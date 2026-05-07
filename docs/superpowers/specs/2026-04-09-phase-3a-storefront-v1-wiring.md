# Phase 3A — Storefront v1 Wiring

> **Goal:** Turn the already-built theme engine into a running, test-covered Express SSR server that serves the Gbox Dawn seed theme for a real shop.
>
> **Date:** 2026-04-09
> **Status:** Spec — approved by Thai (standing authorization for Phase 3)
> **Owner:** Claude (execute), Thai (review end-of-phase)

---

## 1. Context & Motivation

**What already exists (packages/core):**
- Liquid renderer (`themes/engine/liquid.ts`), tags, filters, JSON template parser
- Pipeline (full page render: layout + template + sections), section API (`?sections=`)
- Storefront router with 16 Shopify-compat routes (`themes/engine/storefront/router.ts`)
- Express adapter shim (`themes/engine/storefront/express-adapter.ts`)
- `DbDataSource` backed by Kysely (`themes/engine/storefront/db-datasource.ts`)
- Locale negotiator, error logger, theme-config loader
- Gbox Dawn seed theme (20 sections, 16 templates, layout, snippets, assets)

**What is missing:**
- `apps/storefront/src/` is empty — no Express server, no bootstrap, no middleware chain, no deployment config
- Multi-tenant shop resolver (Host header → shop_id via `shop_domains` table)
- Cookie parsing (cart/session/locale) wired in
- Static asset serving for theme files (`/assets/*`)
- 404 + 500 pages rendered through the template engine
- Request ID / structured logging / health check
- Integration tests (supertest against the live app)
- PM2 + nginx deployment config for Server 3 (192.168.1.19)

**Why 3A first:** Every other Phase 3 sub-phase (cart, customer accounts, SEO, analytics, theme builder, AI) assumes the storefront *renders HTML for a real shop at an HTTP port*. 3A is the glue that makes the rest addressable.

**What 3A is NOT:**
- NOT rewriting the theme engine (it's done and tested)
- NOT touching cart *mutation* (only read cart cookie; writes happen in 3B)
- NOT customer auth (3C)
- NOT analytics events (3E)
- NOT the visual theme builder (3F)
- NOT custom-domain SSL provisioning (deferred — single test domain only in 3A)

---

## 2. Success Criteria (exit checklist)

A running `apps/storefront` that satisfies all of:

1. **Boots clean**: `node --loader tsx apps/storefront/src/server.ts` prints `[Gbox Storefront] Running on :4326 | PID: …` and listens.
2. **Health check**: `GET /_health` returns `{ status: 'ok', service: 'gbox-storefront', …}`.
3. **Multi-tenant resolve**: `GET /` with `Host: demo.gbox.test` looks up `shop_domains.domain = 'demo.gbox.test'`, finds the shop, and renders `index.json` from that shop's active theme.
4. **Renders Dawn seed**: Given a shop whose active theme is Gbox Dawn, `GET /products/:handle` and `GET /collections/:handle` return HTML with the product/collection title in the body.
5. **Assets**: `GET /assets/theme.css` returns the CSS file with `Content-Type: text/css` and `Cache-Control: public, max-age=…`.
6. **404 via engine**: `GET /does-not-exist` renders `templates/404.liquid` (not Express's default).
7. **500 via engine**: When a template throws, `templates/500.liquid` renders and request details are logged.
8. **Cookie read**: The `cart` and `_session` cookies reach the datasource loader (observable via integration test with fake datasource).
9. **Locale**: Cookie `locale` → header `Accept-Language` → shop default → `en-US` negotiation works.
10. **Request ID**: Every response has `X-Request-ID` header; logger prints `[req=<id>] …` lines.
11. **All tests green**: `npx vitest run` — no regressions, +N new tests from this phase.
12. **Integration test**: Supertest against the real Express app + `MemoryDataSource` seeded with a shop + Dawn theme returns 200 HTML for `/`, `/products/:h`, 404 for missing, 500 for thrown.
13. **PM2 + nginx config drafted** for Server 3 (not deployed in 3A — deployment is a separate runbook step).

Exit: all 12 criteria pass + Phase 2-style commit-per-stage + push to `origin` + `org`.

---

## 3. Architecture

```
                      ┌──────────────────────────┐
                      │   apps/storefront/src    │
                      │      (Express SSR)       │
                      └──────────────────────────┘
                                   │
        ┌──────────────────────────┼──────────────────────────┐
        │                          │                          │
   middleware                 handler                    shutdown
   ─────────────              ───────                    ────────
   • request-id               • express-adapter          • destroyDb
   • logger                   • storefront router        • closeRedis
   • compression/perf         • pipeline render
   • security headers         • section API
   • cookie-parser
   • host→shop resolver       on error →
   • locale negotiator        • 404 template
   • cart cookie reader       • 500 template + logger
   • asset static mount
        │
        ▼
   Kysely Db → DbDataSource → theme-config-loader → gbox-dawn seed
```

### 3.1 Module layout

```
apps/storefront/
├── package.json                ← deps: express, cookie-parser, @gbox/core, @gbox/db
├── tsconfig.json
└── src/
    ├── server.ts               ← entry: boots app, graceful shutdown
    ├── app.ts                  ← builds Express instance (exported for tests)
    ├── middleware/
    │   ├── request-context.ts  ← request id + logger binding
    │   ├── resolve-shop.ts     ← Host → shop_id, 404 if unknown
    │   ├── cookies.ts          ← cart / session / locale cookie extraction
    │   ├── assets.ts           ← /assets/* static handler
    │   └── error-handler.ts    ← renders 404/500 via engine
    └── handler.ts              ← wires express-adapter + datasource + options
```

### 3.2 Data flow per request

```
Request arrives
  │
  ▼
1. request-context  → req.ctx = { id, startedAt, logger }
  │
  ▼
2. security-headers + compression + cookie-parser
  │
  ▼
3. resolve-shop     → req.gboxShopId = <uuid>   (404 if no match)
  │
  ▼
4. assets           → if /assets/* → serve file (skip storefront handler)
  │
  ▼
5. cookies          → req.cartToken, req.sessionToken, req.localeCookie
  │
  ▼
6. storefront handler (express-adapter → router → pipeline)
  │
  ▼
7. error-handler    → on throw: log + render 500; on next(404): render 404
  │
  ▼
Response out with X-Request-ID header + perf timing log
```

### 3.3 Key design decisions

| Decision | Choice | Reason |
|---|---|---|
| Framework | Express 5 | Matches `apps/accounts`, `apps/god-admin`, `apps/store-admin` pattern — reuse existing middleware |
| DB handle | Closure-bound single `Kysely` via `createDb()` | Same as `apps/accounts` |
| Shop resolver | Direct SELECT on `shop_domains WHERE domain = $1` with in-memory LRU cache (60s TTL) | Sub-ms lookup; simple invalidation by restart or explicit TTL |
| Host normalization | Strip port, lowercase, strip trailing `.` | Avoid cache-misses on `:4326` suffix |
| Dev fallback | If `HOST=localhost`/`127.0.0.1` and env `STOREFRONT_DEV_SHOP_SLUG` set → resolve by slug instead of domain | Local dev without fake /etc/hosts entries |
| Asset serving | `express.static()` mounted at `/assets` pointing to the active theme's asset dir (dev) | R2 redirect belongs in 3A.10 deployment config, not runtime |
| 404 flow | `express-adapter` calls `next()` when router returns null → error-handler matches `err === 'NOT_FOUND'` → renders `templates/404.liquid` via a mini-pipeline | Keeps the adapter pure, lets error-handler own presentation |
| 500 flow | Express `err` handler catches → logs stack with request-id → renders `templates/500.liquid`; if *that* throws, plaintext fallback | Never leak stack traces in HTML |
| Cookie names | `cart`, `_session`, `locale` | Matches what the existing router already reads (`req.cookies['cart']`, `req.cookies['_session']`) |
| Port | `4326` (env `STOREFRONT_PORT`, fallback `4326`) | Matches masterplan diagram + frees `4321` on Server 3 for API |
| Security headers | **NEW** `storefrontSecurityHeaders` helper in `packages/core/src/modules/security/headers.ts` — looser than admin (allows external img/font CDNs, `frameAncestors 'self'` so merchants can embed), stricter than nothing (HSTS, noSniff, referrer) | Storefront is public; rules differ from admin |
| Logging | Reuse `requestLogger('gbox-storefront')` from `@gbox/core/modules/logging/logger.js` | Consistency across all apps |
| Testing | Vitest + supertest against `buildApp()` from `app.ts` — seed a `MemoryDataSource`, bypass DB | Fast, deterministic; DB integration is server-3 smoke-test territory |

---

## 4. Stage Breakdown

The phase is split into 10 stages. Each stage is test-first, green-before-commit, and ends with a commit + push to both remotes.

| # | Stage | What ships | New tests |
|---|---|---|---|
| 3A.1 | Scaffold | `apps/storefront` package.json + tsconfig + empty `app.ts`/`server.ts` + health check | 3 (app factory, health, 404 default) |
| 3A.2 | Request context | `middleware/request-context.ts` — injects X-Request-ID, binds logger | ~8 |
| 3A.3 | Storefront security headers | `storefrontSecurityHeaders` helper in `security/headers.ts` + unit test | ~6 |
| 3A.4 | Host→shop resolver | `middleware/resolve-shop.ts` + LRU cache helper + unit tests (including dev fallback) | ~10 |
| 3A.5 | Cookie middleware | `middleware/cookies.ts` — reads `cart`/`_session`/`locale` into typed shape | ~8 |
| 3A.6 | Storefront i18n negotiator | Reuse admin-i18n locale-negotiate pattern as a shared `modules/i18n-negotiate` OR wire directly — TBD in stage design; tests drive it | ~8 |
| 3A.7 | Asset static handler | `middleware/assets.ts` — serves active theme asset files with correct MIME + cache headers | ~8 |
| 3A.8 | Handler + datasource wiring | `handler.ts` — builds `ExpressStorefrontHandler` from a shop+db, integration tests against `MemoryDataSource` for `/`, `/products/:h`, `/collections/:h` | ~10 |
| 3A.9 | Error handler (404 + 500) | `middleware/error-handler.ts` — renders `templates/404.liquid`/`templates/500.liquid` via mini-pipeline | ~10 |
| 3A.10 | PM2 + nginx runbook draft | `docs/runbooks/storefront-deploy.md` — ecosystem.config.cjs snippet, nginx upstream block, env vars, rollback steps (NO live deploy in 3A) | 0 (doc only) |

Estimated total new tests: ~71.

---

## 5. Error Handling Strategy

- **Unknown host** (no match in `shop_domains`): resolve-shop responds `404` directly with a minimal HTML page (no template engine, because no theme to render from). A later phase adds a generic "shop not found" landing page.
- **Shop exists but has no active theme**: 500 — rendered via a hard-coded fallback (can't use the engine without a theme).
- **Template render throws**: error-handler catches, logs with `X-Request-ID`, renders `templates/500.liquid` from the *shop's own theme*. If that render also throws, plaintext fallback `"500 Internal Server Error — Request ID: <id>"`.
- **Route matched but loader returns null** (e.g. `/products/bogus`): express-adapter already calls `next()` — error-handler renders `templates/404.liquid`.
- **Asset not found**: express.static returns its own 404 — we wrap it so it renders `templates/404.liquid` instead of the Express default.
- **Database down**: resolve-shop throws → error-handler logs + renders 500. No retry logic in 3A — circuit breaker is a separate concern.

---

## 6. Testing Strategy

### 6.1 Unit tests (per middleware)
Every middleware file has a `.test.ts` sibling. Tests construct fake `req`/`res`/`next`, assert on what they mutate. No Express instance needed.

### 6.2 App-level integration tests (`app.test.ts`)
- Build the real Express app via `buildApp({ datasource: new MemoryDataSource(seed), ... })`
- Use `supertest` (already in dev deps via other apps — verify in 3A.1)
- Scenarios:
  - `GET /_health` → 200 JSON
  - `GET /` with resolved shop → 200 HTML containing `<title>` from shop
  - `GET /products/:handle` → 200 HTML with product title
  - `GET /products/bogus` → 404 HTML (from `templates/404.liquid`)
  - `GET /assets/theme.css` → 200 CSS
  - `GET /does-not-exist` → 404 HTML
  - Missing `Host` header → 404 HTML
  - Handler throws → 500 HTML + stack in log (not in response)
  - `X-Request-ID` header present on every response
  - Locale cookie `de-DE` → shop's German content (if datasource supports it; stub if not)

### 6.3 Smoke test
- `docs/runbooks/storefront-deploy.md` includes a manual curl script to run on Server 3 after deploy:
  ```
  curl -sSI http://localhost:4326/_health | grep 200
  curl -sS -H "Host: demo.gbox.test" http://localhost:4326/ | grep -qi "<html"
  ```

---

## 7. Out of Scope (explicitly)

- **Custom domain SSL provisioning** — deferred; 3A supports a single pre-seeded test domain only.
- **R2 asset redirect** — dev uses `express.static`; production R2 URL generation is in the deployment runbook but not implemented as runtime code in 3A.
- **Cart mutations** (POST /cart/add etc.) — 3B.
- **Customer login on storefront** — 3C.
- **Search UI** (`/search?q=`) — handler ships (router already has the route), but proper full-text ranking + autocomplete is 3D.
- **Structured data / sitemap / robots** — 3D.
- **Analytics events** — 3E.
- **Visual theme editor** — 3F.
- **AI content generation** — 3G.

---

## 8. Risks & Mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Theme engine has an edge case the adapter doesn't cover | Medium | Integration tests exercise all 16 routes against Dawn seed; any bug → fix in engine in same phase |
| `express.static` can't resolve per-shop theme path | Low | Asset middleware computes path from resolved shop's active theme dir; fall back to seed dir in dev |
| Cookie-parser + signed cookies mismatch across apps | Low | Reuse existing cookie helpers from `@gbox/core/modules/auth/session.js` for `_session`; cart/locale are unsigned |
| Host cache staleness after custom-domain change | Low | 60s TTL acceptable; explicit cache-clear endpoint is 3A.4 stretch |
| Phase 3A grows during implementation | Medium | Explicit "out of scope" list above; any new scope → push to 3B-3G |

---

## 9. Open Questions

None — Thai has granted standing authorization for Phase 3 (`"hay start tu 3A den 3G, lan luot, van hoan toan do em quyet dinh, khong can hoi lai anh nua"`). Any decision point Claude resolves using Iron Rules + existing Phase 2 patterns.

---

## 10. Definition of Done

- [ ] All 10 stages committed individually to `master` with `Co-Authored-By: Claude Opus 4.6`
- [ ] Each commit pushed to both `origin` (xaozayta) and `org` (GBox-Company)
- [ ] `npx vitest run` → green (all new tests + no regressions)
- [ ] `apps/storefront` boots locally on port 4326 and responds to `/_health`
- [ ] This spec file stays checked into git under `docs/superpowers/specs/`
- [ ] `docs/runbooks/storefront-deploy.md` exists and is complete enough for Server 3 deploy
- [ ] Phase 3A summary posted; Phase 3B spec kickoff begins immediately after
