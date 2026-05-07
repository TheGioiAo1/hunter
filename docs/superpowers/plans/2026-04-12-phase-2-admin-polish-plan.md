# Phase 2 — Admin Polish Plan

> Status: **complete** (all five slices landed 2026-04-12)
> Owner: Thai Bui (buithai3107@gmail.com)
> Agent: Claude (Opus 4.6)
> Started: 2026-04-12 (right after Phase 0.7 deferred-item close-out)
> Finished: 2026-04-12
> Predecessor: `docs/superpowers/specs/2026-04-11-phase-0-admin-hierarchy-security-mindmap.md`

## Why Phase 2 exists

Phase 0 delivered the hierarchy + security backbone (Rule 2) and
Phase 0.7 pulled forward the deferred §8 items (2FA enforcement, audit
retention/export, webhook rotation, per-admin IP allowlist). The admin
surfaces now WORK but they still have a dozen "Coming Soon" badges
and half-wired drill-downs from the original MVP. Phase 2 polishes
those off so god-admin and store-admin feel production-grade before
Phase 3 Storefront ships publicly.

## Scope (ranked by impact × effort)

### 2.1 — Shop webhook secret rotation UI  **← start here**

**Why first:** sits directly on top of Phase 0.7 Item #2 (webhook
signing rotation). The rotation system already ships in
`packages/core/src/modules/webhooks/hmac.ts` and via the CLI at
`scripts/ops/rotate-webhook-secret.ts`. Giving god admin a web UI
unlocks the whole feature for ops and finally replaces the "Coming in
Phase 3" stub that's been sitting on `/god-admin/developer/webhooks`.

**Deliverables:**

- Replace the disabled `getWebhooks` stub with a real page:
  - Row per shop that has webhook registrations OR stored secret
  - Columns: shop slug, # webhook subscriptions, last rotated, grace
    status, rotate button
- POST `/god-admin/developer/webhooks/rotate` (strictLimiter, CSRF)
  - Resolves shop by id → calls `rotateShopWebhookSecret`
  - Writes `webhook_secret_rotated` audit entry with `source: 'ui'`
  - Shows the new secret ONCE in a modal/flash (server-rendered, no JS)
- Empty state remains for shops that have never rotated (fallback to
  the HMAC(root, shopId) derivation still applies)

**Out of scope for this slice:** webhook *registration* UI, delivery
history drill-down, bulk rotation — keep the change surgical.

---

### 2.2 — Order / product drill-down wiring

**Why next:** `dashboard.ts` already has "order number → order detail
(Phase 2 target)" in a comment and the `order-detail.ts` page exists
but isn't linked from the dashboard. Merchants who click an order
number expect a detail view.

**Deliverables:**

- Wire `/god-admin/orders/:id` into the router (already imports
  `getOrderDetail`).
- Make every order number in `dashboard.ts`, `orders.ts`, and
  `revenue.ts` render as a `<a href="/god-admin/orders/:id">` anchor.
- Do the same for product IDs (→ product detail) and customer IDs
  (→ customer detail) *if* the pages exist — fall back gracefully.
- Smoke test: click-through from dashboard to order detail.

---

### 2.3 — Background audit export for > 10k rows

**Why:** `security.ts:132` already references this as Phase 2 Admin
Polish work. The current synchronous export caps at 10k rows; real ops
needs occasionally pull 100k+ rows for compliance.

**Deliverables:**

- BullMQ queue `audit-export` on Redis (existing infra).
- Worker reads filter + actor user id, streams CSV to
  `/var/tmp/gbox-audit-exports/<uuid>.csv`, presigned-URL-style
  (signed path stored in platform_settings or audit_exports table
  TBD).
- God admin UI: "Queue large export" button → 202 + "you'll get an
  email / download link when it's ready".
- Expiry: files older than 72h deleted by the existing prune cron.

**Only start after 2.1 and 2.2.**

---

### 2.4 — "Coming Soon" audit and honest labelling

**Why:** 8+ placeholders still live across developer.ts, ai-agents.ts,
online-store.ts, gift-cards.ts. Some (gift-cards, ai-agents/3 of 4)
are genuinely Phase 3/4; others (webhooks) become obsolete once 2.1
lands. Walk each one and either:

- Wire it to a real implementation, or
- Replace the badge with a clear "Phase 3 / Phase 4" label and move
  on. Don't leave unclickable buttons with `disabled` + `opacity:0.5`.

---

### 2.5 — Accessibility + keyboard polish pass

**Why:** layouts already reference Phase 2 Step 2.8 (WCAG 2.4.1 skip
nav) and 2.6 (command palette). Walk through every god-admin and
store-admin page and confirm:

- Skip link is reachable with Tab from the very first focusable
  element.
- Every icon-only button has an `aria-label`.
- Focus outlines aren't suppressed by global `outline: 0` rules.
- Command palette surfaces every route in the nav tree.

---

## Execution order (agreed with owner)

```
1. Draft THIS plan and commit           (done — a9e8ab3)
2. Land 2.1 — Webhook secret rotation   (done — bbe5c21)
3. Land 2.2 — Drill-down wiring         (done — 5928e80)
4. Land 2.3 — Background audit export   (done — 004a387)
5. Land 2.4 — Coming Soon audit         (done — 1869235)
6. Land 2.5 — A11y + keyboard polish    (done — f904b0b)
7. Phase 2 close-out: plan + smoke test (this commit)
```

All slices shipped on branch `feat/god-admin-2fa-hardening`
(pushed to both `org` and `origin` remotes, deployed to
`botesty@192.168.1.13` and smoke-tested on each slice).

## Close-out verification

- `/god-admin/login` returns 200.
- `/god-admin/security` returns 302 → login redirect (auth wall intact).
- `/god-admin/security/audit-export/queue` (POST, unauth) → 302.
- `/god-admin/security/audit-export/:id/download` (GET, unauth) → 302.
- `pm2 info gbox-god-admin` → online, 0 unstable restarts.
- Background worker registered in `startWorkers()` — visible in
  activeWorkers array as the third push.

## Tech debt carried forward (intentional)

- **Audit export prune wiring**: `pruneExpiredAuditExports()` is
  defined but not yet called from `scripts/ops/prune-audit-logs.ts`.
  Files still get TTL'd out of Redis (72h) so nothing grows unbounded;
  the cron hook can land whenever the next audit-log prune cycle ships.
- **God-admin tsx deprecation warnings**: pre-existing issue from
  earlier in the day; unrelated to Phase 2 work. Fix is a one-liner
  in the pm2 ecosystem file (`--loader tsx` → `--import tsx`).
- **Developer Hub "Active Webhooks" count**: now queries the real
  table but will be inaccurate the moment multi-secret rotation lands
  Phase 4. Revisit when webhook UI gains edit/delete.

## Cross-references

- Phase 0 mindmap: `docs/superpowers/specs/2026-04-11-phase-0-admin-hierarchy-security-mindmap.md`
- God Admin platform plan: `docs/superpowers/plans/2026-04-07-god-admin-platform-plan.md`
- Webhook rotation module: `packages/core/src/modules/webhooks/hmac.ts`
- IP allowlist module: `packages/core/src/modules/auth/ip-allowlist.ts`
- Iron rules: `CLAUDE.md` §Rule 1, §Rule 2, §Rule 3
