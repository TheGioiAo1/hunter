/**
 * Gbox God Admin Dashboard — Express Server
 *
 * Port: 4324
 * Route prefix: /god-admin/*
 * Access: role='owner' (God Admin, level 0) only
 *
 * Login: isolated at /god-admin/login (NOT accounts portal)
 * COMPLETELY SEPARATE from store admin (EmDash) and accounts portal.
 */

import { existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { config as dotenvConfig } from 'dotenv'
;(function loadRootEnv() {
  let dir = process.cwd()
  for (let i = 0; i < 8; i++) {
    const p = resolve(dir, '.env')
    if (existsSync(p)) { dotenvConfig({ path: p }); return }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
})()

import express from 'express'
import cookieParser from 'cookie-parser'
import { createGodAuthMiddleware } from './middleware/god-auth.js'
import { createCsrfStore } from '@gbox/core/modules/auth/csrf-express.js'
import { adminSecurityHeaders } from '@gbox/core/modules/security/headers.js'
import { sanitizeResponseMiddleware } from '@gbox/core/modules/security/sanitize-middleware.js'
import { adminCorsConfig } from '@gbox/core/modules/security/cors.js'
import { pageLimiter, authLimiter, strictLimiter } from '@gbox/core/modules/security/rate-limit.js'
import { performanceMiddleware, configureKeepAlive } from '@gbox/core/modules/performance/middleware.js'
import { requestLogger, correlationId, shopifyErrorHandler, installProcessErrorHandlers } from '@gbox/core/modules/logging/logger.js'
import { closeRedis } from '@gbox/core/modules/cache/redis.js'
import { isDevBypassEnabled, createDevMockDb } from './lib/dev-bypass.js'

// Pages
import { getDashboard } from './pages/dashboard.js'
import { getMetrics, getMetricsApi } from './pages/metrics.js'
import { getHealthCheck } from './pages/health.js'
import { getAlerts } from './pages/alerts.js'
import { getEmail, postSendTestEmail } from './pages/email.js'
import {
  getPlatformAlerts,
  postUpdateRecipient,
  postSendTestAlert,
  postFirePolicyViolation,
} from './pages/platform-alerts.js'
import { getActivity } from './pages/activity.js'
import { getStores, getStoreDetail, getCreateStore, postCreateStore, postSuspendStore, postReactivateStore, postDeleteStore, getStoreHealth } from './pages/stores.js'
import { getUsers, getUserDetail, postDisableUser, postEnableUser, getCreateUser, postCreateUser, postResetPassword, postImpersonate } from './pages/users.js'
import { getCustomers, getCustomerDetail } from './pages/customers.js'
import { getOrders } from './pages/orders.js'
import { getOrderDetail } from './pages/order-detail.js'
import { getFinance } from './pages/finance.js'
import { getRevenue } from './pages/revenue.js'
import { getOrderAnalytics } from './pages/order-analytics.js'
import { getPlatformAnalytics } from './pages/platform-analytics.js'
import { getTransactionLog } from './pages/transaction-log.js'
import { getStaff, getStaffDetail } from './pages/staff.js'
import { getAIAgents } from './pages/ai-agents.js'
import {
  getAgentChat,
  postAgentApprovalProxy,
  postAgentChatProxy,
  postAgentKillProxy,
  postAgentKillswitch,
} from './pages/agent-chat.js'
import {
  getAgentSessionList,
  getAgentSessionReplay,
} from './pages/agent-sessions.js'
import { getAgentHealth } from './pages/agent-health.js'
import { getContent, getCampaigns } from './pages/content.js'
import { getDeveloperHub, getApiTokens, getWebhooks, getAppMarketplace, postWebhooksRotate } from './pages/developer.js'
import { getFulfillments, getFulfillmentDetail, postFulfillOrder, postUpdateTracking } from './pages/fulfillments.js'
// Lenful fulfillment integration (migration 030 / Phase F0)
import {
  getCredentialsList,
  getCredentialsNew,
  postCredentialsCreate,
  postCredentialsTest,
  postCredentialsDelete,
} from './pages/fulfillment-lenful-credentials.js'
import {
  getLenfulQueue,
  postLenfulQueuePush,
  postLenfulQueueBulkPush,
  postLenfulQueueSyncTracking,
  postLenfulQueueSyncRow,
} from './pages/fulfillment-lenful-queue.js'
// F1: Catalog + Designs
import {
  getCatalog,
  getCatalogEdit,
  postCatalogSave,
  postCatalogUnmap,
  getCatalogLookup,
} from './pages/fulfillment-lenful-catalog.js'
import {
  getDesigns,
  postDesignsSync,
} from './pages/fulfillment-lenful-designs.js'
// F4: Routing rules
import {
  getRoutingRules,
  postRoutingRuleCreate,
  postRoutingRuleUpdate,
  postRoutingRuleDelete,
  postRoutingRuleSweep,
} from './pages/fulfillment-lenful-routing.js'
// F5: Wallet snapshot
import {
  getWallet,
  postWalletCapture,
  postWalletThreshold,
} from './pages/fulfillment-lenful-wallet.js'
// F6: API log explorer
import {
  getApiLog,
  getApiLogDetail,
} from './pages/fulfillment-lenful-apilog.js'
// Migration 033 — Legacy Gbox master-shop integration
import {
  getIntegrationList,
  getIntegrationForm,
  postIntegrationCreate,
  postIntegrationUpdate,
  postIntegrationTest,
  postIntegrationFetchShop,
  postIntegrationDelete,
} from './pages/integrations-gbox-legacy.js'
import { getRefundRequests, getRefundRequestDetail, postApproveRefund, postRejectRefund } from './pages/refund-requests.js'
import { getSecurity, getLoginHistory, getSuspicious, getTokens, postRevokeTokens, postAuditExportQueue, getAuditExportDownload } from './pages/security.js'
import { getPlatformConfig, postPlatformConfig } from './pages/platform-config.js'
// Phase 12.5 PR4 — Support AI Anthropic integration settings.
import { getAiSettings, postAiSettings } from './pages/ai-settings.js'
import { getAdmins, getCreateAdmin, postCreateAdmin, postDeleteAdmin } from './pages/admins.js'
import { postAiChat } from './pages/ai-chat.js'
import { getGodLogin, postGodLogin, getGodLogout } from './pages/login.js'
import {
  getLogin2fa,
  postLogin2fa,
  getLogin2faEmail,
  postLogin2faEmailSend,
  postLogin2faEmailVerify,
  getLogin2faBackup,
  postLogin2faBackup,
} from './pages/login-2fa.js'
import {
  getSettings2fa,
  postSettings2faEnable,
  postSettings2faDisable,
  postSettings2faRegenerate,
} from './pages/settings-2fa.js'
// Phase 0 §8 Item #4 — per-user IP allowlist settings page.
import {
  getSettingsIpAllowlist,
  postSettingsIpAllowlistSave,
} from './pages/settings-ip-allowlist.js'
import { getPlanRequests, postApprovePlanRequest, postRejectPlanRequest } from './pages/plan-requests.js'
import { getCloneJobs, getCloneJobDetail } from './pages/clone-jobs.js'
import { godLayout } from './layouts/god-layout.js'

// ---------------------------------------------------------------------------
// Initialize
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.GOD_ADMIN_PORT ?? '4324', 10)
// // API-MODE: previously `createDb()` from `packages/db`. Stubbed null;
// // page handlers should guard `if (!db)` and route through the API
// // gateway when one becomes available.
//
// Dev-only: nếu GOD_ADMIN_DEV_BYPASS=1 + NODE_ENV != production → thay
// db null bằng mock Kysely proxy (chain self, terminal trả empty). Page
// handler không crash khi gọi db.selectFrom(...). KHÔNG persist gì.
const db: any = isDevBypassEnabled() ? createDevMockDb() : null
const app = express()

// ---------------------------------------------------------------------------
// CSRF store — centralized for god-admin routes
// ---------------------------------------------------------------------------
// Each page module (stores, users, admins, security, etc.) maintains its own
// module-level CSRF store with a unique cookie name. This server-level store
// exists as documentation and for any future routes wired directly in this
// file. The login page uses its own store ('gbox_csrf_god') inside login.ts.

const csrfStore = createCsrfStore({ cookieName: 'gbox_csrf_god' })

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production'
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

app.set('trust proxy', 1)

// Correlation ID for request tracing
app.use(correlationId())

// Performance middleware
app.use(performanceMiddleware())
app.use(requestLogger('gbox-god-admin'))

// Security middleware
app.use(adminSecurityHeaders)
// Phase 0 close-the-loop — restrictive CORS whitelisted to the gbox.co
// subdomains (admin/accounts/api). Browsers coming from a hostile
// origin never reach the auth middleware below. `credentials: true`
// is required because God Admin uses a session cookie.
app.use(adminCorsConfig)
app.use(express.urlencoded({ extended: false, limit: '1mb' }))
app.use(express.json({ limit: '1mb' }))
app.use(cookieParser())

// Phase 0 close-the-loop — monkey-patch res.json so every JSON response
// is scrubbed of password_hash / tokens / secrets before it leaves the
// process. Mounted after body parsers so /_health's plain-text probe
// (if any) isn't affected, but before every route below.
app.use(sanitizeResponseMiddleware())

// Rate limiting — all pages
app.use('/god-admin/', pageLimiter)

// ---------------------------------------------------------------------------
// Hardening: block browser caching of god-admin responses
//
// Chrome's bfcache (back/forward cache) preserves fully-rendered pages in
// memory so the Back button shows them INSTANTLY, WITHOUT re-running the
// server-side auth check. For a platform-admin surface that's exactly
// what we don't want — a logged-out admin pressing Back would see a
// stale dashboard snapshot from memory instead of getting bounced to
// /login. Observed in the wild: owner opened a browser tab where the
// previous domain was test-only (thaibeotit.com), navigated to
// admin.gbox.co/god-admin, the dashboard appeared to render even though
// the session had long gone; clicking any function then fired a real
// request and bounced correctly to login. Root cause: bfcache.
//
// `Cache-Control: no-store` opts the response out of bfcache per the
// HTML spec + Chrome implementation notes. We also set `Pragma: no-cache`
// + `Expires: 0` for HTTP/1.0 intermediaries and older Safari. Applied
// to ALL /god-admin/* responses before anything else so it covers login,
// dashboard, and every subroute.
// ---------------------------------------------------------------------------

app.use('/god-admin', (_req, res, next) => {
  res.setHeader(
    'Cache-Control',
    'no-store, no-cache, must-revalidate, private, max-age=0',
  )
  res.setHeader('Pragma', 'no-cache')
  res.setHeader('Expires', '0')
  next()
})

// ---------------------------------------------------------------------------
// Health check (NO auth required)
// ---------------------------------------------------------------------------

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'gbox-god-admin',
    timestamp: new Date().toISOString(),
  })
})

// ---------------------------------------------------------------------------
// God Auth middleware on ALL /god-admin/* routes
// (Login/logout routes are skipped inside the middleware)
// ---------------------------------------------------------------------------

const godAuth = createGodAuthMiddleware(db)
app.use('/god-admin', godAuth)

// ---------------------------------------------------------------------------
// Routes — Login/Logout (public, auth handled inside)
// ---------------------------------------------------------------------------

app.get('/god-admin/login', (req, res) => getGodLogin(req, res, db))
app.post('/god-admin/login', authLimiter, (req, res) => postGodLogin(req, res, db))
app.get('/god-admin/logout', (req, res) => getGodLogout(req, res, db))

// 2FA challenge routes (reached after password succeeds, before session
// is "fully verified"). god-auth middleware explicitly allows these.
app.get('/god-admin/login/2fa', (req, res) => getLogin2fa(req, res, db))
app.post('/god-admin/login/2fa', authLimiter, (req, res) => postLogin2fa(req, res, db))
app.get('/god-admin/login/2fa/email', (req, res) => getLogin2faEmail(req, res, db))
app.post('/god-admin/login/2fa/email/send', strictLimiter, (req, res) => postLogin2faEmailSend(req, res, db))
app.post('/god-admin/login/2fa/email', authLimiter, (req, res) => postLogin2faEmailVerify(req, res, db))
app.get('/god-admin/login/2fa/backup', (req, res) => getLogin2faBackup(req, res, db))
app.post('/god-admin/login/2fa/backup', authLimiter, (req, res) => postLogin2faBackup(req, res, db))

// 2FA settings (requires a fully authenticated God Admin session)
app.get('/god-admin/settings/2fa', (req, res) => getSettings2fa(req, res, db))
app.post('/god-admin/settings/2fa/enable', strictLimiter, (req, res) => postSettings2faEnable(req, res, db))
app.post('/god-admin/settings/2fa/disable', strictLimiter, (req, res) => postSettings2faDisable(req, res, db))
app.post('/god-admin/settings/2fa/regenerate-backup', strictLimiter, (req, res) => postSettings2faRegenerate(req, res, db))

// IP allowlist settings (Phase 0 §8 Item #4)
app.get('/god-admin/settings/ip-allowlist', (req, res) => getSettingsIpAllowlist(req, res, db))
app.post('/god-admin/settings/ip-allowlist/save', strictLimiter, (req, res) => postSettingsIpAllowlistSave(req, res, db))

// ---------------------------------------------------------------------------
// Routes — Category A: Overview
// ---------------------------------------------------------------------------

app.get('/god-admin', (req, res) => getDashboard(req, res, db))
app.get('/god-admin/metrics', (req, res) => getMetrics(req, res, db))
app.get('/god-admin/api/metrics', (req, res) => getMetricsApi(req, res, db))
app.get('/god-admin/health-check', (req, res) => getHealthCheck(req, res, db))
app.get('/god-admin/alerts', (req, res) => getAlerts(req, res, db))
app.get('/god-admin/activity', (req, res) => getActivity(req, res, db))

// Phase 14 PR1 — Email Center (Templates / Deliveries / Preferences / Tests)
app.get('/god-admin/email', (req, res) => getEmail(req, res, db))
app.post('/god-admin/email/send-test', strictLimiter, (req, res) => postSendTestEmail(req, res, db))

// Phase 14 PR6 — Platform Alerts (9 god-admin-audience templates +
// recipient editing + test-send + manual policy-violation trigger).
// Kept in the Platform category (next to Email Center) because ops /
// on-call use it to see which alerts have fired today.
app.get('/god-admin/platform-alerts', (req, res) => getPlatformAlerts(req, res, db))
app.post('/god-admin/platform-alerts/update', (req, res) => postUpdateRecipient(req, res, db))
app.post('/god-admin/platform-alerts/test', strictLimiter, (req, res) => postSendTestAlert(req, res, db))
app.post('/god-admin/platform-alerts/policy', strictLimiter, (req, res) => postFirePolicyViolation(req, res, db))
// Phase 6 PR5 — platform-wide analytics (god-admin only). Gated by the
// existing god-auth middleware; the handler itself does no extra role
// checks. The route sits in category A because platform overview
// conceptually lives next to dashboard + metrics + health.
app.get('/god-admin/analytics/platform', (req, res) => getPlatformAnalytics(req, res, db))

// ---------------------------------------------------------------------------
// Routes — Category B: Stores
// ---------------------------------------------------------------------------

app.get('/god-admin/stores', (req, res) => getStores(req, res, db))
app.get('/god-admin/stores/create', (req, res) => getCreateStore(req, res, db))
app.post('/god-admin/stores', (req, res) => postCreateStore(req, res, db))
app.get('/god-admin/stores/:id', (req, res) => getStoreDetail(req, res, db))
app.get('/god-admin/stores/:id/health', (req, res) => getStoreHealth(req, res, db))
app.post('/god-admin/stores/:id/suspend', strictLimiter, (req, res) => postSuspendStore(req, res, db))
app.post('/god-admin/stores/:id/reactivate', (req, res) => postReactivateStore(req, res, db))
app.post('/god-admin/stores/:id/delete', strictLimiter, (req, res) => postDeleteStore(req, res, db))

// ---------------------------------------------------------------------------
// Routes — Category C: Users
// ---------------------------------------------------------------------------

app.get('/god-admin/users', (req, res) => getUsers(req, res, db))
app.get('/god-admin/users/create', (req, res) => getCreateUser(req, res, db))
app.post('/god-admin/users', (req, res) => postCreateUser(req, res, db))
app.get('/god-admin/users/:id', (req, res) => getUserDetail(req, res, db))
app.post('/god-admin/users/:id/disable', strictLimiter, (req, res) => postDisableUser(req, res, db))
app.post('/god-admin/users/:id/enable', strictLimiter, (req, res) => postEnableUser(req, res, db))
app.post('/god-admin/users/:id/reset-pw', strictLimiter, (req, res) => postResetPassword(req, res, db))
app.post('/god-admin/users/:id/impersonate', strictLimiter, (req, res) => postImpersonate(req, res, db))

// ---------------------------------------------------------------------------
// Routes — Customers (Level 5 shoppers, storefront-side)
// ---------------------------------------------------------------------------

app.get('/god-admin/customers', (req, res) => getCustomers(req, res, db))
app.get('/god-admin/customers/:id', (req, res) => getCustomerDetail(req, res, db))

// ---------------------------------------------------------------------------
// Routes — Category D: Orders
// ---------------------------------------------------------------------------

app.get('/god-admin/orders', (req, res) => getOrders(req, res, db))
app.get('/god-admin/orders/analytics', (req, res) => getOrderAnalytics(req, res, db))
// IMPORTANT: /orders/:id must be registered AFTER /orders/analytics so
// Express matches the literal path first. The drill-down target for
// order rows in the dashboard, orders list, and fulfillment center.
app.get('/god-admin/orders/:id', (req, res) => getOrderDetail(req, res, db))

// ---------------------------------------------------------------------------
// Routes — Category E: Fulfillment Center
// ---------------------------------------------------------------------------

app.get('/god-admin/fulfillments', (req, res) => getFulfillments(req, res))

// ---- Lenful integration (F0 MVP) ---------------------------------------
// Credentials
app.get('/god-admin/fulfillments/credentials', (req, res) => getCredentialsList(req, res, db))
app.get('/god-admin/fulfillments/credentials/new', (req, res) => getCredentialsNew(req, res))
app.post('/god-admin/fulfillments/credentials', (req, res) => postCredentialsCreate(req, res, db))
app.post('/god-admin/fulfillments/credentials/:id/test', (req, res) => postCredentialsTest(req, res, db))
app.post('/god-admin/fulfillments/credentials/:id/delete', (req, res) => postCredentialsDelete(req, res, db))

// Legacy Gbox master-shop integration (migration 033).
// Every seller's "Add to store" on the Lenful catalog tab funnels
// through the single active config here.
app.get('/god-admin/integrations/gbox-legacy', (req, res) => getIntegrationList(req, res, db))
app.get('/god-admin/integrations/gbox-legacy/new', (req, res) => getIntegrationForm(req, res, db))
app.post('/god-admin/integrations/gbox-legacy', (req, res) => postIntegrationCreate(req, res, db))
app.get('/god-admin/integrations/gbox-legacy/:id/edit', (req, res) => getIntegrationForm(req, res, db))
app.post('/god-admin/integrations/gbox-legacy/:id', (req, res) => postIntegrationUpdate(req, res, db))
app.post('/god-admin/integrations/gbox-legacy/:id/test', (req, res) => postIntegrationTest(req, res, db))
app.post('/god-admin/integrations/gbox-legacy/:id/fetch-shop', (req, res) => postIntegrationFetchShop(req, res, db))
app.post('/god-admin/integrations/gbox-legacy/:id/delete', (req, res) => postIntegrationDelete(req, res, db))
// Queue + manual push (F0) + bulk push (F2) + tracking sync (F3)
app.get('/god-admin/fulfillments/lenful-queue', (req, res) => getLenfulQueue(req, res, db))
app.post('/god-admin/fulfillments/lenful-queue/bulk-push', (req, res) => postLenfulQueueBulkPush(req, res, db))
app.post('/god-admin/fulfillments/lenful-queue/sync-tracking', (req, res) => postLenfulQueueSyncTracking(req, res, db))
app.post('/god-admin/fulfillments/lenful-queue/:orderId/push', (req, res) => postLenfulQueuePush(req, res, db))
app.post('/god-admin/fulfillments/lenful-queue/:orderId/sync', (req, res) => postLenfulQueueSyncRow(req, res, db))
// F1: Product mapping — static routes MUST come before :productId
app.get('/god-admin/fulfillments/catalog', (req, res) => getCatalog(req, res, db))
app.get('/god-admin/fulfillments/catalog/lookup', (req, res) => getCatalogLookup(req, res, db))
app.get('/god-admin/fulfillments/catalog/:productId', (req, res) => getCatalogEdit(req, res, db))
app.post('/god-admin/fulfillments/catalog/:productId', (req, res) => postCatalogSave(req, res, db))
app.post('/god-admin/fulfillments/catalog/:productId/unmap', (req, res) => postCatalogUnmap(req, res, db))
// F1: Design library
app.get('/god-admin/fulfillments/designs', (req, res) => getDesigns(req, res, db))
app.post('/god-admin/fulfillments/designs/sync', (req, res) => postDesignsSync(req, res, db))
// F4: Routing rules — static routes before :id
app.get('/god-admin/fulfillments/routing', (req, res) => getRoutingRules(req, res, db))
app.post('/god-admin/fulfillments/routing/sweep', (req, res) => postRoutingRuleSweep(req, res, db))
app.post('/god-admin/fulfillments/routing', (req, res) => postRoutingRuleCreate(req, res, db))
app.post('/god-admin/fulfillments/routing/:id/delete', (req, res) => postRoutingRuleDelete(req, res, db))
app.post('/god-admin/fulfillments/routing/:id', (req, res) => postRoutingRuleUpdate(req, res, db))
// F5: Wallet snapshot
app.get('/god-admin/fulfillments/wallet', (req, res) => getWallet(req, res, db))
app.post('/god-admin/fulfillments/wallet/capture', (req, res) => postWalletCapture(req, res, db))
app.post('/god-admin/fulfillments/wallet/threshold', (req, res) => postWalletThreshold(req, res, db))
// F6: API log explorer
app.get('/god-admin/fulfillments/api-log', (req, res) => getApiLog(req, res, db))
app.get('/god-admin/fulfillments/api-log/:id', (req, res) => getApiLogDetail(req, res, db))
// ------------------------------------------------------------------------

// Legacy manual-fulfillment routes (will be deprecated when F3 lands — keep for now)
app.get('/god-admin/fulfillments/:orderId', (req, res) => getFulfillmentDetail(req, res))
app.post('/god-admin/fulfillments/:orderId/fulfill', (req, res) => postFulfillOrder(req, res))
app.post('/god-admin/fulfillments/:fulfillmentId/tracking', (req, res) => postUpdateTracking(req, res))

// ---------------------------------------------------------------------------
// Routes — Refund Requests
// ---------------------------------------------------------------------------

app.get('/god-admin/refund-requests', (req, res) => getRefundRequests(req, res))
app.get('/god-admin/refund-requests/:id', (req, res) => getRefundRequestDetail(req, res))
app.post('/god-admin/refund-requests/:id/approve', (req, res) => postApproveRefund(req, res))
app.post('/god-admin/refund-requests/:id/reject', (req, res) => postRejectRefund(req, res))

// ---------------------------------------------------------------------------
// Routes — Category F: Finance
// ---------------------------------------------------------------------------

app.get('/god-admin/finance', (req, res) => getFinance(req, res, db))
app.get('/god-admin/finance/revenue', (req, res) => getRevenue(req, res, db))
app.get('/god-admin/finance/transactions', (req, res) => getTransactionLog(req, res, db))

// ---------------------------------------------------------------------------
// Routes — Category G: Staff Management
// ---------------------------------------------------------------------------

app.get('/god-admin/staff', (req, res) => getStaff(req, res, db))
app.get('/god-admin/staff/ai-agents', (req, res) => getAIAgents(req, res, db))

// ---------------------------------------------------------------------------
// Routes — Agent Pair Programmer (Default God Admin only)
// ---------------------------------------------------------------------------

app.get('/god-admin/agent', (req, res) => getAgentChat(req, res))
// Alias — Phase 9.2 Phase B PR-3: new canonical URL so the sidebar
// nav "Chat" item can use a distinct href prefix and not collide with
// /god-admin/agent/sessions / /god-admin/agent/health via startsWith().
app.get('/god-admin/agent/chat', (req, res) => getAgentChat(req, res))
app.get('/god-admin/agent/health', (req, res) => getAgentHealth(req, res))
app.get('/god-admin/agent/sessions', (req, res) => getAgentSessionList(req, res))
app.get('/god-admin/agent/sessions/:aid', (req, res) => getAgentSessionReplay(req, res))
app.post('/god-admin/agent/chat-proxy', (req, res) => postAgentChatProxy(req, res))
app.post('/god-admin/agent/kill-proxy', (req, res) => postAgentKillProxy(req, res))
app.post('/god-admin/agent/approval-proxy', (req, res) => postAgentApprovalProxy(req, res))
app.post('/god-admin/agent/killswitch', strictLimiter, (req, res) => postAgentKillswitch(req, res))
app.get('/god-admin/staff/:id', (req, res) => getStaffDetail(req, res, db))

// ---------------------------------------------------------------------------
// Routes — Category H: Security
// ---------------------------------------------------------------------------

app.get('/god-admin/security', (req, res) => getSecurity(req, res, db))
app.get('/god-admin/security/logins', (req, res) => getLoginHistory(req, res, db))
app.get('/god-admin/security/suspicious', (req, res) => getSuspicious(req, res, db))
app.get('/god-admin/security/tokens', (req, res) => getTokens(req, res, db))
app.post('/god-admin/security/tokens/:userId/revoke', strictLimiter, (req, res) => postRevokeTokens(req, res, db))
// Phase 2 Admin Polish §2.3 — background audit-log exports (>10k rows).
app.post('/god-admin/security/audit-export/queue', strictLimiter, (req, res) => postAuditExportQueue(req, res, db))
app.get('/god-admin/security/audit-export/:id/download', (req, res) => getAuditExportDownload(req, res, db))

// ---------------------------------------------------------------------------
// Routes — Category J: Platform Config
// ---------------------------------------------------------------------------

app.get('/god-admin/config', (req, res) => getPlatformConfig(req, res, db))
app.post('/god-admin/config', strictLimiter, (req, res) => postPlatformConfig(req, res, db))

// Phase 12.5 PR4 — Support AI integration settings (Anthropic key,
// master switch, monthly budget cap + live spend dashboard).
app.get('/god-admin/settings/ai', (req, res) => getAiSettings(req, res, db))
app.post('/god-admin/settings/ai', strictLimiter, (req, res) => postAiSettings(req, res, db))

// ---------------------------------------------------------------------------
// Routes — Admin Hierarchy (Default God Admin only)
// ---------------------------------------------------------------------------

app.get('/god-admin/admins', (req, res) => getAdmins(req, res, db))
app.get('/god-admin/admins/create', (req, res) => getCreateAdmin(req, res, db))
app.post('/god-admin/admins/create', (req, res) => postCreateAdmin(req, res, db))
app.post('/god-admin/admins/:id/delete', strictLimiter, (req, res) => postDeleteAdmin(req, res, db))

// ---------------------------------------------------------------------------
// Routes — AI Advisor (embedded in detail pages)
// ---------------------------------------------------------------------------

app.post('/god-admin/ai/chat', strictLimiter, (req, res) => postAiChat(req, res))

// ---------------------------------------------------------------------------
// Routes — Category I: Content Management
// ---------------------------------------------------------------------------

app.get('/god-admin/content', (req, res) => getContent(req, res, db))
app.get('/god-admin/content/campaigns', (req, res) => getCampaigns(req, res, db))

// ---------------------------------------------------------------------------
// Routes — Category K: Developer Hub
// ---------------------------------------------------------------------------

app.get('/god-admin/developer', (req, res) => getDeveloperHub(req, res, db))
app.get('/god-admin/developer/tokens', (req, res) => getApiTokens(req, res, db))
app.get('/god-admin/developer/webhooks', (req, res) => getWebhooks(req, res, db))
// Phase 2.1 — Shop webhook secret rotation. Strict limiter guards against
// accidental double-submits and brute force against the CSRF token.
app.post('/god-admin/developer/webhooks/rotate', strictLimiter, (req, res) => postWebhooksRotate(req, res, db))
app.get('/god-admin/developer/apps', (req, res) => getAppMarketplace(req, res, db))

// ---------------------------------------------------------------------------
// Routes — Category L: Plan Requests (Billing Approval Flow)
// ---------------------------------------------------------------------------

app.get('/god-admin/plan-requests', (req, res) => getPlanRequests(req, res, db))
app.post('/god-admin/plan-requests/:id/approve', (req, res) => postApprovePlanRequest(req, res, db))
app.post('/god-admin/plan-requests/:id/reject', (req, res) => postRejectPlanRequest(req, res, db))

// ---------------------------------------------------------------------------
// Routes — Category K: Tools (Clone Jobs)
// ---------------------------------------------------------------------------

app.get('/god-admin/clone-jobs', (req, res) => getCloneJobs(req, res, db))
app.get('/god-admin/clone-jobs/:id', (req, res) => getCloneJobDetail(req, res, db))

// ---------------------------------------------------------------------------
// Root redirect
// ---------------------------------------------------------------------------

app.get('/', (_req, res) => {
  res.redirect('/god-admin')
})

// ---------------------------------------------------------------------------
// 404 catch-all
// ---------------------------------------------------------------------------

app.use((_req, res) => {
  res.status(404).send(`
    <!DOCTYPE html>
    <html><head><title>404 - God Admin</title>
    <style>
      body { font-family: -apple-system, sans-serif; background: #0f172a; color: #e2e8f0; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
      .c { text-align: center; }
      h1 { font-size: 72px; font-weight: 800; margin: 0; color: #3b82f6; }
      p { color: #94a3b8; margin-top: 8px; }
      a { color: #3b82f6; text-decoration: none; }
      a:hover { text-decoration: underline; }
    </style></head>
    <body><div class="c">
      <h1>404</h1>
      <p>Page not found</p>
      <p><a href="/god-admin">Go to Dashboard</a></p>
    </div></body></html>
  `)
})

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

// Shopify-format error handler
app.use(shopifyErrorHandler())
// Phase 14 PR6 — platform-incident alerts for god-admin crashes. Same
// 60s dedup contract as accounts/checkout; recipient lives in
// platform_alert_recipients row for `platform_incident_alert`.
installProcessErrorHandlers('gbox-god-admin', { db })

const server = app.listen(PORT, () => {
  console.log(`[Gbox God Admin] Running on http://localhost:${PORT} | PID: ${process.pid}`)
  console.log(`[Gbox God Admin] Dashboard: http://localhost:${PORT}/god-admin`)
  console.log(`[Gbox God Admin] ENV: ${process.env.NODE_ENV ?? 'development'}`)
})

// Configure keep-alive
configureKeepAlive(server)

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

async function shutdown() {
  console.log('[Gbox God Admin] Shutting down...')
  // // API-MODE: db stubbed null in demo; only Redis needs draining.
  await closeRedis().catch(() => {})
  process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
