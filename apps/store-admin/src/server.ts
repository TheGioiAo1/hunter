/**
 * Gbox Store Admin — Express Server (FULL SELLER DASHBOARD)
 *
 * Port: 4325
 * Route prefix: /admin/store/:slug/*
 * Access: Authenticated users with store access (via user_shops)
 *
 * ~80 routes covering 12 feature groups (A-L):
 * A: Dashboard, B: Products, C: Orders, D: Customers,
 * E: Discounts, F: Marketing, G: Analytics, H: Online Store,
 * I: Shipping, J: Tax, K: Settings, L: AI Agent
 *
 * ALL actions logged to audit_logs for God Admin visibility.
 * Dark/light theme toggle. AI Agent with 30+ functions.
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
import multer from 'multer'
import { createStoreAuthMiddleware } from './middleware/store-auth.js'
import { createSessionAuthMiddleware } from './middleware/session-auth.js'
import { onboardingGate } from './middleware/onboarding-gate.js'
import { onboardingBannerInjector } from './middleware/onboarding-banner.js'
// Phase 14 PR7 — per-permission route guard. Seals the BUG-E2 gap where
// email template / suppression / analytics / finance-alerts routes had
// no permission checks and any `staff` could edit templates or
// unsuppress addresses.
import { createRequirePermission } from './middleware/require-permission.js'
import { sellerLayout, esc } from './layouts/seller-layout.js'
import { adminSecurityHeaders } from '@gbox/core/modules/security/headers.js'
import { sanitizeResponseMiddleware } from '@gbox/core/modules/security/sanitize-middleware.js'
import { adminCorsConfig } from '@gbox/core/modules/security/cors.js'
import { createCsrfStore, createMemoryCsrfStore, type CsrfSecretStore } from '@gbox/core/modules/auth/csrf-express.js'
import { strictLimiter } from '@gbox/core/modules/security/rate-limit.js'
import { performanceMiddleware, configureKeepAlive } from '@gbox/core/modules/performance/middleware.js'
import { requestLogger, correlationId, shopifyErrorHandler, installProcessErrorHandlers } from '@gbox/core/modules/logging/logger.js'
import { getRedis, closeRedis } from '@gbox/core/modules/cache/redis.js'

// ─── Pages ──────────────────────────────────────────────────────

// A: Dashboard
import { getDashboard } from './pages/dashboard.js'

// B: Products
import {
  getProducts,
  getProductDetail,
  getProductNew,
  postProductCreate,
  postProductBulk,
  postProductBulkEdit,
  postProductSeoShortcut,
  postProductUpdate,
  postProductDelete,
  postProductStatusToggle,
  postProductDuplicate,
  postProductMediaAdd,
  postProductMediaDelete,
  postProductMediaUploadApi,
  postProductMediaRemoveApi,
  postProductVariantAdd,
  postProductVariantUpdate,
  postProductVariantDelete,
  postProductImportFromLenful,
  postLenfulCatalogSyncNow,
  // Phase 2 PR1 — Custom data (metafields) on product detail.
  postProductMetafieldAdd,
  postProductMetafieldDelete,
} from './pages/products.js'
import {
  getInventory,
  postAdjustInventory,
  postBulkSetInventory,
  postCreateVariant,
  postUpdateVariant,
  postDeleteVariant,
} from './pages/inventory.js'
import { getInventoryAnalytics } from './pages/inventory-analytics.js'
import { getCustomerBehavior } from './pages/customer-behavior.js'
// Phase 14 PR4 — email open/click analytics
import { getEmailAnalyticsPage } from './pages/email-analytics.js'
// Phase 14 PR4.B — email suppressions (bounce/complaint blocklist)
import {
  getEmailSuppressionsPage,
  postUnsuppressAction,
} from './pages/email-suppressions.js'
// Phase 14 PR5 — GDPR/Privacy request queue. Merchant-facing list + two
// write actions (cancel deletion, mark rectification done). All three
// routes filter by `shop_id = store.id` — cross-shop access blocked
// at handler level.
import {
  getPrivacyRequestsPage,
  postCancelDeletionAction,
  postMarkReadyAction,
} from './pages/privacy-requests.js'
import {
  getCollections,
  getCollectionDetail,
  getCreateCollection,
  postCreateCollection,
  getEditCollection,
  postUpdateCollection,
  postDeleteCollection,
  // Phase C1 — manual product management inside a collection
  postCollectionProductsAdd,
  postCollectionProductsRemove,
  postCollectionProductsReorder,
  // Phase C3b — multi-select bulk publish/unpublish/delete on the list page
  postCollectionsBulk,
  // Phase 2 PR1 — metafields on collection edit page
  postCollectionMetafieldAdd,
  postCollectionMetafieldDelete,
} from './pages/collections.js'
// Shop Collections — wired vào BE CollectionController (Gbox-Product-Service-V2),
// thay handlers cũ ở collections.ts (vốn dùng Categories collection).
import {
  getShopCollections,
  getCreateShopCollection,
  postCreateShopCollection,
  getEditShopCollection,
  postUpdateShopCollection,
  postDeleteShopCollection,
  postBulkShopCollections,
  getShopCollectionsProductsSearch,
  getShopCollectionSlugCheck,
  postShopCollectionProductAdd,
  postShopCollectionProductRemove,
} from './pages/shop-collections.js'

// C: Orders
import { getOrders, getOrderDetail, postFulfillOrder, postOrderBulk, postOrderEdit, postOrderAddNote, postPodUpload } from './pages/orders.js'
import { getFulfillments, getFulfillmentDetail, postPodUploadFulfillment } from './pages/fulfillments.js'
import { getOrderExport, postOrderExportDownload } from './pages/orders-export.js'
import { getProductExport, postProductExportDownload } from './pages/products-export.js'
import { getProductImport, postProductImportUpload } from './pages/products-import.js'
import { getOrderImport, postOrderImportUpload, postOrderImportConfirm } from './pages/orders-import.js'
import { postSaveOrderFilter, postDeleteOrderFilter } from './pages/orders-saved-filters.js'
import { getImportTracking, postImportTrackingUpload, postImportTrackingConfirm } from './pages/orders-import-tracking.js'
import { getCreateReturn, postCreateReturn, getReturns, getReturnDetail, postApproveReturn, postReceiveReturn, postRefundReturn, postCancelReturn } from './pages/orders-returns.js'
import { getRefundRequests, getCreateRefundRequest, postCreateRefundRequest } from './pages/refund-requests.js'

// D: Customers
import {
  getCustomers,
  getCustomerDetail,
  getCustomerNew,
  postCustomerCreate,
  getCustomerEdit,
  postCustomerEdit,
  postCustomerBulk,
  // Phase 4 PR1 — notes timeline + tags chip editor. These were shipped
  // in #24 but the route registrations below referenced them without a
  // matching import; PR2 closes that gap to stop the runtime
  // ReferenceError when a merchant hits the notes/tags endpoints.
  postCustomerAddNote,
  postCustomerDeleteNote,
  postCustomerUpdateTags,
  // Phase 4 PR5 — shared quick-filter pills above the customer list.
  postCustomerQuickFilterCreate,
  postCustomerQuickFilterDelete,
} from './pages/customers.js'
// Phase 4 PR4 — CSV import + export for customers.
import {
  getCustomerImport,
  postCustomerImportUpload,
  postCustomerImportCommit,
} from './pages/customers-import.js'
import {
  getCustomerExport,
  postCustomerExportDownload,
} from './pages/customers-export.js'

// E: Discounts
import { getDiscounts, getCreateDiscount, getDiscountDetail, postCreateDiscount, postUpdateDiscount, postDeleteDiscount } from './pages/discounts.js'

// F: Marketing
import { getMarketingDashboard, getAbandonedCarts, getSeoManager } from './pages/marketing.js'
import { getMarkets, getCreateMarket, postCreateMarket } from './pages/markets.js'
// F3b: Abandoned Cart settings + ad-hoc send-now (Phase 8 PR2d).
import {
  getAbandonedCartSettings,
  postAbandonedCartSettings,
  postAbandonedCartSendNow,
  postAbandonedCartRunTick,
} from './pages/abandoned-cart-settings.js'
// F4b: SEO settings + run-scan (Phase 8 PR3d). Sits alongside the older
// SEO overview page (getSeoManager above) — the overview inspects DB
// fields; this new surface controls head-tag injection + runs live HTML
// scans against the primary domain.
import {
  getSeoSettings,
  postSeoSettings,
  postSeoScan,
} from './pages/seo-settings.js'

// G: Analytics
import { getAnalyticsDashboard, getSalesReport, getProductReport, getCustomerReport, getFinanceReport, getSalesReportCsv, getFinanceReportCsv } from './pages/analytics.js'

// G (M4 Measurement): new dashboards backed by page_views + orders
import {
  getTrafficSourcesReport,
  getConversionFunnelReport,
  getAttributionReport,
  getCohortReportPage,
} from './pages/analytics-measurement.js'

// H: Online Store — Pages & Blog
import { getPages, getCreatePage, getPageDetail, postCreatePage, postUpdatePage, postDeletePage, postBulkPages } from './pages/pages.js'
import { getBlogPosts, getCreateBlogPost, getBlogPostDetail, postCreateBlogPost, postUpdateBlogPost, postDeleteBlogPost, postBulkBlogPosts } from './pages/blog.js'

// B5: Domains (API-mode — via Shop API)
import {
  getDomains,
  postAddDomain,
  postRemoveDomain,
} from './pages/domains.js'

// B4: Order Analytics
import { getOrderAnalytics } from './pages/order-analytics.js'

// B6: Payment Settings
import { getPaymentSettings, postPaymentSettings, postDisconnectPaypal, getPaypalOnboardStart, getPaypalOnboardCallback, postPaypalAccountAdd, postPaypalAccountActivate, postPaypalAccountDelete, postPaypalToggle } from './pages/payment-settings.js'

// C4: Gift Cards & Reviews
import {
  getGiftCards,
  getCreateGiftCard,
  getCreateGiftCardProduct,
  postCreateGiftCard,
  postDisableGiftCard,
  getGiftCardDetail,
  postSendGiftCardEmail,
  postUpdateGiftCard,
} from './pages/gift-cards.js'
import {
  getReviews,
  postApproveReview,
  postRejectReview,
  postDeleteReview,
  postReply,
  postBulkAction,
} from './pages/reviews.js'
import {
  getReviewSettings,
  postReviewSettingsModeration,
  postReviewSettingsNotifications,
} from './pages/review-settings.js'

import {
  getEmailAutomationList,
  getEmailAutomationEditor,
  postEmailAutomationSave,
  postEmailAutomationReset,
  postEmailAutomationClone,
} from './pages/email-automation.js'

// C5: Customer Segments & Campaigns
import {
  getCustomerSegments,
  getCustomerSegmentNew,
  getCustomerSegmentDetail,
  postCustomerSegmentCreate,
  postCustomerSegmentUpdate,
  postCustomerSegmentDelete,
} from './pages/customer-segments.js'
import { getCustomerSegmentCustomers } from './pages/customer-segment-customers.js'
import {
  getCampaignsList,
  getCampaignEditor,
  postCreateCampaign,
  postUpdateCampaign,
  postDeleteCampaign,
  postScheduleCampaign,
  postCancelCampaign,
} from './pages/campaigns.js'

// C6: Online Store Hub, Themes, Navigation, Files
import { getOnlineStoreHub, getThemes } from './pages/online-store.js'
import { getFilesPage, postUploadFile, postDeleteFile, postUpdateFile } from './pages/files.js'
import { getNavigation, postCreateMenu, postDeleteMenu, postRenameMenu, postCreateMenuItem, postUpdateMenuItem, postDeleteMenuItem, postReorderMenu, getResourceSearch, postSaveMenuItems } from './pages/navigation.js'
import { getThemeEditor, getThemeFile, postThemeFile, postNewThemeFile, postDeleteThemeFile, postActivateTheme, postDuplicateTheme, getThemeEditorSearch } from './pages/theme-editor.js'
// Sprint 11 — theme exporter (.zip download).
import { getThemeExport } from './pages/theme-export.js'
// Sidebar entry-point handler — resolves the seller's main theme and
// 302s onward to /themes/:id/customize. Lets the sidebar carry a
// stable URL even though the customizer needs a per-theme id.
import { getThemeEditorEntry } from './pages/theme-editor-entry.js'
import { registerVisualEditorRoutes } from './pages/visual-editor.js'
// Phase 23 PR1 — Theme Builder (visual customizer shell, read-only).
// Thin module under pages/theme-customizer/. Subsequent PRs (2-8) extend
// in place; routes registered here in one block for grep-ability.
import {
  getThemeCustomizer,
  getSectionsJson as getThemeCustomizerSectionsJson,
  getPreviewUrl as getThemeCustomizerPreviewUrl,
  getSectionSchema,
  postSectionSettings,
  postSectionBlocks,
  postSectionVisibility,
  postAddSection,
  deleteSectionRoute,
  postReorderSections,
  postPublishTheme as postThemeCustomizerPublish,
  postCreateSnapshot as postThemeCustomizerSnapshot,
  getVersionsJson as getThemeCustomizerVersions,
  postRestoreVersion as postThemeCustomizerRestoreVersion,
} from './pages/theme-customizer/index.js'
// Sprint 8 PR-D — picker-search endpoints (product/collection/page/blog/article).
import {
  getProductPicker,
  getCollectionPicker,
  getPagePicker,
  getBlogPicker,
  getArticlePicker,
} from './pages/theme-customizer/pickers.js'

// Content Hub (Shopify Content section)
import { getContentHub, getMetaobjects } from './pages/content.js'

// 2026-04-26: Clone Pro re-scoped to god-admin-only concierge tooling.
// All seller-facing clone-pro UI has been removed. The backend code
// under packages/core/src/modules/clone-pro/ stays intact — god admin
// runs clone jobs on behalf of sellers via support tickets. Sellers
// who need a storefront cloned contact Gbox support; we never expose
// a self-serve path here. Iron Rule 5 application: god-admin tooling
// stays invisible to seller surfaces.

// 2026-04-26 cleanup — unified Library page (Theme/Design Library).
// New canonical entry is /online-store/library?tab=…
import { getLibraryPage } from './pages/library.js'

// Phase D4 (2026-04-18): Design Library — unified gallery of curated
// seed brands (from xaozayta/awesome-design-md mirror) + per-shop
// clones. GET renders the page + two AJAX helpers (entry JSON + raw
// preview HTML for the iframe); POST handlers live in
// ./pages/design-library/actions.ts.
import {
  getDesignLibraryPage,
  getDesignLibraryEntryJson,
  getDesignLibraryPreview,
} from './pages/design-library.js'

// Sprint 8 — Theme library: install default + import .zip handlers.
import { postInstallDefaultTheme } from './pages/theme-library/install-default.js'
import { postImportTheme } from './pages/theme-library/import.js'
import {
  postDeleteDesignLibraryEntry,
} from './pages/design-library/actions.js'

// Phase B (2026-04-18): Onboarding wizard — two-tab welcome page at
// /onboarding/first-run + deep-link alias at /onboarding/library.
// Phase C (2026-04-18): mutator POSTs (skip / dismiss-banner).
// 2026-04-26: clone tab dropped (clone pro now god-admin-only).
import { getOnboardingFirstRun } from './pages/onboarding/first-run.js'
import { getOnboardingLibraryRedirect } from './pages/onboarding/library.js'
import { postOnboardingSkip } from './pages/onboarding/skip.js'
import { postDismissOnboardingBanner } from './pages/onboarding/dismiss-banner.js'

// 2026-04-26 cleanup — the /online-store/design hub is retired in
// favour of /online-store/themes (theme management). All design-* and
// clone-* legacy routes now 410/404 inline below — clone is god-admin-
// only tooling and never appears in seller surfaces.

// Phase 2B Sprint 1: Placeholders for sidebar items landing in Sprint 3-4
// (Landing pages, Watermark, Size charts). Each renders a "coming soon"
// card so the sidebar never 404s before the real page ships.
import {
  getLandingPages,
  getWatermarkPage,
  getSizeChartsPage,
} from './pages/online-store-stubs.js'

// Phase 3.E → migration 034: Multi-pixel tracking (row-per-pixel).
import {
  getPixelConfigPage,
  getPixelNewPage,
  getPixelEditPage,
  postPixelCreate,
  postPixelUpdate,
  postPixelDelete,
  postPixelToggle,
} from './pages/pixel-config.js'

// C6b: Theme list. The legacy AI Clone wizard exports
// (getCloneWizard / postCloneWizard) were retired with the rest of
// clone-pro on 2026-04-26 — `cloneProRetiredHandler` now serves those
// URLs.
import { getThemesList } from './pages/theme-clone.js'

// I,J,K: Shipping, Tax, Settings
import { getSettings, getGeneralSettings, postGeneralSettings } from './pages/settings.js'
import { getShippingSettings, postCreateShippingZone, getNotificationSettings, getEmailTemplateEdit, postEmailTemplateUpdate, getActivityLog, getLegalPages } from './pages/settings-extended.js'
// Phase 9 PR4 — staff + permissions, security, alerts.
import {
  getStaffSettings,
  postStaffInvite,
  postStaffInvitationRevoke,
  getStaffMember,
  postStaffMemberUpdate,
  postStaffMemberDisable,
  postStaffMemberReenable,
  postStaffMemberRemove,
} from './pages/staff-settings.js'
import { getSecuritySettings } from './pages/security-settings.js'
import {
  getAlertsSettings,
  postAlertRead,
  postAlertDismiss,
  postAlertsReadAll,
  postAlertPreferences,
} from './pages/alerts-settings.js'
import {
  getSurchargesPage,
  postSurchargeCreate,
  postSurchargeUpdate,
  postSurchargeDelete,
} from './pages/surcharges-settings.js'

// Replaced placeholder pages
import { getAbandonedCheckouts } from './pages/abandoned-checkouts.js'
import { getCheckoutSettings, postCheckoutSettings } from './pages/checkout-settings.js'
import { getPreferences, postPreferences } from './pages/preferences.js'
import { getCustomerAccountsSettings, postCustomerAccountsSettings } from './pages/customer-accounts-settings.js'
import {
  getMarketsSettings,
  postMarketsSettings,
  postMarketFromTemplate,
  postMarketCreate,
  postMarketUpdate,
  postMarketDelete,
  postMarketLinkZone,
  postMarketLinkRegistration,
} from './pages/markets-settings.js'
import {
  getCurrenciesSettings,
  postCurrenciesSettings,
} from './pages/currencies-settings.js'
import { getLanguagesSettings, postLanguagesSettings } from './pages/languages-settings.js'
import { getCustomDataSettings } from './pages/custom-data-settings.js'
import { getPlanSettings, postChangePlan, postCancelPlan, postReactivatePlan } from './pages/plan-settings.js'
import { getDraftOrders, getDraftOrderNew, getDraftOrderDetail, postDraftOrderCreate, postDraftOrderUpdate, postSendInvoice, postConvertDraft, postDeleteDraft, postBulkDraftAction, getDraftOrdersExport } from './pages/draft-orders.js'
import { getDraftProductsSearch, getDraftCustomersSearch } from './pages/draft-order-new-api.js'
import { postOrderDeleteApi, searchProductsApi, searchOrdersApi, listShippingZonesApi, postOrderUpdateApi } from './pages/orders-list-api.js'
import { getAutomations, postAutomationToggle } from './pages/automations.js'
// Phase 14 PR3 — Shopify Flow lite settings surface. Replaces the old
// marketing/automations page and absorbs abandoned-cart/settings under a
// single unified "/settings/automations" hub so merchants have one place
// to control every automatic email. Legacy routes 301 below.
import {
  getSettingsAutomations,
  postSettingsAutomations,
} from './pages/settings-automations.js'
// Phase 14 PR6 commit 8 — dedicated finance alerts surface. Narrower
// slice of the same `automation_flows` table `settings-automations.ts`
// writes to; pulled onto its own page so "turn off the fraud email"
// doesn't require scrolling past 18 marketing toggles, and so the 5
// Phase 12 deferred payout/chargeback entries get a "Coming with
// payouts" affordance instead of polluting the main automations list.
import {
  getSettingsFinanceAlerts,
  postSettingsFinanceAlerts,
} from './pages/settings-finance-alerts.js'

// New standalone pages (Shopify parity)
import { getActivityLog as getActivityLogPage } from './pages/activity-log.js'
import { getNotifications as getNotificationsPage, postMarkRead, postMarkAllRead, postMarkAllSeen } from './pages/notifications-admin.js'
// Phase 12.5 PR2 — support (tickets + messages + widget polling).
import {
  getSupportTicketList,
  getSupportTicketNew,
  getSupportTicketDetail,
  getSupportUnreadCount,
  postSupportCsat,
  postSupportMarkRead,
  postSupportMessageCreate,
  postSupportTicketCreate,
} from './pages/support.js'
import {
  getShippingSettingsPage,
  postCreateZone,
  postCreateRate,
  postDeleteZone,
  postDeleteMethod,
  getEntityPicker,
  postEnableCarrier,
  postCarrierToggle,
  postCarrierLiveToggle,
  postSeedRates,
  postRemoveCarrierRates,
} from './pages/shipping-settings.js'
import { getLocations, postCreateLocation, postUpdateLocation, postDeleteLocation } from './pages/locations.js'

// G.3: Automation Engine
import {
  listAutomations as listCustomAutomations,
  createAutomation,
  updateAutomation,
  deleteAutomation,
} from '@gbox/core/modules/automations/engine.js'
import { fireAutomationTrigger } from '@gbox/core/modules/automations/engine.js'
import { getLiveView } from './pages/live-view.js'
import { listAccessibleStores } from './lib/user-stores.js'
import {
  getPurchaseOrders,
  getCreatePurchaseOrder,
  postCreatePurchaseOrder,
  getPurchaseOrderProductsSearch,
  getTransfers,
  getCreateTransfer,
  postCreateTransfer,
} from './pages/purchase-orders.js'

// G.6: Apps / Plugin System
import { getApps, postInstallApp, postUninstallApp, getAppConfig, postAppConfig } from './pages/apps.js'

// L: AI Agent
import { handleAIChat } from './ai/agent.js'

// Phase 0.5: top-level stores hub + create-store (moved from accounts)
// /stores hub đã được hợp nhất sang accounts.gbox.co/accounts/stores.
// Route /stores ở admin.gbox.co giờ chỉ là 302 redirect (xem khối handler bên dưới).
import { getMyStoresApi } from './pages/my-stores-api.js'
import { postQuickCreateCustomer } from './pages/customer-quick-create-api.js'

// M: AI Settings
import { getAiSettings, postAiSettings, getAiSettingsClearKey } from './pages/ai-settings.js'
// Phase 10 PR1 — AI copywriter REST endpoints
import {
  postAiProductDescription,
  postAiProductTags,
  postAiCampaignSuggestion,
  postAiEmailSubjects,
  getAiStatus,
} from './pages/ai-copywriter.js'

// ---------------------------------------------------------------------------
// Initialize
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.STORE_ADMIN_PORT ?? '4325', 10)
const db = null as any
const app = express()
const podUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } })

// Sprint 8: theme-zip multer — 5 MB cap per the importer's MAX_BYTES.
const themeZipUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } })

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

app.set('trust proxy', 1)

// Correlation ID for request tracing
app.use(correlationId())

// Performance middleware
app.use(performanceMiddleware())
app.use(requestLogger('gbox-store-admin'))

// Security middleware
app.use(adminSecurityHeaders)
// Phase 0 close-the-loop — CORS restricted to gbox.co and the
// explicit dev ports listed in cors.ts. Credentials are allowed so
// store-admin can carry the session cookie across subdomain calls.
app.use(adminCorsConfig)
app.use(express.urlencoded({ extended: false, limit: '1mb', parameterLimit: 5000 }))
app.use(express.json({ limit: '1mb' }))

// Phase 0 close-the-loop — scrub password_hash / tokens / secrets
// from every JSON response (defence in depth over route select-list
// hygiene).
app.use(sanitizeResponseMiddleware())

// Rate limiting — DISABLED at the global /admin/ level (2026-04-26).
//
// Why: `pageLimiter` (60 req/min per IP) was applied as a blanket guard
// for every /admin/* page. In production this caused 429 storms whenever
// a seller's dashboard fired its normal mix of XHR + page-nav requests
// (autosave, polling for support thread updates, opening 5 tabs at once,
// pm2 reload re-sharing counters across processes, etc.).
//
// Root cause is in `@gbox/core/modules/security/rate-limit.ts`: the
// factory imports `getRedisStore()` but never wires it into the
// `rateLimit({...})` options, so every PM2 process keeps its own
// in-memory counter. After a `pm2 reload`, fresh counters from the
// blue/green cutover stack on top of the lingering counters in the old
// process and trip the 60/min cap on routine usage.
//
// Per-route limiters that already do the right thing remain in place:
//   - authLimiter      (5/min)  on /login, /signup, /forgot-password
//   - apiLimiter       (30/min) on POST/PUT/DELETE /api/*
//   - apiReadLimiter   (120/min) on GET /api/*
//   - strictLimiter    (3 / 5min) on dangerous ops
//   - checkoutLimiter  (10/min) on POST /checkout
//   - paymentLimiter   (20/min keyed by shop) on payment ops
//   - refundLimiter    (30 / 5min keyed by shop) on refund ops
//
// Auth + CSRF + bcrypt-throttling all still apply unchanged. Removing
// the blanket pageLimiter does NOT reduce defence-in-depth for any
// abuse vector that we actually saw in logs.
//
// Re-enabling: fix `createRateLimiter` to call `await getRedisStore(prefix)`
// and pass `store` into `rateLimit({...})`. That requires the factory to
// become async and the limiter exports to be initialised at boot rather
// than module load. Tracked as a follow-up; see PR-2 description.
//
// app.use('/admin/', pageLimiter)  // intentionally disabled — see above

// ---------------------------------------------------------------------------
// Health check (no auth)
// ---------------------------------------------------------------------------

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'gbox-store-admin',
    timestamp: new Date().toISOString(),
  })
})

// ---------------------------------------------------------------------------
// Legacy login-URL redirects
//
// Sellers authenticate ONLY via the accounts portal (`accounts.gbox.co`).
// Historically the store-admin domain had no public login handler — typing
// `admin.gbox.co/admin/login` (or `/login`, or bare `/admin`) dead-ended
// in a 404 page that confused non-technical merchants. Shopify solves the
// same problem by 302-ing any login-ish URL to `accounts.shopify.com` —
// we mirror that behaviour here.
//
// Why this is more than cosmetic:
//   - stale bookmarks / old email links / search-engine indexes may still
//     point at these paths. A 404 feels like the store is broken.
//   - support tickets frequently arrive with the merchant saying "I typed
//     admin.gbox.co and got a blank page". 302ing to the accounts portal
//     turns that into a one-click recovery.
//
// `resolveAccountsBaseUrl` mirrors the helper in session-auth.ts (TODO'd
// to Phase 0.6 for extraction) so changing the accounts base URL only
// requires touching ACCOUNTS_BASE_URL.
// ---------------------------------------------------------------------------

function resolveAccountsBaseUrl(req: express.Request): string {
  const base = (process.env.ACCOUNTS_BASE_URL ?? '').replace(/\/+$/, '')
  if (base) return base
  // Single-domain deploy (admin.gbox.co/accounts/*) hoặc multi-subdomain
  // đều ổn nếu set ACCOUNTS_BASE_URL. Fallback prod = same-origin theo
  // request host (không hardcode subdomain để tránh redirect-out-of-domain).
  if (process.env.NODE_ENV === 'production') {
    return `https://${req.headers.host || 'admin.gbox.co'}`
  }
  const host = (req.headers.host || 'localhost').split(':')[0]
  const port = process.env.ACCOUNTS_PORT ?? '4323'
  return `http://${host}:${port}`
}

// Mirror của resolveAccountsBaseUrl cho god-admin (port 4324). Local dev
// auto-route tới http://localhost:4324 qua GOD_ADMIN_PORT. Production có
// thể override bằng GOD_ADMIN_BASE_URL khi nginx chưa proxy /god-admin/*.
function resolveGodAdminBaseUrl(req: express.Request): string {
  const base = (process.env.GOD_ADMIN_BASE_URL ?? '').replace(/\/+$/, '')
  if (base) return base
  if (process.env.NODE_ENV === 'production') {
    return `https://${req.headers.host || 'admin.gbox.co'}`
  }
  const host = (req.headers.host || 'localhost').split(':')[0]
  const port = process.env.GOD_ADMIN_PORT ?? '4324'
  return `http://${host}:${port}`
}

function redirectToAccountsLogin(
  req: express.Request,
  res: express.Response,
  returnTo: string,
): void {
  const accountsUrl = resolveAccountsBaseUrl(req)
  res.redirect(
    `${accountsUrl}/accounts/login?return_to=${encodeURIComponent(returnTo)}`,
  )
}

// Bare /admin and /admin/ — unauth'd sellers sometimes type just the
// domain + /admin (muscle memory from Shopify). Bounce to accounts.
app.get(['/admin', '/admin/'], (req, res) =>
  redirectToAccountsLogin(req, res, '/accounts/stores'),
)

// Any /admin/login, /admin/signin, /login, /signin — typoed or stale URLs.
// `return_to=/accounts/stores` lands them on the shop picker after auth, which is
// where they'd have ended up anyway.
app.get(
  ['/admin/login', '/admin/signin', '/login', '/signin'],
  (req, res) => redirectToAccountsLogin(req, res, '/accounts/stores'),
)

// Signup flow: Shopify surfaces at `/join` / `/signup`. Merchants type
// these at admin.<platform> occasionally — route to the accounts signup.
app.get(['/signup', '/join', '/register'], (req, res) => {
  const accountsUrl = resolveAccountsBaseUrl(req)
  res.redirect(`${accountsUrl}/accounts/signup`)
})

// Logout convenience — some seller-facing links may still point at
// `admin.<platform>/logout`. Forward to the canonical accounts logout.
app.get(['/logout', '/admin/logout'], (req, res) => {
  const accountsUrl = resolveAccountsBaseUrl(req)
  res.redirect(`${accountsUrl}/accounts/logout`)
})

// ---------------------------------------------------------------------------
// /stores → /accounts/stores (consolidated 2026-05-06)
//
// Stores hub + create-store đã được hợp nhất về accounts.gbox.co/accounts/stores
// để có 1 nguồn duy nhất quản lý shop list + delete + UI card mới.
// admin.gbox.co/stores giữ lại như 302 redirect cho bookmark/old links.
//
// Iron Rule 5 guard: god-admin (isDefaultAdmin) vẫn bị bounce sang /god-admin
// trước khi redirect — tránh seller picker render với god-admin session.
// ---------------------------------------------------------------------------

const sessionAuth = createSessionAuthMiddleware()

app.get(['/stores', '/stores/new'], sessionAuth, (req, res) => {
  if (req.sessionUser?.isDefaultAdmin) {
    // iron-rule-5-ok: defensive god-admin-only redirect — absolute URL
    // because god-admin chạy ở port riêng (4324), không phải app này.
    res.redirect(`${resolveGodAdminBaseUrl(req)}/god-admin`)
    return
  }
  const accountsUrl = resolveAccountsBaseUrl(req)
  // /stores/new → trang tạo store ở accounts portal (/accounts/create-store).
  // /stores → list shops.
  const target = req.path === '/stores/new' ? '/accounts/create-store' : '/accounts/stores'
  res.redirect(`${accountsUrl}${target}`)
})

// ---------------------------------------------------------------------------
// Store auth on ALL /store/:slug/* routes
// ---------------------------------------------------------------------------

const storeAuth = createStoreAuthMiddleware()
app.use('/admin/store/:slug', storeAuth)

// Phase 14 PR7 — permission factory. Reused below on email / finance
// alerts routes. Owners + platform admins (both land with
// storeRole='owner') bypass automatically; staff + admin + limited
// consult `user_shops.permissions_computed`.
const requirePerm = createRequirePermission()
const requireEmailView = requirePerm('email:view')
const requireEmailManageTemplates = requirePerm('email:manage_templates')
const requireEmailManageSuppression = requirePerm('email:manage_suppression')
const requireEmailManageAlerts = requirePerm('email:manage_alerts')
const requireEmailSendTest = requirePerm('email:send_test')

// Phase D (2026-04-18) — Onboarding gate sits AFTER storeAuth so
// req.store is populated. When shops.onboarding_state='pending',
// non-bypass UI paths 302 into the wizard; when 'skipped',
// res.locals.showOnboardingBanner is set for the banner-injection
// middleware (Task D2) to splice the Resume-setup card into the
// layout. Terminal states (completed/cloning) pass through untouched.
// Kill-switch: GBOX_ONBOARDING_WIZARD_ENABLED=false disables the gate.
app.use('/admin/store/:slug', onboardingGate)

// Phase D Task D2 — Banner injection. Wraps res.send so that any HTML
// response carrying `<!--GBOX_ONBOARDING_BANNER_SLOT-->` gets the slot
// replaced with either the Resume-setup banner (flag true) or the
// empty string (flag false). The slot is embedded in seller-layout
// just above ${content}, so every page using the layout participates
// without edits to individual handlers. Buffer / JSON / stream bodies
// pass through untouched.
app.use('/admin/store/:slug', onboardingBannerInjector)

// ---------------------------------------------------------------------------
// Centralized CSRF protection on ALL /admin/store/:slug/* routes
// ---------------------------------------------------------------------------

const memoryCsrfBackend = createMemoryCsrfStore({ maxEntries: 10_000 })
const redisPreferredCsrfBackend: CsrfSecretStore = {
  async set(cookieId, secret, ttlSeconds) {
    try {
      const redis = await getRedis()
      await redis.set(`csrf:admin:${cookieId}`, secret, { EX: ttlSeconds })
    } catch {
      await memoryCsrfBackend.set(cookieId, secret, ttlSeconds)
    }
  },
  async get(cookieId) {
    try {
      const redis = await getRedis()
      return await redis.get(`csrf:admin:${cookieId}`)
    } catch {
      return await memoryCsrfBackend.get(cookieId)
    }
  },
  async delete(cookieId) {
    try {
      const redis = await getRedis()
      await redis.del(`csrf:admin:${cookieId}`)
    } catch {
      await memoryCsrfBackend.delete(cookieId)
    }
  },
}
export const csrfStore = createCsrfStore({ cookieName: 'gbox_csrf_admin', backend: redisPreferredCsrfBackend })

export function isProduction(): boolean {
  return process.env.NODE_ENV === 'production'
}

/**
 * GET middleware: issue a CSRF token and attach to req.csrfToken so pages
 * can embed it in forms via csrfStore.hiddenField(req.csrfToken).
 *
 * Uses `csrfStore.getOrIssue` (not raw `issue`) so a page-load doesn't
 * rotate the cookie under a previously-rendered form. Without that,
 * navigating /onboarding/clone → /onboarding/first-run → submit-clone-
 * form 403s because each /first-run GET overwrites the CSRF cookie
 * id, leaving the form's embedded token pointing at a cookie id the
 * browser no longer holds. Production incident 2026-04-25.
 */
app.use('/admin/store/:slug', async (req, _res, next) => {
  if (req.method === 'GET') {
    // Skip CSRF issuance for AJAX/API/SSE endpoints — they don't render
    // forms, and their Set-Cookie would overwrite the page-level cookie,
    // breaking the token that IS embedded in the form.
    const p = req.path
    if (
      p.endsWith('/notifications/recent') ||
      p.endsWith('/notifications/stream') ||
      p.endsWith('/events') ||
      p.endsWith('/ai/chat') ||
      p.endsWith('/csrf-refresh') ||
      p.startsWith('/api/') ||
      p.endsWith('/entity-picker')
    ) {
      next()
      return
    }
    try {
      const token = await csrfStore.getOrIssue(req, _res, isProduction())
      req.csrfToken = token
    } catch (err) {
      console.error('[CSRF] Failed to issue token:', err)
    }
  }
  next()
})

// CSRF refresh JSON endpoint — JS dùng fetch trước form submit để đảm bảo
// _csrf field luôn khớp backend secret hiện tại (chống case Redis/cookie
// drift khiến form rendered từ trước bị 403).
app.get('/admin/store/:slug/csrf-refresh', async (req, res) => {
  try {
    const token = await csrfStore.getOrIssue(req, res, isProduction())
    res.json({ token })
  } catch (err) {
    console.error('[csrf-refresh]', err)
    res.status(500).json({ error: 'failed' })
  }
})

/**
 * POST/PUT/DELETE middleware: validate the CSRF token before the route
 * handler runs. JSON API endpoints (ai/chat, notifications) are excluded
 * because they use session auth and are not form-based.
 */
app.use('/admin/store/:slug', async (req, res, next) => {
  if (req.method !== 'POST' && req.method !== 'PUT' && req.method !== 'DELETE') {
    next()
    return
  }

  // Skip CSRF for JSON API endpoints (not form submissions)
  const path = req.path
  if (
    // All /admin/store/:slug/api/* are JSON proxies hit by inline page
    // scripts via fetch(credentials:'same-origin'). SameSite=Lax cookie
    // + storeAuth tenant gate already block cross-origin abuse, and
    // these handlers don't render forms so there is no CSRF token to
    // round-trip. Mirror of the GET middleware whitelist above.
    path.startsWith('/api/') ||
    path.endsWith('/ai/chat') ||
    path.endsWith('/notifications/recent') ||
    // Fired from the topbar bell drawer (open + "Mark all as read")
    // as a fetch POST. SameSite=Lax on the session cookie + the
    // storeAuth tenant gate block cross-origin abuse, so a CSRF token
    // adds nothing here and would just force the drawer JS to round-
    // trip the hidden-input HTML it doesn't render.
    path.endsWith('/notifications/mark-seen') ||
    // Phase 12.5 PR2 — seller support widget polls this every 3s for
    // the unread badge. Same pattern as /notifications/mark-seen:
    // session cookie (SameSite=Lax) + storeAuth gate block cross-
    // origin abuse, and it's GET-only — no mutation, no CSRF surface.
    path.endsWith('/support/api/unread')
  ) {
    next()
    return
  }

  // Skip CSRF for SSE endpoints
  if (path.endsWith('/events')) {
    next()
    return
  }

  // Skip CSRF for routes that handle their own CSRF
  // 2026-05: /settings/payments removed — dùng csrfStore chính (xem payment-settings.ts).
  if (path.includes('/settings/plan') || path.includes('/settings/languages')) {
    next()
    return
  }

  // Skip CSRF for read-only export download.
  // Rationale: the handler only reads the store's own orders and streams a
  // file back — no state mutation, no data leak beyond what the session is
  // already authorized to see. SameSite=Lax on the session cookie blocks any
  // cross-origin POST from carrying the session, so CSRF adds nothing here.
  // Keeping it on caused intermittent 403s because the one-time token gets
  // consumed/rotated by background GETs before the user submits the form
  // (multi-tab, prefetchers, etc).
  if (path.endsWith('/orders/export/download')) {
    next()
    return
  }

  // Same rationale as orders/export/download above — stateless streaming of
  // the store's own data. SameSite=Lax session cookie blocks cross-origin
  // POST, so CSRF adds nothing and costs us intermittent 403s when a
  // background GET rotates the token between render and submit.
  if (path.endsWith('/products/export/download')) {
    next()
    return
  }

  // Phase 4 PR4 — customer CSV streaming download. Same reasoning as
  // products/export/download above: stateless GET-of-your-own-data via
  // POST, no cross-origin risk (SameSite=Lax blocks), and intermittent
  // token-rotation 403s hurt UX for no win.
  if (path.endsWith('/customers/export/download')) {
    next()
    return
  }

  // Skip CSRF for multipart/form-data upload routes.
  //
  // Why: the CSRF verifier reads `req.body._csrf`, but Express's global
  // body parsers (urlencoded/json) don't touch multipart — only the
  // per-route `multer` middleware does, and that runs AFTER this global
  // CSRF middleware. So `req.body` is still `{}` here and every upload
  // gets blocked with 403 (which looks to the user like "the Import
  // button doesn't do anything").
  //
  // Safety: the session cookie is SameSite=Lax, and `storeAuth`
  // middleware (already run above) gates the tenant, so a cross-origin
  // POST can't carry the session anyway — CSRF adds nothing here.
  //
  // If we need CSRF on uploads later, the right pattern is a per-route
  // check after multer has parsed the body (see draft-orders or
  // orders/bulk for the non-multipart pattern).
  if (
    path.endsWith('/orders/import/upload') ||
    path.endsWith('/orders/import-tracking/upload') ||
    path.endsWith('/products/import/upload') ||
    path.endsWith('/customers/import/upload') ||
    /\/orders\/[^/]+\/pod-upload$/.test(path) ||
    /\/fulfillments\/[^/]+\/pod-upload$/.test(path) ||
    path.endsWith('/online-store/files/upload') ||
    /\/products\/[^/]+\/media-upload$/.test(path) ||
    /\/products\/[^/]+\/media-remove$/.test(path) ||
    // POST /admin/store/<slug>/products — create product với multipart
    // (file media upload). multer chạy AFTER CSRF middleware → req.body
    // chưa parse → CSRF reject. Skip CSRF cho route này; storeAuth +
    // SameSite=Lax cookie + same-origin form đảm bảo CSRF protection.
    // Note: middleware mount tại '/admin/store/:slug' → req.path là RELATIVE
    // (chỉ '/products', không có prefix). So compare exact.
    path === '/products'
  ) {
    next()
    return
  }

  const valid = await csrfStore.verify(req)
  if (!valid) {
    // Diagnostic: log lý do thực sự để debug 403 thường xảy ra sau restart server.
    const cookieHeader = req.headers.cookie ?? ''
    const hasCookie = cookieHeader.includes('gbox_csrf_admin=')
    const hasBodyToken = !!(req.body as any)?._csrf
    console.warn(
      `[csrf] 403 path=${req.path} hasCookie=${hasCookie} hasBodyToken=${hasBodyToken} ` +
      `(typical cause: server restart cleared backend secret while form was open)`,
    )
    const referer = req.get('Referer') || ''
    res.status(403).send(`<!DOCTYPE html>
<html><head><title>403 — Form session expired</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:-apple-system,sans-serif;background:#0f172a;display:flex;align-items:center;justify-content:center;min-height:100vh;color:#e2e8f0;padding:20px}
  .c{text-align:center;max-width:520px}
  h1{font-size:42px;font-weight:800;color:#f59e0b;margin-bottom:8px}
  h2{font-size:18px;font-weight:600;color:#e2e8f0;margin:8px 0 16px}
  p{color:#94a3b8;margin-top:8px;line-height:1.5;font-size:14px}
  .btn{display:inline-block;margin-top:20px;padding:10px 24px;background:#6366f1;color:#fff;border-radius:8px;text-decoration:none;font-weight:600;border:none;cursor:pointer;font-size:14px}
  .btn-outline{background:transparent;color:#94a3b8;border:1px solid #334155;margin-left:8px}
  .btn:hover{opacity:.9}
  details{margin-top:24px;text-align:left;font-size:12px;color:#64748b}
  summary{cursor:pointer;color:#94a3b8}
  code{background:#1e293b;padding:2px 6px;border-radius:4px;color:#f1f5f9}
</style></head>
<body><div class="c">
  <h1>⚠️ 403</h1>
  <h2>Form session expired</h2>
  <p>Your form submission could not be verified. This usually happens when the server was restarted while you had the form open.</p>
  <p style="margin-top:8px"><strong>Your data is preserved</strong> — click below to reload the form and try submitting again.</p>
  <button class="btn" onclick="(function(){var r=${JSON.stringify(referer)};if(r){location.replace(r)}else{history.back()}})()">Reload form</button>
  <a class="btn btn-outline" href="javascript:history.back()">Go back</a>
  <details>
    <summary>Technical details</summary>
    <p style="margin-top:8px">Cookie present: <code>${hasCookie ? 'yes' : 'no'}</code> &middot; Body token present: <code>${hasBodyToken ? 'yes' : 'no'}</code></p>
    <p>If this keeps happening: clear cookies for this site and refresh.</p>
  </details>
</div></body></html>`)
    return
  }

  next()
})

// =========================================================================
// FULFILLMENT GATE — Phase F0 (2026-04)
// =========================================================================
// Fulfillment has been centralized: Gbox god admin pushes every paid order
// to Lenful on behalf of the seller. Sellers no longer manage their own
// fulfillments / tracking / POD uploads. This middleware returns a 410 Gone
// landing page for any legacy fulfillment URL when the platform flag
// `fulfillment_seller_enabled` is false (default since migration 030).
//
// The flag is cached in-process for 60s to avoid hitting the DB on every
// request. Flip it on via god admin > Config to temporarily restore the
// legacy seller pages (e.g. for a specific store during incident recovery).
// =========================================================================

let sellerFulfillmentEnabledCache: { value: boolean; expiresAt: number } | null = null
async function isSellerFulfillmentEnabled(): Promise<boolean> {
  const now = Date.now()
  if (sellerFulfillmentEnabledCache && sellerFulfillmentEnabledCache.expiresAt > now) {
    return sellerFulfillmentEnabledCache.value
  }
  let value = false
  if (!db) {
    value = false // Default to false in demo mode
  } else {
    try {
      const row = await db
        .selectFrom('platform_settings' as any)
        .select(['value'])
        .where('key', '=', 'fulfillment_seller_enabled')
        .executeTakeFirst()
      if (row && (row as any).value) {
        const raw = String((row as any).value).toLowerCase()
        value = raw === 'true' || raw === '1' || raw === 'yes' || raw === 'on'
      }
    } catch {
      // platform_settings table missing (shouldn't happen post-030) → keep default false
      value = false
    }
  }
  sellerFulfillmentEnabledCache = { value, expiresAt: now + 60_000 }
  return value
}

function isSellerFulfillmentPath(p: string): boolean {
  // /admin/store/:slug/fulfillments(/*)
  // /admin/store/:slug/orders/import-tracking(/*)
  // /admin/store/:slug/orders/:id/pod-upload
  // /admin/store/:slug/orders/:id/fulfill
  if (/^\/admin\/store\/[^/]+\/fulfillments(\/|$)/.test(p)) return true
  if (/^\/admin\/store\/[^/]+\/orders\/import-tracking(\/|$)/.test(p)) return true
  if (/^\/admin\/store\/[^/]+\/orders\/[^/]+\/pod-upload$/.test(p)) return true
  if (/^\/admin\/store\/[^/]+\/orders\/[^/]+\/fulfill$/.test(p)) return true
  return false
}

app.use('/admin/store/:slug', async (req, res, next) => {
  if (!isSellerFulfillmentPath(req.path)) {
    next()
    return
  }
  const enabled = await isSellerFulfillmentEnabled()
  if (enabled) {
    next()
    return
  }
  // Block — return JSON for POST/upload, HTML page for GET
  if (req.method !== 'GET') {
    res.status(410).json({
      ok: false,
      error: 'fulfillment_disabled_for_sellers',
      message: 'Fulfillment is now handled by Gbox. Sellers cannot push tracking, POD files, or manual fulfillments. Contact Gbox support if you need to intervene on a specific order.',
    })
    return
  }
  const backBase = `/admin/store/${req.params.slug}/orders`
  res.status(410).send(`<!DOCTYPE html>
<html><head><title>Fulfillment moved — Gbox</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;background:#0f172a;color:#e2e8f0;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}
  .c{max-width:560px;text-align:left;background:#1e293b;border:1px solid #334155;border-radius:16px;padding:32px 36px}
  .icon{width:48px;height:48px;border-radius:12px;background:#312e81;display:flex;align-items:center;justify-content:center;margin-bottom:16px;font-size:24px}
  h1{font-size:22px;font-weight:700;color:#fff;margin-bottom:8px}
  p{color:#94a3b8;line-height:1.6;margin-top:10px;font-size:14px}
  ul{color:#94a3b8;line-height:1.7;margin:12px 0 0 20px;font-size:14px}
  .actions{margin-top:22px;display:flex;gap:10px;flex-wrap:wrap}
  a.btn{display:inline-block;padding:10px 18px;border-radius:8px;background:#6366f1;color:#fff;text-decoration:none;font-weight:600;font-size:13px;border:1px solid #6366f1}
  a.btn.ghost{background:transparent;color:#cbd5e1;border-color:#475569}
  a.btn:hover{background:#4f46e5}
  a.btn.ghost:hover{background:#1e293b;color:#fff}
</style></head>
<body><div class="c">
  <div class="icon">📦</div>
  <h1>Fulfillment is now handled by Gbox</h1>
  <p>Starting this release, Gbox pushes every paid order to our production partner (Lenful) automatically. Sellers no longer need to:</p>
  <ul>
    <li>Upload POD / design files for fulfillment</li>
    <li>Import tracking numbers manually</li>
    <li>Open the legacy Fulfillment Center page</li>
  </ul>
  <p>Your orders continue to sync here with live status (<em>Pushed → In production → Shipped → Delivered</em>) once Gbox forwards them to Lenful. If something looks wrong on a specific order, <a href="mailto:support@gbox.co" style="color:#818cf8">contact Gbox support</a> and we will take care of it for you.</p>
  <div class="actions">
    <a class="btn" href="${backBase}">Back to Orders</a>
    <a class="btn ghost" href="mailto:support@gbox.co">Contact support</a>
  </div>
</div></body></html>`)
})

// =========================================================================
// A. DASHBOARD (Overview)
// =========================================================================

app.get('/admin/store/:slug', getDashboard)

// =========================================================================
// B. PRODUCTS (B1-B8)
// =========================================================================

app.get('/admin/store/:slug/products', getProducts)
app.post('/admin/store/:slug/products/bulk', postProductBulk)
// Phase 2 PR6 — bulk field edit (tags/pricing/collections/status/metafield)
app.post('/admin/store/:slug/products/bulk/edit', postProductBulkEdit)
app.get('/admin/store/:slug/products/new', getProductNew)
app.get('/admin/store/:slug/products/export', getProductExport)
app.post('/admin/store/:slug/products/export/download', postProductExportDownload)
app.get('/admin/store/:slug/products/import', getProductImport)
app.post(
  '/admin/store/:slug/products/import/upload',
  podUpload.single('csv'),
  postProductImportUpload,
)
app.get('/admin/store/:slug/products/inventory', getInventory)
app.post('/admin/store/:slug/products/inventory/adjust', postAdjustInventory)
// Phase 05 — bulk absolute set (=N) for selected SKUs
app.post('/admin/store/:slug/products/inventory/bulk-set', postBulkSetInventory)
// Variant CRUD — BE pattern: GET product full → modify variants[] → PUT product
app.post('/admin/store/:slug/products/inventory/variants/create', postCreateVariant)
app.post('/admin/store/:slug/products/inventory/variants/update', postUpdateVariant)
app.post('/admin/store/:slug/products/inventory/variants/delete', postDeleteVariant)
// Phase 6 PR2 — inventory analytics report
app.get('/admin/store/:slug/reports/inventory', getInventoryAnalytics)
// Phase 6 PR3 — customer behavior report
app.get('/admin/store/:slug/reports/customers', getCustomerBehavior)
// Phase 14 PR4 — email open/click analytics
app.get('/admin/store/:slug/reports/email-analytics', requireEmailView, getEmailAnalyticsPage)
// Collections routes — replaced (was using Categories as Collections).
// Wired tới BE CollectionController qua shop-collections handlers.
app.get('/admin/store/:slug/products/collections', getShopCollections)
app.get('/admin/store/:slug/products/collections/new', getCreateShopCollection)
app.post('/admin/store/:slug/products/collections', postCreateShopCollection)
app.post('/admin/store/:slug/products/collections/new', postCreateShopCollection)
app.get('/admin/store/:slug/products/collections/products-search', getShopCollectionsProductsSearch)
app.get('/admin/store/:slug/products/collections/slug-check', getShopCollectionSlugCheck)
app.post('/admin/store/:slug/products/collections/bulk', postBulkShopCollections)
app.get('/admin/store/:slug/products/collections/:id/edit', getEditShopCollection)
app.post('/admin/store/:slug/products/collections/:id/update', postUpdateShopCollection)
app.post('/admin/store/:slug/products/collections/:id/delete', postDeleteShopCollection)
app.post('/admin/store/:slug/products/collections/:id/products/add', postShopCollectionProductAdd)
app.post('/admin/store/:slug/products/collections/:id/products/remove/:product_id', postShopCollectionProductRemove)
// LEGACY routes — vẫn giữ map sang handler cũ phòng ngoại lệ. Comment khi remove.
// app.get('/admin/store/:slug/products/collections/:collectionId', (req, res) => getCollectionDetail(req, res, db))
// app.post('/admin/store/:slug/products/collections/:collectionId/products/reorder', (req, res) => postCollectionProductsReorder(req, res, db))
// app.post('/admin/store/:slug/products/collections/:collectionId/metafields', (req, res) => postCollectionMetafieldAdd(req, res, db))
// app.post('/admin/store/:slug/products/collections/:collectionId/metafields/:metafieldId/delete', (req, res) => postCollectionMetafieldDelete(req, res, db))
app.get('/admin/store/:slug/products/purchase-orders', getPurchaseOrders)
app.get('/admin/store/:slug/products/purchase-orders/new', (req, res) => getCreatePurchaseOrder(req, res, db))
app.get('/admin/store/:slug/products/purchase-orders/products-search', (req, res) => getPurchaseOrderProductsSearch(req, res, db))
app.post('/admin/store/:slug/products/purchase-orders', (req, res) => postCreatePurchaseOrder(req, res, db))
app.get('/admin/store/:slug/products/transfers', getTransfers)
app.get('/admin/store/:slug/products/transfers/new', (req, res) => getCreateTransfer(req, res, db))
app.get('/admin/store/:slug/products/transfers/products-search', (req, res) => getPurchaseOrderProductsSearch(req, res, db))
app.post('/admin/store/:slug/products/transfers', (req, res) => postCreateTransfer(req, res, db))
app.get('/admin/store/:slug/gift-cards', getGiftCards)
app.get('/admin/store/:slug/gift-cards/new', getCreateGiftCard)
app.post('/admin/store/:slug/gift-cards', postCreateGiftCard)
// Phase 10 PR2 — per-card detail + email delivery actions.
app.get('/admin/store/:slug/gift-cards/:giftCardId', getGiftCardDetail)
app.post('/admin/store/:slug/gift-cards/:giftCardId/send-email', postSendGiftCardEmail)
app.post('/admin/store/:slug/gift-cards/:giftCardId/update', postUpdateGiftCard)
app.post('/admin/store/:slug/gift-cards/:giftCardId/disable', postDisableGiftCard)
app.get('/admin/store/:slug/products/gift-cards', getGiftCards)
app.get('/admin/store/:slug/products/gift-cards/new', getCreateGiftCard)
app.get('/admin/store/:slug/products/gift-cards/product/new', getCreateGiftCardProduct)
app.get('/admin/store/:slug/products/reviews', getReviews)
app.get('/admin/store/:slug/products/reviews/settings', getReviewSettings)
app.post('/admin/store/:slug/products/reviews/settings/moderation', postReviewSettingsModeration)
app.post('/admin/store/:slug/products/reviews/settings/notifications', postReviewSettingsNotifications)
app.post('/admin/store/:slug/products/reviews/bulk', postBulkAction)
app.post('/admin/store/:slug/products/reviews/:reviewId/approve', postApproveReview)
app.post('/admin/store/:slug/products/reviews/:reviewId/reject', postRejectReview)
app.post('/admin/store/:slug/products/reviews/:reviewId/delete', postDeleteReview)
app.post('/admin/store/:slug/products/reviews/:reviewId/reply', postReply)
// Lenful catalog tab (Phase F8) — literal paths, must be registered before /:productId/*
app.post('/admin/store/:slug/products/lenful/import', postProductImportFromLenful)
app.post('/admin/store/:slug/products/lenful/sync-now', postLenfulCatalogSyncNow)
app.get('/admin/store/:slug/products/:productId', getProductDetail)
app.post('/admin/store/:slug/products/:productId/update', postProductUpdate)
app.post('/admin/store/:slug/products/:productId/delete', postProductDelete)
app.post('/admin/store/:slug/products/:productId/status-toggle', postProductStatusToggle)
app.post('/admin/store/:slug/products/:productId/duplicate', postProductDuplicate)
app.post('/admin/store/:slug/products/:productId/media', postProductMediaAdd)
app.post('/admin/store/:slug/products/:productId/media/:mediaId/delete', postProductMediaDelete)
// API-mode upload: multipart file → BE Shop Service S3 upload → append to product.images via Product PUT.
app.post('/admin/store/:slug/products/:productId/media-upload', podUpload.single('file'), postProductMediaUploadApi)
// API-mode remove: ?index=N → splice from product.images and PUT back.
app.post('/admin/store/:slug/products/:productId/media-remove', postProductMediaRemoveApi)
app.post('/admin/store/:slug/products/:productId/variants', postProductVariantAdd)
app.post('/admin/store/:slug/products/:productId/variants/:variantId/update', postProductVariantUpdate)
app.post('/admin/store/:slug/products/:productId/variants/:variantId/delete', postProductVariantDelete)
// Phase 2 PR6 — SEO shortcut: one-click upsert of seo.title/description/handle metafields
app.post('/admin/store/:slug/products/:productId/seo-shortcut', postProductSeoShortcut)
// Phase 2 PR1 — product metafields (Custom data sidebar card).
app.post('/admin/store/:slug/products/:productId/metafields', postProductMetafieldAdd)
app.post('/admin/store/:slug/products/:productId/metafields/:metafieldId/delete', postProductMetafieldDelete)
app.post('/admin/store/:slug/products', podUpload.array('media', 10), postProductCreate)

// =========================================================================
// C. ORDERS (C1-C6)
// =========================================================================

app.get('/admin/store/:slug/orders', getOrders)
app.post('/admin/store/:slug/orders/bulk', postOrderBulk)
app.post('/admin/store/:slug/orders/:id/delete', postOrderDeleteApi)
app.get('/admin/store/:slug/api/my-stores', getMyStoresApi)
app.post('/admin/store/:slug/api/customers/quick-create', postQuickCreateCustomer)
app.get('/admin/store/:slug/api/products-search', searchProductsApi)
app.get('/admin/store/:slug/api/orders-search', searchOrdersApi)
app.get('/admin/store/:slug/api/shipping-zones', listShippingZonesApi)
app.post('/admin/store/:slug/api/orders/:orderId/update', postOrderUpdateApi)
app.get('/admin/store/:slug/orders/drafts', getDraftOrders)
app.get('/admin/store/:slug/orders/drafts/new', getDraftOrderNew)
app.get('/admin/store/:slug/orders/drafts/api/products', getDraftProductsSearch)
app.get('/admin/store/:slug/orders/drafts/api/customers', getDraftCustomersSearch)
app.get('/admin/store/:slug/orders/drafts/export', getDraftOrdersExport)
app.post('/admin/store/:slug/orders/drafts/bulk', postBulkDraftAction)
app.get('/admin/store/:slug/orders/drafts/:id', getDraftOrderDetail)
app.post('/admin/store/:slug/orders/drafts', postDraftOrderCreate)
app.post('/admin/store/:slug/orders/drafts/:id/update', postDraftOrderUpdate)
app.post('/admin/store/:slug/orders/drafts/:id/send-invoice', postSendInvoice)
app.post('/admin/store/:slug/orders/drafts/:id/convert', postConvertDraft)
app.post('/admin/store/:slug/orders/drafts/:id/delete', postDeleteDraft)
app.get('/admin/store/:slug/orders/export', getOrderExport)
app.post('/admin/store/:slug/orders/export/download', postOrderExportDownload)
app.get('/admin/store/:slug/orders/import', getOrderImport)
app.post('/admin/store/:slug/orders/import/upload', podUpload.single('file'), postOrderImportUpload)
app.post('/admin/store/:slug/orders/import/confirm', postOrderImportConfirm)
app.get('/admin/store/:slug/orders/import-tracking', getImportTracking)
app.post('/admin/store/:slug/orders/import-tracking/upload', podUpload.single('file'), postImportTrackingUpload)
app.post('/admin/store/:slug/orders/import-tracking/confirm', postImportTrackingConfirm)
app.post('/admin/store/:slug/orders/saved-filters', postSaveOrderFilter)
app.post('/admin/store/:slug/orders/saved-filters/:id/delete', postDeleteOrderFilter)
app.get('/admin/store/:slug/orders/abandoned', getAbandonedCheckouts)
app.get('/admin/store/:slug/orders/analytics', getOrderAnalytics)
app.get('/admin/store/:slug/refund-requests', getRefundRequests)
app.get('/admin/store/:slug/refund-requests/new', getCreateRefundRequest)
app.post('/admin/store/:slug/refund-requests/new', postCreateRefundRequest)
app.get('/admin/store/:slug/orders/:orderId', getOrderDetail)
app.post('/admin/store/:slug/orders/:orderId/edit', postOrderEdit)
app.post('/admin/store/:slug/orders/:orderId/add-note', postOrderAddNote)
app.post('/admin/store/:slug/orders/:orderId/pod-upload', podUpload.single('file'), postPodUpload)
app.post('/admin/store/:slug/orders/:orderId/fulfill', postFulfillOrder)

// =========================================================================
// C-FULFILL. FULFILLMENTS + POD
// =========================================================================

app.get('/admin/store/:slug/fulfillments', getFulfillments)
app.get('/admin/store/:slug/fulfillments/:orderId', getFulfillmentDetail)
app.post('/admin/store/:slug/fulfillments/:orderId/pod-upload', podUpload.single('file'), postPodUploadFulfillment)

// =========================================================================
// C-RETURNS. RETURNS & REFUNDS
// =========================================================================

app.get('/admin/store/:slug/returns', getReturns)
app.get('/admin/store/:slug/returns/:returnId', getReturnDetail)
app.post('/admin/store/:slug/returns/:returnId/approve', postApproveReturn)
app.post('/admin/store/:slug/returns/:returnId/receive', postReceiveReturn)
app.post('/admin/store/:slug/returns/:returnId/refund', postRefundReturn)
app.post('/admin/store/:slug/returns/:returnId/cancel', postCancelReturn)
app.get('/admin/store/:slug/orders/:orderId/return', getCreateReturn)
app.post('/admin/store/:slug/orders/:orderId/return', postCreateReturn)

// =========================================================================
// D. CUSTOMERS (D1-D6)
// =========================================================================

app.get('/admin/store/:slug/customers', getCustomers)
app.get('/admin/store/:slug/customers/new', getCustomerNew)
// Delete 1 customer — gọi BE Customer-Service DELETE bulk với body=[id].
app.post('/admin/store/:slug/customers/:customerId/delete', async (req, res) => {
  const { postCustomerDeleteApi } = await import('./pages/customer-detail-api.js')
  return postCustomerDeleteApi(req, res)
})
// Phase 4 PR4 — CSV import + export. Declared BEFORE the
// /:customerId route so Express doesn't route "import" / "export"
// into the customer-detail handler.
app.get('/admin/store/:slug/customers/export', getCustomerExport)
app.post('/admin/store/:slug/customers/export/download', postCustomerExportDownload)
app.get('/admin/store/:slug/customers/import', getCustomerImport)
app.post(
  '/admin/store/:slug/customers/import/upload',
  podUpload.single('csv'),
  postCustomerImportUpload,
)
app.post('/admin/store/:slug/customers/import/commit', postCustomerImportCommit)
// Segment routes are declared BEFORE /customers/:customerId so Express
// doesn't match "segments" or "segments/new" as a customerId path.
app.get('/admin/store/:slug/customers/segments', getCustomerSegments)
app.get('/admin/store/:slug/customers/segments/new', getCustomerSegmentNew)
app.post('/admin/store/:slug/customers/segments', postCustomerSegmentCreate)
// View customers in a segment — declared BEFORE the bare /:segmentId
// route so Express doesn't match "customers" as a segmentId suffix.
app.get('/admin/store/:slug/customers/segments/:segmentId/customers', getCustomerSegmentCustomers)
app.get('/admin/store/:slug/customers/segments/:segmentId', getCustomerSegmentDetail)
app.post('/admin/store/:slug/customers/segments/:segmentId', postCustomerSegmentUpdate)
app.post('/admin/store/:slug/customers/segments/:segmentId/delete', postCustomerSegmentDelete)
app.post('/admin/store/:slug/customers/bulk', postCustomerBulk)
// Phase 4 PR5 — shared quick-filter pills (create + delete). Declared
// BEFORE the `/customers/:customerId` routes so the literal
// `quick-filters` segment isn't captured as a customer id.
app.post('/admin/store/:slug/customers/quick-filters', postCustomerQuickFilterCreate)
app.post('/admin/store/:slug/customers/quick-filters/:id/delete', postCustomerQuickFilterDelete)
app.post('/admin/store/:slug/customers', postCustomerCreate)
app.get('/admin/store/:slug/customers/:customerId', getCustomerDetail)
app.get('/admin/store/:slug/customers/:customerId/edit', getCustomerEdit)
app.post('/admin/store/:slug/customers/:customerId/edit', postCustomerEdit)
// Phase 4 PR1 — structured notes timeline + inline tag chip editor.
app.post('/admin/store/:slug/customers/:customerId/notes', postCustomerAddNote)
app.post('/admin/store/:slug/customers/:customerId/notes/:noteId/delete', postCustomerDeleteNote)
app.post('/admin/store/:slug/customers/:customerId/tags', postCustomerUpdateTags)

// =========================================================================
// D2. CONTENT (Metaobjects, Files — Shopify Content section)
// =========================================================================

app.get('/admin/store/:slug/content', getContentHub)
app.get('/admin/store/:slug/content/metaobjects', getMetaobjects)
app.get('/admin/store/:slug/content/files', getFilesPage)

// =========================================================================
// E. DISCOUNTS (E1-E5)
// =========================================================================

app.get('/admin/store/:slug/discounts', getDiscounts)
app.get('/admin/store/:slug/discounts/new', getCreateDiscount)
app.post('/admin/store/:slug/discounts', postCreateDiscount)
app.get('/admin/store/:slug/discounts/:discountId', getDiscountDetail)
app.post('/admin/store/:slug/discounts/:discountId/update', postUpdateDiscount)
app.post('/admin/store/:slug/discounts/:discountId/delete', postDeleteDiscount)

// =========================================================================
// F. MARKETING (F1-F5)
// =========================================================================

app.get('/admin/store/:slug/markets', getMarkets)
app.get('/admin/store/:slug/markets/new', getCreateMarket)
app.post('/admin/store/:slug/markets', postCreateMarket)
app.get('/admin/store/:slug/marketing', getMarketingDashboard)
app.get('/admin/store/:slug/marketing/campaigns', getCampaignsList)
app.get('/admin/store/:slug/marketing/campaigns/new', getCampaignEditor)
app.get('/admin/store/:slug/marketing/campaigns/:id', getCampaignEditor)
app.post('/admin/store/:slug/marketing/campaigns/create', postCreateCampaign)
app.post('/admin/store/:slug/marketing/campaigns/:id/update', postUpdateCampaign)
app.post('/admin/store/:slug/marketing/campaigns/:id/delete', postDeleteCampaign)
app.post('/admin/store/:slug/marketing/campaigns/:id/schedule', postScheduleCampaign)
app.post('/admin/store/:slug/marketing/campaigns/:id/cancel', postCancelCampaign)
// Phase 14 PR3 — legacy `/marketing/automations` is retained for a single
// release so bookmarks keep working, but now it 301s to the unified
// `/settings/automations` surface. The old handlers are still imported
// above so we can unwind cleanly if AUTOMATION_FRAMEWORK_V2 is rolled
// back — the import stays dead-weight-free thanks to tree-shaking in
// production bundles but costs nothing at runtime.
app.get('/admin/store/:slug/marketing/automations', (req, res) => {
  res.redirect(301, `/admin/store/${req.params.slug}/settings/automations`)
})
app.post('/admin/store/:slug/marketing/automations', postAutomationToggle)
app.get('/admin/store/:slug/marketing/abandoned', getAbandonedCarts)
// Phase 8 PR2d — Recovery-flow settings + ad-hoc send-now + manual
// tick runner. `settings` and `run-tick` MUST come BEFORE
// `:enrollmentId/send-now` so Express doesn't capture the literal
// segment as an enrolment id.
// Phase 14 PR3 — abandoned-cart settings are migrating under the new
// unified `/settings/automations` hub. Keep the GET as a 301 so bookmarks
// + in-email links that referenced the old URL still land on the right
// page. The POST handler stays wired in case AUTOMATION_FRAMEWORK_V2 is
// rolled back — Phase 8 fallback path then writes to shop_settings.*
// exactly as before. When the flag rollout stabilizes we drop the POST
// and the legacy handler file.
app.get('/admin/store/:slug/marketing/abandoned/settings', (req, res) => {
  res.redirect(301, `/admin/store/${req.params.slug}/settings/automations`)
})
app.post('/admin/store/:slug/marketing/abandoned/settings', postAbandonedCartSettings)
app.post('/admin/store/:slug/marketing/abandoned/run-tick', postAbandonedCartRunTick)
app.post('/admin/store/:slug/marketing/abandoned/:enrollmentId/send-now', postAbandonedCartSendNow)
app.get('/admin/store/:slug/marketing/seo', getSeoManager)
// Phase 8 PR3d — SEO settings (meta defaults + tracking IDs + noindex toggle)
// and "run scan" button. Mirrors the abandoned-cart settings layout.
app.get('/admin/store/:slug/marketing/seo/settings', getSeoSettings)
app.post('/admin/store/:slug/marketing/seo/settings', postSeoSettings)
app.post('/admin/store/:slug/marketing/seo/scan', postSeoScan)

// =========================================================================
// G. ANALYTICS (G1-G6)
// =========================================================================

app.get('/admin/store/:slug/analytics', getAnalyticsDashboard)
app.get('/admin/store/:slug/analytics/reports', getSalesReport)
app.get('/admin/store/:slug/analytics/live', getLiveView)

// SSE endpoint for live view real-time stats (ShopBase-style payload).
// Payload shape is aligned with apps/store-admin/src/pages/live-view.ts:
//   { visitors_now, sessions_10, sales_10, sales_currency, orders_10 }
// Respects ?scope=all for multistore aggregation when the user has
// access to more than one store.
app.get('/admin/store/:slug/analytics/live/stream', async (req, res) => {
  const store = req.store
  const user = req.storeUser
  if (!store || !user) { res.status(401).end(); return }

  // Resolve multistore scope the same way the page handler does.
  let storeIds: string[] = [store.id]
  if (req.query.scope === 'all') {
    try {
      // db here is typed against the root Kysely; listAccessibleStores
      // expects @gbox/db's own Kysely instance — same baseline mismatch
      // that every other call site in server.ts works around with `as any`.
      const accessibleStores = await listAccessibleStores(db as any, user.id, user.role)
      if (accessibleStores.length > 1) {
        storeIds = accessibleStores.map((s) => s.id)
      }
    } catch { /* fall back to single-store */ }
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.write('retry: 10000\n\n')

  const currencySymbol = (store as any).currency === 'VND' ? '' : '$'
  const currencySuffix = (store as any).currency === 'VND' ? ' VND' : ''

  const sendStats = async () => {
    try {
      const now = new Date()
      const tenMinsAgo = new Date(now.getTime() - 10 * 60 * 1000).toISOString()

      const [visitorsNowRow, sessionsLast10Row, ordersLast10Row] = await Promise.all([
        // M2: visitors = distinct sessions in page_views last 5 min
        db
          .selectFrom('page_views' as any)
          .select(sql<number>`COUNT(DISTINCT session_id)`.as('count'))
          .where('shop_id', 'in', storeIds)
          .where('created_at', '>', sql<string>`NOW() - INTERVAL '5 minutes'`)
          .executeTakeFirst(),
        db
          .selectFrom('checkout_sessions')
          .select(db.fn.count('id').as('count'))
          .where('shop_id', 'in', storeIds)
          .where('created_at', '>=', tenMinsAgo as any)
          .executeTakeFirst(),
        db
          .selectFrom('orders')
          .select([
            db.fn.count('id').as('order_count'),
            db.fn.sum('total_price').as('sales_total'),
          ])
          .where('shop_id', 'in', storeIds)
          .where('created_at', '>=', tenMinsAgo as any)
          .where('financial_status', '!=', 'voided')
          .executeTakeFirst(),
      ])

      const salesTotal = Number((ordersLast10Row as any)?.sales_total ?? 0)
      const data = JSON.stringify({
        visitors_now: String(Number((visitorsNowRow as any)?.count ?? 0)),
        sessions_10: String(Number((sessionsLast10Row as any)?.count ?? 0)),
        orders_10: String(Number((ordersLast10Row as any)?.order_count ?? 0)),
        sales_10: salesTotal.toFixed(2) + currencySuffix,
        sales_currency: currencySymbol,
      })
      res.write(`event: stats\ndata: ${data}\n\n`)
    } catch { /* graceful — client reconnects */ }
  }

  // Send immediately, then every 10 seconds
  await sendStats()
  const interval = setInterval(sendStats, 10000)

  req.on('close', () => {
    clearInterval(interval)
    res.end()
  })
})

app.get('/admin/store/:slug/analytics/sales', getSalesReport)
app.get('/admin/store/:slug/analytics/sales/export.csv', getSalesReportCsv)
app.get('/admin/store/:slug/analytics/products', getProductReport)
app.get('/admin/store/:slug/analytics/customers', getCustomerReport)
app.get('/admin/store/:slug/analytics/finance', getFinanceReport)
app.get('/admin/store/:slug/analytics/finance/export.csv', getFinanceReportCsv)

// M4 — Measurement dashboards (backed by page_views + orders + events)
app.get('/admin/store/:slug/analytics/traffic', getTrafficSourcesReport)
app.get('/admin/store/:slug/analytics/funnel', getConversionFunnelReport)
app.get('/admin/store/:slug/analytics/attribution', getAttributionReport)
app.get('/admin/store/:slug/analytics/cohort', getCohortReportPage)

// =========================================================================
// G.6 APPS / PLUGIN SYSTEM
// =========================================================================

app.get('/admin/store/:slug/apps', getApps)
app.post('/admin/store/:slug/apps/install', postInstallApp)
app.post('/admin/store/:slug/apps/uninstall', postUninstallApp)
app.get('/admin/store/:slug/apps/:appId/config', getAppConfig)
app.post('/admin/store/:slug/apps/:appId/config', postAppConfig)

// =========================================================================
// H. ONLINE STORE (H1-H6)
// =========================================================================

app.get('/admin/store/:slug/online-store', getOnlineStoreHub)

// 2026-04-26 — Clone Pro re-scoped to god-admin-only concierge tooling.
// Every legacy seller-visible clone path 410s with a seller-friendly
// "contact support" message. Iron Rule 5: never expose god-admin
// surfaces. Sellers who want a storefront cloned email contact@gbox.co;
// god admin runs the job via internal tooling and imports results into
// the seller's store.
const cloneProRetiredHandler = (_req: any, res: any) => {
  res.status(410).type('text/plain').send(
    'Storefront cloning is now a concierge service. Please contact Gbox support.',
  )
}

// C6b: Themes list. Legacy /online-store/themes/clone returns 410.
app.get('/admin/store/:slug/online-store/themes', getThemesList)
// Sidebar "Theme editor" entry-point — resolves the seller's main
// theme and 302s onward to /themes/:id/customize. Stable URL the
// sidebar can carry even though the customizer needs a per-theme id.
app.get('/admin/store/:slug/online-store/theme-editor', getThemeEditorEntry)
app.get('/admin/store/:slug/online-store/themes/clone', cloneProRetiredHandler)
app.post('/admin/store/:slug/online-store/themes/clone', cloneProRetiredHandler)

// 2026-04-26 cleanup — unified Library (Cloned themes + Design references).
// Replaces standalone /clone-library and /design-library entries; both
// 301 here. The handler reads `?tab=clones|designs` (default 'clones')
// and dispatches to the existing per-source handler (no logic moved).
app.get('/admin/store/:slug/online-store/library', getLibraryPage)

// Theme Editor
app.get('/admin/store/:slug/online-store/themes/:themeId/editor', getThemeEditor)
app.get('/admin/store/:slug/online-store/themes/:themeId/editor/search', getThemeEditorSearch)
app.get('/admin/store/:slug/online-store/themes/:themeId/editor/file', getThemeFile)
app.post('/admin/store/:slug/online-store/themes/:themeId/editor/file', postThemeFile)
app.post('/admin/store/:slug/online-store/themes/:themeId/editor/new-file', postNewThemeFile)
app.post('/admin/store/:slug/online-store/themes/:themeId/editor/delete', postDeleteThemeFile)
app.post('/admin/store/:slug/online-store/themes/:themeId/activate', postActivateTheme)
app.post('/admin/store/:slug/online-store/themes/:themeId/duplicate', postDuplicateTheme)
// Sprint 11 — download a theme as a Shopify-format .zip.
app.get('/admin/store/:slug/online-store/themes/:themeId/export', getThemeExport)
app.get('/admin/store/:slug/themes/:themeId/export', getThemeExport)

// Phase 23 PR1 — Theme Customizer (visual editor) entry points.
// PR1 ships read-only shell + sidebar tree + iframe preview. Mutations,
// settings forms, inspector overlay, publish flow land in PR2-8. Routes
// pass through the same store-auth + page-rate-limiter chain as the
// existing code editor.
app.get('/admin/store/:slug/themes/:themeId/customize', getThemeCustomizer)
app.get('/admin/store/:slug/themes/:themeId/customize/sections.json', getThemeCustomizerSectionsJson)
app.get('/admin/store/:slug/themes/:themeId/customize/preview-url', getThemeCustomizerPreviewUrl)
// Sprint 8 PR-C — read schema for one section (drives right-panel form),
// then write paths for settings/blocks/visibility/add/remove/reorder.
app.get('/admin/store/:slug/themes/:themeId/customize/sections/:sectionId/schema.json', getSectionSchema)
app.post('/admin/store/:slug/themes/:themeId/customize/sections/:sectionId/settings', postSectionSettings)
app.post('/admin/store/:slug/themes/:themeId/customize/sections/:sectionId/blocks', postSectionBlocks)
app.post('/admin/store/:slug/themes/:themeId/customize/sections/:sectionId/visibility', postSectionVisibility)
app.post('/admin/store/:slug/themes/:themeId/customize/sections/add', postAddSection)
app.delete('/admin/store/:slug/themes/:themeId/customize/sections/:sectionId', deleteSectionRoute)
app.post('/admin/store/:slug/themes/:themeId/customize/sections/reorder', postReorderSections)
// Sprint 10 — versions + drafts + publish workflow.
app.post('/admin/store/:slug/themes/:themeId/customize/publish', postThemeCustomizerPublish)
app.post('/admin/store/:slug/themes/:themeId/customize/snapshot', postThemeCustomizerSnapshot)
app.get('/admin/store/:slug/themes/:themeId/customize/versions.json', getThemeCustomizerVersions)
app.post('/admin/store/:slug/themes/:themeId/customize/versions/:versionId/restore', postThemeCustomizerRestoreVersion)
// Sprint 8 PR-D — picker-search endpoints. Resource-scoped under
// /online-store/picker/* so they're easy to spot in nginx logs and don't
// collide with the per-theme customize subtree.
app.get('/admin/store/:slug/online-store/picker/products', getProductPicker)
app.get('/admin/store/:slug/online-store/picker/collections', getCollectionPicker)
app.get('/admin/store/:slug/online-store/picker/pages', getPagePicker)
app.get('/admin/store/:slug/online-store/picker/blogs', getBlogPicker)
app.get('/admin/store/:slug/online-store/picker/articles', getArticlePicker)

// Visual Editor (Page Builder)
registerVisualEditorRoutes(app)

// Pages (CMS) — Phase 7 PR1 adds /pages/bulk for bulk publish/unpublish/delete.
// Declared BEFORE /:pageId so Express doesn't treat "bulk" as a pageId.
app.get('/admin/store/:slug/online-store/pages', getPages)
app.get('/admin/store/:slug/online-store/pages/new', getCreatePage)
app.post('/admin/store/:slug/online-store/pages', postCreatePage)
app.post('/admin/store/:slug/online-store/pages/bulk', postBulkPages)
app.get('/admin/store/:slug/online-store/pages/:pageId', getPageDetail)
app.post('/admin/store/:slug/online-store/pages/:pageId', postUpdatePage)
app.post('/admin/store/:slug/online-store/pages/:pageId/delete', postDeletePage)

// Blog
app.get('/admin/store/:slug/online-store/blog', getBlogPosts)
app.get('/admin/store/:slug/online-store/blog/new', getCreateBlogPost)
app.post('/admin/store/:slug/online-store/blog', postCreateBlogPost)
// Bulk MUST be registered before /:postId or Express treats "bulk"
// as a valid postId and routes to the single-post GET handler.
app.post('/admin/store/:slug/online-store/blog/bulk', postBulkBlogPosts)
app.get('/admin/store/:slug/online-store/blog/:postId', getBlogPostDetail)
app.post('/admin/store/:slug/online-store/blog/:postId', postUpdateBlogPost)
app.post('/admin/store/:slug/online-store/blog/:postId/delete', postDeleteBlogPost)

// 2026-04-26 cleanup — old /online-store/design hub retired. Canonical
// entry is /online-store/themes (theme management).
app.get('/admin/store/:slug/online-store/design', (req, res) => {
  res.redirect(301, `/admin/store/${req.params.slug}/online-store/themes`)
})

// Legacy clone-pro / clone-library / storefront-clone paths return 410.
// (cloneProRetiredHandler defined above near /online-store/themes/clone)
const cloneProRetiredPaths = [
  '/admin/store/:slug/storefront-clone',
  '/admin/store/:slug/storefront-clone/:rest(*)',
  '/admin/store/:slug/online-store/design/clone',
  '/admin/store/:slug/online-store/design/clone/:rest(*)',
  '/admin/store/:slug/clone-pro',
  '/admin/store/:slug/clone-pro/:rest(*)',
  '/admin/store/:slug/clone-library',
  '/admin/store/:slug/clone-library/:rest(*)',
]
for (const p of cloneProRetiredPaths) {
  app.get(p, cloneProRetiredHandler)
  app.post(p, cloneProRetiredHandler)
}

// /storefront-clone/pixels redirected to /settings/pixels for legacy
// bookmarks (pixels were never a clone-specific feature).
app.get('/admin/store/:slug/storefront-clone/pixels', (req, res) => {
  res.redirect(301, `/admin/store/${req.params.slug}/settings/pixels`)
})
app.post('/admin/store/:slug/storefront-clone/pixels', (req, res) => {
  res.redirect(307, `/admin/store/${req.params.slug}/settings/pixels`)
})

// Phase D4 (2026-04-18): Design Library. Scoped to the current shop
// (req.store.id from middleware). GET page + two GET AJAX endpoints
// backing the preview modal + one POST for clone-row deletion.
//
// 2026-04-26 cleanup — the page lives at /online-store/library?tab=designs
// now (merged with Clone Library). The bare /design-library path
// 301s there for old bookmarks. AJAX endpoints (entry, preview)
// stay on the legacy path because the modal JS bundle hard-codes
// them; rewriting JS would inflate this PR's diff for no UX win.
app.get('/admin/store/:slug/design-library', (req, res) => {
  res.redirect(301, `/admin/store/${req.params.slug}/online-store/library?tab=designs`)
})
app.get('/admin/store/:slug/design-library/entry/:source/:slug', (req, res) =>
  getDesignLibraryEntryJson(req, res),
)
app.get('/admin/store/:slug/design-library/preview/:source/:slug', (req, res) =>
  getDesignLibraryPreview(req, res),
)
// Sprint 8 — install Gbox Default theme + import a theme .zip. The
// install-default form is a plain POST; the import form is multipart
// (5 MB cap, see themeZipUpload above).
app.post('/admin/store/:slug/online-store/theme-library/install-default', (req, res) =>
  postInstallDefaultTheme(req, res),
)
app.post(
  '/admin/store/:slug/online-store/theme-library/import',
  themeZipUpload.single('theme_zip'),
  (req, res) => postImportTheme(req as any, res),
)

app.post('/admin/store/:slug/design-library/clone/:entrySlug/delete', (req, res) =>
  postDeleteDesignLibraryEntry(req, res),
)

// Phase B (2026-04-18) — Onboarding wizard entry surface.
//
// /onboarding/first-run is the main welcome page (two-tab: Clone from
// URL + Theme Library). State-based routing inside the handler keeps
// completed stores out (→ dashboard). Pending + skipped states render
// the welcome surface.
//
// /onboarding/library is a convenience alias that 302s into
// /onboarding/first-run?tab=library so any link ("open my theme
// library") lands on the same page with Tab 2 pre-selected.
//
// 2026-04-26: /onboarding/clone removed — clone-from-URL is god-admin-
// only concierge tooling. Sellers start with the Theme Library tab only.
//
// Both routes inherit storeAuth via `app.use('/admin/store/:slug',
// storeAuth)` mounted further up — no per-route middleware needed.
app.get('/admin/store/:slug/onboarding/first-run', (req, res) =>
  getOnboardingFirstRun(req, res),
)
app.get('/admin/store/:slug/onboarding/library', (req, res) =>
  getOnboardingLibraryRedirect(req, res),
)

// Phase C (2026-04-18) — Onboarding wizard mutators.
//
// POST /onboarding/skip: pending → skipped. Renders the Resume-setup
//   banner on every subsequent dashboard view.
// POST /onboarding/dismiss-banner: skipped → completed with
//   choice='dismissed'. Terminal — no more wizard surfaces for this shop.
// GET /onboarding/clone: 410 (concierge service, see cloneProRetiredHandler).
app.get('/admin/store/:slug/onboarding/clone', cloneProRetiredHandler)
app.post('/admin/store/:slug/onboarding/skip', (req, res) =>
  postOnboardingSkip(req, res),
)
app.post('/admin/store/:slug/onboarding/dismiss-banner', (req, res) =>
  postDismissOnboardingBanner(req, res),
)

// Navigation, Domains, Files
app.get('/admin/store/:slug/online-store/navigation', (req, res) => getNavigation(req, res, db))
app.get('/admin/store/:slug/online-store/navigation/resources', (req, res) => getResourceSearch(req, res, db))
// Menu-level CRUD
app.post('/admin/store/:slug/online-store/navigation/menus', (req, res) => postCreateMenu(req, res, db))
app.post('/admin/store/:slug/online-store/navigation/menus/:menuId/delete', (req, res) => postDeleteMenu(req, res, db))
app.post('/admin/store/:slug/online-store/navigation/menus/:menuId/rename', (req, res) => postRenameMenu(req, res, db))
app.post('/admin/store/:slug/online-store/navigation/menus/:menuId/reorder', (req, res) => postReorderMenu(req, res, db))
app.post('/admin/store/:slug/online-store/navigation/menus/:menuId/save-items', (req, res) => postSaveMenuItems(req, res, db))
// Item-level CRUD
app.post('/admin/store/:slug/online-store/navigation/items', (req, res) => postCreateMenuItem(req, res, db))
app.post('/admin/store/:slug/online-store/navigation/items/:itemId/update', (req, res) => postUpdateMenuItem(req, res, db))
app.post('/admin/store/:slug/online-store/navigation/items/:itemId/delete', (req, res) => postDeleteMenuItem(req, res, db))
app.get('/admin/store/:slug/online-store/domains', getDomains)
app.post('/admin/store/:slug/online-store/domains', postAddDomain)
app.post('/admin/store/:slug/online-store/domains/remove', postRemoveDomain)
app.get('/admin/store/:slug/online-store/files', getFilesPage)
// Phase 7 PR5 — Files library upload/rename/delete. The upload route uses
// multer memoryStorage with a 20MB cap (same as product/CSV imports). CSRF
// is skipped for the multipart upload (see CSRF middleware above).
app.post('/admin/store/:slug/online-store/files/upload', podUpload.single('file'), postUploadFile)
app.post('/admin/store/:slug/online-store/files/:id/delete', postDeleteFile)
app.post('/admin/store/:slug/online-store/files/:id/update', postUpdateFile)
app.get('/admin/store/:slug/online-store/preferences', getPreferences)
app.post('/admin/store/:slug/online-store/preferences', postPreferences)

// Phase 2B Sprint 1 placeholders (full pages ship in Sprints 3 + 4).
app.get('/admin/store/:slug/online-store/landing', (req, res) => getLandingPages(req, res))
app.get('/admin/store/:slug/online-store/watermark', (req, res) => getWatermarkPage(req, res))
app.get('/admin/store/:slug/online-store/size-charts', (req, res) => getSizeChartsPage(req, res))

// =========================================================================
// I. SHIPPING & J. TAX & K. SETTINGS (I1-I5, J1-J3, K1-K7)
// =========================================================================

app.get('/admin/store/:slug/settings', getSettings)
app.get('/admin/store/:slug/settings/general', getGeneralSettings)
app.post('/admin/store/:slug/settings/general', postGeneralSettings)
// Phase 14 PR3 — unified automation settings (Shopify Flow lite). Lists
// all 18 catalog flows with per-flow enable toggle + delay override.
// Legacy `/marketing/automations` and `/marketing/abandoned/settings`
// both 301 here (handlers above in the marketing block).
app.get('/admin/store/:slug/settings/automations', getSettingsAutomations)
app.post('/admin/store/:slug/settings/automations', postSettingsAutomations)
// Phase 14 PR6 commit 8 — narrow finance-alerts view onto the same
// automation_flows rows. Scopes to the 10 PR6 finance keys (5 wired,
// 5 Phase 12 deferred). POST ignores deferred keys server-side.
app.get('/admin/store/:slug/settings/finance-alerts', requireEmailView, getSettingsFinanceAlerts)
app.post('/admin/store/:slug/settings/finance-alerts', requireEmailManageAlerts, postSettingsFinanceAlerts)
// Phase 9 PR4 — staff + permissions (migration 069).
app.get('/admin/store/:slug/settings/staff', getStaffSettings)
app.post('/admin/store/:slug/settings/staff/invite', strictLimiter, postStaffInvite)
app.post('/admin/store/:slug/settings/staff/invitations/:id/revoke', postStaffInvitationRevoke)
app.get('/admin/store/:slug/settings/staff/:userId', getStaffMember)
app.post('/admin/store/:slug/settings/staff/:userId/update', postStaffMemberUpdate)
app.post('/admin/store/:slug/settings/staff/:userId/disable', postStaffMemberDisable)
app.post('/admin/store/:slug/settings/staff/:userId/reenable', postStaffMemberReenable)
app.post('/admin/store/:slug/settings/staff/:userId/remove', postStaffMemberRemove)

// Phase 9 PR4 — security (sign-in history + active sessions).
app.get('/admin/store/:slug/settings/security', getSecuritySettings)

// Phase 9 PR4 — alerts (feed + per-event preferences).
app.get('/admin/store/:slug/settings/alerts', getAlertsSettings)
app.post('/admin/store/:slug/settings/alerts/:id/read', postAlertRead)
app.post('/admin/store/:slug/settings/alerts/:id/dismiss', postAlertDismiss)
app.post('/admin/store/:slug/settings/alerts/read-all', postAlertsReadAll)
app.post('/admin/store/:slug/settings/alerts/preferences', postAlertPreferences)

app.get('/admin/store/:slug/settings/payments', getPaymentSettings)
app.post('/admin/store/:slug/settings/payments', postPaymentSettings)
app.post('/admin/store/:slug/settings/payments/disconnect-paypal', postDisconnectPaypal)
app.get('/admin/store/:slug/settings/payments/paypal/onboard-start', getPaypalOnboardStart)
app.get('/admin/store/:slug/settings/payments/paypal/onboard-callback', getPaypalOnboardCallback)
// PayPal multi-account management
app.post('/admin/store/:slug/settings/payments/paypal-accounts/add', postPaypalAccountAdd)
app.post('/admin/store/:slug/settings/payments/paypal-accounts/toggle', postPaypalToggle)
app.post('/admin/store/:slug/settings/payments/paypal-accounts/:id/activate', postPaypalAccountActivate)
app.post('/admin/store/:slug/settings/payments/paypal-accounts/:id/delete', postPaypalAccountDelete)

// Shipping
// Phase I: primary /settings/shipping route serves the full-featured page
// (previously orphaned at /settings/shipping/full). The legacy handler
// (getShippingSettings, postCreateShippingZone) is kept available for
// backward-compat via /settings/shipping/legacy.
app.get('/admin/store/:slug/settings/shipping', getShippingSettingsPage)
app.get('/admin/store/:slug/settings/shipping/legacy', getShippingSettings)
app.post('/admin/store/:slug/settings/shipping/legacy', postCreateShippingZone)

// Tax settings — list + add form (UI Thai chốt). Bám BE Subfee.
app.get('/admin/store/:slug/settings/taxes', getSurchargesPage)
app.post('/admin/store/:slug/settings/taxes', postSurchargeCreate)
app.post('/admin/store/:slug/settings/taxes/:id/delete', postSurchargeDelete)
app.post('/admin/store/:slug/settings/taxes/:id', postSurchargeUpdate)

// Notifications
app.get('/admin/store/:slug/settings/notifications', getNotificationSettings)
app.get('/admin/store/:slug/settings/notifications/templates/:name/edit', getEmailTemplateEdit)
app.post('/admin/store/:slug/settings/notifications/templates/:name', postEmailTemplateUpdate)

// Email automation templates — Gbox Email Service (api-email.gbox.co).
// /clone phải đứng TRƯỚC /:sys_name để Express không match "clone" vào :sys_name.
app.get('/admin/store/:slug/settings/email-templates', requireEmailView, getEmailAutomationList)
app.post('/admin/store/:slug/settings/email-templates/clone', requireEmailManageTemplates, postEmailAutomationClone)
app.get('/admin/store/:slug/settings/email-templates/:sys_name', requireEmailView, getEmailAutomationEditor)
app.post('/admin/store/:slug/settings/email-templates/:sys_name/save', requireEmailManageTemplates, postEmailAutomationSave)
app.post('/admin/store/:slug/settings/email-templates/:sys_name/reset', requireEmailManageTemplates, postEmailAutomationReset)

// Phase 14 PR4.B — email suppressions (bounce/complaint blocklist)
// Action list: view + manually unsuppress. Writes coming in from the
// webhook path (/webhooks/email/ses, /webhooks/email/generic) land on
// the storefront app and never touch this surface.
app.get('/admin/store/:slug/settings/email-suppressions', requireEmailView, getEmailSuppressionsPage)
app.post('/admin/store/:slug/settings/email-suppressions/:id/unsuppress', requireEmailManageSuppression, postUnsuppressAction)

// Phase 14 PR5 — GDPR/Privacy request queue. List + staff actions.
// The corresponding customer-facing surface lives on the accounts
// portal (`/accounts/privacy`) — this page is the seller-side triage
// queue. Cross-shop access is blocked inside the handlers.
app.get('/admin/store/:slug/settings/privacy-requests', getPrivacyRequestsPage)
app.post('/admin/store/:slug/settings/privacy-requests/:id/cancel', postCancelDeletionAction)
app.post('/admin/store/:slug/settings/privacy-requests/:id/mark-ready', postMarkReadyAction)

// Legal
app.get('/admin/store/:slug/settings/legal', getLegalPages)

// Billing — orphaned in Phase I. Redirect to the Plan page (which holds the
// billing UI in the new model). The original getBillingPage is still
// exported from settings-extended.ts in case we want to restore a dedicated
// billing page later.
app.get('/admin/store/:slug/settings/billing', (req, res) => {
  res.redirect(`/admin/store/${req.params.slug}/settings/plan`)
})

// Activity Log
app.get('/admin/store/:slug/settings/activity', getActivityLog)

// Phase 2+ placeholders for sidebar nav completeness
app.get('/admin/store/:slug/settings/plan', getPlanSettings)
app.post('/admin/store/:slug/settings/plan', postChangePlan)
app.post('/admin/store/:slug/settings/plan/cancel', postCancelPlan)
app.post('/admin/store/:slug/settings/plan/reactivate', postReactivatePlan)
app.get('/admin/store/:slug/settings/checkout', getCheckoutSettings)
app.post('/admin/store/:slug/settings/checkout', postCheckoutSettings)
app.get('/admin/store/:slug/settings/markets', getMarketsSettings)
app.post('/admin/store/:slug/settings/markets', postMarketsSettings)
// Phase 9 PR3 — Markets rich CRUD (migration 068)
app.post('/admin/store/:slug/settings/markets/from-template', postMarketFromTemplate)
app.post('/admin/store/:slug/settings/markets/create', postMarketCreate)
app.post('/admin/store/:slug/settings/markets/update', postMarketUpdate)
app.post('/admin/store/:slug/settings/markets/delete', postMarketDelete)
app.post('/admin/store/:slug/settings/markets/link-zone', postMarketLinkZone)
app.post('/admin/store/:slug/settings/markets/link-registration', postMarketLinkRegistration)

// Phase 9 PR3 — Currencies settings (migration 068 shop cols)
app.get('/admin/store/:slug/settings/currencies', getCurrenciesSettings)
app.post('/admin/store/:slug/settings/currencies', postCurrenciesSettings)
app.get('/admin/store/:slug/settings/customer-accounts', getCustomerAccountsSettings)
app.post('/admin/store/:slug/settings/customer-accounts', postCustomerAccountsSettings)
app.get('/admin/store/:slug/settings/custom-data', getCustomDataSettings)
app.get('/admin/store/:slug/settings/languages', getLanguagesSettings)
app.post('/admin/store/:slug/settings/languages', postLanguagesSettings)

// AI Settings
app.get('/admin/store/:slug/settings/ai', getAiSettings)
app.post('/admin/store/:slug/settings/ai', postAiSettings)
app.get('/admin/store/:slug/settings/ai/clear', getAiSettingsClearKey)

// Phase 10 PR1 — AI Copywriter REST endpoints (JSON in/out).
// All POST routes are rate-limited — we don't want a runaway loop
// draining the shop's AI budget. `/api/ai/status` is cheap so it
// uses the default pageLimiter.
app.get('/admin/store/:slug/api/ai/status', getAiStatus)
app.post('/admin/store/:slug/api/ai/product-description', strictLimiter, postAiProductDescription)
app.post('/admin/store/:slug/api/ai/product-tags', strictLimiter, postAiProductTags)
app.post('/admin/store/:slug/api/ai/campaign-suggestion', strictLimiter, postAiCampaignSuggestion)
app.post('/admin/store/:slug/api/ai/email-subjects', strictLimiter, postAiEmailSubjects)

// Marketing pixels — multi-pixel CRUD (migration 034 — row-per-pixel).
// The legacy /storefront-clone/pixels paths still 301/307 → /settings/pixels.
app.get('/admin/store/:slug/settings/pixels', getPixelConfigPage)
app.get('/admin/store/:slug/settings/pixels/new', (req, res) => getPixelNewPage(req, res))
app.post('/admin/store/:slug/settings/pixels', postPixelCreate)
app.get('/admin/store/:slug/settings/pixels/:id/edit', getPixelEditPage)
app.post('/admin/store/:slug/settings/pixels/:id', postPixelUpdate)
app.post('/admin/store/:slug/settings/pixels/:id/delete', postPixelDelete)
app.post('/admin/store/:slug/settings/pixels/:id/toggle', postPixelToggle)

// Locations (Inventory Locations)
app.get('/admin/store/:slug/settings/locations', getLocations)
app.post('/admin/store/:slug/settings/locations/create', postCreateLocation)
app.post('/admin/store/:slug/settings/locations/update', postUpdateLocation)
app.post('/admin/store/:slug/settings/locations/delete', postDeleteLocation)

// Enhanced Shipping POSTs (forms rendered by /settings/shipping)
// /settings/shipping/full now redirects to /settings/shipping (where the full
// page is served from) so old bookmarks continue to work.
app.get('/admin/store/:slug/settings/shipping/full', (req, res) => {
  res.redirect(`/admin/store/${req.params.slug}/settings/shipping`)
})
app.post('/admin/store/:slug/settings/shipping/create-zone', postCreateZone)
app.post('/admin/store/:slug/settings/shipping/create-rate', postCreateRate)
app.post('/admin/store/:slug/settings/shipping/delete-zone', postDeleteZone)
app.post('/admin/store/:slug/settings/shipping/delete-method', postDeleteMethod)
app.get('/admin/store/:slug/settings/shipping/entity-picker', getEntityPicker)
// Phase 9 PR1 — carrier-aware shipping
app.post('/admin/store/:slug/settings/shipping/carrier-enable', postEnableCarrier)
app.post('/admin/store/:slug/settings/shipping/carrier-toggle', postCarrierToggle)
app.post('/admin/store/:slug/settings/shipping/carrier-live-toggle', postCarrierLiveToggle)
app.post('/admin/store/:slug/settings/shipping/seed-rates', postSeedRates)
app.post('/admin/store/:slug/settings/shipping/remove-carrier-rates', postRemoveCarrierRates)

// =========================================================================
// ACTIVITY LOG (standalone full-featured page)
// =========================================================================

app.get('/admin/store/:slug/activity', getActivityLogPage)

// =========================================================================
// NOTIFICATIONS CENTER (full page)
// =========================================================================

app.get('/admin/store/:slug/notifications', getNotificationsPage)
app.post('/admin/store/:slug/notifications/mark-read', postMarkRead)
app.post('/admin/store/:slug/notifications/mark-all-read', postMarkAllRead)
// JSON mark-seen: fired from the topbar bell drawer the moment it opens,
// and from the drawer's "Mark all as read" button. CSRF is skipped for
// this path in the middleware above (line ~413) because the handler is
// pure AJAX — SameSite=Lax on the session cookie + the storeAuth gate
// is sufficient. See notifications-admin.postMarkAllSeen for the
// request/response contract.
app.post('/admin/store/:slug/notifications/mark-seen', postMarkAllSeen)

// =========================================================================
// SUPPORT (Phase 12.5 PR2 — seller-facing tickets + widget polling)
// =========================================================================

// JSON polling endpoint MUST come before /support/:ticketId so the path
// doesn't get swallowed by the dynamic route ("api" isn't a ticket UUID
// but Express matches literally against :ticketId).
app.get('/admin/store/:slug/support/api/unread', getSupportUnreadCount)
app.get('/admin/store/:slug/support', getSupportTicketList)
app.get('/admin/store/:slug/support/new', (req, res) => getSupportTicketNew(req, res))
app.post('/admin/store/:slug/support/new', postSupportTicketCreate)
app.get('/admin/store/:slug/support/:ticketId', getSupportTicketDetail)
app.post('/admin/store/:slug/support/:ticketId/reply', postSupportMessageCreate)
app.post('/admin/store/:slug/support/:ticketId/read', postSupportMarkRead)
app.post('/admin/store/:slug/support/:ticketId/csat', postSupportCsat)

// =========================================================================
// NOTIFICATIONS API (for topbar bell drawer)
// =========================================================================

app.get('/admin/store/:slug/notifications/recent', async (req, res) => {
  const store = req.store
  if (!store) { res.status(401).json({ items: [], unreadCount: 0 }); return }

  // Phase 14 Demo Mode — if db is null, provide mock notifications
  if (!db) {
    const items = [
      { id: 'n1', text: 'New order #1056', message: 'Jane Doe placed an order for $120.00', time: '5m ago', read: false, type: 'order' },
      { id: 'n2', text: 'Stock low: Canvas Tote', message: 'Variant "Black" is down to 2 units', time: '1h ago', read: false, type: 'stock' },
      { id: 'n3', text: 'Payout processed', message: 'Your payout of $450.00 is on its way', time: '2h ago', read: true, type: 'payout' },
    ]
    res.json({ items, unreadCount: 2 })
    return
  }

  try {
    // Read from notifications table (not audit_logs)
    const notifs = await db.selectFrom('notifications')
      .select(['id', 'type', 'title', 'message', 'read', 'resource_type', 'resource_id', 'created_at'])
      .where('shop_id', '=', store.id)
      .orderBy('created_at', 'desc')
      .limit(15)
      .execute()

    // Get unread count
    const unreadResult = await db.selectFrom('notifications')
      .select(db.fn.count('id').as('count'))
      .where('shop_id', '=', store.id)
      .where('read', '=', false)
      .executeTakeFirst()
    const unreadCount = Number(unreadResult?.count ?? 0)

    const items = notifs.map(n => {
      const timeAgo = getTimeAgo(new Date(n.created_at))
      return {
        id: n.id,
        text: n.title,
        message: n.message || '',
        time: timeAgo,
        read: n.read,
        type: n.type,
      }
    })

    res.json({ items, unreadCount })
  } catch (err: any) {
    console.error('[Notifications] Failed to load:', err.message)
    res.json({ items: [], unreadCount: 0 })
  }
})

// SSE: Real-time notification stream
app.get('/admin/store/:slug/notifications/stream', (req, res) => {
  const store = req.store
  if (!store) { res.status(401).end(); return }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // nginx passthrough
  })

  // Send heartbeat every 30s to keep connection alive
  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n')
  }, 30000)

  // Register this client for the store
  const storeId = store.id
  if (!sseClients.has(storeId)) sseClients.set(storeId, new Set())
  sseClients.get(storeId)!.add(res)

  req.on('close', () => {
    clearInterval(heartbeat)
    sseClients.get(storeId)?.delete(res)
    if (sseClients.get(storeId)?.size === 0) sseClients.delete(storeId)
  })

  // Send initial connection event
  res.write('data: {"type":"connected"}\n\n')
})

// SSE client registry (store_id → Set of Response objects)
const sseClients = new Map<string, Set<import('express').Response>>()

// Helper to push notification to all connected clients for a store
export function pushNotification(storeId: string, event: { type: string; text: string }) {
  const clients = sseClients.get(storeId)
  if (!clients) return
  const data = JSON.stringify(event)
  for (const client of clients) {
    client.write(`data: ${data}\n\n`)
  }
}

/**
 * Fire-and-forget helper for server.ts endpoints that can't import
 * lib/notify.ts without creating a circular dependency. Mirrors the
 * semantics of notify() in lib/notify.ts: inserts a notifications row
 * and pushes via SSE. Errors are logged but swallowed — the caller's
 * operation already succeeded by the time this runs.
 */
function emitNotification(
  storeId: string,
  userId: string | null | undefined,
  type: string,
  title: string,
  resourceType: string | null = null,
  resourceId: string | null = null,
  message: string | null = null,
): void {
  db.insertInto('notifications')
    .values({
      shop_id: storeId,
      user_id: userId ?? null,
      type,
      title,
      message: message ?? null,
      resource_type: resourceType,
      resource_id: resourceId,
    } as any)
    .execute()
    .then(() => {
      try { pushNotification(storeId, { type, text: title }) } catch { /* ignore */ }
    })
    .catch((e: any) => {
      console.error(`[emitNotification] insert failed for type=${type}:`, e?.message)
    })
}

function getTimeAgo(date: Date): string {
  const now = new Date()
  const diff = now.getTime() - date.getTime()
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return 'Just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

// =========================================================================
// G.3. AUTOMATIONS API (Custom Automations — Shopify Flow equivalent)
// =========================================================================

app.get('/api/store/:slug/automations', async (req, res) => {
  const store = req.store
  if (!store) { res.status(401).json({ error: 'Not authenticated' }); return }
  try {
    const automations = await listCustomAutomations(db, store.id)
    res.json({ automations })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

app.post('/api/store/:slug/automations', async (req, res) => {
  const store = req.store
  if (!store) { res.status(401).json({ error: 'Not authenticated' }); return }
  const { name, trigger, actions, enabled } = req.body
  if (!name || !trigger || !actions) {
    res.status(400).json({ error: 'name, trigger, and actions are required' })
    return
  }
  try {
    const automation = await createAutomation(db, store.id, { name, trigger, actions, enabled })
    emitNotification(store.id, (req as any).storeUser?.id, 'automation_created', `Automation created: ${name}`, 'automation', (automation as any)?.id)
    res.status(201).json({ automation })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

app.put('/api/store/:slug/automations/:id', async (req, res) => {
  const store = req.store
  if (!store) { res.status(401).json({ error: 'Not authenticated' }); return }
  const { name, trigger, actions, enabled } = req.body
  try {
    const updated = await updateAutomation(db, store.id, req.params.id, { name, trigger, actions, enabled })
    if (!updated) { res.status(404).json({ error: 'Automation not found' }); return }
    emitNotification(store.id, (req as any).storeUser?.id, 'automation_updated', `Automation updated${name ? ': ' + name : ''}`, 'automation', req.params.id)
    res.json({ automation: updated })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

app.delete('/api/store/:slug/automations/:id', async (req, res) => {
  const store = req.store
  if (!store) { res.status(401).json({ error: 'Not authenticated' }); return }
  try {
    const deleted = await deleteAutomation(db, store.id, req.params.id)
    if (!deleted) { res.status(404).json({ error: 'Automation not found' }); return }
    emitNotification(store.id, (req as any).storeUser?.id, 'automation_deleted', 'Automation deleted', 'automation', req.params.id)
    res.json({ success: true })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// =========================================================================
// L. AI AGENT
// =========================================================================

app.post('/admin/store/:slug/ai/chat', async (req, res) => {
  const store = req.store
  if (!store) {
    res.status(401).json({ error: 'Not authenticated' })
    return
  }

  const { message, context } = req.body
  if (!message || typeof message !== 'string') {
    res.status(400).json({ error: 'Message required' })
    return
  }

  const response = await handleAIChat(db, {
    storeId: store.id,
    storeName: store.name,
    storeSlug: store.slug,
    userMessage: message,
    currentPage: context || '',
  })

  res.json(response)
})

// =========================================================================
// Placeholder page factory (for remaining Phase 2+ routes)
// =========================================================================

function placeholderPage(pageName: string, navId: string) {
  return (req: express.Request, res: express.Response) => {
    const store = req.store!
    const user = req.storeUser!
    const theme = (req as any).theme || 'dark'
    res.send(sellerLayout({
      title: pageName,
      storeName: store.name,
      storeSlug: store.slug,
      userName: user.name,
      userEmail: user.email,
      userRole: user.role,
      storeRole: user.storeRole,
      activePage: navId,
      theme,
      content: `
        <div class="page-header">
          <h1 class="page-title">${esc(pageName)}</h1>
        </div>
        <div class="card">
          <div class="card-body">
            <div class="empty-state">
              <div class="empty-state-icon">&#128679;</div>
              <div class="empty-state-title">Coming Soon</div>
              <div class="empty-state-text">The ${esc(pageName)} section is being built. Check back soon!</div>
            </div>
          </div>
        </div>
      `,
    }))
  }
}

// ---------------------------------------------------------------------------
// Root redirect
// ---------------------------------------------------------------------------

app.get('/', sessionAuth, (req, res) => {
  // Phase 0.5: root of admin.<platform> now lands on our own local
  // /stores hub instead of bouncing across to the accounts portal.
  // The session cookie is scoped to the parent domain so the auth
  // check in `sessionAuth` will see a valid session if the user is
  // already logged in — and bounce them back to accounts/login if
  // not. One fewer cross-origin hop, one fewer place to get wrong.
  //
  // Iron Rule 5: god admins get bounced to /god-admin instead of
  // /stores so they never see the seller hub. See the /stores handler
  // below for the same guard (in case a god-admin hits /stores
  // directly).
  if (req.sessionUser?.isDefaultAdmin) {
    // Mirror guard for the /stores handler above — absolute URL vì
    // god-admin chạy ở app/port riêng (4324), không cùng store-admin.
    res.redirect(`${resolveGodAdminBaseUrl(req)}/god-admin`) // iron-rule-5-ok
    return
  }
  res.redirect('/stores')
})

// ---------------------------------------------------------------------------
// 404
// ---------------------------------------------------------------------------

app.use((_req, res) => {
  // Phase 0.5: send 404s back to our own /stores hub, same reason as
  // the root redirect above. Anything 404 on admin.<platform> is
  // almost certainly a stale bookmark or a typoed slug, and /stores
  // is the right canonical landing page.
  res.status(404).send(`<!DOCTYPE html>
<html><head><title>404 - Store Admin</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:-apple-system,sans-serif;background:#0f172a;display:flex;align-items:center;justify-content:center;min-height:100vh;color:#e2e8f0}
  .c{text-align:center}
  h1{font-size:72px;font-weight:800;color:#6366f1;margin:0}
  p{color:#94a3b8;margin-top:8px}
  a{color:#818cf8;text-decoration:none}
  a:hover{text-decoration:underline}
</style></head>
<body><div class="c">
  <h1>404</h1>
  <p>Page not found</p>
  <p><a href="/accounts/stores">Go to stores</a></p>
</div></body></html>`)
})

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

// Shopify-format error handler (must be last middleware)
app.use(shopifyErrorHandler())

// Install process-level error handlers
installProcessErrorHandlers('gbox-store-admin')

// 2026-04-27 — Idempotent UPSERT of the 16 built-in section schemas the
// theme customizer's "+ Add section" modal lists. Without these rows
// the right-panel form has no schema to render so settings forms come
// up empty. Seeded on every boot so a code edit propagates without a
// migration. Errors are logged but never block server startup — the
// app still works without seeds, just with an empty Add-section modal.
import { ensureBuiltinSchemas } from '@gbox/core/modules/themes/section-schemas-seed.js'
;(async () => {
  try {
    await ensureBuiltinSchemas()
    console.log('[Gbox Store Admin] Built-in section schemas seeded')
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[Gbox Store Admin] section-schemas seed failed:', (err as Error).message)
  }
})()

const server = app.listen(PORT, () => {
  console.log(`[Gbox Store Admin] Running on http://localhost:${PORT} | PID: ${process.pid}`)
  console.log(`[Gbox Store Admin] Routes: ~80 (12 feature groups A-L)`)
  console.log(`[Gbox Store Admin] ENV: ${process.env.NODE_ENV ?? 'development'}`)
})

// Configure keep-alive
configureKeepAlive(server)

// Graceful shutdown
async function shutdown() {
  console.log('[Gbox Store Admin] Shutting down...')
  await closeRedis()
  process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
