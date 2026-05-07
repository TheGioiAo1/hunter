import "dotenv/config";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve as pathResolve } from "node:path";
import express, { Request, Response, NextFunction, RequestHandler } from "express";
import {
  getSessionTokenFromCookies,
  validateSession,
} from "@gbox/core/modules/auth/session.js";
import { type Kysely, sql } from "kysely";
import { schemas, validate, validateQuery, sanitize } from "@gbox/core/modules/security/validation.js";
import { sendEmail, sendOrderConfirmation, sendShippingNotification, sendPasswordReset, sendRefundNotification, sendAbandonedCartRecovery, sendNewOrderReceived, sendOrderCanceled } from "@gbox/core/modules/email/service.js";
import { createPayPalOrder, capturePayPalOrder, createPayPalRefund, verifyWebhook as verifyPayPalWebhook } from "@gbox/core/modules/payments/paypal.js";
import { createPaymentIntent, handleWebhook as handleStripeWebhook, processWebhookEvent } from "@gbox/core/modules/payments/stripe.js";
// Phase 15 PR2 — single chokepoint for inbound payment webhook
// idempotency. Every gateway handler INSERTs ON CONFLICT (gateway,
// event_id) DO NOTHING before running any side-effect. See
// packages/core/src/modules/webhooks/payment-idempotency.ts.
import { recordInboundWebhook, markWebhookProcessed } from "@gbox/core/modules/webhooks/payment-idempotency.js";
import {
  createPartnerReferralLink,
  processOnboardingCallback,
  isMerchantReady,
  createPayPalPartnerOrder,
  capturePayPalPartnerOrder,
  cancelPayPalPartnerOrder,
  refundPayPalPartnerCapture,
  buildPayPalSdkScriptTag,
  type MerchantOnboardingResult,
  type CreatePayPalOrderInput,
} from "@gbox/core/modules/payments/paypal-partner/index.js";
import { selectPaymentGateway } from "@gbox/core/modules/payments/gateway-selector.js";
import { securityHeaders } from "@gbox/core/modules/security/headers.js";
import { sanitizeResponseMiddleware } from "@gbox/core/modules/security/sanitize-middleware.js";
import { corsConfig, dynamicShopCors } from "@gbox/core/modules/security/cors.js";
import { apiLimiter, apiReadLimiter, strictLimiter, checkoutLimiter, paymentLimiter, refundLimiter, authLimiter } from "@gbox/core/modules/security/rate-limit.js";
import { sanitizeHtml } from "@gbox/core/modules/security/sanitize-html.js";
import { shopContext } from "@gbox/core/modules/shops/context.js";
import { idempotency } from "@gbox/core/modules/idempotency/middleware.js";
import {
  CUSTOMER_COOKIE_NAME,
  CustomerAuthError,
  buildCustomerCookieOptions,
  customerAuth,
  issueLoginCode,
  revokeSession,
  verifyMagicLink,
  verifyOtpCode,
} from "@gbox/core/modules/customer-auth/index.js";
import { emailSendQueue } from "@gbox/core/modules/queue/queues.js";
import { listProductsWithDetails } from "@gbox/core/modules/products/service.js";
import { rollupYesterdayAllShops, incrementToday } from "@gbox/core/modules/analytics/daily-metrics.js";
import { seedAnalyticsCronTasks } from "@gbox/core/modules/analytics/cron-register.js";
import { seedCampaignsCronTasks } from "@gbox/core/modules/marketing/campaigns-cron.js";
import { seedAbandonedCartCronTasks } from "@gbox/core/modules/marketing/abandoned-cart-cron.js";
import { seedGiftCardCronTasks } from "@gbox/core/modules/gift-cards/cron.js";
import { seedSupportCronTasks } from "@gbox/core/modules/support-notifications/index.js";
// Phase 14 PR7 (BUG-E4) — soft-bounce aggregator cron seed.
import { seedEmailCronTasks } from "@gbox/core/modules/email/bounce-aggregator.js";
// Phase 14 PR8 (bug 9) — zombie-queued delivery janitor cron seed.
import { seedEmailZombieJanitorCron } from "@gbox/core/modules/email/cron-seed.js";
import { executeDueJobs } from "@gbox/core/modules/cron/service.js";
import {
  registerLenfulCronHandlers,
  seedLenfulCronTasks,
} from "@gbox/core/modules/fulfillment/lenful/index.js";
import { emitOrderEvent } from "@gbox/core/modules/events/orderEvents.js";
import { requireScope, type ScopeOptions } from "@gbox/core/modules/security/scopes.js";
import { safeOrderBy } from "@gbox/core/modules/security/safe-order-by.js";
import { validateUploadedFile } from "@gbox/core/modules/security/file-validation.js";
import multer from "multer";
import { getObjectStore } from "@gbox/core/modules/storage/index.js";
import { startWorkers, stopWorkers, closeAllQueues, closeQueueConnection, registerDefaultOrderHandlers } from "@gbox/core/modules/queue/index.js";
import { performanceMiddleware, configureKeepAlive, cacheHeaders } from "@gbox/core/modules/performance/middleware.js";
import { requestLogger, apiLogger, correlationId, shopifyErrorHandler, installProcessErrorHandlers } from "@gbox/core/modules/logging/logger.js";
import { cacheGet, cacheSet, cacheDelPattern, closeRedis, redisPing } from "@gbox/core/modules/cache/redis.js";
import { cacheProducts, cacheProduct, cacheCollections, cacheOrders, cacheCustomers, cacheDiscounts, cacheDashboard, cacheSettings, invalidateProductCache, invalidateCollectionCache, invalidateOrderCache, invalidateCustomerCache, invalidateDashboardCache } from "@gbox/core/modules/cache/api-cache.js";
import { healthCheck, metricsMiddleware, getMetrics } from "@gbox/core/modules/monitoring/metrics.js";
import { fireAutomationTrigger } from "@gbox/core/modules/automations/engine.js";
import {
  CANONICAL_EVENTS,
  claimEventId,
  dispatchServerSide,
  newEventId,
  type CanonicalEvent,
} from "@gbox/core/modules/tracking/index.js";

// ---------------------------------------------------------------------------
// Express augmentation
// ---------------------------------------------------------------------------

declare global {
  namespace Express {
    interface Request {
      apiUser?: { id: string; email: string; name: string; role: string };
      apiStore?: { id: string; name: string; slug: string };
    }
  }
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

const db = null as any;

// ---------------------------------------------------------------------------
// Audit-log helper
// ---------------------------------------------------------------------------

async function logApi(
  db: Kysely<Database>,
  userId: string | null,
  shopId: string | null,
  action: string,
  resourceType: string | null,
  resourceId: string | null,
  details: unknown,
  ip: string | null
): Promise<void> {
  await db
    .insertInto("audit_logs")
    .values({
      shop_id: shopId || null,
      user_id: userId || null,
      action,
      resource_type: resourceType || null,
      resource_id: resourceId || null,
      details: JSON.stringify(details),
      ip_address: ip || "",
    })
    .execute()
    .catch((err: any) => apiLogger.error({ err: err.message }, 'Audit log write failed'));
}

// ---------------------------------------------------------------------------
// Middleware helpers
// ---------------------------------------------------------------------------

async function extractUser(req: Request): Promise<{
  id: string;
  email: string;
  name: string;
  role: string;
} | null> {
  const cookieHeader = req.headers.cookie || "";
  const token = getSessionTokenFromCookies(cookieHeader);
  if (!token) return null;

  const result = await validateSession(db as Kysely<any>, token);
  if (!result.valid || !result.session) return null;

  const u = result.session.user;
  return { id: u.id, email: u.email, name: u.name, role: u.role };
}

// ---------------------------------------------------------------------------
// Auth middleware: requireGodAdmin
// ---------------------------------------------------------------------------

function requireGodAdmin(_db: Kysely<Database>): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const user = await extractUser(req);
      if (!user) {
        res.status(401).json({ error: "Unauthorized", message: "Valid session required" });
        return;
      }
      if (user.role !== "owner") {
        res.status(403).json({ error: "Forbidden", message: "God Admin access required" });
        return;
      }
      // Verify is_default_admin flag in DB (not just role)
      const dbUser = await _db
        .selectFrom("users")
        .select("is_default_admin")
        .where("id", "=", user.id)
        .executeTakeFirst();
      if (!dbUser?.is_default_admin) {
        res.status(403).json({ error: "Forbidden", message: "God Admin access required" });
        return;
      }
      req.apiUser = user;
      next();
    } catch (err: any) {
      apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' });
    }
  };
}

// ---------------------------------------------------------------------------
// Auth middleware: requireStoreAccess
// ---------------------------------------------------------------------------

function requireStoreAccess(_db: Kysely<Database>): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const user = await extractUser(req);
      if (!user) {
        res.status(401).json({ error: "Unauthorized", message: "Valid session required" });
        return;
      }

      const slug = req.params.slug;
      if (!slug) {
        res.status(400).json({ error: "Bad request", message: "Store slug required" });
        return;
      }

      const shop = await db
        .selectFrom("shops")
        .select(["id", "name", "slug"])
        .where("slug", "=", slug)
        .executeTakeFirst();

      if (!shop) {
        res.status(404).json({ error: "Not found", message: "Store not found" });
        return;
      }

      // God admin has access to all stores
      if (user.role === "owner") {
        req.apiUser = user;
        req.apiStore = { id: shop.id, name: shop.name, slug: shop.slug };
        next();
        return;
      }

      // Check user_shops
      const access = await db
        .selectFrom("user_shops")
        .select(["role"])
        .where("user_id", "=", user.id)
        .where("shop_id", "=", shop.id)
        .executeTakeFirst();

      if (!access) {
        res.status(403).json({ error: "Forbidden", message: "No access to this store" });
        return;
      }

      req.apiUser = user;
      req.apiStore = { id: shop.id, name: shop.name, slug: shop.slug };
      next();
    } catch (err: any) {
      apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' });
    }
  };
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app = express();
app.set("trust proxy", 1);

// Correlation ID — attaches X-Request-ID to every request for tracing
app.use(correlationId());

// Performance middleware (compression + timing headers)
app.use(performanceMiddleware());

// Metrics tracking (request count, latency, errors)
app.use(metricsMiddleware());

// Request logging (async, structured, non-blocking, with correlation ID)
app.use(requestLogger('gbox-api'));

// Security middleware stack
app.use(securityHeaders);                         // Security headers (helmet)
app.use(dynamicShopCors(db));                      // Dynamic CORS — validates merchant custom domains

// Stripe webhook needs raw body for signature verification
app.use("/api/webhooks/stripe", express.raw({ type: "application/json" }));

// JSON body parsing for all other routes
app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.path === "/api/webhooks/stripe") return next(); // already parsed as raw
  express.json({ limit: "1mb" })(req, res, next);
});
app.use(express.urlencoded({ extended: false, limit: "1mb" }));

// Phase 0 close-the-loop — monkey-patch res.json so every JSON
// response is scrubbed of password_hash / tokens / secrets before it
// leaves the process. Mounted after body parsers so streaming + raw
// handlers are untouched, but before every mutation route below.
app.use(sanitizeResponseMiddleware());

// Rate limiting by method — applied to all API routes
app.use((req: Request, res: Response, next: NextFunction) => {
  if (!req.path.startsWith("/api/")) return next();
  if (["POST", "PUT", "DELETE", "PATCH"].includes(req.method)) {
    apiLimiter(req, res, next);
  } else {
    apiReadLimiter(req, res, next);
  }
});

// Resolve shop context (X-Shop-Domain → Bearer token → Host header) and
// stamp `req.shopId` / `req.shop`. Optional — never blocks the request,
// just makes shop context available to downstream middleware (idempotency,
// rate limiters keyed by shop, the legacy /api/2026-04/* endpoints).
app.use(shopContext({ db, required: false }));

// Resolve customer session (cookie `gbox_customer_session`) and stamp
// `req.customerId` / `req.customerShopId`. Opt-in: missing/expired
// cookies do NOT block the request — handlers gate on req.customerId.
app.use(customerAuth({ db }));

const godAdmin = requireGodAdmin(db);
const storeAccess = requireStoreAccess(db);

// ---------------------------------------------------------------------------
// Helper: resolve shopId from `:slug` URL param BEFORE the handler runs.
//
// The /api/store/:slug/* routes have always done their own slug→shop lookup
// inside each handler. The new idempotency middleware needs `req.shopId`
// set BEFORE the handler is called so it can scope the idempotency key per
// shop. This middleware bridges the gap without disturbing the existing
// `requireStoreAccess` flow (which is still authoritative for auth).
// ---------------------------------------------------------------------------

const SLUG_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const slugCache = new Map<string, { id: string; ts: number }>(); // slug -> { shop_id, timestamp }
const shopFromSlug: RequestHandler = async (req, _res, next) => {
  try {
    const slug = req.params.slug;
    if (!slug) return next();
    const cached = slugCache.get(slug);
    let id: string | undefined;
    if (cached && (Date.now() - cached.ts) < SLUG_CACHE_TTL_MS) {
      id = cached.id;
    }
    if (!id) {
      const row = await db
        .selectFrom("shops")
        .select("id")
        .where("slug", "=", slug)
        .executeTakeFirst();
      if (row?.id) {
        id = row.id;
        if (slugCache.size > 500) slugCache.clear(); // crude bound
        slugCache.set(slug, { id, ts: Date.now() });
      }
    }
    if (id) (req as any).shopId = id;
    next();
  } catch {
    // Fail open — handler will reject the request itself if needed.
    next();
  }
};

// Idempotency middleware factory bound to our DB. Routes opt in by adding
// `idempotent` to their middleware chain. Honors `Idempotency-Key` header.
const idempotent = idempotency({ db });

// API token scope enforcement — routes opt in with scope('write_products') etc.
// `write_X` implicitly grants `read_X`. Returns 401 for missing token, 403
// for insufficient scope. Uses Bearer token → SHA-256 hash → api_tokens lookup.
const scopeOpts: ScopeOptions = { db };
const scope = (s: Parameters<typeof requireScope>[0]) => requireScope(s, scopeOpts);

// File upload validation — validates magic bytes (not just Content-Type).
// Apply to any route that accepts file uploads:
//   app.post('/api/store/:slug/files', upload.single('file'), validateUpload, handler)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const validateUpload = validateUploadedFile({
  allowedMimes: ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif', 'application/pdf'],
  maxBytes: 20 * 1024 * 1024, // 20 MB
});

// ===========================================================================
// CUSTOMER AUTH (Decision #4) — magic link + 6-digit OTP
// ===========================================================================
//
// Storefront customer login flow. Completely separate from merchant auth:
// uses customer_otp_codes + customer_sessions tables (migration 007), the
// `gbox_customer_session` cookie, and never reads/writes the `users` /
// `sessions` tables.
//
// Endpoints (all under /api/store/:slug/):
//   POST  auth/request-otp     { email }                      → 200 { sent }
//   POST  auth/verify-otp      { email, code }                → 200 + cookie
//   GET   auth/verify-magic    ?email=&token= (from email)    → 302 + cookie
//   POST  auth/logout                                          → 200 + clear
//   GET   auth/me                                              → 200 customer
//
// Per PRINCIPLES.md P3 we never disclose whether an email is enrolled —
// request-otp always returns `{ sent: true }` regardless. Per P18 the OTP
// is a first-class auth path, not a password fallback.
// ---------------------------------------------------------------------------

// GET /api/store/:slug/auth/settings — public customer account settings
// Returns account mode, login method, and feature toggles for the storefront
app.get("/api/store/:slug/auth/settings", shopFromSlug, async (req: Request, res: Response) => {
  try {
    const shopId = (req as any).shopId as string;
    if (!shopId) { res.status(404).json({ error: "store_not_found" }); return; }

    const settingKeys = [
      "customer_account_mode", "customer_login_method",
      "customer_self_serve_returns", "customer_order_history",
      "customer_saved_addresses", "customer_wishlist",
    ];
    const rows = await db
      .selectFrom("shop_settings")
      .select(["key", "value"])
      .where("shop_id", "=", shopId)
      .where("key", "in", settingKeys)
      .execute();

    const settings: Record<string, string> = {};
    for (const r of rows) settings[r.key] = r.value;

    res.json({
      account_mode: settings.customer_account_mode || "optional",
      login_method: settings.customer_login_method || "email",
      features: {
        self_serve_returns: settings.customer_self_serve_returns === "true",
        order_history: settings.customer_order_history !== "false",
        saved_addresses: settings.customer_saved_addresses !== "false",
        wishlist: settings.customer_wishlist === "true",
      },
    });
  } catch (err: any) { apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' }); }
});

// POST /api/store/:slug/auth/request-otp
// Phase 0 Step 0.3: rate-limited. Without `authLimiter` this endpoint
// is a free email-enumeration + SMTP-DoS vector (every request triggers
// a queued email-send job).
app.post(
  "/api/store/:slug/auth/request-otp",
  authLimiter,
  shopFromSlug,
  async (req: Request, res: Response) => {
    const shopId = (req as any).shopId as string | undefined;
    if (!shopId) {
      return res.status(404).json({ error: "store_not_found" });
    }
    const email = typeof req.body?.email === "string" ? req.body.email : "";
    if (!email || !email.includes("@")) {
      return res
        .status(400)
        .json({ error: "invalid_email", message: "Valid email required" });
    }

    try {
      const issued = await issueLoginCode(
        db,
        shopId,
        email,
        req.ip,
      );

      // Best-effort: enqueue an email-send job containing the magic link
      // and 6-digit code. The email-send queue does not yet have a worker
      // wired (see Decision #8 placeholder queues), so for now we ALSO
      // log the link to the API logs so dev can complete the flow.
      // Production wiring will plug an SMTP/SES worker into this same
      // queue without changing producers.
      try {
        await emailSendQueue().add("customer-login", {
          shop_id: shopId,
          to: email,
          subject: "Your sign-in link",
          template: "customer-magic-link",
          data: {
            magic_link: `/api/store/${req.params.slug}/auth/verify-magic?email=${encodeURIComponent(email)}&token=${issued.magicLinkToken}`,
            otp_code: issued.otpCode,
            expires_at: issued.expiresAt.toISOString(),
          },
        });
      } catch (err: any) {
        apiLogger.warn(
          { err: err?.message, shop_id: shopId },
          "[customer-auth] failed to enqueue login email",
        );
      }

      // Dev convenience: surface the link/code in server logs so the
      // flow is testable without an SMTP backend wired up.
      if (process.env.NODE_ENV !== "production") {
        apiLogger.info(
          {
            shop_id: shopId,
            email,
            magic_link_token: issued.magicLinkToken,
            otp_code: issued.otpCode,
          },
          "[customer-auth][dev] login code issued",
        );
      }

      // Always return success — never leak whether the email is enrolled.
      res.json({ sent: true });
    } catch (err) {
      if (err instanceof CustomerAuthError) {
        return res
          .status(err.status)
          .json({ error: err.code, message: err.message });
      }
      apiLogger.error(
        { err: (err as Error)?.message, shop_id: shopId },
        "[customer-auth] request-otp failed",
      );
      res.status(500).json({ error: "internal_error" });
    }
  },
);

// POST /api/store/:slug/auth/verify-otp
// Phase 0 Step 0.3: rate-limited so an attacker can't brute-force the
// 6-digit OTP (10^6 space × 5/min = still ~14 days to cover, which
// exceeds the OTP TTL; combined with server-side attempt-counting in
// customer-auth it's effectively closed).
app.post(
  "/api/store/:slug/auth/verify-otp",
  authLimiter,
  shopFromSlug,
  async (req: Request, res: Response) => {
    const shopId = (req as any).shopId as string | undefined;
    if (!shopId) return res.status(404).json({ error: "store_not_found" });

    const { email, code } = req.body ?? {};
    try {
      const result = await verifyOtpCode(db, shopId, email, code, {
        ip: req.ip,
        userAgent: req.headers["user-agent"],
      });

      res.cookie(
        CUSTOMER_COOKIE_NAME,
        result.sessionToken,
        buildCustomerCookieOptions(result.sessionExpiresAt),
      );
      res.json({
        ok: true,
        customer_id: result.customer_id,
        new_customer: result.newCustomer,
      });
    } catch (err) {
      if (err instanceof CustomerAuthError) {
        return res
          .status(err.status)
          .json({ error: err.code, message: err.message });
      }
      apiLogger.error(
        { err: (err as Error)?.message },
        "[customer-auth] verify-otp failed",
      );
      res.status(500).json({ error: "internal_error" });
    }
  },
);

// GET /api/store/:slug/auth/verify-magic — link from email
// Phase 0 Step 0.3: even GET magic-link consumption is limited to
// prevent log-scraping attacks that replay every token they've seen.
app.get(
  "/api/store/:slug/auth/verify-magic",
  authLimiter,
  shopFromSlug,
  async (req: Request, res: Response) => {
    const shopId = (req as any).shopId as string | undefined;
    if (!shopId) return res.status(404).json({ error: "store_not_found" });

    const email =
      typeof req.query.email === "string" ? req.query.email : "";
    const token =
      typeof req.query.token === "string" ? req.query.token : "";

    try {
      const result = await verifyMagicLink(db, shopId, email, token, {
        ip: req.ip,
        userAgent: req.headers["user-agent"],
      });

      res.cookie(
        CUSTOMER_COOKIE_NAME,
        result.sessionToken,
        buildCustomerCookieOptions(result.sessionExpiresAt),
      );
      // For now we return JSON; the storefront app (Decision #1/#2) will
      // wire this to a 302 redirect to /account once that route exists.
      res.json({
        ok: true,
        customer_id: result.customer_id,
        new_customer: result.newCustomer,
      });
    } catch (err) {
      if (err instanceof CustomerAuthError) {
        return res
          .status(err.status)
          .json({ error: err.code, message: err.message });
      }
      apiLogger.error(
        { err: (err as Error)?.message },
        "[customer-auth] verify-magic failed",
      );
      res.status(500).json({ error: "internal_error" });
    }
  },
);

// POST /api/store/:slug/auth/logout
app.post(
  "/api/store/:slug/auth/logout",
  async (req: Request, res: Response) => {
    const cookie =
      (req as any).cookies?.[CUSTOMER_COOKIE_NAME] ??
      (req.headers.cookie || "")
        .split(";")
        .map((s) => s.trim())
        .find((p) => p.startsWith(`${CUSTOMER_COOKIE_NAME}=`))
        ?.slice(CUSTOMER_COOKIE_NAME.length + 1);

    if (cookie) {
      try {
        await revokeSession(db, decodeURIComponent(cookie));
      } catch (err: any) {
        apiLogger.warn(
          { err: err?.message },
          "[customer-auth] revoke failed during logout",
        );
      }
    }
    res.clearCookie(CUSTOMER_COOKIE_NAME, { path: "/" });
    res.json({ ok: true });
  },
);

// GET /api/store/:slug/auth/me — current customer profile (requires login)
app.get(
  "/api/store/:slug/auth/me",
  shopFromSlug,
  async (req: Request, res: Response) => {
    const shopId = (req as any).shopId as string | undefined;
    if (!shopId) return res.status(404).json({ error: "store_not_found" });

    if (!req.customerId || req.customerShopId !== shopId) {
      return res.status(401).json({ error: "unauthorized" });
    }

    const customer = await db
      .selectFrom("customers")
      .select([
        "id",
        "email",
        "first_name",
        "last_name",
        "phone",
        "orders_count",
        "total_spent",
        "email_verified_at",
        "last_login_at",
        "created_at",
      ])
      .where("id", "=", req.customerId)
      .executeTakeFirst();

    if (!customer) return res.status(404).json({ error: "customer_not_found" });
    res.json({ customer });
  },
);

// ---------------------------------------------------------------------------
// Health & root (no auth)
// ---------------------------------------------------------------------------

app.get("/", (_req: Request, res: Response) => {
  res.json({
    platform: "Gbox Platform v4",
    version: "4.0.0",
    status: "running",
    server: "API Server (Windows)",
    endpoints: {
      api: "/api/2026-04/",
      god: "/api/god/",
      store: "/api/store/:slug/",
      docs: "/api/2026-04/docs.json",
    },
  });
});

// Enhanced health check — checks DB + Redis + memory + latency stats
app.get("/health", healthCheck(db));

// Prometheus-compatible metrics endpoint (god admin only)
app.get("/metrics", godAdmin, getMetrics());

// ===========================================================================
// PUBLIC TRACKING ENDPOINT (migration 034)
// ===========================================================================
// POST /api/track
//
// Browser fires `window.gboxTrack(canonical, customData)` which:
//   1. Calls the partner libraries (fbq/gtag/ttq) directly with a
//      shared event_id.
//   2. POSTs here so the server can fan out to Meta CAPI / GA4
//      Measurement Protocol / TikTok Events API with the SAME event_id.
//   3. Meta/TikTok/GA4 all dedupe by event_id within 7 days.
//
// Shop is resolved from the Host header by `shopContext` middleware
// above — we don't trust the body's `shop_id` to prevent cross-shop
// spoofing. The client sends it purely for sanity/debug logging.

app.post("/api/track", async (req: Request, res: Response) => {
  try {
    const shopId = req.shopId ?? null;
    if (!shopId) {
      res.status(400).json({ ok: false, error: "shop_not_resolved" });
      return;
    }

    const body = (req.body ?? {}) as {
      event_id?: unknown;
      canonical_event?: unknown;
      event_time_ms?: unknown;
      source_url?: unknown;
      custom_data?: unknown;
      user_data?: {
        email?: unknown;
        phone?: unknown;
        external_id?: unknown;
        fbp?: unknown;
        fbc?: unknown;
        ga4_client_id?: unknown;
        ttclid?: unknown;
      };
    };

    const canonicalEvent =
      typeof body.canonical_event === "string" &&
      (CANONICAL_EVENTS as readonly string[]).includes(body.canonical_event)
        ? (body.canonical_event as CanonicalEvent)
        : null;
    if (!canonicalEvent) {
      res.status(400).json({ ok: false, error: "unknown_canonical_event" });
      return;
    }

    const eventId =
      typeof body.event_id === "string" && body.event_id.length > 0
        ? body.event_id
        : newEventId();

    // Idempotency — skip dispatch if the same event_id has fired before.
    const claim = await claimEventId(db, {
      eventId,
      shopId,
      eventName: canonicalEvent,
    });
    if (!claim.fresh) {
      res.json({ ok: true, dedup: true });
      return;
    }

    // Client IP + UA are trusted from the HTTP layer (never the body).
    const forwarded = req.headers["x-forwarded-for"];
    const clientIp =
      (typeof forwarded === "string"
        ? forwarded.split(",")[0]?.trim()
        : null) ||
      req.socket?.remoteAddress ||
      null;
    const userAgent = (req.headers["user-agent"] as string | undefined) ?? null;

    const userData = body.user_data ?? {};

    const result = await dispatchServerSide(db, shopId, {
      canonicalEvent,
      eventId,
      eventTimeMs:
        typeof body.event_time_ms === "number" && Number.isFinite(body.event_time_ms)
          ? body.event_time_ms
          : Date.now(),
      sourceUrl: typeof body.source_url === "string" ? body.source_url : "",
      userAgent,
      clientIp,
      userEmail: typeof userData.email === "string" ? userData.email : null,
      userPhone: typeof userData.phone === "string" ? userData.phone : null,
      userExternalId:
        typeof userData.external_id === "string" ? userData.external_id : null,
      fbp: typeof userData.fbp === "string" ? userData.fbp : null,
      fbc: typeof userData.fbc === "string" ? userData.fbc : null,
      ga4ClientId:
        typeof userData.ga4_client_id === "string" ? userData.ga4_client_id : null,
      ttclid: typeof userData.ttclid === "string" ? userData.ttclid : null,
      customData:
        body.custom_data && typeof body.custom_data === "object"
          ? (body.custom_data as Record<string, unknown>)
          : {},
    });

    res.json({
      ok: true,
      event_id: eventId,
      pixels_fired: result.totalPixels,
      attempts: result.attempts.map((a) => ({
        provider: a.provider,
        success: a.success,
        http_status: a.httpStatus,
      })),
    });
  } catch (err) {
    // Never throw 500 — the client can't retry usefully. Log and no-op.
    try {
      // eslint-disable-next-line no-console
      console.error("[/api/track]", err);
    } catch {
      /* nothing */
    }
    res.json({ ok: false, error: "dispatch_failed" });
  }
});

// ===========================================================================
// GOD ADMIN ROUTES
// ===========================================================================

// ---------------------------------------------------------------------------
// GET /api/god/fulfillments — unfulfilled orders across all stores
// ---------------------------------------------------------------------------

app.get("/api/god/fulfillments", godAdmin, async (req: Request, res: Response) => {
  try {
    const status = req.query.status as string | undefined;
    const shopId = req.query.shop_id as string | undefined;

    let query = db
      .selectFrom("orders as o")
      .innerJoin("shops as s", "s.id", "o.shop_id")
      .select([
        "o.id",
        "o.order_number",
        "o.email",
        "o.financial_status",
        "o.fulfillment_status",
        "o.total_price",
        "o.currency",
        "o.created_at",
        "s.id as shop_id",
        "s.name as shop_name",
        "s.slug as shop_slug",
      ])
      .orderBy("o.created_at", "asc");

    if (status) {
      query = query.where("o.fulfillment_status", "=", status);
    } else {
      query = query.where("o.fulfillment_status", "in", ["unfulfilled", "partial"]);
    }

    if (shopId) {
      query = query.where("o.shop_id", "=", shopId);
    }

    const orders = await query.limit(100).execute();
    res.json({ orders, count: orders.length });
  } catch (err: any) {
    apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/god/fulfillments/:orderId — order detail with line items
// ---------------------------------------------------------------------------

app.get("/api/god/fulfillments/:orderId", godAdmin, async (req: Request, res: Response) => {
  try {
    const order = await db
      .selectFrom("orders as o")
      .innerJoin("shops as s", "s.id", "o.shop_id")
      .select([
        "o.id", "o.order_number", "o.email", "o.phone",
        "o.financial_status", "o.fulfillment_status",
        "o.subtotal_price", "o.total_discounts", "o.total_shipping",
        "o.total_tax", "o.total_price", "o.currency",
        "o.note", "o.shipping_address", "o.billing_address",
        "o.created_at", "o.updated_at",
        "s.id as shop_id", "s.name as shop_name", "s.slug as shop_slug",
      ])
      .where("o.id", "=", req.params.orderId)
      .executeTakeFirst();

    if (!order) {
      res.status(404).json({ error: "Not found", message: "Order not found" });
      return;
    }

    const lineItems = await db
      .selectFrom("order_line_items")
      .selectAll()
      .where("order_id", "=", order.id)
      .execute();

    const fulfillments = await db
      .selectFrom("fulfillments")
      .selectAll()
      .where("order_id", "=", order.id)
      .execute();

    // POD design files for Print on Demand orders
    const podFiles = await db
      .selectFrom("pod_files")
      .selectAll()
      .where("order_id", "=", order.id)
      .execute()
      .catch(() => []);

    res.json({ order, line_items: lineItems, fulfillments, pod_files: podFiles });
  } catch (err: any) {
    apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/god/fulfillments/:orderId/fulfill — create fulfillment
// ---------------------------------------------------------------------------

app.post("/api/god/fulfillments/:orderId/fulfill", godAdmin, async (req: Request, res: Response) => {
  try {
    const { tracking_company, tracking_number, tracking_url, line_item_ids } = req.body;
    const orderId = req.params.orderId;

    const order = await db
      .selectFrom("orders")
      .select(["id", "shop_id", "order_number"])
      .where("id", "=", orderId)
      .executeTakeFirst();

    if (!order) {
      res.status(404).json({ error: "Not found", message: "Order not found" });
      return;
    }

    // Create fulfillment
    const fulfillment = await db
      .insertInto("fulfillments")
      .values({
        order_id: orderId,
        status: "success",
        tracking_company: tracking_company || null,
        tracking_number: tracking_number || null,
        tracking_url: tracking_url || null,
        shipped_at: new Date().toISOString(),
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    // Link line items if provided
    if (Array.isArray(line_item_ids) && line_item_ids.length > 0) {
      for (const liId of line_item_ids) {
        const li = await db
          .selectFrom("order_line_items")
          .select(["id", "quantity"])
          .where("id", "=", liId)
          .where("order_id", "=", orderId)
          .executeTakeFirst();
        if (li) {
          await db
            .insertInto("fulfillment_line_items")
            .values({
              fulfillment_id: fulfillment.id,
              line_item_id: li.id,
              quantity: li.quantity,
            })
            .execute();
        }
      }
    }

    // Update order fulfillment status
    await db
      .updateTable("orders")
      .set({ fulfillment_status: "fulfilled", updated_at: new Date().toISOString() })
      .where("id", "=", orderId)
      .execute();

    // Audit log
    await logApi(
      db, req.apiUser!.id, order.shop_id, "order_fulfilled",
      "order", orderId,
      { tracking_company, tracking_number, fulfillment_id: fulfillment.id },
      req.ip || null
    );

    // Notification for the store
    await db
      .insertInto("notifications")
      .values({
        shop_id: order.shop_id,
        type: "fulfillment",
        title: `Order #${order.order_number} fulfilled`,
        message: tracking_number
          ? `Tracking: ${tracking_company || ""} ${tracking_number}`
          : "Order has been marked as fulfilled",
      })
      .execute()
      .catch(() => {});

    // Send shipping notification email to customer (fire-and-forget)
    if (process.env.SMTP_HOST) {
      const fullOrder = await db.selectFrom("orders").selectAll().where("id", "=", orderId).executeTakeFirst();
      if (fullOrder && fullOrder.email) {
        const lineItems = await db.selectFrom("order_line_items").selectAll().where("order_id", "=", orderId).execute();
        sendShippingNotification(db, order.shop_id, {
          id: fullOrder.id, order_number: Number(fullOrder.order_number), email: fullOrder.email,
          currency: fullOrder.currency || "USD", subtotal_price: String(fullOrder.subtotal_price),
          total_shipping: String(fullOrder.total_shipping), total_tax: String(fullOrder.total_tax),
          total_discounts: String(fullOrder.total_discounts), total_price: String(fullOrder.total_price),
          line_items: lineItems.map((li: any) => ({ title: li.title || "", variant_title: li.variant_title, quantity: li.quantity, price: String(li.price) })),
          shipping_address: fullOrder.shipping_address as any, billing_address: fullOrder.billing_address as any, created_at: String(fullOrder.created_at),
        }, {
          id: fulfillment.id, tracking_company: fulfillment.tracking_company, tracking_number: fulfillment.tracking_number,
          tracking_url: fulfillment.tracking_url, shipped_at: fulfillment.shipped_at ? String(fulfillment.shipped_at) : null,
          line_items: lineItems.map((li: any) => ({ title: li.title || "", variant_title: li.variant_title, quantity: li.quantity })),
        }).catch((err: any) => apiLogger.error({ err: err.message }, '[email] shipping notification failed'));
      }
    }

    res.json({ fulfillment });
  } catch (err: any) {
    apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// PUT /api/god/fulfillments/:fulfillmentId/tracking — update tracking
// ---------------------------------------------------------------------------

app.put("/api/god/fulfillments/:fulfillmentId/tracking", godAdmin, async (req: Request, res: Response) => {
  try {
    const { tracking_company, tracking_number, tracking_url } = req.body;
    const fulfillmentId = req.params.fulfillmentId;

    const fulfillment = await db
      .selectFrom("fulfillments as f")
      .innerJoin("orders as o", "o.id", "f.order_id")
      .select(["f.id", "f.order_id", "o.shop_id"])
      .where("f.id", "=", fulfillmentId)
      .executeTakeFirst();

    if (!fulfillment) {
      res.status(404).json({ error: "Not found", message: "Fulfillment not found" });
      return;
    }

    const updated = await db
      .updateTable("fulfillments")
      .set({
        tracking_company: tracking_company ?? undefined,
        tracking_number: tracking_number ?? undefined,
        tracking_url: tracking_url ?? undefined,
        updated_at: new Date().toISOString(),
      })
      .where("id", "=", fulfillmentId)
      .returningAll()
      .executeTakeFirstOrThrow();

    await logApi(
      db, req.apiUser!.id, fulfillment.shop_id, "tracking_updated",
      "fulfillment", fulfillmentId,
      { tracking_company, tracking_number, tracking_url },
      req.ip || null
    );

    res.json({ fulfillment: updated });
  } catch (err: any) {
    apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/god/refund-requests — all refund requests
// ---------------------------------------------------------------------------

app.get("/api/god/refund-requests", godAdmin, async (req: Request, res: Response) => {
  try {
    const status = req.query.status as string | undefined;

    let query = db
      .selectFrom("refund_requests as rr")
      .innerJoin("orders as o", "o.id", "rr.order_id")
      .innerJoin("shops as s", "s.id", "o.shop_id")
      .select([
        "rr.id", "rr.order_id", "rr.amount", "rr.reason",
        "rr.status", "rr.created_at",
        "o.order_number", "o.total_price",
        "s.id as shop_id", "s.name as shop_name",
      ])
      .orderBy("rr.created_at", "desc");

    if (status) {
      query = query.where("rr.status", "=", status);
    }

    const requests = await query.limit(100).execute();
    res.json({ refund_requests: requests, count: requests.length });
  } catch (err: any) {
    apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/god/refund-requests/:id — detail
// ---------------------------------------------------------------------------

app.get("/api/god/refund-requests/:id", godAdmin, async (req: Request, res: Response) => {
  try {
    const rr = await db
      .selectFrom("refund_requests as rr")
      .innerJoin("orders as o", "o.id", "rr.order_id")
      .innerJoin("shops as s", "s.id", "o.shop_id")
      .select([
        "rr.id", "rr.order_id", "rr.amount", "rr.reason",
        "rr.status", "rr.reviewed_by", "rr.reviewed_at", "rr.review_note",
        "rr.line_items", "rr.created_at",
        "o.order_number", "o.total_price", "o.financial_status",
        "s.id as shop_id", "s.name as shop_name", "s.slug as shop_slug",
      ])
      .where("rr.id", "=", req.params.id)
      .executeTakeFirst();

    if (!rr) {
      res.status(404).json({ error: "Not found", message: "Refund request not found" });
      return;
    }

    res.json({ refund_request: rr });
  } catch (err: any) {
    apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/god/refund-requests/:id/approve
// ---------------------------------------------------------------------------

app.post("/api/god/refund-requests/:id/approve", godAdmin, async (req: Request, res: Response) => {
  try {
    const { note } = req.body || {};
    const rrId = req.params.id;

    const rr = await db
      .selectFrom("refund_requests as rr")
      .innerJoin("orders as o", "o.id", "rr.order_id")
      .select([
        "rr.id", "rr.order_id", "rr.amount", "rr.status",
        "o.shop_id", "o.total_price", "o.order_number",
      ])
      .where("rr.id", "=", rrId)
      .executeTakeFirst();

    if (!rr) {
      res.status(404).json({ error: "Not found", message: "Refund request not found" });
      return;
    }

    if (rr.status !== "pending") {
      res.status(400).json({ error: "Bad request", message: `Refund request already ${rr.status}` });
      return;
    }

    // Update refund request
    await db
      .updateTable("refund_requests")
      .set({
        status: "approved",
        reviewed_by: req.apiUser!.id,
        reviewed_at: new Date().toISOString(),
        review_note: note || null,
      })
      .where("id", "=", rrId)
      .execute();

    // Create refund record
    const refund = await db
      .insertInto("refunds")
      .values({
        order_id: rr.order_id,
        note: note || `Refund approved for request ${rrId}`,
        restock: false,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    // Create transaction
    await db
      .insertInto("transactions")
      .values({
        order_id: rr.order_id,
        kind: "refund",
        gateway: "gbox",
        amount: rr.amount,
        status: "success",
      })
      .execute();

    // Update order financial status
    const refundAmount = parseFloat(rr.amount);
    const orderTotal = parseFloat(rr.total_price);
    const newStatus = refundAmount >= orderTotal ? "refunded" : "partially_refunded";

    await db
      .updateTable("orders")
      .set({ financial_status: newStatus, updated_at: new Date().toISOString() })
      .where("id", "=", rr.order_id)
      .execute();

    // Order event sourcing
    await emitOrderEvent(db, {
      shop_id: rr.shop_id, order_id: rr.order_id, event_type: "refund_issued",
      actor_type: "user", actor_id: req.apiUser!.id,
      data: { amount: rr.amount, status: newStatus, note },
    }).catch(() => {});

    // Audit log
    await logApi(
      db, req.apiUser!.id, rr.shop_id, "refund_approved",
      "refund_request", rrId,
      { amount: rr.amount, refund_id: refund.id, note },
      req.ip || null
    );

    // Notification
    await db
      .insertInto("notifications")
      .values({
        shop_id: rr.shop_id,
        type: "refund",
        title: `Refund approved for Order #${rr.order_number}`,
        message: `Amount: ${rr.amount}${note ? ` - ${note}` : ""}`,
      })
      .execute()
      .catch(() => {});

    // Send refund email to customer (fire-and-forget)
    void (async () => {
      try {
        const order = await db.selectFrom("orders").selectAll().where("id", "=", rr.order_id).executeTakeFirst();
        if (order?.email) {
          const lineItems = await db.selectFrom("order_line_items").selectAll().where("order_id", "=", rr.order_id).execute();
          await sendRefundNotification(db, rr.shop_id, {
            id: order.id, order_number: order.order_number as number, email: order.email,
            currency: order.currency || "USD", subtotal_price: String(order.subtotal_price || "0"),
            total_shipping: String(order.total_shipping || "0"), total_tax: String(order.total_tax || "0"),
            total_discounts: String(order.total_discounts || "0"), total_price: String(order.total_price || "0"),
            line_items: lineItems.map((li: any) => ({ title: li.title, variant_title: li.variant_title, quantity: li.quantity, price: String(li.price) })),
            shipping_address: order.shipping_address as any, billing_address: order.billing_address as any,
            created_at: String(order.created_at),
          }, {
            id: refund.id, amount: rr.amount, currency: order.currency || "USD",
            reason: note || null,
            refund_line_items: lineItems.map((li: any) => ({ title: li.title, variant_title: li.variant_title, quantity: li.quantity, price: String(li.price) })),
          });
        }
      } catch {}
    })();

    res.json({ refund_request: { id: rrId, status: "approved" }, refund });
  } catch (err: any) {
    apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/god/refund-requests/:id/reject
// ---------------------------------------------------------------------------

app.post("/api/god/refund-requests/:id/reject", godAdmin, async (req: Request, res: Response) => {
  try {
    const { note } = req.body || {};
    const rrId = req.params.id;

    if (!note) {
      res.status(400).json({ error: "Bad request", message: "Rejection reason (note) is required" });
      return;
    }

    const rr = await db
      .selectFrom("refund_requests as rr")
      .innerJoin("orders as o", "o.id", "rr.order_id")
      .select(["rr.id", "rr.status", "rr.order_id", "o.shop_id", "o.order_number"])
      .where("rr.id", "=", rrId)
      .executeTakeFirst();

    if (!rr) {
      res.status(404).json({ error: "Not found", message: "Refund request not found" });
      return;
    }

    if (rr.status !== "pending") {
      res.status(400).json({ error: "Bad request", message: `Refund request already ${rr.status}` });
      return;
    }

    await db
      .updateTable("refund_requests")
      .set({
        status: "rejected",
        reviewed_by: req.apiUser!.id,
        reviewed_at: new Date().toISOString(),
        review_note: note,
      })
      .where("id", "=", rrId)
      .execute();

    await logApi(
      db, req.apiUser!.id, rr.shop_id, "refund_rejected",
      "refund_request", rrId, { note }, req.ip || null
    );

    await db
      .insertInto("notifications")
      .values({
        shop_id: rr.shop_id,
        type: "refund",
        title: `Refund rejected for Order #${rr.order_number}`,
        message: note,
      })
      .execute()
      .catch(() => {});

    res.json({ refund_request: { id: rrId, status: "rejected" } });
  } catch (err: any) {
    apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/god/stores — all stores with stats
// ---------------------------------------------------------------------------

app.get("/api/god/stores", godAdmin, async (req: Request, res: Response) => {
  try {
    const shops = await db
      .selectFrom("shops")
      .selectAll()
      .orderBy("created_at", "desc")
      .execute();

    // Fetch stats per shop
    const storesWithStats = await Promise.all(
      shops.map(async (shop) => {
        const orderStats = await db
          .selectFrom("orders")
          .select([
            db.fn.countAll().as("total_orders"),
            db.fn.sum("total_price").as("total_revenue"),
          ])
          .where("shop_id", "=", shop.id)
          .executeTakeFirst();

        const productCount = await db
          .selectFrom("products")
          .select(db.fn.countAll().as("count"))
          .where("shop_id", "=", shop.id)
          .executeTakeFirst();

        const customerCount = await db
          .selectFrom("customers")
          .select(db.fn.countAll().as("count"))
          .where("shop_id", "=", shop.id)
          .executeTakeFirst();

        return {
          ...shop,
          stats: {
            total_orders: Number(orderStats?.total_orders || 0),
            total_revenue: orderStats?.total_revenue || "0",
            total_products: Number(productCount?.count || 0),
            total_customers: Number(customerCount?.count || 0),
          },
        };
      })
    );

    res.json({ stores: storesWithStats, count: storesWithStats.length });
  } catch (err: any) {
    apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/god/stores/:id — store detail
// ---------------------------------------------------------------------------

app.get("/api/god/stores/:id", godAdmin, async (req: Request, res: Response) => {
  try {
    const shop = await db
      .selectFrom("shops")
      .selectAll()
      .where("id", "=", req.params.id)
      .executeTakeFirst();

    if (!shop) {
      res.status(404).json({ error: "Not found", message: "Store not found" });
      return;
    }

    const members = await db
      .selectFrom("user_shops as us")
      .innerJoin("users as u", "u.id", "us.user_id")
      .select(["u.id", "u.email", "u.name", "us.role", "us.created_at"])
      .where("us.shop_id", "=", shop.id)
      .execute();

    const orderStats = await db
      .selectFrom("orders")
      .select([
        db.fn.countAll().as("total_orders"),
        db.fn.sum("total_price").as("total_revenue"),
      ])
      .where("shop_id", "=", shop.id)
      .executeTakeFirst();

    res.json({
      store: shop,
      members,
      stats: {
        total_orders: Number(orderStats?.total_orders || 0),
        total_revenue: orderStats?.total_revenue || "0",
      },
    });
  } catch (err: any) {
    apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/god/stores/:id/suspend
// ---------------------------------------------------------------------------

app.post("/api/god/stores/:id/suspend", godAdmin, async (req: Request, res: Response) => {
  try {
    const shopId = req.params.id;

    const shop = await db
      .selectFrom("shops")
      .select(["id", "name", "status"])
      .where("id", "=", shopId)
      .executeTakeFirst();

    if (!shop) {
      res.status(404).json({ error: "Not found", message: "Store not found" });
      return;
    }

    if (shop.status === "suspended") {
      res.status(400).json({ error: "Bad request", message: "Store is already suspended" });
      return;
    }

    await db
      .updateTable("shops")
      .set({ status: "suspended", updated_at: new Date().toISOString() })
      .where("id", "=", shopId)
      .execute();

    await logApi(
      db, req.apiUser!.id, shopId, "store_suspended",
      "shop", shopId, { previous_status: shop.status }, req.ip || null
    );

    res.json({ store: { id: shopId, name: shop.name, status: "suspended" } });
  } catch (err: any) {
    apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/god/stores/:id/reactivate
// ---------------------------------------------------------------------------

app.post("/api/god/stores/:id/reactivate", godAdmin, async (req: Request, res: Response) => {
  try {
    const shopId = req.params.id;

    const shop = await db
      .selectFrom("shops")
      .select(["id", "name", "status"])
      .where("id", "=", shopId)
      .executeTakeFirst();

    if (!shop) {
      res.status(404).json({ error: "Not found", message: "Store not found" });
      return;
    }

    if (shop.status === "active") {
      res.status(400).json({ error: "Bad request", message: "Store is already active" });
      return;
    }

    await db
      .updateTable("shops")
      .set({ status: "active", updated_at: new Date().toISOString() })
      .where("id", "=", shopId)
      .execute();

    await logApi(
      db, req.apiUser!.id, shopId, "store_reactivated",
      "shop", shopId, { previous_status: shop.status }, req.ip || null
    );

    res.json({ store: { id: shopId, name: shop.name, status: "active" } });
  } catch (err: any) {
    apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/god/users — all users
// ---------------------------------------------------------------------------

app.get("/api/god/users", godAdmin, async (req: Request, res: Response) => {
  try {
    const users = await db
      .selectFrom("users")
      .select(["id", "email", "name", "role", "status", "is_default_admin", "created_at", "updated_at"])
      .orderBy("created_at", "desc")
      .limit(200)
      .execute();

    res.json({ users, count: users.length });
  } catch (err: any) {
    apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/god/orders — all orders across all stores
// ---------------------------------------------------------------------------

app.get("/api/god/orders", godAdmin, async (req: Request, res: Response) => {
  try {
    const shopId = req.query.shop_id as string | undefined;
    const status = req.query.status as string | undefined;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const offset = parseInt(req.query.offset as string) || 0;

    let query = db
      .selectFrom("orders as o")
      .innerJoin("shops as s", "s.id", "o.shop_id")
      .select([
        "o.id", "o.order_number", "o.email",
        "o.financial_status", "o.fulfillment_status",
        "o.total_price", "o.currency", "o.created_at",
        "s.id as shop_id", "s.name as shop_name", "s.slug as shop_slug",
      ])
      .orderBy("o.created_at", "desc");

    if (shopId) query = query.where("o.shop_id", "=", shopId);
    if (status) query = query.where("o.financial_status", "=", status);

    const orders = await query.limit(limit).offset(offset).execute();
    res.json({ orders, count: orders.length });
  } catch (err: any) {
    apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/god/finance/overview — GMV, revenue stats
// ---------------------------------------------------------------------------

app.get("/api/god/finance/overview", godAdmin, async (req: Request, res: Response) => {
  try {
    // Total GMV (all orders)
    const gmv = await db
      .selectFrom("orders")
      .select([
        db.fn.countAll().as("total_orders"),
        db.fn.sum("total_price").as("gmv"),
        db.fn.sum("total_shipping").as("total_shipping"),
        db.fn.sum("total_tax").as("total_tax"),
        db.fn.sum("total_discounts").as("total_discounts"),
      ])
      .executeTakeFirst();

    // Paid orders only
    const paidStats = await db
      .selectFrom("orders")
      .select([
        db.fn.countAll().as("paid_orders"),
        db.fn.sum("total_price").as("paid_revenue"),
      ])
      .where("financial_status", "=", "paid")
      .executeTakeFirst();

    // Refund totals
    const refundStats = await db
      .selectFrom("transactions")
      .select([
        db.fn.countAll().as("refund_count"),
        db.fn.sum("amount").as("refund_total"),
      ])
      .where("kind", "=", "refund")
      .where("status", "=", "success")
      .executeTakeFirst();

    // Store count
    const storeCount = await db
      .selectFrom("shops")
      .select(db.fn.countAll().as("count"))
      .where("status", "=", "active")
      .executeTakeFirst();

    res.json({
      gmv: gmv?.gmv || "0",
      total_orders: Number(gmv?.total_orders || 0),
      total_shipping: gmv?.total_shipping || "0",
      total_tax: gmv?.total_tax || "0",
      total_discounts: gmv?.total_discounts || "0",
      paid_orders: Number(paidStats?.paid_orders || 0),
      paid_revenue: paidStats?.paid_revenue || "0",
      refund_count: Number(refundStats?.refund_count || 0),
      refund_total: refundStats?.refund_total || "0",
      active_stores: Number(storeCount?.count || 0),
    });
  } catch (err: any) {
    apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' });
  }
});

// ===========================================================================
// PHASE 4: STORE MANAGEMENT APIs (C1-C9)
// ===========================================================================

// ---------------------------------------------------------------------------
// C1: PUT /api/god/stores/:id/settings — update store settings
// ---------------------------------------------------------------------------

app.put("/api/god/stores/:id/settings", godAdmin, async (req: Request, res: Response) => {
  try {
    const shopId = req.params.id;
    const { name, email, phone, address, city, province, country, zip, currency, timezone, logo_url } = req.body;

    const shop = await db.selectFrom("shops").select(["id", "name"]).where("id", "=", shopId).executeTakeFirst();
    if (!shop) { res.status(404).json({ error: "Not found", message: "Store not found" }); return; }

    const updates: Record<string, any> = { updated_at: new Date().toISOString() };
    if (name !== undefined) updates.name = name;
    if (email !== undefined) updates.email = email;
    if (phone !== undefined) updates.phone = phone;
    if (address !== undefined) updates.address = address;
    if (city !== undefined) updates.city = city;
    if (province !== undefined) updates.province = province;
    if (country !== undefined) updates.country = country;
    if (zip !== undefined) updates.zip = zip;
    if (currency !== undefined) updates.currency = currency;
    if (timezone !== undefined) updates.timezone = timezone;
    if (logo_url !== undefined) updates.logo_url = logo_url;

    const updated = await db.updateTable("shops").set(updates).where("id", "=", shopId).returningAll().executeTakeFirstOrThrow();

    await logApi(db, req.apiUser!.id, shopId, "store_settings_updated", "shop", shopId, { fields: Object.keys(updates).filter(k => k !== "updated_at") }, req.ip || null);
    res.json({ store: updated });
  } catch (err: any) {
    apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// C2: PUT /api/god/stores/:id/plan — change store plan
// ---------------------------------------------------------------------------

app.put("/api/god/stores/:id/plan", godAdmin, async (req: Request, res: Response) => {
  try {
    const shopId = req.params.id;
    const { plan } = req.body;
    if (!plan) { res.status(400).json({ error: "Bad request", message: "plan is required" }); return; }

    const shop = await db.selectFrom("shops").select(["id", "name", "plan"]).where("id", "=", shopId).executeTakeFirst();
    if (!shop) { res.status(404).json({ error: "Not found", message: "Store not found" }); return; }

    await db.updateTable("shops").set({ plan, updated_at: new Date().toISOString() }).where("id", "=", shopId).execute();

    await logApi(db, req.apiUser!.id, shopId, "store_plan_changed", "shop", shopId, { old_plan: shop.plan, new_plan: plan }, req.ip || null);
    await db.insertInto("notifications").values({ shop_id: shopId, type: "system", title: `Store plan changed to ${plan}`, message: `Your store plan has been updated from ${shop.plan || "none"} to ${plan}` }).execute().catch(() => {});

    res.json({ store: { id: shopId, name: shop.name, plan } });
  } catch (err: any) {
    apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// C3: POST /api/god/stores/:id/close — force-close store
// ---------------------------------------------------------------------------

app.post("/api/god/stores/:id/close", godAdmin, async (req: Request, res: Response) => {
  try {
    const shopId = req.params.id;
    const { reason } = req.body || {};

    const shop = await db.selectFrom("shops").select(["id", "name", "status"]).where("id", "=", shopId).executeTakeFirst();
    if (!shop) { res.status(404).json({ error: "Not found", message: "Store not found" }); return; }
    if (shop.status === "closed") { res.status(400).json({ error: "Bad request", message: "Store is already closed" }); return; }

    await db.updateTable("shops").set({ status: "closed", updated_at: new Date().toISOString() }).where("id", "=", shopId).execute();

    await logApi(db, req.apiUser!.id, shopId, "store_closed", "shop", shopId, { previous_status: shop.status, reason }, req.ip || null);
    await db.insertInto("notifications").values({ shop_id: shopId, type: "system", title: "Store has been closed", message: reason || "Your store has been closed by the platform administrator" }).execute().catch(() => {});

    res.json({ store: { id: shopId, name: shop.name, status: "closed" } });
  } catch (err: any) {
    apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// C4: GET /api/god/stores/:id/domains — list store domains
// ---------------------------------------------------------------------------

app.get("/api/god/stores/:id/domains", godAdmin, async (req: Request, res: Response) => {
  try {
    const domains = await db.selectFrom("shop_domains").selectAll().where("shop_id", "=", req.params.id).orderBy("created_at", "desc").execute();
    res.json({ domains, count: domains.length });
  } catch (err: any) {
    apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// C5: POST /api/god/stores/:id/domains — add domain
// ---------------------------------------------------------------------------

app.post("/api/god/stores/:id/domains", godAdmin, async (req: Request, res: Response) => {
  try {
    const shopId = req.params.id;
    const { domain, is_primary } = req.body;
    if (!domain) { res.status(400).json({ error: "Bad request", message: "domain is required" }); return; }

    const shop = await db.selectFrom("shops").select("id").where("id", "=", shopId).executeTakeFirst();
    if (!shop) { res.status(404).json({ error: "Not found", message: "Store not found" }); return; }

    const newDomain = await db.insertInto("shop_domains").values({ shop_id: shopId, domain, is_primary: is_primary || false }).returningAll().executeTakeFirstOrThrow();

    await logApi(db, req.apiUser!.id, shopId, "domain_added", "shop_domain", newDomain.id, { domain }, req.ip || null);
    res.status(201).json({ domain: newDomain });
  } catch (err: any) {
    apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// C6: DELETE /api/god/stores/:id/domains/:domainId — remove domain
// ---------------------------------------------------------------------------

app.delete("/api/god/stores/:id/domains/:domainId", godAdmin, async (req: Request, res: Response) => {
  try {
    const { id: shopId, domainId } = req.params;

    const domain = await db.selectFrom("shop_domains").select(["id", "domain"]).where("id", "=", domainId).where("shop_id", "=", shopId).executeTakeFirst();
    if (!domain) { res.status(404).json({ error: "Not found", message: "Domain not found" }); return; }

    await db.deleteFrom("shop_domains").where("id", "=", domainId).execute();
    await logApi(db, req.apiUser!.id, shopId, "domain_removed", "shop_domain", domainId, { domain: domain.domain }, req.ip || null);

    res.json({ deleted: true, domain: domain.domain });
  } catch (err: any) {
    apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// C7: GET /api/store/:slug/settings — seller view own store settings
// ---------------------------------------------------------------------------

app.get("/api/store/:slug/settings", storeAccess, async (req: Request, res: Response) => {
  try {
    const shop = await db.selectFrom("shops").selectAll().where("id", "=", req.apiStore!.id).executeTakeFirst();
    const settings = await db.selectFrom("shop_settings").select(["key", "value"]).where("shop_id", "=", req.apiStore!.id).execute();

    const settingsMap: Record<string, any> = {};
    for (const s of settings) settingsMap[s.key] = s.value;

    res.json({ store: shop, settings: settingsMap });
  } catch (err: any) {
    apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// C8: PUT /api/store/:slug/settings — seller update own store (limited)
// ---------------------------------------------------------------------------

app.put("/api/store/:slug/settings", storeAccess, async (req: Request, res: Response) => {
  try {
    const { name, email, phone, address, city, province, country, zip, logo_url } = req.body;
    const shopId = req.apiStore!.id;

    const updates: Record<string, any> = { updated_at: new Date().toISOString() };
    if (name !== undefined) updates.name = name;
    if (email !== undefined) updates.email = email;
    if (phone !== undefined) updates.phone = phone;
    if (address !== undefined) updates.address = address;
    if (city !== undefined) updates.city = city;
    if (province !== undefined) updates.province = province;
    if (country !== undefined) updates.country = country;
    if (zip !== undefined) updates.zip = zip;
    if (logo_url !== undefined) updates.logo_url = logo_url;
    // Sellers CANNOT change: plan, status, slug, currency, timezone

    const updated = await db.updateTable("shops").set(updates).where("id", "=", shopId).returningAll().executeTakeFirstOrThrow();
    await logApi(db, req.apiUser!.id, shopId, "store_settings_updated", "shop", shopId, { fields: Object.keys(updates).filter(k => k !== "updated_at"), by: "seller" }, req.ip || null);

    res.json({ store: updated });
  } catch (err: any) {
    apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' });
  }
});

// ===========================================================================
// PHASE 5: USER/STAFF APIs (D1-D9)
// ===========================================================================

// ---------------------------------------------------------------------------
// D1: GET /api/god/users/:id — user detail
// ---------------------------------------------------------------------------

app.get("/api/god/users/:id", godAdmin, async (req: Request, res: Response) => {
  try {
    const user = await db
      .selectFrom("users")
      .select(["id", "email", "name", "role", "status", "is_default_admin", "avatar_url", "created_at", "updated_at"])
      .where("id", "=", req.params.id)
      .executeTakeFirst();

    if (!user) { res.status(404).json({ error: "Not found", message: "User not found" }); return; }

    const stores = await db
      .selectFrom("user_shops as us")
      .innerJoin("shops as s", "s.id", "us.shop_id")
      .select(["s.id", "s.name", "s.slug", "s.status as shop_status", "us.role as store_role", "us.permissions", "us.created_at"])
      .where("us.user_id", "=", req.params.id)
      .execute();

    const sessionCount = await db
      .selectFrom("sessions")
      .select(db.fn.countAll().as("count"))
      .where("user_id", "=", req.params.id)
      .where("expires_at", ">", new Date().toISOString())
      .executeTakeFirst();

    res.json({ user, stores, active_sessions: Number(sessionCount?.count || 0) });
  } catch (err: any) {
    apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// D2: POST /api/god/users/:id/disable — disable user
// ---------------------------------------------------------------------------

app.post("/api/god/users/:id/disable", godAdmin, async (req: Request, res: Response) => {
  try {
    const userId = req.params.id;
    const user = await db.selectFrom("users").select(["id", "email", "name", "role", "status", "is_default_admin"]).where("id", "=", userId).executeTakeFirst();
    if (!user) { res.status(404).json({ error: "Not found", message: "User not found" }); return; }
    if (user.is_default_admin) { res.status(403).json({ error: "Forbidden", message: "Cannot disable the Default God Admin" }); return; }
    if (user.status === "disabled") { res.status(400).json({ error: "Bad request", message: "User is already disabled" }); return; }

    await db.updateTable("users").set({ status: "disabled", updated_at: new Date().toISOString() }).where("id", "=", userId).execute();
    // Invalidate sessions
    await db.deleteFrom("sessions").where("user_id", "=", userId).execute();

    await logApi(db, req.apiUser!.id, null, "user_disabled", "user", userId, { email: user.email }, req.ip || null);
    res.json({ user: { id: userId, email: user.email, status: "disabled" } });
  } catch (err: any) {
    apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// D3: POST /api/god/users/:id/enable — enable user
// ---------------------------------------------------------------------------

app.post("/api/god/users/:id/enable", godAdmin, async (req: Request, res: Response) => {
  try {
    const userId = req.params.id;
    const user = await db.selectFrom("users").select(["id", "email", "status"]).where("id", "=", userId).executeTakeFirst();
    if (!user) { res.status(404).json({ error: "Not found", message: "User not found" }); return; }
    if (user.status === "active") { res.status(400).json({ error: "Bad request", message: "User is already active" }); return; }

    await db.updateTable("users").set({ status: "active", updated_at: new Date().toISOString() }).where("id", "=", userId).execute();
    await logApi(db, req.apiUser!.id, null, "user_enabled", "user", userId, { email: user.email }, req.ip || null);

    res.json({ user: { id: userId, email: user.email, status: "active" } });
  } catch (err: any) {
    apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// D4: PUT /api/god/users/:id/role — update user global role
// ---------------------------------------------------------------------------

app.put("/api/god/users/:id/role", godAdmin, async (req: Request, res: Response) => {
  try {
    const userId = req.params.id;
    const { role } = req.body;
    if (!role || !["owner", "admin", "staff"].includes(role)) {
      res.status(400).json({ error: "Bad request", message: "Valid role required: owner, admin, staff" }); return;
    }

    const user = await db.selectFrom("users").select(["id", "email", "role", "is_default_admin"]).where("id", "=", userId).executeTakeFirst();
    if (!user) { res.status(404).json({ error: "Not found", message: "User not found" }); return; }
    if (user.is_default_admin && role !== "owner") { res.status(403).json({ error: "Forbidden", message: "Cannot demote the Default God Admin" }); return; }

    await db.updateTable("users").set({ role, updated_at: new Date().toISOString() }).where("id", "=", userId).execute();
    await logApi(db, req.apiUser!.id, null, "user_role_updated", "user", userId, { email: user.email, old_role: user.role, new_role: role }, req.ip || null);

    res.json({ user: { id: userId, email: user.email, role } });
  } catch (err: any) {
    apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// D5: GET /api/god/users/:id/stores — list user's stores
// ---------------------------------------------------------------------------

app.get("/api/god/users/:id/stores", godAdmin, async (req: Request, res: Response) => {
  try {
    const stores = await db
      .selectFrom("user_shops as us")
      .innerJoin("shops as s", "s.id", "us.shop_id")
      .select(["s.id", "s.name", "s.slug", "s.status", "s.plan", "s.created_at as shop_created_at", "us.role", "us.permissions", "us.created_at as joined_at"])
      .where("us.user_id", "=", req.params.id)
      .orderBy("us.created_at", "desc")
      .execute();

    res.json({ stores, count: stores.length });
  } catch (err: any) {
    apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// D6: GET /api/store/:slug/staff — list store staff
// ---------------------------------------------------------------------------

app.get("/api/store/:slug/staff", storeAccess, async (req: Request, res: Response) => {
  try {
    const staff = await db
      .selectFrom("user_shops as us")
      .innerJoin("users as u", "u.id", "us.user_id")
      .select(["u.id", "u.email", "u.name", "u.avatar_url", "u.status as user_status", "us.role", "us.permissions", "us.created_at"])
      .where("us.shop_id", "=", req.apiStore!.id)
      .orderBy("us.created_at", "asc")
      .execute();

    res.json({ staff, count: staff.length });
  } catch (err: any) {
    apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// D7: POST /api/store/:slug/staff/invite — invite staff by email
// ---------------------------------------------------------------------------

app.post("/api/store/:slug/staff/invite", storeAccess, validate(schemas.inviteStaff), async (req: Request, res: Response) => {
  try {
    const { email, role } = req.body;
    // Zod already validated: email format, role enum (admin/staff/limited)

    const user = await db.selectFrom("users").select(["id", "email", "name"]).where("email", "=", email).executeTakeFirst();
    if (!user) { res.status(404).json({ error: "Not found", message: "User not found. They must register an account first." }); return; }

    // Check if already a member
    const existing = await db.selectFrom("user_shops").select("user_id").where("user_id", "=", user.id).where("shop_id", "=", req.apiStore!.id).executeTakeFirst();
    if (existing) { res.status(409).json({ error: "Conflict", message: "User is already a member of this store" }); return; }

    const permissions = req.body.permissions ?? null;

    await db.insertInto("user_shops").values({
      user_id: user.id,
      shop_id: req.apiStore!.id,
      role,
      permissions: permissions ? JSON.stringify(permissions) : null,
    }).execute();

    await logApi(db, req.apiUser!.id, req.apiStore!.id, "staff_invited", "user", user.id, { email, role }, req.ip || null);
    await db.insertInto("notifications").values({
      shop_id: req.apiStore!.id,
      user_id: user.id,
      type: "system",
      title: `You've been invited to ${req.apiStore!.name}`,
      message: `You now have ${role} access to this store`,
    }).execute().catch(() => {});

    res.status(201).json({ staff: { user_id: user.id, email: user.email, name: user.name, role } });
  } catch (err: any) {
    apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// D8: PUT /api/store/:slug/staff/:userId/role — update staff role
// ---------------------------------------------------------------------------

app.put("/api/store/:slug/staff/:userId/role", storeAccess, validate(schemas.updateStaffRole), async (req: Request, res: Response) => {
  try {
    const { userId } = req.params;
    const { role } = req.body;
    // Zod already validated: role enum (admin/staff/limited)

    if (userId === req.apiUser!.id) { res.status(400).json({ error: "Bad request", message: "Cannot change your own role" }); return; }

    const membership = await db.selectFrom("user_shops").select(["user_id", "role"]).where("user_id", "=", userId).where("shop_id", "=", req.apiStore!.id).executeTakeFirst();
    if (!membership) { res.status(404).json({ error: "Not found", message: "User is not a member of this store" }); return; }

    const permissions = req.body.permissions ?? undefined;
    const updates: Record<string, any> = { role };
    if (permissions !== undefined) updates.permissions = JSON.stringify(permissions);

    await db.updateTable("user_shops").set(updates).where("user_id", "=", userId).where("shop_id", "=", req.apiStore!.id).execute();
    await logApi(db, req.apiUser!.id, req.apiStore!.id, "staff_role_updated", "user", userId, { old_role: membership.role, new_role: role }, req.ip || null);

    res.json({ staff: { user_id: userId, role, permissions: permissions ?? null } });
  } catch (err: any) {
    apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// D9: DELETE /api/store/:slug/staff/:userId — remove staff
// ---------------------------------------------------------------------------

app.delete("/api/store/:slug/staff/:userId", storeAccess, async (req: Request, res: Response) => {
  try {
    const { userId } = req.params;
    if (userId === req.apiUser!.id) { res.status(400).json({ error: "Bad request", message: "Cannot remove yourself from the store" }); return; }

    const membership = await db.selectFrom("user_shops as us").innerJoin("users as u", "u.id", "us.user_id").select(["us.user_id", "us.role", "u.email"]).where("us.user_id", "=", userId).where("us.shop_id", "=", req.apiStore!.id).executeTakeFirst();
    if (!membership) { res.status(404).json({ error: "Not found", message: "User is not a member of this store" }); return; }

    await db.deleteFrom("user_shops").where("user_id", "=", userId).where("shop_id", "=", req.apiStore!.id).execute();
    await logApi(db, req.apiUser!.id, req.apiStore!.id, "staff_removed", "user", userId, { email: membership.email, role: membership.role }, req.ip || null);

    await db.insertInto("notifications").values({
      shop_id: req.apiStore!.id,
      user_id: userId,
      type: "system",
      title: `Access removed from ${req.apiStore!.name}`,
      message: "You have been removed from this store by an administrator",
    }).execute().catch(() => {});

    res.json({ deleted: true, user_id: userId, email: membership.email });
  } catch (err: any) {
    apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' });
  }
});

// ===========================================================================
// PHASE 6: FINANCE APIs (E1-E7)
// ===========================================================================

// ---------------------------------------------------------------------------
// E1: GET /api/god/finance/stores/:id — store-level finance breakdown
// ---------------------------------------------------------------------------

app.get("/api/god/finance/stores/:id", godAdmin, async (req: Request, res: Response) => {
  try {
    const shopId = req.params.id;

    const shop = await db.selectFrom("shops").select(["id", "name", "slug"]).where("id", "=", shopId).executeTakeFirst();
    if (!shop) { res.status(404).json({ error: "Not found", message: "Store not found" }); return; }

    const orderStats = await db
      .selectFrom("orders")
      .select([
        db.fn.countAll().as("total_orders"),
        db.fn.sum("total_price").as("gmv"),
        db.fn.sum("total_shipping").as("total_shipping"),
        db.fn.sum("total_tax").as("total_tax"),
        db.fn.sum("total_discounts").as("total_discounts"),
      ])
      .where("shop_id", "=", shopId)
      .executeTakeFirst();

    const paidStats = await db
      .selectFrom("orders")
      .select([db.fn.countAll().as("paid_orders"), db.fn.sum("total_price").as("paid_revenue")])
      .where("shop_id", "=", shopId)
      .where("financial_status", "=", "paid")
      .executeTakeFirst();

    const refundStats = await db
      .selectFrom("transactions as t")
      .innerJoin("orders as o", "o.id", "t.order_id")
      .select([db.fn.countAll().as("refund_count"), db.fn.sum("t.amount").as("refund_total")])
      .where("o.shop_id", "=", shopId)
      .where("t.kind", "=", "refund")
      .where("t.status", "=", "success")
      .executeTakeFirst();

    // Last 30 days revenue
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    const recentStats = await db
      .selectFrom("orders")
      .select([db.fn.countAll().as("recent_orders"), db.fn.sum("total_price").as("recent_revenue")])
      .where("shop_id", "=", shopId)
      .where("created_at", ">=", thirtyDaysAgo)
      .executeTakeFirst();

    // Commission rate from shop_settings
    const commissionSetting = await db.selectFrom("shop_settings").select("value").where("shop_id", "=", shopId).where("key", "=", "platform_commission_rate").executeTakeFirst();
    const commissionRate = commissionSetting ? parseFloat(commissionSetting.value as any) : 0;

    const paidRevenue = parseFloat(paidStats?.paid_revenue as string || "0");
    const refundTotal = parseFloat(refundStats?.refund_total as string || "0");
    const netRevenue = paidRevenue - refundTotal;
    const platformCommission = netRevenue * (commissionRate / 100);

    res.json({
      store: shop,
      finance: {
        gmv: orderStats?.gmv || "0",
        total_orders: Number(orderStats?.total_orders || 0),
        total_shipping: orderStats?.total_shipping || "0",
        total_tax: orderStats?.total_tax || "0",
        total_discounts: orderStats?.total_discounts || "0",
        paid_orders: Number(paidStats?.paid_orders || 0),
        paid_revenue: paidStats?.paid_revenue || "0",
        refund_count: Number(refundStats?.refund_count || 0),
        refund_total: refundStats?.refund_total || "0",
        net_revenue: netRevenue.toFixed(2),
        commission_rate: commissionRate,
        platform_commission: platformCommission.toFixed(2),
        estimated_payout: (netRevenue - platformCommission).toFixed(2),
        last_30_days: {
          orders: Number(recentStats?.recent_orders || 0),
          revenue: recentStats?.recent_revenue || "0",
        },
      },
    });
  } catch (err: any) {
    apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// E2: GET /api/god/finance/transactions — all transactions
// ---------------------------------------------------------------------------

app.get("/api/god/finance/transactions", godAdmin, async (req: Request, res: Response) => {
  try {
    const shopId = req.query.shop_id as string | undefined;
    const kind = req.query.kind as string | undefined;
    const status = req.query.status as string | undefined;
    const gateway = req.query.gateway as string | undefined;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const offset = parseInt(req.query.offset as string) || 0;

    let query = db
      .selectFrom("transactions as t")
      .innerJoin("orders as o", "o.id", "t.order_id")
      .innerJoin("shops as s", "s.id", "o.shop_id")
      .select([
        "t.id", "t.order_id", "t.kind", "t.gateway", "t.amount", "t.currency",
        "t.status", "t.authorization", "t.error_code", "t.message", "t.created_at",
        "o.order_number", "o.email as order_email",
        "s.id as shop_id", "s.name as shop_name",
      ])
      .orderBy("t.created_at", "desc");

    if (shopId) query = query.where("o.shop_id", "=", shopId);
    if (kind) query = query.where("t.kind", "=", kind);
    if (status) query = query.where("t.status", "=", status);
    if (gateway) query = query.where("t.gateway", "=", gateway);

    const transactions = await query.limit(limit).offset(offset).execute();
    res.json({ transactions, count: transactions.length });
  } catch (err: any) {
    apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// E3: GET /api/god/finance/payouts — payout summary per store
// ---------------------------------------------------------------------------

app.get("/api/god/finance/payouts", godAdmin, async (req: Request, res: Response) => {
  try {
    const shops = await db.selectFrom("shops").select(["id", "name", "slug", "status"]).where("status", "=", "active").execute();

    const payouts = await Promise.all(shops.map(async (shop) => {
      const sales = await db
        .selectFrom("transactions as t")
        .innerJoin("orders as o", "o.id", "t.order_id")
        .select(db.fn.sum("t.amount").as("total"))
        .where("o.shop_id", "=", shop.id)
        .where("t.kind", "=", "sale")
        .where("t.status", "=", "success")
        .executeTakeFirst();

      const refunds = await db
        .selectFrom("transactions as t")
        .innerJoin("orders as o", "o.id", "t.order_id")
        .select(db.fn.sum("t.amount").as("total"))
        .where("o.shop_id", "=", shop.id)
        .where("t.kind", "=", "refund")
        .where("t.status", "=", "success")
        .executeTakeFirst();

      const commissionSetting = await db.selectFrom("shop_settings").select("value").where("shop_id", "=", shop.id).where("key", "=", "platform_commission_rate").executeTakeFirst();
      const rate = commissionSetting ? parseFloat(commissionSetting.value as any) : 0;

      const salesTotal = parseFloat(sales?.total as string || "0");
      const refundsTotal = parseFloat(refunds?.total as string || "0");
      const net = salesTotal - refundsTotal;
      const commission = net * (rate / 100);

      return {
        shop_id: shop.id,
        shop_name: shop.name,
        shop_slug: shop.slug,
        gross_sales: salesTotal.toFixed(2),
        refunds: refundsTotal.toFixed(2),
        net_revenue: net.toFixed(2),
        commission_rate: rate,
        platform_commission: commission.toFixed(2),
        estimated_payout: (net - commission).toFixed(2),
      };
    }));

    res.json({ payouts, count: payouts.length });
  } catch (err: any) {
    apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// E4: PUT /api/god/finance/commission — set commission rate
// ---------------------------------------------------------------------------

app.put("/api/god/finance/commission", godAdmin, async (req: Request, res: Response) => {
  try {
    const { shop_id, rate } = req.body;
    if (rate === undefined || isNaN(parseFloat(rate))) { res.status(400).json({ error: "Bad request", message: "rate is required (numeric)" }); return; }

    if (shop_id) {
      const shop = await db.selectFrom("shops").select("id").where("id", "=", shop_id).executeTakeFirst();
      if (!shop) { res.status(404).json({ error: "Not found", message: "Store not found" }); return; }

      // Upsert shop_settings
      const existing = await db.selectFrom("shop_settings").select("id").where("shop_id", "=", shop_id).where("key", "=", "platform_commission_rate").executeTakeFirst();
      if (existing) {
        await db.updateTable("shop_settings").set({ value: JSON.stringify(rate), updated_at: new Date().toISOString() }).where("id", "=", existing.id).execute();
      } else {
        await db.insertInto("shop_settings").values({ shop_id, key: "platform_commission_rate", value: JSON.stringify(rate) }).execute();
      }

      await logApi(db, req.apiUser!.id, shop_id, "commission_updated", "shop", shop_id, { rate }, req.ip || null);
      res.json({ shop_id, rate: parseFloat(rate), scope: "store" });
    } else {
      // Apply to all active stores
      const shops = await db.selectFrom("shops").select("id").where("status", "=", "active").execute();
      for (const s of shops) {
        const existing = await db.selectFrom("shop_settings").select("id").where("shop_id", "=", s.id).where("key", "=", "platform_commission_rate").executeTakeFirst();
        if (existing) {
          await db.updateTable("shop_settings").set({ value: JSON.stringify(rate), updated_at: new Date().toISOString() }).where("id", "=", existing.id).execute();
        } else {
          await db.insertInto("shop_settings").values({ shop_id: s.id, key: "platform_commission_rate", value: JSON.stringify(rate) }).execute();
        }
      }
      await logApi(db, req.apiUser!.id, null, "commission_updated_global", "platform", null, { rate, affected_stores: shops.length }, req.ip || null);
      res.json({ rate: parseFloat(rate), scope: "global", affected_stores: shops.length });
    }
  } catch (err: any) {
    apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// E5: GET /api/store/:slug/finance/transactions — seller's transactions
// ---------------------------------------------------------------------------

app.get("/api/store/:slug/finance/transactions", storeAccess, async (req: Request, res: Response) => {
  try {
    const kind = req.query.kind as string | undefined;
    const status = req.query.status as string | undefined;
    const dateFrom = req.query.date_from as string | undefined;
    const dateTo = req.query.date_to as string | undefined;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const offset = parseInt(req.query.offset as string) || 0;

    let query = db
      .selectFrom("transactions as t")
      .innerJoin("orders as o", "o.id", "t.order_id")
      .select([
        "t.id", "t.order_id", "t.kind", "t.gateway", "t.amount", "t.currency",
        "t.status", "t.message", "t.created_at",
        "o.order_number", "o.email as order_email",
      ])
      .where("o.shop_id", "=", req.apiStore!.id)
      .orderBy("t.created_at", "desc");

    if (kind) query = query.where("t.kind", "=", kind);
    if (status) query = query.where("t.status", "=", status);
    if (dateFrom) query = query.where("t.created_at", ">=", dateFrom);
    if (dateTo) query = query.where("t.created_at", "<=", dateTo);

    const transactions = await query.limit(limit).offset(offset).execute();
    res.json({ transactions, count: transactions.length });
  } catch (err: any) {
    apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// E6: GET /api/store/:slug/finance/summary — seller's revenue summary
// ---------------------------------------------------------------------------

app.get("/api/store/:slug/finance/summary", storeAccess, async (req: Request, res: Response) => {
  try {
    const shopId = req.apiStore!.id;

    const total = await db
      .selectFrom("orders")
      .select([
        db.fn.countAll().as("total_orders"),
        db.fn.sum("total_price").as("total_revenue"),
        db.fn.sum("total_shipping").as("total_shipping"),
        db.fn.sum("total_tax").as("total_tax"),
        db.fn.sum("total_discounts").as("total_discounts"),
      ])
      .where("shop_id", "=", shopId)
      .executeTakeFirst();

    const paid = await db
      .selectFrom("orders")
      .select([db.fn.countAll().as("count"), db.fn.sum("total_price").as("revenue")])
      .where("shop_id", "=", shopId)
      .where("financial_status", "=", "paid")
      .executeTakeFirst();

    const refunds = await db
      .selectFrom("transactions as t")
      .innerJoin("orders as o", "o.id", "t.order_id")
      .select([db.fn.countAll().as("count"), db.fn.sum("t.amount").as("total")])
      .where("o.shop_id", "=", shopId)
      .where("t.kind", "=", "refund")
      .where("t.status", "=", "success")
      .executeTakeFirst();

    // Current month
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    const currentMonth = await db
      .selectFrom("orders")
      .select([db.fn.countAll().as("count"), db.fn.sum("total_price").as("revenue")])
      .where("shop_id", "=", shopId)
      .where("created_at", ">=", monthStart.toISOString())
      .executeTakeFirst();

    // Previous month
    const prevMonthStart = new Date(monthStart);
    prevMonthStart.setMonth(prevMonthStart.getMonth() - 1);
    const prevMonth = await db
      .selectFrom("orders")
      .select([db.fn.countAll().as("count"), db.fn.sum("total_price").as("revenue")])
      .where("shop_id", "=", shopId)
      .where("created_at", ">=", prevMonthStart.toISOString())
      .where("created_at", "<", monthStart.toISOString())
      .executeTakeFirst();

    const paidRevenue = parseFloat(paid?.revenue as string || "0");
    const refundTotal = parseFloat(refunds?.total as string || "0");

    res.json({
      summary: {
        total_orders: Number(total?.total_orders || 0),
        total_revenue: total?.total_revenue || "0",
        total_shipping: total?.total_shipping || "0",
        total_tax: total?.total_tax || "0",
        total_discounts: total?.total_discounts || "0",
        paid_orders: Number(paid?.count || 0),
        paid_revenue: paid?.revenue || "0",
        refund_count: Number(refunds?.count || 0),
        refund_total: refunds?.total || "0",
        net_revenue: (paidRevenue - refundTotal).toFixed(2),
      },
      current_month: {
        orders: Number(currentMonth?.count || 0),
        revenue: currentMonth?.revenue || "0",
      },
      previous_month: {
        orders: Number(prevMonth?.count || 0),
        revenue: prevMonth?.revenue || "0",
      },
    });
  } catch (err: any) {
    apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// E7: GET /api/store/:slug/finance/payouts — seller's payout status
// ---------------------------------------------------------------------------

app.get("/api/store/:slug/finance/payouts", storeAccess, async (req: Request, res: Response) => {
  try {
    const shopId = req.apiStore!.id;

    const sales = await db
      .selectFrom("transactions as t")
      .innerJoin("orders as o", "o.id", "t.order_id")
      .select(db.fn.sum("t.amount").as("total"))
      .where("o.shop_id", "=", shopId)
      .where("t.kind", "=", "sale")
      .where("t.status", "=", "success")
      .executeTakeFirst();

    const refunds = await db
      .selectFrom("transactions as t")
      .innerJoin("orders as o", "o.id", "t.order_id")
      .select(db.fn.sum("t.amount").as("total"))
      .where("o.shop_id", "=", shopId)
      .where("t.kind", "=", "refund")
      .where("t.status", "=", "success")
      .executeTakeFirst();

    const commissionSetting = await db.selectFrom("shop_settings").select("value").where("shop_id", "=", shopId).where("key", "=", "platform_commission_rate").executeTakeFirst();
    const rate = commissionSetting ? parseFloat(commissionSetting.value as any) : 0;

    const salesTotal = parseFloat(sales?.total as string || "0");
    const refundsTotal = parseFloat(refunds?.total as string || "0");
    const net = salesTotal - refundsTotal;
    const commission = net * (rate / 100);

    res.json({
      payout: {
        gross_sales: salesTotal.toFixed(2),
        refunds: refundsTotal.toFixed(2),
        net_revenue: net.toFixed(2),
        commission_rate: rate,
        platform_commission: commission.toFixed(2),
        estimated_payout: (net - commission).toFixed(2),
        status: "calculated",
      },
    });
  } catch (err: any) {
    apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' });
  }
});

// ===========================================================================
// PHASE 7: MONITORING APIs (F1-F8)
// ===========================================================================

// ---------------------------------------------------------------------------
// F1: GET /api/god/audit-logs — global audit logs
// ---------------------------------------------------------------------------

app.get("/api/god/audit-logs", godAdmin, async (req: Request, res: Response) => {
  try {
    const userId = req.query.user_id as string | undefined;
    const shopId = req.query.shop_id as string | undefined;
    const action = req.query.action as string | undefined;
    const resourceType = req.query.resource_type as string | undefined;
    const dateFrom = req.query.date_from as string | undefined;
    const dateTo = req.query.date_to as string | undefined;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const offset = parseInt(req.query.offset as string) || 0;

    let query = db
      .selectFrom("audit_logs as al")
      .leftJoin("users as u", "u.id", "al.user_id")
      .leftJoin("shops as s", "s.id", "al.shop_id")
      .select([
        "al.id", "al.action", "al.resource_type", "al.resource_id",
        "al.details", "al.ip_address", "al.created_at",
        "u.email as user_email", "u.name as user_name",
        "s.name as shop_name", "s.slug as shop_slug",
      ])
      .orderBy("al.created_at", "desc");

    if (userId) query = query.where("al.user_id", "=", userId);
    if (shopId) query = query.where("al.shop_id", "=", shopId);
    if (action) query = query.where("al.action", "like", `%${action}%`);
    if (resourceType) query = query.where("al.resource_type", "=", resourceType);
    if (dateFrom) query = query.where("al.created_at", ">=", dateFrom);
    if (dateTo) query = query.where("al.created_at", "<=", dateTo);

    const logs = await query.limit(limit).offset(offset).execute();
    res.json({ audit_logs: logs, count: logs.length });
  } catch (err: any) {
    apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// F2: GET /api/god/system/health — system health check
// ---------------------------------------------------------------------------

app.get("/api/god/system/health", godAdmin, async (_req: Request, res: Response) => {
  try {
    const startMs = Date.now();
    await db.selectFrom("shops").select("id").limit(1).execute();
    const dbLatencyMs = Date.now() - startMs;

    const shopCount = await db.selectFrom("shops").select(db.fn.countAll().as("c")).executeTakeFirst();
    const userCount = await db.selectFrom("users").select(db.fn.countAll().as("c")).executeTakeFirst();
    const orderCount = await db.selectFrom("orders").select(db.fn.countAll().as("c")).executeTakeFirst();
    const productCount = await db.selectFrom("products").select(db.fn.countAll().as("c")).executeTakeFirst();
    const sessionCount = await db.selectFrom("sessions").select(db.fn.countAll().as("c")).where("expires_at", ">", new Date().toISOString()).executeTakeFirst();
    const auditCount = await db.selectFrom("audit_logs").select(db.fn.countAll().as("c")).executeTakeFirst();

    res.json({
      status: "healthy",
      database: {
        connected: true,
        latency_ms: dbLatencyMs,
      },
      tables: {
        shops: Number(shopCount?.c || 0),
        users: Number(userCount?.c || 0),
        orders: Number(orderCount?.c || 0),
        products: Number(productCount?.c || 0),
        active_sessions: Number(sessionCount?.c || 0),
        audit_logs: Number(auditCount?.c || 0),
      },
      server: {
        uptime_seconds: Math.floor(process.uptime()),
        memory_mb: Math.floor(process.memoryUsage().heapUsed / 1024 / 1024),
        node_version: process.version,
        platform: process.platform,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    apiLogger.error({ err }, 'Health check failed'); res.status(500).json({ status: "unhealthy" });
  }
});

// ---------------------------------------------------------------------------
// F3: GET /api/god/system/errors — error log
// ---------------------------------------------------------------------------

app.get("/api/god/system/errors", godAdmin, async (req: Request, res: Response) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 100, 200);

    const auditErrors = await db
      .selectFrom("audit_logs as al")
      .leftJoin("users as u", "u.id", "al.user_id")
      .select(["al.id", "al.action", "al.resource_type", "al.resource_id", "al.details", "al.ip_address", "al.created_at", "u.email as user_email"])
      .where((eb) => eb.or([
        eb("al.action", "like", "%error%"),
        eb("al.action", "like", "%fail%"),
        eb("al.action", "like", "%denied%"),
      ]))
      .orderBy("al.created_at", "desc")
      .limit(limit)
      .execute();

    const webhookFailures = await db
      .selectFrom("webhook_deliveries")
      .selectAll()
      .where("status", "=", "failure")
      .orderBy("created_at", "desc")
      .limit(50)
      .execute();

    res.json({
      errors: auditErrors,
      webhook_failures: webhookFailures,
      total_errors: auditErrors.length,
      total_webhook_failures: webhookFailures.length,
    });
  } catch (err: any) {
    apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// F4: GET /api/god/system/sessions — active sessions
// ---------------------------------------------------------------------------

app.get("/api/god/system/sessions", godAdmin, async (req: Request, res: Response) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);

    const sessions = await db
      .selectFrom("sessions as s")
      .innerJoin("users as u", "u.id", "s.user_id")
      .select([
        "s.id", "s.ip_address", "s.user_agent", "s.expires_at", "s.created_at",
        "u.id as user_id", "u.email", "u.name", "u.role",
      ])
      .where("s.expires_at", ">", new Date().toISOString())
      .orderBy("s.created_at", "desc")
      .limit(limit)
      .execute();

    res.json({ sessions, count: sessions.length });
  } catch (err: any) {
    apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// F5: GET /api/god/orders/pipeline — order pipeline funnel
// ---------------------------------------------------------------------------

app.get("/api/god/orders/pipeline", godAdmin, async (_req: Request, res: Response) => {
  try {
    // By fulfillment status
    const fulfillmentPipeline = await db
      .selectFrom("orders")
      .select(["fulfillment_status", db.fn.countAll().as("count")])
      .groupBy("fulfillment_status")
      .execute();

    // By financial status
    const financialPipeline = await db
      .selectFrom("orders")
      .select(["financial_status", db.fn.countAll().as("count")])
      .groupBy("financial_status")
      .execute();

    // Combined matrix
    const matrix = await db
      .selectFrom("orders")
      .select(["financial_status", "fulfillment_status", db.fn.countAll().as("count")])
      .groupBy(["financial_status", "fulfillment_status"])
      .execute();

    // Today's orders
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayOrders = await db
      .selectFrom("orders")
      .select([db.fn.countAll().as("count"), db.fn.sum("total_price").as("revenue")])
      .where("created_at", ">=", todayStart.toISOString())
      .executeTakeFirst();

    res.json({
      fulfillment_pipeline: Object.fromEntries(fulfillmentPipeline.map(r => [r.fulfillment_status, Number(r.count)])),
      financial_pipeline: Object.fromEntries(financialPipeline.map(r => [r.financial_status, Number(r.count)])),
      matrix: matrix.map(r => ({ financial: r.financial_status, fulfillment: r.fulfillment_status, count: Number(r.count) })),
      today: {
        orders: Number(todayOrders?.count || 0),
        revenue: todayOrders?.revenue || "0",
      },
    });
  } catch (err: any) {
    apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// F6: GET /api/god/events — global events feed
// ---------------------------------------------------------------------------

app.get("/api/god/events", godAdmin, async (req: Request, res: Response) => {
  try {
    const shopId = req.query.shop_id as string | undefined;
    const subjectType = req.query.subject_type as string | undefined;
    const verb = req.query.verb as string | undefined;
    const dateFrom = req.query.date_from as string | undefined;
    const dateTo = req.query.date_to as string | undefined;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const offset = parseInt(req.query.offset as string) || 0;

    let query = db
      .selectFrom("events as e")
      .leftJoin("shops as s", "s.id", "e.shop_id")
      .select(["e.id", "e.subject_type", "e.subject_id", "e.verb", "e.body", "e.created_at", "s.name as shop_name", "s.slug as shop_slug"])
      .orderBy("e.created_at", "desc");

    if (shopId) query = query.where("e.shop_id", "=", shopId);
    if (subjectType) query = query.where("e.subject_type", "=", subjectType);
    if (verb) query = query.where("e.verb", "=", verb);
    if (dateFrom) query = query.where("e.created_at", ">=", dateFrom);
    if (dateTo) query = query.where("e.created_at", "<=", dateTo);

    const events = await query.limit(limit).offset(offset).execute();
    res.json({ events, count: events.length });
  } catch (err: any) {
    apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// F7: GET /api/store/:slug/audit-logs — store activity log
// ---------------------------------------------------------------------------

app.get("/api/store/:slug/audit-logs", storeAccess, async (req: Request, res: Response) => {
  try {
    const action = req.query.action as string | undefined;
    const resourceType = req.query.resource_type as string | undefined;
    const dateFrom = req.query.date_from as string | undefined;
    const dateTo = req.query.date_to as string | undefined;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const offset = parseInt(req.query.offset as string) || 0;

    let query = db
      .selectFrom("audit_logs as al")
      .leftJoin("users as u", "u.id", "al.user_id")
      .select([
        "al.id", "al.action", "al.resource_type", "al.resource_id",
        "al.details", "al.ip_address", "al.created_at",
        "u.email as user_email", "u.name as user_name",
      ])
      .where("al.shop_id", "=", req.apiStore!.id)
      .orderBy("al.created_at", "desc");

    if (action) query = query.where("al.action", "like", `%${action}%`);
    if (resourceType) query = query.where("al.resource_type", "=", resourceType);
    if (dateFrom) query = query.where("al.created_at", ">=", dateFrom);
    if (dateTo) query = query.where("al.created_at", "<=", dateTo);

    const logs = await query.limit(limit).offset(offset).execute();
    res.json({ audit_logs: logs, count: logs.length });
  } catch (err: any) {
    apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// F8: GET /api/store/:slug/events — store events feed
// ---------------------------------------------------------------------------

app.get("/api/store/:slug/events", storeAccess, async (req: Request, res: Response) => {
  try {
    const subjectType = req.query.subject_type as string | undefined;
    const verb = req.query.verb as string | undefined;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const offset = parseInt(req.query.offset as string) || 0;

    let query = db
      .selectFrom("events")
      .selectAll()
      .where("shop_id", "=", req.apiStore!.id)
      .orderBy("created_at", "desc");

    if (subjectType) query = query.where("subject_type", "=", subjectType);
    if (verb) query = query.where("verb", "=", verb);

    const events = await query.limit(limit).offset(offset).execute();
    res.json({ events, count: events.length });
  } catch (err: any) {
    apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' });
  }
});

// ===========================================================================
// PHASE 8: NOTIFICATION APIs (G1-G6)
// ===========================================================================

// ---------------------------------------------------------------------------
// G1: POST /api/god/notifications/send — send notification to store
// ---------------------------------------------------------------------------

app.post("/api/god/notifications/send", godAdmin, validate(schemas.sendNotification), async (req: Request, res: Response) => {
  try {
    const { shop_id, type, title, message, user_id } = req.body;

    const shop = await db.selectFrom("shops").select(["id", "name"]).where("id", "=", shop_id).executeTakeFirst();
    if (!shop) { res.status(404).json({ error: "Not found", message: "Store not found" }); return; }

    const notification = await db.insertInto("notifications").values({
      shop_id,
      user_id: user_id || null,
      type: type || "system",
      title,
      message: message || null,
    }).returningAll().executeTakeFirstOrThrow();

    await logApi(db, req.apiUser!.id, shop_id, "notification_sent", "notification", notification.id, { title, type }, req.ip || null);
    res.status(201).json({ notification });
  } catch (err: any) {
    apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// G2: POST /api/god/notifications/broadcast — broadcast to all stores
// ---------------------------------------------------------------------------

app.post("/api/god/notifications/broadcast", godAdmin, validate(schemas.broadcastNotification), async (req: Request, res: Response) => {
  try {
    const { type, title, message } = req.body;

    const shops = await db.selectFrom("shops").select("id").where("status", "=", "active").execute();
    let sent = 0;

    for (const shop of shops) {
      await db.insertInto("notifications").values({
        shop_id: shop.id,
        type: type || "system",
        title,
        message: message || null,
      }).execute().catch(() => {});
      sent++;
    }

    await logApi(db, req.apiUser!.id, null, "notification_broadcast", "platform", null, { title, type, stores_count: sent }, req.ip || null);
    res.status(201).json({ broadcast: true, title, stores_notified: sent });
  } catch (err: any) {
    apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// G3: GET /api/store/:slug/notifications/preferences — get prefs
// ---------------------------------------------------------------------------

app.get("/api/store/:slug/notifications/preferences", storeAccess, async (req: Request, res: Response) => {
  try {
    const settings = await db
      .selectFrom("shop_settings")
      .select(["key", "value"])
      .where("shop_id", "=", req.apiStore!.id)
      .where("key", "like", "notification_%")
      .execute();

    const preferences: Record<string, boolean> = {
      fulfillment: true,
      refund: true,
      order: true,
      system: true,
    };

    for (const s of settings) {
      const key = s.key.replace("notification_", "");
      preferences[key] = s.value === "true" || s.value === true;
    }

    res.json({ preferences });
  } catch (err: any) {
    apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// G4: PUT /api/store/:slug/notifications/preferences — update prefs
// ---------------------------------------------------------------------------

app.put("/api/store/:slug/notifications/preferences", storeAccess, async (req: Request, res: Response) => {
  try {
    const { preferences } = req.body;
    if (!preferences || typeof preferences !== "object") {
      res.status(400).json({ error: "Bad request", message: "preferences object is required" }); return;
    }

    const shopId = req.apiStore!.id;
    for (const [key, value] of Object.entries(preferences)) {
      const settingKey = `notification_${key}`;
      const existing = await db.selectFrom("shop_settings").select("id").where("shop_id", "=", shopId).where("key", "=", settingKey).executeTakeFirst();
      if (existing) {
        await db.updateTable("shop_settings").set({ value: JSON.stringify(value), updated_at: new Date().toISOString() }).where("id", "=", existing.id).execute();
      } else {
        await db.insertInto("shop_settings").values({ shop_id: shopId, key: settingKey, value: JSON.stringify(value) }).execute();
      }
    }

    await logApi(db, req.apiUser!.id, shopId, "notification_preferences_updated", "shop", shopId, { preferences }, req.ip || null);
    res.json({ preferences, updated: true });
  } catch (err: any) {
    apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// G5: PUT /api/store/:slug/notifications/read-all — mark all as read
// ---------------------------------------------------------------------------

app.put("/api/store/:slug/notifications/read-all", storeAccess, async (req: Request, res: Response) => {
  try {
    const result = await db
      .updateTable("notifications")
      .set({ read: true })
      .where("shop_id", "=", req.apiStore!.id)
      .where("read", "=", false)
      .execute();

    // Kysely returns an array of results; the numUpdatedRows is on the first element
    const updatedCount = Number((result as any)?.[0]?.numUpdatedRows ?? (result as any)?.numUpdatedRows ?? 0);
    res.json({ marked_read: true, count: updatedCount });
  } catch (err: any) {
    apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// G6: DELETE /api/store/:slug/notifications/:id — delete notification
// ---------------------------------------------------------------------------

app.delete("/api/store/:slug/notifications/:id", storeAccess, async (req: Request, res: Response) => {
  try {
    const notification = await db
      .selectFrom("notifications")
      .select(["id", "shop_id", "title"])
      .where("id", "=", req.params.id)
      .where("shop_id", "=", req.apiStore!.id)
      .executeTakeFirst();

    if (!notification) { res.status(404).json({ error: "Not found", message: "Notification not found" }); return; }

    await db.deleteFrom("notifications").where("id", "=", req.params.id).execute();
    res.json({ deleted: true, id: req.params.id });
  } catch (err: any) {
    apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' });
  }
});

// ===========================================================================
// SELLER / STORE ROUTES
// ===========================================================================

// ---------------------------------------------------------------------------
// GET /api/store/:slug/orders — orders for this store
// ---------------------------------------------------------------------------

app.get("/api/store/:slug/orders", storeAccess, async (req: Request, res: Response) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const offset = parseInt(req.query.offset as string) || 0;
    const status = req.query.status as string | undefined;

    // Safe ORDER BY — prevents SQL injection via sort params
    const sortSpecs = safeOrderBy(req.query.sort, {
      created: "created_at", updated: "updated_at", total: "total_price",
      status: "financial_status", number: "order_number",
    }, { column: "created_at", direction: "desc" });

    let query = db
      .selectFrom("orders")
      .selectAll()
      .where("shop_id", "=", req.apiStore!.id);

    for (const s of sortSpecs) query = query.orderBy(s.column as any, s.direction);

    if (status) {
      query = query.where("financial_status", "=", status);
    }

    const orders = await query.limit(limit).offset(offset).execute();
    res.json({ orders, count: orders.length });
  } catch (err: any) {
    apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/store/:slug/orders/:orderId — order detail with fulfillment + tracking
// ---------------------------------------------------------------------------

app.get("/api/store/:slug/orders/:orderId", storeAccess, async (req: Request, res: Response) => {
  try {
    const order = await db
      .selectFrom("orders")
      .selectAll()
      .where("id", "=", req.params.orderId)
      .where("shop_id", "=", req.apiStore!.id)
      .executeTakeFirst();

    if (!order) {
      res.status(404).json({ error: "Not found", message: "Order not found" });
      return;
    }

    const lineItems = await db
      .selectFrom("order_line_items")
      .selectAll()
      .where("order_id", "=", order.id)
      .execute();

    const fulfillments = await db
      .selectFrom("fulfillments")
      .selectAll()
      .where("order_id", "=", order.id)
      .orderBy("created_at", "desc")
      .execute();

    // Get fulfillment line items for each fulfillment
    const fulfillmentsWithItems = await Promise.all(
      fulfillments.map(async (f) => {
        const items = await db
          .selectFrom("fulfillment_line_items")
          .selectAll()
          .where("fulfillment_id", "=", f.id)
          .execute();
        return { ...f, line_items: items };
      })
    );

    // Get refund requests if table exists
    let refundRequests: any[] = [];
    try {
      refundRequests = await db
        .selectFrom("refund_requests")
        .selectAll()
        .where("order_id", "=", order.id)
        .execute();
    } catch {
      // Table may not exist yet
    }

    // Order timeline (event sourcing)
    const { getOrderTimeline } = await import("@gbox/core/modules/events/orderEvents.js");
    const timeline = await getOrderTimeline(db, req.apiStore!.id, order.id).catch(() => []);

    res.json({
      order,
      line_items: lineItems,
      fulfillments: fulfillmentsWithItems,
      refund_requests: refundRequests,
      timeline,
    });
  } catch (err: any) {
    apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/store/:slug/orders/:orderId/timeline — order event timeline
// ---------------------------------------------------------------------------

app.get("/api/store/:slug/orders/:orderId/timeline", storeAccess, async (req: Request, res: Response) => {
  try {
    const { getOrderTimeline } = await import("@gbox/core/modules/events/orderEvents.js");
    const events = await getOrderTimeline(db, req.apiStore!.id, req.params.orderId);
    res.json({ events });
  } catch (err: any) {
    apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/store/:slug/orders/:orderId/refund-request — create refund request
// ---------------------------------------------------------------------------

app.post("/api/store/:slug/orders/:orderId/refund-request", storeAccess, async (req: Request, res: Response) => {
  try {
    const { amount, reason, line_items } = req.body;
    const orderId = req.params.orderId;

    if (!amount || !reason) {
      res.status(400).json({ error: "Bad request", message: "amount and reason are required" });
      return;
    }

    const order = await db
      .selectFrom("orders")
      .select(["id", "shop_id", "total_price", "order_number"])
      .where("id", "=", orderId)
      .where("shop_id", "=", req.apiStore!.id)
      .executeTakeFirst();

    if (!order) {
      res.status(404).json({ error: "Not found", message: "Order not found" });
      return;
    }

    if (parseFloat(amount) > parseFloat(order.total_price)) {
      res.status(400).json({ error: "Bad request", message: "Refund amount exceeds order total" });
      return;
    }

    const refundRequest = await db
      .insertInto("refund_requests")
      .values({
        order_id: orderId,
        amount: amount.toString(),
        reason,
        status: "pending",
        line_items: line_items ? JSON.stringify(line_items) : null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await logApi(
      db, req.apiUser!.id, req.apiStore!.id, "refund_requested",
      "refund_request", refundRequest.id,
      { amount, reason, order_number: order.order_number },
      req.ip || null
    );

    res.status(201).json({ refund_request: refundRequest });
  } catch (err: any) {
    apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// ORDER LIFECYCLE — cancel, update, fulfill, refund (uses orders service)
// ---------------------------------------------------------------------------

import {
  updateOrder as updateOrderService, cancelOrder as cancelOrderService,
  createFulfillment, createRefund as createRefundService,
} from "@gbox/core/modules/orders/service.js";
import { generateOrdersExport } from "@gbox/core/modules/orders/export/service.js";
import { importOrdersFromCsv } from "@gbox/core/modules/orders/import/service.js";

// PUT /api/store/:slug/orders/:orderId — Update order (note, tags, addresses)
app.put("/api/store/:slug/orders/:orderId", storeAccess, async (req: Request, res: Response) => {
  try {
    const store = req.apiStore!;
    const { email, phone, note, tags, shipping_address, billing_address } = req.body;
    const order = await updateOrderService(db, store.id, req.params.orderId, {
      email, phone, note, tags, shipping_address, billing_address,
    });
    res.json({ order });
  } catch (err: any) {
    apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/store/:slug/orders/:orderId/cancel — Cancel an order
app.post("/api/store/:slug/orders/:orderId/cancel", storeAccess, async (req: Request, res: Response) => {
  try {
    const store = req.apiStore!;
    const { reason } = req.body;
    const order = await cancelOrderService(db, store.id, req.params.orderId, reason);
    logApi(db, req.apiUser!.id, store.id, "order_cancel", "order", req.params.orderId, { reason }, req.ip || "").catch(() => {});
    triggerWebhook(db, store.id, "orders/cancel", { id: req.params.orderId, cancel_reason: reason }).catch(() => {});

    // PR2 commit 14 — customer-facing cancellation notice.
    // Fire-and-forget; silent on SMTP down / missing email.
    if (process.env.SMTP_HOST && order.email) {
      const lineItems = await db.selectFrom("order_line_items").selectAll().where("order_id", "=", req.params.orderId).execute();
      sendOrderCanceled(db, store.id, {
        id: order.id,
        order_number: Number(order.order_number),
        email: order.email,
        currency: order.currency || "USD",
        total_price: order.total_price || "0",
        cancel_reason: order.cancel_reason ?? null,
        line_items: lineItems.map((li: any) => ({ title: li.title || "", variant_title: li.variant_title, quantity: li.quantity })),
        shipping_address: order.shipping_address as any,
      }).catch((err: any) => apiLogger.error({ err: err.message }, '[email] order canceled failed'));
    }

    res.json({ order });
  } catch (err: any) {
    apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/store/:slug/orders/:orderId/fulfill — Create fulfillment
app.post("/api/store/:slug/orders/:orderId/fulfill", storeAccess, async (req: Request, res: Response) => {
  try {
    const store = req.apiStore!;
    const { location_id, tracking_company, tracking_number, tracking_url, line_items } = req.body;
    // Verify order belongs to store
    const order = await db.selectFrom("orders").select("id").where("id", "=", req.params.orderId).where("shop_id", "=", store.id).executeTakeFirst();
    if (!order) { res.status(404).json({ error: "Order not found" }); return; }
    // If no line_items specified, fulfill ALL unfulfilled items
    let fulfillLineItems = line_items;
    if (!fulfillLineItems || fulfillLineItems.length === 0) {
      const allItems = await db.selectFrom("order_line_items")
        .select(["id", "quantity"])
        .where("order_id", "=", req.params.orderId)
        .where((eb) => eb.or([eb("fulfillment_status", "is", null), eb("fulfillment_status", "!=", "fulfilled")]))
        .execute();
      fulfillLineItems = allItems.map((li: any) => ({ line_item_id: li.id, quantity: li.quantity }));
    }
    if (fulfillLineItems.length === 0) { res.status(400).json({ error: "No unfulfilled items to fulfill" }); return; }
    const fulfillment = await createFulfillment(db, req.params.orderId, {
      location_id, tracking_company, tracking_number, tracking_url, line_items: fulfillLineItems,
    });
    logApi(db, req.apiUser!.id, store.id, "order_fulfill", "fulfillment", fulfillment.id, { tracking_number }, req.ip || "").catch(() => {});
    triggerWebhook(db, store.id, "orders/fulfilled", { id: req.params.orderId, fulfillment_id: fulfillment.id, tracking_number }).catch(() => {});
    void fireAutomationTrigger(db, store.id, "order_fulfilled", { order: { id: req.params.orderId, fulfillment_id: fulfillment.id, tracking_number } }).catch(() => {});

    // Send shipping notification email (fire-and-forget)
    void (async () => {
      try {
        const fullOrder = await db.selectFrom("orders").selectAll().where("id", "=", req.params.orderId).executeTakeFirst();
        if (fullOrder?.email) {
          const lineItems = await db.selectFrom("order_line_items").selectAll().where("order_id", "=", req.params.orderId).execute();
          await sendShippingNotification(db, store.id, {
            id: fullOrder.id, order_number: fullOrder.order_number as number, email: fullOrder.email,
            currency: fullOrder.currency || "USD", subtotal_price: String(fullOrder.subtotal_price || "0"),
            total_shipping: String(fullOrder.total_shipping || "0"), total_tax: String(fullOrder.total_tax || "0"),
            total_discounts: String(fullOrder.total_discounts || "0"), total_price: String(fullOrder.total_price || "0"),
            line_items: lineItems.map((li: any) => ({ title: li.title, variant_title: li.variant_title, quantity: li.quantity, price: String(li.price) })),
            shipping_address: fullOrder.shipping_address as any, billing_address: fullOrder.billing_address as any,
            created_at: String(fullOrder.created_at),
          }, {
            id: fulfillment.id, tracking_company: tracking_company || null, tracking_number: tracking_number || null,
            tracking_url: tracking_url || null, shipped_at: fulfillment.shipped_at ? String(fulfillment.shipped_at) : null,
            line_items: fulfillLineItems.map((li: any) => ({ title: li.title || "", variant_title: li.variant_title || null, quantity: li.quantity })),
          });
        }
      } catch {}
    })();

    res.status(201).json({ fulfillment });
  } catch (err: any) {
    apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/store/:slug/orders/:orderId/refund — Create a refund
app.post("/api/store/:slug/orders/:orderId/refund", storeAccess, async (req: Request, res: Response) => {
  try {
    const store = req.apiStore!;
    // Verify order belongs to store
    const order = await db.selectFrom("orders").select(["id", "total_price"]).where("id", "=", req.params.orderId).where("shop_id", "=", store.id).executeTakeFirst();
    if (!order) { res.status(404).json({ error: "Order not found" }); return; }
    const { note, restock, refund_line_items, transactions } = req.body;
    if (!refund_line_items || refund_line_items.length === 0) {
      res.status(400).json({ error: "refund_line_items are required" }); return;
    }
    const refund = await createRefundService(db, req.params.orderId, {
      note, restock, refund_line_items, transactions,
    });
    logApi(db, req.apiUser!.id, store.id, "order_refund", "refund", refund.id, { note }, req.ip || "").catch(() => {});

    // Send refund email (fire-and-forget)
    void (async () => {
      try {
        const fullOrder = await db.selectFrom("orders").selectAll().where("id", "=", req.params.orderId).executeTakeFirst();
        if (fullOrder?.email) {
          const lineItems = await db.selectFrom("order_line_items").selectAll().where("order_id", "=", req.params.orderId).execute();
          const refundTotal = refund_line_items.reduce((s: number, li: any) => s + (parseFloat(li.amount || li.price || "0") * (li.quantity || 1)), 0);
          await sendRefundNotification(db, store.id, {
            id: fullOrder.id, order_number: fullOrder.order_number as number, email: fullOrder.email,
            currency: fullOrder.currency || "USD", subtotal_price: String(fullOrder.subtotal_price || "0"),
            total_shipping: String(fullOrder.total_shipping || "0"), total_tax: String(fullOrder.total_tax || "0"),
            total_discounts: String(fullOrder.total_discounts || "0"), total_price: String(fullOrder.total_price || "0"),
            line_items: lineItems.map((li: any) => ({ title: li.title, variant_title: li.variant_title, quantity: li.quantity, price: String(li.price) })),
            shipping_address: fullOrder.shipping_address as any, billing_address: fullOrder.billing_address as any,
            created_at: String(fullOrder.created_at),
          }, {
            id: refund.id, amount: String(refundTotal), currency: fullOrder.currency || "USD",
            reason: note || null,
            refund_line_items: refund_line_items.map((li: any) => ({ title: li.title || "", variant_title: li.variant_title || null, quantity: li.quantity || 1, price: String(li.amount || li.price || "0") })),
          });
        }
      } catch {}
    })();

    res.status(201).json({ refund });
  } catch (err: any) {
    apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// Orders — Export / Import / Saved Filters / Drafts (Phase 9 REST parity)
//
// These endpoints expose the Sprint 1-6 features that previously only
// existed as server-rendered pages in store-admin. They all reuse the
// core/src/modules/orders/* services so the UI and API stay in lockstep.
// ---------------------------------------------------------------------------

// POST /api/store/:slug/orders/export — generate a CSV or JSON export.
// Body: { format: 'csv'|'json', scope?, date_from?, date_to?, ids?,
//         includeLineItems?, includeTransactions?, includeFulfillments?,
//         stream?: boolean (default true — sets Content-Disposition) }
app.post("/api/store/:slug/orders/export", storeAccess, async (req: Request, res: Response) => {
  try {
    const store = req.apiStore!;
    const body = req.body || {};
    const format: "csv" | "json" = body.format === "json" ? "json" : "csv";

    const result = await generateOrdersExport(db, store.id, {
      scope: body.scope || "all",
      date_from: body.date_from || null,
      date_to: body.date_to || null,
      ids: Array.isArray(body.ids) ? body.ids : undefined,
      limit: Math.min(Number(body.limit) || 10_000, 50_000),
      includeLineItems: body.includeLineItems !== false,
      includeTransactions: body.includeTransactions === true,
      includeFulfillments: body.includeFulfillments === true,
      format,
      storeSlug: store.slug,
      options: {
        includeLineItems: body.includeLineItems !== false,
        includeCustomer: body.includeCustomer !== false,
        includeAddresses: body.includeAddresses !== false,
        includeTransactions: body.includeTransactions === true,
        includeFulfillments: body.includeFulfillments === true,
      },
    });

    logApi(db, req.apiUser!.id, store.id, "order_export", "orders", "bulk",
      { format, rowCount: result.rowCount, scope: body.scope || "all" },
      req.ip || "").catch(() => {});

    // By default stream as a downloadable file. When stream=false the
    // response is wrapped in JSON — useful for API clients that want to
    // read the body without content-disposition.
    if (body.stream === false) {
      res.json({
        filename: result.filename,
        contentType: result.contentType,
        rowCount: result.rowCount,
        data: result.data,
      });
      return;
    }

    res.setHeader("Content-Type", result.contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${result.filename}"`);
    res.send(result.data);
  } catch (err: any) {
    apiLogger.error({ err }, "order export failed");
    res.status(500).json({ error: "Export failed", message: err?.message || "unknown" });
  }
});

// POST /api/store/:slug/orders/import — import orders from CSV text.
// Body: { csv: string, forcePlatform?: 'shopify'|'amazon'|'tiktok'|'etsy'|'ebay'|'csv' }
// Returns a persistence report (imported/skipped/errors).
app.post("/api/store/:slug/orders/import", storeAccess, async (req: Request, res: Response) => {
  try {
    const store = req.apiStore!;
    const body = req.body || {};
    const csv = typeof body.csv === "string" ? body.csv : "";
    if (!csv) {
      res.status(400).json({ error: "Missing 'csv' field in body" });
      return;
    }

    const report = await importOrdersFromCsv(db, store.id, csv, {
      userId: req.apiUser!.id,
      forcePlatform: body.forcePlatform,
    });

    logApi(db, req.apiUser!.id, store.id, "order_import", "orders", "bulk",
      { platform: report.platform, imported: report.imported, skipped: report.skipped, errors: report.errors },
      req.ip || "").catch(() => {});

    res.status(200).json(report);
  } catch (err: any) {
    apiLogger.error({ err }, "order import failed");
    res.status(500).json({ error: "Import failed", message: err?.message || "unknown" });
  }
});

// GET /api/store/:slug/orders/saved-filters — list current user's saved filters
app.get("/api/store/:slug/orders/saved-filters", storeAccess, async (req: Request, res: Response) => {
  try {
    const store = req.apiStore!;
    const rows = await db
      .selectFrom("order_saved_filters")
      .select(["id", "name", "filter_json", "is_default", "created_at", "updated_at"])
      .where("shop_id", "=", store.id)
      .where("user_id", "=", req.apiUser!.id)
      .orderBy("updated_at", "desc")
      .limit(100)
      .execute();
    res.json({ saved_filters: rows, count: rows.length });
  } catch (err: any) {
    apiLogger.error({ err }, "saved filter list failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/store/:slug/orders/saved-filters — upsert a saved filter
// Body: { name: string, filter_json: Record<string, unknown>, is_default?: boolean }
app.post("/api/store/:slug/orders/saved-filters", storeAccess, async (req: Request, res: Response) => {
  try {
    const store = req.apiStore!;
    const body = req.body || {};
    const name = String(body.name || "").trim().slice(0, 80);
    if (!name) { res.status(400).json({ error: "Missing 'name' field" }); return; }

    const filterJson = body.filter_json && typeof body.filter_json === "object" ? body.filter_json : {};
    const jsonbValue = JSON.stringify(filterJson) as any;

    await db
      .insertInto("order_saved_filters")
      .values({
        shop_id: store.id,
        user_id: req.apiUser!.id,
        name,
        filter_json: jsonbValue,
        is_default: body.is_default === true,
      })
      .onConflict((oc) => oc.columns(["shop_id", "user_id", "name"]).doUpdateSet({
        filter_json: jsonbValue,
        is_default: body.is_default === true,
        updated_at: new Date().toISOString(),
      }))
      .execute();

    res.status(201).json({ success: true });
  } catch (err: any) {
    apiLogger.error({ err }, "saved filter upsert failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /api/store/:slug/orders/saved-filters/:id — delete a saved filter
app.delete("/api/store/:slug/orders/saved-filters/:id", storeAccess, async (req: Request, res: Response) => {
  try {
    const store = req.apiStore!;
    const deleted = await db
      .deleteFrom("order_saved_filters")
      .where("id", "=", req.params.id)
      .where("shop_id", "=", store.id)
      .where("user_id", "=", req.apiUser!.id)
      .executeTakeFirst();
    res.json({ deleted: Number(deleted?.numDeletedRows || 0) });
  } catch (err: any) {
    apiLogger.error({ err }, "saved filter delete failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/store/:slug/draft-orders — list draft orders (tagged 'draft')
app.get("/api/store/:slug/draft-orders", storeAccess, async (req: Request, res: Response) => {
  try {
    const store = req.apiStore!;
    const rows = await db
      .selectFrom("orders")
      .selectAll()
      .where("shop_id", "=", store.id)
      .where(sql<boolean>`COALESCE(tags, ARRAY[]::text[]) @> ARRAY['draft']::text[]`)
      .orderBy("created_at", "desc")
      .limit(200)
      .execute();
    res.json({ draft_orders: rows, count: rows.length });
  } catch (err: any) {
    apiLogger.error({ err }, "draft orders list failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/store/:slug/draft-orders/:id/convert — convert draft to real order
// Removes the 'draft' tag and emits an `order_placed` event.
app.post("/api/store/:slug/draft-orders/:id/convert", storeAccess, async (req: Request, res: Response) => {
  try {
    const store = req.apiStore!;
    const order = await db
      .selectFrom("orders")
      .selectAll()
      .where("id", "=", req.params.id)
      .where("shop_id", "=", store.id)
      .executeTakeFirst();
    if (!order) { res.status(404).json({ error: "Draft order not found" }); return; }

    const tags = (order.tags || []).filter((t: string) => t !== "draft");
    await db
      .updateTable("orders")
      .set({ tags: tags as any, updated_at: new Date().toISOString() as any })
      .where("id", "=", order.id)
      .execute();

    await db.insertInto("order_events").values({
      shop_id: store.id,
      order_id: order.id,
      event_type: "order_placed",
      actor_type: "user",
      actor_id: req.apiUser!.id,
      message: "Draft converted to order",
    } as any).execute().catch(() => {});

    logApi(db, req.apiUser!.id, store.id, "draft_convert", "order", order.id, {}, req.ip || "").catch(() => {});
    res.json({ success: true, order_id: order.id });
  } catch (err: any) {
    apiLogger.error({ err }, "draft convert failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// GET /api/store/:slug/refund-requests — seller's refund requests
// ---------------------------------------------------------------------------

app.get("/api/store/:slug/refund-requests", storeAccess, async (req: Request, res: Response) => {
  try {
    const requests = await db
      .selectFrom("refund_requests as rr")
      .innerJoin("orders as o", "o.id", "rr.order_id")
      .select([
        "rr.id", "rr.order_id", "rr.amount", "rr.reason",
        "rr.status", "rr.review_note", "rr.created_at",
        "o.order_number", "o.total_price",
      ])
      .where("o.shop_id", "=", req.apiStore!.id)
      .orderBy("rr.created_at", "desc")
      .limit(100)
      .execute();

    res.json({ refund_requests: requests, count: requests.length });
  } catch (err: any) {
    apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/store/:slug/fulfillments — fulfillments for this store
// ---------------------------------------------------------------------------

app.get("/api/store/:slug/fulfillments", storeAccess, async (req: Request, res: Response) => {
  try {
    const fulfillments = await db
      .selectFrom("fulfillments as f")
      .innerJoin("orders as o", "o.id", "f.order_id")
      .select([
        "f.id", "f.order_id", "f.status",
        "f.tracking_company", "f.tracking_number", "f.tracking_url",
        "f.shipped_at", "f.created_at",
        "o.order_number", "o.email",
      ])
      .where("o.shop_id", "=", req.apiStore!.id)
      .orderBy("f.created_at", "desc")
      .limit(100)
      .execute();

    res.json({ fulfillments, count: fulfillments.length });
  } catch (err: any) {
    apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' });
  }
});

// NOTE: Notifications routes moved to the NOTIFICATIONS section (uses service module).
// NOTE: Old raw-SQL notification endpoints replaced by service-based versions above.

// ---------------------------------------------------------------------------
// GET /api/store/:slug/stats — store dashboard stats
// ---------------------------------------------------------------------------

app.get("/api/store/:slug/stats", storeAccess, async (req: Request, res: Response) => {
  try {
    const shopId = req.apiStore!.id;

    const orderStats = await db
      .selectFrom("orders")
      .select([
        db.fn.countAll().as("total_orders"),
        db.fn.sum("total_price").as("total_revenue"),
      ])
      .where("shop_id", "=", shopId)
      .executeTakeFirst();

    const unfulfilledCount = await db
      .selectFrom("orders")
      .select(db.fn.countAll().as("count"))
      .where("shop_id", "=", shopId)
      .where("fulfillment_status", "in", ["unfulfilled", "partial"])
      .executeTakeFirst();

    const productCount = await db
      .selectFrom("products")
      .select(db.fn.countAll().as("count"))
      .where("shop_id", "=", shopId)
      .executeTakeFirst();

    const customerCount = await db
      .selectFrom("customers")
      .select(db.fn.countAll().as("count"))
      .where("shop_id", "=", shopId)
      .executeTakeFirst();

    const unreadNotifications = await db
      .selectFrom("notifications")
      .select(db.fn.countAll().as("count"))
      .where("shop_id", "=", shopId)
      .where("read", "=", false)
      .executeTakeFirst();

    // Pending refund requests count
    let pendingRefunds = 0;
    try {
      const rr = await db
        .selectFrom("refund_requests as rr")
        .innerJoin("orders as o", "o.id", "rr.order_id")
        .select(db.fn.countAll().as("count"))
        .where("o.shop_id", "=", shopId)
        .where("rr.status", "=", "pending")
        .executeTakeFirst();
      pendingRefunds = Number(rr?.count || 0);
    } catch {
      // Table may not exist yet
    }

    res.json({
      store: { id: shopId, name: req.apiStore!.name, slug: req.apiStore!.slug },
      stats: {
        total_orders: Number(orderStats?.total_orders || 0),
        total_revenue: orderStats?.total_revenue || "0",
        unfulfilled_orders: Number(unfulfilledCount?.count || 0),
        total_products: Number(productCount?.count || 0),
        total_customers: Number(customerCount?.count || 0),
        unread_notifications: Number(unreadNotifications?.count || 0),
        pending_refund_requests: pendingRefunds,
      },
    });
  } catch (err: any) {
    apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' });
  }
});

// ===========================================================================
// SELLER CRUD APIs — Products, Variants, Collections, Discounts, Inventory, Customers
// ===========================================================================

// --- Helper: Generate unique product slug within a shop ---
async function generateUniqueProductSlug(shopId: string, title: string): Promise<string> {
  const baseSlug = title.toLowerCase().trim().replace(/[^a-z0-9\s-]/g, "").replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  let slug = baseSlug || "product";
  let counter = 1;
  while (true) {
    const existing = await db.selectFrom("products").select("id").where("shop_id", "=", shopId).where("slug", "=", slug).executeTakeFirst();
    if (!existing) break;
    counter++;
    slug = `${baseSlug}-${counter}`;
  }
  return slug;
}

async function generateUniqueCollectionSlug(shopId: string, title: string): Promise<string> {
  const baseSlug = title.toLowerCase().trim().replace(/[^a-z0-9\s-]/g, "").replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  let slug = baseSlug || "collection";
  let counter = 1;
  while (true) {
    const existing = await db.selectFrom("collections").select("id").where("shop_id", "=", shopId).where("slug", "=", slug).executeTakeFirst();
    if (!existing) break;
    counter++;
    slug = `${baseSlug}-${counter}`;
  }
  return slug;
}

// ---------------------------------------------------------------------------
// PRODUCT CRUD (8 endpoints)
// ---------------------------------------------------------------------------

// GET /api/store/:slug/products — List products with pagination, search, filters
app.get("/api/store/:slug/products", storeAccess, async (req: Request, res: Response) => {
  try {
    const store = req.apiStore!;
    const search = (req.query.search as string) || "";
    const status = req.query.status as string;
    const vendor = req.query.vendor as string;
    const productType = req.query.product_type as string;
    const collectionId = req.query.collection_id as string;
    const sortBy = (req.query.sort_by as string) || "created_at";
    const sortOrder = (req.query.sort_order as string) === "asc" ? "asc" as const : "desc" as const;
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const perPage = Math.min(250, Math.max(1, parseInt(req.query.per_page as string) || 25));

    let query = db.selectFrom("products").where("shop_id", "=", store.id);
    let countQuery = db.selectFrom("products").where("shop_id", "=", store.id).select(sql<number>`count(*)`.as("total"));

    if (search) {
      query = query.where(eb => eb.or([eb("title", "ilike", `%${search}%`), eb("vendor", "ilike", `%${search}%`), eb("product_type", "ilike", `%${search}%`), eb("tags", "ilike", `%${search}%`)]));
      countQuery = countQuery.where(eb => eb.or([eb("title", "ilike", `%${search}%`), eb("vendor", "ilike", `%${search}%`), eb("product_type", "ilike", `%${search}%`), eb("tags", "ilike", `%${search}%`)]));
    }
    if (status) { query = query.where("status", "=", status); countQuery = countQuery.where("status", "=", status); }
    if (vendor) { query = query.where("vendor", "=", vendor); countQuery = countQuery.where("vendor", "=", vendor); }
    if (productType) { query = query.where("product_type", "=", productType); countQuery = countQuery.where("product_type", "=", productType); }
    if (collectionId) {
      query = query.where("id", "in", db.selectFrom("collection_products").select("product_id").where("collection_id", "=", collectionId));
      countQuery = countQuery.where("id", "in", db.selectFrom("collection_products").select("product_id").where("collection_id", "=", collectionId));
    }

    const allowedSorts = ["created_at", "updated_at", "title", "vendor", "product_type", "status"];
    const safeSortBy = allowedSorts.includes(sortBy) ? sortBy : "created_at";

    const [products, total] = await Promise.all([
      query.selectAll().orderBy(safeSortBy as any, sortOrder).limit(perPage).offset((page - 1) * perPage).execute(),
      countQuery.executeTakeFirst(),
    ]);

    // Fetch variants for all products in one query
    const productIds = products.map(p => p.id);
    const variants = productIds.length > 0
      ? await db.selectFrom("product_variants").selectAll().where("product_id", "in", productIds).orderBy("position", "asc").execute()
      : [];
    const variantMap = new Map<string, typeof variants>();
    for (const v of variants) {
      const arr = variantMap.get(v.product_id) || [];
      arr.push(v);
      variantMap.set(v.product_id, arr);
    }

    const totalCount = Number(total?.total ?? 0);
    res.json({
      products: products.map(p => ({ ...p, variants: variantMap.get(p.id) || [] })),
      total: totalCount,
      page,
      per_page: perPage,
      pages: Math.ceil(totalCount / perPage),
    });
  } catch (err: any) {
    apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/store/:slug/products/:productId — Get single product with variants
app.get("/api/store/:slug/products/:productId", storeAccess, async (req: Request, res: Response) => {
  try {
    const store = req.apiStore!;
    const product = await db.selectFrom("products").selectAll().where("id", "=", req.params.productId).where("shop_id", "=", store.id).executeTakeFirst();
    if (!product) { res.status(404).json({ error: "Not found", message: "Product not found in this store" }); return; }
    const variants = await db.selectFrom("product_variants").selectAll().where("product_id", "=", product.id).orderBy("position", "asc").execute();
    const images = await db.selectFrom("product_images").selectAll().where("product_id", "=", product.id).orderBy("position", "asc").execute();
    res.json({ product: { ...product, variants, images } });
  } catch (err: any) {
    apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/store/:slug/products — Create product
app.post("/api/store/:slug/products", storeAccess, validate(schemas.createProduct), async (req: Request, res: Response) => {
  try {
    const store = req.apiStore!;
    const user = req.apiUser!;
    const { title, body_html, vendor, product_type, tags, status } = req.body;
    // Zod already validated: title required, status enum, tags array

    const productId = crypto.randomUUID();
    const variantId = crypto.randomUUID();
    const productSlug = await generateUniqueProductSlug(store.id, title);
    const now = new Date().toISOString();

    const product = await db.insertInto("products").values({
      id: productId, shop_id: store.id, title, slug: productSlug,
      body_html: body_html ? sanitizeHtml(body_html) : null, vendor: vendor || null, product_type: product_type || null,
      status: status || "draft", tags: tags || [], published_at: status === "active" ? now : null,
      created_at: now, updated_at: now,
    }).returningAll().executeTakeFirstOrThrow();

    const variant = await db.insertInto("product_variants").values({
      id: variantId, product_id: productId, title: "Default Title", price: 0, position: 1,
      requires_shipping: true, taxable: true, inventory_quantity: 0,
      created_at: now, updated_at: now,
    }).returningAll().executeTakeFirstOrThrow();

    logApi(db, user.id, store.id, "product_create", "product", productId, { title: product.title }, req.ip || "").catch(() => {});
    triggerWebhook(db, store.id, "products/create", { id: productId, title: product.title, status: product.status }).catch(() => {});
    res.status(201).json({ product: { ...product, variants: [variant] } });
  } catch (err: any) {
    apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/store/:slug/products/:productId — Update product
app.put("/api/store/:slug/products/:productId", storeAccess, validate(schemas.updateProduct), async (req: Request, res: Response) => {
  try {
    const store = req.apiStore!;
    const user = req.apiUser!;
    const { productId } = req.params;
    const { title, body_html, vendor, product_type, tags, status } = req.body;

    const existing = await db.selectFrom("products").selectAll().where("id", "=", productId).where("shop_id", "=", store.id).executeTakeFirst();
    if (!existing) { res.status(404).json({ error: "Not found", message: "Product not found in this store" }); return; }

    if (status && !["draft", "active", "archived"].includes(status)) {
      res.status(400).json({ error: "Validation error", message: "status must be draft, active, or archived" }); return;
    }

    const updates: Record<string, any> = { updated_at: new Date().toISOString() };
    if (title !== undefined) { updates.title = title.trim(); updates.slug = await generateUniqueProductSlug(store.id, title.trim()); }
    if (body_html !== undefined) updates.body_html = body_html ? sanitizeHtml(body_html) : null;
    if (vendor !== undefined) updates.vendor = vendor;
    if (product_type !== undefined) updates.product_type = product_type;
    if (tags !== undefined) updates.tags = tags;
    if (status !== undefined) {
      updates.status = status;
      if (status === "active" && existing.status !== "active") updates.published_at = new Date().toISOString();
      else if (status !== "active" && existing.status === "active") updates.published_at = null;
    }

    const updated = await db.updateTable("products").set(updates).where("id", "=", productId).where("shop_id", "=", store.id).returningAll().executeTakeFirstOrThrow();
    logApi(db, user.id, store.id, "product_update", "product", productId, { changes: Object.keys(updates).filter(k => k !== "updated_at") }, req.ip || "").catch(() => {});
    res.json({ product: updated });
  } catch (err: any) {
    apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/store/:slug/products/:productId — Delete product
app.delete("/api/store/:slug/products/:productId", storeAccess, async (req: Request, res: Response) => {
  try {
    const store = req.apiStore!;
    const user = req.apiUser!;
    const { productId } = req.params;

    const existing = await db.selectFrom("products").select(["id", "title"]).where("id", "=", productId).where("shop_id", "=", store.id).executeTakeFirst();
    if (!existing) { res.status(404).json({ error: "Not found", message: "Product not found in this store" }); return; }

    await db.deleteFrom("product_variants").where("product_id", "=", productId).execute();
    await db.deleteFrom("product_images").where("product_id", "=", productId).execute();
    await db.deleteFrom("product_options").where("product_id", "=", productId).execute();
    await db.deleteFrom("collection_products").where("product_id", "=", productId).execute();
    await db.deleteFrom("products").where("id", "=", productId).where("shop_id", "=", store.id).execute();

    logApi(db, user.id, store.id, "product_delete", "product", productId, { title: existing.title }, req.ip || "").catch(() => {});
    res.json({ success: true });
  } catch (err: any) {
    apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/store/:slug/products/:productId/variants — Create variant
app.post("/api/store/:slug/products/:productId/variants", storeAccess, validate(schemas.createVariant), async (req: Request, res: Response) => {
  try {
    const store = req.apiStore!;
    const user = req.apiUser!;
    const { productId } = req.params;
    const { title, price, compare_at_price, sku, barcode, inventory_quantity, weight, weight_unit, option1, option2, option3, requires_shipping, taxable } = req.body;
    // Zod already validated: price required, weight_unit enum, inventory_quantity int >= 0

    const product = await db.selectFrom("products").select("id").where("id", "=", productId).where("shop_id", "=", store.id).executeTakeFirst();
    if (!product) { res.status(404).json({ error: "Not found", message: "Product not found in this store" }); return; }

    const maxPos = await db.selectFrom("product_variants").select(sql<number>`COALESCE(MAX(position), 0)`.as("max_pos")).where("product_id", "=", productId).executeTakeFirstOrThrow();
    const variantId = crypto.randomUUID();
    const now = new Date().toISOString();

    const variant = await db.insertInto("product_variants").values({
      id: variantId, product_id: productId, title: title || "Default Title", price,
      compare_at_price: compare_at_price ?? null, sku: sku || null, barcode: barcode || null,
      inventory_quantity: inventory_quantity ?? 0, weight: weight ?? null, weight_unit: weight_unit || "kg",
      option1: option1 || null, option2: option2 || null, option3: option3 || null,
      position: (maxPos.max_pos || 0) + 1, requires_shipping: requires_shipping ?? true, taxable: taxable ?? true,
      created_at: now, updated_at: now,
    }).returningAll().executeTakeFirstOrThrow();

    logApi(db, user.id, store.id, "variant_create", "product_variant", variantId, { product_id: productId }, req.ip || "").catch(() => {});
    res.status(201).json({ variant });
  } catch (err: any) {
    apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/store/:slug/products/:productId/variants/:variantId — Update variant
app.put("/api/store/:slug/products/:productId/variants/:variantId", storeAccess, validate(schemas.updateVariant), async (req: Request, res: Response) => {
  try {
    const store = req.apiStore!;
    const user = req.apiUser!;
    const { productId, variantId } = req.params;

    const product = await db.selectFrom("products").select("id").where("id", "=", productId).where("shop_id", "=", store.id).executeTakeFirst();
    if (!product) { res.status(404).json({ error: "Not found", message: "Product not found" }); return; }

    const existing = await db.selectFrom("product_variants").select("id").where("id", "=", variantId).where("product_id", "=", productId).executeTakeFirst();
    if (!existing) { res.status(404).json({ error: "Not found", message: "Variant not found" }); return; }

    const { title, price, compare_at_price, sku, barcode, inventory_quantity, weight, weight_unit, option1, option2, option3, image_url, requires_shipping, taxable } = req.body;
    const updates: Record<string, any> = { updated_at: new Date().toISOString() };
    if (title !== undefined) updates.title = title;
    if (price !== undefined) updates.price = price;
    if (compare_at_price !== undefined) updates.compare_at_price = compare_at_price;
    if (sku !== undefined) updates.sku = sku;
    if (barcode !== undefined) updates.barcode = barcode;
    if (inventory_quantity !== undefined) updates.inventory_quantity = inventory_quantity;
    if (weight !== undefined) updates.weight = weight;
    if (weight_unit !== undefined) updates.weight_unit = weight_unit;
    if (option1 !== undefined) updates.option1 = option1;
    if (option2 !== undefined) updates.option2 = option2;
    if (option3 !== undefined) updates.option3 = option3;
    if (image_url !== undefined) updates.image_url = image_url;
    if (requires_shipping !== undefined) updates.requires_shipping = requires_shipping;
    if (taxable !== undefined) updates.taxable = taxable;

    const updated = await db.updateTable("product_variants").set(updates).where("id", "=", variantId).where("product_id", "=", productId).returningAll().executeTakeFirstOrThrow();
    logApi(db, user.id, store.id, "variant_update", "product_variant", variantId, { changes: Object.keys(updates).filter(k => k !== "updated_at") }, req.ip || "").catch(() => {});
    res.json({ variant: updated });
  } catch (err: any) {
    apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/store/:slug/products/:productId/variants/:variantId — Delete variant
app.delete("/api/store/:slug/products/:productId/variants/:variantId", storeAccess, async (req: Request, res: Response) => {
  try {
    const store = req.apiStore!;
    const user = req.apiUser!;
    const { productId, variantId } = req.params;

    const product = await db.selectFrom("products").select("id").where("id", "=", productId).where("shop_id", "=", store.id).executeTakeFirst();
    if (!product) { res.status(404).json({ error: "Not found", message: "Product not found" }); return; }

    const existing = await db.selectFrom("product_variants").select("id").where("id", "=", variantId).where("product_id", "=", productId).executeTakeFirst();
    if (!existing) { res.status(404).json({ error: "Not found", message: "Variant not found" }); return; }

    const countResult = await db.selectFrom("product_variants").select(sql<number>`COUNT(*)`.as("count")).where("product_id", "=", productId).executeTakeFirstOrThrow();
    if (Number(countResult.count) <= 1) {
      res.status(400).json({ error: "Validation error", message: "Cannot delete the last variant" }); return;
    }

    await db.deleteFrom("product_variants").where("id", "=", variantId).where("product_id", "=", productId).execute();
    logApi(db, user.id, store.id, "variant_delete", "product_variant", variantId, { product_id: productId }, req.ip || "").catch(() => {});
    res.json({ success: true });
  } catch (err: any) {
    apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// COLLECTION CRUD (8 endpoints)
// ---------------------------------------------------------------------------

// GET /api/store/:slug/collections — List collections with pagination, search, filters
app.get("/api/store/:slug/collections", storeAccess, async (req: Request, res: Response) => {
  try {
    const store = req.apiStore!;
    const search = (req.query.search as string) || "";
    const published = req.query.published as string;
    const sortBy = (req.query.sort_by as string) || "created_at";
    const sortOrder = (req.query.sort_order as string) === "asc" ? "asc" as const : "desc" as const;
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const perPage = Math.min(250, Math.max(1, parseInt(req.query.per_page as string) || 25));

    let query = db.selectFrom("collections").where("shop_id", "=", store.id);
    let countQuery = db.selectFrom("collections").where("shop_id", "=", store.id).select(sql<number>`count(*)`.as("total"));

    if (search) {
      query = query.where("title", "ilike", `%${search}%`);
      countQuery = countQuery.where("title", "ilike", `%${search}%`);
    }
    if (published === "true") { query = query.where("published", "=", true); countQuery = countQuery.where("published", "=", true); }
    else if (published === "false") { query = query.where("published", "=", false); countQuery = countQuery.where("published", "=", false); }

    const allowedSorts = ["created_at", "updated_at", "title", "sort_order"];
    const safeSortBy = allowedSorts.includes(sortBy) ? sortBy : "created_at";

    const [collections, total] = await Promise.all([
      query.selectAll().orderBy(safeSortBy as any, sortOrder).limit(perPage).offset((page - 1) * perPage).execute(),
      countQuery.executeTakeFirst(),
    ]);

    // Fetch product counts for each collection
    const collectionIds = collections.map(c => c.id);
    const productCounts = collectionIds.length > 0
      ? await db.selectFrom("collection_products").select(["collection_id", sql<number>`count(*)`.as("count")]).where("collection_id", "in", collectionIds).groupBy("collection_id").execute()
      : [];
    const countMap = new Map(productCounts.map(r => [r.collection_id, Number(r.count)]));

    const totalCount = Number(total?.total ?? 0);
    res.json({
      collections: collections.map(c => ({ ...c, products_count: countMap.get(c.id) || 0 })),
      total: totalCount,
      page,
      per_page: perPage,
      pages: Math.ceil(totalCount / perPage),
    });
  } catch (err: any) {
    apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/store/:slug/collections/:collectionId — Get single collection with products
app.get("/api/store/:slug/collections/:collectionId", storeAccess, async (req: Request, res: Response) => {
  try {
    const store = req.apiStore!;
    const collection = await db.selectFrom("collections").selectAll().where("id", "=", req.params.collectionId).where("shop_id", "=", store.id).executeTakeFirst();
    if (!collection) { res.status(404).json({ error: "Not found", message: "Collection not found in this store" }); return; }
    const collectionProducts = await db.selectFrom("collection_products as cp")
      .innerJoin("products as p", "p.id", "cp.product_id")
      .select(["p.id", "p.title", "p.slug", "p.status", "p.vendor", "p.product_type", "p.tags", "cp.position"])
      .where("cp.collection_id", "=", collection.id)
      .orderBy("cp.position", "asc")
      .execute();
    res.json({ collection: { ...collection, products: collectionProducts, products_count: collectionProducts.length } });
  } catch (err: any) {
    apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/store/:slug/collections — Create collection
app.post("/api/store/:slug/collections", storeAccess, validate(schemas.createCollection), async (req: Request, res: Response) => {
  try {
    const store = req.apiStore!;
    const user = req.apiUser!;
    const { title, body_html, image_url, sort_order, published, rules } = req.body;

    if (!title || typeof title !== "string" || !title.trim()) {
      res.status(400).json({ error: "Validation error", message: "title is required" }); return;
    }

    const id = crypto.randomUUID();
    const slug = await generateUniqueCollectionSlug(store.id, title.trim());
    const now = new Date().toISOString();

    const collection = await db.insertInto("collections").values({
      id, shop_id: store.id, title: title.trim(), slug,
      body_html: body_html ? sanitizeHtml(body_html) : null, image_url: image_url || null,
      sort_order: sort_order || "alpha-asc", published: published ?? false,
      rules: rules ? JSON.stringify(rules) : null, created_at: now, updated_at: now,
    }).returningAll().executeTakeFirstOrThrow();

    logApi(db, user.id, store.id, "collection_create", "collection", id, { title: collection.title }, req.ip || "").catch(() => {});
    res.status(201).json({ collection });
  } catch (err: any) {
    apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/store/:slug/collections/:collectionId — Update collection
app.put("/api/store/:slug/collections/:collectionId", storeAccess, validate(schemas.updateCollection), async (req: Request, res: Response) => {
  try {
    const store = req.apiStore!;
    const user = req.apiUser!;
    const { collectionId } = req.params;
    const { title, body_html, image_url, sort_order, published, rules } = req.body;

    const existing = await db.selectFrom("collections").select("id").where("id", "=", collectionId).where("shop_id", "=", store.id).executeTakeFirst();
    if (!existing) { res.status(404).json({ error: "Not found", message: "Collection not found" }); return; }

    const updates: Record<string, any> = { updated_at: new Date().toISOString() };
    if (title !== undefined) updates.title = title.trim();
    if (body_html !== undefined) updates.body_html = body_html ? sanitizeHtml(body_html) : null;
    if (image_url !== undefined) updates.image_url = image_url;
    if (sort_order !== undefined) updates.sort_order = sort_order;
    if (published !== undefined) updates.published = published;
    if (rules !== undefined) updates.rules = JSON.stringify(rules);

    const updated = await db.updateTable("collections").set(updates).where("id", "=", collectionId).where("shop_id", "=", store.id).returningAll().executeTakeFirstOrThrow();
    logApi(db, user.id, store.id, "collection_update", "collection", collectionId, { changes: Object.keys(updates).filter(k => k !== "updated_at") }, req.ip || "").catch(() => {});
    res.json({ collection: updated });
  } catch (err: any) {
    apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/store/:slug/collections/:collectionId — Delete collection
app.delete("/api/store/:slug/collections/:collectionId", storeAccess, async (req: Request, res: Response) => {
  try {
    const store = req.apiStore!;
    const user = req.apiUser!;
    const { collectionId } = req.params;

    const existing = await db.selectFrom("collections").select(["id", "title"]).where("id", "=", collectionId).where("shop_id", "=", store.id).executeTakeFirst();
    if (!existing) { res.status(404).json({ error: "Not found", message: "Collection not found" }); return; }

    await db.deleteFrom("collection_products").where("collection_id", "=", collectionId).execute();
    await db.deleteFrom("collections").where("id", "=", collectionId).where("shop_id", "=", store.id).execute();

    logApi(db, user.id, store.id, "collection_delete", "collection", collectionId, { title: existing.title }, req.ip || "").catch(() => {});
    res.json({ success: true });
  } catch (err: any) {
    apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/store/:slug/collections/:collectionId/products — Add product to collection
app.post("/api/store/:slug/collections/:collectionId/products", storeAccess, validate(schemas.addCollectionProduct), async (req: Request, res: Response) => {
  try {
    const store = req.apiStore!;
    const user = req.apiUser!;
    const { collectionId } = req.params;
    const { product_id } = req.body;

    if (!product_id) { res.status(400).json({ error: "Validation error", message: "product_id is required" }); return; }

    const collection = await db.selectFrom("collections").select("id").where("id", "=", collectionId).where("shop_id", "=", store.id).executeTakeFirst();
    if (!collection) { res.status(404).json({ error: "Not found", message: "Collection not found" }); return; }

    const product = await db.selectFrom("products").select("id").where("id", "=", product_id).where("shop_id", "=", store.id).executeTakeFirst();
    if (!product) { res.status(404).json({ error: "Not found", message: "Product not found" }); return; }

    const already = await db.selectFrom("collection_products").select("collection_id").where("collection_id", "=", collectionId).where("product_id", "=", product_id).executeTakeFirst();
    if (already) { res.status(409).json({ error: "Conflict", message: "Product already in collection" }); return; }

    const maxPos = await db.selectFrom("collection_products").select(sql<number>`COALESCE(MAX(position), 0)`.as("mp")).where("collection_id", "=", collectionId).executeTakeFirstOrThrow();

    await db.insertInto("collection_products").values({ collection_id: collectionId, product_id, position: (maxPos.mp || 0) + 1 }).execute();
    logApi(db, user.id, store.id, "collection_product_add", "collection", collectionId, { product_id }, req.ip || "").catch(() => {});
    res.status(201).json({ success: true, collection_id: collectionId, product_id });
  } catch (err: any) {
    apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/store/:slug/collections/:collectionId/products/:productId — Remove product from collection
app.delete("/api/store/:slug/collections/:collectionId/products/:productId", storeAccess, async (req: Request, res: Response) => {
  try {
    const store = req.apiStore!;
    const user = req.apiUser!;
    const { collectionId, productId } = req.params;

    const collection = await db.selectFrom("collections").select("id").where("id", "=", collectionId).where("shop_id", "=", store.id).executeTakeFirst();
    if (!collection) { res.status(404).json({ error: "Not found", message: "Collection not found" }); return; }

    await db.deleteFrom("collection_products").where("collection_id", "=", collectionId).where("product_id", "=", productId).execute();
    logApi(db, user.id, store.id, "collection_product_remove", "collection", collectionId, { product_id: productId }, req.ip || "").catch(() => {});
    res.json({ success: true });
  } catch (err: any) {
    apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// DISCOUNT CRUD (7 endpoints)
// ---------------------------------------------------------------------------

// GET /api/store/:slug/discounts — List discounts with pagination, search, filters
app.get("/api/store/:slug/discounts", storeAccess, async (req: Request, res: Response) => {
  try {
    const store = req.apiStore!;
    const search = (req.query.search as string) || "";
    const status = req.query.status as string;
    const type = req.query.type as string;
    const sortBy = (req.query.sort_by as string) || "created_at";
    const sortOrder = (req.query.sort_order as string) === "asc" ? "asc" as const : "desc" as const;
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const perPage = Math.min(250, Math.max(1, parseInt(req.query.per_page as string) || 25));

    let query = db.selectFrom("discounts").where("shop_id", "=", store.id);
    let countQuery = db.selectFrom("discounts").where("shop_id", "=", store.id).select(sql<number>`count(*)`.as("total"));

    if (search) {
      query = query.where(eb => eb.or([eb("title", "ilike", `%${search}%`), eb("code", "ilike", `%${search}%`)]));
      countQuery = countQuery.where(eb => eb.or([eb("title", "ilike", `%${search}%`), eb("code", "ilike", `%${search}%`)]));
    }
    if (status) { query = query.where("status", "=", status); countQuery = countQuery.where("status", "=", status); }
    if (type) { query = query.where("type", "=", type); countQuery = countQuery.where("type", "=", type); }

    const allowedSorts = ["created_at", "updated_at", "title", "code", "starts_at", "ends_at", "usage_count"];
    const safeSortBy = allowedSorts.includes(sortBy) ? sortBy : "created_at";

    const [discounts, total] = await Promise.all([
      query.selectAll().orderBy(safeSortBy as any, sortOrder).limit(perPage).offset((page - 1) * perPage).execute(),
      countQuery.executeTakeFirst(),
    ]);

    const totalCount = Number(total?.total ?? 0);
    res.json({
      discounts,
      total: totalCount,
      page,
      per_page: perPage,
      pages: Math.ceil(totalCount / perPage),
    });
  } catch (err: any) {
    apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/store/:slug/discounts/:discountId — Get single discount
app.get("/api/store/:slug/discounts/:discountId", storeAccess, async (req: Request, res: Response) => {
  try {
    const store = req.apiStore!;
    const discount = await db.selectFrom("discounts").selectAll().where("id", "=", req.params.discountId).where("shop_id", "=", store.id).executeTakeFirst();
    if (!discount) { res.status(404).json({ error: "Not found", message: "Discount not found in this store" }); return; }
    res.json({ discount });
  } catch (err: any) {
    apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/store/:slug/discounts — Create discount
app.post("/api/store/:slug/discounts", storeAccess, validate(schemas.createDiscount), async (req: Request, res: Response) => {
  try {
    const store = req.apiStore!;
    const user = req.apiUser!;
    const { title, code, type, value, value_type, applies_to, target_selection, minimum_requirement_type, minimum_requirement_value, usage_limit, once_per_customer, starts_at, ends_at } = req.body;
    // Zod already validated & transformed: title, code (uppercased), type enum, value (positive), value_type, starts_at

    const existingCode = await db.selectFrom("discounts").select("id").where("shop_id", "=", store.id).where("code", "=", code).executeTakeFirst();
    if (existingCode) { res.status(409).json({ error: "Conflict", message: "Discount code already exists" }); return; }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    const discount = await db.insertInto("discounts").values({
      id, shop_id: store.id, title, code, type, value, value_type,
      applies_to: applies_to || "all", target_selection: target_selection ? JSON.stringify(target_selection) : null,
      minimum_requirement_type: minimum_requirement_type || "none", minimum_requirement_value: minimum_requirement_value ?? null,
      usage_limit: usage_limit ?? null, once_per_customer: once_per_customer ?? false,
      usage_count: 0, starts_at: new Date(starts_at).toISOString(), ends_at: ends_at ? new Date(ends_at).toISOString() : null,
      status: "active", created_at: now, updated_at: now,
    }).returningAll().executeTakeFirstOrThrow();

    logApi(db, user.id, store.id, "discount_create", "discount", id, { code, title }, req.ip || "").catch(() => {});
    res.status(201).json({ discount });
  } catch (err: any) {
    apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/store/:slug/discounts/:discountId — Update discount
app.put("/api/store/:slug/discounts/:discountId", storeAccess, validate(schemas.updateDiscount), async (req: Request, res: Response) => {
  try {
    const store = req.apiStore!;
    const user = req.apiUser!;
    const { discountId } = req.params;

    const existing = await db.selectFrom("discounts").selectAll().where("id", "=", discountId).where("shop_id", "=", store.id).executeTakeFirst();
    if (!existing) { res.status(404).json({ error: "Not found", message: "Discount not found" }); return; }

    const { title, code, type, value, value_type, applies_to, target_selection, minimum_requirement_type, minimum_requirement_value, usage_limit, once_per_customer, starts_at, ends_at, status } = req.body;
    const updates: Record<string, any> = { updated_at: new Date().toISOString() };

    if (title !== undefined) updates.title = title;
    if (type !== undefined) updates.type = type;
    if (value !== undefined) updates.value = Number(value);
    if (value_type !== undefined) updates.value_type = value_type;
    if (applies_to !== undefined) updates.applies_to = applies_to;
    if (target_selection !== undefined) updates.target_selection = JSON.stringify(target_selection);
    if (minimum_requirement_type !== undefined) updates.minimum_requirement_type = minimum_requirement_type;
    if (minimum_requirement_value !== undefined) updates.minimum_requirement_value = Number(minimum_requirement_value);
    if (usage_limit !== undefined) updates.usage_limit = usage_limit != null ? Number(usage_limit) : null;
    if (once_per_customer !== undefined) updates.once_per_customer = once_per_customer;
    if (starts_at !== undefined) updates.starts_at = new Date(starts_at).toISOString();
    if (ends_at !== undefined) updates.ends_at = ends_at ? new Date(ends_at).toISOString() : null;
    if (status !== undefined) updates.status = status;

    if (code !== undefined) {
      const normalizedCode = String(code).toUpperCase().trim();
      if (normalizedCode !== existing.code) {
        const dup = await db.selectFrom("discounts").select("id").where("shop_id", "=", store.id).where("code", "=", normalizedCode).where("id", "!=", discountId).executeTakeFirst();
        if (dup) { res.status(409).json({ error: "Conflict", message: "Discount code already exists" }); return; }
      }
      updates.code = normalizedCode;
    }

    const updated = await db.updateTable("discounts").set(updates).where("id", "=", discountId).where("shop_id", "=", store.id).returningAll().executeTakeFirstOrThrow();
    logApi(db, user.id, store.id, "discount_update", "discount", discountId, { changes: Object.keys(updates).filter(k => k !== "updated_at") }, req.ip || "").catch(() => {});
    res.json({ discount: updated });
  } catch (err: any) {
    apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/store/:slug/discounts/:discountId — Delete discount
app.delete("/api/store/:slug/discounts/:discountId", storeAccess, async (req: Request, res: Response) => {
  try {
    const store = req.apiStore!;
    const user = req.apiUser!;
    const { discountId } = req.params;

    const existing = await db.selectFrom("discounts").select(["id", "code", "title"]).where("id", "=", discountId).where("shop_id", "=", store.id).executeTakeFirst();
    if (!existing) { res.status(404).json({ error: "Not found", message: "Discount not found" }); return; }

    await db.deleteFrom("discounts").where("id", "=", discountId).where("shop_id", "=", store.id).execute();
    logApi(db, user.id, store.id, "discount_delete", "discount", discountId, { code: existing.code, title: existing.title }, req.ip || "").catch(() => {});
    res.json({ success: true });
  } catch (err: any) {
    apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/store/:slug/discounts/:discountId/status — Toggle discount status
app.put("/api/store/:slug/discounts/:discountId/status", storeAccess, validate(schemas.toggleDiscountStatus), async (req: Request, res: Response) => {
  try {
    const store = req.apiStore!;
    const user = req.apiUser!;
    const { discountId } = req.params;
    const { status } = req.body;
    // Zod already validated: status enum (active/expired/scheduled)

    const existing = await db.selectFrom("discounts").select(["id", "status", "code"]).where("id", "=", discountId).where("shop_id", "=", store.id).executeTakeFirst();
    if (!existing) { res.status(404).json({ error: "Not found", message: "Discount not found" }); return; }

    const updated = await db.updateTable("discounts").set({ status, updated_at: new Date().toISOString() }).where("id", "=", discountId).where("shop_id", "=", store.id).returningAll().executeTakeFirstOrThrow();
    logApi(db, user.id, store.id, "discount_status_change", "discount", discountId, { previous: existing.status, new_status: status }, req.ip || "").catch(() => {});
    res.json({ discount: updated });
  } catch (err: any) {
    apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// INVENTORY MANAGEMENT (3 endpoints)
// ---------------------------------------------------------------------------

// POST /api/store/:slug/inventory/adjust — Adjust inventory quantity
app.post("/api/store/:slug/inventory/adjust", storeAccess, validate(schemas.inventoryAdjust), async (req: Request, res: Response) => {
  try {
    const store = req.apiStore!;
    const user = req.apiUser!;
    const { variant_id, adjustment, reason } = req.body;
    // Zod already validated: variant_id UUID, adjustment int, reason optional

    const variant = await db.selectFrom("product_variants").innerJoin("products", "products.id", "product_variants.product_id")
      .where("product_variants.id", "=", variant_id).where("products.shop_id", "=", store.id)
      .select(["product_variants.id", "product_variants.inventory_quantity"]).executeTakeFirst();

    if (!variant) { res.status(404).json({ error: "Not found", message: "Variant not found in this store" }); return; }

    const prev = variant.inventory_quantity ?? 0;
    const newQty = Math.max(0, prev + adjustment);

    await db.updateTable("product_variants").set({ inventory_quantity: newQty, updated_at: new Date().toISOString() }).where("id", "=", variant_id).execute();
    logApi(db, user.id, store.id, "inventory_adjust", "product_variant", variant_id, { prev, new_qty: newQty, adjustment, reason }, req.ip || "").catch(() => {});
    res.json({ variant_id, previous_quantity: prev, new_quantity: newQty, adjustment });
  } catch (err: any) {
    apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/store/:slug/inventory/set — Set absolute inventory quantity
app.post("/api/store/:slug/inventory/set", storeAccess, validate(schemas.inventorySet), async (req: Request, res: Response) => {
  try {
    const store = req.apiStore!;
    const user = req.apiUser!;
    const { variant_id, quantity } = req.body;
    // Zod already validated: variant_id UUID, quantity int >= 0

    const variant = await db.selectFrom("product_variants").innerJoin("products", "products.id", "product_variants.product_id")
      .where("product_variants.id", "=", variant_id).where("products.shop_id", "=", store.id)
      .select(["product_variants.id", "product_variants.inventory_quantity"]).executeTakeFirst();

    if (!variant) { res.status(404).json({ error: "Not found", message: "Variant not found" }); return; }

    const prev = variant.inventory_quantity ?? 0;
    await db.updateTable("product_variants").set({ inventory_quantity: quantity, updated_at: new Date().toISOString() }).where("id", "=", variant_id).execute();
    logApi(db, user.id, store.id, "inventory_set", "product_variant", variant_id, { prev, new_qty: quantity }, req.ip || "").catch(() => {});
    res.json({ variant_id, previous_quantity: prev, new_quantity: quantity });
  } catch (err: any) {
    apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/store/:slug/inventory — List inventory levels
app.get("/api/store/:slug/inventory", storeAccess, async (req: Request, res: Response) => {
  try {
    const store = req.apiStore!;
    const lowStock = req.query.low_stock === "true";
    const search = (req.query.search as string) || "";
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const perPage = 50;

    let query = db.selectFrom("product_variants as pv").innerJoin("products as p", "p.id", "pv.product_id").where("p.shop_id", "=", store.id);
    let countQuery = db.selectFrom("product_variants as pv").innerJoin("products as p", "p.id", "pv.product_id").where("p.shop_id", "=", store.id);

    if (lowStock) { query = query.where("pv.inventory_quantity", "<", 10); countQuery = countQuery.where("pv.inventory_quantity", "<", 10); }
    if (search) { query = query.where("pv.sku", "ilike", `%${search}%`); countQuery = countQuery.where("pv.sku", "ilike", `%${search}%`); }

    const [items, total] = await Promise.all([
      query.select(["pv.id as variant_id", "pv.title as variant_title", "pv.sku", "pv.inventory_quantity", "pv.price", "p.title as product_title"])
        .orderBy("pv.inventory_quantity", "asc").limit(perPage).offset((page - 1) * perPage).execute(),
      countQuery.select(sql<number>`count(*)`.as("total")).executeTakeFirst(),
    ]);

    res.json({ items, total: Number(total?.total ?? 0), page, per_page: perPage });
  } catch (err: any) {
    apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// CUSTOMER CRUD (4 endpoints)
// ---------------------------------------------------------------------------

// POST /api/store/:slug/customers — Create customer
app.post("/api/store/:slug/customers", storeAccess, validate(schemas.createCustomer), async (req: Request, res: Response) => {
  try {
    const store = req.apiStore!;
    const user = req.apiUser!;
    const { email, first_name, last_name, phone, accepts_marketing, tags, note, tax_exempt } = req.body;
    // Zod already validated: email format + normalized to lowercase, first_name required

    const existing = await db.selectFrom("customers").select("id").where("shop_id", "=", store.id).where("email", "=", email).executeTakeFirst();
    if (existing) { res.status(409).json({ error: "Conflict", message: "Customer with this email already exists" }); return; }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    const customer = await db.insertInto("customers").values({
      id, shop_id: store.id, email,
      first_name: first_name || null, last_name: last_name || null, phone: phone || null,
      accepts_marketing: accepts_marketing ?? false, orders_count: 0, total_spent: 0,
      tags: tags || [], note: note || null, tax_exempt: tax_exempt ?? false,
      verified_email: false, status: "active", created_at: now, updated_at: now,
    }).returningAll().executeTakeFirstOrThrow();

    logApi(db, user.id, store.id, "customer_create", "customer", id, { email: customer.email }, req.ip || "").catch(() => {});
    triggerWebhook(db, store.id, "customers/create", { id, email: customer.email, first_name: customer.first_name }).catch(() => {});
    void fireAutomationTrigger(db, store.id, "customer_created", { customer: { id, email: customer.email, first_name: customer.first_name, last_name: customer.last_name } }).catch(() => {});
    res.status(201).json({ customer });
  } catch (err: any) {
    apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/store/:slug/customers/:customerId — Update customer
app.put("/api/store/:slug/customers/:customerId", storeAccess, validate(schemas.updateCustomer), async (req: Request, res: Response) => {
  try {
    const store = req.apiStore!;
    const user = req.apiUser!;
    const { customerId } = req.params;

    const existing = await db.selectFrom("customers").selectAll().where("id", "=", customerId).where("shop_id", "=", store.id).executeTakeFirst();
    if (!existing) { res.status(404).json({ error: "Not found", message: "Customer not found" }); return; }

    const allowed = ["email", "first_name", "last_name", "phone", "accepts_marketing", "tags", "note", "tax_exempt", "status"];
    const updates: Record<string, any> = { updated_at: new Date().toISOString() };
    for (const field of allowed) {
      if (req.body[field] !== undefined) updates[field] = req.body[field];
    }

    if (updates.email) {
      updates.email = updates.email.toLowerCase();
      if (updates.email !== existing.email) {
        const dup = await db.selectFrom("customers").select("id").where("shop_id", "=", store.id).where("email", "=", updates.email).where("id", "!=", customerId).executeTakeFirst();
        if (dup) { res.status(409).json({ error: "Conflict", message: "Email already exists" }); return; }
      }
    }

    const updated = await db.updateTable("customers").set(updates).where("id", "=", customerId).where("shop_id", "=", store.id).returningAll().executeTakeFirstOrThrow();
    logApi(db, user.id, store.id, "customer_update", "customer", customerId, { changes: Object.keys(updates).filter(k => k !== "updated_at") }, req.ip || "").catch(() => {});
    res.json({ customer: updated });
  } catch (err: any) {
    apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/store/:slug/customers/:customerId — Delete customer
app.delete("/api/store/:slug/customers/:customerId", storeAccess, async (req: Request, res: Response) => {
  try {
    const store = req.apiStore!;
    const user = req.apiUser!;
    const { customerId } = req.params;

    const existing = await db.selectFrom("customers").select(["id", "email"]).where("id", "=", customerId).where("shop_id", "=", store.id).executeTakeFirst();
    if (!existing) { res.status(404).json({ error: "Not found", message: "Customer not found" }); return; }

    const activeOrder = await db.selectFrom("orders").where("customer_id", "=", customerId).where("financial_status", "!=", "voided").select("id").executeTakeFirst();
    if (activeOrder) { res.status(409).json({ error: "Conflict", message: "Cannot delete customer with active orders" }); return; }

    await db.deleteFrom("customer_addresses").where("customer_id", "=", customerId).execute();
    await db.deleteFrom("customers").where("id", "=", customerId).where("shop_id", "=", store.id).execute();

    logApi(db, user.id, store.id, "customer_delete", "customer", customerId, { email: existing.email }, req.ip || "").catch(() => {});
    res.json({ success: true });
  } catch (err: any) {
    apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/store/:slug/customers (enhanced with segments)
app.get("/api/store/:slug/customers", storeAccess, async (req: Request, res: Response) => {
  try {
    const store = req.apiStore!;
    const search = (req.query.search as string) || "";
    const status = req.query.status as string;
    const segment = req.query.segment as string;
    const acceptsMarketing = req.query.accepts_marketing as string;
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const perPage = Math.min(100, Math.max(1, parseInt(req.query.per_page as string) || 50));

    let query = db.selectFrom("customers").where("shop_id", "=", store.id);
    let countQuery = db.selectFrom("customers").where("shop_id", "=", store.id).select(sql<number>`count(*)`.as("total"));

    if (search) {
      query = query.where(eb => eb.or([eb("email", "ilike", `%${search}%`), eb("first_name", "ilike", `%${search}%`), eb("last_name", "ilike", `%${search}%`)]));
      countQuery = countQuery.where(eb => eb.or([eb("email", "ilike", `%${search}%`), eb("first_name", "ilike", `%${search}%`), eb("last_name", "ilike", `%${search}%`)]));
    }
    if (status) { query = query.where("status", "=", status); countQuery = countQuery.where("status", "=", status); }
    if (acceptsMarketing === "true") { query = query.where("accepts_marketing", "=", true); countQuery = countQuery.where("accepts_marketing", "=", true); }
    if (segment === "repeat") { query = query.where("orders_count", ">", 1); countQuery = countQuery.where("orders_count", ">", 1); }
    else if (segment === "new") { const d = new Date(Date.now() - 30*86400000).toISOString(); query = query.where("created_at", ">=", d); countQuery = countQuery.where("created_at", ">=", d); }
    else if (segment === "vip") { query = query.where("total_spent", ">", 500); countQuery = countQuery.where("total_spent", ">", 500); }

    const [customers, total] = await Promise.all([
      query.selectAll().orderBy("created_at", "desc").limit(perPage).offset((page - 1) * perPage).execute(),
      countQuery.executeTakeFirst(),
    ]);

    res.json({ customers, total: Number(total?.total ?? 0), page, per_page: perPage });
  } catch (err: any) {
    apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' });
  }
});

// ===========================================================================
// PUBLIC STOREFRONT API — Headless JSON endpoints (no auth required)
// These mirror Shopify's Storefront API for headless/mobile apps.
// ===========================================================================

// GET /api/storefront/:slug/products.json — Public product catalog
app.get("/api/storefront/:slug/products.json", async (req: Request, res: Response) => {
  try {
    const shop = await db.selectFrom("shops").select(["id"]).where("slug", "=", req.params.slug).where("status", "=", "active").executeTakeFirst();
    if (!shop) { res.status(404).json({ error: "Store not found" }); return; }
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 20));
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const collectionHandle = req.query.collection as string;
    const search = req.query.q as string;
    const sortBy = (req.query.sort_by as string) || "created_at";

    let query = db.selectFrom("products").where("shop_id", "=", shop.id).where("status", "=", "active");
    let countQ = db.selectFrom("products").where("shop_id", "=", shop.id).where("status", "=", "active").select(sql<number>`count(*)`.as("total"));

    if (search) {
      query = query.where(eb => eb.or([eb("title", "ilike", `%${search}%`), eb("tags", "ilike", `%${search}%`)]));
      countQ = countQ.where(eb => eb.or([eb("title", "ilike", `%${search}%`), eb("tags", "ilike", `%${search}%`)]));
    }
    if (collectionHandle) {
      const col = await db.selectFrom("collections").select("id").where("shop_id", "=", shop.id).where("slug", "=", collectionHandle).executeTakeFirst();
      if (col) {
        query = query.where("id", "in", db.selectFrom("collection_products").select("product_id").where("collection_id", "=", col.id));
        countQ = countQ.where("id", "in", db.selectFrom("collection_products").select("product_id").where("collection_id", "=", col.id));
      }
    }

    const [products, total] = await Promise.all([
      query.selectAll().orderBy(sortBy === "title" ? "title" : "created_at", "desc").limit(limit).offset((page - 1) * limit).execute(),
      countQ.executeTakeFirst(),
    ]);

    const productIds = products.map(p => p.id);
    const variants = productIds.length > 0
      ? await db.selectFrom("product_variants").selectAll().where("product_id", "in", productIds).orderBy("position", "asc").execute()
      : [];
    const variantMap = new Map<string, typeof variants>();
    for (const v of variants) { const arr = variantMap.get(v.product_id) || []; arr.push(v); variantMap.set(v.product_id, arr); }

    res.json({
      products: products.map(p => ({ ...p, variants: variantMap.get(p.id) || [] })),
      total: Number(total?.total ?? 0), page, limit,
    });
  } catch (err: any) { apiLogger.error({ err }, 'Request failed'); res.status(500).json({ error: 'Internal server error' }); }
});

// GET /api/storefront/:slug/products/:handle.json — Single product
app.get("/api/storefront/:slug/products/:handle.json", async (req: Request, res: Response) => {
  try {
    const shop = await db.selectFrom("shops").select(["id"]).where("slug", "=", req.params.slug).where("status", "=", "active").executeTakeFirst();
    if (!shop) { res.status(404).json({ error: "Store not found" }); return; }
    const product = await db.selectFrom("products").selectAll().where("shop_id", "=", shop.id).where("slug", "=", req.params.handle).where("status", "=", "active").executeTakeFirst();
    if (!product) { res.status(404).json({ error: "Product not found" }); return; }
    const [variants, images, reviews] = await Promise.all([
      db.selectFrom("product_variants").selectAll().where("product_id", "=", product.id).orderBy("position", "asc").execute(),
      db.selectFrom("product_images").selectAll().where("product_id", "=", product.id).orderBy("position", "asc").execute(),
      db.selectFrom("product_reviews").select([db.fn.countAll<number>().as("count"), db.fn.avg<number>("rating").as("avg")])
        .where("product_id", "=", product.id).where("status", "=", "approved").executeTakeFirst(),
    ]);
    res.json({ product: { ...product, variants, images, reviews_count: Number(reviews?.count ?? 0), reviews_average: reviews?.avg ? Number(Number(reviews.avg).toFixed(1)) : null } });
  } catch (err: any) { apiLogger.error({ err }, 'Request failed'); res.status(500).json({ error: 'Internal server error' }); }
});

// GET /api/storefront/:slug/collections.json — Public collection list
app.get("/api/storefront/:slug/collections.json", async (req: Request, res: Response) => {
  try {
    const shop = await db.selectFrom("shops").select(["id"]).where("slug", "=", req.params.slug).where("status", "=", "active").executeTakeFirst();
    if (!shop) { res.status(404).json({ error: "Store not found" }); return; }
    const collections = await db.selectFrom("collections").selectAll().where("shop_id", "=", shop.id).where("published", "=", true).orderBy("sort_order", "asc").execute();
    res.json({ collections });
  } catch (err: any) { apiLogger.error({ err }, 'Request failed'); res.status(500).json({ error: 'Internal server error' }); }
});

// GET /api/storefront/:slug/pages.json — Public pages list
app.get("/api/storefront/:slug/pages.json", async (req: Request, res: Response) => {
  try {
    const shop = await db.selectFrom("shops").select(["id"]).where("slug", "=", req.params.slug).where("status", "=", "active").executeTakeFirst();
    if (!shop) { res.status(404).json({ error: "Store not found" }); return; }
    const pages = await db.selectFrom("pages").selectAll().where("shop_id", "=", shop.id).where("published", "=", true).orderBy("created_at", "desc").execute();
    res.json({ pages });
  } catch (err: any) { apiLogger.error({ err }, 'Request failed'); res.status(500).json({ error: 'Internal server error' }); }
});

// GET /api/storefront/:slug/search.json — Public product search
app.get("/api/storefront/:slug/search.json", async (req: Request, res: Response) => {
  try {
    const shop = await db.selectFrom("shops").select(["id"]).where("slug", "=", req.params.slug).where("status", "=", "active").executeTakeFirst();
    if (!shop) { res.status(404).json({ error: "Store not found" }); return; }
    const q = (req.query.q as string) || "";
    if (!q.trim()) { res.json({ results: [], total: 0 }); return; }
    const limit = Math.min(50, parseInt(req.query.limit as string) || 20);
    const result = await searchProductsFull(db, shop.id, q, {}, { limit, offset: 0 });
    res.json({ results: result.results, total: result.total });
  } catch (err: any) { apiLogger.error({ err }, 'Request failed'); res.status(500).json({ error: 'Internal server error' }); }
});

// ===========================================================================
// CONTENT CMS — Pages, Blog Posts, Menus, Files (17 endpoints)
// ===========================================================================

import {
  createPage, getPage, updatePage, deletePage, listPages,
  createBlogPost, getBlogPost, updateBlogPost, deleteBlogPost, listBlogPosts,
  createMenu, getMenu, updateMenu, addMenuItem, reorderMenuItems, deleteMenuItem,
  uploadFile, listFiles,
} from "@gbox/core/modules/content/service.js";

// --- Pages ---
app.get("/api/store/:slug/pages", storeAccess, async (req: Request, res: Response) => {
  try {
    const store = req.apiStore!;
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const perPage = Math.min(100, Math.max(1, parseInt(req.query.per_page as string) || 25));
    const result = await listPages(db, store.id, { limit: perPage, offset: (page - 1) * perPage });
    res.json({ pages: result.pages, total: result.total, page, per_page: perPage });
  } catch (err: any) { apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' }); }
});

app.get("/api/store/:slug/pages/:pageSlug", storeAccess, async (req: Request, res: Response) => {
  try {
    const store = req.apiStore!;
    const pg = await getPage(db, store.id, req.params.pageSlug);
    if (!pg) { res.status(404).json({ error: "Not found", message: "Page not found" }); return; }
    res.json({ page: pg });
  } catch (err: any) { apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' }); }
});

app.post("/api/store/:slug/pages", storeAccess, validate(schemas.createPage), async (req: Request, res: Response) => {
  try {
    const store = req.apiStore!;
    const { title, slug: pageSlug, body_html, author, template_suffix, published } = req.body;
    const pg = await createPage(db, store.id, { title, slug: pageSlug, body_html, author, template_suffix, published });
    res.status(201).json({ page: pg });
  } catch (err: any) { apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' }); }
});

app.put("/api/store/:slug/pages/:pageId", storeAccess, validate(schemas.updatePage), async (req: Request, res: Response) => {
  try {
    const store = req.apiStore!;
    const pg = await updatePage(db, store.id, req.params.pageId, req.body);
    res.json({ page: pg });
  } catch (err: any) { apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' }); }
});

app.delete("/api/store/:slug/pages/:pageId", storeAccess, async (req: Request, res: Response) => {
  try {
    const store = req.apiStore!;
    await deletePage(db, store.id, req.params.pageId);
    res.json({ success: true });
  } catch (err: any) { apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' }); }
});

// --- Blog Posts ---
app.get("/api/store/:slug/blog-posts", storeAccess, async (req: Request, res: Response) => {
  try {
    const store = req.apiStore!;
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const perPage = Math.min(100, Math.max(1, parseInt(req.query.per_page as string) || 25));
    const published = req.query.published as string;
    const tag = req.query.tag as string;
    const search = req.query.search as string;
    const filters: any = {};
    if (published === "true") filters.published = true;
    else if (published === "false") filters.published = false;
    if (tag) filters.tag = tag;
    if (search) filters.search = search;
    const result = await listBlogPosts(db, store.id, filters, { limit: perPage, offset: (page - 1) * perPage });
    res.json({ blog_posts: result.posts, total: result.total, page, per_page: perPage });
  } catch (err: any) { apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' }); }
});

app.get("/api/store/:slug/blog-posts/:postSlug", storeAccess, async (req: Request, res: Response) => {
  try {
    const store = req.apiStore!;
    const post = await getBlogPost(db, store.id, req.params.postSlug);
    if (!post) { res.status(404).json({ error: "Not found", message: "Blog post not found" }); return; }
    res.json({ blog_post: post });
  } catch (err: any) { apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' }); }
});

app.post("/api/store/:slug/blog-posts", storeAccess, validate(schemas.createBlogPost), async (req: Request, res: Response) => {
  try {
    const store = req.apiStore!;
    const { title, slug: postSlug, body_html, excerpt, author, tags, image_url, published, published_at } = req.body;
    const post = await createBlogPost(db, store.id, { title, slug: postSlug, body_html, excerpt, author, tags, image_url, published, published_at });
    res.status(201).json({ blog_post: post });
  } catch (err: any) { apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' }); }
});

app.put("/api/store/:slug/blog-posts/:postId", storeAccess, validate(schemas.updateBlogPost), async (req: Request, res: Response) => {
  try {
    const store = req.apiStore!;
    const post = await updateBlogPost(db, store.id, req.params.postId, req.body);
    res.json({ blog_post: post });
  } catch (err: any) { apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' }); }
});

app.delete("/api/store/:slug/blog-posts/:postId", storeAccess, async (req: Request, res: Response) => {
  try {
    const store = req.apiStore!;
    await deleteBlogPost(db, store.id, req.params.postId);
    res.json({ success: true });
  } catch (err: any) { apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' }); }
});

// --- Menus / Navigation ---
app.get("/api/store/:slug/menus", storeAccess, async (req: Request, res: Response) => {
  try {
    const store = req.apiStore!;
    const menus = await db.selectFrom("menus").selectAll().where("shop_id", "=", store.id).orderBy("created_at", "asc").execute();
    res.json({ menus });
  } catch (err: any) { apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' }); }
});

app.get("/api/store/:slug/menus/:menuSlug", storeAccess, async (req: Request, res: Response) => {
  try {
    const store = req.apiStore!;
    const menu = await getMenu(db, store.id, req.params.menuSlug);
    if (!menu) { res.status(404).json({ error: "Not found", message: "Menu not found" }); return; }
    res.json({ menu });
  } catch (err: any) { apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' }); }
});

app.post("/api/store/:slug/menus", storeAccess, validate(schemas.createMenu), async (req: Request, res: Response) => {
  try {
    const store = req.apiStore!;
    const { title, slug: menuSlug } = req.body;
    const menu = await createMenu(db, store.id, { title, slug: menuSlug });
    res.status(201).json({ menu });
  } catch (err: any) { apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' }); }
});

app.put("/api/store/:slug/menus/:menuId", storeAccess, validate(schemas.updateMenu), async (req: Request, res: Response) => {
  try {
    const store = req.apiStore!;
    const menu = await updateMenu(db, store.id, req.params.menuId, req.body);
    res.json({ menu });
  } catch (err: any) { apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' }); }
});

app.post("/api/store/:slug/menus/:menuId/items", storeAccess, validate(schemas.createMenuItem), async (req: Request, res: Response) => {
  try {
    const { title, url, resource_type, resource_id, parent_id, position } = req.body;
    const item = await addMenuItem(db, req.params.menuId, { title, url, resource_type, resource_id, parent_id, position });
    res.status(201).json({ menu_item: item });
  } catch (err: any) { apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' }); }
});

app.put("/api/store/:slug/menus/:menuId/items/reorder", storeAccess, async (req: Request, res: Response) => {
  try {
    const { item_ids } = req.body;
    if (!Array.isArray(item_ids)) { res.status(400).json({ error: "item_ids array is required" }); return; }
    await reorderMenuItems(db, req.params.menuId, item_ids);
    res.json({ success: true });
  } catch (err: any) { apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' }); }
});

app.delete("/api/store/:slug/menus/items/:itemId", storeAccess, async (req: Request, res: Response) => {
  try {
    await deleteMenuItem(db, req.params.itemId);
    res.json({ success: true });
  } catch (err: any) { apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' }); }
});

// --- Files ---
app.get("/api/store/:slug/files", storeAccess, async (req: Request, res: Response) => {
  try {
    const store = req.apiStore!;
    const files = await listFiles(db, store.id);
    res.json({ files });
  } catch (err: any) { apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' }); }
});

app.post("/api/store/:slug/files", storeAccess, validate(schemas.createFile), async (req: Request, res: Response) => {
  try {
    const store = req.apiStore!;
    const { filename, mime_type, size, url, alt } = req.body;
    const file = await uploadFile(db, store.id, { filename, mime_type, size, url, alt });
    res.status(201).json({ file });
  } catch (err: any) { apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' }); }
});

// POST /api/store/:slug/files/upload — Binary file upload via multipart/form-data
// Uses multer for parsing + magic-byte validation + ObjectStore for storage.
app.post("/api/store/:slug/files/upload", storeAccess, upload.single("file"), validateUpload, async (req: Request, res: Response) => {
  try {
    const store = req.apiStore!;
    const multerFile = (req as any).file;
    if (!multerFile) { res.status(400).json({ error: "No file uploaded" }); return; }

    const alt = req.body.alt || null;
    const objectStore = getObjectStore();
    const ext = (multerFile as any).detectedExtension || multerFile.originalname?.split(".").pop() || "bin";
    const key = `shops/${store.id}/files/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const url = await objectStore.put(key, multerFile.buffer, { contentType: multerFile.mimetype });

    const file = await uploadFile(db, store.id, {
      filename: multerFile.originalname || key,
      mime_type: multerFile.mimetype,
      size: multerFile.size,
      url,
      alt,
    });

    logApi(db, req.apiUser!.id, store.id, "file_uploaded", "file", file.id, { key, size: multerFile.size }, req.ip || "").catch(() => {});
    res.status(201).json({ file });
  } catch (err: any) {
    apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/store/:slug/files/:fileId — Delete a file
app.delete("/api/store/:slug/files/:fileId", storeAccess, async (req: Request, res: Response) => {
  try {
    const store = req.apiStore!;
    // Get file info first
    const file = await db.selectFrom("files").selectAll().where("id", "=", req.params.fileId).where("shop_id", "=", store.id).executeTakeFirst();
    if (!file) { res.status(404).json({ error: "File not found" }); return; }

    // Delete from object store if url looks like an object store key
    try {
      const objectStore = getObjectStore();
      const urlStr = String(file.url || "");
      if (urlStr.includes(`shops/${store.id}/files/`)) {
        const key = urlStr.includes("shops/") ? urlStr.substring(urlStr.indexOf("shops/")) : "";
        if (key) await objectStore.delete(key);
      }
    } catch { /* object store delete is best-effort */ }

    await db.deleteFrom("files").where("id", "=", req.params.fileId).where("shop_id", "=", store.id).execute();
    logApi(db, req.apiUser!.id, store.id, "file_deleted", "file", req.params.fileId, {}, req.ip || "").catch(() => {});
    res.json({ success: true });
  } catch (err: any) { apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' }); }
});

// ===========================================================================
// MULTI-CURRENCY (4 endpoints)
// ===========================================================================

import { getRate, convert, setRate } from "@gbox/core/modules/currency/service.js";

// GET /api/store/:slug/currencies — list enabled currencies for this store
app.get("/api/store/:slug/currencies", storeAccess, async (req: Request, res: Response) => {
  try {
    const store = req.apiStore!;
    const rates = await db
      .selectFrom("currency_rates")
      .selectAll()
      .orderBy("quote_currency", "asc")
      .execute();
    const shopCurrency = store.currency || "USD";
    const currencies = rates
      .filter((r: any) => r.base_currency === shopCurrency)
      .map((r: any) => ({ currency: r.quote_currency, rate: r.rate, source: r.source }));
    res.json({ shop_currency: shopCurrency, currencies });
  } catch (err: any) { apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' }); }
});

// GET /api/store/:slug/currencies/convert — convert amount between currencies
app.get("/api/store/:slug/currencies/convert", storeAccess, async (req: Request, res: Response) => {
  try {
    const { amount, from, to } = req.query as { amount?: string; from?: string; to?: string };
    if (!amount || !from || !to) { res.status(400).json({ error: "amount, from, and to are required" }); return; }
    const result = await convert(db, amount, from, to);
    res.json(result);
  } catch (err: any) { res.status(400).json({ error: err.message }); }
});

// GET /api/store/:slug/currencies/rate — get rate between two currencies
app.get("/api/store/:slug/currencies/rate", storeAccess, async (req: Request, res: Response) => {
  try {
    const { from, to } = req.query as { from?: string; to?: string };
    if (!from || !to) { res.status(400).json({ error: "from and to are required" }); return; }
    const rate = await getRate(db, from, to);
    if (!rate) { res.status(404).json({ error: "No rate found", message: `No exchange rate: ${from} → ${to}` }); return; }
    res.json({ from: from.toUpperCase(), to: to.toUpperCase(), rate });
  } catch (err: any) { apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' }); }
});

// POST /api/store/:slug/currencies/rate — set/update exchange rate (admin)
app.post("/api/store/:slug/currencies/rate", storeAccess, async (req: Request, res: Response) => {
  try {
    const { base, quote, rate, source } = req.body;
    if (!base || !quote || !rate) { res.status(400).json({ error: "base, quote, and rate are required" }); return; }
    await setRate(db, base, quote, String(rate), source || "manual");
    logApi(db, req.apiUser!.id, req.apiStore!.id, "currency_rate_set", "currency", `${base}:${quote}`, { rate, source }, req.ip || "").catch(() => {});
    res.json({ success: true, base: base.toUpperCase(), quote: quote.toUpperCase(), rate: String(rate) });
  } catch (err: any) { apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' }); }
});

// ===========================================================================
// MARKETS — Country-Specific Pricing Rules (G.1)
// ===========================================================================

// GET /api/store/:slug/markets/pricing-rules — list pricing rules
app.get("/api/store/:slug/markets/pricing-rules", storeAccess, async (req: Request, res: Response) => {
  try {
    const shopId = req.apiStore!.id;
    const row = await db.selectFrom("shop_settings").select("value").where("shop_id", "=", shopId).where("key", "=", "market_pricing_rules").executeTakeFirst();
    const rules = row ? JSON.parse(row.value as string) : [];
    res.json({ pricing_rules: rules });
  } catch (err: any) { apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' }); }
});

// POST /api/store/:slug/markets/pricing-rules — create a pricing rule
app.post("/api/store/:slug/markets/pricing-rules", storeAccess, async (req: Request, res: Response) => {
  try {
    const shopId = req.apiStore!.id;
    const { country_code, adjustment_type, adjustment_value, currency } = req.body;

    if (!country_code || !adjustment_type || adjustment_value == null) {
      res.status(400).json({ error: "country_code, adjustment_type, and adjustment_value are required" }); return;
    }
    if (adjustment_type !== "percentage" && adjustment_type !== "fixed") {
      res.status(400).json({ error: "adjustment_type must be 'percentage' or 'fixed'" }); return;
    }
    if (typeof adjustment_value !== "number" || isNaN(adjustment_value)) {
      res.status(400).json({ error: "adjustment_value must be a number" }); return;
    }

    // Load existing rules
    const row = await db.selectFrom("shop_settings").select(["id", "value"]).where("shop_id", "=", shopId).where("key", "=", "market_pricing_rules").executeTakeFirst();
    const rules: any[] = row ? JSON.parse(row.value as string) : [];

    const newRule = {
      id: `pr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      country_code: country_code.toUpperCase(),
      adjustment_type,
      adjustment_value,
      currency: currency ? currency.toUpperCase() : undefined,
      created_at: new Date().toISOString(),
    };
    rules.push(newRule);

    // Upsert
    if (row) {
      await db.updateTable("shop_settings").set({ value: JSON.stringify(rules), updated_at: new Date().toISOString() } as any).where("shop_id", "=", shopId).where("key", "=", "market_pricing_rules").execute();
    } else {
      await db.insertInto("shop_settings").values({ shop_id: shopId, key: "market_pricing_rules", value: JSON.stringify(rules) } as any).execute();
    }

    logApi(db, req.apiUser!.id, shopId, "market_pricing_rule_created", "shop", shopId, { rule: newRule }, req.ip || "").catch(() => {});
    res.status(201).json({ pricing_rule: newRule });
  } catch (err: any) { apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' }); }
});

// DELETE /api/store/:slug/markets/pricing-rules/:id — delete a pricing rule
app.delete("/api/store/:slug/markets/pricing-rules/:id", storeAccess, async (req: Request, res: Response) => {
  try {
    const shopId = req.apiStore!.id;
    const ruleId = req.params.id;

    const row = await db.selectFrom("shop_settings").select(["id", "value"]).where("shop_id", "=", shopId).where("key", "=", "market_pricing_rules").executeTakeFirst();
    if (!row) { res.status(404).json({ error: "No pricing rules found" }); return; }

    const rules: any[] = JSON.parse(row.value as string);
    const idx = rules.findIndex((r: any) => r.id === ruleId);
    if (idx === -1) { res.status(404).json({ error: "Pricing rule not found" }); return; }

    const removed = rules.splice(idx, 1)[0];
    await db.updateTable("shop_settings").set({ value: JSON.stringify(rules), updated_at: new Date().toISOString() } as any).where("shop_id", "=", shopId).where("key", "=", "market_pricing_rules").execute();

    logApi(db, req.apiUser!.id, shopId, "market_pricing_rule_deleted", "shop", shopId, { rule: removed }, req.ip || "").catch(() => {});
    res.json({ deleted: true, id: ruleId });
  } catch (err: any) { apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' }); }
});

// ===========================================================================
// MARKETS — Duty/Tax Rates per Market (G.1)
// ===========================================================================

// GET /api/store/:slug/markets/tax-rates — list tax rates by country
app.get("/api/store/:slug/markets/tax-rates", storeAccess, async (req: Request, res: Response) => {
  try {
    const shopId = req.apiStore!.id;
    const row = await db.selectFrom("shop_settings").select("value").where("shop_id", "=", shopId).where("key", "=", "market_tax_rates").executeTakeFirst();
    const rates = row ? JSON.parse(row.value as string) : [];
    res.json({ tax_rates: rates });
  } catch (err: any) { apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' }); }
});

// POST /api/store/:slug/markets/tax-rates — set/update tax rate for a country
app.post("/api/store/:slug/markets/tax-rates", storeAccess, async (req: Request, res: Response) => {
  try {
    const shopId = req.apiStore!.id;
    const { country_code, rate, name, included_in_price } = req.body;

    if (!country_code || rate == null) {
      res.status(400).json({ error: "country_code and rate are required" }); return;
    }
    if (typeof rate !== "number" || isNaN(rate) || rate < 0 || rate > 100) {
      res.status(400).json({ error: "rate must be a number between 0 and 100" }); return;
    }

    // Load existing rates
    const row = await db.selectFrom("shop_settings").select(["id", "value"]).where("shop_id", "=", shopId).where("key", "=", "market_tax_rates").executeTakeFirst();
    const rates: any[] = row ? JSON.parse(row.value as string) : [];

    // Upsert: replace existing rate for the same country_code, or add new
    const existingIdx = rates.findIndex((r: any) => r.country_code === country_code.toUpperCase());
    const taxRate = {
      id: existingIdx >= 0 ? rates[existingIdx].id : `tr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      country_code: country_code.toUpperCase(),
      rate,
      name: name || "Tax",
      included_in_price: included_in_price === true,
      updated_at: new Date().toISOString(),
    };

    if (existingIdx >= 0) {
      rates[existingIdx] = taxRate;
    } else {
      taxRate.updated_at = new Date().toISOString();
      rates.push(taxRate);
    }

    // Upsert shop_settings row
    if (row) {
      await db.updateTable("shop_settings").set({ value: JSON.stringify(rates), updated_at: new Date().toISOString() } as any).where("shop_id", "=", shopId).where("key", "=", "market_tax_rates").execute();
    } else {
      await db.insertInto("shop_settings").values({ shop_id: shopId, key: "market_tax_rates", value: JSON.stringify(rates) } as any).execute();
    }

    logApi(db, req.apiUser!.id, shopId, "market_tax_rate_set", "shop", shopId, { tax_rate: taxRate }, req.ip || "").catch(() => {});
    res.json({ tax_rate: taxRate });
  } catch (err: any) { apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' }); }
});

// ===========================================================================
// MARKETS — Full Market Management (G.1 — Shopify Markets equivalent)
// ===========================================================================

import { listMarkets, getMarket, createMarket, updateMarket, deleteMarket, resolveMarketPrice, detectCountryFromRequest } from "@gbox/core/modules/markets/service.js";

// GET /api/store/:slug/markets — list all markets
app.get("/api/store/:slug/markets", storeAccess, async (req: Request, res: Response) => {
  try {
    const markets = await listMarkets(db, req.apiStore!.id);
    res.json({ markets });
  } catch (err: any) { apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' }); }
});

// GET /api/store/:slug/markets/:marketId — get single market
app.get("/api/store/:slug/markets/:marketId", storeAccess, async (req: Request, res: Response) => {
  try {
    const market = await getMarket(db, req.apiStore!.id, req.params.marketId);
    if (!market) { res.status(404).json({ error: "Market not found" }); return; }
    res.json({ market });
  } catch (err: any) { apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' }); }
});

// POST /api/store/:slug/markets — create a market
app.post("/api/store/:slug/markets", storeAccess, async (req: Request, res: Response) => {
  try {
    const { name, countries, currency, price_adjustment, domain, languages, duties_enabled, primary } = req.body;
    if (!name || !countries || !currency) {
      res.status(400).json({ error: "name, countries, and currency are required" }); return;
    }
    const market = await createMarket(db, req.apiStore!.id, { name, countries, currency, price_adjustment, domain, languages, duties_enabled, primary });
    logApi(db, req.apiUser!.id, req.apiStore!.id, "market_create", "market", market.id, { name }, req.ip || "").catch(() => {});
    res.status(201).json({ market });
  } catch (err: any) { apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' }); }
});

// PUT /api/store/:slug/markets/:marketId — update a market
app.put("/api/store/:slug/markets/:marketId", storeAccess, async (req: Request, res: Response) => {
  try {
    const market = await updateMarket(db, req.apiStore!.id, req.params.marketId, req.body);
    if (!market) { res.status(404).json({ error: "Market not found" }); return; }
    logApi(db, req.apiUser!.id, req.apiStore!.id, "market_update", "market", market.id, {}, req.ip || "").catch(() => {});
    res.json({ market });
  } catch (err: any) { apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' }); }
});

// DELETE /api/store/:slug/markets/:marketId — delete a market
app.delete("/api/store/:slug/markets/:marketId", storeAccess, async (req: Request, res: Response) => {
  try {
    const ok = await deleteMarket(db, req.apiStore!.id, req.params.marketId);
    if (!ok) { res.status(404).json({ error: "Market not found" }); return; }
    logApi(db, req.apiUser!.id, req.apiStore!.id, "market_delete", "market", req.params.marketId, {}, req.ip || "").catch(() => {});
    res.json({ deleted: true });
  } catch (err: any) { apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' }); }
});

// GET /api/store/:slug/markets/resolve-price — resolve price for buyer's country
app.get("/api/store/:slug/markets/resolve-price", storeAccess, async (req: Request, res: Response) => {
  try {
    const { price, currency: baseCurrency } = req.query as { price?: string; currency?: string };
    const country = (req.query.country as string) || detectCountryFromRequest(req) || 'US';
    if (!price) { res.status(400).json({ error: "price query param is required" }); return; }
    const result = await resolveMarketPrice(db, req.apiStore!.id, Math.round(parseFloat(price) * 100), baseCurrency || req.apiStore!.currency || 'USD', country);
    res.json({ ...result, price: (result.price / 100).toFixed(2) });
  } catch (err: any) { apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' }); }
});

// ===========================================================================
// GIFT CARDS (6 endpoints)
// ===========================================================================

import {
  createGiftCard, getGiftCard, redeemGiftCard, getGiftCardBalance,
  disableGiftCard, listGiftCards,
} from "@gbox/core/modules/gift-cards/service.js";

app.get("/api/store/:slug/gift-cards", storeAccess, async (req: Request, res: Response) => {
  try {
    const store = req.apiStore!;
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const perPage = Math.min(100, Math.max(1, parseInt(req.query.per_page as string) || 25));
    const result = await listGiftCards(db, store.id, { limit: perPage, offset: (page - 1) * perPage });
    res.json({ gift_cards: result.giftCards, total: result.total, page, per_page: perPage });
  } catch (err: any) { apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' }); }
});

app.post("/api/store/:slug/gift-cards", storeAccess, validate(schemas.createGiftCard), async (req: Request, res: Response) => {
  try {
    const store = req.apiStore!;
    const { initial_value, code, currency, customer_id, note, expires_at } = req.body;
    const giftCard = await createGiftCard(db, store.id, {
      initialValue: initial_value, code, currency, customer_id, note, expiresAt: expires_at,
    });
    res.status(201).json({ gift_card: giftCard });
  } catch (err: any) { apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' }); }
});

app.get("/api/store/:slug/gift-cards/lookup", storeAccess, async (req: Request, res: Response) => {
  try {
    const code = req.query.code as string;
    if (!code) { res.status(400).json({ error: "code query parameter is required" }); return; }
    const giftCard = await getGiftCard(db, code);
    if (!giftCard || (giftCard as any).shop_id !== req.apiStore!.id) { res.status(404).json({ error: "Gift card not found or expired" }); return; }
    res.json({ gift_card: giftCard });
  } catch (err: any) { apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' }); }
});

app.get("/api/store/:slug/gift-cards/:code/balance", storeAccess, async (req: Request, res: Response) => {
  try {
    // Verify gift card belongs to this store
    const gc = await db.selectFrom("gift_cards" as any).select("shop_id").where("code_hash", "=", req.params.code).executeTakeFirst();
    if (!gc || (gc as any).shop_id !== req.apiStore!.id) { res.status(404).json({ error: "Gift card not found" }); return; }
    const balance = await getGiftCardBalance(db, req.params.code);
    if (balance === null) { res.status(404).json({ error: "Gift card not found, expired, or disabled" }); return; }
    res.json({ balance, code: req.params.code });
  } catch (err: any) { apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' }); }
});

app.post("/api/store/:slug/gift-cards/:code/redeem", storeAccess, async (req: Request, res: Response) => {
  try {
    // Verify gift card belongs to this store
    const gc = await db.selectFrom("gift_cards" as any).select("shop_id").where("code_hash", "=", req.params.code).executeTakeFirst();
    if (!gc || (gc as any).shop_id !== req.apiStore!.id) { res.status(404).json({ error: "Gift card not found" }); return; }
    const { amount, order_id } = req.body;
    if (!amount) { res.status(400).json({ error: "amount is required" }); return; }
    const updated = await redeemGiftCard(db, req.params.code, amount, order_id);
    res.json({ gift_card: updated });
  } catch (err: any) {
    if (err.message?.includes("Insufficient") || err.message?.includes("not found") || err.message?.includes("expired")) {
      res.status(400).json({ error: err.message }); return;
    }
    apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' });
  }
});

app.post("/api/store/:slug/gift-cards/:giftCardId/disable", storeAccess, async (req: Request, res: Response) => {
  try {
    const existing = await db.selectFrom("gift_cards" as any).select("shop_id").where("id", "=", req.params.giftCardId).executeTakeFirst();
    if (!existing || (existing as any).shop_id !== req.apiStore!.id) { res.status(404).json({ error: "Gift card not found" }); return; }
    await disableGiftCard(db, req.params.giftCardId);
    res.json({ success: true });
  } catch (err: any) { apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' }); }
});

// ===========================================================================
// LOCATIONS & INVENTORY (9 endpoints)
// ===========================================================================

import {
  createLocation, getLocation, updateLocation, deleteLocation, listLocations,
  getInventoryLevels, setInventoryLevel, adjustInventory, transferInventory,
} from "@gbox/core/modules/locations/service.js";

app.get("/api/store/:slug/locations", storeAccess, async (req: Request, res: Response) => {
  try {
    const store = req.apiStore!;
    const locations = await listLocations(db, store.id);
    res.json({ locations });
  } catch (err: any) { apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' }); }
});

app.get("/api/store/:slug/locations/:locationId", storeAccess, async (req: Request, res: Response) => {
  try {
    const location = await getLocation(db, req.params.locationId);
    if (!location || (location as any).shop_id !== req.apiStore!.id) { res.status(404).json({ error: "Location not found" }); return; }
    res.json({ location });
  } catch (err: any) { apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' }); }
});

app.post("/api/store/:slug/locations", storeAccess, async (req: Request, res: Response) => {
  try {
    const store = req.apiStore!;
    const { name, address, city, province, country, zip, phone, is_primary, active } = req.body;
    if (!name) { res.status(400).json({ error: "name is required" }); return; }
    const location = await createLocation(db, store.id, { name, address, city, province, country, zip, phone, is_primary, active });
    res.status(201).json({ location });
  } catch (err: any) { apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' }); }
});

app.put("/api/store/:slug/locations/:locationId", storeAccess, async (req: Request, res: Response) => {
  try {
    const existing = await db.selectFrom("locations" as any).select("shop_id").where("id", "=", req.params.locationId).executeTakeFirst();
    if (!existing || (existing as any).shop_id !== req.apiStore!.id) { res.status(404).json({ error: "Location not found" }); return; }
    const location = await updateLocation(db, req.params.locationId, req.body);
    res.json({ location });
  } catch (err: any) { apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' }); }
});

app.delete("/api/store/:slug/locations/:locationId", storeAccess, async (req: Request, res: Response) => {
  try {
    const existing = await db.selectFrom("locations" as any).select("shop_id").where("id", "=", req.params.locationId).executeTakeFirst();
    if (!existing || (existing as any).shop_id !== req.apiStore!.id) { res.status(404).json({ error: "Location not found" }); return; }
    await deleteLocation(db, req.params.locationId);
    res.json({ success: true });
  } catch (err: any) {
    if (err.message?.includes("Cannot delete")) { res.status(400).json({ error: err.message }); return; }
    apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' });
  }
});

app.get("/api/store/:slug/locations/:locationId/inventory", storeAccess, async (req: Request, res: Response) => {
  try {
    const existing = await db.selectFrom("locations" as any).select("shop_id").where("id", "=", req.params.locationId).executeTakeFirst();
    if (!existing || (existing as any).shop_id !== req.apiStore!.id) { res.status(404).json({ error: "Location not found" }); return; }
    const levels = await getInventoryLevels(db, req.params.locationId);
    res.json({ inventory_levels: levels });
  } catch (err: any) { apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' }); }
});

app.put("/api/store/:slug/inventory/:inventoryItemId/:locationId", storeAccess, async (req: Request, res: Response) => {
  try {
    const { quantity } = req.body;
    if (quantity === undefined) { res.status(400).json({ error: "quantity is required" }); return; }
    const level = await setInventoryLevel(db, req.params.inventoryItemId, req.params.locationId, quantity);
    res.json({ inventory_level: level });
  } catch (err: any) { apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' }); }
});

app.post("/api/store/:slug/inventory/adjust", storeAccess, async (req: Request, res: Response) => {
  try {
    const { inventory_item_id, location_id, adjustment } = req.body;
    if (!inventory_item_id || !location_id || adjustment === undefined) {
      res.status(400).json({ error: "inventory_item_id, location_id, and adjustment are required" }); return;
    }
    const level = await adjustInventory(db, inventory_item_id, location_id, adjustment);
    res.json({ inventory_level: level });
  } catch (err: any) {
    if (err.message?.includes("Insufficient")) { res.status(400).json({ error: err.message }); return; }
    apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' });
  }
});

app.post("/api/store/:slug/inventory/transfer", storeAccess, async (req: Request, res: Response) => {
  try {
    const { inventory_item_id, from_location_id, to_location_id, quantity } = req.body;
    if (!inventory_item_id || !from_location_id || !to_location_id || !quantity) {
      res.status(400).json({ error: "inventory_item_id, from_location_id, to_location_id, and quantity are required" }); return;
    }
    await transferInventory(db, inventory_item_id, from_location_id, to_location_id, quantity);
    res.json({ success: true });
  } catch (err: any) {
    if (err.message?.includes("Insufficient") || err.message?.includes("must be")) { res.status(400).json({ error: err.message }); return; }
    apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' });
  }
});

// ===========================================================================
// METAFIELDS (4 endpoints)
// ===========================================================================

import {
  setMetafield,
  getMetafield,
  listMetafields,
  deleteMetafield,
  getMetafieldById,
  updateMetafieldById,
  deleteMetafieldById,
  OWNER_TYPES,
  type MetafieldOwnerType,
} from "@gbox/core/modules/metafields/service.js";

app.get("/api/store/:slug/metafields", storeAccess, async (req: Request, res: Response) => {
  try {
    const store = req.apiStore!;
    const ownerType = (req.query.owner_type as string) || "shop";
    const ownerId = (req.query.owner_id as string) || store.id;
    const namespace = req.query.namespace as string | undefined;
    const metafields = await listMetafields(db, store.id, ownerType as any, ownerId, namespace);
    res.json({ metafields });
  } catch (err: any) { apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' }); }
});

app.post("/api/store/:slug/metafields", storeAccess, async (req: Request, res: Response) => {
  try {
    const store = req.apiStore!;
    const { owner_type, owner_id, namespace, key, value, value_type, description } = req.body;
    if (!namespace || !key) { res.status(400).json({ error: "namespace and key are required" }); return; }
    const metafield = await setMetafield(db, {
      shop_id: store.id, owner_type: owner_type || "shop", owner_id: owner_id || store.id,
      namespace, key, value, value_type, description,
    });
    res.status(201).json({ metafield });
  } catch (err: any) {
    if (err.message?.includes("Invalid metafield")) { res.status(400).json({ error: err.message }); return; }
    apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' });
  }
});

app.get("/api/store/:slug/metafields/:ownerType/:ownerId/:namespace/:key", storeAccess, async (req: Request, res: Response) => {
  try {
    const store = req.apiStore!;
    const metafield = await getMetafield(db, {
      shop_id: store.id, owner_type: req.params.ownerType as any,
      owner_id: req.params.ownerId, namespace: req.params.namespace, key: req.params.key,
    });
    if (!metafield) { res.status(404).json({ error: "Metafield not found" }); return; }
    res.json({ metafield });
  } catch (err: any) { apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' }); }
});

app.delete("/api/store/:slug/metafields/:ownerType/:ownerId/:namespace/:key", storeAccess, async (req: Request, res: Response) => {
  try {
    const store = req.apiStore!;
    const deleted = await deleteMetafield(db, {
      shop_id: store.id, owner_type: req.params.ownerType as any,
      owner_id: req.params.ownerId, namespace: req.params.namespace, key: req.params.key,
    });
    if (!deleted) { res.status(404).json({ error: "Metafield not found" }); return; }
    res.json({ success: true });
  } catch (err: any) { apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' }); }
});

// ===========================================================================
// WEBHOOKS CRUD (5 endpoints)
// ===========================================================================

import {
  registerWebhook, deleteWebhook as deleteWebhookById, listWebhooks,
  getWebhook as getWebhookById, retryDelivery, triggerWebhook,
} from "@gbox/core/modules/webhooks/service.js";

app.get("/api/store/:slug/webhooks", storeAccess, async (req: Request, res: Response) => {
  try {
    const store = req.apiStore!;
    const webhooks = await listWebhooks(db, store.id);
    res.json({ webhooks });
  } catch (err: any) { apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' }); }
});

app.get("/api/store/:slug/webhooks/:webhookId", storeAccess, async (req: Request, res: Response) => {
  try {
    const webhook = await getWebhookById(db, req.params.webhookId);
    if (!webhook || (webhook as any).shop_id !== req.apiStore!.id) { res.status(404).json({ error: "Webhook not found" }); return; }
    res.json({ webhook });
  } catch (err: any) { apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' }); }
});

app.post("/api/store/:slug/webhooks", storeAccess, async (req: Request, res: Response) => {
  try {
    const store = req.apiStore!;
    const { topic, address, format } = req.body;
    if (!topic || !address) { res.status(400).json({ error: "topic and address are required" }); return; }
    const webhook = await registerWebhook(db, store.id, topic, address, format);
    res.status(201).json({ webhook });
  } catch (err: any) {
    if (err.message?.includes("Unsupported") || err.message?.includes("already registered")) {
      res.status(400).json({ error: err.message }); return;
    }
    apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete("/api/store/:slug/webhooks/:webhookId", storeAccess, async (req: Request, res: Response) => {
  try {
    const existing = await db.selectFrom("webhooks" as any).select("shop_id").where("id", "=", req.params.webhookId).executeTakeFirst();
    if (!existing || (existing as any).shop_id !== req.apiStore!.id) { res.status(404).json({ error: "Webhook not found" }); return; }
    await deleteWebhookById(db, req.params.webhookId);
    res.json({ success: true });
  } catch (err: any) { apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' }); }
});

app.post("/api/store/:slug/webhooks/deliveries/:deliveryId/retry", storeAccess, async (req: Request, res: Response) => {
  try {
    await retryDelivery(db, req.params.deliveryId);
    res.json({ success: true });
  } catch (err: any) {
    if (err.message?.includes("not found")) { res.status(404).json({ error: err.message }); return; }
    apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' });
  }
});

// ===========================================================================
// SHIPPING ZONES & RATES (8 endpoints)
// ===========================================================================

import {
  getShippingZones as listShippingZones, getShippingZone, createShippingZone,
  updateShippingZone, deleteShippingZone, addShippingRate, updateShippingRate,
  deleteShippingRate,
} from "@gbox/core/modules/shipping/service.js";

app.get("/api/store/:slug/shipping-zones", storeAccess, async (req: Request, res: Response) => {
  try {
    const store = req.apiStore!;
    const zones = await listShippingZones(db, store.id);
    res.json({ shipping_zones: zones });
  } catch (err: any) { apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' }); }
});

app.get("/api/store/:slug/shipping-zones/:zoneId", storeAccess, async (req: Request, res: Response) => {
  try {
    const zone = await getShippingZone(db, req.params.zoneId);
    if (!zone) { res.status(404).json({ error: "Shipping zone not found" }); return; }
    res.json({ shipping_zone: zone });
  } catch (err: any) { apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' }); }
});

app.post("/api/store/:slug/shipping-zones", storeAccess, async (req: Request, res: Response) => {
  try {
    const store = req.apiStore!;
    const { name, countries } = req.body;
    if (!name || !countries?.length) { res.status(400).json({ error: "name and countries are required" }); return; }
    const zone = await createShippingZone(db, store.id, { name, countries });
    res.status(201).json({ shipping_zone: zone });
  } catch (err: any) { apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' }); }
});

app.put("/api/store/:slug/shipping-zones/:zoneId", storeAccess, async (req: Request, res: Response) => {
  try {
    const zone = await updateShippingZone(db, req.params.zoneId, req.body);
    res.json({ shipping_zone: zone });
  } catch (err: any) { apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' }); }
});

app.delete("/api/store/:slug/shipping-zones/:zoneId", storeAccess, async (req: Request, res: Response) => {
  try {
    await deleteShippingZone(db, req.params.zoneId);
    res.json({ success: true });
  } catch (err: any) { apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' }); }
});

app.post("/api/store/:slug/shipping-zones/:zoneId/rates", storeAccess, async (req: Request, res: Response) => {
  try {
    const { name, price, type, min_value, max_value } = req.body;
    if (!name || !price || !type) { res.status(400).json({ error: "name, price, and type are required" }); return; }
    const rate = await addShippingRate(db, req.params.zoneId, { name, price, type, min_value, max_value });
    res.status(201).json({ shipping_rate: rate });
  } catch (err: any) {
    if (err.message?.includes("not found")) { res.status(404).json({ error: err.message }); return; }
    apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' });
  }
});

app.put("/api/store/:slug/shipping-zones/:zoneId/rates/:rateId", storeAccess, async (req: Request, res: Response) => {
  try {
    const rate = await updateShippingRate(db, req.params.rateId, req.body);
    res.json({ shipping_rate: rate });
  } catch (err: any) { apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' }); }
});

app.delete("/api/store/:slug/shipping-zones/:zoneId/rates/:rateId", storeAccess, async (req: Request, res: Response) => {
  try {
    await deleteShippingRate(db, req.params.rateId);
    res.json({ success: true });
  } catch (err: any) { apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' }); }
});

// ===========================================================================
// WISHLIST (5 endpoints — customer-facing)
// ===========================================================================

import {
  addToWishlist, removeFromWishlist, getWishlist, isInWishlist,
  getWishlistCount, getPopularWishlistProducts,
} from "@gbox/core/modules/wishlist/service.js";

app.get("/api/store/:slug/wishlist", storeAccess, async (req: Request, res: Response) => {
  try {
    const customerId = req.query.customer_id as string;
    if (!customerId) { res.status(400).json({ error: "customer_id is required" }); return; }
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const perPage = Math.min(100, Math.max(1, parseInt(req.query.per_page as string) || 25));
    const result = await getWishlist(db, customerId, { limit: perPage, offset: (page - 1) * perPage });
    res.json({ wishlist_items: result.items, total: result.total, page, per_page: perPage });
  } catch (err: any) { apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' }); }
});

app.post("/api/store/:slug/wishlist", storeAccess, async (req: Request, res: Response) => {
  try {
    const { customer_id, product_id } = req.body;
    if (!customer_id || !product_id) { res.status(400).json({ error: "customer_id and product_id are required" }); return; }
    const item = await addToWishlist(db, customer_id, product_id);
    res.status(201).json({ wishlist_item: item });
  } catch (err: any) { apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' }); }
});

app.delete("/api/store/:slug/wishlist/:productId", storeAccess, async (req: Request, res: Response) => {
  try {
    const customerId = req.query.customer_id as string;
    if (!customerId) { res.status(400).json({ error: "customer_id is required" }); return; }
    await removeFromWishlist(db, customerId, req.params.productId);
    res.json({ success: true });
  } catch (err: any) { apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' }); }
});

app.get("/api/store/:slug/wishlist/check/:productId", storeAccess, async (req: Request, res: Response) => {
  try {
    const customerId = req.query.customer_id as string;
    if (!customerId) { res.status(400).json({ error: "customer_id is required" }); return; }
    const inWishlist = await isInWishlist(db, customerId, req.params.productId);
    res.json({ in_wishlist: inWishlist });
  } catch (err: any) { apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' }); }
});

app.get("/api/store/:slug/wishlist/popular", storeAccess, async (req: Request, res: Response) => {
  try {
    const store = req.apiStore!;
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 10));
    const popular = await getPopularWishlistProducts(db, store.id, limit);
    res.json({ popular_products: popular });
  } catch (err: any) { apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' }); }
});

// ===========================================================================
// PRODUCT REVIEWS (6 endpoints)
// ===========================================================================

import {
  createReview, getReview, updateReviewStatus, deleteReview,
  getProductReviews, getShopReviews, getReviewStats,
} from "@gbox/core/modules/reviews/service.js";

app.get("/api/store/:slug/reviews", storeAccess, async (req: Request, res: Response) => {
  try {
    const store = req.apiStore!;
    const status = req.query.status as any;
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const perPage = Math.min(100, Math.max(1, parseInt(req.query.per_page as string) || 25));
    const result = await getShopReviews(db, store.id, status, { limit: perPage, offset: (page - 1) * perPage });
    res.json({ reviews: result.reviews, total: result.total, page, per_page: perPage });
  } catch (err: any) { apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' }); }
});

app.get("/api/store/:slug/products/:productId/reviews", async (req: Request, res: Response) => {
  try {
    const status = (req.query.status as any) || "approved";
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const perPage = Math.min(100, Math.max(1, parseInt(req.query.per_page as string) || 20));
    const result = await getProductReviews(db, req.params.productId, status, { limit: perPage, offset: (page - 1) * perPage });
    res.json({ reviews: result.reviews, total: result.total, avg_rating: result.avgRating, page, per_page: perPage });
  } catch (err: any) { apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' }); }
});

app.get("/api/store/:slug/products/:productId/reviews/stats", async (req: Request, res: Response) => {
  try {
    const stats = await getReviewStats(db, req.params.productId);
    res.json({ stats });
  } catch (err: any) { apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' }); }
});

app.post("/api/store/:slug/products/:productId/reviews", strictLimiter, validate(schemas.createReview), async (req: Request, res: Response) => {
  try {
    // Resolve shop_id from the product
    const product = await db.selectFrom("products").select(["id", "shop_id"]).where("id", "=", req.params.productId).executeTakeFirst();
    if (!product) { res.status(404).json({ error: "Product not found" }); return; }
    const { customer_id, author_name, author_email, rating, title, body } = req.body;
    const review = await createReview(db, product.shop_id, req.params.productId, {
      customerId: customer_id, authorName: author_name, authorEmail: author_email,
      rating, title, body,
    });
    res.status(201).json({ review });
  } catch (err: any) {
    if (err.message?.includes("Rating")) { res.status(400).json({ error: err.message }); return; }
    apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' });
  }
});

app.put("/api/store/:slug/reviews/:reviewId", storeAccess, async (req: Request, res: Response) => {
  try {
    const { status } = req.body;
    if (!["pending", "approved", "rejected"].includes(status)) {
      res.status(400).json({ error: "status must be pending, approved, or rejected" }); return;
    }
    const review = await updateReviewStatus(db, req.params.reviewId, status);
    res.json({ review });
  } catch (err: any) { apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' }); }
});

app.delete("/api/store/:slug/reviews/:reviewId", storeAccess, async (req: Request, res: Response) => {
  try {
    await deleteReview(db, req.params.reviewId);
    res.json({ success: true });
  } catch (err: any) { apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' }); }
});

// ===========================================================================
// SEARCH (4 endpoints)
// ===========================================================================

import {
  searchProducts as searchProductsFull, searchOrders as searchOrdersFull,
  searchCustomers as searchCustomersFull, searchAll, buildSearchIndex,
} from "@gbox/core/modules/search/service.js";

app.get("/api/store/:slug/search", async (req: Request, res: Response) => {
  try {
    // Public storefront search — products only
    const shopSlug = req.params.slug;
    const shop = await db.selectFrom("shops").select("id").where("slug", "=", shopSlug).executeTakeFirst();
    if (!shop) { res.status(404).json({ error: "Shop not found" }); return; }
    const q = (req.query.q as string) || "";
    if (!q.trim()) { res.json({ results: [], total: 0 }); return; }
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const perPage = Math.min(50, Math.max(1, parseInt(req.query.per_page as string) || 20));
    const category = req.query.category as string;
    const minPrice = req.query.min_price as string;
    const maxPrice = req.query.max_price as string;
    const inStock = req.query.in_stock === "true";
    const result = await searchProductsFull(db, shop.id, q, { category, min_price: minPrice, max_price: maxPrice, in_stock: inStock || undefined }, { limit: perPage, offset: (page - 1) * perPage });
    res.json({ results: result.results, total: result.total, page, per_page: perPage });
  } catch (err: any) { apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' }); }
});

app.get("/api/store/:slug/admin/search", storeAccess, async (req: Request, res: Response) => {
  try {
    const store = req.apiStore!;
    const q = (req.query.q as string) || "";
    if (!q.trim()) { res.json({ products: [], orders: [], customers: [], pages: [] }); return; }
    const results = await searchAll(db, store.id, q);
    res.json(results);
  } catch (err: any) { apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' }); }
});

app.get("/api/store/:slug/admin/search/orders", storeAccess, async (req: Request, res: Response) => {
  try {
    const store = req.apiStore!;
    const q = (req.query.q as string) || "";
    if (!q.trim()) { res.json({ orders: [] }); return; }
    const orders = await searchOrdersFull(db, store.id, q);
    res.json({ orders });
  } catch (err: any) { apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' }); }
});

app.post("/api/store/:slug/search/reindex", storeAccess, async (req: Request, res: Response) => {
  try {
    const store = req.apiStore!;
    await buildSearchIndex(db, store.id);
    res.json({ success: true, message: "Search indexes rebuilt" });
  } catch (err: any) { apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' }); }
});

// ===========================================================================
// NOTIFICATIONS (5 endpoints)
// ===========================================================================

import {
  createNotification, getNotifications, markAsRead, markAllAsRead,
  deleteNotification, getUnreadCount,
} from "@gbox/core/modules/notifications/service.js";

app.get("/api/store/:slug/notifications", storeAccess, async (req: Request, res: Response) => {
  try {
    const store = req.apiStore!;
    const user = req.apiUser!;
    const unreadOnly = req.query.unread === "true";
    const notifications = await getNotifications(db, store.id, user.id, unreadOnly);
    res.json({ notifications });
  } catch (err: any) { apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' }); }
});

app.get("/api/store/:slug/notifications/unread-count", storeAccess, async (req: Request, res: Response) => {
  try {
    const store = req.apiStore!;
    const user = req.apiUser!;
    const count = await getUnreadCount(db, store.id, user.id);
    res.json({ unread_count: count });
  } catch (err: any) { apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' }); }
});

app.post("/api/store/:slug/notifications/:notificationId/read", storeAccess, async (req: Request, res: Response) => {
  try {
    await markAsRead(db, req.params.notificationId);
    res.json({ success: true });
  } catch (err: any) { apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' }); }
});

app.post("/api/store/:slug/notifications/read-all", storeAccess, async (req: Request, res: Response) => {
  try {
    const store = req.apiStore!;
    const user = req.apiUser!;
    const count = await markAllAsRead(db, store.id, user.id);
    res.json({ success: true, marked_count: count });
  } catch (err: any) { apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' }); }
});

app.delete("/api/store/:slug/notifications/:notificationId", storeAccess, async (req: Request, res: Response) => {
  try {
    await deleteNotification(db, req.params.notificationId);
    res.json({ success: true });
  } catch (err: any) { apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' }); }
});

// ===========================================================================
// CHECKOUT + PAYMENT ENDPOINTS
// ===========================================================================

import { createCheckout, updateCheckoutEmail, updateCheckoutShipping, getShippingRates, selectShippingRate, applyDiscount, removeDiscount, completeCheckout, cancelCheckout, getCheckout } from "@gbox/core/modules/checkout/service.js";
import { issueHandoffToken, HANDOFF_TOKEN_TTL_MS, HandoffTokenError } from "@gbox/core/modules/checkout/handoff.js";
import { validateGiftCardForCheckout } from "@gbox/core/modules/gift-cards/service.js";

// POST /api/store/:slug/checkout — Create checkout session from cart
app.post("/api/store/:slug/checkout", shopFromSlug, checkoutLimiter, idempotent, async (req: Request, res: Response) => {
  try {
    const slug = req.params.slug;
    const shop = await db.selectFrom("shops").select(["id", "name", "slug", "currency"]).where("slug", "=", slug).executeTakeFirst();
    if (!shop) { res.status(404).json({ error: "Not found", message: "Store not found" }); return; }

    const { items, email } = req.body;
    if (!items || !Array.isArray(items) || items.length === 0) {
      res.status(400).json({ error: "Validation error", message: "items array is required" }); return;
    }

    // G.5: Enforce customer account settings
    const accountModeSetting = await db.selectFrom("shop_settings").select("value").where("shop_id", "=", shop.id).where("key", "=", "customer_account_mode").executeTakeFirst();
    const accountMode = accountModeSetting?.value || "optional";
    if (accountMode === "required" && !email) {
      res.status(400).json({ error: "Customer account required", message: "This store requires customers to provide an email to checkout" }); return;
    }
    if (accountMode === "required" && email) {
      const existingCustomer = await db.selectFrom("customers").select("id").where("shop_id", "=", shop.id).where("email", "=", email).executeTakeFirst();
      if (!existingCustomer) {
        res.status(400).json({
          error: "Account required",
          message: "This store requires a customer account. Please create an account first.",
          account_required: true,
        }); return;
      }
    }

    const checkout = await createCheckout(db, shop.id, items, email || null);

    // Optional currency conversion: ?currency=EUR converts all prices
    const targetCurrency = (req.query.currency as string || "").toUpperCase();
    if (targetCurrency && targetCurrency.length === 3) {
      const shopCurrency = shop.currency || "USD";
      if (targetCurrency !== shopCurrency) {
        try {
          const converted = await convert(db, String(checkout.total || checkout.subtotal || "0"), shopCurrency, targetCurrency);
          (checkout as any).presentment_currency = targetCurrency;
          (checkout as any).presentment_total = converted.presentment_money.amount;
          (checkout as any).exchange_rate = converted.rate;
          (checkout as any).shop_currency = shopCurrency;
        } catch { /* rate not available — return in shop currency */ }
      }
    }

    res.status(201).json({ checkout });
  } catch (err: any) {
    apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/checkout/:checkoutId — Read a single checkout session (slug-less)
//
// Returns the Redis-backed checkout record + its owning shop so the
// Gbox-hosted checkout subdomain (apps/checkout, Decision #2) can render
// the 3-step form from the `/c/:checkoutId` URL alone — no slug required
// because the checkoutId is itself a random UUID (knowledge-of-id == auth
// for the buyer flow, same model as Shopify's `/checkouts/:token`).
//
// We deliberately do NOT expose this as `/store/:slug/checkout/:id`
// because the checkout subdomain doesn't know the slug at route time.
app.get(
  "/api/checkout/:checkoutId",
  apiReadLimiter,
  async (req: Request, res: Response) => {
    try {
      const checkout = await getCheckout(req.params.checkoutId);
      if (!checkout) {
        res
          .status(404)
          .json({
            error: "checkout_not_found",
            message: "No checkout session with that id",
          });
        return;
      }

      const shop = await db
        .selectFrom("shops")
        .select(["id", "slug", "name", "currency", "domain"])
        .where("id", "=", checkout.shop_id)
        .executeTakeFirst();
      if (!shop) {
        // Orphaned checkout — shop was deleted between create and fetch.
        // Treat as not-found so we don't leak the orphan state.
        res
          .status(404)
          .json({
            error: "checkout_not_found",
            message: "No checkout session with that id",
          });
        return;
      }

      // Optional currency conversion: ?currency=EUR converts checkout prices
      const targetCurrency = (req.query.currency as string || "").toUpperCase();
      if (targetCurrency && targetCurrency.length === 3) {
        const shopCurrency = (shop.currency || "USD").toUpperCase();
        if (targetCurrency !== shopCurrency) {
          try {
            const converted = await convert(db, String((checkout as any).total || (checkout as any).subtotal || "0"), shopCurrency, targetCurrency);
            (checkout as any).presentment_currency = targetCurrency;
            (checkout as any).presentment_total = converted.presentment_money.amount;
            (checkout as any).exchange_rate = converted.rate;
            (checkout as any).shop_currency = shopCurrency;
          } catch { /* rate not available — return in shop currency */ }
        }
      }

      res.json({
        checkout,
        shop: {
          id: shop.id,
          slug: shop.slug,
          name: shop.name,
          currency: shop.currency,
          domain: shop.domain,
        },
      });
    } catch (err: any) {
      apiLogger.error({ err }, 'Checkout GET failed');
      res
        .status(500)
        .json({ error: "Internal server error" });
    }
  },
);

// GET /api/checkout/:checkoutId/order — slug-less order lookup for the
// buyer's thank-you page.
//
// Auth model: knowledge of the checkoutId IS the auth token (same model
// as `/api/checkout/:id`). We resolve checkoutId → order_id via the
// Redis-backed checkout session, which remains alive for the session
// TTL (~1 hour) after completion and is the only piece of state that
// binds the buyer to a specific order without requiring a merchant login.
//
// Returns 409 if the checkout exists but hasn't been paid yet.
// Returns 410 if the checkout session has expired — the buyer should
// check their email for the confirmation instead.
app.get(
  "/api/checkout/:checkoutId/order",
  apiReadLimiter,
  async (req: Request, res: Response) => {
    try {
      const checkout = await getCheckout(req.params.checkoutId);
      if (!checkout) {
        res
          .status(410)
          .json({
            error: "checkout_expired",
            message:
              "This checkout session has expired. Please check your email for the order confirmation.",
          });
        return;
      }
      if (!checkout.completed_at || !checkout.order_id) {
        res
          .status(409)
          .json({
            error: "checkout_not_completed",
            message: "This checkout has not been paid for yet.",
          });
        return;
      }

      const [order, lineItems, shop] = await Promise.all([
        db
          .selectFrom("orders")
          .selectAll()
          .where("id", "=", checkout.order_id)
          .where("shop_id", "=", checkout.shop_id)
          .executeTakeFirst(),
        db
          .selectFrom("order_line_items")
          .selectAll()
          .where("order_id", "=", checkout.order_id)
          .execute(),
        db
          .selectFrom("shops")
          .select(["id", "slug", "name", "currency", "domain", "email"])
          .where("id", "=", checkout.shop_id)
          .executeTakeFirst(),
      ]);

      if (!order || !shop) {
        // Inconsistent state — order was finalized but the row isn't
        // readable. Log loudly and tell the buyer to check their email.
        apiLogger.error(
          {
            checkout_id: req.params.checkoutId,
            order_id: checkout.order_id,
            shop_id: checkout.shop_id,
          },
          "[checkout] slug-less order lookup: order or shop missing",
        );
        res
          .status(500)
          .json({
            error: "order_lookup_failed",
            message:
              "We couldn\u2019t load your order details. Please check your email — the confirmation has been sent.",
          });
        return;
      }

      res.json({
        order,
        line_items: lineItems,
        shop: {
          id: shop.id,
          slug: shop.slug,
          name: shop.name,
          currency: shop.currency,
          domain: shop.domain,
          email: shop.email,
        },
      });
    } catch (err: any) {
      apiLogger.error(
        { err: err?.message, checkout_id: req.params.checkoutId },
        "[checkout] slug-less order lookup failed",
      );
      res
        .status(500)
        .json({ error: "internal" });
    }
  },
);

// POST /api/checkout/:checkoutId/paypal/create — slug-less PayPal order create
//
// Thin wrapper around the shop-scoped create endpoint for apps/checkout
// (Decision #2). The buyer's browser doesn't know the shop slug at this
// URL — we pull it from the checkout session. Everything else (items,
// totals, shipping address) is hydrated from the checkout so the browser
// never constructs order data itself.
app.post(
  "/api/checkout/:checkoutId/paypal/create",
  paymentLimiter,
  async (req: Request, res: Response) => {
    try {
      const checkout = await getCheckout(req.params.checkoutId);
      if (!checkout) {
        res
          .status(404)
          .json({ error: "checkout_not_found", message: "No checkout with that id" });
        return;
      }
      if ((checkout as any).completed_at) {
        res
          .status(409)
          .json({ error: "checkout_completed", message: "Checkout already completed" });
        return;
      }
      const shop = await db
        .selectFrom("shops")
        .select(["id", "name", "currency"])
        .where("id", "=", checkout.shop_id)
        .executeTakeFirst();
      if (!shop) {
        res.status(404).json({ error: "shop_not_found" });
        return;
      }

      const paymentMethod: "paypal" | "venmo" =
        req.body?.payment_method === "venmo" ? "venmo" : "paypal";

      const addr = checkout.shipping_address;
      const shippingAddress = addr && addr.address1 && addr.city && addr.zip && (addr.country_code || addr.country)
        ? {
            fullName: [addr.first_name, addr.last_name].filter(Boolean).join(" ") || "Customer",
            address1: addr.address1,
            address2: addr.address2 ?? undefined,
            city: addr.city,
            province: addr.province ?? undefined,
            zip: addr.zip,
            countryCode: (addr.country_code || addr.country || "US").toUpperCase(),
          }
        : undefined;

      const checkoutBase =
        process.env.CHECKOUT_BASE_URL ?? "https://checkout.gbox.co";
      const returnUrl = `${checkoutBase}/c/${encodeURIComponent(checkout.id)}/paypal-return`;
      const cancelUrl = `${checkoutBase}/c/${encodeURIComponent(checkout.id)}?cancelled=1`;

      const result = await createPayPalPartnerOrder(db, shop.id, {
        orderId: checkout.id,
        orderNumber: checkout.id.slice(-8).toUpperCase(),
        currency: checkout.currency || shop.currency || "USD",
        items: checkout.line_items.map((li: any) => ({
          name: li.title || "Item",
          sku: li.sku ?? undefined,
          quantity: li.quantity,
          price: parseFloat(li.price),
          requiresShipping: !!li.requires_shipping,
        })),
        subtotal: parseFloat(checkout.subtotal_price || "0"),
        shippingTotal: parseFloat(checkout.total_shipping || "0"),
        taxTotal: parseFloat(checkout.total_tax || "0"),
        discountTotal: parseFloat(checkout.total_discounts || "0"),
        total: parseFloat(checkout.total_price || "0"),
        shippingAddress,
        returnUrl,
        cancelUrl,
        shopName: shop.name,
        paymentMethod,
      });

      res.status(201).json({
        paypal_order: {
          id: result.paypalOrderId,
          approval_url: result.approvalUrl,
        },
      });
    } catch (err: any) {
      apiLogger.error(
        { err: err?.message, checkout_id: req.params.checkoutId },
        "[paypal-partner] slug-less create order failed",
      );
      res
        .status(500)
        .json({ error: "paypal_error" });
    }
  },
);

// POST /api/checkout/:checkoutId/paypal/capture — slug-less PayPal capture
//
// Captures the PayPal order and finalizes the checkout → order. Returns
// the Gbox order id so apps/checkout can 302 to /c/:id/thankyou.
app.post(
  "/api/checkout/:checkoutId/paypal/capture",
  paymentLimiter,
  async (req: Request, res: Response) => {
    try {
      const { paypal_order_id } = req.body ?? {};
      if (!paypal_order_id) {
        res.status(400).json({ error: "missing_paypal_order_id" });
        return;
      }
      const checkout = await getCheckout(req.params.checkoutId);
      if (!checkout) {
        res.status(404).json({ error: "checkout_not_found" });
        return;
      }

      const capture = await capturePayPalPartnerOrder(paypal_order_id);
      let orderId: string | null = null;
      if (capture.status === "COMPLETED") {
        try {
          const session = await completeCheckout(db, req.params.checkoutId, {
            gateway: "paypal",
            gateway_transaction_id: capture.captureId,
          });
          orderId = session.order_id ?? null;

          // Send order confirmation email (fire-and-forget)
          if (process.env.SMTP_HOST && session.order_id && session.email) {
            const fullOrder = await db.selectFrom("orders").selectAll().where("id", "=", session.order_id).executeTakeFirst();
            if (fullOrder) {
              const lineItems = await db.selectFrom("order_line_items").selectAll().where("order_id", "=", session.order_id).execute();
              const orderData = {
                id: fullOrder.id, order_number: Number(fullOrder.order_number), email: session.email,
                currency: session.currency, subtotal_price: session.subtotal_price,
                total_shipping: session.total_shipping, total_tax: session.total_tax,
                total_discounts: session.total_discounts, total_price: session.total_price,
                line_items: lineItems.map((li: any) => ({ title: li.title || "", variant_title: li.variant_title, quantity: li.quantity, price: String(li.price) })),
                shipping_address: fullOrder.shipping_address as any, billing_address: fullOrder.billing_address as any,
                created_at: String(fullOrder.created_at),
              };
              sendOrderConfirmation(db, checkout.shop_id, orderData).catch((err: any) => apiLogger.error({ err: err.message }, '[email] order confirmation failed'));
              // PR2 commit 13 — merchant heads-up; ops category, forced-send.
              sendNewOrderReceived(db, checkout.shop_id, orderData).catch((err: any) => apiLogger.error({ err: err.message }, '[email] new order received failed'));
            }
          }

          logApi(
            db,
            null,
            checkout.shop_id,
            "paypal_partner_capture",
            "order",
            orderId,
            { paypal_order_id, capture_id: capture.captureId },
            null,
          ).catch(() => {});
        } catch (finalizeErr: any) {
          apiLogger.error(
            {
              err: finalizeErr?.message,
              checkout_id: req.params.checkoutId,
              paypal_order_id,
            },
            "[paypal-partner] slug-less checkout finalization failed after capture",
          );
          res.status(202).json({
            paypal_capture: capture,
            order_id: null,
            warning: "payment_captured_finalize_pending",
          });
          return;
        }
      }
      res.json({ paypal_capture: capture, order_id: orderId });
    } catch (err: any) {
      const msg = err?.message ?? "";
      if (msg.includes("INSTRUMENT_DECLINED")) {
        res
          .status(422)
          .json({
            error: "instrument_declined",
            message:
              "Payment method declined. Please try another payment method.",
          });
        return;
      }
      apiLogger.error(
        { err: msg, checkout_id: req.params.checkoutId },
        "[paypal-partner] slug-less capture failed",
      );
      res.status(500).json({ error: "paypal_error", message: msg });
    }
  },
);

// --- Checkout ownership helper ---
async function verifyCheckoutOwnership(checkoutId: string, slug: string): Promise<{ valid: boolean; shopId?: string }> {
  const shop = await db.selectFrom("shops").select("id").where("slug", "=", slug).executeTakeFirst();
  if (!shop) return { valid: false };
  const checkout = await getCheckout(checkoutId);
  if (!checkout || checkout.shop_id !== shop.id) return { valid: false };
  return { valid: true, shopId: shop.id };
}

// PUT /api/store/:slug/checkout/:checkoutId/email — Set customer email
app.put("/api/store/:slug/checkout/:checkoutId/email", checkoutLimiter, async (req: Request, res: Response) => {
  try {
    const ownership = await verifyCheckoutOwnership(req.params.checkoutId, req.params.slug);
    if (!ownership.valid) { res.status(404).json({ error: "Checkout not found" }); return; }
    const { email } = req.body;
    if (!email) { res.status(400).json({ error: "Validation error", message: "email is required" }); return; }
    const checkout = await updateCheckoutEmail(req.params.checkoutId, email);
    res.json({ checkout });
  } catch (err: any) {
    { const status = err.message?.includes("not found") ? 404 : 500; apiLogger.error({ err }, 'Checkout error'); res.status(status).json({ error: status === 404 ? "Not found" : "Internal server error" }); }
  }
});

// PUT /api/store/:slug/checkout/:checkoutId/shipping — Set shipping address
app.put("/api/store/:slug/checkout/:checkoutId/shipping", checkoutLimiter, async (req: Request, res: Response) => {
  try {
    const ownership = await verifyCheckoutOwnership(req.params.checkoutId, req.params.slug);
    if (!ownership.valid) { res.status(404).json({ error: "Checkout not found" }); return; }
    const checkout = await updateCheckoutShipping(req.params.checkoutId, req.body);
    res.json({ checkout });
  } catch (err: any) {
    { const status = err.message?.includes("not found") ? 404 : 500; apiLogger.error({ err }, 'Checkout error'); res.status(status).json({ error: status === 404 ? "Not found" : "Internal server error" }); }
  }
});

// GET /api/store/:slug/checkout/:checkoutId/shipping-rates — Get available shipping rates
app.get("/api/store/:slug/checkout/:checkoutId/shipping-rates", checkoutLimiter, async (req: Request, res: Response) => {
  try {
    const ownership = await verifyCheckoutOwnership(req.params.checkoutId, req.params.slug);
    if (!ownership.valid) { res.status(404).json({ error: "Checkout not found" }); return; }
    const rates = await getShippingRates(db, req.params.checkoutId);
    res.json({ shipping_rates: rates });
  } catch (err: any) {
    { const status = err.message?.includes("not found") ? 404 : 500; apiLogger.error({ err }, 'Checkout error'); res.status(status).json({ error: status === 404 ? "Not found" : "Internal server error" }); }
  }
});

// PUT /api/store/:slug/checkout/:checkoutId/shipping-rate — Select shipping rate
app.put("/api/store/:slug/checkout/:checkoutId/shipping-rate", checkoutLimiter, async (req: Request, res: Response) => {
  try {
    const ownership = await verifyCheckoutOwnership(req.params.checkoutId, req.params.slug);
    if (!ownership.valid) { res.status(404).json({ error: "Checkout not found" }); return; }
    const { rate_id, name, price, type } = req.body;
    if (!rate_id) { res.status(400).json({ error: "rate_id is required" }); return; }

    const checkout = await selectShippingRate(req.params.checkoutId, {
      id: rate_id, name: name || "Standard", price: price || "0.00", type: type || "flat",
    });
    res.json({ checkout });
  } catch (err: any) {
    { const status = err.message?.includes("not found") ? 404 : 500; apiLogger.error({ err }, 'Checkout error'); res.status(status).json({ error: status === 404 ? "Not found" : "Internal server error" }); }
  }
});

// POST /api/store/:slug/checkout/:checkoutId/discount — Apply discount code
app.post("/api/store/:slug/checkout/:checkoutId/discount", checkoutLimiter, async (req: Request, res: Response) => {
  try {
    const ownership = await verifyCheckoutOwnership(req.params.checkoutId, req.params.slug);
    if (!ownership.valid) { res.status(404).json({ error: "Checkout not found" }); return; }
    const { code } = req.body;
    if (!code) { res.status(400).json({ error: "Discount code is required", message: "Please enter a discount code." }); return; }

    const checkout = await applyDiscount(db, req.params.checkoutId, code);
    res.json({ checkout });
  } catch (err: any) {
    // Phase 5 PR1 — surface the human-readable validation message to
    // the buyer (once_per_customer, expired, min-purchase, etc.). The
    // service crafts `.message` strings that are safe to render in the
    // DOM; we pass them through so the checkout app can paint them
    // under the code input.
    const rawMessage = typeof err?.message === 'string' ? err.message : 'Could not apply discount.';
    const status = rawMessage.toLowerCase().includes("not found") ? 404 : 400;
    apiLogger.error({ err }, 'Checkout error');
    res.status(status).json({
      error: status === 404 ? "Not found" : "discount_rejected",
      message: rawMessage,
    });
  }
});

// DELETE /api/store/:slug/checkout/:checkoutId/discount — Remove discount
app.delete("/api/store/:slug/checkout/:checkoutId/discount", checkoutLimiter, async (req: Request, res: Response) => {
  try {
    const ownership = await verifyCheckoutOwnership(req.params.checkoutId, req.params.slug);
    if (!ownership.valid) { res.status(404).json({ error: "Checkout not found" }); return; }
    const checkout = await removeDiscount(req.params.checkoutId);
    res.json({ checkout });
  } catch (err: any) {
    { const status = err.message?.includes("not found") ? 404 : 500; apiLogger.error({ err }, 'Checkout error'); res.status(status).json({ error: status === 404 ? "Not found" : "Internal server error" }); }
  }
});

// POST /api/store/:slug/checkout/:checkoutId/gift-card — Phase 10 PR2
// Validate a gift card code against the current checkout. Read-only —
// does NOT decrement the balance. The actual redemption will fire at
// checkout completion once the orders module wires it in.
//
// Response shape mirrors `validateGiftCardForCheckout` — `{ ok: true,
// giftCard, applicable }` on success, `{ ok: false, reason, message }`
// on failure. HTTP status is always 200 so the storefront can render a
// friendly inline message without a fetch-error fallback.
app.post("/api/store/:slug/checkout/:checkoutId/gift-card", checkoutLimiter, async (req: Request, res: Response) => {
  try {
    const ownership = await verifyCheckoutOwnership(req.params.checkoutId, req.params.slug);
    if (!ownership.valid) { res.status(404).json({ ok: false, reason: 'not_found', message: 'Checkout not found.' }); return; }
    const code = String(req.body?.code ?? '').trim();
    if (!code) {
      res.status(400).json({ ok: false, reason: 'invalid_code', message: 'Please enter a gift card code.' });
      return;
    }
    const checkout = await getCheckout(req.params.checkoutId);
    if (!checkout) { res.status(404).json({ ok: false, reason: 'not_found', message: 'Checkout not found.' }); return; }

    const result = await validateGiftCardForCheckout(
      db,
      ownership.shopId!,
      code,
      (checkout as any).total_price ?? (checkout as any).subtotal_price ?? '0',
      (checkout as any).currency ?? null,
    );
    res.json(result);
  } catch (err: any) {
    apiLogger.error({ err }, 'Gift card validation error');
    res.status(500).json({ ok: false, reason: 'server_error', message: 'Please try again.' });
  }
});

// POST /api/store/:slug/checkout/:checkoutId/complete — Complete checkout (create order + transaction)
app.post("/api/store/:slug/checkout/:checkoutId/complete", shopFromSlug, checkoutLimiter, idempotent, async (req: Request, res: Response) => {
  try {
    const { gateway, gateway_transaction_id } = req.body;
    if (!gateway || !["stripe", "paypal", "manual"].includes(gateway)) {
      res.status(400).json({ error: "Validation error", message: "gateway must be stripe, paypal, or manual" }); return;
    }

    const slug = req.params.slug;
    const shop = await db.selectFrom("shops").select("id").where("slug", "=", slug).executeTakeFirst();
    if (!shop) { res.status(404).json({ error: "Store not found" }); return; }

    const session = await completeCheckout(db, req.params.checkoutId, {
      gateway,
      gateway_transaction_id: gateway_transaction_id || null,
    });

    // Send order confirmation email (fire-and-forget)
    if (process.env.SMTP_HOST && session.order_id && session.email) {
      const fullOrder = await db.selectFrom("orders").selectAll().where("id", "=", session.order_id).executeTakeFirst();
      if (fullOrder) {
        const lineItems = await db.selectFrom("order_line_items").selectAll().where("order_id", "=", session.order_id).execute();
        const orderData = {
          id: fullOrder.id, order_number: Number(fullOrder.order_number), email: session.email,
          currency: session.currency, subtotal_price: session.subtotal_price,
          total_shipping: session.total_shipping, total_tax: session.total_tax,
          total_discounts: session.total_discounts, total_price: session.total_price,
          line_items: lineItems.map((li: any) => ({ title: li.title || "", variant_title: li.variant_title, quantity: li.quantity, price: String(li.price) })),
          shipping_address: fullOrder.shipping_address as any, billing_address: fullOrder.billing_address as any,
          created_at: String(fullOrder.created_at),
        };
        sendOrderConfirmation(db, shop.id, orderData).catch((err: any) => apiLogger.error({ err: err.message }, '[email] order confirmation failed'));
        // PR2 commit 13 — merchant heads-up; ops category, forced-send.
        sendNewOrderReceived(db, shop.id, orderData).catch((err: any) => apiLogger.error({ err: err.message }, '[email] new order received failed'));
      }
    }

    logApi(db, null, shop.id, "checkout_complete", "order", session.order_id, { gateway }, null).catch(() => {});

    // Fire automation triggers (fire-and-forget)
    void fireAutomationTrigger(db, shop.id, "order_created", { order: { id: session.order_id, email: session.email, total_price: session.total_price, currency: session.currency } }).catch(() => {});

    res.status(201).json({ checkout: session });
  } catch (err: any) {
    { const status = err.message?.includes("not found") ? 404 : 500; apiLogger.error({ err }, 'Checkout error'); res.status(status).json({ error: status === 404 ? "Not found" : "Internal server error" }); }
  }
});

// ---------------------------------------------------------------------------
// CHECKOUT SUBDOMAIN HANDOFF (Decision #2 — Step 2.2)
// ---------------------------------------------------------------------------
//
// POST /api/store/:slug/checkout/:checkoutId/handoff-token
//
// Mints a signed, one-shot, 5-minute handoff token that lets a custom-domain
// storefront (e.g. https://shop.acme.com) redirect a buyer to the Gbox-owned
// checkout subdomain (https://checkout.gbox.co/c/:checkoutId?hop=<token>)
// without leaking the customer-session cookie across eTLD+1 boundaries.
//
// Flow on the storefront side:
//   1. POST here with the checkoutId in the URL.
//   2. Server validates the checkout exists and belongs to this shop.
//   3. Server pulls req.customerId from the customerAuth middleware (may
//      be undefined if the buyer is shopping as a guest — that's fine).
//   4. Server returns { token, redirect_url, expires_at }.
//   5. Browser navigates to redirect_url. checkout.gbox.co consumes the
//      token, mints a Domain=.gbox.co cookie, and 302s to the clean URL.
//
// Rate-limited via checkoutLimiter (the same one that gates checkout
// create/complete) — 60 req/min/IP. Owner-approved per Decision #2 §8.4.
// ---------------------------------------------------------------------------
app.post(
  "/api/store/:slug/checkout/:checkoutId/handoff-token",
  shopFromSlug,
  checkoutLimiter,
  async (req: Request, res: Response) => {
    try {
      const slug = req.params.slug;
      const checkoutId = req.params.checkoutId;

      // 1. Look up the shop. shopFromSlug already checked it exists, but
      //    we need the id for the ownership check.
      const shop = await db
        .selectFrom("shops")
        .select(["id", "slug"])
        .where("slug", "=", slug)
        .executeTakeFirst();
      if (!shop) {
        res.status(404).json({ error: "Not found", message: "Store not found" });
        return;
      }

      // 2. Look up the checkout and verify ownership.
      const checkout = await getCheckout(checkoutId);
      if (!checkout) {
        res.status(404).json({
          error: "checkout_not_found",
          message: "No checkout session with that id",
        });
        return;
      }
      if (checkout.shop_id !== shop.id) {
        // Don't leak whether the checkout exists for some other shop.
        res.status(404).json({
          error: "checkout_not_found",
          message: "No checkout session with that id",
        });
        return;
      }
      if ((checkout as any).completed_at) {
        res.status(409).json({
          error: "checkout_completed",
          message: "Checkout is already completed — handoff not possible",
        });
        return;
      }

      // 3. Pull the optional customer id from the auth middleware. The
      //    middleware enforces that the customer cookie matches THIS shop
      //    via req.customerShopId — so we re-check that and otherwise
      //    treat it as a guest checkout.
      const customerId =
        req.customerShopId === shop.id ? req.customerId ?? null : null;

      // 4. Mint the token.
      const signed = await issueHandoffToken({
        checkoutId,
        shopId: shop.id,
        customerId,
      });

      // 5. Build the redirect URL. CHECKOUT_BASE_URL defaults to the
      //    production subdomain; override in dev with .env.
      const checkoutBase =
        process.env.CHECKOUT_BASE_URL ?? "https://checkout.gbox.co";
      const redirectUrl = `${checkoutBase}/c/${encodeURIComponent(
        checkoutId,
      )}?hop=${encodeURIComponent(signed.token)}`;

      logApi(
        db,
        null,
        shop.id,
        "checkout_handoff_issued",
        "checkout",
        checkoutId,
        { customer_id: customerId, expires_at: signed.payload.exp },
        null,
      ).catch(() => {});

      res.json({
        token: signed.token,
        redirect_url: redirectUrl,
        expires_at: new Date(signed.payload.exp).toISOString(),
        ttl_ms: HANDOFF_TOKEN_TTL_MS,
      });
    } catch (err: any) {
      if (err instanceof HandoffTokenError) {
        const status =
          err.code === "redis_unavailable"
            ? 503
            : err.code === "expired"
              ? 410
              : 400;
        res.status(status).json({
          error: err.code,
          message: err.message,
        });
        return;
      }
      apiLogger.error(
        { err: err.message, stack: err.stack },
        "[checkout-handoff] unexpected error",
      );
      res.status(500).json({
        error: "Internal server error",
      });
    }
  },
);

// ---------------------------------------------------------------------------
// PAYPAL PAYMENT FLOW ENDPOINTS — LEGACY (kept for backwards compatibility)
// ---------------------------------------------------------------------------
//
// These routes call into packages/core/src/modules/payments/paypal.ts —
// the PRE-Partner module. They still work, still attach the Gbox_Ecom BN
// code (fixed in commit 0f9e62a), but they DO NOT route money to the
// merchant's own PayPal account. Use the /payments/paypal-partner/*
// routes for new integrations.
//
// The middleware below stamps standard deprecation headers (RFC 8594-style)
// and emits a warn-level log line so we can find any storefront still
// hitting these routes before we delete them in a future phase.
const legacyPaypalDeprecation: RequestHandler = (req, res, next) => {
  res.setHeader("Deprecation", "true");
  res.setHeader("Sunset", "Wed, 31 Dec 2026 23:59:59 GMT");
  res.setHeader(
    "Link",
    '</api/store/:slug/payments/paypal-partner/create>; rel="successor-version"',
  );
  // Warning header value MUST be 7-bit ASCII per RFC 7234 — em dash breaks
  // Node's setHeader. Use ASCII hyphen instead.
  res.setHeader(
    "Warning",
    '299 - "Deprecated PayPal route - migrate to /payments/paypal-partner/*"',
  );
  apiLogger.warn(
    {
      route: req.path,
      method: req.method,
      slug: req.params.slug,
      ua: req.get("user-agent") ?? null,
    },
    "[paypal-legacy] deprecated route hit — migrate to /payments/paypal-partner/*",
  );
  next();
};

// POST /api/store/:slug/payments/paypal/create — Create PayPal order for checkout
app.post("/api/store/:slug/payments/paypal/create", legacyPaypalDeprecation, shopFromSlug, paymentLimiter, idempotent, async (req: Request, res: Response) => {
  try {
    const slug = req.params.slug;
    const shop = await db.selectFrom("shops").select(["id", "name", "currency"]).where("slug", "=", slug).executeTakeFirst();
    if (!shop) { res.status(404).json({ error: "Store not found" }); return; }

    const { checkout_id, return_url, cancel_url } = req.body;
    if (!checkout_id || !return_url || !cancel_url) {
      res.status(400).json({ error: "checkout_id, return_url, cancel_url required" }); return;
    }

    // Get checkout session total from DB — never trust client-supplied amount
    const checkout = await getCheckout(checkout_id);
    if (!checkout) {
      res.status(404).json({ error: "Checkout session not found" }); return;
    }
    if (checkout.shop_id !== shop.id) {
      res.status(404).json({ error: "Checkout session not found" }); return;
    }
    const orderAmount = checkout.total_price || "0.00";
    const orderCurrency = checkout.currency || shop.currency || "USD";

    const paypalOrder = await createPayPalOrder(
      orderAmount, orderCurrency, return_url, cancel_url,
      { description: `Order from ${shop.name}`, custom_id: checkout_id }
    );

    res.status(201).json({
      paypal_order_id: paypalOrder.id,
      approve_url: paypalOrder.approve_url,
      status: paypalOrder.status,
    });
  } catch (err: any) {
    apiLogger.error({ err: err.message }, '[paypal] create order error');
    res.status(500).json({ error: "PayPal error" });
  }
});

// POST /api/store/:slug/payments/paypal/capture — Capture PayPal order after buyer approval
app.post("/api/store/:slug/payments/paypal/capture", legacyPaypalDeprecation, shopFromSlug, paymentLimiter, idempotent, async (req: Request, res: Response) => {
  try {
    const slug = req.params.slug;
    const shop = await db.selectFrom("shops").select("id").where("slug", "=", slug).executeTakeFirst();
    if (!shop) { res.status(404).json({ error: "Store not found" }); return; }

    const { paypal_order_id, checkout_id } = req.body;
    if (!paypal_order_id) { res.status(400).json({ error: "paypal_order_id required" }); return; }

    const capture = await capturePayPalOrder(paypal_order_id);

    if (capture.status === "COMPLETED" && checkout_id) {
      // Complete the checkout with PayPal transaction
      try {
        const session = await completeCheckout(db, checkout_id, {
          gateway: "paypal",
          gateway_transaction_id: capture.capture_id || paypal_order_id,
        });

        // Send order confirmation email
        if (process.env.SMTP_HOST && session.order_id && session.email) {
          const fullOrder = await db.selectFrom("orders").selectAll().where("id", "=", session.order_id).executeTakeFirst();
          if (fullOrder) {
            const lineItems = await db.selectFrom("order_line_items").selectAll().where("order_id", "=", session.order_id).execute();
            const orderData = {
              id: fullOrder.id, order_number: Number(fullOrder.order_number), email: session.email,
              currency: session.currency, subtotal_price: session.subtotal_price,
              total_shipping: session.total_shipping, total_tax: session.total_tax,
              total_discounts: session.total_discounts, total_price: session.total_price,
              line_items: lineItems.map((li: any) => ({ title: li.title || "", variant_title: li.variant_title, quantity: li.quantity, price: String(li.price) })),
              shipping_address: fullOrder.shipping_address as any, billing_address: fullOrder.billing_address as any,
              created_at: String(fullOrder.created_at),
            };
            sendOrderConfirmation(db, shop.id, orderData).catch((err: any) => apiLogger.error({ err: err.message }, '[email] order confirmation failed'));
            // PR2 commit 13 — merchant heads-up; ops category, forced-send.
            sendNewOrderReceived(db, shop.id, orderData).catch((err: any) => apiLogger.error({ err: err.message }, '[email] new order received failed'));
          }
        }

        logApi(db, null, shop.id, "paypal_capture", "order", session.order_id, { paypal_order_id, capture_id: capture.capture_id }, null).catch(() => {});
        res.json({ capture, order_id: session.order_id });
        return;
      } catch (checkoutErr: any) {
        apiLogger.error({ err: checkoutErr.message }, '[paypal] checkout completion failed');
        // Still return capture success — order creation failed but money was captured
      }
    }

    res.json({ capture });
  } catch (err: any) {
    apiLogger.error({ err: err.message }, '[paypal] capture error');
    res.status(500).json({ error: "PayPal error" });
  }
});

// POST /api/store/:slug/payments/paypal/refund — Refund a PayPal capture
app.post("/api/store/:slug/payments/paypal/refund", legacyPaypalDeprecation, storeAccess, shopFromSlug, refundLimiter, idempotent, async (req: Request, res: Response) => {
  try {
    const { capture_id, amount, currency, note } = req.body;
    if (!capture_id) { res.status(400).json({ error: "capture_id required" }); return; }

    const refundAmount = amount ? { currency_code: currency || "USD", value: String(amount) } : undefined;
    const refund = await createPayPalRefund(capture_id, refundAmount, note);

    logApi(db, req.apiUser!.id, req.apiStore!.id, "paypal_refund", "transaction", capture_id, { refund_id: refund.id, amount }, req.ip || "").catch(() => {});
    res.json({ refund });
  } catch (err: any) {
    apiLogger.error({ err: err.message }, '[paypal] refund error');
    res.status(500).json({ error: "PayPal error" });
  }
});

// ===========================================================================
// PAYPAL PARTNER ENDPOINTS (Decision #3 — gbox-paypal migration)
// ===========================================================================
//
// Gbox is an official PayPal partner — these routes wire the TypeScript
// port of gbox-paypal (formerly a WooCommerce PHP plugin) into the main
// API. Each store owner connects their own PayPal account via Partner
// Referral; once connected, customer payments flow DIRECTLY to the store
// owner's PayPal (with Gbox as Partner of Record via BN code). This is
// the strategic payment path. Legacy /payments/paypal/* and /payments/
// stripe/* remain as fallbacks.
//
// Merchant routes (storeAccess required — only shop owner/admin):
//   POST /api/store/:slug/paypal/onboarding           { return_url }
//   POST /api/store/:slug/paypal/onboarding/callback  { merchant details }
//   GET  /api/store/:slug/paypal/status
//
// Customer-facing routes (public but rate-limited — storefront calls
// these during checkout; merchant must have completed onboarding):
//   POST /api/store/:slug/payments/paypal-partner/create
//   POST /api/store/:slug/payments/paypal-partner/capture
//   POST /api/store/:slug/payments/paypal-partner/refund  (storeAccess)
//
// Public gateway discovery (storefront uses this to decide which
// payment button to render):
//   GET  /api/store/:slug/checkout/gateways
// ---------------------------------------------------------------------------

// POST /api/store/:slug/paypal/onboarding — generate Partner Referral URL
app.post(
  "/api/store/:slug/paypal/onboarding",
  storeAccess,
  shopFromSlug,
  async (req: Request, res: Response) => {
    const shopId = (req as any).shopId as string | undefined;
    if (!shopId) return res.status(404).json({ error: "store_not_found" });
    const returnUrl =
      typeof req.body?.return_url === "string"
        ? req.body.return_url
        : `${req.protocol}://${req.get("host")}/api/store/${req.params.slug}/paypal/onboarding/callback`;
    try {
      const shop = await db
        .selectFrom("shops")
        .select(["email"])
        .where("id", "=", shopId)
        .executeTakeFirst();
      const url = await createPartnerReferralLink(
        shopId,
        returnUrl,
        shop?.email ?? "",
      );
      logApi(
        db,
        req.apiUser!.id,
        shopId,
        "paypal_partner_onboarding_requested",
        "shop",
        shopId,
        null,
        req.ip || "",
      ).catch(() => {});
      res.json({ paypal_partner: { onboarding_url: url } });
    } catch (err: any) {
      apiLogger.error(
        { err: err?.message, shop_id: shopId },
        "[paypal-partner] onboarding link failed",
      );
      res.status(500).json({ error: "paypal_error" });
    }
  },
);

// POST /api/store/:slug/paypal/onboarding/callback — persist merchant creds
app.post(
  "/api/store/:slug/paypal/onboarding/callback",
  storeAccess,
  shopFromSlug,
  async (req: Request, res: Response) => {
    const shopId = (req as any).shopId as string | undefined;
    if (!shopId) return res.status(404).json({ error: "store_not_found" });
    const params = req.body as Partial<MerchantOnboardingResult>;
    if (!params || !params.merchantIdInPayPal) {
      return res
        .status(400)
        .json({ error: "missing_merchant_id", message: "merchantIdInPayPal required" });
    }
    try {
      await processOnboardingCallback(db, shopId, params as MerchantOnboardingResult);
      logApi(
        db,
        req.apiUser!.id,
        shopId,
        "paypal_partner_connected",
        "shop",
        shopId,
        { merchant_id: params.merchantIdInPayPal },
        req.ip || "",
      ).catch(() => {});
      res.json({
        paypal_partner: {
          connected: true,
          merchant_id: params.merchantIdInPayPal,
          account_status: params.accountStatus ?? null,
        },
      });
    } catch (err: any) {
      apiLogger.error(
        { err: err?.message, shop_id: shopId },
        "[paypal-partner] onboarding callback failed",
      );
      res.status(500).json({ error: "paypal_error" });
    }
  },
);

// GET /api/store/:slug/paypal/status — merchant readiness (cheap, no network)
app.get(
  "/api/store/:slug/paypal/status",
  storeAccess,
  shopFromSlug,
  async (req: Request, res: Response) => {
    const shopId = (req as any).shopId as string | undefined;
    if (!shopId) return res.status(404).json({ error: "store_not_found" });
    try {
      const status = await isMerchantReady(db, shopId);
      res.json({
        paypal_partner: {
          connected: status.ready,
          merchant_id: status.merchantId,
          reason: status.reason ?? null,
        },
      });
    } catch (err: any) {
      apiLogger.error(
        { err: err?.message, shop_id: shopId },
        "[paypal-partner] status check failed",
      );
      res.status(500).json({ error: "paypal_error" });
    }
  },
);

// POST /api/store/:slug/payments/paypal-partner/create — partner order (on-behalf-of merchant)
app.post(
  "/api/store/:slug/payments/paypal-partner/create",
  shopFromSlug,
  paymentLimiter,
  idempotent,
  async (req: Request, res: Response) => {
    const shopId = (req as any).shopId as string | undefined;
    if (!shopId) return res.status(404).json({ error: "store_not_found" });
    const input = req.body as Partial<CreatePayPalOrderInput>;
    if (
      !input ||
      !input.orderId ||
      !input.orderNumber ||
      !input.currency ||
      !Array.isArray(input.items) ||
      !input.returnUrl ||
      !input.cancelUrl
    ) {
      return res.status(400).json({
        error: "invalid_order",
        message:
          "orderId, orderNumber, currency, items[], returnUrl, cancelUrl required",
      });
    }
    try {
      const result = await createPayPalPartnerOrder(
        db,
        shopId,
        input as CreatePayPalOrderInput,
      );
      res.status(201).json({
        paypal_order: {
          id: result.paypalOrderId,
          approval_url: result.approvalUrl,
        },
      });
    } catch (err: any) {
      apiLogger.error(
        { err: err?.message, shop_id: shopId },
        "[paypal-partner] create order failed",
      );
      res.status(500).json({ error: "paypal_error" });
    }
  },
);

// POST /api/store/:slug/payments/paypal-partner/capture — capture partner order
app.post(
  "/api/store/:slug/payments/paypal-partner/capture",
  shopFromSlug,
  paymentLimiter,
  idempotent,
  async (req: Request, res: Response) => {
    const shopId = (req as any).shopId as string | undefined;
    if (!shopId) return res.status(404).json({ error: "store_not_found" });
    const { paypal_order_id, checkout_id } = req.body ?? {};
    if (!paypal_order_id) {
      return res
        .status(400)
        .json({ error: "missing_paypal_order_id" });
    }
    try {
      const capture = await capturePayPalPartnerOrder(paypal_order_id);
      // If checkout_id is supplied, finalize the Gbox order so the
      // buyer sees a real order id / confirmation page.
      let orderId: string | null = null;
      if (capture.status === "COMPLETED" && checkout_id) {
        try {
          const session = await completeCheckout(db, checkout_id, {
            gateway: "paypal",
            gateway_transaction_id: capture.captureId,
          });
          orderId = session.order_id ?? null;

          // Send order confirmation email (fire-and-forget)
          if (process.env.SMTP_HOST && session.order_id && session.email) {
            const fullOrder = await db.selectFrom("orders").selectAll().where("id", "=", session.order_id).executeTakeFirst();
            if (fullOrder) {
              const lineItems = await db.selectFrom("order_line_items").selectAll().where("order_id", "=", session.order_id).execute();
              const orderData = {
                id: fullOrder.id, order_number: Number(fullOrder.order_number), email: session.email,
                currency: session.currency, subtotal_price: session.subtotal_price,
                total_shipping: session.total_shipping, total_tax: session.total_tax,
                total_discounts: session.total_discounts, total_price: session.total_price,
                line_items: lineItems.map((li: any) => ({ title: li.title || "", variant_title: li.variant_title, quantity: li.quantity, price: String(li.price) })),
                shipping_address: fullOrder.shipping_address as any, billing_address: fullOrder.billing_address as any,
                created_at: String(fullOrder.created_at),
              };
              sendOrderConfirmation(db, shopId, orderData).catch((err: any) => apiLogger.error({ err: err.message }, '[email] order confirmation failed'));
              // PR2 commit 13 — merchant heads-up; ops category, forced-send.
              sendNewOrderReceived(db, shopId, orderData).catch((err: any) => apiLogger.error({ err: err.message }, '[email] new order received failed'));
            }
          }

          logApi(
            db,
            null,
            shopId,
            "paypal_partner_capture",
            "order",
            orderId,
            { paypal_order_id, capture_id: capture.captureId },
            null,
          ).catch(() => {});
        } catch (finalizeErr: any) {
          apiLogger.error(
            {
              err: finalizeErr?.message,
              shop_id: shopId,
              checkout_id,
              paypal_order_id,
            },
            "[paypal-partner] checkout finalization failed after capture",
          );
          // Payment IS captured — return 202 so client can retry finalize
          return res.status(202).json({
            paypal_capture: capture,
            order_id: null,
            warning: "payment_captured_finalize_pending",
          });
        }
      }
      res.json({ paypal_capture: capture, order_id: orderId });
    } catch (err: any) {
      const msg = err?.message ?? "";
      if (msg.includes("INSTRUMENT_DECLINED")) {
        return res.status(422).json({
          error: "instrument_declined",
          message:
            "Payment method declined. Please try another payment method.",
        });
      }
      apiLogger.error(
        { err: msg, shop_id: shopId, paypal_order_id },
        "[paypal-partner] capture failed",
      );
      res.status(500).json({ error: "paypal_error", message: msg });
    }
  },
);

// POST /api/store/:slug/payments/paypal-partner/cancel — buyer abandoned PayPal flow
//
// Mirrors paypal-gbox.php's `gbox_paypal_cancel` GET handler. Called by the
// storefront when the buyer is bounced back to `cancel_url` (the URL we
// supplied to PayPal in createPartnerOrder.experience_context.cancel_url).
//
// Behavior:
//   1. Verify with PayPal that the order has NOT already been captured.
//      If COMPLETED, return 409 — caller must use the refund route instead.
//   2. Tear down the local Gbox checkout session (Redis-backed).
//   3. Audit-log the abandonment for the merchant.
//
// Idempotent: a second cancel call returns 200 with `already_cancelled: true`.
app.post(
  "/api/store/:slug/payments/paypal-partner/cancel",
  shopFromSlug,
  paymentLimiter,
  idempotent,
  async (req: Request, res: Response) => {
    const shopId = (req as any).shopId as string | undefined;
    if (!shopId) return res.status(404).json({ error: "store_not_found" });
    const { paypal_order_id, checkout_id, reason } = req.body ?? {};
    if (!paypal_order_id) {
      return res.status(400).json({ error: "missing_paypal_order_id" });
    }
    try {
      const cancelInfo = await cancelPayPalPartnerOrder(paypal_order_id);

      if (cancelInfo.alreadyCaptured) {
        // Money already moved — refusing to silently void.
        // Caller must explicitly issue a refund via the refund route.
        return res.status(409).json({
          error: "order_already_captured",
          message:
            "PayPal order is already captured. Use the refund endpoint to reverse the payment.",
          paypal_status: cancelInfo.paypalStatus,
        });
      }

      // Tear down the local Gbox checkout session if the storefront passed
      // its checkout_id. We tolerate "already gone" silently — the buyer
      // could have hit cancel twice, or the Redis TTL could have expired.
      let removed: boolean | null = null;
      let alreadyCancelled = false;
      if (checkout_id) {
        try {
          const snapshot = await cancelCheckout(
            checkout_id,
            reason ? String(reason).slice(0, 200) : "buyer_cancelled_paypal",
          );
          removed = snapshot !== null;
          alreadyCancelled = snapshot === null;
        } catch (cancelErr: any) {
          // cancelCheckout throws if the checkout was already completed.
          // That's a real conflict — the storefront state is out of sync.
          if (
            String(cancelErr?.message ?? "").includes(
              "Cannot cancel a completed checkout",
            )
          ) {
            return res.status(409).json({
              error: "checkout_already_completed",
              message:
                "Local checkout was already completed — cannot cancel.",
            });
          }
          throw cancelErr;
        }
      }

      logApi(
        db,
        null,
        shopId,
        "paypal_partner_cancel",
        "checkout",
        checkout_id ?? null,
        {
          paypal_order_id,
          paypal_status: cancelInfo.paypalStatus,
          reason: reason ?? null,
          checkout_removed: removed,
        },
        req.ip || "",
      ).catch(() => {});

      res.json({
        cancelled: true,
        paypal_status: cancelInfo.paypalStatus,
        checkout_removed: removed,
        already_cancelled: alreadyCancelled,
      });
    } catch (err: any) {
      apiLogger.error(
        { err: err?.message, shop_id: shopId, paypal_order_id },
        "[paypal-partner] cancel failed",
      );
      res.status(500).json({ error: "paypal_error" });
    }
  },
);

// POST /api/store/:slug/payments/paypal-partner/refund — refund a partner capture
app.post(
  "/api/store/:slug/payments/paypal-partner/refund",
  storeAccess,
  shopFromSlug,
  refundLimiter,
  idempotent,
  async (req: Request, res: Response) => {
    const shopId = (req as any).shopId as string | undefined;
    if (!shopId) return res.status(404).json({ error: "store_not_found" });
    const { capture_id, amount, currency, note } = req.body ?? {};
    if (!capture_id) {
      return res.status(400).json({ error: "missing_capture_id" });
    }
    try {
      const result = await refundPayPalPartnerCapture(
        db,
        shopId,
        capture_id,
        amount !== undefined ? Number(amount) : undefined,
        currency,
        note,
      );
      logApi(
        db,
        req.apiUser!.id,
        shopId,
        "paypal_partner_refund",
        "transaction",
        capture_id,
        { refund_id: result.refundId, amount },
        req.ip || "",
      ).catch(() => {});
      res.json({
        paypal_refund: { id: result.refundId, status: result.status },
      });
    } catch (err: any) {
      apiLogger.error(
        { err: err?.message, shop_id: shopId, capture_id },
        "[paypal-partner] refund failed",
      );
      res.status(500).json({ error: "paypal_error" });
    }
  },
);

// GET /api/store/:slug/checkout/gateways — public gateway discovery
// Storefront calls this to decide which payment button to render.
// PayPal is preferred; Stripe is returned only as fallback.
app.get(
  "/api/store/:slug/checkout/gateways",
  shopFromSlug,
  async (req: Request, res: Response) => {
    const shopId = (req as any).shopId as string | undefined;
    if (!shopId) return res.status(404).json({ error: "store_not_found" });
    try {
      const gateways = await selectPaymentGateway(db, shopId);
      res.json({ gateways });
    } catch (err: any) {
      apiLogger.error(
        { err: err?.message, shop_id: shopId },
        "[gateway-selector] failed",
      );
      res.status(500).json({ error: "internal_error" });
    }
  },
);

// GET /api/store/:slug/payments/paypal-partner/sdk-tag — return the PayPal
// JS SDK <script> tag pre-stamped with `data-partner-attribution-id`.
//
// The storefront splices this into <head> on the checkout page so PayPal
// gets the partner attribution on the BROWSER side. The server-side fix
// in commit 0f9e62a covered API-call attribution; this covers the SDK.
//
// Returns 409 if the shop has not yet completed PayPal Partner onboarding,
// so the storefront can fall back to Stripe gracefully.
app.get(
  "/api/store/:slug/payments/paypal-partner/sdk-tag",
  shopFromSlug,
  apiReadLimiter,
  async (req: Request, res: Response) => {
    const shopId = (req as any).shopId as string | undefined;
    if (!shopId) return res.status(404).json({ error: "store_not_found" });
    try {
      const shop = await db
        .selectFrom("shops")
        .select(["currency"])
        .where("id", "=", shopId)
        .executeTakeFirst();
      const tag = await buildPayPalSdkScriptTag(db, shopId, {
        currency: shop?.currency || "USD",
        buyerCountry:
          (req.query.country ? String(req.query.country) : "US").toUpperCase(),
      });
      // Cache the script tag for 5 minutes — merchant_id rarely changes
      // and a stale tag is safe (PayPal validates server-side anyway).
      res.setHeader("Cache-Control", "public, max-age=300");
      res.json({
        paypal_sdk: {
          script_tag: tag.scriptTag,
          src: tag.src,
          bn_code: tag.bnCode,
          merchant_id: tag.merchantId,
        },
      });
    } catch (err: any) {
      const msg = err?.message ?? "";
      if (
        msg.includes("not connected") ||
        msg.includes("merchant not connected") ||
        msg.includes("PayPal SDK unavailable")
      ) {
        return res.status(409).json({
          error: "paypal_not_connected",
          message: msg,
        });
      }
      apiLogger.error(
        { err: msg, shop_id: shopId },
        "[paypal-partner] sdk-tag build failed",
      );
      res.status(500).json({ error: "paypal_error", message: msg });
    }
  },
);

// GET /api/payments/paypal-partner/buttons.js — serve the browser-side
// PayPal/Venmo button renderer. Plain JS, no auth, aggressively cacheable
// (file content is shipped with the build, versioned via the URL query
// `?v=...` if the storefront wants to bust caches).
//
// This is the TS port of gbox-paypal/js/gbox-paypal.js extended to render
// PayPal AND Venmo buttons against /payments/paypal-partner/* endpoints.
// We read the file off disk on first hit and cache the bytes in memory.
let __paypalButtonsJsCache: string | null = null;
function loadPaypalButtonsJs(): string {
  if (__paypalButtonsJsCache !== null) return __paypalButtonsJsCache;
  // server.ts lives at the repo root; the file lives under packages/core.
  // Resolve relative to this module to survive any cwd choice.
  const here = dirname(fileURLToPath(import.meta.url));
  const filePath = pathResolve(
    here,
    "packages/core/src/modules/payments/paypal-partner/browser/paypal-buttons.js",
  );
  __paypalButtonsJsCache = readFileSync(filePath, "utf8");
  return __paypalButtonsJsCache;
}
app.get(
  "/api/payments/paypal-partner/buttons.js",
  apiReadLimiter,
  (_req: Request, res: Response) => {
    try {
      const body = loadPaypalButtonsJs();
      res.setHeader("Content-Type", "application/javascript; charset=utf-8");
      // Long cache — content is content-addressed by the deploy.
      res.setHeader("Cache-Control", "public, max-age=86400, immutable");
      res.send(body);
    } catch (err: any) {
      apiLogger.error(
        { err: err?.message },
        "[paypal-partner] failed to read buttons.js from disk",
      );
      res.status(500).send("// gbox: failed to load paypal-buttons.js");
    }
  },
);

// ---------------------------------------------------------------------------
// STRIPE PAYMENT FLOW ENDPOINTS
// ---------------------------------------------------------------------------

// POST /api/store/:slug/payments/stripe/create-intent — Create Stripe PaymentIntent
app.post("/api/store/:slug/payments/stripe/create-intent", shopFromSlug, paymentLimiter, idempotent, async (req: Request, res: Response) => {
  try {
    const slug = req.params.slug;
    const shop = await db.selectFrom("shops").select(["id", "name"]).where("slug", "=", slug).executeTakeFirst();
    if (!shop) { res.status(404).json({ error: "Store not found" }); return; }

    const { amount, currency, checkout_id, receipt_email, capture_method } = req.body;
    if (!amount || !currency) { res.status(400).json({ error: "amount (cents) and currency required" }); return; }

    const intent = await createPaymentIntent({
      amount: Number(amount),
      currency: currency.toLowerCase(),
      metadata: { shop_id: shop.id, checkout_id: checkout_id || "" },
      receipt_email: receipt_email || undefined,
      description: `Order from ${shop.name}`,
      capture_method: capture_method || "automatic",
    });

    res.status(201).json({
      client_secret: intent.client_secret,
      payment_intent_id: intent.id,
      status: intent.status,
    });
  } catch (err: any) {
    apiLogger.error({ err: err.message }, '[stripe] create intent error');
    res.status(500).json({ error: "Stripe error" });
  }
});

// POST /api/webhooks/stripe — Stripe webhook handler
//
// Phase 15 PR2 — gateway idempotency chokepoint. Stripe WILL redeliver
// the same `event.id` on network retries, multi-endpoint fan-out, and
// dashboard-triggered replays. Every handler MUST dedupe against
// `payment_webhook_events` before running side-effects — otherwise a
// replay duplicates the capture / refund / fulfilment row.
app.post("/api/webhooks/stripe", async (req: Request, res: Response) => {
  // Two-stage error handling:
  //   - verification / parse / dedup failures return 4xx so Stripe keeps
  //     retrying (network blip or signing-secret rotation)
  //   - side-effect failures AFTER a successful dedup row are recorded
  //     on the ledger (result='error' + error_reason) and we return 200
  //     so Stripe stops retrying — otherwise the replay short-circuits
  //     on the conflict and the original error never gets fixed.
  let dedupId: number | null = null;
  try {
    const sig = req.headers["stripe-signature"] as string;
    if (!sig) { res.status(400).json({ error: "Missing stripe-signature header" }); return; }

    const event = await handleStripeWebhook(req.body, sig);
    const action = processWebhookEvent(event);

    // ─── Idempotency chokepoint ──────────────────────────────────────
    // INSERT ... ON CONFLICT (gateway, event_id) DO NOTHING.
    // On replay, isNew=false → return 200 with no side-effects.
    const dedup = await recordInboundWebhook(db, {
      gateway: 'stripe',
      eventId: event.id,
      eventType: event.type,
      payload: event,
      signature: sig,
      // shop_id is not directly known at signature time for platform-
      // scoped events; for payment_intent.* we attach it below once we
      // resolve via transactions.gateway_transaction_id (non-critical —
      // the ledger row still exists for forensics either way).
    });
    if (!dedup.isNew) {
      apiLogger.info({ eventId: event.id, eventType: event.type, dedupRow: dedup.id }, '[stripe webhook] duplicate replay — ignored');
      res.status(200).json({ received: true, duplicate: true });
      return;
    }
    dedupId = dedup.id;

    apiLogger.info({ eventType: event.type, action: action.action, paymentIntentId: action.paymentIntentId, dedupRow: dedup.id }, '[stripe webhook] event received');

    if (action.action === "payment_succeeded" && action.paymentIntentId) {
      // Find order by gateway_transaction_id or metadata
      const txn = await db.selectFrom("transactions")
        .select(["id", "order_id"])
        .where("gateway_transaction_id", "=", action.paymentIntentId)
        .executeTakeFirst();

      if (txn) {
        await db.updateTable("transactions").set({ status: "success" }).where("id", "=", txn.id).execute();
        await db.updateTable("orders").set({ financial_status: "paid", updated_at: new Date().toISOString() }).where("id", "=", txn.order_id).execute();
        // Order event sourcing + daily metrics
        const order = await db.selectFrom("orders").selectAll().where("id", "=", txn.order_id).executeTakeFirst();
        if (order) {
          await emitOrderEvent(db, { shop_id: order.shop_id, order_id: txn.order_id, event_type: "payment_captured", actor_type: "webhook", data: { gateway: "stripe", intent_id: action.paymentIntentId } });
          void incrementToday(db, order.shop_id, String(order.total_price || "0"), order.currency || "USD").catch(() => {});

          // Send order confirmation email (fire-and-forget)
          if (process.env.SMTP_HOST && order.email) {
            const lineItems = await db.selectFrom("order_line_items").selectAll().where("order_id", "=", txn.order_id).execute();
            const orderData = {
              id: order.id, order_number: Number(order.order_number), email: order.email,
              currency: order.currency || "USD", subtotal_price: order.subtotal_price || "0",
              total_shipping: order.total_shipping || "0", total_tax: order.total_tax || "0",
              total_discounts: order.total_discounts || "0", total_price: order.total_price || "0",
              line_items: lineItems.map((li: any) => ({ title: li.title || "", variant_title: li.variant_title, quantity: li.quantity, price: String(li.price) })),
              shipping_address: order.shipping_address as any, billing_address: order.billing_address as any,
              created_at: String(order.created_at),
            };
            sendOrderConfirmation(db, order.shop_id, orderData).catch((err: any) => apiLogger.error({ err: err.message }, '[email] stripe order confirmation failed'));
            // PR2 commit 13 — merchant heads-up; ops category, forced-send.
            sendNewOrderReceived(db, order.shop_id, orderData).catch((err: any) => apiLogger.error({ err: err.message }, '[email] stripe new order received failed'));
          }
        }
      }
    }

    if (action.action === "payment_failed" && action.paymentIntentId) {
      const txn = await db.selectFrom("transactions")
        .select(["id", "order_id"])
        .where("gateway_transaction_id", "=", action.paymentIntentId)
        .executeTakeFirst();

      if (txn) {
        await db.updateTable("transactions").set({ status: "failure" }).where("id", "=", txn.id).execute();
        const order = await db.selectFrom("orders").select("shop_id").where("id", "=", txn.order_id).executeTakeFirst();
        if (order) {
          await emitOrderEvent(db, { shop_id: order.shop_id, order_id: txn.order_id, event_type: "payment_failed", actor_type: "webhook", data: { gateway: "stripe" } }).catch(() => {});
        }
      }
    }

    if (action.action === "refund_created" && action.paymentIntentId) {
      const txn = await db.selectFrom("transactions")
        .select(["id", "order_id"])
        .where("gateway_transaction_id", "=", action.paymentIntentId)
        .executeTakeFirst();

      if (txn) {
        await db.updateTable("orders").set({ financial_status: "refunded", updated_at: new Date().toISOString() }).where("id", "=", txn.order_id).execute();
        const order = await db.selectFrom("orders").select("shop_id").where("id", "=", txn.order_id).executeTakeFirst();
        if (order) {
          await emitOrderEvent(db, { shop_id: order.shop_id, order_id: txn.order_id, event_type: "refund_issued", actor_type: "webhook", data: { gateway: "stripe" } }).catch(() => {});
        }
      }
    }

    // Phase 15 PR2 — all side-effects succeeded: flip ledger row to 'ok'.
    await markWebhookProcessed(db, dedup.id, { result: 'ok' })
      .catch((err) => apiLogger.warn({ err: err.message, dedupRow: dedup.id }, '[stripe webhook] failed to finalize ledger row'));

    res.json({ received: true });
  } catch (err: any) {
    apiLogger.error({ err: err.message, dedupRow: dedupId }, '[stripe webhook] error');
    if (dedupId !== null) {
      // We already persisted the dedup row; flip it to 'error' so the
      // sweeper / admin dashboard surfaces it, then return 200 so Stripe
      // stops retrying (a retry would short-circuit on the existing row
      // and the underlying bug never gets a chance to be fixed).
      await markWebhookProcessed(db, dedupId, {
        result: 'error',
        errorReason: String(err?.message ?? err ?? 'unknown').slice(0, 2000),
      }).catch(() => undefined);
      res.status(200).json({ received: true, deferred: true });
      return;
    }
    // Pre-dedup failure (signature / parse) — return 400 so Stripe retries.
    res.status(400).json({ error: "Webhook error" });
  }
});

// POST /api/webhooks/paypal — PayPal webhook handler
//
// Phase 15 PR2 — gateway idempotency chokepoint. PayPal redelivers
// `event.id` (WH-xxx) on retry, multi-endpoint fan-out, and manual
// dashboard replays. The ledger chokepoint guarantees each event is
// processed at most once. Critical for PayPal specifically because the
// strategic gateway (Phase 16 Track A) routes money directly to
// merchant accounts via on-behalf-of capture — double capture there
// means double charge to the buyer's funding source.
app.post("/api/webhooks/paypal", async (req: Request, res: Response) => {
  // Phase 15 PR2 — two-stage error handling (see Stripe webhook comment).
  let dedupId: number | null = null;
  try {
    const webhookId = process.env.PAYPAL_WEBHOOK_ID;
    let rawSignature: string | null = null;
    if (webhookId) {
      const headers: Record<string, string> = {};
      for (const [key, val] of Object.entries(req.headers)) {
        if (typeof val === "string") headers[key.toLowerCase()] = val;
      }
      rawSignature = headers['paypal-transmission-sig'] ?? null;
      const verified = await verifyPayPalWebhook(webhookId, headers, JSON.stringify(req.body));
      if (!verified) {
        apiLogger.warn({}, '[paypal webhook] signature verification failed');
        res.status(401).json({ error: "Invalid webhook signature" });
        return;
      }
    }

    const event = req.body;
    const eventType = event.event_type;

    // ─── Idempotency chokepoint ──────────────────────────────────────
    // PayPal's `event.id` (WH-xxx) is the authoritative event identifier.
    // Guard against missing/malformed ids — the gateway's own schema
    // guarantees `event.id` but we fail closed if absent.
    const eventId = typeof event?.id === 'string' ? event.id : null;
    if (!eventId || !eventType) {
      apiLogger.warn({ hasId: !!event?.id, hasType: !!eventType }, '[paypal webhook] malformed event — missing id or type');
      res.status(400).json({ error: 'Malformed webhook event' });
      return;
    }
    const dedup = await recordInboundWebhook(db, {
      gateway: 'paypal',
      eventId,
      eventType,
      payload: event,
      signature: rawSignature,
    });
    if (!dedup.isNew) {
      apiLogger.info({ eventId, eventType, dedupRow: dedup.id }, '[paypal webhook] duplicate replay — ignored');
      res.status(200).json({ received: true, duplicate: true });
      return;
    }
    dedupId = dedup.id;

    apiLogger.info({ eventType, eventId, dedupRow: dedup.id }, '[paypal webhook] event received');

    if (eventType === "CHECKOUT.ORDER.APPROVED") {
      // Order approved, ready to capture
      apiLogger.info({ orderId: event.resource?.id }, '[paypal webhook] order approved');
    }

    if (eventType === "PAYMENT.CAPTURE.COMPLETED") {
      const captureId = event.resource?.id;
      const customId = event.resource?.custom_id;
      apiLogger.info({ captureId, checkoutId: customId }, '[paypal webhook] capture completed');

      // Update transaction status if exists
      if (captureId) {
        const txn = await db.selectFrom("transactions")
          .select(["id", "order_id"])
          .where("gateway_transaction_id", "=", captureId)
          .executeTakeFirst();

        if (txn) {
          await db.updateTable("transactions").set({ status: "success" }).where("id", "=", txn.id).execute();
          await db.updateTable("orders").set({ financial_status: "paid", updated_at: new Date().toISOString() }).where("id", "=", txn.order_id).execute();
          const order = await db.selectFrom("orders").selectAll().where("id", "=", txn.order_id).executeTakeFirst();
          if (order) {
            await emitOrderEvent(db, { shop_id: order.shop_id, order_id: txn.order_id, event_type: "payment_captured", actor_type: "webhook", data: { gateway: "paypal", capture_id: captureId } }).catch(() => {});
            void incrementToday(db, order.shop_id, String(order.total_price || "0"), order.currency || "USD").catch(() => {});

            // Send order confirmation email (fire-and-forget)
            if (process.env.SMTP_HOST && order.email) {
              const lineItems = await db.selectFrom("order_line_items").selectAll().where("order_id", "=", txn.order_id).execute();
              const orderData = {
                id: order.id, order_number: Number(order.order_number), email: order.email,
                currency: order.currency || "USD", subtotal_price: order.subtotal_price || "0",
                total_shipping: order.total_shipping || "0", total_tax: order.total_tax || "0",
                total_discounts: order.total_discounts || "0", total_price: order.total_price || "0",
                line_items: lineItems.map((li: any) => ({ title: li.title || "", variant_title: li.variant_title, quantity: li.quantity, price: String(li.price) })),
                shipping_address: order.shipping_address as any, billing_address: order.billing_address as any,
                created_at: String(order.created_at),
              };
              sendOrderConfirmation(db, order.shop_id, orderData).catch((err: any) => apiLogger.error({ err: err.message }, '[email] paypal webhook order confirmation failed'));
              // PR2 commit 13 — merchant heads-up; ops category, forced-send.
              sendNewOrderReceived(db, order.shop_id, orderData).catch((err: any) => apiLogger.error({ err: err.message }, '[email] paypal webhook new order received failed'));
            }
          }
        }
      }
    }

    if (eventType === "PAYMENT.CAPTURE.REFUNDED") {
      const captureId = event.resource?.links?.find((l: any) => l.rel === "up")?.href?.split("/").pop();
      if (captureId) {
        const txn = await db.selectFrom("transactions")
          .select(["id", "order_id"])
          .where("gateway_transaction_id", "=", captureId)
          .executeTakeFirst();

        if (txn) {
          await db.updateTable("orders").set({ financial_status: "refunded", updated_at: new Date().toISOString() }).where("id", "=", txn.order_id).execute();
          const order = await db.selectFrom("orders").select("shop_id").where("id", "=", txn.order_id).executeTakeFirst();
          if (order) {
            await emitOrderEvent(db, { shop_id: order.shop_id, order_id: txn.order_id, event_type: "refund_issued", actor_type: "webhook", data: { gateway: "paypal" } }).catch(() => {});
          }
        }
      }
    }

    // Phase 15 PR2 — all side-effects succeeded: flip ledger row to 'ok'.
    await markWebhookProcessed(db, dedup.id, { result: 'ok' })
      .catch((err) => apiLogger.warn({ err: err.message, dedupRow: dedup.id }, '[paypal webhook] failed to finalize ledger row'));

    res.json({ received: true });
  } catch (err: any) {
    apiLogger.error({ err: err.message, dedupRow: dedupId }, '[paypal webhook] error');
    if (dedupId !== null) {
      // Side-effect failure after persist — flip row to 'error' and
      // return 200 so PayPal stops retrying (replay would short-circuit
      // on the existing row anyway).
      await markWebhookProcessed(db, dedupId, {
        result: 'error',
        errorReason: String(err?.message ?? err ?? 'unknown').slice(0, 2000),
      }).catch(() => undefined);
      res.status(200).json({ received: true, deferred: true });
      return;
    }
    res.status(500).json({ error: "Webhook error" });
  }
});

// ---------------------------------------------------------------------------
// EMAIL API ENDPOINTS (God Admin)
// ---------------------------------------------------------------------------

// POST /api/god/email/test — Send a test email (God Admin only)
app.post("/api/god/email/test", godAdmin, async (req: Request, res: Response) => {
  try {
    const { to, subject, html } = req.body;
    if (!to || !subject) { res.status(400).json({ error: "to and subject required" }); return; }

    if (!process.env.SMTP_HOST) {
      res.status(503).json({ error: "Email not configured", message: "SMTP_HOST is not set. Configure SMTP in .env" }); return;
    }

    const messageId = await sendEmail({
      to,
      subject: subject || "Test email from Gbox Platform",
      html: html || `<div style="font-family:sans-serif;padding:20px"><h2>Test Email</h2><p>This is a test email from Gbox Platform.</p><p>Sent at: ${new Date().toISOString()}</p></div>`,
    });

    logApi(db, req.apiUser!.id, null, "email_test_sent", "email", null, { to, subject, messageId }, req.ip || "").catch(() => {});
    res.json({ success: true, messageId });
  } catch (err: any) {
    apiLogger.error({ err: err.message }, '[email] test send failed');
    res.status(500).json({ error: "Email send failed" });
  }
});

// GET /api/god/email/config — Check email configuration status
app.get("/api/god/email/config", godAdmin, async (_req: Request, res: Response) => {
  res.json({
    configured: !!process.env.SMTP_HOST,
    host: process.env.SMTP_HOST ? `${process.env.SMTP_HOST}:${process.env.SMTP_PORT || 587}` : null,
    from: process.env.SMTP_FROM || process.env.EMAIL_FROM || "noreply@gbox.io",
    secure: process.env.SMTP_SECURE === "true",
  });
});

// GET /api/store/:slug/email/templates — List email templates for a store
app.get("/api/store/:slug/email/templates", storeAccess, async (req: Request, res: Response) => {
  try {
    const templates = await db.selectFrom("email_templates")
      .selectAll()
      .where("shop_id", "=", req.apiStore!.id)
      .orderBy("name", "asc")
      .execute();

    res.json({
      templates,
      available_templates: ["order_confirmation", "shipping_notification", "password_reset", "welcome"],
    });
  } catch (err: any) {
    apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/store/:slug/email/templates/:name — Create/update email template
app.put("/api/store/:slug/email/templates/:name", storeAccess, async (req: Request, res: Response) => {
  try {
    const { name } = req.params;
    const { subject, body_html, active } = req.body;
    if (!subject && !body_html && active === undefined) {
      res.status(400).json({ error: "At least one field (subject, body_html, active) required" }); return;
    }

    const existing = await db.selectFrom("email_templates")
      .select("id")
      .where("shop_id", "=", req.apiStore!.id)
      .where("name", "=", name)
      .executeTakeFirst();

    if (existing) {
      const updates: Record<string, any> = { updated_at: new Date().toISOString() };
      if (subject !== undefined) updates.subject = subject;
      if (body_html !== undefined) updates.body_html = body_html;
      if (active !== undefined) updates.active = active;

      const template = await db.updateTable("email_templates")
        .set(updates)
        .where("id", "=", existing.id)
        .returningAll()
        .executeTakeFirstOrThrow();

      logApi(db, req.apiUser!.id, req.apiStore!.id, "email_template_update", "email_template", existing.id, { name }, req.ip || "").catch(() => {});
      res.json({ template });
    } else {
      const template = await db.insertInto("email_templates")
        .values({
          shop_id: req.apiStore!.id,
          name,
          subject: subject || `Template: ${name}`,
          body_html: body_html || null,
          active: active ?? true,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      logApi(db, req.apiUser!.id, req.apiStore!.id, "email_template_create", "email_template", template.id, { name }, req.ip || "").catch(() => {});
      res.status(201).json({ template });
    }
  } catch (err: any) {
    apiLogger.error({ err }, 'Internal server error'); res.status(500).json({ error: 'Internal server error' });
  }
});

// ===========================================================================
// BACKWARD-COMPATIBLE LEGACY ENDPOINTS (/api/2026-04/*)
//
// These were originally written to take `?shop_id=` as a query param —
// PRINCIPLES.md P4 explicitly calls that out as the #1 multi-tenant leak
// vector. They now use `req.shopId` (set by the global `shopContext`
// middleware) which derives the shop from `X-Shop-Domain` header / Bearer
// token / Host. The query param fallback is gone.
// ===========================================================================

/**
 * Helper that resolves the active shop_id from `shopContext` and 401s
 * if none was attached. Used by every legacy endpoint below.
 */
function requireShopContext(req: Request, res: Response): string | null {
  const shopId = (req as any).shopId as string | undefined;
  if (!shopId) {
    res.status(401).json({
      error: "shop_context_required",
      message: "No shop context. Send X-Shop-Domain, Authorization Bearer token, or use a configured custom domain.",
    });
    return null;
  }
  return shopId;
}

app.get("/api/2026-04/shop.json", async (req: Request, res: Response) => {
  const shopId = requireShopContext(req, res);
  if (!shopId) return;
  try {
    const shop = await db
      .selectFrom("shops")
      .selectAll()
      .where("id", "=", shopId)
      .executeTakeFirst();
    if (!shop) { res.status(404).json({ error: "shop_not_found" }); return; }
    res.json({ shop });
  } catch (err: any) {
    apiLogger.error({ err }, 'Request failed'); res.status(500).json({ error: 'Internal server error' });
  }
});

app.get("/api/2026-04/products.json", scope("read_products"), async (req: Request, res: Response) => {
  const shopId = requireShopContext(req, res);
  if (!shopId) return;
  try {
    const limit = Math.min(parseInt((req.query.limit as string) || "50", 10) || 50, 250);
    const offset = parseInt((req.query.offset as string) || "0", 10) || 0;
    const status = typeof req.query.status === "string" ? req.query.status : undefined;

    // Single round-trip — fixes the legacy N+1 (PRINCIPLES.md P10).
    const result = await listProductsWithDetails(
      db,
      shopId,
      { status },
      { limit, offset },
    );
    res.json({ products: result.products, total: result.total });
  } catch (err: any) {
    apiLogger.error({ err }, 'Request failed'); res.status(500).json({ error: 'Internal server error' });
  }
});

app.get("/api/2026-04/products/:id.json", scope("read_products"), async (req: Request, res: Response) => {
  const shopId = requireShopContext(req, res);
  if (!shopId) return;
  try {
    const product = await db
      .selectFrom("products")
      .selectAll()
      .where("id", "=", req.params.id)
      .where("shop_id", "=", shopId)
      .executeTakeFirst();
    if (!product) {
      res.status(404).json({ error: "Product not found" });
      return;
    }
    const variants = await db
      .selectFrom("product_variants")
      .selectAll()
      .where("product_id", "=", req.params.id)
      .execute();
    res.json({ product: { ...product, variants } });
  } catch (err: any) {
    apiLogger.error({ err }, 'Request failed'); res.status(500).json({ error: 'Internal server error' });
  }
});

app.get("/api/2026-04/orders.json", scope("read_orders"), async (req: Request, res: Response) => {
  const shopId = requireShopContext(req, res);
  if (!shopId) return;
  try {
    const orders = await db
      .selectFrom("orders")
      .selectAll()
      .where("shop_id", "=", shopId)
      .orderBy("created_at", "desc")
      .limit(50)
      .execute();
    res.json({ orders });
  } catch (err: any) {
    apiLogger.error({ err }, 'Request failed'); res.status(500).json({ error: 'Internal server error' });
  }
});

app.get("/api/2026-04/customers.json", scope("read_customers"), async (req: Request, res: Response) => {
  const shopId = requireShopContext(req, res);
  if (!shopId) return;
  try {
    const customers = await db
      .selectFrom("customers")
      .selectAll()
      .where("shop_id", "=", shopId)
      .orderBy("created_at", "desc")
      .limit(50)
      .execute();
    res.json({ customers });
  } catch (err: any) {
    apiLogger.error({ err }, 'Request failed'); res.status(500).json({ error: 'Internal server error' });
  }
});

app.get("/api/2026-04/stats.json", godAdmin, async (_req: Request, res: Response) => {
  try {
    const tables = await db
      .selectFrom("information_schema.tables" as any)
      .select(["table_name"])
      .where("table_schema", "=", "public")
      .execute();
    const counts: Record<string, number> = {};
    for (const t of tables.slice(0, 20)) {
      try {
        const r = await db
          .selectFrom((t as any).table_name as any)
          .select(db.fn.countAll().as("c"))
          .executeTakeFirst();
        counts[(t as any).table_name] = Number((r as any)?.c || 0);
      } catch {
        counts[(t as any).table_name] = 0;
      }
    }
    res.json({
      status: "healthy",
      database: "PostgreSQL",
      server: "API (Windows)",
      tables_count: tables.length,
      tables: counts,
    });
  } catch (err: any) {
    apiLogger.error({ err }, 'Request failed'); res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/2026-04/collections.json — Shopify-compat collection list
app.get("/api/2026-04/collections.json", scope("read_products"), async (req: Request, res: Response) => {
  const shopId = requireShopContext(req, res);
  if (!shopId) return;
  try {
    const limit = Math.min(250, parseInt(req.query.limit as string) || 50);
    const collections = await db.selectFrom("collections").selectAll().where("shop_id", "=", shopId)
      .orderBy("created_at", "desc").limit(limit).execute();
    res.json({ collections });
  } catch (err: any) { apiLogger.error({ err }, 'Request failed'); res.status(500).json({ error: 'Internal server error' }); }
});

// GET /api/2026-04/pages.json — Shopify-compat pages list
app.get("/api/2026-04/pages.json", scope("read_content"), async (req: Request, res: Response) => {
  const shopId = requireShopContext(req, res);
  if (!shopId) return;
  try {
    const limit = Math.min(250, parseInt(req.query.limit as string) || 50);
    const pages = await db.selectFrom("pages").selectAll().where("shop_id", "=", shopId)
      .orderBy("created_at", "desc").limit(limit).execute();
    res.json({ pages });
  } catch (err: any) { apiLogger.error({ err }, 'Request failed'); res.status(500).json({ error: 'Internal server error' }); }
});

// GET /api/2026-04/webhooks.json — Shopify-compat webhook list
app.get("/api/2026-04/webhooks.json", scope("read_webhooks"), async (req: Request, res: Response) => {
  const shopId = requireShopContext(req, res);
  if (!shopId) return;
  try {
    const webhooks = await db.selectFrom("webhooks").selectAll().where("shop_id", "=", shopId)
      .orderBy("created_at", "desc").execute();
    res.json({ webhooks });
  } catch (err: any) { apiLogger.error({ err }, 'Request failed'); res.status(500).json({ error: 'Internal server error' }); }
});

// POST /api/2026-04/webhooks.json — Shopify-compat webhook create
app.post("/api/2026-04/webhooks.json", scope("write_webhooks"), async (req: Request, res: Response) => {
  const shopId = requireShopContext(req, res);
  if (!shopId) return;
  try {
    const { topic, address, format } = req.body?.webhook ?? req.body ?? {};
    if (!topic || !address) { res.status(400).json({ error: "topic and address are required" }); return; }
    const webhook = await registerWebhook(db, shopId, topic, address, format);
    res.status(201).json({ webhook });
  } catch (err: any) { res.status(400).json({ error: err.message }); }
});

// DELETE /api/2026-04/webhooks/:id.json — Shopify-compat webhook delete
app.delete("/api/2026-04/webhooks/:id.json", scope("write_webhooks"), async (req: Request, res: Response) => {
  const shopId = requireShopContext(req, res);
  if (!shopId) return;
  try {
    await deleteWebhookById(db, req.params.id);
    res.json({ success: true });
  } catch (err: any) { apiLogger.error({ err }, 'Request failed'); res.status(500).json({ error: 'Internal server error' }); }
});

// ---------------------------------------------------------------------------
// METAFIELDS — Shopify-compat CRUD
//
//   Flat API                               Owner-scoped API (Shopify canonical)
//   GET    /metafields.json                GET    /{owner}/:id/metafields.json
//   POST   /metafields.json                POST   /{owner}/:id/metafields.json
//   GET    /metafields/:id.json            (shared — by metafield id)
//   PUT    /metafields/:id.json
//   DELETE /metafields/:id.json
//
//   {owner} ∈ products | variants | collections | customers | orders
//   Shop-level metafields use the flat API with owner_type=shop.
//
//   Auth: JWT bearer → shopContext middleware sets req.shopId. All writes
//   enforce `write_metafields` scope; reads enforce `read_metafields`.
// ---------------------------------------------------------------------------

// Map Shopify REST owner segment → internal owner_type.
const OWNER_SEGMENT_TO_TYPE: Record<string, MetafieldOwnerType> = {
  products: "product",
  variants: "variant",
  collections: "collection",
  customers: "customer",
  orders: "order",
  pages: "page",
  blog_posts: "blog_post",
};

// Parse + validate a metafield input body shape (accepts `{ metafield: {...} }`
// or a flat `{...}`). Returns the parsed input or an { error, status } object.
function parseMetafieldBody(body: any): { ok: true; data: any } | { ok: false; error: string; status: number } {
  const input = body?.metafield ?? body;
  if (!input || typeof input !== "object") {
    return { ok: false, error: "Missing metafield payload", status: 400 };
  }
  if (!input.namespace || typeof input.namespace !== "string") {
    return { ok: false, error: "namespace is required", status: 422 };
  }
  if (!input.key || typeof input.key !== "string") {
    return { ok: false, error: "key is required", status: 422 };
  }
  if (input.value === undefined) {
    return { ok: false, error: "value is required", status: 422 };
  }
  if (input.value_type !== undefined && typeof input.value_type !== "string") {
    return { ok: false, error: "value_type must be a string", status: 422 };
  }
  return { ok: true, data: input };
}

// Convert service-layer Error → HTTP response. Validation errors → 422;
// anything else → 500 (logged).
function sendMetafieldError(res: Response, err: any): void {
  const msg = String(err?.message ?? "");
  if (
    msg.includes("Invalid metafield") ||
    msg.includes("too large") ||
    msg.includes("JSON-serializable")
  ) {
    res.status(422).json({ errors: [msg] });
    return;
  }
  apiLogger.error({ err }, "metafield request failed");
  res.status(500).json({ error: "Internal server error" });
}

// GET /api/2026-04/metafields.json — flat list, filter by ?owner_type&owner_id&namespace
app.get("/api/2026-04/metafields.json", scope("read_metafields"), async (req: Request, res: Response) => {
  const shopId = requireShopContext(req, res);
  if (!shopId) return;
  try {
    const ownerType = (req.query.owner_type as string) || "shop";
    if (!(OWNER_TYPES as readonly string[]).includes(ownerType)) {
      res.status(422).json({ errors: [`Invalid owner_type "${ownerType}"`] });
      return;
    }
    const ownerId = (req.query.owner_id as string) || shopId;
    const namespace = req.query.namespace as string | undefined;
    const metafields = await listMetafields(db, shopId, ownerType as MetafieldOwnerType, ownerId, namespace);
    res.json({ metafields });
  } catch (err: any) { sendMetafieldError(res, err); }
});

// POST /api/2026-04/metafields.json — upsert (flat form)
app.post("/api/2026-04/metafields.json", scope("write_metafields"), async (req: Request, res: Response) => {
  const shopId = requireShopContext(req, res);
  if (!shopId) return;
  const parsed = parseMetafieldBody(req.body);
  if (!parsed.ok) { res.status(parsed.status).json({ errors: [parsed.error] }); return; }
  try {
    const input = parsed.data;
    const metafield = await setMetafield(db, {
      shop_id: shopId,
      owner_type: (input.owner_type || "shop") as MetafieldOwnerType,
      owner_id: input.owner_id || shopId,
      namespace: input.namespace,
      key: input.key,
      value: input.value,
      value_type: input.value_type,
      description: input.description,
    });
    res.status(201).json({ metafield });
  } catch (err: any) { sendMetafieldError(res, err); }
});

// GET /api/2026-04/metafields/:id.json — by ID
app.get("/api/2026-04/metafields/:id.json", scope("read_metafields"), async (req: Request, res: Response) => {
  const shopId = requireShopContext(req, res);
  if (!shopId) return;
  try {
    const metafield = await getMetafieldById(db, shopId, String(req.params.id));
    if (!metafield) { res.status(404).json({ errors: ["Metafield not found"] }); return; }
    res.json({ metafield });
  } catch (err: any) { sendMetafieldError(res, err); }
});

// PUT /api/2026-04/metafields/:id.json — update by ID (only value/value_type/description mutable)
app.put("/api/2026-04/metafields/:id.json", scope("write_metafields"), async (req: Request, res: Response) => {
  const shopId = requireShopContext(req, res);
  if (!shopId) return;
  const input = req.body?.metafield ?? req.body ?? {};
  try {
    const metafield = await updateMetafieldById(db, String(req.params.id), {
      shop_id: shopId,
      value: input.value,
      value_type: input.value_type,
      description: input.description,
    });
    if (!metafield) { res.status(404).json({ errors: ["Metafield not found"] }); return; }
    res.json({ metafield });
  } catch (err: any) { sendMetafieldError(res, err); }
});

// DELETE /api/2026-04/metafields/:id.json — delete by ID
app.delete("/api/2026-04/metafields/:id.json", scope("write_metafields"), async (req: Request, res: Response) => {
  const shopId = requireShopContext(req, res);
  if (!shopId) return;
  try {
    const deleted = await deleteMetafieldById(db, shopId, String(req.params.id));
    if (!deleted) { res.status(404).json({ errors: ["Metafield not found"] }); return; }
    res.status(200).json({ success: true });
  } catch (err: any) { sendMetafieldError(res, err); }
});

// GET /api/2026-04/:ownerSegment/:ownerId/metafields.json — owner-scoped list
//   Shopify canonical: /products/:id/metafields, /customers/:id/metafields, etc.
//   Express 5 / path-to-regexp v8 dropped inline regex captures on params —
//   we validate the segment with OWNER_SEGMENT_TO_TYPE[...] inside the handler
//   (404 on unknown), which preserves the old behavior without the regex.
app.get("/api/2026-04/:ownerSegment/:ownerId/metafields.json", scope("read_metafields"), async (req: Request, res: Response) => {
  const shopId = requireShopContext(req, res);
  if (!shopId) return;
  try {
    const ownerType = OWNER_SEGMENT_TO_TYPE[String(req.params.ownerSegment)];
    if (!ownerType) { res.status(404).json({ errors: ["Unknown owner"] }); return; }
    const namespace = req.query.namespace as string | undefined;
    const metafields = await listMetafields(db, shopId, ownerType, String(req.params.ownerId), namespace);
    res.json({ metafields });
  } catch (err: any) { sendMetafieldError(res, err); }
});

// POST /api/2026-04/:ownerSegment/:ownerId/metafields.json — owner-scoped upsert
//   (Same Express 5 compat note as the GET above — segment validated in handler.)
app.post("/api/2026-04/:ownerSegment/:ownerId/metafields.json", scope("write_metafields"), async (req: Request, res: Response) => {
  const shopId = requireShopContext(req, res);
  if (!shopId) return;
  const parsed = parseMetafieldBody(req.body);
  if (!parsed.ok) { res.status(parsed.status).json({ errors: [parsed.error] }); return; }
  try {
    const ownerType = OWNER_SEGMENT_TO_TYPE[String(req.params.ownerSegment)];
    if (!ownerType) { res.status(404).json({ errors: ["Unknown owner"] }); return; }
    const input = parsed.data;
    const metafield = await setMetafield(db, {
      shop_id: shopId,
      owner_type: ownerType,
      owner_id: String(req.params.ownerId),
      namespace: input.namespace,
      key: input.key,
      value: input.value,
      value_type: input.value_type,
      description: input.description,
    });
    res.status(201).json({ metafield });
  } catch (err: any) { sendMetafieldError(res, err); }
});

// GET /api/2026-04/gift_cards.json — Shopify-compat gift card list
app.get("/api/2026-04/gift_cards.json", scope("read_gift_cards"), async (req: Request, res: Response) => {
  const shopId = requireShopContext(req, res);
  if (!shopId) return;
  try {
    const limit = Math.min(250, parseInt(req.query.limit as string) || 50);
    const result = await listGiftCards(db, shopId, { limit, offset: 0 });
    res.json({ gift_cards: result.giftCards });
  } catch (err: any) { apiLogger.error({ err }, 'Request failed'); res.status(500).json({ error: 'Internal server error' }); }
});

// PUT /api/2026-04/products/:id.json — Shopify-compat product update
app.put("/api/2026-04/products/:id.json", scope("write_products"), async (req: Request, res: Response) => {
  const shopId = requireShopContext(req, res);
  if (!shopId) return;
  try {
    const productData = req.body?.product ?? req.body;
    const allowed = ["title", "body_html", "vendor", "product_type", "tags", "status"];
    const updateFields: any = {};
    for (const key of allowed) {
      if (productData[key] !== undefined) updateFields[key] = productData[key];
    }
    updateFields.updated_at = new Date().toISOString();
    const product = await db.updateTable("products").set(updateFields)
      .where("id", "=", req.params.id).where("shop_id", "=", shopId)
      .returningAll().executeTakeFirst();
    if (!product) { res.status(404).json({ error: "Product not found" }); return; }
    res.json({ product });
  } catch (err: any) { apiLogger.error({ err }, 'Request failed'); res.status(500).json({ error: 'Internal server error' }); }
});

// DELETE /api/2026-04/products/:id.json — Shopify-compat product delete
app.delete("/api/2026-04/products/:id.json", scope("write_products"), async (req: Request, res: Response) => {
  const shopId = requireShopContext(req, res);
  if (!shopId) return;
  try {
    await db.deleteFrom("product_variants").where("product_id", "=", req.params.id).execute();
    await db.deleteFrom("products").where("id", "=", req.params.id).where("shop_id", "=", shopId).execute();
    res.json({ success: true });
  } catch (err: any) { apiLogger.error({ err }, 'Request failed'); res.status(500).json({ error: 'Internal server error' }); }
});

app.get("/api/2026-04/docs.json", (_req: Request, res: Response) => {
  res.json({
    openapi: "3.0.3",
    info: { title: "Gbox Platform API", version: "2026-04" },
    paths: {
      "/api/2026-04/shop.json": { get: { summary: "Get shop info" } },
      "/api/2026-04/products.json": { get: { summary: "List products (read_products scope)" } },
      "/api/2026-04/products/:id.json": { get: { summary: "Get product" }, put: { summary: "Update product" }, delete: { summary: "Delete product" } },
      "/api/2026-04/collections.json": { get: { summary: "List collections (read_products scope)" } },
      "/api/2026-04/orders.json": { get: { summary: "List orders (read_orders scope)" } },
      "/api/2026-04/customers.json": { get: { summary: "List customers (read_customers scope)" } },
      "/api/2026-04/pages.json": { get: { summary: "List pages (read_content scope)" } },
      "/api/2026-04/webhooks.json": { get: { summary: "List webhooks" }, post: { summary: "Create webhook" } },
      "/api/2026-04/webhooks/:id.json": { delete: { summary: "Delete webhook" } },
      "/api/2026-04/metafields.json": { get: { summary: "List metafields" }, post: { summary: "Set metafield" } },
      "/api/2026-04/gift_cards.json": { get: { summary: "List gift cards" } },
      "/api/2026-04/themes.json": { get: { summary: "List themes" } },
      "/api/2026-04/themes/:id/assets.json": { get: { summary: "Get theme asset" }, put: { summary: "Update theme asset" } },
      "/api/2026-04/stats.json": { get: { summary: "Database statistics" } },
    },
  });
});

// ===========================================================================
// PHASE 5 — Theme Customizer & Management API
//
// Endpoints for the admin theme editor: list/create/delete themes, manage
// assets, reorder sections, update settings, export/import, preview,
// marketplace install, and translation management.
// ===========================================================================

import {
  listThemes, getTheme, createTheme, deleteTheme, setActiveTheme,
  getThemeAsset, updateThemeAsset, deleteThemeAsset, listThemeAssets,
  duplicateTheme,
} from "@gbox/core/modules/themes/service.js";
import { reorderSections } from "@gbox/core/modules/themes/section-reorder.js";
import { validateThemeSettings } from "@gbox/core/modules/themes/settings-validator.js";
import { bundleTheme, parseThemeBundle } from "@gbox/core/modules/themes/bundle.js";
import { signPreviewToken, verifyPreviewToken } from "@gbox/core/modules/themes/preview-token.js";

// --- Theme CRUD ---

app.get("/api/store/:slug/themes", storeAccess, async (req: Request, res: Response) => {
  try {
    const themes = await listThemes(db, req.apiStore!.id);
    res.json({ themes });
  } catch (err: any) { apiLogger.error({ err }, 'Request failed'); res.status(500).json({ error: 'Internal server error' }); }
});

app.get("/api/store/:slug/themes/:themeId", storeAccess, async (req: Request, res: Response) => {
  try {
    const theme = await getTheme(db, req.apiStore!.id, req.params.themeId);
    if (!theme) { res.status(404).json({ error: "Theme not found" }); return; }
    res.json({ theme });
  } catch (err: any) { apiLogger.error({ err }, 'Request failed'); res.status(500).json({ error: 'Internal server error' }); }
});

app.post("/api/store/:slug/themes", storeAccess, async (req: Request, res: Response) => {
  try {
    const { name, role } = req.body;
    if (!name) { res.status(400).json({ error: "name is required" }); return; }
    const theme = await createTheme(db, req.apiStore!.id, { name, role });
    res.status(201).json({ theme });
  } catch (err: any) { apiLogger.error({ err }, 'Request failed'); res.status(500).json({ error: 'Internal server error' }); }
});

app.delete("/api/store/:slug/themes/:themeId", storeAccess, async (req: Request, res: Response) => {
  try {
    await deleteTheme(db, req.apiStore!.id, req.params.themeId);
    res.json({ deleted: true });
  } catch (err: any) { res.status(400).json({ error: err.message }); }
});

app.post("/api/store/:slug/themes/:themeId/activate", storeAccess, async (req: Request, res: Response) => {
  try {
    await setActiveTheme(db, req.apiStore!.id, req.params.themeId);
    res.json({ activated: true });
  } catch (err: any) { res.status(400).json({ error: err.message }); }
});

app.post("/api/store/:slug/themes/:themeId/duplicate", storeAccess, async (req: Request, res: Response) => {
  try {
    const { name } = req.body;
    const dup = await duplicateTheme(db, req.apiStore!.id, req.params.themeId, name || undefined);
    res.status(201).json({ theme: dup });
  } catch (err: any) { apiLogger.error({ err }, 'Request failed'); res.status(500).json({ error: 'Internal server error' }); }
});

// --- Theme Assets CRUD ---

app.get("/api/store/:slug/themes/:themeId/assets", storeAccess, async (req: Request, res: Response) => {
  try {
    const assets = await listThemeAssets(db, req.params.themeId);
    res.json({ assets: assets.map((a: any) => ({ key: a.key, size: a.value?.length ?? 0, updated_at: a.updated_at })) });
  } catch (err: any) { apiLogger.error({ err }, 'Request failed'); res.status(500).json({ error: 'Internal server error' }); }
});

// Single asset GET — Shopify pattern: ?key=templates/index.json
app.get("/api/store/:slug/themes/:themeId/asset", storeAccess, async (req: Request, res: Response) => {
  try {
    const key = req.query.key as string;
    if (!key) { res.status(400).json({ error: "key query parameter is required" }); return; }
    const asset = await getThemeAsset(db, req.params.themeId, key);
    if (!asset) { res.status(404).json({ error: "Asset not found" }); return; }
    res.json({ asset: { key: asset.key, value: asset.value, updated_at: asset.updated_at } });
  } catch (err: any) { apiLogger.error({ err }, 'Request failed'); res.status(500).json({ error: 'Internal server error' }); }
});

// Single asset PUT — key in body alongside value
app.put("/api/store/:slug/themes/:themeId/asset", storeAccess, async (req: Request, res: Response) => {
  try {
    const key = (req.body.key || req.query.key) as string;
    const { value } = req.body;
    if (!key) { res.status(400).json({ error: "key is required (body or query)" }); return; }
    if (value === undefined) { res.status(400).json({ error: "value is required" }); return; }
    await updateThemeAsset(db, req.params.themeId, key, value);
    res.json({ updated: true });
  } catch (err: any) { apiLogger.error({ err }, 'Request failed'); res.status(500).json({ error: 'Internal server error' }); }
});

// Single asset DELETE — key via query param
app.delete("/api/store/:slug/themes/:themeId/asset", storeAccess, async (req: Request, res: Response) => {
  try {
    const key = req.query.key as string;
    if (!key) { res.status(400).json({ error: "key query parameter is required" }); return; }
    await deleteThemeAsset(db, req.params.themeId, key);
    res.json({ deleted: true });
  } catch (err: any) { apiLogger.error({ err }, 'Request failed'); res.status(500).json({ error: 'Internal server error' }); }
});

// --- Section Reorder ---

app.post("/api/store/:slug/themes/:themeId/sections/reorder", storeAccess, async (req: Request, res: Response) => {
  try {
    const { from_id, to_id, position } = req.body;
    if (!from_id || !to_id || !position) {
      res.status(400).json({ error: "from_id, to_id, and position (before|after) are required" }); return;
    }
    // Load current template order from index.json
    const indexAsset = await getThemeAsset(db, req.params.themeId, "templates/index.json");
    if (!indexAsset) { res.status(404).json({ error: "templates/index.json not found" }); return; }
    const indexData = JSON.parse(indexAsset.value);
    const currentOrder: string[] = indexData.order || Object.keys(indexData.sections || {});

    const result = reorderSections(currentOrder, from_id, to_id, position, {
      locked: ["header", "footer"],
    });
    if (!result.ok) {
      res.status(400).json({ error: result.error.code, message: result.error.message }); return;
    }
    // Persist new order
    indexData.order = result.order;
    await updateThemeAsset(db, req.params.themeId, "templates/index.json", JSON.stringify(indexData, null, 2));
    res.json({ order: result.order });
  } catch (err: any) { apiLogger.error({ err }, 'Request failed'); res.status(500).json({ error: 'Internal server error' }); }
});

// --- Theme Settings ---

app.get("/api/store/:slug/themes/:themeId/settings", storeAccess, async (req: Request, res: Response) => {
  try {
    const schemaAsset = await getThemeAsset(db, req.params.themeId, "config/settings_schema.json");
    const dataAsset = await getThemeAsset(db, req.params.themeId, "config/settings_data.json");
    res.json({
      schema: schemaAsset ? JSON.parse(schemaAsset.value) : [],
      data: dataAsset ? JSON.parse(dataAsset.value) : {},
    });
  } catch (err: any) { apiLogger.error({ err }, 'Request failed'); res.status(500).json({ error: 'Internal server error' }); }
});

app.put("/api/store/:slug/themes/:themeId/settings", storeAccess, async (req: Request, res: Response) => {
  try {
    const { settings } = req.body;
    if (!settings || typeof settings !== "object") {
      res.status(400).json({ error: "settings object is required" }); return;
    }
    // Load schema for validation
    const schemaAsset = await getThemeAsset(db, req.params.themeId, "config/settings_schema.json");
    if (schemaAsset) {
      const schema = JSON.parse(schemaAsset.value);
      const validation = validateThemeSettings(settings, schema);
      if (!validation.ok) {
        res.status(400).json({ error: "invalid_settings", errors: validation.errors }); return;
      }
    }
    // Load existing data, merge, save
    const dataAsset = await getThemeAsset(db, req.params.themeId, "config/settings_data.json");
    const existing = dataAsset ? JSON.parse(dataAsset.value) : {};
    const merged = { ...existing, current: { ...(existing.current || {}), ...settings } };
    await updateThemeAsset(db, req.params.themeId, "config/settings_data.json", JSON.stringify(merged, null, 2));
    res.json({ updated: true, settings: merged.current });
  } catch (err: any) { apiLogger.error({ err }, 'Request failed'); res.status(500).json({ error: 'Internal server error' }); }
});

// --- Theme Export/Import ---

app.get("/api/store/:slug/themes/:themeId/export", storeAccess, async (req: Request, res: Response) => {
  try {
    const assets = await listThemeAssets(db, req.params.themeId);
    const files: Record<string, string> = {};
    for (const a of assets as any[]) { files[a.key] = a.value; }
    const theme = await getTheme(db, req.apiStore!.id, req.params.themeId);
    const bundle = bundleTheme(files, { name: theme?.name || "exported-theme", version: "1.0.0", author: "Gbox" });
    res.json(bundle);
  } catch (err: any) { apiLogger.error({ err }, 'Request failed'); res.status(500).json({ error: 'Internal server error' }); }
});

app.post("/api/store/:slug/themes/import", storeAccess, async (req: Request, res: Response) => {
  try {
    const { manifest, files } = req.body;
    if (!manifest || !files) { res.status(400).json({ error: "manifest and files are required" }); return; }
    const parsed = parseThemeBundle(manifest, files);
    if (!parsed.ok) { res.status(400).json({ error: "invalid_bundle", errors: parsed.errors }); return; }
    // Create theme and insert all assets
    const theme = await createTheme(db, req.apiStore!.id, { name: parsed.theme.meta.name, role: "unpublished" });
    for (const [key, value] of Object.entries(parsed.theme.files)) {
      await updateThemeAsset(db, (theme as any).id, key, value);
    }
    res.status(201).json({ theme, asset_count: Object.keys(parsed.theme.files).length });
  } catch (err: any) { apiLogger.error({ err }, 'Request failed'); res.status(500).json({ error: 'Internal server error' }); }
});

// --- Theme Preview ---

app.post("/api/store/:slug/themes/:themeId/preview", storeAccess, async (req: Request, res: Response) => {
  try {
    const secret = process.env.PREVIEW_TOKEN_SECRET || process.env.SESSION_SECRET || "gbox-preview-secret";
    const token = signPreviewToken(
      secret,
      { shopId: req.apiStore!.id, themeId: req.params.themeId, adminId: req.apiUser!.id },
    );
    const domain = req.apiStore!.domain || req.apiStore!.custom_domain || `${req.apiStore!.slug}.gbox.co`;
    res.json({ preview_url: `https://${domain}/?preview_token=${token}`, token, expires_in: 3600 });
  } catch (err: any) { apiLogger.error({ err }, 'Request failed'); res.status(500).json({ error: 'Internal server error' }); }
});

// ═══════════════════════════════════════════════════════════════
// PAGE BUILDER API
// ═══════════════════════════════════════════════════════════════

import {
  seedBuiltinSections,
  listSectionSchemas,
  getSectionSchema,
  listPageSections,
  getPageSection,
  addPageSection,
  updateSectionSettings as updatePBSectionSettings,
  updateSectionBlocks as updatePBSectionBlocks,
  updateSectionCss as updatePBSectionCss,
  toggleSection,
  deletePageSection,
  reorderSections as reorderPBSections,
  duplicateSection,
  getGlobalSettings,
  updateGlobalSettings,
  initGlobalSettings,
  createVersion,
  publishVersion,
  listVersions,
  restoreVersion,
  sectionizeAndSave,
  getEditorBridgeScript,
} from "@gbox/core/modules/page-builder/index.js";

// --- Theme ownership helper ---
async function verifyThemeOwnership(themeId: string, shopId: string): Promise<boolean> {
  const theme = await db
    .selectFrom("themes" as any)
    .select("shop_id")
    .where("id", "=", themeId)
    .executeTakeFirst();
  return !!theme && (theme as any).shop_id === shopId;
}

// --- Section Schemas ---

app.get("/api/store/:slug/page-builder/schemas", storeAccess, async (req: Request, res: Response) => {
  try {
    const schemas = await listSectionSchemas(db);
    res.json({ schemas, count: schemas.length });
  } catch (err: any) { apiLogger.error({ err }, 'Request failed'); res.status(500).json({ error: 'Internal server error' }); }
});

app.get("/api/store/:slug/page-builder/schemas/:type", storeAccess, async (req: Request, res: Response) => {
  try {
    const schema = await getSectionSchema(db, req.params.type);
    if (!schema) { res.status(404).json({ error: "Schema not found" }); return; }
    res.json({ schema });
  } catch (err: any) { apiLogger.error({ err }, 'Request failed'); res.status(500).json({ error: 'Internal server error' }); }
});

app.post("/api/store/:slug/page-builder/schemas/seed", storeAccess, async (req: Request, res: Response) => {
  try {
    const count = await seedBuiltinSections(db);
    res.json({ seeded: count });
  } catch (err: any) { apiLogger.error({ err }, 'Request failed'); res.status(500).json({ error: 'Internal server error' }); }
});

// --- Page Sections CRUD ---

app.get("/api/store/:slug/themes/:themeId/page-builder/sections", storeAccess, async (req: Request, res: Response) => {
  try {
    if (!(await verifyThemeOwnership(req.params.themeId, req.apiStore!.id))) { res.status(404).json({ error: "Theme not found" }); return; }
    const pageType = (req.query.page_type as string) || "index";
    const sections = await listPageSections(db, req.params.themeId, pageType);
    res.json({ sections, count: sections.length });
  } catch (err: any) { apiLogger.error({ err }, 'Request failed'); res.status(500).json({ error: 'Internal server error' }); }
});

app.get("/api/store/:slug/themes/:themeId/page-builder/sections/:sectionId", storeAccess, async (req: Request, res: Response) => {
  try {
    if (!(await verifyThemeOwnership(req.params.themeId, req.apiStore!.id))) { res.status(404).json({ error: "Theme not found" }); return; }
    const section = await getPageSection(db, req.params.sectionId);
    if (!section) { res.status(404).json({ error: "Section not found" }); return; }
    res.json({ section });
  } catch (err: any) { apiLogger.error({ err }, 'Request failed'); res.status(500).json({ error: 'Internal server error' }); }
});

app.post("/api/store/:slug/themes/:themeId/page-builder/sections", storeAccess, async (req: Request, res: Response) => {
  try {
    if (!(await verifyThemeOwnership(req.params.themeId, req.apiStore!.id))) { res.status(404).json({ error: "Theme not found" }); return; }
    const { page_type, section_type, position, settings, blocks, custom_css } = req.body;
    if (!page_type || !section_type) {
      res.status(400).json({ error: "page_type and section_type are required" }); return;
    }
    const section = await addPageSection(db, {
      themeId: req.params.themeId,
      pageType: page_type,
      sectionType: section_type,
      position: position ?? 0,
      settings,
      blocks,
      customCss: custom_css,
    });
    res.status(201).json({ section });
  } catch (err: any) { apiLogger.error({ err }, 'Request failed'); res.status(500).json({ error: 'Internal server error' }); }
});

app.put("/api/store/:slug/themes/:themeId/page-builder/sections/:sectionId/settings", storeAccess, async (req: Request, res: Response) => {
  try {
    if (!(await verifyThemeOwnership(req.params.themeId, req.apiStore!.id))) { res.status(404).json({ error: "Theme not found" }); return; }
    const { settings } = req.body;
    if (!settings) { res.status(400).json({ error: "settings object required" }); return; }
    const section = await updatePBSectionSettings(db, req.params.sectionId, settings);
    res.json({ section });
  } catch (err: any) { apiLogger.error({ err }, 'Request failed'); res.status(500).json({ error: 'Internal server error' }); }
});

app.put("/api/store/:slug/themes/:themeId/page-builder/sections/:sectionId/blocks", storeAccess, async (req: Request, res: Response) => {
  try {
    if (!(await verifyThemeOwnership(req.params.themeId, req.apiStore!.id))) { res.status(404).json({ error: "Theme not found" }); return; }
    const { blocks } = req.body;
    if (!Array.isArray(blocks)) { res.status(400).json({ error: "blocks array required" }); return; }
    const section = await updatePBSectionBlocks(db, req.params.sectionId, blocks);
    res.json({ section });
  } catch (err: any) { apiLogger.error({ err }, 'Request failed'); res.status(500).json({ error: 'Internal server error' }); }
});

app.put("/api/store/:slug/themes/:themeId/page-builder/sections/:sectionId/css", storeAccess, async (req: Request, res: Response) => {
  try {
    if (!(await verifyThemeOwnership(req.params.themeId, req.apiStore!.id))) { res.status(404).json({ error: "Theme not found" }); return; }
    const { css } = req.body;
    const section = await updatePBSectionCss(db, req.params.sectionId, css || "");
    res.json({ section });
  } catch (err: any) { apiLogger.error({ err }, 'Request failed'); res.status(500).json({ error: 'Internal server error' }); }
});

app.put("/api/store/:slug/themes/:themeId/page-builder/sections/:sectionId/toggle", storeAccess, async (req: Request, res: Response) => {
  try {
    if (!(await verifyThemeOwnership(req.params.themeId, req.apiStore!.id))) { res.status(404).json({ error: "Theme not found" }); return; }
    const { enabled } = req.body;
    const section = await toggleSection(db, req.params.sectionId, enabled !== false);
    res.json({ section });
  } catch (err: any) { apiLogger.error({ err }, 'Request failed'); res.status(500).json({ error: 'Internal server error' }); }
});

app.delete("/api/store/:slug/themes/:themeId/page-builder/sections/:sectionId", storeAccess, async (req: Request, res: Response) => {
  try {
    if (!(await verifyThemeOwnership(req.params.themeId, req.apiStore!.id))) { res.status(404).json({ error: "Theme not found" }); return; }
    await deletePageSection(db, req.params.sectionId);
    res.json({ deleted: true });
  } catch (err: any) { apiLogger.error({ err }, 'Request failed'); res.status(500).json({ error: 'Internal server error' }); }
});

app.put("/api/store/:slug/themes/:themeId/page-builder/sections/reorder", storeAccess, async (req: Request, res: Response) => {
  try {
    if (!(await verifyThemeOwnership(req.params.themeId, req.apiStore!.id))) { res.status(404).json({ error: "Theme not found" }); return; }
    const { page_type, order } = req.body;
    if (!page_type || !Array.isArray(order)) {
      res.status(400).json({ error: "page_type and order array required" }); return;
    }
    await reorderPBSections(db, req.params.themeId, page_type, order);
    res.json({ reordered: true });
  } catch (err: any) { apiLogger.error({ err }, 'Request failed'); res.status(500).json({ error: 'Internal server error' }); }
});

app.post("/api/store/:slug/themes/:themeId/page-builder/sections/:sectionId/duplicate", storeAccess, async (req: Request, res: Response) => {
  try {
    if (!(await verifyThemeOwnership(req.params.themeId, req.apiStore!.id))) { res.status(404).json({ error: "Theme not found" }); return; }
    const section = await duplicateSection(db, req.params.sectionId);
    res.status(201).json({ section });
  } catch (err: any) { apiLogger.error({ err }, 'Request failed'); res.status(500).json({ error: 'Internal server error' }); }
});

// --- Auto-Sectionize ---

app.post("/api/store/:slug/themes/:themeId/page-builder/sectionize", storeAccess, async (req: Request, res: Response) => {
  try {
    if (!(await verifyThemeOwnership(req.params.themeId, req.apiStore!.id))) { res.status(404).json({ error: "Theme not found" }); return; }
    const { page_type, html, source_url } = req.body;
    if (!page_type || !html) {
      res.status(400).json({ error: "page_type and html required" }); return;
    }
    const sections = await sectionizeAndSave(db, req.params.themeId, page_type, html, source_url);
    res.status(201).json({ sections, count: sections.length });
  } catch (err: any) { apiLogger.error({ err }, 'Request failed'); res.status(500).json({ error: 'Internal server error' }); }
});

// --- Global Settings ---

app.get("/api/store/:slug/themes/:themeId/page-builder/global-settings", storeAccess, async (req: Request, res: Response) => {
  try {
    if (!(await verifyThemeOwnership(req.params.themeId, req.apiStore!.id))) { res.status(404).json({ error: "Theme not found" }); return; }
    let settings = await getGlobalSettings(db, req.params.themeId);
    if (!settings) {
      settings = await initGlobalSettings(db, req.params.themeId);
    }
    res.json({ settings });
  } catch (err: any) { apiLogger.error({ err }, 'Request failed'); res.status(500).json({ error: 'Internal server error' }); }
});

app.put("/api/store/:slug/themes/:themeId/page-builder/global-settings", storeAccess, async (req: Request, res: Response) => {
  try {
    if (!(await verifyThemeOwnership(req.params.themeId, req.apiStore!.id))) { res.status(404).json({ error: "Theme not found" }); return; }
    const { settings } = req.body;
    if (!settings) { res.status(400).json({ error: "settings object required" }); return; }
    const result = await updateGlobalSettings(db, req.params.themeId, settings);
    res.json({ settings: result });
  } catch (err: any) { apiLogger.error({ err }, 'Request failed'); res.status(500).json({ error: 'Internal server error' }); }
});

// --- Theme Versions ---

app.get("/api/store/:slug/themes/:themeId/page-builder/versions", storeAccess, async (req: Request, res: Response) => {
  try {
    if (!(await verifyThemeOwnership(req.params.themeId, req.apiStore!.id))) { res.status(404).json({ error: "Theme not found" }); return; }
    const versions = await listVersions(db, req.params.themeId);
    res.json({ versions, count: versions.length });
  } catch (err: any) { apiLogger.error({ err }, 'Request failed'); res.status(500).json({ error: 'Internal server error' }); }
});

app.post("/api/store/:slug/themes/:themeId/page-builder/versions", storeAccess, async (req: Request, res: Response) => {
  try {
    if (!(await verifyThemeOwnership(req.params.themeId, req.apiStore!.id))) { res.status(404).json({ error: "Theme not found" }); return; }
    const { label } = req.body;
    const version = await createVersion(db, req.params.themeId, {
      label,
      createdBy: req.apiUser?.id,
    });
    res.status(201).json({ version });
  } catch (err: any) { apiLogger.error({ err }, 'Request failed'); res.status(500).json({ error: 'Internal server error' }); }
});

app.post("/api/store/:slug/themes/:themeId/page-builder/versions/:versionId/publish", storeAccess, async (req: Request, res: Response) => {
  try {
    if (!(await verifyThemeOwnership(req.params.themeId, req.apiStore!.id))) { res.status(404).json({ error: "Theme not found" }); return; }
    const version = await publishVersion(db, req.params.versionId);
    res.json({ version });
  } catch (err: any) { apiLogger.error({ err }, 'Request failed'); res.status(500).json({ error: 'Internal server error' }); }
});

app.post("/api/store/:slug/themes/:themeId/page-builder/versions/:versionId/restore", storeAccess, async (req: Request, res: Response) => {
  try {
    if (!(await verifyThemeOwnership(req.params.themeId, req.apiStore!.id))) { res.status(404).json({ error: "Theme not found" }); return; }
    await restoreVersion(db, req.params.versionId);
    res.json({ restored: true });
  } catch (err: any) { apiLogger.error({ err }, 'Request failed'); res.status(500).json({ error: 'Internal server error' }); }
});

// --- Editor Bridge Script ---

app.get("/api/store/:slug/page-builder/bridge.js", (req: Request, res: Response) => {
  res.setHeader("Content-Type", "application/javascript");
  res.setHeader("Cache-Control", "public, max-age=300");
  // Pass admin origin so the bridge script can validate postMessage sources
  const adminOrigin = `${req.protocol}://${req.get('host')}`;
  res.send(getEditorBridgeScript(adminOrigin));
});

// --- Translation Management ---

app.get("/api/store/:slug/translations", storeAccess, async (req: Request, res: Response) => {
  try {
    const locale = (req.query.locale as string) || "en";
    const namespace = (req.query.namespace as string) || undefined;
    let query = db.selectFrom("translations").selectAll().where("shop_id", "=", req.apiStore!.id).where("locale", "=", locale);
    if (namespace) query = query.where("namespace", "=", namespace);
    const rows = await query.orderBy("key", "asc").execute();
    res.json({ translations: rows, count: rows.length });
  } catch (err: any) { apiLogger.error({ err }, 'Request failed'); res.status(500).json({ error: 'Internal server error' }); }
});

app.put("/api/store/:slug/translations", storeAccess, async (req: Request, res: Response) => {
  try {
    const { locale, key, value, namespace } = req.body;
    if (!locale || !key || value === undefined) {
      res.status(400).json({ error: "locale, key, and value are required" }); return;
    }
    await db.insertInto("translations").values({
      shop_id: req.apiStore!.id, locale, key, value, namespace: namespace || "theme",
    } as any).onConflict((oc) =>
      oc.columns(["shop_id", "locale", "key"] as any).doUpdateSet({ value, updated_at: new Date().toISOString() } as any)
    ).execute();
    res.json({ updated: true });
  } catch (err: any) { apiLogger.error({ err }, 'Request failed'); res.status(500).json({ error: 'Internal server error' }); }
});

app.delete("/api/store/:slug/translations/:id", storeAccess, async (req: Request, res: Response) => {
  try {
    await db.deleteFrom("translations").where("id", "=", req.params.id).where("shop_id", "=", req.apiStore!.id).execute();
    res.json({ deleted: true });
  } catch (err: any) { apiLogger.error({ err }, 'Request failed'); res.status(500).json({ error: 'Internal server error' }); }
});

// --- Custom Domain & SSL Management ---

import { addCustomDomain, verifyAndProvision, removeCustomDomain, listShopDomains } from "@gbox/core/modules/domains/index.js";

app.get("/api/store/:slug/domains", storeAccess, async (req: Request, res: Response) => {
  try {
    const domains = await listShopDomains(db, req.apiStore!.id);
    res.json({ domains });
  } catch (err: any) { apiLogger.error({ err }, 'Request failed'); res.status(500).json({ error: 'Internal server error' }); }
});

app.post("/api/store/:slug/domains", storeAccess, async (req: Request, res: Response) => {
  try {
    const { domain } = req.body;
    if (!domain) { res.status(400).json({ error: "domain is required" }); return; }
    const result = await addCustomDomain(db, req.apiStore!.id, domain);
    res.status(201).json(result);
  } catch (err: any) { res.status(400).json({ error: err.message }); }
});

app.post("/api/store/:slug/domains/verify", storeAccess, async (req: Request, res: Response) => {
  try {
    const { domain } = req.body;
    if (!domain) { res.status(400).json({ error: "domain is required" }); return; }
    const result = await verifyAndProvision(db, req.apiStore!.id, domain);
    res.json(result);
  } catch (err: any) { apiLogger.error({ err }, 'Request failed'); res.status(500).json({ error: 'Internal server error' }); }
});

app.delete("/api/store/:slug/domains/:domain", storeAccess, async (req: Request, res: Response) => {
  try {
    const deleted = await removeCustomDomain(db, req.apiStore!.id, req.params.domain);
    res.json({ deleted });
  } catch (err: any) { apiLogger.error({ err }, 'Request failed'); res.status(500).json({ error: 'Internal server error' }); }
});

// --- Shopify-compat Theme API ---

app.get("/api/2026-04/themes.json", scope("read_themes"), async (req: Request, res: Response) => {
  const shopId = requireShopContext(req, res);
  if (!shopId) return;
  try {
    const themes = await listThemes(db, shopId);
    res.json({ themes });
  } catch (err: any) { apiLogger.error({ err }, 'Request failed'); res.status(500).json({ error: 'Internal server error' }); }
});

app.get("/api/2026-04/themes/:id/assets.json", scope("read_themes"), async (req: Request, res: Response) => {
  const shopId = requireShopContext(req, res);
  if (!shopId) return;
  try {
    const key = req.query.key as string;
    if (key) {
      const asset = await getThemeAsset(db, req.params.id, key);
      if (!asset) { res.status(404).json({ error: "Asset not found" }); return; }
      res.json({ asset: { key: asset.key, value: asset.value } });
    } else {
      const assets = await listThemeAssets(db, req.params.id);
      res.json({ assets: assets.map((a: any) => ({ key: a.key, size: a.value?.length ?? 0 })) });
    }
  } catch (err: any) { apiLogger.error({ err }, 'Request failed'); res.status(500).json({ error: 'Internal server error' }); }
});

app.put("/api/2026-04/themes/:id/assets.json", scope("write_themes"), async (req: Request, res: Response) => {
  const shopId = requireShopContext(req, res);
  if (!shopId) return;
  try {
    const { key, value } = req.body?.asset || {};
    if (!key || value === undefined) { res.status(400).json({ error: "asset.key and asset.value are required" }); return; }
    await updateThemeAsset(db, req.params.id, key, value);
    res.json({ asset: { key, value } });
  } catch (err: any) { apiLogger.error({ err }, 'Request failed'); res.status(500).json({ error: 'Internal server error' }); }
});

// ===========================================================================
// G.6: Apps / Plugin System APIs
// ===========================================================================

import {
  listAppDefinitions,
  getInstalledApps,
  installApp,
  uninstallApp,
  updateAppConfig,
} from "@gbox/core/modules/apps/service.js";

// GET /api/apps/marketplace — Public: list available app definitions
app.get("/api/apps/marketplace", async (req: Request, res: Response) => {
  try {
    const search = (req.query.search as string) || undefined;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
    const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);
    const result = await listAppDefinitions(db, search ? { search } : {}, { limit, offset });
    res.json(result);
  } catch (err: any) {
    apiLogger.error({ err }, 'Request failed'); res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/store/:slug/apps — List installed apps for a store
app.get("/api/store/:slug/apps", storeAccess, async (req: Request, res: Response) => {
  try {
    const apps = await getInstalledApps(db, req.apiStore!.id);
    res.json({ apps, count: apps.length });
  } catch (err: any) {
    apiLogger.error({ err }, 'Request failed'); res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/store/:slug/apps/install — Install an app
app.post("/api/store/:slug/apps/install", storeAccess, async (req: Request, res: Response) => {
  try {
    const { app_id, config } = req.body;
    if (!app_id) {
      res.status(400).json({ error: "app_id is required" });
      return;
    }
    const installation = await installApp(db, req.apiStore!.id, app_id, config);
    res.status(201).json(installation);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/store/:slug/apps/:appId/uninstall — Uninstall an app
app.post("/api/store/:slug/apps/:appId/uninstall", storeAccess, async (req: Request, res: Response) => {
  try {
    await uninstallApp(db, req.apiStore!.id, req.params.appId);
    res.json({ uninstalled: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// GET /api/store/:slug/apps/:appId/config — Get app config
app.get("/api/store/:slug/apps/:appId/config", storeAccess, async (req: Request, res: Response) => {
  try {
    const apps = await getInstalledApps(db, req.apiStore!.id);
    const installation = apps.find((a) => a.app_id === req.params.appId);
    if (!installation) {
      res.status(404).json({ error: "App not installed" });
      return;
    }
    res.json({
      app_id: installation.app_id,
      config: installation.config,
      app: installation.app,
    });
  } catch (err: any) {
    apiLogger.error({ err }, 'Request failed'); res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/store/:slug/apps/:appId/config — Update app config
app.put("/api/store/:slug/apps/:appId/config", storeAccess, async (req: Request, res: Response) => {
  try {
    const { config } = req.body;
    if (!config || typeof config !== "object") {
      res.status(400).json({ error: "config must be a JSON object" });
      return;
    }
    const apps = await getInstalledApps(db, req.apiStore!.id);
    const installation = apps.find((a) => a.app_id === req.params.appId);
    if (!installation) {
      res.status(404).json({ error: "App not installed" });
      return;
    }
    const updated = await updateAppConfig(db, installation.id, config);
    res.json(updated);
  } catch (err: any) {
    apiLogger.error({ err }, 'Request failed'); res.status(500).json({ error: 'Internal server error' });
  }
});

// ===========================================================================
// Plugin Route Proxy
//
// ALL /api/store/:slug/plugins/:pluginId/* — Proxy to plugin's registered
// routes. Looks up app_installation, checks if it has routes config, and
// forwards the request to the plugin's registered handler URL.
// ===========================================================================

app.all("/api/store/:slug/plugins/:pluginId/*splat", storeAccess, async (req: Request, res: Response) => {
  try {
    const { pluginId } = req.params;
    const shopId = req.apiStore!.id;

    // Look up the app installation for this plugin
    const installation = await db
      .selectFrom("app_installations")
      .innerJoin("app_definitions", "app_definitions.id", "app_installations.app_id")
      .select([
        "app_installations.id",
        "app_installations.config",
        "app_installations.status",
        "app_definitions.url",
        "app_definitions.slug",
      ])
      .where("app_installations.shop_id", "=", shopId)
      .where("app_definitions.slug", "=", pluginId)
      .where("app_installations.status", "=", "active")
      .executeTakeFirst();

    if (!installation) {
      res.status(404).json({ error: "Plugin not found or not installed" });
      return;
    }

    if (!installation.url) {
      res.status(502).json({ error: "Plugin has no registered URL endpoint" });
      return;
    }

    // Extract the sub-path after /plugins/:pluginId/
    const prefixPattern = `/api/store/${req.params.slug}/plugins/${pluginId}/`;
    const subPath = req.originalUrl.slice(req.originalUrl.indexOf(prefixPattern) + prefixPattern.length);

    // Forward the request to the plugin's URL
    const targetUrl = `${installation.url.replace(/\/$/, "")}/${subPath}`;
    const headers: Record<string, string> = {
      "Content-Type": req.headers["content-type"] || "application/json",
      "X-Gbox-Shop-Id": shopId,
      "X-Gbox-Plugin-Id": pluginId,
      "X-Gbox-Installation-Id": installation.id,
    };

    const fetchOptions: RequestInit = {
      method: req.method,
      headers,
    };

    if (["POST", "PUT", "PATCH"].includes(req.method) && req.body) {
      fetchOptions.body = JSON.stringify(req.body);
    }

    const proxyResponse = await fetch(targetUrl, fetchOptions);
    const contentType = proxyResponse.headers.get("content-type") || "application/json";

    res.status(proxyResponse.status);
    res.set("Content-Type", contentType);

    if (contentType.includes("application/json")) {
      const data = await proxyResponse.json();
      res.json(data);
    } else {
      const text = await proxyResponse.text();
      res.send(text);
    }
  } catch (err: any) {
    apiLogger.error({ err }, 'Plugin proxy error');
    res.status(502).json({
      error: "Plugin proxy error",
    });
  }
});

// ===========================================================================
// Global Express error handler
//
// Per-route try/catch already covers the happy path, but anything that
// throws synchronously inside middleware (or rejects from a handler that
// forgot to wrap in try/catch) used to take down the response with a
// blank 500. This 4-arg handler is the safety net.
// ===========================================================================

app.use(shopifyErrorHandler({
  notifyFn: (err, req) => {
    // Insert admin notification on 5xx errors (fire-and-forget)
    db.insertInto("notifications")
      .values({
        shop_id: (req as any).apiStore?.id || (req as any).store?.id || null,
        type: "system" as any,
        title: "Server Error (5xx)",
        message: `${req.method} ${req.originalUrl}: ${err?.message || "Unknown"}`,
        resource_type: "error",
        resource_id: (req as any).correlationId || null,
      })
      .execute()
      .catch(() => {});
  },
}));

// ===========================================================================
// Server startup & graceful shutdown
// ===========================================================================

// Install process-level error handlers (uncaughtException, unhandledRejection)
installProcessErrorHandlers("gbox-api");

const PORT = parseInt(process.env.PORT || "4321");

const server = app.listen(PORT, "0.0.0.0", () => {
  apiLogger.info({ port: PORT, pid: process.pid }, `GBOX API SERVER running on http://0.0.0.0:${PORT}`);
  console.log(`\n  GBOX API SERVER running on http://0.0.0.0:${PORT}`);
  console.log(`  PID: ${process.pid} | Routes: /health, /api/god/*, /api/store/:slug/*, /api/2026-04/*\n`);

  // -------------------------------------------------------------------------
  // Daily metrics roll-up cron (PRINCIPLES.md P14, Phase 6 PR1)
  //
  // Two-track scheduling:
  //   1. Legacy boot-time scheduler — runs once at boot (catches up if the
  //      process was down at 00:05 UTC) and then every 24h.
  //   2. cron_tasks row (schedule='daily', handler='rollup_daily_metrics')
  //      picked up by the Lenful cron executor tick every ~60s. Gives the
  //      admin/cron UI a visible row with last_run_at / next_run_at.
  //
  // Both paths call the same `rollupYesterdayAllShops` / `rollupDay`
  // implementation which is fully idempotent — safe if both fire on the
  // same day because the underlying upsert is ON CONFLICT DO UPDATE.
  //
  // Disabled if `DISABLE_METRICS_CRON=1` (e.g. when running as a worker
  // replica without the cron role).
  // -------------------------------------------------------------------------
  if (process.env.DISABLE_METRICS_CRON !== "1") {
    const runRollup = async () => {
      try {
        const count = await rollupYesterdayAllShops(db);
        apiLogger.info({ count }, "[daily-metrics] rollup complete");
      } catch (err: any) {
        apiLogger.error({ err: err.message }, "[daily-metrics] rollup failed");
      }
    };
    // Run once on boot, then every 24h.
    setTimeout(runRollup, 30_000); // 30s after boot, give DB time to warm
    setInterval(runRollup, 24 * 60 * 60 * 1000);

    // Seed the cron_tasks row so the handler appears in the cron driver +
    // admin UI. Handler itself is registered at module-load in
    // modules/cron/service.ts → registerHandler('rollup_daily_metrics', …).
    seedAnalyticsCronTasks(db)
      .then((r) => {
        apiLogger.info(
          { inserted: r.inserted, existing: r.existing },
          "[analytics-cron] tasks seeded",
        );
      })
      .catch((err: any) => {
        apiLogger.error(
          { err: err?.message ?? String(err) },
          "[analytics-cron] seed failed",
        );
      });

    // Phase 8 PR1 — seed the `dispatch_campaigns` cron task. Handler is
    // registered at module-load in modules/cron/service.ts. Every 5 min
    // the driver picks campaigns whose `scheduled_at <= now()` and sends
    // the drafted email blast.
    seedCampaignsCronTasks(db)
      .then((r) => {
        apiLogger.info(
          { inserted: r.inserted, existing: r.existing },
          "[campaigns-cron] tasks seeded",
        );
      })
      .catch((err: any) => {
        apiLogger.error(
          { err: err?.message ?? String(err) },
          "[campaigns-cron] seed failed",
        );
      });

    // Phase 8 PR2 — seed the `dispatch_abandoned_cart_steps` cron task.
    // Without this seed, the handler is registered (service.ts) but no
    // cron_tasks row ever exists, so `executeDueJobs` never picks it up
    // and abandoned-cart recovery emails silently never fire. Every 30
    // min the driver detects eligible open checkouts, enrols them, and
    // walks pending enrolments through the flow engine to send step
    // emails via SMTP.
    seedAbandonedCartCronTasks(db)
      .then((r) => {
        apiLogger.info(
          { inserted: r.inserted, existing: r.existing },
          "[abandoned-cart-cron] tasks seeded",
        );
      })
      .catch((err: any) => {
        apiLogger.error(
          { err: err?.message ?? String(err) },
          "[abandoned-cart-cron] seed failed",
        );
      });

    // Phase 10 PR2 follow-up — seed the `process_pending_gift_cards` cron
    // task. PR2 landed the `send_at` column + `processPendingGiftCardEmails`
    // batch dispatcher but never wired a cron_tasks row for it, so
    // scheduled gift-card delivery silently never fired on prod. Handler
    // is registered at module-load in modules/cron/service.ts. Every 5
    // min the driver picks cards whose send_at <= now() with
    // email_sent_at IS NULL and dispatches them via SMTP (shop template
    // override honoured).
    seedGiftCardCronTasks(db)
      .then((r) => {
        apiLogger.info(
          { inserted: r.inserted, existing: r.existing },
          "[gift-card-cron] tasks seeded",
        );
      })
      .catch((err: any) => {
        apiLogger.error(
          { err: err?.message ?? String(err) },
          "[gift-card-cron] seed failed",
        );
      });

    // Phase 12.5 PR6 — seed the 4 support cron tasks (SLA tick every 5min,
    // CSAT prompt + auto-close every 15min, retention cleanup quarterly).
    // Handlers are registered at module-load in modules/cron/service.ts;
    // this just ensures cron_tasks rows exist so executeDueJobs() can pick
    // them up. Idempotent — re-running on boot is a no-op when rows exist.
    // DISABLE_SUPPORT_CRON=1 on replica nodes that should not run the jobs.
    if (process.env.DISABLE_SUPPORT_CRON !== "1") {
      seedSupportCronTasks(db)
        .then((r) => {
          apiLogger.info(
            { inserted: r.inserted, existing: r.existing },
            "[support-cron] tasks seeded",
          );
        })
        .catch((err: any) => {
          apiLogger.error(
            { err: err?.message ?? String(err) },
            "[support-cron] seed failed",
          );
        });
    }

    // Phase 14 PR7 (BUG-E4) — soft-bounce rollup seed. Handler lives in
    // modules/cron/service.ts; this ensures the cron_tasks row exists
    // so executeDueJobs picks it up. DISABLE_EMAIL_CRON=1 kills it on
    // replicas. Schedule `daily` → driver runs roughly once every 24h
    // (calculateNextRun default for unknown-schedule strings).
    if (process.env.DISABLE_EMAIL_CRON !== "1") {
      seedEmailCronTasks(db)
        .then((r) => {
          apiLogger.info(
            { inserted: r.inserted, existing: r.existing },
            "[email-cron] tasks seeded",
          );
        })
        .catch((err: any) => {
          apiLogger.error(
            { err: err?.message ?? String(err) },
            "[email-cron] seed failed",
          );
        });

      // Phase 14 PR8 (bug 9) — zombie-queued janitor. Reaps rows left at
      // status='queued' past the grace period (10 min) so the admin UI's
      // counter stays honest and the bug-8 idempotency fast-path doesn't
      // keep hitting zombie rows forever. Handler registered at
      // module-load in modules/cron/service.ts; this seeds the
      // cron_tasks row. Runs every 5 minutes. DISABLE_EMAIL_CRON=1
      // disables BOTH this and the soft-bounce aggregator on replicas.
      seedEmailZombieJanitorCron(db)
        .then((r) => {
          apiLogger.info(
            { inserted: r.inserted, existing: r.existing },
            "[email-zombie-janitor-cron] tasks seeded",
          );
        })
        .catch((err: any) => {
          apiLogger.error(
            { err: err?.message ?? String(err) },
            "[email-zombie-janitor-cron] seed failed",
          );
        });
    }
  }

  // -------------------------------------------------------------------------
  // Lenful fulfillment cron jobs (Phase F7)
  //
  // Three recurring jobs wired via the existing cron_tasks driver:
  //   • lenful_auto_push_sweep  — hourly safety-net for inline mark_paid hook
  //   • lenful_sync_tracking    — hourly /api/order/tracking_item poll
  //   • lenful_capture_wallet   — daily wallet balance snapshot + alert
  //
  // Register handlers in-process (side-effect only), seed cron_tasks rows
  // if they don't exist yet, then poll the executor once per minute. Set
  // DISABLE_LENFUL_CRON=1 on replica nodes that should not run the jobs.
  // -------------------------------------------------------------------------
  if (process.env.DISABLE_LENFUL_CRON !== "1") {
    try {
      registerLenfulCronHandlers();
      seedLenfulCronTasks(db)
        .then((r) => {
          apiLogger.info(
            { inserted: r.inserted, existing: r.existing },
            "[lenful-cron] tasks seeded",
          );
        })
        .catch((err: any) => {
          apiLogger.error(
            { err: err?.message ?? String(err) },
            "[lenful-cron] seed failed",
          );
        });
      // Poll once a minute; executeDueJobs picks up any task whose
      // next_run_at is in the past and runs it through the registered
      // handler. Handlers catch their own errors so a single failure
      // doesn't kill the tick.
      const runLenfulTick = async () => {
        try {
          const results = await executeDueJobs(db);
          if (results.length > 0) {
            apiLogger.info(
              { results: results.map((r) => ({ name: r.name, status: r.status, ms: r.durationMs })) },
              "[lenful-cron] tick complete",
            );
          }
        } catch (err: any) {
          apiLogger.error(
            { err: err?.message ?? String(err) },
            "[lenful-cron] tick failed",
          );
        }
      };
      setTimeout(runLenfulTick, 45_000); // 45s after boot
      setInterval(runLenfulTick, 60_000); // every minute
      console.log("  Lenful cron jobs wired: auto_push_sweep, sync_tracking, capture_wallet");
    } catch (err: any) {
      apiLogger.error(
        { err: err?.message ?? String(err) },
        "[lenful-cron] setup failed",
      );
    }
  }

  // -------------------------------------------------------------------------
  // BullMQ workers (Decision #8)
  //
  // Currently runs in-process alongside the API. When traffic justifies it,
  // set DISABLE_QUEUE_WORKERS=1 here and run a dedicated worker process via
  // PM2 that calls startWorkers(db) standalone — no producer-side change.
  // -------------------------------------------------------------------------
  if (process.env.DISABLE_QUEUE_WORKERS !== "1") {
    try {
      // Phase 3 close-the-loop — register stub handlers for every
      // OrderProcessingKind BEFORE starting the worker so post-
      // checkout fan-out jobs have something to dispatch to instead
      // of retrying to exhaustion. Real email / analytics senders
      // should call registerOrderHandler(...) AFTER this to
      // override the specific kinds they implement.
      registerDefaultOrderHandlers((msg) =>
        apiLogger.info({ subsystem: "order-processing" }, msg),
      );
      startWorkers(db);
      apiLogger.info(
        { queues: ["webhook-delivery", "order-processing"] },
        "[queue] workers started",
      );
      console.log(
        "  BullMQ workers started: webhook-delivery, order-processing (stub handlers)",
      );
    } catch (err: any) {
      apiLogger.error({ err: err.message }, "[queue] failed to start workers");
    }
  }
});

// Configure keep-alive for Nginx upstream connections
configureKeepAlive(server);

async function gracefulShutdown(signal: string) {
  apiLogger.info({ signal }, 'Shutting down gracefully...');
  console.log(`\n  ${signal} received — shutting down gracefully...`);

  server.close(async () => {
    try {
      // Stop accepting new BullMQ jobs first so in-flight handlers can
      // finish before we tear down the DB pool they depend on.
      await stopWorkers();
      await closeAllQueues();
      await Promise.all([
        destroyDb(db),
        closeRedis(),
        closeQueueConnection(),
      ]);
      console.log("  Database pool + Redis + queue connections closed.");
    } catch (err) {
      console.error("  Error during shutdown:", err);
    }
    process.exit(0);
  });

  // Force exit after 10 seconds if graceful shutdown hangs
  setTimeout(() => {
    console.error("  Forced shutdown after timeout.");
    process.exit(1);
  }, 10_000);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
