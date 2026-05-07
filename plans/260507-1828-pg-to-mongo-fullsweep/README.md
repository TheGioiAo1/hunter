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
| **A** | Foundation + auth core + login flow → admin.huntershop.us login work end-to-end | **🟡 in-progress** | mongo client + 6 auth modules + accounts/login + store-admin middleware |
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

## Phase A acceptance

- [ ] User truy cập `https://admin.huntershop.us` → redirect tới `accounts.huntershop.us/accounts/login`
- [ ] Nhập email + pass đã seed → POST /accounts/login
- [ ] login.ts query Mongo `Gbox-Users.users`, bcrypt verify, insert `sessions`, set cookie
- [ ] Redirect `/accounts/stores` → list shops từ Mongo `Gbox-Shops.shops` (qua `user_shops`)
- [ ] Click vào store → redirect `admin.huntershop.us/admin/store/<id>` → store-admin pod
- [ ] store-admin middleware đọc cookie → validateSession Mongo → load user → render dashboard

## Out of scope Phase A (sẽ throw runtime error nếu touch)

- Tất cả page khác `/accounts/login`, `/accounts/stores`, `/admin/store/<id>` (dashboard root)
- API server `api.huntershop.us` — vẫn CrashLoop vì server.ts dùng Kysely + thiếu `payments/stripe.js`. Login không phụ thuộc api pod nên OK.
- Storefront, checkout, supporter — chưa refactor.
- Bất kỳ business logic page nào (products, orders, themes...).

## Migrate progress

| Date | Phase | Files done | LOC delta | Notes |
|---|---|---|---|---|
| 2026-05-07 | A start | — | — | Plan set, scope measured |
