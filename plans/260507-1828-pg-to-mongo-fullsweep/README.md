# PG → Mongo full sweep

**Goal:** chuyển toàn bộ codebase từ PostgreSQL/Kysely sang MongoDB. Bỏ `pg`, `kysely`, `@gbox/db/schema/tables.js` references.

**Scope khổng lồ:** 411 file import Kysely, 177K LOC, 78 module dirs trong `packages/core/src/modules/`. Không thể xong trong 1 session — phải làm dần qua nhiều session.

**Strategy:** SLICE BY USER FLOW. Module nào đang nằm trên đường dẫn login admin thì refactor trước (Phase A). Các module khác (products, orders, themes...) refactor dần ở các phase sau, mỗi phase 1 PR.

## Architecture quyết định

- **MongoDB topology:** 15 DB tách (Gbox-Users, Gbox-Shops, Gbox-Products, Gbox-Orders, ...) đã sẵn trên Machine 1 cluster với user `gbox` / pass có sẵn ở env.
- **Auth strategy:** session-based (token = random hex 64 ký tự, lưu hash SHA-256 vào `Gbox-Users.sessions` collection). Bỏ JWT, bỏ `AuthApi` remote call.
- **Connection:** một MongoClient pool dùng chung (host:port giống nhau, chỉ khác DB). Helper `getMongoDb(envKey)` cache theo URI.
- **Schema convention:** giữ snake_case field names như Postgres để giảm code change. `_id` là string (nanoid hoặc ObjectId.toString()).
- **Cross-DB joins:** không có (Mongo không support cross-DB lookup). App-side join khi cần.

## Phase tracking

| Phase | Scope | Status | Files |
|---|---|---|---|
| **A** | Foundation + auth core + login flow → admin.huntershop.us login work end-to-end | **✅ done (2026-05-07)** | mongo client + 6 auth modules + accounts/{login,stores} + store-admin middleware |
| B | Signup + OTP + 2FA + password reset full flow | pending | accounts/{signup,login-2fa,forgot-password,oauth-google,two-factor,account-settings} |
| C | god-admin app (40+ pages dùng Kysely) | pending | apps/god-admin/* |
| D | store-admin pages (90+ pages) | pending | apps/store-admin/pages/* |
| E | API routes (packages/api) | pending | packages/api/routes/* |
| F | Storefront, checkout, supporter | pending | apps/{storefront,checkout,supporter}/* |
| G | Domain modules (products, orders, customers, themes, shops, …) | pending — break into sub-phases | packages/core/src/modules/* (78 dirs) |
| H | Scripts + smoke tests + seed | pending | scripts/* + seed-data.ts |
| I | Cleanup: remove pg, kysely deps; remove @gbox/db imports | pending | package.json + global imports |

## Phase A files (this session)

| File | Action |
|---|---|
| `packages/core/src/modules/db/mongo.ts` | NEW — singleton MongoClient + `getMongoDb()` helper |
| `packages/core/src/modules/db/types.ts` | NEW — UserDoc, SessionDoc, UserShopDoc, ShopDoc, AuditLogDoc, TwoFactorDoc |
| `packages/core/src/modules/auth/session.ts` | REWRITE — Mongo find/insert/delete on `sessions` |
| `packages/core/src/modules/auth/service.ts` | REWRITE — Mongo CRUD on `users`, `user_shops`, `api_tokens` |
| `packages/core/src/modules/auth/audit.ts` | REWRITE — Mongo insert on `audit_logs` |
| `packages/core/src/modules/auth/otp.ts` | REWRITE — Mongo update on `users` |
| `packages/core/src/modules/auth/two-factor.ts` | REWRITE — Mongo CRUD on `user_2fa` |
| `packages/core/src/modules/auth/require-level.ts` | REWRITE — drop Kysely, use validateSession + Mongo |
| `apps/accounts/src/pages/login.ts` | REPLACE AuthApi → direct Mongo verify + createSession |
| `apps/accounts/src/server.ts` | INIT mongo connection on startup; pass to handlers |
| `apps/store-admin/src/server.ts` | INIT mongo connection on startup |
| `apps/store-admin/src/middleware/store-auth.ts` | REPLACE JWT decode → validateSession |
| `scripts/seed-admin-mongo.ts` | NEW — create root admin user (email + bcrypt pass) |
| `packages/core/package.json` | ADD `mongodb` dep |

## Phase A acceptance — ✅ verified 2026-05-07

E2E test from Machine 2 via ingress (HTTPS, --resolve to 127.0.0.1):

- [x] GET /accounts/login → 200, CSRF token 64ch, form rendered with `_csrf`+`email`+`password` inputs
- [x] POST /accounts/login với `duc7bnamdan@gmail.com` → 200, session cookie set (`gbox_session=597194f0...`), interstitial Đang đăng nhập rendered
- [x] GET /accounts/stores → 200, "Welcome back, Hunter Admin", liệt kê Hunter Shop từ Mongo (Gbox-Shops.shops ⨝ Gbox-Users.user_shops)
- [x] GET admin.huntershop.us/admin/store/MwXYO4WodfwNKZeRRQATU → 200, `<title>Dashboard — Hunter Shop — Gbox</title>` + `<h1>Home</h1>`
- [x] Mongo collections seeded: `Gbox-Users.{users,sessions,user_shops,audit_logs}` + `Gbox-Shops.shops`

Seed credentials (testing):
- email: `duc7bnamdan@gmail.com`
- shop:  Hunter Shop / slug `hunter` / domain `huntershop.us`
- shop_id (Mongo `_id`): `MwXYO4WodfwNKZeRRQATU`
- user_id: `vMxeEEgBZns2p4JHgofqB`

## Open question — Cloudflare routing

`admin.huntershop.us` DNS → Cloudflare edge IPs (104.21.27.64 / 172.67.141.196). Machine 2 (192.168.1.24) is on a private LAN — no public IP, no cloudflared / wireguard / tailscale running. For the public URL to actually reach this cluster, one of:
1. Cloudflare Tunnel (cloudflared) running in cluster as a Deployment
2. Router/firewall port-forward 80/443 → 192.168.1.24
3. Something fronting Machine 2 with a public IP

Out of scope for Phase A (login proven working from inside cluster). Open ticket for Phase J — public ingress.

## Out of scope Phase A (sẽ throw runtime error nếu touch)

- Tất cả page khác `/accounts/login`, `/accounts/stores`, `/admin/store/<id>` (dashboard root)
- API server `api.huntershop.us` — vẫn CrashLoop vì server.ts dùng Kysely + thiếu `payments/stripe.js`. Login không phụ thuộc api pod nên OK.
- Storefront, checkout, supporter — chưa refactor.
- Bất kỳ business logic page nào (products, orders, themes...).

## Migrate progress

| Date | Phase | Files done | LOC delta | Notes |
|---|---|---|---|---|
| 2026-05-07 | A start | — | — | Plan set, scope measured |
| 2026-05-07 | A done  | 14 | +1436/−1550 | Login E2E verified. Commits 3184b3c → 3cdef9d → c8daefb → a9eedd0. Image digest 217d57a... rolled out gbox-fe/{accounts,store-admin}. |
