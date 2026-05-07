# Domain-first Onboarding — Design Spec

> **Status:** Draft — awaiting owner (Thai) review
> **Filed:** 2026-04-25
> **Related:** Phase 14 PR #91-#97 incident chain; CLAUDE.md Iron Rule 2 (hierarchy) + Iron Rule 5 (no god-admin leaks); Phase 2B domains page; Phase 19 PR1 Clone Pro v5
> **Scope:** Sellers get a working public URL from minute zero; clone result is immediately visible; custom domain is the UPGRADE path not a prerequisite.

---

## 0. TL;DR

Gbox's cloned Shopify-style UI already ships every shop with a default subdomain at `<slug>.gbox.co`. DNS wildcard is configured, nginx has a `*.gbox.co` server block, storefront's `lookupShopByHost` checks `shops.domain` as the third fallback. **Every piece of infrastructure works EXCEPT one line** — `create-store` never populates `shops.domain`, so the whole chain dead-ends with a 404 when a seller visits their default subdomain.

This spec:

- **P0 (1 commit)** — populate `shops.domain = <slug>.gbox.co` at create-store time + backfill existing shops. Fixes "Visit live site" for every past and future clone immediately.
- **P1 (1 PR)** — surface the default subdomain in the onboarding wizard + clone-pro detail page + post-verify stores hub, so the seller SEES their live URL from the moment their account is ready.
- **P2 (follow-up PR)** — Clone Pro auto-publish: when `status=succeeded`, flip to `published` automatically if the shop has a verified primary domain (default subdomain counts as verified). Seller stops having to click "Publish" on every run.
- **P3 (deferred, optional)** — pre-clone "add custom domain" nudge in the onboarding wizard. Non-gating; seller can skip and upgrade later. Matches Shopify's pattern of "set up custom domain when you're ready to promote".

Each P level is shippable independently. P0 alone closes the reported bug.

---

## 1. Problem statement (2026-04-25 incident)

Seller `lamdiepanh1903@gmail.com` completed clone of `bibliobloom.com`. Clone graded B/85 and user clicked "Publish to live". Two things failed:

1. **"Visit live site" was a dead `href="#"`** (fixed in PR #97 with "Add a domain to go live" fallback)
2. **Default subdomain `best-store.gbox.co` returns 404** even though wildcard DNS + nginx are configured

The deeper issue: Gbox messages everywhere that shops have a default subdomain, but no code path populates it. The whole platform subdomain promise is aspirational.

## 2. Goals

1. **Every shop has a working public URL from `create-store` onwards** — no seller action required.
2. **Clone result is visible immediately post-succeeded** on that default URL — no "Publish" gymnastics to see output.
3. **Custom domain is the UPGRADE path, not a prerequisite** — matches Shopify's `<slug>.myshopify.com` → "Connect your domain" pattern exactly.
4. **Existing shops (including `best-store`) are backfilled** so current sellers don't stay broken.
5. **No Iron Rule 5 regressions** — seller-facing copy never leaks god-admin paths.

## 3. Non-goals

- Rebuilding the existing custom-domain + Cloudflare SSL flow (already works; Phase 2B shipped it).
- Forcing every seller through a domain-setup wizard before clone. Friction cost > benefit.
- Giving each shop a stable IPv4 for direct A-record use. The `*.gbox.co` wildcard via Cloudflare handles TLS; sellers who want apex use the existing Phase 2B flow.
- Changing Clone Pro's pipeline stages or grading logic.

## 4. Infrastructure audit (what's already wired)

| Layer | Exists? | Where |
|---|---|---|
| Wildcard DNS `*.gbox.co` → Cloudflare → server 1 | ✓ | Cloudflare zone config |
| Wildcard TLS cert | ✓ | `/etc/ssl/cloudflare/gbox.co.pem` (checked on server 1) |
| Nginx `server_name *.gbox.co` → storefront upstream | ✓ | `/etc/nginx/sites-enabled/gbox` |
| Storefront `lookupShopByHost` checks `shops.domain` | ✓ | `apps/storefront/src/server.ts:295-301` |
| `shops.domain` column exists + indexed | ✓ | migration history; `idx_shops_domain` |
| Domains admin page shows the subdomain | ✓ | `apps/store-admin/src/pages/domains.ts:343-383` (hard-coded `${slug}.gbox.co`) |
| **`create-store` populates `shops.domain`** | **✗** | **THIS is the gap** |
| Existing rows backfilled | ✗ | |

Because everything else works, the fix is ~10 lines of code + one migration.

## 5. Locked architectural decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | Default subdomain pattern is `<slug>.gbox.co` — already hard-coded elsewhere in the app. | Consistency with domains page + existing nginx wildcard + TLS cert. No new env vars. |
| D2 | `shops.domain` holds the CURRENT primary-facing host (default subdomain OR verified custom domain). Not a historical ledger. | Single source of truth for storefront lookup + "Visit live site" CTA. |
| D3 | When seller adds a custom domain and marks it primary (via existing Phase 2B flow), `postSetPrimaryDomain` updates `shops.domain` too. | Keeps `shops.domain` in sync with the Phase 2B domain-management flow. |
| D4 | Unsetting a custom-domain primary (or removing one) reverts `shops.domain` back to `<slug>.gbox.co`. Default subdomain is never removed. | A shop always has at least its default subdomain. No broken-state window. |
| D5 | Clone Pro `auto-publish-on-succeeded` is gated by `AUTO_PUBLISH_AFTER_CLONE=true` env (default ON in prod). Seller retains a manual override via "Don't auto-publish" flag in clone-pro config. | Matches Shopify's "Publish automatically" toggle; ON by default, opt-out per-clone. |
| D6 | Pre-clone domain wizard (P3) surfaces EXISTING domain status as an info card in the onboarding/clone form. Does NOT block clone. | Never gate a user with no domain; show them the upgrade option. |
| D7 | Slug reservations (`gbox-subdomain-not-allowed` validators) already exist in domains.ts; `create-store` slugify must produce slugs that pass those validators. | Prevents a seller from claiming `admin.gbox.co` etc. via collision. |
| D8 | Backfill migration runs once, is idempotent, skips shops with non-empty `domain`. | Safe to re-run; never clobbers a custom-domain-primary set later. |
| D9 | Iron Rule 5 check: "Visit live site" copy + banner copy uses "Please contact Gbox support" for any infra error. Never exposes `/god-admin` / `/settings/admin` / internal service names. | Continuing CLAUDE.md Rule 5 discipline. |

## 6. Implementation plan — three phases

### Phase P0 — "Default subdomain actually works" (MUST ship first)

Deliverable: every existing and future shop has `shops.domain = '<slug>.gbox.co'`, so `https://<slug>.gbox.co/` serves their storefront immediately.

**Code changes (~15 lines):**

1. `apps/store-admin/src/pages/stores-hub.ts::postCreateStore()` line 484 — insert `domain: \`${slug}.gbox.co\`` into the values block. Uses the already-reserved slug so no race with slug uniqueness check.
2. `apps/accounts/src/pages/create-store.ts::postCreateStore()` — same. (Legacy accounts-host create-store still exists per the codebase hybrid.)
3. New migration `NNN_shops_default_subdomain_backfill.ts`:
   ```sql
   UPDATE shops
      SET domain = slug || '.gbox.co'
    WHERE domain IS NULL OR btrim(domain) = '';
   ```
   Idempotent. Adds no new column.
4. Unit test: creating a new shop sets `domain = '<slug>.gbox.co'`.
5. Live-DB smoke addition in `scripts/smoke-phase20-pr1.ts`: probe `https://<slug>.gbox.co/` for a fresh shop and assert 200.

**Iron Rule 5 copy audit for this phase:**

- No seller-facing copy change here; only a backend insert. The existing domains-tab copy ("Every Gbox shop ships with a default subdomain on `*.gbox.co`") stops being a lie.

**Exit criteria (P0 done):**

- All existing non-discarded shops have `shops.domain != NULL/''`.
- `lookupShopByHost('<slug>.gbox.co')` returns the expected shop for all shops.
- `best-store.gbox.co` (the incident shop) serves a non-404 response.

### Phase P1 — "Seller sees their live URL immediately" (polish; independent PR)

Deliverable: the default subdomain is surfaced everywhere the seller looks right after create-store, and the "Visit live site" CTA uses it by default.

**Code changes:**

1. `apps/store-admin/src/pages/clone-pro/detail.ts::publishedCta()` — the fallback branch (currently "Add a domain to go live") becomes a REAL "Visit live site" link to `https://<shopDomain>` where `shopDomain = req.store.domain` (guaranteed populated after P0). The "Add a domain" nudge moves to an optional side-card.
2. `apps/accounts/src/pages/create-store.ts::getStoreCreated()` — post-create confirmation page now prominently displays "Your store is live at `<slug>.gbox.co`" with a primary-action link.
3. `apps/store-admin/src/pages/onboarding/first-run.ts` + welcome.ts — add a "Your store URL" strip at the top of the wizard with the default subdomain + copy-to-clipboard.
4. `apps/store-admin/src/pages/clone-pro/detail.ts` — replace the advisory banner "one more step to go public" with a confirmation banner "Your clone is live at `<slug>.gbox.co`" + "Want a branded URL? Add a custom domain" side-link.
5. Unit + render tests for each surface.

**Iron Rule 5 copy audit:**

- All copy uses "your store", "your URL" — never mentions internal platform mechanics.
- "Contact Gbox support" is still the only escape-hatch phrase.

### Phase P2 — "Clone auto-publishes to the default subdomain" (follow-up PR)

Deliverable: when Clone Pro pipeline reaches `status=succeeded`, if the shop has a primary domain (always true post-P0), flip to `status=published` automatically. Seller no longer has to click "Publish".

**Code changes:**

1. `packages/core/src/modules/clone-pro/pipeline.ts::finalize stage` — after `status=succeeded`, if env `AUTO_PUBLISH_AFTER_CLONE !== 'false'` AND `config.autoPublish !== false`, call existing publish logic inline.
2. `CloneProConfig.autoPublish?: boolean` — new optional field; runner threads the env default through.
3. `apps/store-admin/src/pages/onboarding/clone.ts` + `apps/store-admin/src/pages/clone-pro/new.ts` — optional "Publish automatically when finished" checkbox (default CHECKED). Seller can uncheck to leave the clone in `succeeded` for manual review.
4. Clone-pro detail page removes the "Publish to live" button when `autoPublish=true AND status=succeeded`; instead shows "Publishing automatically…" with the stage-7/finalize progress.
5. Unit tests covering: auto-publish on, auto-publish off, env flag off overrides config-on (safety fuse).

**Iron Rule 5 copy audit:**

- Checkbox label: "Publish automatically when the clone finishes" — product-neutral.
- Error path if auto-publish fails (e.g. `grade='F'`): banner says "Publish blocked. Please review the clone report before making it live." No god-admin path disclosure.

### Phase P3 — "Nudge custom domain post-publish" (deferred, discuss after P0+P1+P2)

Deliverable: on the onboarding/clone form (and post-clone detail page), offer a single-click path to "Use a custom domain instead of `<slug>.gbox.co`" that deep-links into the existing Phase 2B domains UI.

This is intentionally the LAST phase because:

- Custom-domain adoption is a conversion event that should be measured — no point shipping UI without instrumentation (`domain_add_clicked`, `domain_verified`, `domain_set_primary_post_clone` events).
- The existing Phase 2B UI is functional; we just need a discovery nudge.

**Code changes (sketch, not fully specced yet):**

1. `onboarding/clone.ts` form — optional "Want your store on your own domain?" expandable section.
2. A `post-clone-success` tooltip on the detail page for shops whose `domain` still ends in `.gbox.co` after 24h, offering the upgrade path.
3. Event instrumentation on a `custom_domain_funnel` analytics slot (tie into Phase 6 analytics module).

**Deferred questions for P3 discussion:**

- Do we offer a free `gbox-hosted` custom domain for paid tiers?
- When seller switches to custom domain, do we 301 redirect the `<slug>.gbox.co` URL permanently?
- How do we handle SEO for a shop that changes primary domain mid-life?

## 7. Data flow — before vs after

### Before (broken)

```
seller creates shop "Best Store" (slug=best-store)
  → shops.domain = '' ← broken
  → clone succeeds
  → "Visit live site" href="#" ← broken
  → best-store.gbox.co returns 404 ← broken
```

### After P0

```
seller creates shop "Best Store" (slug=best-store)
  → shops.domain = 'best-store.gbox.co' ← FIXED
  → clone succeeds (manual publish still)
  → "Visit live site" → https://best-store.gbox.co ← WORKS
  → best-store.gbox.co serves the cloned storefront ← WORKS
```

### After P2 (auto-publish)

```
seller creates shop "Best Store"
  → shops.domain = 'best-store.gbox.co'
  → clone pipeline reaches status=succeeded
  → auto-publish fires (default ON) → status=published, published_at=now
  → seller lands on detail page with "Your clone is live at best-store.gbox.co" banner
  → single click → storefront
```

### After P3 (custom domain nudge, opt-in)

```
seller has lived with best-store.gbox.co for a while
  → onboarding/clone form or detail page shows "Upgrade to your own domain?" card
  → click → /online-store/domains (existing Phase 2B flow)
  → seller adds example.com + verifies via Cloudflare nameserver
  → setPrimaryDomain → shops.domain = 'example.com' (+ redirect shopify-style from .gbox.co)
  → "Visit live site" now points at example.com
```

## 8. Testing strategy

### P0 unit tests

- `stores-hub.test.ts`: creating a shop sets `domain = '<slug>.gbox.co'`.
- New migration file self-test: backfill is idempotent, skips non-empty domain.
- `lookupShopByHost` already tested; add a case for "match via `shops.domain` when `shop_domains` + `custom_domain` are both empty".

### P1 + P2 render tests

- Chrome tests assert the "Your store URL" strip shows the right default subdomain.
- deriveDetailChrome covers `published` state with `shopDomain = '<slug>.gbox.co'`, asserts CTA is the full https link.
- Pipeline test covers auto-publish ON / OFF, env override.

### Live e2e smoke addition

Extend `scripts/smoke-onboarding-e2e.ts` (shipped PR #96) with:

- [E10] After create-store, `shops.domain` is non-empty and matches `<slug>.gbox.co`.
- [E11] GET `https://<slug>.gbox.co/` returns 200 (real public hit via test sub-shop).

### Iron Rule 5 lint

Extend the existing iron-rule-5 lint script to flag any new file that contains the literal `god-admin` or `/settings/admin` in seller-facing HTML. Not directly P0-P3 code, but prevents copy drift.

## 9. Rollout + rollback

### Rollout

- P0 ships behind no flag (it's a data-level fix). Backfill migration first, then the create-store change.
- P1 ships immediately after P0 lands.
- P2 ships behind `AUTO_PUBLISH_AFTER_CLONE` env (default ON in prod, can be turned OFF per pod as kill-switch).
- P3 ships with a feature flag if we decide to A/B test the domain nudge.

### Rollback

- P0: if the backfill is wrong, `UPDATE shops SET domain = '' WHERE domain LIKE '%.gbox.co'` — one-line revert. Create-store reverts by removing the single line.
- P1: pure UI; revert the commit.
- P2: env flip `AUTO_PUBLISH_AFTER_CLONE=false` — instant kill-switch per pod.

## 10. Open questions (decisions Thai still needs to lock)

| # | Question | Default proposal |
|---|---|---|
| Q1 | Should `shops.domain` also track the CHANGE-OVER to a custom domain (i.e. update it on `setPrimary`)? | Yes — D3 above. |
| Q2 | When a seller removes their custom domain, should `shops.domain` fall back to `<slug>.gbox.co`? | Yes — D4 above. Default subdomain is always a floor. |
| Q3 | Is `AUTO_PUBLISH_AFTER_CLONE` default ON or OFF in prod? | ON. Shopify's default is "publish when clone succeeds"; sellers can turn off per-clone. |
| Q4 | In P3, should we 301 redirect from `<slug>.gbox.co` → custom domain after switch? | Yes, for SEO — Shopify does this. Defer until P3. |
| Q5 | Pre-clone "add custom domain" — gating or non-gating? | NON-gating. Anyone who wants to clone without touching DNS should be able to. Matches the user's original case 2. |
| Q6 | Is there a concurrency-safety concern on the slug → domain mapping? | No — slug has UNIQUE index, so `<slug>.gbox.co` is automatically unique. |
| Q7 | Should `gbox-subdomain-not-allowed` validator block slugs like `admin`, `checkout`, `accounts`? | Yes — reserved slugs list. Already enforced by domains.ts validator for custom domains; add the same check to `slugify()` in create-store. |

## 11. Success metrics (how we know P0+P1+P2 worked)

- **P0**: `SELECT COUNT(*) FROM shops WHERE domain IS NULL OR domain = ''` returns 0 within 5 minutes of backfill.
- **P0**: `curl https://<slug>.gbox.co/` returns 200 for >99% of non-discarded shops within the same window.
- **P1**: support tickets containing "visit live site doesn't work" drop to 0 after 7 days.
- **P2**: % of `succeeded` clones that become `published` (auto OR manual) rises from ~X% (today) to >95% within 14 days.
- **P3 (if shipped)**: custom-domain adoption funnel CTR > baseline by a statistically significant margin.

## 12. Out of scope (explicitly deferred)

- Per-shop stable IPv4 for direct A-records. `*.gbox.co` CNAME through Cloudflare remains the blessed path.
- Email forwarding on `<slug>.gbox.co`. Sellers who want email on a branded domain use their custom domain.
- Analytics / metrics dashboards. Ship in Phase 6 analytics polish.
- SEO redirects between default subdomain and custom domain. Handled in P3 / later.
- A/B testing of the P3 domain-upgrade nudge timing.

## 13. Follow-up specs required

- **Phase 21 (Q3 idea)**: `<slug>.gbox.co` vanity-slug rewrite — let sellers change their slug post-creation without losing SEO. Requires 301 redirect infrastructure.

---

## Appendix A — minimal P0 diff (to validate sizing)

```diff
 // apps/store-admin/src/pages/stores-hub.ts
   const shop = await db
     .insertInto('shops')
     .values({
       name: store_name.trim(),
       slug,
+      domain: `${slug}.gbox.co`,
       email: user.email,
       country,
       currency: defaults.currency,
       timezone: defaults.timezone,
     })
```

```sql
-- packages/db/src/migrations/NNN_shops_default_subdomain_backfill.ts
UPDATE shops
   SET domain = slug || '.gbox.co'
 WHERE domain IS NULL OR btrim(domain) = '';
```

Two real changes, ~3 lines of production code. Everything else (nginx, DNS, TLS, storefront routing) is already live.
