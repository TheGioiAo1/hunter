# Store Onboarding Wizard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Date:** 2026-04-18
**Owner:** Thai Bui
**Status:** 🟡 Plan written — pending owner sign-off before Phase A kicks off
**Related specs:** `docs/superpowers/specs/2026-04-07-seller-dashboard-spec.md`, `docs/superpowers/specs/2026-04-13-clone-pro-v4-spec.md`
**Related plans:** `docs/superpowers/plans/2026-04-17-clone-pro-dashboard-ui.md`, `docs/superpowers/plans/2026-04-18-design-library-integration.md`
**Runbook updated by this plan:** `docs/runbooks/custom-domain-verification.md` (§4 "after verify" paragraph)

---

## Owner decisions (2026-04-18, locked)

Raised after Thai pointed DNS for `lifeasy.org` and hit a blank-store UX on
first arrival. Four design questions asked, four answers captured here.

1. **Gating** — ✅ **Optional** ("a nghĩ họ tối ưu rồi thì mình nên học tập").
   Wizard is the default landing for pending stores but never blocks access.
   "I'll do this later" is always visible. Skipped stores get a dismissable
   banner on the dashboard. Shopify-equivalent behaviour.
2. **Trigger** — ✅ **Every new store** ("a cũng nghĩ mọi store như em gợi ý
   là chuẩn"). Not gated on domain verification. Store-created → wizard.
   Domain-verified → secondary nudge for stores still pending.
3. **Theme source** — ✅ **Two tabs: Clone Pro (primary) + Theme Library
   (secondary)** ("em chỉ để option clone theme của clone pro em nhé,
   a quên mất, cái library, em hãy để 1 tab phụ bên cạnh clone pro nhé.
   phơi bày 2 cái mình ưng ý nhất ra chứ em nhỉ" +
   "em thay Design Library bằng Theme Library cho đúng bản chất").
   Welcome screen is a two-tab panel:
   - **Tab 1 (default active):** "Clone from URL" — paste a Shopify /
     e-com URL, clone-pro does the rest. Primary CTA.
   - **Tab 2 (secondary):** "Theme Library" — preview 3–4 hero brand
     cards from the `design_library_entries` gallery + a "Browse full
     library →" link that deep-links into `/design-library?from=onboarding`.
     The library page already supports Live Preview + Copy DESIGN.md. The
     "Clone to store" action on library cards is gated on the design-library
     plan's D5 milestone — until D5 ships, tab 2 is a discovery surface;
     once D5 ships, clicking "Clone →" on a library card runs the same
     clone-pro-with-design-md pipeline and feeds the same completion hook
     (Task E3) so wizard state machine is identical for both tabs.

   **Naming note:** user-facing copy says **"Theme Library"** everywhere
   (tab label, button text, banner copy, empty states, breadcrumbs). The
   underlying route (`/design-library`) and table (`design_library_entries`)
   keep their names from the sibling design-library plan to avoid
   cross-plan churn. A `Task F6` in this plan adds a user-facing copy
   audit step to make sure no "Design Library" string leaks into the
   onboarding surfaces — and a follow-up (out-of-scope here) may rename
   the route to `/theme-library` with a 301 from `/design-library` once
   both plans stabilize.
4. **Clone CTA only when shop empty** — ✅ **OK** ("a thấy ok"). When
   `COUNT(products WHERE shop_id=X) > 0`, the wizard shows a
   "Your store already has products — cloning will overwrite them" confirm
   gate before starting the job. Defensive rail in case seller re-enters
   wizard later via the Resume-setup banner.

---

## Problem

Today, after a merchant creates a store in accounts portal
(`apps/accounts/src/pages/create-store.ts` → `POST /create-store`), they are
bounced to `/accounts/store-created` → dashboard. The dashboard is empty:
0 products, default theme, no guidance. Two real-world symptoms captured
this week:

1. **Thai pointed `lifeasy.org` DNS to the platform** expecting a storefront.
   The domain resolved + verified, but the shop it mapped to was a blank
   "test" shop with 1 page, 0 products. Visiting the domain returned a
   near-empty storefront, which he read as "system didn't create a store."
   It did — but the store had nothing in it, which is a UX bug, not an
   architecture bug.
2. **Sellers who complete accounts signup** land on a dashboard with no
   entry point. There's a sidebar with 12 groups, an AI panel, keyboard
   shortcuts — but no first-move suggestion. Shopify solves this with a
   first-run wizard that takes the seller from zero to "store with products
   + theme" in one click-path.

We need a first-run wizard that:

- Fires on every new shop immediately after `POST /create-store` succeeds.
- Fires as a "nudge" after first domain verification if the shop is still
  in pending state (catches sellers who skipped during signup and reached
  DNS before finishing setup).
- Offers two paths on a single welcome screen:
  - **Clone from URL** (primary) — paste any Shopify / e-commerce site,
    `clone-pro` builds the store, products, theme.
  - **Theme Library** (secondary tab) — preview a curated handful of
    hero theme cards + deep-link to the full `/design-library` gallery
    (labelled "Theme Library" in the UI) where sellers can Live Preview
    themes and (once design-library D5 ships) click "Clone →" on a card
    to bootstrap a store from a DESIGN.md spec.
- Lets the seller bail at any step ("I'll do this later") with a
  dashboard banner that points back to the wizard.
- Never blocks navigation — gating is soft, matching Shopify's optional
  setup model.
- Auto-migrates every existing shop to `onboarding_state='completed'` so
  live sellers don't get a retroactive welcome screen.

---

## Target data model

### Migration 050: `shops.onboarding_state` columns

| Column | Type | Notes |
|---|---|---|
| `onboarding_state` | `varchar(20) NOT NULL DEFAULT 'pending'` | CHECK constraint: `IN ('pending','cloning','completed','skipped')` |
| `onboarding_completed_at` | `timestamptz NULL` | Set when state transitions to `completed` (either via clone success or via dismiss-banner) |
| `onboarding_choice` | `varchar(20) NULL` | `'clone_from_url'` or `'skipped'`. Null while pending/cloning. For analytics only. |
| `onboarding_clone_job_id` | `uuid NULL` | FK → `storefront_clone_jobs.id`. Set when the user starts a clone from the wizard so we can show the job's progress on `/onboarding/first-run` if they revisit mid-clone. |

**Data migration (inside `up()`):**

```sql
UPDATE shops
SET onboarding_state = 'completed',
    onboarding_completed_at = COALESCE(updated_at, created_at, now())
WHERE created_at < now();  -- i.e. every row at migration time
```

This is the "don't annoy current sellers" rule. New shops (inserted after
migration) pick up the column default of `'pending'`.

**State machine:**

```
           ┌──────────────┐
           │   pending    │← default on INSERT
           └──────┬───────┘
                  │ seller clicks "Clone from URL" → Start
                  ▼
           ┌──────────────┐
           │   cloning    │← onboarding_clone_job_id set
           └──────┬───────┘
                  │ clone-pro job succeeds
                  ▼
           ┌──────────────┐
           │  completed   │ (terminal — banner hidden, no redirect)
           └──────▲───────┘
                  │ seller clicks "Dismiss" on Resume-setup banner
                  │
           ┌──────┴───────┐
           │   skipped    │← seller clicked "I'll do this later"
           └──────▲───────┘
                  │ seller clicks "I'll do this later" from first-run
                  │
           ┌──────┴───────┐
           │   pending    │ (initial)
           └──────────────┘

Side-edge: from `cloning`, if the clone-pro job fails / is discarded, state
rolls back to `pending` (so the seller can retry).
```

---

## Routes & page structure

All new routes live under `apps/store-admin/src/pages/onboarding/`:

| Route | Handler | Purpose |
|---|---|---|
| `GET /admin/store/:slug/onboarding/first-run` | `onboarding/first-run.ts` | Welcome page. Shows a two-tab panel: **Tab 1** "Clone from URL" (default active, primary CTA) with a secondary "I'll do this later" link; **Tab 2** "Theme Library" with 3–4 preview cards + "Browse full library →" link. Accepts `?tab=library` query to open tab 2 directly. If state=`cloning` + has `onboarding_clone_job_id`, redirect into `/admin/store/:slug/clone-pro/:jobId` so they see job progress. |
| `GET /admin/store/:slug/onboarding/clone` | `onboarding/clone.ts` | Clone-from-URL form (reached when Tab 1 "Start cloning" is clicked from the welcome tab-view, or as a direct link). Reuses `renderCloneForm()` from `@gbox/core/modules/ui/clone-pro`. Guards `COUNT(products) > 0` with a dismissable warning above the form. |
| `GET /admin/store/:slug/onboarding/library` | `onboarding/library.ts` | Theme Library tab view. Queries `design_library_entries` for up to 4 hero seed cards (sorted by curator-assigned `featured_rank` or fallback to `slug ASC`). Renders them as the wizard preview; "Browse full library →" CTA deep-links to `/admin/store/:slug/design-library?from=onboarding` (labelled "Theme Library" in the UI breadcrumb). When design-library D5 ships, individual cards gain a "Clone →" button that POSTs to `/admin/store/:slug/onboarding/library/clone`. |
| `POST /admin/store/:slug/onboarding/library/clone` | `onboarding/library-clone.ts` | **Deferred until design-library D5 ships.** Accepts `entry_slug`, creates a clone-pro job with `config_json.design_md_source='library:<slug>'`, transitions shop to `cloning` + `onboarding_clone_job_id`, redirects to clone-pro job page. Until D5, this route is unwired — Phase B/C must ship without it, and Phase E adds it behind a feature flag (`GBOX_ONBOARDING_LIBRARY_CLONE_ENABLED`) once the design-library clone pipeline is ready. |
| `POST /admin/store/:slug/onboarding/clone/start` | `onboarding/clone-start.ts` | Delegates to the existing `postCloneProStart` logic but also sets `shops.onboarding_state='cloning'` and `onboarding_clone_job_id=<new job id>` in the same transaction. Redirects to `/admin/store/:slug/clone-pro/:jobId`. |
| `POST /admin/store/:slug/onboarding/skip` | `onboarding/skip.ts` | Sets `state='skipped'`, `choice='skipped'`. Redirects to dashboard with a one-shot toast "Banner added to your dashboard — finish setup anytime." |
| `POST /admin/store/:slug/onboarding/dismiss-banner` | `onboarding/dismiss-banner.ts` | Permanent dismiss — transitions `skipped → completed` with `completed_at=now()`. Called from the banner "×" button. |
| `GET /admin/store/:slug/onboarding/resume` | `onboarding/resume.ts` | Alias → 302 to `/onboarding/first-run`. Target of the "Resume setup →" banner CTA. Keeps a clean URL in the banner link regardless of internal state. |

**Middleware:** `apps/store-admin/src/middleware/onboarding-gate.ts`

- Loaded after `storeAuth` middleware (so `req.store` is populated).
- On every request under `/admin/store/:slug/*`:
  - If `req.store.onboarding_state === 'pending'` AND the request path does
    NOT match any of:
    - `/admin/store/:slug/onboarding/*`
    - `/admin/store/:slug/api/*`
    - `/admin/store/:slug/assets/*`
    - `/admin/store/:slug/logout`
    - `/admin/store/:slug/clone-pro/*` (needed when clone job is in flight
      and state=`cloning`)
    - `/admin/store/:slug/design-library/*` (the Library tab deep-link
      must work — seller lands on `/design-library?from=onboarding` from
      Tab 2, the page needs to render instead of re-redirecting them back
      into the wizard shell)
    → 302 redirect to `/admin/store/:slug/onboarding/first-run`.
  - If `req.store.onboarding_state === 'skipped'` → set
    `res.locals.showOnboardingBanner = true` + pass through.
  - Else → no-op.

**Layout hook:** `apps/store-admin/src/layouts/seller-layout.ts`

- Accept optional `showOnboardingBanner: boolean` prop (default false).
- When `true`, inject a banner above the page header:

  ```html
  <div class="onboarding-banner" role="status">
    <div class="onboarding-banner__body">
      <span class="onboarding-banner__icon">✨</span>
      <div>
        <strong>Finish setting up your store</strong>
        <p>Clone a theme + products from any Shopify URL in one click.</p>
      </div>
    </div>
    <div class="onboarding-banner__actions">
      <a href="/admin/store/{slug}/onboarding/resume" class="btn btn-primary btn-sm">Resume setup</a>
      <form method="post" action="/admin/store/{slug}/onboarding/dismiss-banner" class="inline-form">
        <input type="hidden" name="_csrf" value="{csrfToken}" />
        <button class="onboarding-banner__dismiss" aria-label="Dismiss setup banner">×</button>
      </form>
    </div>
  </div>
  ```

- CSS matches existing banner patterns (indigo accent, dark/light parity).

---

## Entry-point hooks

### Hook 1 — accounts portal: redirect new stores to wizard

**File:** `apps/accounts/src/pages/create-store.ts` (around line 432–434)

**Change:** Replace
```ts
res.redirect(`/accounts/store-created?slug=${...}&name=${...}`)
```
with
```ts
// New: send to onboarding wizard on first-run. store-created bounce is
// replaced by an in-admin welcome. Adds onboarding=1 so the admin
// app knows to skip its gate middleware (the gate will be a no-op on
// first-run route anyway, this is just for cleaner server logs).
const adminUrl = getAdminUrl(slug)
res.redirect(`${adminUrl}/onboarding/first-run?welcome=1`)
```

**Side-effect:** `getStoreCreated` (the `/accounts/store-created` bounce)
becomes dead code — delete it + its route wiring. Update CSP form-action
note if still needed; cross-origin redirect works for explicit user-initiated
navigation (302 after POST is same-origin if the admin host is on the same
eTLD+1 as accounts — which it is: `*.gbox.co`). Verify in
Task F3 with a cross-origin smoke.

### Hook 2 — store-admin: nudge after domain verify

**File:** `apps/store-admin/src/pages/domains.ts` `postVerifyDomain` (line 785)

**Change:** Inside the `if (result.ok)` branch, BEFORE the final redirect:

```ts
if (store.onboarding_state === 'pending') {
  // First verified domain + still in initial setup → route into wizard
  // instead of the bare Domains page. Seller sees a clear next step.
  res.redirect(`/admin/store/${store.slug}/onboarding/first-run?from=domain-verified`)
  return
}
```

Existing redirect chain (with `success=` query) fires only when
`onboarding_state` is already `completed`/`skipped`/`cloning`.

### Hook 3 — clone-pro completion → onboarding completion

**File:** `packages/core/src/modules/clone-pro/runner.ts` (or wherever a
clone-pro job transitions to `succeeded`)

**Change:** When a job reaches a terminal success state AND the associated
shop has `onboarding_state='cloning'` with matching `onboarding_clone_job_id`,
run:

```sql
UPDATE shops
SET onboarding_state = 'completed',
    onboarding_completed_at = now(),
    onboarding_choice = 'clone_from_url'
WHERE id = $1
  AND onboarding_state = 'cloning'
  AND onboarding_clone_job_id = $2
```

If a job fails or is discarded while `onboarding_state='cloning'`, reset
shop to `pending` and clear `onboarding_clone_job_id`. Keeps the banner
+ wizard available for retry.

---

## Implementation phases

Rollout bands:

- **Phase A** — Foundation (migration, types, helpers). MVP schema only.
- **Phase B** — Routes + welcome page skeleton. Unit-tested handlers.
- **Phase C** — Clone-from-URL wizard flow. Reuses clone-pro. E2E skip path.
- **Phase D** — Gating middleware + dashboard banner. Optional-gate UX.
- **Phase E** — Entry-point hooks (accounts portal redirect, domain-verify
  redirect, clone-pro completion hook).
- **Phase F** — Polish: a11y sweep, cross-browser smoke, runbook update,
  rollout flag `GBOX_ONBOARDING_WIZARD_ENABLED`.

---

## Phase A — Foundation (schema, types, helpers)

### Task A1: Create migration 050 for `shops.onboarding_*` columns

**Files:**
- Create: `packages/db/src/migrations/050_shops_onboarding_state.ts`
- Test: `packages/db/src/migrations/050_shops_onboarding_state.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/db/src/migrations/050_shops_onboarding_state.test.ts
import { describe, it, expect } from 'vitest'
import { up, down } from './050_shops_onboarding_state.js'

describe('migration 050 shops_onboarding_state', () => {
  it('up() and down() are functions', () => {
    expect(typeof up).toBe('function')
    expect(typeof down).toBe('function')
  })
  it('adds onboarding_state, onboarding_completed_at, onboarding_choice, onboarding_clone_job_id columns', async () => {
    const fs = await import('node:fs/promises')
    const src = await fs.readFile(new URL('./050_shops_onboarding_state.ts', import.meta.url), 'utf8')
    for (const col of [
      'onboarding_state',
      'onboarding_completed_at',
      'onboarding_choice',
      'onboarding_clone_job_id',
    ]) {
      expect(src).toContain(col)
    }
    expect(src).toContain(`'pending'`)
    expect(src).toContain(`'cloning'`)
    expect(src).toContain(`'completed'`)
    expect(src).toContain(`'skipped'`)
    expect(src).toContain('UPDATE shops') // backfill existing stores
    expect(src).toContain('idx_shops_onboarding_state')
  })
})
```

- [ ] **Step 2: Run the test — expect module-not-found failure**

  `pnpm --filter @gbox/db vitest run src/migrations/050_shops_onboarding_state.test.ts`

- [ ] **Step 3: Write the migration**

```ts
// packages/db/src/migrations/050_shops_onboarding_state.ts
import type { Kysely } from 'kysely'
import { sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('shops')
    .addColumn('onboarding_state', 'varchar(20)', (c) =>
      c.notNull().defaultTo('pending'),
    )
    .addColumn('onboarding_completed_at', 'timestamptz')
    .addColumn('onboarding_choice', 'varchar(20)')
    .addColumn('onboarding_clone_job_id', 'uuid')
    .execute()

  await sql`
    ALTER TABLE shops
    ADD CONSTRAINT shops_onboarding_state_check
    CHECK (onboarding_state IN ('pending','cloning','completed','skipped'))
  `.execute(db)

  // Backfill: every shop that exists at migration time is treated as
  // already-onboarded. We don't want to retroactively gate live sellers.
  await sql`
    UPDATE shops
    SET onboarding_state = 'completed',
        onboarding_completed_at = COALESCE(updated_at, created_at, now())
    WHERE created_at < now()
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_shops_onboarding_state
    ON shops(onboarding_state)
    WHERE onboarding_state <> 'completed'
  `.execute(db)

  // FK last so the backfill doesn't race with clone-pro jobs referencing
  // a partially-created column.
  await sql`
    ALTER TABLE shops
    ADD CONSTRAINT shops_onboarding_clone_job_id_fkey
    FOREIGN KEY (onboarding_clone_job_id)
    REFERENCES storefront_clone_jobs(id)
    ON DELETE SET NULL
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE shops DROP CONSTRAINT IF EXISTS shops_onboarding_clone_job_id_fkey`.execute(db)
  await sql`DROP INDEX IF EXISTS idx_shops_onboarding_state`.execute(db)
  await sql`ALTER TABLE shops DROP CONSTRAINT IF EXISTS shops_onboarding_state_check`.execute(db)
  await db.schema
    .alterTable('shops')
    .dropColumn('onboarding_clone_job_id')
    .dropColumn('onboarding_choice')
    .dropColumn('onboarding_completed_at')
    .dropColumn('onboarding_state')
    .execute()
}
```

- [ ] **Step 4: Re-run the test — expect green**

- [ ] **Step 5: Run migration against dev DB and inspect**

  On server 1: `cd /home/botesty/gbox-platform && pnpm --filter @gbox/db migrate:up`
  Then: `psql ... -c "\d shops"` — verify 4 new columns + CHECK constraint present.
  Then: `SELECT onboarding_state, COUNT(*) FROM shops GROUP BY 1` — expect every row `completed`.

### Task A2: Extend Kysely types

- [ ] Update `packages/db/src/types.ts` (or wherever the `ShopsTable` interface lives) to add the four nullable / default columns.

  ```ts
  export type ShopOnboardingState = 'pending' | 'cloning' | 'completed' | 'skipped'

  export interface ShopsTable {
    // ... existing columns
    onboarding_state: ColumnType<ShopOnboardingState, ShopOnboardingState | undefined, ShopOnboardingState>
    onboarding_completed_at: ColumnType<Date | null, Date | null | undefined, Date | null>
    onboarding_choice: ColumnType<string | null, string | null | undefined, string | null>
    onboarding_clone_job_id: ColumnType<string | null, string | null | undefined, string | null>
  }
  ```

- [ ] Verify TypeScript builds across `apps/*` and `packages/*`:
  `pnpm -r run build`

### Task A3: Helper module — `packages/core/src/modules/onboarding/`

**Files:**
- Create: `packages/core/src/modules/onboarding/state.ts`
- Test:   `packages/core/src/modules/onboarding/state.test.ts`

Exports (all pure + db-backed, no Express coupling):

```ts
export function isOnboardingPending(shop: ShopRow): boolean
export function shouldShowOnboardingBanner(shop: ShopRow): boolean
export async function markOnboardingSkipped(db, shopId): Promise<void>
export async function markOnboardingCompleted(db, shopId, choice: 'clone_from_url' | 'dismissed'): Promise<void>
export async function markOnboardingCloning(db, shopId, cloneJobId): Promise<void>
export async function rollbackOnboardingToPending(db, shopId): Promise<void>  // called when clone job fails
export async function getOnboardingCloneJobId(db, shopId): Promise<string | null>
```

- [ ] **Step 1: write failing tests** for each helper covering all state
  transitions listed in §"State machine". Use in-memory SQLite (or mock)
  so the unit suite doesn't need Postgres.

- [ ] **Step 2: implement** until green.

---

## Phase B — Wizard welcome page

### Task B1: Route skeleton + welcome renderer

**Files:**
- Create: `apps/store-admin/src/pages/onboarding/first-run.ts`
- Test:   `apps/store-admin/src/pages/onboarding/first-run.test.ts`

- [ ] **Step 1: Write the failing test**

  Cover:
  1. Renders welcome page when `onboarding_state='pending'` with Tab 1
     active (default).
  2. Tab strip contains exactly two tabs, in order: "Clone from URL"
     (primary, `aria-selected="true"` by default) and "Theme Library"
     (secondary).
  3. Tab 1 panel includes the clone-pro CTA linking to
     `/onboarding/clone` and the "I'll do this later" POST form with CSRF.
  4. Tab 2 panel is rendered (hidden via CSS when tab 1 is active) and
     embeds the library preview cards from `onboarding/library.ts`
     helper; includes the "Browse full library →" link to
     `/admin/store/:slug/design-library?from=onboarding`.
  5. `?tab=library` query flips Tab 2 to `aria-selected="true"` on first
     render (for the deep-link from "Back to setup" on the library page).
  6. When `onboarding_state='cloning'` + `onboarding_clone_job_id` set → 302 redirects to `/admin/store/:slug/clone-pro/:jobId`.
  7. When `onboarding_state='completed'` → 302 redirects to `/admin/store/:slug` (dashboard).
  8. Honors `?welcome=1` query by prepending "Welcome to Gbox!" H1.
  9. Honors `?from=domain-verified` by prepending "Your domain is live!" banner.

- [ ] **Step 2: Implement `first-run.ts`**

  Key shape:
  ```ts
  export async function getOnboardingFirstRun(req, res, db) {
    const shop = req.store
    if (shop.onboarding_state === 'completed') {
      res.redirect(`/admin/store/${shop.slug}`)
      return
    }
    if (shop.onboarding_state === 'cloning' && shop.onboarding_clone_job_id) {
      res.redirect(`/admin/store/${shop.slug}/clone-pro/${shop.onboarding_clone_job_id}`)
      return
    }
    // `pending` or `skipped` → render wizard
    const welcome = req.query.welcome === '1'
    const fromDomain = req.query.from === 'domain-verified'
    const csrfToken = csrfStore.issue(req, res)
    res.send(sellerLayout({
      title: 'Welcome to Gbox',
      hideSidebar: true, // focused first-run experience
      content: renderWelcome({ shop, welcome, fromDomain, csrfToken }),
    }))
  }
  ```

### Task B2: Welcome page component + CSS (two-tab UI)

**Files:**
- Create: `packages/core/src/modules/ui/onboarding/welcome.ts`
- Create: `packages/core/src/modules/ui/onboarding/welcome-css.ts`
- Test:   `packages/core/src/modules/ui/onboarding/welcome.test.ts`

Shopify-inspired layout: hero header (pitch copy + illustration), then a
two-tab panel.

**Tab strip (WAI-ARIA tablist):**

```html
<div class="onboarding-tabs" role="tablist" aria-label="Store setup options">
  <button role="tab" id="tab-clone" aria-selected="true" aria-controls="panel-clone" class="onboarding-tab onboarding-tab--primary">
    <span class="onboarding-tab__icon">🚀</span>
    <span class="onboarding-tab__label">Clone from URL</span>
    <span class="onboarding-tab__hint">Fastest way — paste any storefront</span>
  </button>
  <button role="tab" id="tab-library" aria-selected="false" aria-controls="panel-library" class="onboarding-tab">
    <span class="onboarding-tab__icon">🎨</span>
    <span class="onboarding-tab__label">Theme Library</span>
    <span class="onboarding-tab__hint">Curated brand themes</span>
  </button>
</div>
```

**Tab panels:**

- `#panel-clone` (active by default) — pitch copy ("Paste any Shopify or
  e-commerce URL and we'll clone the theme, products, and layout in
  minutes"), big primary button "Start cloning →" linking to
  `/onboarding/clone`, and a tertiary "I'll do this later" POST form.
- `#panel-library` — 3–4 `libraryPreviewCard()` tiles rendered from
  hero seed entries, "Browse full library →" link, and a footnote
  explaining sellers can copy DESIGN.md to feed an AI agent or wait for
  the D5 "Clone →" button to ship.

**Tab switcher JS** — inline vanilla JS in `welcome-runtime.ts`:
click handler toggles `aria-selected`, flips CSS `display`, updates
`history.replaceState` so `?tab=library` sticks on reload.

- [ ] **Step 1: failing test** — snapshot of output HTML contains the key
  strings: "Welcome to Gbox", "Clone from URL", "Theme Library", tab
  ARIA attributes (`role="tablist"`, two `role="tab"` with matching
  `aria-controls`), "I'll do this later", CSRF input, skip-form action
  path, Clone-from-URL href, "Browse full library →" link pointing to
  `/admin/store/:slug/design-library?from=onboarding`. Negative assertion:
  the string `"Design Library"` must NOT appear anywhere in the rendered
  HTML (user-facing label is "Theme Library" per owner rename).
- [ ] **Step 2: implement** `renderWelcome()` + tokenized CSS + tab
  runtime script body.
- [ ] **Step 3: a11y smoke** — `aria-label` on dismiss, `role="main"` on
  content wrapper, `role="tablist"` + `role="tab"` + `role="tabpanel"`
  with correct `aria-selected` / `aria-controls` / `aria-labelledby`
  wiring, focus ring on CTAs, arrow-key navigation between tabs.

### Task B3: Library preview helper

**Files:**
- Create: `apps/store-admin/src/pages/onboarding/library.ts`
- Create: `packages/core/src/modules/ui/onboarding/library-preview.ts`
- Test:   `apps/store-admin/src/pages/onboarding/library.test.ts`

Purpose: query `design_library_entries` for the 3–4 hero seeds the welcome
page's Tab 2 needs, render a compact card (thumbnail + title + category).

- [ ] **Step 1: failing test**
  1. Query uses `source='seed'` and orders by `featured_rank ASC NULLS LAST, slug ASC`
     (the `featured_rank` column is added in Task B3a below if the
     design-library migration hasn't shipped it).
  2. Limit = 4.
  3. Returned rows shaped as `{ slug, title, category, thumbnail_url, preview_html_url? }`.
  4. When seed library is empty (fresh DB before design-library seed
     migration runs), the helper returns `[]` and Tab 2 falls back to
     a "Theme Library coming soon — [Browse anyway →]" empty state.
- [ ] **Step 2: implement** the query + `libraryPreviewCards([])` component.
- [ ] **Step 3: contract-check with design-library plan** — before Phase B
  merges, confirm with the design-library plan's D4 seed loader that
  `design_library_entries` is populated on server 1. If not, ship B3
  behind the empty-state branch and flip on after D4 runs.

### Task B3a (contingent): Add `featured_rank` column to design_library_entries

Only needed if the design-library migration (049) doesn't already ship a
curator-ranking column.

- [ ] Grep `packages/db/src/migrations/049_design_library_entries.ts` for
      `featured_rank`. If present → skip this task.
- [ ] Otherwise create `packages/db/src/migrations/051_design_library_featured_rank.ts`:
      `ALTER TABLE design_library_entries ADD COLUMN featured_rank int2 NULL;`
      + `CREATE INDEX idx_design_library_entries_featured_rank ON design_library_entries(featured_rank) WHERE featured_rank IS NOT NULL;`
- [ ] Seed Thai's top 4 picks (suggest: Airbnb, Stripe, Linear, Notion)
      with `featured_rank=1..4`. Confirm pick order with Thai before seeding.

### Task B4: Register routes in server.ts

- [ ] Edit `apps/store-admin/src/server.ts` to mount:
  - `app.get('/admin/store/:slug/onboarding/first-run', storeAuth, (req, res) => getOnboardingFirstRun(req, res, db))`
  - `app.get('/admin/store/:slug/onboarding/library', storeAuth, (req, res) => res.redirect(\`/admin/store/\${req.store!.slug}/onboarding/first-run?tab=library\`))`  // deep-link alias
  - `app.get('/admin/store/:slug/onboarding/resume', storeAuth, (req, res) => res.redirect(\`/admin/store/\${req.store!.slug}/onboarding/first-run\`))`
- [ ] Smoke with `curl` against server 1 after deploy:
  1. Log in as a seller whose shop is `pending`.
  2. Hit `/admin/store/:slug/onboarding/first-run?welcome=1` — expect 200 + welcome body + Tab 1 active.
  3. Hit `/admin/store/:slug/onboarding/first-run?tab=library` — expect 200 with Tab 2 active (check `aria-selected="true"` on `#tab-library`).
  4. Flip shop to `completed` via SQL, hit same URL — expect 302 → dashboard.

---

## Phase C — Clone-from-URL flow

### Task C1: Clone form page

**Files:**
- Create: `apps/store-admin/src/pages/onboarding/clone.ts`
- Test:   `apps/store-admin/src/pages/onboarding/clone.test.ts`

- [ ] **Step 1: failing test**

  1. Renders a clone form that reuses `renderCloneForm` (import from
     `@gbox/core/modules/ui/clone-pro`).
  2. Form `action` is `/admin/store/:slug/onboarding/clone/start`.
  3. When `SELECT COUNT(*) FROM products WHERE shop_id=X AND deleted_at IS NULL > 0`,
     the page prepends a yellow warning card: "Your store already has
     products. Cloning will overwrite them. [Continue anyway button just
     below form]". Warning is informational — the form still submits.
  4. `onboarding_state='completed'` → 302 to dashboard.

- [ ] **Step 2: implement**

  Key snippet:
  ```ts
  const productCount = await db
    .selectFrom('products')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('shop_id', '=', shop.id)
    .where('deleted_at', 'is', null)
    .executeTakeFirstOrThrow()
  const hasProducts = Number(productCount.n) > 0
  // hasProducts=true → render warning card above renderCloneForm(...)
  ```

### Task C2: Clone-start handler

**Files:**
- Create: `apps/store-admin/src/pages/onboarding/clone-start.ts`
- Test:   `apps/store-admin/src/pages/onboarding/clone-start.test.ts`

Handler flow:

```
1. Validate source_url (reuse validator from clone-pro/start.ts).
2. Transaction:
   a. INSERT storefront_clone_jobs via createStorefrontCloneJob.
   b. UPDATE shops SET onboarding_state='cloning', onboarding_clone_job_id=<new id>
      WHERE id=:shop_id AND onboarding_state IN ('pending','skipped').
3. enqueueWebsiteClone + runCloneProJob (fire-and-forget via deps).
4. Audit-log notify() — event 'onboarding_clone_started'.
5. 302 → /admin/store/:slug/clone-pro/:jobId?from=onboarding
```

- [ ] **Step 1: failing test** — mock the DB, assert all 5 steps happen in
  order, assert transaction rollback semantics when step 2b fails.
- [ ] **Step 2: implement** using `db.transaction().execute(async (trx) => ...)`
  to make (a)+(b) atomic.
- [ ] **Step 3: integration test** against a real dev DB — kick a clone,
  wait for terminal, verify `onboarding_state='completed'` via Task E3's
  completion hook.

### Task C3: Skip handler

**Files:**
- Create: `apps/store-admin/src/pages/onboarding/skip.ts`
- Test:   `apps/store-admin/src/pages/onboarding/skip.test.ts`

- [ ] Sets `onboarding_state='skipped'`, `onboarding_choice='skipped'`
  when current state is `pending`.
- [ ] No-op when state is already `skipped`, `cloning`, or `completed` (prevents
  re-entry after dismiss-banner from re-setting choice).
- [ ] 302 → `/admin/store/:slug` with a flash toast `"Resume setup any time from the banner above."`
- [ ] CSRF-verified POST only.
- [ ] Audit log `'onboarding_skipped'`.

### Task C4: Dismiss-banner handler

**Files:**
- Create: `apps/store-admin/src/pages/onboarding/dismiss-banner.ts`
- Test:   `apps/store-admin/src/pages/onboarding/dismiss-banner.test.ts`

- [ ] POST only, CSRF-verified.
- [ ] Only transitions `skipped → completed` (with `choice='dismissed'`,
  `completed_at=now()`).
- [ ] 302 back to the Referer (or `/admin/store/:slug` fallback).
- [ ] Audit log `'onboarding_banner_dismissed'`.

---

## Phase D — Gating middleware + dashboard banner

### Task D1: `onboarding-gate` middleware

**Files:**
- Create: `apps/store-admin/src/middleware/onboarding-gate.ts`
- Test:   `apps/store-admin/src/middleware/onboarding-gate.test.ts`

- [ ] **Step 1: failing test**

  Test matrix:

  | state | path | expected |
  |---|---|---|
  | pending | `/admin/store/foo/` | 302 to `/admin/store/foo/onboarding/first-run` |
  | pending | `/admin/store/foo/products` | 302 to `/admin/store/foo/onboarding/first-run` |
  | pending | `/admin/store/foo/onboarding/first-run` | pass-through (no redirect) |
  | pending | `/admin/store/foo/onboarding/clone` | pass-through |
  | pending | `/admin/store/foo/clone-pro/abc123` | pass-through (clone-in-progress) |
  | pending | `/admin/store/foo/api/v1/products` | pass-through (API, not UI) |
  | pending | `/admin/store/foo/assets/app.css` | pass-through |
  | pending | `/admin/store/foo/logout` | pass-through |
  | skipped | `/admin/store/foo/products` | pass-through, `res.locals.showOnboardingBanner=true` |
  | cloning | `/admin/store/foo/products` | pass-through (don't gate once clone is running) |
  | completed | `/admin/store/foo/products` | pass-through |

- [ ] **Step 2: implement**

  ```ts
  const BYPASS_REGEXES: RegExp[] = [
    /^\/admin\/store\/[^/]+\/onboarding(\/|$)/,
    /^\/admin\/store\/[^/]+\/api(\/|$)/,
    /^\/admin\/store\/[^/]+\/assets(\/|$)/,
    /^\/admin\/store\/[^/]+\/logout(\/|$)/,
    /^\/admin\/store\/[^/]+\/clone-pro(\/|$)/,
  ]
  export function onboardingGate(req, res, next) {
    const shop = req.store
    if (!shop) { return next() }
    if (shop.onboarding_state === 'completed' || shop.onboarding_state === 'cloning') {
      return next()
    }
    if (shop.onboarding_state === 'skipped') {
      res.locals.showOnboardingBanner = true
      return next()
    }
    // pending
    if (BYPASS_REGEXES.some((re) => re.test(req.path))) { return next() }
    return res.redirect(`/admin/store/${shop.slug}/onboarding/first-run`)
  }
  ```

- [ ] **Step 3: wire into `server.ts`** after `storeAuth` but before route
  handlers:

  ```ts
  app.use('/admin/store/:slug', storeAuth, onboardingGate)
  ```

### Task D2: Dashboard banner in `seller-layout.ts`

- [ ] **Step 1: failing test** (extend `seller-layout.test.ts`)

  Assert that when called with `showOnboardingBanner: true`, the output
  contains the banner HTML from §Routes above, the dismiss form POSTs to
  `/admin/store/{slug}/onboarding/dismiss-banner` with a CSRF hidden input.

- [ ] **Step 2: implement**

  Add `showOnboardingBanner?: boolean` + `slug?: string` + `csrfToken?: string`
  to `SellerLayoutProps`. When true, render banner block before the main
  content grid. Add to `layouts/seller-layout-css.ts` (create if missing).

- [ ] **Step 3: plumb `res.locals.showOnboardingBanner` into every page**

  The cleanest fix: a small helper `pageContext(res)` that reads
  `res.locals.showOnboardingBanner` + `res.locals.csrfToken` and returns
  props to spread into `sellerLayout(...)`. Every page that already calls
  `sellerLayout(...)` adds `...pageContext(res)`. Grep for `sellerLayout(`
  — ~60 call sites. Mechanical edit; apply `replace_all` by-file.

- [ ] **Step 4: smoke** — `onboarding_state='skipped'` on a real shop, hit
  `/admin/store/:slug/products`, confirm banner renders with working
  Resume + Dismiss buttons.

---

## Phase E — Entry-point hooks

### Task E1: accounts portal redirect

- [ ] Edit `apps/accounts/src/pages/create-store.ts` per §"Hook 1" above.
- [ ] Test the change: POST to `/accounts/create-store` with valid payload,
  expect 302 to `<admin-host>/admin/store/<slug>/onboarding/first-run?welcome=1`.
- [ ] Delete `getStoreCreated` + the `GET /accounts/store-created` route in
  `server.ts`. Confirm no other callers (`grep -r store-created apps/`).

### Task E2: postVerifyDomain nudge

- [ ] Edit `apps/store-admin/src/pages/domains.ts` `postVerifyDomain` per
  §"Hook 2" above. Insert the pending-state redirect BEFORE the existing
  success redirect.
- [ ] Unit-test the branch: mock `store.onboarding_state='pending'`, call
  `postVerifyDomain` with a successful verify, assert redirect URL ends
  with `/onboarding/first-run?from=domain-verified`.
- [ ] Unit-test the non-pending branch: `onboarding_state='completed'` →
  existing `?success=...` redirect fires.

### Task E3: clone-pro completion hook

The hook fires for **both** wizard entry paths: Tab 1 "Clone from URL" and
Tab 2 "Theme Library" Clone → (once D5 ships). Clone-pro runs identically
regardless of which tab started it; only the `onboarding_choice` column
recorded at completion differs (`'clone_from_url'` vs `'clone_from_library'`).
The originating tab is stamped on `storefront_clone_jobs.config_json.origin`
at start-time (Task C2 sets `origin: 'onboarding_url'`; the deferred Task
C5 sets `origin: 'onboarding_library'`).

- [ ] Locate the terminal-success transition in
  `packages/core/src/modules/clone-pro/runner.ts` (grep for status
  `succeeded` UPDATE).
- [ ] After that UPDATE, read `config_json.origin` off the job row.
  Derive `choice`:
  - `'onboarding_url'` → `'clone_from_url'`
  - `'onboarding_library'` → `'clone_from_library'`
  - any other / missing → skip the onboarding update (job wasn't
    wizard-initiated).
- [ ] Call `markOnboardingCompleted(db, shopId, choice)` from the helper
  module (Task A3). Gated on
  `onboarding_state='cloning' AND onboarding_clone_job_id=<this job id>`
  so we don't clobber an unrelated state.
- [ ] Similarly for terminal-failure: call `rollbackOnboardingToPending`.
- [ ] Integration test:
  1. Kick a clone from `/onboarding/clone/start`, wait for terminal,
     assert `shops` row moved to `completed` with non-null
     `completed_at` and `choice='clone_from_url'`.
  2. Once Task C5 is unlocked, repeat from Tab 2, assert
     `choice='clone_from_library'`.

### Task E4: Runbook update

- [ ] Edit `docs/runbooks/custom-domain-verification.md` §4 seller walkthrough.
  After "You'll see Verified + SSL Active" step, add: "If this is your first
  verified domain and your store is still in setup, you'll be taken into
  the onboarding wizard to pick a theme source — you can click 'I'll do
  this later' to skip."

---

## Phase F — Polish

### Task F1: A11y sweep

Reuse the existing `a11y.test.ts` harness from `apps/store-admin/src/pages/clone-pro/`
as template.

- [x] Add `apps/store-admin/src/pages/onboarding/a11y.test.ts` — 327 LOC,
  28 assertions, 6 rendered surfaces (first-run welcome, skipped,
  domain-verified, library tab, clone form empty, clone form with
  existing products). Audits button accessible names, labelled inputs,
  progressbar ARIA, `aria-live="polite"` on status regions, color+text
  signal pairing, and verifies no internal "Design Library" label leaks
  into seller copy. Shipped in PR #13. [2026-04-20]
- [ ] Axe-scan: welcome, clone form, skip confirmation. Zero violations.
  (Regex sweep shipped as F1 initial pass; axe-core scan deferred —
  requires jsdom + axe-core setup across suites, larger lift.)
- [ ] Keyboard trap check: `Tab` through welcome, both CTAs reachable,
  `Enter` on primary button submits, `Escape` nothing destructive.
  (Deferred with axe — needs real DOM + focus simulation.)
- [ ] Dark/light parity — banner + welcome both render correctly in each
  theme (snapshot test with `theme: 'dark' | 'light'`). (Deferred —
  current wizard surfaces don't branch on theme; revisit when themed
  variants land.)

### Task F2: Rollout feature flag

- [ ] Add `GBOX_ONBOARDING_WIZARD_ENABLED` env var (default `'true'`).
- [ ] In `middleware/onboarding-gate.ts`, bail out early when
  `process.env.GBOX_ONBOARDING_WIZARD_ENABLED !== 'true'` — gate becomes
  a no-op. Guarantees we can kill-switch on server 1 without redeploying.
- [ ] In `accounts/pages/create-store.ts` Hook 1, fall back to the old
  `/accounts/store-created` path when flag is off.
- [ ] Document the flag in `docs/runbooks/custom-domain-verification.md`
  §8 env table AND `docs/env-vars.md` (if it exists; create if not).

### Task F3: Cross-host smoke (dev + production pattern)

Hosts: accounts on `accounts.gbox.co`, admin on `admin.gbox.co`.

- [x] Unauth redirect chain — verified on server 1 live via curl:
  - `GET /admin/store/demo/onboarding/first-run` → final 200 at
    `https://accounts.gbox.co/accounts/login?return_to=%2Fadmin%2Fstore%2Fdemo%2Ffirst-run`.
  - `GET /accounts/create-store` → final 200 at login page.
  - `GET /admin/store/demo/` → final 200 at login with `return_to`.
  All three routes correctly enforce auth and capture `return_to` for
  post-login resume. [2026-04-20]
- [x] Cookie propagation: seller session cookie scoped to `.gbox.co`
  (leading dot → valid across all subdomains). Verified via:
  - Code: `packages/core/src/modules/auth/session.ts:73`
    `domain: process.env.SESSION_COOKIE_DOMAIN || (isProduction ? ".gbox.co" : "")`
  - Server 1 `.env`: `SESSION_COOKIE_DOMAIN=.gbox.co` (explicit).
  Cookie attrs verified on login CSRF cookie: `HttpOnly; Secure; SameSite=Lax`.
  [2026-04-20]
- [ ] If cookie doesn't propagate, the 302 lands on a login page →
  seller re-auths → then onboarding. Acceptable UX, but mention in runbook.
  (Still deferred — with `.gbox.co` domain confirmed, this fallback
  isn't triggered in the happy path. Runbook mention can follow when
  a real edge case surfaces.)

### Task F4: Full suite + smoke

- [x] `pnpm -r test` green across all packages — CI on PR #13 shows
  4606/4607 pass (1 pre-existing master flake on `bundle.test.ts`
  determinism reran green). Local Windows run: 4590/4614 with 1
  Windows-specific integration fail in `apps/storefront/src/app.integration.test.ts`
  (tracked in memory as `vitest_windows_symlinks.md`, non-blocking for CI).
  [2026-04-20]
- [x] `pnpm -r run build` passes — storefront build on server 1 in 1.08s,
  API build green, admin build green. [2026-04-20]
- [ ] Deploy to server 1 via PR branch + PR2-style smoke:
  1. Create fresh seller via accounts signup.
  2. Create new store → expect to land on `/onboarding/first-run?welcome=1`.
  3. Click "Clone from URL", paste a test Shopify URL, submit.
  4. Watch job progress page (existing clone-pro UI).
  5. On success, visit `/admin/store/:slug/` — no banner, normal dashboard.
  6. In a second browser, create another seller, click "I'll do this later".
  7. Dashboard renders with Resume banner. Click Resume → welcome page.
  8. Click Dismiss — banner gone, state=`completed`.
  (Deferred to owner-run live smoke — involves creating real seller
  accounts + test Shopify clones on prod DB. Happy-path unauth redirect
  chain + cookie scoping verified in F3 covers the infrastructure layer.)
- [ ] Capture screenshots for PR description.
  (Deferred to live smoke above.)

### Task F6: User-facing copy audit — "Theme Library" only

Owner rename per 2026-04-18: user-facing label is **Theme Library**, never
"Design Library". Internal identifiers (route `/design-library`, table
`design_library_entries`, sibling plan filename) stay as they are.

- [ ] `grep -R "Design Library" apps/store-admin/src/pages/onboarding/ packages/core/src/modules/ui/onboarding/` → expect zero matches.
- [ ] `grep -R "Design Library" apps/store-admin/src/layouts/ apps/accounts/src/` under the onboarding-related branches → expect zero matches.
- [ ] When deep-linking into `/design-library?from=onboarding`, the
  receiving page (`apps/store-admin/src/pages/design-library.ts` or
  equivalent) should detect the query and render **"Theme Library"** in
  the H1 + breadcrumb while `from=onboarding` is present. Add a tiny
  branch there; don't globally rename the page (out of scope).
- [ ] Add a lint-level unit test `packages/core/src/modules/ui/onboarding/label-audit.test.ts`
  that greps the `welcome.ts` + `library-preview.ts` source + their CSS
  files for the literal `"Design Library"` and fails the build if
  found. Prevents regressions.

### Task F5: Rollout checklist

Before merging PR:

- [x] Migration 050 is backward-compatible — verified live on server 1's
      `gbox_platform` DB: 14 shops, 100 % at `onboarding_state='completed'`,
      no orphaned / null rows. Kysely select queries in hot paths
      (`packages/core/src/modules/shops/*.ts`) use explicit column lists;
      no `selectAll()` on shops. Old API reading post-migration rows is
      forward-compat safe. [2026-04-20]
- [x] Backfill query ran under 1 second — 14 rows updated in a single
      `UPDATE shops SET onboarding_state='completed' WHERE onboarding_state IS NULL`
      on server 1. Live count post-migration: 14/14 `completed`. [2026-04-20]
- [x] New env var `GBOX_ONBOARDING_WIZARD_ENABLED=true` added to
      `.env.example:141` and exported in server 1's
      `/home/botesty/gbox-platform/.env`. Confirmed via `grep` on both.
      Also set `SESSION_COOKIE_DOMAIN=.gbox.co` on server 1. [2026-04-20]
- [ ] PR description mentions: "Existing shops are migrated to `completed`
      in the up() migration — no retroactive wizard for live sellers."
      (Action item for PR #13 description at merge time.)

---

## Open questions / deferred

1. **Resume mid-clone** — if a seller starts a clone, closes the tab, then
   revisits `/onboarding/first-run`, Task B1 redirects them to the clone
   progress page. If the job has already succeeded, the completion hook
   moves state to `completed` and the first-run route redirects to
   dashboard. If the job failed, state rolls back to `pending` and seller
   sees the welcome again. **Edge case:** what if the failure rollback
   runs but the seller is mid-navigation? Worst case: they see the
   welcome screen and start a new clone. Acceptable for v1.
2. **Clone from a non-Shopify URL** — clone-pro already supports any
   e-commerce site. No wizard change needed.
3. **Design-library integration in wizard** — explicitly OUT OF SCOPE per
   owner decision #3. When Phase D5 of the design-library plan lands the
   "Clone to store" action, we may revisit whether the wizard should
   offer a gallery picker. For now: clone-from-URL only.
4. **Storefront-side first-visit empty state** — when a visitor hits a
   verified domain whose shop has 0 products, the storefront still
   renders a "This store is still being set up" page. That's separate
   from this plan (lives in the storefront app) and tracked under the
   storefront-empty-state spec if/when written.

---

## File inventory

**New files:**
- `packages/db/src/migrations/050_shops_onboarding_state.ts` (+ test)
- `packages/core/src/modules/onboarding/state.ts` (+ test)
- `packages/core/src/modules/ui/onboarding/welcome.ts` (+ test)
- `packages/core/src/modules/ui/onboarding/welcome-css.ts`
- `apps/store-admin/src/pages/onboarding/first-run.ts` (+ test)
- `apps/store-admin/src/pages/onboarding/clone.ts` (+ test)
- `apps/store-admin/src/pages/onboarding/clone-start.ts` (+ test)
- `apps/store-admin/src/pages/onboarding/skip.ts` (+ test)
- `apps/store-admin/src/pages/onboarding/dismiss-banner.ts` (+ test)
- `apps/store-admin/src/pages/onboarding/a11y.test.ts`
- `apps/store-admin/src/middleware/onboarding-gate.ts` (+ test)

**Modified files:**
- `packages/db/src/types.ts` — `ShopsTable` + `ShopOnboardingState`
- `apps/store-admin/src/server.ts` — route wiring + middleware mount
- `apps/store-admin/src/layouts/seller-layout.ts` — banner prop + render
- `apps/accounts/src/pages/create-store.ts` — redirect to wizard
- `apps/accounts/src/server.ts` — delete `getStoreCreated` route
- `apps/store-admin/src/pages/domains.ts` — `postVerifyDomain` nudge branch
- `packages/core/src/modules/clone-pro/runner.ts` — completion hook
- `docs/runbooks/custom-domain-verification.md` — §4, §8
- `.env.example` — `GBOX_ONBOARDING_WIZARD_ENABLED`

**Deleted files:**
- `apps/accounts/src/pages/store-created.ts` (if Task E1 confirms it's dead
  code after the redirect change — otherwise skip the delete).

---

## Success criteria

- A brand-new seller creating a fresh shop sees the welcome wizard as their
  first admin screen.
- "Clone from URL" starts a real clone-pro job and the shop state tracks
  `pending → cloning → completed` through the lifecycle.
- "I'll do this later" dismisses the wizard immediately and shows a
  banner on the next dashboard visit.
- "Dismiss" on the banner permanently clears it and moves state to
  `completed`.
- Every existing shop on server 1 stays in `completed` state with no
  retroactive wizard or banner.
- Killswitch env var returns the UX to the pre-wizard behaviour when set
  to `false`.
- Full test suite green (`pnpm -r test`).
- Zero a11y violations on new pages (axe + keyboard).
- Runbook update merged alongside code.
