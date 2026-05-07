# Phase 8 — Marketing (Detailed Plan)

**Author:** Claude, 2026-04-21
**Owner:** Thai Bui
**Scope:** 4 PRs, ~8 days
**Precedes:** Phase 9 (shipping/tax/settings/staff), Phase 10 (AI + gift cards polish)

---

## Context

Phase 7 shipped the **Online Store** surface (pages/blog, navigation,
domains, theme editor, files library). Phase 8 turns the
merchant's marketing surface from shells into working features.

Shells already on disk (read-only views / empty-state tables):

| Shell                                       | LOC | State          |
| ------------------------------------------- | --- | -------------- |
| `apps/store-admin/src/pages/campaigns.ts`   | 294 | read-only view |
| `apps/store-admin/src/pages/marketing.ts`   | 534 | dashboard OK   |
| `apps/store-admin/src/pages/reviews.ts`     | 308 | shell          |
| `apps/store-admin/src/pages/notifications-admin.ts` | 283 | shell |
| `apps/store-admin/src/pages/abandoned-checkouts.ts` | 671 | lists only   |
| `packages/core/src/modules/email/service.ts` | 805 | transactional send + template render ✅ |
| `packages/core/src/modules/marketing/email-flows.ts` | 350 | pure flow definitions ✅ |
| `packages/core/src/modules/seo/meta-tags.ts` | 168 | pure helpers ✅ |
| `packages/core/src/modules/seo/json-ld.ts`   | 203 | pure helpers ✅ |
| `apps/storefront/src/middleware/seo-routes.ts` | —   | `/robots.txt` + `/sitemap.xml` ✅ |

The pure layers are good. We need persistence, cron drivers, and the
merchant-facing flows.

---

## Iron rules respected

- **Workflow-first** (Iron Rule #3): Each PR has a mindmap below.
  Present to owner → approve → implement.
- **Log changes** (Iron Rule #4): Every PR appends to CLAUDE-EXTENDED.md.
- **No god-admin in seller UI** (Iron Rule #5): Any platform-level
  config surface (SMTP host, global rate limits) lives in god-admin,
  NEVER in store-admin. Seller-facing errors read "Please contact
  Gbox support".

---

## PR1 — Campaigns (CRUD + scheduling + send-now + recipient tracking)

### Mindmap
```
Merchant → /admin/store/:slug/marketing/campaigns
├── List
│   ├── Filter by status (draft / scheduled / sending / sent / failed)
│   ├── Search by name
│   └── Paginate 20/page
├── Create new campaign
│   ├── Name
│   ├── Subject line
│   ├── Body HTML (rich editor, mustache tokens)
│   ├── Audience segment (dropdown — reuses customer_segments)
│   ├── Discount code attach (optional, dropdown from discounts table)
│   └── Save as draft
├── Schedule
│   ├── Pick send-at datetime (store tz)
│   └── Status → scheduled (cron picks up at T)
├── Send now
│   ├── Snapshot recipients (freeze segment membership)
│   ├── Enqueue background send
│   └── Status → sending → sent/failed
├── View sent campaign
│   ├── Recipient count, open rate, click rate (basic tracking)
│   └── Per-recipient log (sent / bounced / unsub / error)
└── Cancel scheduled
    └── Status → draft
```

### Data model
- **New migration `062_campaigns.ts`**:
  - `campaigns`: id (uuid pk), shop_id (fk), name (varchar), subject
    (varchar), body_html (text), audience_segment (varchar nullable
    — matches customer_segments.slug), discount_id (uuid fk nullable
    → discounts.id ON DELETE SET NULL), status (enum: draft/scheduled/
    sending/sent/failed/cancelled), scheduled_at (timestamptz null),
    sent_at (timestamptz null), recipient_count (int default 0),
    opened_count (int default 0), clicked_count (int default 0),
    error (text null), created_by (uuid fk users.id), created_at,
    updated_at.
  - `campaign_recipients`: id (uuid pk), campaign_id (fk ON DELETE
    CASCADE), customer_id (uuid fk customers.id ON DELETE SET NULL),
    email (varchar NOT NULL — frozen at snapshot time so deleting the
    customer doesn't orphan the log), sent_at (timestamptz null),
    opened_at (timestamptz null), clicked_at (timestamptz null),
    bounced_at (timestamptz null), unsubscribed_at (timestamptz null),
    error (text null).
  - Indexes: `(shop_id, status, scheduled_at)` for cron pickup,
    `(campaign_id)` on recipients.

### Service layer
- **New `packages/core/src/modules/marketing/campaigns.ts`**:
  - `createCampaign(db, shopId, input) → { ok, campaign }` — validates
    name/subject/body, defaults status=draft.
  - `listCampaigns(db, shopId, filter?)` — paginated.
  - `getCampaign(db, campaignId)` — single record.
  - `updateCampaign(db, campaignId, patch)` — draft/scheduled only.
  - `deleteCampaign(db, campaignId)` — draft only.
  - `scheduleCampaign(db, campaignId, sendAt)` — transitions
    draft→scheduled, sendAt must be ≥ now.
  - `cancelScheduled(db, campaignId)` — scheduled→draft.
  - `snapshotRecipients(db, campaignId)` — resolves segment to rows,
    inserts into `campaign_recipients`, updates recipient_count.
    Pure idempotent by campaign_id uniqueness on (campaign_id, email).
  - `markCampaignSending(db, campaignId)` — scheduled→sending.
  - `markCampaignSent(db, campaignId)` — sending→sent, stamps sent_at.
  - `markCampaignFailed(db, campaignId, error)` — sending→failed.
  - `recordRecipientSent(db, recipientId)` / `...Opened` / `Clicked`
    / `Bounced` / `Unsubscribed`.

### Cron driver
- **New handler** `packages/core/src/modules/cron/handlers/dispatch-campaigns.ts`:
  - Finds `campaigns WHERE status='scheduled' AND scheduled_at ≤ now()`
  - For each: snapshotRecipients → markSending → loop through
    recipients → sendEmail (email/service.ts) → recordRecipientSent
    or markBounced. Rate-limited (50/min) to avoid SMTP throttling.
  - Seeded in `seedMarketingCronTasks` (new) alongside the existing
    analytics rollup seed. Every 5 min.

### Store-admin handler + UI
- Rewrite `apps/store-admin/src/pages/campaigns.ts`:
  - `getCampaignsList` (replaces the current getCampaigns read-only
    view): stats cards + filter tabs + data table.
  - `getCampaignEditor(id?)`: create/edit form.
  - `postCreateCampaign`, `postUpdateCampaign`, `postDeleteCampaign`.
  - `postScheduleCampaign`, `postCancelCampaign`, `postSendNow`.
  - `getCampaignDetail(id)`: sent-campaign view with per-recipient log.
- Wire routes in `apps/store-admin/src/server.ts`.

### Tests
- Service unit tests (30+): creation, status transitions (draft→
  scheduled→sending→sent), scheduling validation (sendAt in past
  rejected), snapshot idempotency, segment filter (vip segment
  excludes non-vips), discount attach integrity, tenancy
  (campaign A cannot touch shop B's customers).
- Handler tests (10+).
- **Live smoke** `scripts/smoke-phase8-pr1.ts` — 30+ live-DB assertions:
  seed 2 shops + 5 customers + 1 discount → create campaign → schedule
  → run cron tick → verify recipients persisted → send one → mark
  opened → tenancy (shop A can't read shop B's campaign).

### Success criteria
- 40+ unit tests green
- 30+ smoke assertions green
- PR merged on GBox-Company

---

## PR2 — Abandoned cart emails

### Mindmap
```
Every 30 min (cron):
├── detectEligibleCarts
│   └── orders WHERE financial_status='pending' AND created_at < now()-1h
│        AND NOT exists(SELECT 1 FROM abandoned_cart_enrollments
│                       WHERE cart_id=o.id)
├── enrollCart
│   └── INSERT abandoned_cart_enrollments(cart_id, customer_id, email,
│                                          enrolled_at=created_at)
└── Dispatch due steps (per FLOW_DEFINITIONS.abandoned_cart.steps)
    ├── nextStepDue(flow, enrolled_at, last_sent_step_id, now)
    ├── renderEmailStep with vars (cart items, recovery link, discount)
    ├── sendEmail → SMTP
    └── markStepSent(enrollment_id, step_id)

On cart recovery (orders webhook / cart→checkout finalize):
└── markRecovered(cart_id) → short-circuits future steps
```

### Data model
- **New migration `063_abandoned_cart_enrollments.ts`**:
  - `abandoned_cart_enrollments`: id, shop_id, cart_id (unique), customer_id (nullable), email, enrolled_at, last_sent_step_id (nullable), recovered_at (nullable), unsubscribed_at (nullable)
  - Index `(shop_id, recovered_at)` for funnel reports.

### Service layer
- **New `packages/core/src/modules/marketing/abandoned-cart.ts`**:
  - `detectEligibleCarts(db, shopId, olderThanMinutes=60)` — returns cart rows not yet enrolled.
  - `enrollCart(db, shopId, cart)` — upserts enrollment.
  - `selectPendingStep(enrollment, now)` — uses email-flows.nextStepDue.
  - `dispatchStep(db, emailService, enrollment, step)` — renders + sends + markStepSent.
  - `markRecovered(db, cartId)` — called from orders service on financial_status → 'paid'.

### Cron driver
- **New handler `detect-and-dispatch-abandoned-carts.ts`**:
  - For each active shop with cart recovery enabled → detect → enroll → dispatch due steps.
  - Seeded every 30 min.

### Hook into orders service
- `orders/service.ts` `markOrderPaid` → call `markRecovered(cartId)`.

### Store-admin UI polish
- `apps/store-admin/src/pages/abandoned-checkouts.ts`:
  - Add "Recovery rate" stat (recovered / enrolled).
  - "Send recovery now" button per cart (ad-hoc send of step 0).
  - Settings: on/off toggle per step, delay override (per shop row
    on `shops.abandoned_cart_settings` jsonb column).
  - Unsubscribe link in every email → `/unsubscribe/:token`.

### Tests
- Service unit tests (25+): eligibility window, enrollment
  idempotency, step selection, recovery short-circuit, unsubscribe
  blocks further sends.
- Handler tests (8+).
- **Live smoke** `scripts/smoke-phase8-pr2.ts` (25+): seed pending
  order → tick cron → assert enrollment + step 0 sent → mark paid
  → tick again → no further send.

### Success criteria
- 33+ unit tests green
- 25+ smoke assertions green
- PR merged

---

## PR3 — SEO infrastructure

### Mindmap
```
Storefront
├── /robots.txt (exists) — verify pages/blog added in Phase 7 crawled
├── /sitemap.xml (exists) — add pages, blog posts, collections hierarchy
├── <head> auto-inject
│   ├── canonical (meta-tags.ts helper, wire in)
│   ├── og:title / og:description / og:image
│   ├── twitter:card / twitter:image
│   └── JSON-LD (json-ld.ts): product on PDP, article on blog,
│                             breadcrumb everywhere, organization in footer

Store-admin
├── /admin/store/:slug/online-store/preferences
│   ├── Default OG image upload (files library reuse)
│   ├── Twitter handle
│   ├── Shop description (fallback meta description)
│   ├── Site name (og:site_name)
│   └── noindex toggle per URL pattern (preview, search, etc.)
└── /admin/store/:slug/seo/scan
    ├── Scan all published resources (product/page/blog/collection)
    ├── Score 0-100 per resource (title length, desc present,
    │   image present, slug hygiene, h1 check, canonical set)
    └── Fix-suggestion list with deep link to resource editor

God-admin (internal only, NO seller exposure)
└── Nightly sitemap regeneration cron (caches to disk/R2 for faster
    serving of /sitemap.xml, invalidates on product/page publish).
```

### Data model
- **New migration `064_shop_seo_preferences.ts`**:
  - Add columns to `shops`: `seo_og_image_url` text, `seo_twitter_handle` varchar, `seo_site_name` varchar, `seo_default_description` text, `seo_noindex_patterns` jsonb default '[]'.
- **New table `seo_scan_results`**: id, shop_id, resource_type (product/page/blog/collection), resource_id, score, issues jsonb, scanned_at. Indexes on (shop_id, score), (shop_id, scanned_at).

### Service layer
- **New `packages/core/src/modules/seo/scan.ts`**:
  - `scanResource(resource, defaults) → { score, issues[] }`
  - `scanShopAll(db, shopId) → { summary, results[] }`
  - `persistScanResults(db, shopId, results)`
- **New `packages/core/src/modules/seo/sitemap.ts`** (replaces inline gen):
  - `buildSitemap(db, shopId, baseUrl) → xmlString`
  - `cacheSitemap(shopId, xml)` / `getCachedSitemap(shopId)` (ObjectStore).

### Storefront wiring
- `apps/storefront/src/middleware/seo-head.ts` — new: auto-inject
  canonical + og + twitter + JSON-LD into layout via Astro slot or
  Express locals.
- Update `seo-routes.ts` sitemap generator to include pages + blog
  posts + collections (Phase 7 added these, sitemap currently misses).

### Store-admin wiring
- Enhance `apps/store-admin/src/pages/online-store.ts` preferences
  section OR split into `apps/store-admin/src/pages/seo-settings.ts`.
- Add `apps/store-admin/src/pages/seo-scan.ts`: trigger + display
  scan results with fix links.

### Tests
- `scan.test.ts` (20+): score math, issue detection per resource
  type, edge cases (empty title, missing image, canonical mismatch).
- `sitemap.test.ts` (10+): xml structure, URL encoding, lastmod
  freshness.
- Handler tests (6+).
- **Live smoke** `scripts/smoke-phase8-pr3.ts` (20+): seed shop with
  3 products (1 well-optimized, 1 missing image, 1 missing desc) →
  scan → assert scores + issues → regenerate sitemap → assert 200
  response with all 3 in xml.

### Success criteria
- 36+ unit tests green
- 20+ smoke assertions green
- PR merged

---

## PR4 — Reviews moderation + notifications polish

### Mindmap
```
Storefront
├── PDP: "Write a review" form (rating 1-5, title, body)
│   └── POST → createReview (status='pending')
└── PDP: Display approved reviews (avg rating, count, list,
    distribution chart, pagination)

Store-admin
├── /admin/store/:slug/reviews
│   ├── List (filter: pending / approved / rejected)
│   ├── Bulk approve / reject
│   ├── Inline reply (merchant response shown on storefront)
│   └── Delete spam
└── Notifications settings
    ├── Which events emit in-app notification toggle list
    ├── /admin/store/:slug/notifications (inbox polish)
    └── Mark all read + pagination + filter by type

Cross-cutting
├── Email: new pending review → merchant email
├── Email: review approved → customer email (thank you)
└── In-app notification: new pending review → merchant inbox bell
```

### Data model
- **Assumed table `product_reviews` exists** (referenced by
  reviews/service.ts). Verify in migration audit; if missing, add
  migration.
- Add columns to `product_reviews`: `merchant_reply` text,
  `merchant_replied_at` timestamptz, `helpful_count` int default 0,
  `unhelpful_count` int default 0.
- Add `shops.notification_preferences` jsonb (per-event toggles).

### Service layer
- Extend `reviews/service.ts`:
  - `addMerchantReply(db, reviewId, reply)`
  - `bulkUpdateStatus(db, reviewIds, status)` with tenancy guard.
- New `packages/core/src/modules/notifications/preferences.ts`:
  - `getPreferences(db, shopId)` / `setPreferences(db, shopId, prefs)`
  - `shouldNotify(prefs, eventType) → boolean`

### Admin handler
- Rewrite `apps/store-admin/src/pages/reviews.ts`:
  - `getReviewsList` with filters.
  - `postApprove`, `postReject`, `postReply`, `postBulk`, `postDelete`.
- Polish `notifications-admin.ts` — mark-all-read + filter + per-event settings page.

### Storefront
- New `apps/storefront/src/pages/product-review.ts` handler: GET form,
  POST create review.
- Enhance PDP partial to render approved reviews + avg stars.

### Email + notifications hook
- On `createReview` → if prefs.newReview enabled → enqueue
  merchant email + create notification row.
- On status=approved → email customer.

### Tests
- Service unit (20+): approval transitions, bulk ops, reply,
  tenancy, preference gates.
- Handler tests (10+).
- **Live smoke** `scripts/smoke-phase8-pr4.ts` (20+): seed product →
  submit review via storefront handler → assert pending → approve →
  assert visible on PDP → assert customer notification row +
  merchant email attempted.

### Success criteria
- 30+ unit tests green
- 20+ smoke assertions green
- PR merged

---

## Timeline

| PR  | Days | Cumulative |
| --- | ---- | ---------- |
| PR1 | 2.5  | 2.5        |
| PR2 | 2    | 4.5        |
| PR3 | 2    | 6.5        |
| PR4 | 1.5  | 8          |

## Dependencies

- Phase 4 CRM customer_segments — used by campaign audience filter ✅
- Phase 5 discounts — optional attach on campaigns ✅
- Phase 7 pages/blog — fed into sitemap ✅
- SMTP config env vars (`SMTP_HOST` etc) — required for PR1/PR2/PR4
  to actually send. If unset, services log the intent but don't crash.
  God-admin gets a "no SMTP configured" banner on platform health.

## Non-goals (deferred to Phase 10 or later)

- Abandoned-cart ML send-time optimization
- A/B testing campaigns
- SMS campaigns (email only in Phase 8)
- Deep email analytics (heatmaps, device split)
- Review photo/video uploads (text only in Phase 8)
- AI-drafted review responses (Phase 10 AI agent touches)

## Sequencing

PR1 → PR2 → PR3 → PR4, merged sequentially to master. Each blocks
the next only in the sense of shared code review load; no hard tech
dependency.

## Roll-back policy

Each PR ships behind default-safe behavior — missing SMTP means
campaigns/abandoned-cart queue indefinitely (no-op logs), never
crash. SEO changes are additive (canonical tags, sitemap entries)
and safe to revert via PR revert.
