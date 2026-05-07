# Gbox Platform — Measurement & Analytics Roadmap

**Author:** Claude (pair-programmer)  
**Date:** 2026-04-16  
**Owner:** Thai Bui  
**Status:** In progress — M1 + M2 + M3 shipped (2026-04-16); M4 + M5 pending

**Progress log**

| Milestone | Status | Commit |
|---|---|---|
| M1 — Measurement Foundation | ✅ shipped | `c223f74 feat(analytics): M1 Measurement Foundation — page_views table, UTM wiring, daily metrics` |
| M2 — Live View Upgrades | ✅ shipped | `36c67ba feat(store-admin/live-view): M2 — real page_views data, Top pages + Traffic sources panels` |
| M3 — Pixel Integration Polish | ✅ shipped | `a654f31 feat(pixels): M3 — real HTTP POSTs for Meta CAPI, GA4 MP, TikTok Events API` |
| M4 — Analytics Dashboards v2 | ⏳ pending | — |
| M5 — Advanced Measurement | ⏳ pending | — |

---

## 1. Audit: What exists today

### 1.1 UTM Attribution

| Component | File | Status |
|---|---|---|
| UTM fields on `orders` table | `packages/db/.../tables.ts` (OrderTable) | Columns exist: `utm_source/medium/campaign/content/term` |
| Checkout → Order copy | `packages/core/.../checkout/service.ts` | `createCheckout()` accepts a `CheckoutUtm` object and copies to the order at completion |
| Cookie-based first-touch capture | _(missing)_ | Comment says "storefront middleware stamps gbox_utm cookie" but **no such middleware exists** |
| UTM filter UI (orders dashboard) | `apps/store-admin/src/lib/order-filters.ts` | WHERE `orders.utm_source ILIKE ...` — read-only |

**Gap:** No storefront middleware captures UTM params into a 30-day first-touch cookie. Sellers can't attribute orders to campaigns unless the storefront caller manually passes UTM params at checkout creation.

### 1.2 Page View Tracking

| Component | File | Status |
|---|---|---|
| `recordPageView()` | `packages/core/.../events/storefront-events.ts` | Inserts into `events` table (verb = `page_view`). Fire-and-forget. |
| Admin audit log | `apps/store-admin/src/middleware/store-auth.ts` | Logs admin page views to `audit_logs` — not storefront analytics |
| No auto-recording middleware | _(missing)_ | Storefront must call `recordPageView()` explicitly; no global middleware does this |

**Gap:** Page views land in the generic `events` table (not a dedicated `page_views` table), so querying visitors/day or top pages requires scanning all events. The `daily_metrics.visitors` column is hardcoded to 0.

### 1.3 Analytics Dashboards

| Page | File | What it shows |
|---|---|---|
| Analytics Dashboard | `apps/store-admin/src/pages/analytics.ts` | Revenue chart, summary KPIs, 5 report tabs (Sales, Products, Customers, Finance, Overview). Queries `orders`, `customers`, `order_line_items` directly. |
| Order Analytics | `apps/store-admin/src/pages/order-analytics.ts` | Period selector (7d/30d/90d/all), daily order/revenue charts, fulfillment/payment breakdowns, top products, repeat customer rate. Queries `orders` directly. |
| Live View | `apps/store-admin/src/pages/live-view.ts` | 4 KPI cards (visitors, sessions, sales, orders), world map, behavior bars (active carts, checking out, purchased). All data from last 10 minutes. |

**Gap:** No traffic-source breakdown (which UTM campaigns drive revenue), no conversion funnels, no cohort analysis, no attribution modeling.

### 1.4 Daily Metrics Aggregation

| Component | File | Status |
|---|---|---|
| Nightly cron rollup | `packages/core/.../analytics/daily-metrics.ts` | `rollupYesterdayAllShops()` aggregates `orders` → `daily_metrics(orders_count, revenue, refunds)`. Triggered at 00:05 UTC. |
| Hot-path increment | Same file | `incrementToday()` called from checkout completion — bumps `orders_count` and `revenue` in real time. |
| `visitors` / `conversions` | Same file | **Hardcoded to 0** with TODO comment. |
| Dashboard stats | `packages/core/.../analytics/service.ts` | `getDashboardStats()` and `getConversionFunnel()` query `orders` and `events` directly — don't use `daily_metrics`. |

**Gap:** `visitors` and `conversions` columns are never populated. Dashboard doesn't read from the pre-aggregated table, so page-load for older date ranges scans raw orders.

### 1.5 Marketing Pixels & Server-Side Events

| Component | File | Status |
|---|---|---|
| Pixel CRUD + AES-256-GCM token storage | `packages/core/.../storefront-clone/pixel-service.ts` | Meta, GTM, GA4, TikTok pixel IDs + encrypted API tokens. |
| Pixel config admin UI | `apps/store-admin/src/pages/pixel-config.ts` | Form at `/settings/pixels` with 8 providers (Meta, GTM, GA4, TikTok, Pinterest, Snap, Google Ads, custom HTML). **Elevated to /settings in this session.** |
| Server-side event relay | `packages/core/.../storefront-clone/event-relay.ts` | `relayPixelEvent()` fans out to Meta CAPI, GA4 Measurement Protocol, TikTok Events API. **All three senders are stubs** — no real HTTP calls yet. |

**Gap:** Server-side event firing is wired structurally but the HTTP calls are stubs. No events are actually sent to Meta/GA4/TikTok.

### 1.6 Order Event Sourcing

| Component | File | Status |
|---|---|---|
| Immutable event stream | `packages/core/.../events/orderEvents.ts` | 22 event types into `order_events` table (order lifecycle, payments, fulfillment, refunds, risk, etc.). |

**Status:** Complete and production-ready. No gaps.

### 1.7 Conversion Funnel

| Component | File | Status |
|---|---|---|
| `getConversionFunnel()` | `packages/core/.../analytics/service.ts` | Reads from `events` table: `page_view` → `add_to_cart` → `checkout_start` → `purchase`. |

**Gap:** Depends on storefront actually emitting `add_to_cart` and `checkout_start` events. Currently only `page_view` is reliably recorded. Funnel data is therefore incomplete.

---

## 2. Roadmap: 5 Milestones

### M1: Measurement Foundation (est. 3-5 days)

**Goal:** Make `visitors` and `conversions` real numbers, persist UTM first-touch.

| # | Task | Details |
|---|---|---|
| 1.1 | Create `page_views` table | Migration: `(id, shop_id, session_id, path, referrer, utm_source/medium/campaign, user_agent, ip_hash, created_at)`. Indexed by `(shop_id, created_at)`. |
| 1.2 | Storefront page-view middleware | Express middleware on storefront routes that inserts into `page_views` on every GET. Debounce: max 1 row per session+path per 30s. |
| 1.3 | UTM first-touch cookie middleware | On storefront GET: if `?utm_source` present and no `gbox_utm` cookie, set a 30-day `gbox_utm` cookie with `{source, medium, campaign, content, term}`. Checkout reads this cookie. |
| 1.4 | Wire `daily_metrics.visitors` | Nightly cron counts distinct `session_id` from `page_views` for yesterday. `incrementToday()` also bumps visitors when a new session is seen. |
| 1.5 | Wire `daily_metrics.conversions` | Increment on checkout complete (already called, just needs `conversions += 1`). |

### M2: Live View Upgrades (est. 2-3 days)

**Goal:** Separate "real visitors" from "carts", add top pages and traffic sources.

| # | Task | Details |
|---|---|---|
| 2.1 | Visitors from `page_views` | Replace checkout_sessions proxy with `COUNT(DISTINCT session_id) FROM page_views WHERE created_at > NOW() - 5m`. |
| 2.2 | Top pages panel | Top 10 paths by page-view count in the last 10 minutes. Mini bar chart below the map. |
| 2.3 | Traffic sources panel | Top 5 `utm_source` values from `page_views` in the last 10 minutes. Pie/donut chart. |
| 2.4 | Separate "Browsing" behavior bar | New bar: visitors with page views but no cart = "Browsing". Current "Active carts", "Checking out", "Purchased" stay. |

### M3: Pixel Integration Polish (est. 2-3 days) — ✅ SHIPPED 2026-04-16

**Goal:** Wire the server-side event stubs to real HTTP calls.

| # | Task | Details | Status |
|---|---|---|---|
| 3.1 | Meta CAPI sender | Implement `sendMetaCapi()`: POST to `graph.facebook.com/v18.0/{pixel_id}/events` with event_name, event_time, user_data (SHA-256 hashed email/phone/external_id), custom_data (value, currency, content_ids, order_id, num_items). Action source = `website`. | ✅ |
| 3.2 | GA4 Measurement Protocol sender | Implement `sendGa4Mp()`: POST to `mp/collect?measurement_id=...&api_secret=...` with client_id (derived from session_id via sha256 slice, stable across calls), events[] array. | ✅ |
| 3.3 | TikTok Events API sender | Implement `sendTiktokEvent()`: POST to `business-api.tiktok.com/open_api/v1.3/event/track/` with `Access-Token` header, `event_source_id` in body, hashed user props, contents[] mapping. | ✅ |
| 3.4 | Checkout hooks | All 4 storefront event routes (page_view / add_to_cart / checkout_start / purchase) now `void fireRelay()` after the local recorder. Event names map to `PageView/ViewContent/AddToCart/InitiateCheckout/Purchase` (Meta), pass-through (GA4), `Pageview/AddToCart/InitiateCheckout/CompletePayment` (TikTok). | ✅ |
| 3.5 | Pinterest + Snap + Google Ads senders | Same pattern — POST to vendor API endpoints for `PageVisit`, `AddToCart`, `Purchase` equivalents. | ⏳ deferred — roll into M4 |

### M4: Analytics Dashboards v2 (shipped 2026-04-16 — commit 53cdce8)

**Goal:** Replace direct-query dashboards with `daily_metrics`-backed reports, add traffic source and funnel views.

| # | Task | Details | Status |
|---|---|---|---|
| 4.1 | Traffic Sources dashboard | Table: sessions / pageviews / orders / revenue / CR by (utm_source, utm_medium). 7d/30d/90d/12m period tabs + All-stores toggle. Sessions from `page_views`, orders from `orders.utm_*`, merged in JS by composite key (page_views lacks customer_id so no SQL JOIN). Route: `/analytics/traffic`. | ✅ |
| 4.2 | Conversion Funnel dashboard | 4-bar visual funnel: visitors → add_to_cart → checkout_start → purchase with pctOfPrior + pctOfTop per step, divide-by-zero safe. Route: `/analytics/funnel`. Pure helper `buildFunnel()` unit-tested. | ✅ |
| 4.3 | Attribution report | First-touch UTM attribution via the 30-day `gbox_utm` cookie stamped on `orders.utm_*` at checkout. Table: source + medium + campaign + orders + revenue + AOV. Route: `/analytics/attribution`. Last-touch deferred to M5 (requires `orders.session_id` link). | ✅ |
| 4.4 | Cohort analysis | Monthly retention heatmap with HSL indigo intensity scale. First-order-month assignment + offset bucketing via `monthDiff` pure helper. 6/12/24-month window picker. Route: `/analytics/cohort`. | ✅ |
| 4.5 | Migrate dashboards to `daily_metrics` | `getRangeRevenueHybrid` helper landed in `measurement-queries.ts` — blends `daily_metrics` for past days with live orders query for today. NOT YET wired into `getDashboardStats` / `getAnalyticsDashboard` — follow-up task. | ⏳ helper-only |

**Shipped artefacts**
- `packages/core/src/modules/analytics/measurement-queries.ts` — query + helpers
- `packages/core/src/modules/analytics/measurement-queries.test.ts` — 16 passing unit tests (4ms)
- `apps/store-admin/src/pages/analytics-measurement.ts` — 4 page handlers
- `apps/store-admin/src/server.ts` — 4 route registrations
- `apps/store-admin/src/layouts/seller-layout.ts` — sidebar nav + command palette
- `apps/store-admin/src/pages/analytics.ts` — "Measurement reports" discovery card grid

### M5: Advanced Measurement (est. 7-10 days, future)

**Goal:** Platform-differentiating analytics features.

| # | Task | Details |
|---|---|---|
| 5.1 | A/B testing framework | Split traffic on storefront (cookie-based), track conversion per variant, declare winner with statistical significance. |
| 5.2 | LTV / CAC calculator | Lifetime value = total revenue / unique customers. Customer acquisition cost = ad spend (manual input) / new customers. Dashboard widget. |
| 5.3 | Audience segments | Rule-based segments (e.g., "bought 2+ times AND from VN AND total_spent > $100"). Use for targeted email campaigns. |
| 5.4 | Real-time event stream (SSE) | Live View gets a real SSE feed of page views, add-to-cart, and purchase events — not just polling. |
| 5.5 | Data export API | JSON/CSV export of daily_metrics, page_views, events for merchants who want to feed into Google Sheets or BI tools. |

---

## 3. Priority Recommendation

```
M1 → ✅ shipped (foundation: page_views + UTM + daily_metrics)
M2 → ✅ shipped (live view upgrades: real page_views data)
M3 → ✅ shipped (pixel wiring: Meta CAPI + GA4 MP + TikTok EAPI)
M4 → ✅ shipped (dashboards v2: Traffic / Funnel / Attribution / Cohort)
NEXT → M4.5 (hybrid daily_metrics reads on legacy dashboards)
      + M3.5 (Pinterest + Snap + Google Ads senders)
FUTURE → M5 (A/B testing, LTV/CAC, segments, SSE, export API)
```

M1 is the critical path because every other milestone depends on real `page_views` data and working UTM cookies. Without M1, the funnel is empty, traffic sources are blank, and `daily_metrics.visitors` stays at zero.

---

## 4. Schema Preview (M1)

```sql
-- New table (migration 033 or next available)
CREATE TABLE page_views (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id     UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  session_id  VARCHAR(64) NOT NULL,   -- SHA-256 of session cookie
  path        VARCHAR(2048) NOT NULL,
  referrer    VARCHAR(2048),
  utm_source  VARCHAR(255),
  utm_medium  VARCHAR(255),
  utm_campaign VARCHAR(255),
  user_agent  VARCHAR(512),
  ip_hash     VARCHAR(64),            -- SHA-256 of IP (privacy)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_page_views_shop_created
  ON page_views (shop_id, created_at DESC);

CREATE INDEX idx_page_views_session
  ON page_views (shop_id, session_id, path);
```

---

*End of spec. Awaiting owner approval before implementation.*
