/**
 * SP-01: Shared Session & Cookie System
 *
 * Session cookie shared across ALL .gbox.co subdomains:
 * - accounts.gbox.co (creates sessions)
 * - admin.gbox.co (reads sessions, verifies shop access)
 * - {slug}.gbox.co (reads sessions for customer accounts)
 * - checkout.gbox.co (reads sessions for customer info)
 *
 * Cookie: gbox_session (domain=.gbox.co, HttpOnly, Secure, SameSite=Lax)
 * Storage: PostgreSQL sessions table
 * TTL: 30 days sliding window
 */

import { Kysely } from "kysely";
import { createHash, randomBytes } from "crypto";
import { cacheGet, cacheSet, cacheDel, cacheDelPattern } from "../cache/redis.js";

// ============ TYPES ============

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: string;
  avatarUrl: string | null;
}

export interface SessionData {
  user: SessionUser;
  shopId: string | null;
  shopRole: string | null;
  createdAt: string;
  expiresAt: string;
}

export interface SessionValidationResult {
  valid: boolean;
  session: SessionData | null;
  token: string | null;
}

export interface CookieOptions {
  domain: string;
  path: string;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "lax" | "strict" | "none";
  maxAge: number;
}

// ============ CONSTANTS ============

const SESSION_COOKIE_NAME = "gbox_session";
const SESSION_TTL_DAYS = 30;
const SESSION_TTL_MS = SESSION_TTL_DAYS * 24 * 60 * 60 * 1000;
const SLIDING_WINDOW_THRESHOLD_MS = 24 * 60 * 60 * 1000; // Extend if < 1 day left

// ============ TOKEN GENERATION ============

function generateSessionToken(): string {
  return randomBytes(32).toString("hex");
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// ============ COOKIE HELPERS ============

export function getSessionCookieOptions(isProduction: boolean): CookieOptions {
  // Session cookie domain resolution:
  //
  //   1. `SESSION_COOKIE_DOMAIN` env var — explicit override, e.g.
  //      `.gbox.co` (prod), `.thaibeotit.com` (dev), `.staging.gbox.co` (staging).
  //      Always use a leading dot if you want the cookie shared across
  //      accounts.*, admin.*, {slug}.*, checkout.* subdomains.
  //
  //   2. Empty string — browser scopes the cookie to the EXACT request host,
  //      which is the safe default for single-host / localhost dev.
  //
  // The old hard-coded `.gbox.co` branch broke every non-gbox.co production
  // deploy (thaibeotit.com, custom staging, future tenants): login_success
  // was written to the audit log but the browser silently dropped the
  // `Set-Cookie` because the Domain attribute didn't match the request host,
  // so the very next request looked logged-out — the user would see the
  // login form again right after submitting correct credentials.
  const envDomain = (process.env.SESSION_COOKIE_DOMAIN ?? "").trim();
  return {
    domain: envDomain,
    path: "/",
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax",
    maxAge: SESSION_TTL_MS / 1000, // seconds
  };
}

export function serializeSessionCookie(
  token: string,
  options: CookieOptions
): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=${token}`,
    ...(options.domain ? [`Domain=${options.domain}`] : []),
    `Path=${options.path}`,
    `Max-Age=${options.maxAge}`,
    `SameSite=${options.sameSite.charAt(0).toUpperCase() + options.sameSite.slice(1)}`,
  ];
  if (options.httpOnly) parts.push("HttpOnly");
  if (options.secure) parts.push("Secure");
  return parts.join("; ");
}

export function parseCookies(cookieHeader: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!cookieHeader) return cookies;
  for (const pair of cookieHeader.split(";")) {
    const [key, ...val] = pair.trim().split("=");
    if (key) cookies[key.trim()] = val.join("=").trim();
  }
  return cookies;
}

export function getSessionTokenFromCookies(cookieHeader: string): string | null {
  const cookies = parseCookies(cookieHeader);
  return cookies[SESSION_COOKIE_NAME] || null;
}

export function clearSessionCookie(isProduction: boolean): string {
  // Why both Max-Age=0 AND Expires=<epoch>? Older iOS Safari and some
  // corporate proxies ignore Max-Age and require Expires in the past.
  // Setting both makes "cookie is GONE right now" unambiguous across the
  // browser long tail. SameSite=Lax mirrors what we set on the auth cookie
  // so the Set-Cookie matches and the browser actually replaces (not
  // appends) the value.
  const opts = getSessionCookieOptions(isProduction);
  const domainPart = opts.domain ? `Domain=${opts.domain}; ` : "";
  return `${SESSION_COOKIE_NAME}=; ${domainPart}Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax; HttpOnly${opts.secure ? "; Secure" : ""}`;
}

// ============ SESSION CRUD ============

/**
 * Create a new session for a user
 * Returns the raw token (to set in cookie) — only time it's available
 */
export async function createSession(
  db: Kysely<any>,
  userId: string,
  meta: { ipAddress?: string; userAgent?: string } = {}
): Promise<{ token: string; expiresAt: Date }> {
  const token = generateSessionToken();
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  await db
    .insertInto("sessions")
    .values({
      user_id: userId,
      token_hash: tokenHash,
      ip_address: meta.ipAddress || null,
      user_agent: meta.userAgent || null,
      expires_at: expiresAt.toISOString(),
    })
    .execute();

  return { token, expiresAt };
}

/**
 * Validate a session token
 * Returns user data if valid, null if invalid/expired
 * Implements sliding window: extends session if close to expiry
 */
export async function validateSession(
  db: Kysely<any>,
  token: string
): Promise<SessionValidationResult> {
  if (!token) return { valid: false, session: null, token: null };

  // Phase 14 Demo — if db is null, we are in "API mode" or "Demo mode".
  // Return a hardcoded mock session so the frontend can be built.
  if (!db) {
    return {
      valid: true,
      token,
      session: {
        user: {
          id: "usr_demo123",
          email: "demo@gbox.co",
          name: "Demo Seller",
          role: "owner",
          avatarUrl: null,
        },
        shopId: null,
        shopRole: null,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      },
    };
  }

  const tokenHash = hashToken(token);
  const cacheKey = `session:${tokenHash}`;

  // --- Redis cache check (0.1ms vs 10ms DB) ---
  const cached = await cacheGet<{ session: SessionData; status: string; sessionId: string; expiresAt: string }>(cacheKey);
  if (cached) {
    // Check not expired
    if (new Date(cached.expiresAt) < new Date()) {
      await cacheDel(cacheKey);
      return { valid: false, session: null, token: null };
    }
    // Check user not disabled
    if (cached.status === "disabled") {
      await cacheDel(cacheKey);
      await deleteSessionByHash(db, tokenHash);
      return { valid: false, session: null, token: null };
    }
    return { valid: true, session: cached.session, token };
  }

  // --- Cache miss → query DB ---
  const row = await db
    .selectFrom("sessions as s")
    .innerJoin("users as u", "u.id", "s.user_id")
    .where("s.token_hash", "=", tokenHash)
    .where("s.expires_at", ">", new Date().toISOString())
    .select([
      "s.id as session_id",
      "s.expires_at",
      "s.created_at as session_created",
      "u.id as user_id",
      "u.email",
      "u.name",
      "u.role",
      "u.avatar_url",
      "u.status",
    ])
    .executeTakeFirst();

  if (!row) return { valid: false, session: null, token: null };

  // Check user not disabled
  if (row.status === "disabled") {
    await deleteSessionByHash(db, tokenHash);
    return { valid: false, session: null, token: null };
  }

  // Sliding window: extend if less than threshold remaining
  const expiresAt = new Date(row.expires_at);
  const remaining = expiresAt.getTime() - Date.now();

  if (remaining < SLIDING_WINDOW_THRESHOLD_MS) {
    const newExpiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await db
      .updateTable("sessions")
      .set({ expires_at: newExpiresAt.toISOString() })
      .where("id", "=", row.session_id)
      .execute();
  }

  const session: SessionData = {
    user: {
      id: row.user_id,
      email: row.email,
      name: row.name || "",
      role: row.role,
      avatarUrl: row.avatar_url,
    },
    shopId: null,
    shopRole: null,
    createdAt: row.session_created,
    expiresAt: row.expires_at,
  };

  // Cache in Redis for 5 minutes (reduces DB load ~99%)
  await cacheSet(cacheKey, {
    session,
    status: row.status,
    sessionId: row.session_id,
    expiresAt: row.expires_at,
  }, 300);

  return { valid: true, session, token };
}

/**
 * Validate session AND check shop access
 * Returns session with shop context if user has access
 */
export async function validateSessionWithShop(
  db: Kysely<any>,
  token: string,
  shopId: string
): Promise<SessionValidationResult> {
  const result = await validateSession(db, token);
  if (!result.valid || !result.session) return result;

  // Check user has access to this shop
  const access = await db
    .selectFrom("user_shops")
    .where("user_id", "=", result.session.user.id)
    .where("shop_id", "=", shopId)
    .select(["role"])
    .executeTakeFirst();

  if (!access) {
    // Super admin (role=owner) can access any shop
    if (result.session.user.role === "owner") {
      result.session.shopId = shopId;
      result.session.shopRole = "owner";
      return result;
    }
    return { valid: false, session: null, token: null };
  }

  result.session.shopId = shopId;
  result.session.shopRole = access.role;
  return result;
}

/**
 * Get all shops a user has access to
 */
export async function getUserShops(
  db: Kysely<any>,
  userId: string
): Promise<Array<{ shopId: string; shopName: string; shopSlug: string; role: string; domain: string | null }>> {
  if (!db) {
    return [
      {
        shopId: "shop_demo1",
        shopName: "Gbox Demo Store",
        shopSlug: "gbox-demo",
        role: "owner",
        domain: "demo.gbox.co",
      },
      {
        shopId: "shop_demo2",
        shopName: "Test Shop #1",
        shopSlug: "test-shop-1",
        role: "owner",
        domain: null,
      },
    ];
  }

  const rows = await db
    .selectFrom("user_shops as us")
    .innerJoin("shops as s", "s.id", "us.shop_id")
    .where("us.user_id", "=", userId)
    .where("s.status", "=", "active")
    .select([
      "s.id as shopId",
      "s.name as shopName",
      "s.slug as shopSlug",
      "us.role",
      "s.domain",
    ])
    .orderBy("s.name", "asc")
    .execute();

  return rows;
}

/**
 * Delete a session by raw token
 */
export async function deleteSession(
  db: Kysely<any>,
  token: string
): Promise<void> {
  const tokenHash = hashToken(token);
  await cacheDel(`session:${tokenHash}`); // Invalidate Redis cache
  await deleteSessionByHash(db, tokenHash);
}

async function deleteSessionByHash(
  db: Kysely<any>,
  tokenHash: string
): Promise<void> {
  await db
    .deleteFrom("sessions")
    .where("token_hash", "=", tokenHash)
    .execute();
}

/**
 * Delete all sessions for a user (force logout everywhere).
 *
 * Pass `exceptToken` to keep ONE session alive (e.g. the one belonging
 * to the current browser right after a password change / privilege
 * rotation — we don't want to log the user out of the tab they just
 * typed their new password into). The except-token is hashed the same
 * way it's stored so the match is constant-time.
 */
export async function deleteAllUserSessions(
  db: Kysely<any>,
  userId: string,
  exceptToken?: string,
): Promise<number> {
  if (!db) return 0 // Demo: nothing deleted

  let query = db.deleteFrom("sessions").where("user_id", "=", userId);
  if (exceptToken && exceptToken.length > 0) {
    query = query.where("token_hash", "!=", hashToken(exceptToken));
  }
  const result = await query.executeTakeFirst();
  return Number(result.numDeletedRows);
}

/**
 * Clean up expired sessions (run via cron)
 */
export async function cleanExpiredSessions(
  db: Kysely<any>
): Promise<number> {
  if (!db) return 0

  const result = await db
    .deleteFrom("sessions")
    .where("expires_at", "<", new Date().toISOString())
    .executeTakeFirst();
  return Number(result.numDeletedRows);
}

/**
 * Get active sessions for a user (for "Login History" page)
 */
export async function getUserSessions(
  db: Kysely<any>,
  userId: string
): Promise<Array<{
  id: string;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
  expiresAt: string;
}>> {
  if (!db) {
    return [
      {
        id: "sess_demo1",
        ipAddress: "127.0.0.1",
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0",
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      },
    ];
  }

  const rows = await db
    .selectFrom("sessions")
    .where("user_id", "=", userId)
    .where("expires_at", ">", new Date().toISOString())
    .select(["id", "ip_address", "user_agent", "created_at", "expires_at"])
    .orderBy("created_at", "desc")
    .execute();

  return rows.map((r) => ({
    id: r.id,
    ipAddress: r.ip_address,
    userAgent: r.user_agent,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
  }));
}
