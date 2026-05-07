# GBOX PLATFORM — PHASE 0 WORKFLOW MINDMAP
## Admin Hierarchy + Security Hardening (Close-the-Loop)

**Date**: 2026-04-11
**Author**: Claude (for Thai Bui review)
**Status**: DRAFT — Cho duyet
**Branch**: `feat/god-admin-2fa-hardening`
**Related**: CLAUDE.md §Rule 1, §Rule 2, §Rule 3

---

## 0. BOI CANH (Context)

Phase 0 KHONG phai greenfield. Tat ca cac module security da built tu
Phase 1-3 (auth, session, sanitize, CSRF, rate-limit, bcrypt, 2FA, admin
hierarchy). Van de la **chung nam roi rac, chua duoc wire vao app boot
paths**. Phase 0 la buoc **"close the loop"** — ghep tat ca lai thanh
mot lop bao ve lien tuc tu HTTP entrypoint → DB.

**Iron Rule 1 nhac lai:** security first, HttpOnly cookies, bcrypt,
CSRF, rate-limit, response scrubbing, rotation on privilege change.

**Iron Rule 2 nhac lai:** 5-level admin hierarchy (Level 0 God Admin →
Level 5 Customer). God Admin tuyet doi khong the bi xoa / demote.

---

## 1. DISCOVERY — CAI GI DA CO, CAI GI CON THIEU

### 1.1 Da co (code nhung chua wired)

```
packages/core/src/modules/
├── auth/
│   ├── bcrypt.ts               ✔  bcrypt 12 salt rounds
│   ├── password-migration.ts   ✔  SHA-256 → bcrypt lazy rehash
│   ├── session.ts              ✔  createSession / deleteAllUserSessions
│   └── rotate-session.ts       ✔  create-before-delete rotation helper
├── security/
│   ├── sanitize.ts             ✔  sanitizeForResponse(obj, options)
│   ├── sanitize-middleware.ts  ✔  Express res.json() wrapper
│   ├── csrf.ts                 ✔  cookie+form double-submit pattern
│   ├── rate-limit.ts           ✔  authLimiter / strictLimiter / pageLimiter
│   ├── headers.ts              ✔  CSP / HSTS / nosniff / framing
│   ├── cors.ts                 ✔  corsConfig + adminCorsConfig
│   ├── scopes.ts               ✔  requireScope + scope tree
│   └── safe-order-by.ts        ✔  whitelist-based ORDER BY
├── customer-auth/
│   └── index.ts                ✔  separate cookie + session
└── two-factor/
    └── index.ts                ✔  TOTP enable/verify/regenerate

packages/db/src/migrations/
├── 002_god_admin.ts            ✔  is_default_admin column
├── 003_seed_god_admin.ts       ✔  buithai3107@gmail.com seed
└── 012_two_factor_auth.ts      ✔  2FA secret + backup codes
```

### 1.2 Cac lo hong phat hien (gaps)

```
 ┌─────────────────────────────────────────────────────────┐
 │  GAP 1 │ [SKIPPED 2026-04-11 theo owner] Chi MOT God    │  —
 │        │ Admin seeded (buithai3107@gmail) — tam du cho  │
 │        │ dev + test. Se them sau khi can thiet.         │
 ├────────┼─────────────────────────────────────────────────┤
 │  GAP 2 │ is_default_admin chi la cot boolean — khong    │ P1
 │        │ co DB trigger ngan chan DELETE / UPDATE demote │
 │        │ → Mot API bug co the xoa God Admin vinh vien   │
 ├────────┼─────────────────────────────────────────────────┤
 │  GAP 3 │ sanitize-middleware ton tai nhung chua mount   │ P1
 │        │ trong 6/6 Express entrypoints                  │
 │        │ → Bat ky res.json() leak nao deu trot lot      │
 ├────────┼─────────────────────────────────────────────────┤
 │  GAP 4 │ Password change / 2FA toggle / role change     │ P1
 │        │ KHONG rotate session token                     │
 │        │ → Session cu van xai duoc sau khi doi mat khau │
 ├────────┼─────────────────────────────────────────────────┤
 │  GAP 5 │ adminCorsConfig ton tai nhung khong mount vao  │ P3
 │        │ god-admin / accounts / store-admin             │
 │        │ → Moi origin co the goi admin API              │
 ├────────┼─────────────────────────────────────────────────┤
 │  GAP 6 │ God Admin password reset route khong kill      │ P2
 │        │ target user sessions                           │
 │        │ → Attacker co the duy tri session sau reset    │
 ├────────┼─────────────────────────────────────────────────┤
 │  GAP 7 │ deleteAllUserSessions khong ho tro "keep       │ P1
 │        │ current token alive" → password change logout  │
 │        │ luon tab dang doi mat khau                     │
 └────────┴─────────────────────────────────────────────────┘
```

---

## 2. WORKFLOW MINDMAP — CAC BUOC PHASE 0

```
                    ┌──────────────────────┐
                    │  PHASE 0 — CLOSE THE │
                    │        LOOP          │
                    └──────────┬───────────┘
                               │
          ┌────────────────────┼────────────────────┐
          │                    │                    │
          ▼                    ▼                    ▼
   ┌─────────────┐      ┌─────────────┐      ┌─────────────┐
   │ STEP 1      │      │ STEP 2      │      │ STEP 3      │
   │ IDENTITY    │      │ RESPONSE    │      │ SESSION     │
   │ (God Admin) │      │ (Sanitize)  │      │ (Rotation)  │
   └──────┬──────┘      └──────┬──────┘      └──────┬──────┘
          │                    │                    │
          │                    │                    │
  ┌───────┴────────┐    ┌──────┴───────┐    ┌───────┴────────┐
  │ 1.1 Seed 2nd   │    │ 2.1 Mount    │    │ 3.1 Extend     │
  │  God Admin     │    │  wrapper in  │    │  deleteAll     │
  │  (thaibq)      │    │  6 servers   │    │  UserSessions  │
  │                │    │              │    │  exceptToken   │
  │ 1.2 DB trigger │    │ 2.2 Add test │    │                │
  │  protect delete│    │  with leaky  │    │ 3.2 Wire into  │
  │                │    │  handler     │    │  postPassword  │
  │ 1.3 DB trigger │    │              │    │                │
  │  protect demote│    │              │    │ 3.3 Wire into  │
  │  (role flip /  │    │              │    │  2FA toggle x3 │
  │  flag flip /   │    │              │    │                │
  │  status=off)   │    │              │    │ 3.4 Wire into  │
  │                │    │              │    │  God Admin     │
  │                │    │              │    │  password reset│
  └────────────────┘    └──────────────┘    └────────────────┘
          │                    │                    │
          └────────────────────┼────────────────────┘
                               │
                               ▼
                      ┌─────────────────┐
                      │ STEP 4          │
                      │ PERIMETER       │
                      │ (CORS + headers)│
                      └────────┬────────┘
                               │
              ┌────────────────┼────────────────┐
              ▼                ▼                ▼
      ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
      │ 4.1 Mount    │ │ 4.2 Mount    │ │ 4.3 Mount    │
      │ adminCors    │ │ adminCors    │ │ adminCors    │
      │ in god-admin │ │ in accounts  │ │ in store-    │
      │              │ │              │ │ admin        │
      └──────────────┘ └──────────────┘ └──────────────┘
                               │
                               ▼
                      ┌─────────────────┐
                      │ STEP 5          │
                      │ VERIFICATION    │
                      └────────┬────────┘
                               │
              ┌────────────────┼────────────────┐
              ▼                ▼                ▼
      ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
      │ 5.1 Core     │ │ 5.2 Storefront│ │ 5.3 Manual   │
      │ 2533 tests   │ │ 21 tests (inc │ │ smoke test   │
      │              │ │ new sanitize) │ │ server-side  │
      └──────────────┘ └──────────────┘ └──────────────┘
```

---

## 3. STEP 1 — GOD ADMIN IDENTITY (Iron Rule 2)

### 3.1 Seed policy (UPDATE 2026-04-11)

**File:** `packages/db/src/migrations/013_god_admin_hardening.ts`

Theo quyet dinh cua owner (2026-04-11) trong giai doan code + test,
migration 013 **KHONG seed God Admin thu hai**. Ly do: chua can God
Admin phu de phat trien, va tranh hardcode password bootstrap trong
migration file.

God Admin duy nhat tu migration 003 (`buithai3107@gmail.com`) van la
default admin. Trigger bao ve se ap dung cho TAT CA row co
`is_default_admin = TRUE`, nen sau nay muon them God Admin phu chi can
insert qua god-admin dashboard → tu dong duoc bao ve.

```
 on migration up():
 ├── CREATE OR REPLACE FUNCTION gbox_protect_default_admin_delete()
 ├── DROP + CREATE TRIGGER trg_protect_default_admin_delete
 ├── CREATE OR REPLACE FUNCTION gbox_protect_default_admin_demote()
 └── DROP + CREATE TRIGGER trg_protect_default_admin_demote
```

### 3.2 Trigger bao ve: DELETE guard

```
CREATE FUNCTION gbox_protect_default_admin_delete():
  IF OLD.is_default_admin = TRUE:
    RAISE EXCEPTION 'cannot delete default admin: % (is_default_admin=TRUE)', OLD.email
  RETURN OLD

CREATE TRIGGER gbox_trg_protect_default_admin_delete
  BEFORE DELETE ON users
  FOR EACH ROW EXECUTE FUNCTION gbox_protect_default_admin_delete()
```

**Kich ban tan cong bi chan:**
- `DELETE FROM users WHERE id='<god-admin-id>'` → `ERROR: cannot delete default admin`
- `DELETE FROM users WHERE is_default_admin = TRUE` → `ERROR` (ngay ca row dau tien)
- Mot SQL injection trong admin route cung khong xoa duoc

### 3.3 Trigger bao ve: DEMOTE guard

```
CREATE FUNCTION gbox_protect_default_admin_demote():
  IF OLD.is_default_admin = TRUE:
    IF NEW.is_default_admin = FALSE:
      RAISE EXCEPTION 'cannot clear is_default_admin on %', OLD.email
    IF NEW.role <> 'owner':
      RAISE EXCEPTION 'cannot demote default admin %: role must stay owner', OLD.email
    IF NEW.status <> 'active':
      RAISE EXCEPTION 'cannot deactivate default admin %', OLD.email
  RETURN NEW

CREATE TRIGGER gbox_trg_protect_default_admin_demote
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION gbox_protect_default_admin_demote()
```

**Kich ban tan cong bi chan:**
- God Admin bi suspend → `ERROR`
- God Admin bi doi role thanh 'staff' → `ERROR`
- is_default_admin flag bi clear qua ORM update → `ERROR`
- God Admin van co the doi: email, password_hash, name, 2FA → OK

### 3.4 Down migration

```
 on migration down():
 ├── DROP TRIGGER gbox_trg_protect_default_admin_demote ON users
 ├── DROP TRIGGER gbox_trg_protect_default_admin_delete ON users
 ├── DROP FUNCTION gbox_protect_default_admin_demote()
 ├── DROP FUNCTION gbox_protect_default_admin_delete()
 └── (KHONG xoa seeded row — data loss hazard)
```

---

## 4. STEP 2 — RESPONSE SANITIZE (Iron Rule 1: strip sensitive fields)

### 4.1 Global mount pattern

```
 Request → Express
   │
   ├── trust proxy / disable x-powered-by
   ├── performanceMiddleware()
   ├── requestLogger()
   ├── <appName>SecurityHeaders  ← CSP / HSTS
   ├── corsConfig / adminCorsConfig  ← STEP 4
   ├── cookieParser()
   ├── express.urlencoded({limit})
   ├── express.json({limit})         (skipped for checkout)
   │
   ├── sanitizeResponseMiddleware() ←── MOI: wrap res.json()
   │     │
   │     └── Kich hoat scrub tren moi res.json() call:
   │         - password_hash, password
   │         - session_token, csrf_secret
   │         - api_key, secret, private_key
   │         - internal_* fields
   │
   ├── rate limiters (authLimiter / pageLimiter / ...)
   └── route handlers
```

### 4.2 Wiring checklist (6 servers)

```
 [✔] apps/god-admin/src/server.ts
 [✔] apps/accounts/src/server.ts
 [✔] apps/store-admin/src/server.ts
 [✔] apps/storefront/src/app.ts
 [✔] apps/checkout/src/server.ts
 [✔] server.ts (root monolith / smoke harness)
```

### 4.3 Integration test pattern

```
 apps/storefront/src/app.test.ts
   describe 'buildApp sanitize middleware (Phase 0 close-the-loop)':
     - buildApp({ healthHandler: (_req, res) => res.json({
         status: 'ok',
         user: { id, email, password_hash: '<leak>', session_token: '<leak>' },
         api_key: '<leak>',
       }) })
     - GET /_health
     - Assert body.user.password_hash === undefined
     - Assert body.user.session_token === undefined
     - Assert body.api_key === undefined
     - Assert body.status === 'ok'           (safe field survives)
     - Assert body.user.id / email survive
```

---

## 5. STEP 3 — SESSION ROTATION ON PRIVILEGE CHANGE

### 5.1 Extend `deleteAllUserSessions` signature

```
 // packages/core/src/modules/auth/session.ts
 export async function deleteAllUserSessions(
   db: Kysely<any>,
   userId: string,
   exceptToken?: string,  ← NEW
 ): Promise<number>

 Implementation:
   let q = db.deleteFrom('sessions').where('user_id', '=', userId)
   if (exceptToken) q = q.where('token_hash', '!=', hashToken(exceptToken))
   return numDeletedRows
```

### 5.2 Wire points (5 handlers)

```
 ┌─────────────────────────────┬──────────────────────────┐
 │ Handler                     │ Action                   │
 ├─────────────────────────────┼──────────────────────────┤
 │ apps/accounts               │ rotateSession(old, user) │
 │  postPassword               │ → mint new token         │
 │                             │ → Set-Cookie (fresh)     │
 │                             │ → deleteAllUserSessions  │
 │                             │   (except new)           │
 ├─────────────────────────────┼──────────────────────────┤
 │ apps/god-admin              │ same (helper:            │
 │  settings-2fa Enable        │  rotateAfter2FAChange)   │
 │  settings-2fa Disable       │                          │
 │  settings-2fa Regenerate    │                          │
 ├─────────────────────────────┼──────────────────────────┤
 │ apps/god-admin              │ deleteAllUserSessions    │
 │  users postResetPassword    │ (target, no except)      │
 │                             │ + audit log              │
 │                             │   sessions_revoked: N    │
 └─────────────────────────────┴──────────────────────────┘
```

### 5.3 Flow chart — password change with rotation

```
 POST /settings/password
   │
   ├── validate csrf
   ├── verifyBcrypt(currentPassword, user.password_hash)
   ├── user.password_hash = await bcrypt.hash(newPassword)
   ├── UPDATE users SET password_hash = ?
   │
   ├── fresh = await rotateSession({
   │     oldToken,
   │     userId,
   │     meta: { ip, ua },
   │   }, { createSession, deleteSession })
   │
   ├── await deleteAllUserSessions(db, userId, fresh.token)
   │     ← kill moi session CU khac,
   │       giu lai fresh session de user khong bi kick
   │
   ├── res.setHeader('Set-Cookie',
   │     serializeSessionCookie(fresh.token, getSessionCookieOptions()))
   │
   └── 302 /settings?ok=1
```

### 5.4 Kich ban tan cong bi chan

```
 t=0  Attacker steal session cookie A (eavesdrop)
 t=1  User notice → doi mat khau
 t=2  rotateSession mint token B
 t=3  deleteAllUserSessions(user, exceptB) → kill A khoi DB
 t=4  Attacker thu GET /admin voi cookie A
       │
       └── session lookup by hash(A) → NULL → 401
 t=5  User van online voi cookie B → OK
```

---

## 6. STEP 4 — CORS PERIMETER (Iron Rule 1)

```
 corsConfig         → public API (storefront, checkout)
 adminCorsConfig    → admin panels (whitelist *.gbox.co)

 Mount order:
   securityHeaders → adminCorsConfig → bodyParsers → sanitize → rate-limit → routes

 Hau qua: browser ngoai *.gbox.co khong goi duoc
          /god-admin/api, /accounts/api, /admin/api
```

Checklist:
```
 [✔] apps/god-admin/src/server.ts    (adminCorsConfig)
 [✔] apps/accounts/src/server.ts     (adminCorsConfig)
 [✔] apps/store-admin/src/server.ts  (adminCorsConfig)
 [ ] apps/checkout                   (N/A — HTML-only, khong expose JSON API)
 [ ] apps/storefront                 (corsConfig already mounted truoc do)
```

---

## 7. STEP 5 — VERIFICATION

```
 ┌──────────────────────────┬──────────┬──────────────────────┐
 │ Suite                    │ Result   │ Notes                │
 ├──────────────────────────┼──────────┼──────────────────────┤
 │ packages/core            │ 2533 ✔   │ 7 skipped (Windows   │
 │                          │          │  symlink EPERM)      │
 │ apps/storefront app.test │ 21 ✔     │ +1 new sanitize test │
 │ apps/storefront          │ 14 fail  │ PRE-EXISTING; not    │
 │  (app.integration +      │          │  caused by Phase 0   │
 │   tracking)              │          │  (verified via stash)│
 │ packages/core typecheck  │ clean    │                      │
 │ apps/god-admin           │ n/a      │ No *.test.ts files   │
 │ apps/accounts            │ n/a      │ No *.test.ts files   │
 │ apps/store-admin         │ n/a      │ No *.test.ts files   │
 │ packages/db              │ n/a      │ No unit tests (needs │
 │                          │          │  live Postgres per   │
 │                          │          │  memory/smoke_test_  │
 │                          │          │  runbook.md)         │
 └──────────────────────────┴──────────┴──────────────────────┘
```

**Manual smoke test (to run on server 2 — bo localhost khong reach PG):**

```
 1. Run migration:
    $ pnpm db:migrate
    → expect: "013_god_admin_hardening completed"

 2. Verify seed:
    $ psql -c "SELECT email, role, is_default_admin FROM users
               WHERE is_default_admin = TRUE"
    → expect 2 rows:
        buithai3107@gmail.com | owner | t
        thaibq@gbox.co        | owner | t

 3. Try delete (must fail):
    $ psql -c "DELETE FROM users WHERE email='thaibq@gbox.co'"
    → expect: ERROR: cannot delete default admin: thaibq@gbox.co

 4. Try demote (must fail):
    $ psql -c "UPDATE users SET role='staff' WHERE email='thaibq@gbox.co'"
    → expect: ERROR: cannot demote default admin

 5. Try clear flag (must fail):
    $ psql -c "UPDATE users SET is_default_admin=FALSE
               WHERE email='thaibq@gbox.co'"
    → expect: ERROR: cannot clear is_default_admin

 6. Login as thaibq@gbox.co with password 'Thaimui@99'
    → should succeed, session cookie issued

 7. Change password via /settings/password:
    → observe rotation: new cookie issued,
       old session gone from `sessions` table

 8. Log API response leak test:
    $ curl -s https://api.gbox.co/admin/users/me | jq .
    → expect: NO password_hash, NO session_token field
```

---

## 8. OUT OF SCOPE (defer sang phase sau)

### 8.A Deferred items landed in Phase 0.7 (this close-out pass)

All four high-priority deferred items were pulled forward so Phase 0
ships a security-complete admin hierarchy. Status below — each item
has landed on `feat/god-admin-2fa-hardening` and is deployed to
server 1.

```
 [x] Item #3  2FA enforcement for Level 0/1/2/3 admins
     - Signup sets users.two_fa_required=true for role in
       ('admin','owner') when ENFORCE_2FA_FOR_ADMINS=1.
     - accounts /accounts/login/2fa challenge page owns the TOTP step.
     - god-auth, store-auth and session-auth middlewares bounce any
       session with two_fa_verified=false to the challenge page.
     - Commit: ca6004c feat(accounts): enforce 2FA for admins

 [x] Item #6  Audit log retention + CSV export
     - packages/core/src/modules/audit/retention.ts — batched
       CTID-based DELETE (1000 rows/batch, 50ms sleep) for
       long-lock avoidance.
     - packages/core/src/modules/audit/export.ts — RFC 4180 CSV
       escape + 10k-row hard cap + join to users/shops.
     - scripts/cron/prune-audit-logs.ts — daily systemd/pm2 cron,
       JSON report line for monitoring harness, also clears
       expired webhook-secret.previous rows.
     - god-admin /security?export=csv emits signed download, logs
       audit_log_exported audit entry.
     - Commit: 1dff18c feat(audit): retention prune + CSV export

 [x] Item #2  Webhook signing rotation with grace window
     - packages/core/src/modules/webhooks/hmac.ts — new
       getShopWebhookSecretBundle, rotateShopWebhookSecret,
       clearExpiredPreviousSecrets.
     - Outbound deliveries (and retries) carry dual
       X-Gbox-Hmac-SHA256 + X-Gbox-Hmac-SHA256-Previous headers
       during the 7-day grace window.
     - scripts/ops/rotate-webhook-secret.ts — CLI that rotates a
       shop's secret, prints the new value ONCE, writes a
       webhook_secret_rotated audit entry.
     - End-to-end verified on my-test-store (shop_id
       63654394-fa4d-4316-8dbf-bdecb5afaefb) — two rotations, both
       audit entries + shop_settings rows present.
     - Commit: 67ffad6 feat(webhooks): signing secret rotation

 [x] Item #4  Per-admin IP allowlist
     - migration 016 — users.ip_allowlist jsonb, nullable.
     - packages/core/src/modules/auth/ip-allowlist.ts — pure
       CIDR matcher (IPv4 + IPv6), 25 unit tests, no external dep.
     - Enforcement wired into god-auth, store-auth, session-auth
       middlewares AFTER the 2FA gate; fails closed on invalid
       CIDRs so ops can't accidentally hide a broken list.
     - god-admin /settings/ip-allowlist page with textarea editor,
       live "your current IP" display, self-lockout guard and
       ip_allowlist_updated audit trail.
     - Nav + command-palette entry under H. Security.
     - Commit: 936f279 feat(auth): per-admin IP allowlist
       + 24aeeed fix(migration): idempotent 016
```

### 8.B Still deferred past Phase 0

```
 - Customer auth parity (customer sessions khong rotate on password
   change yet) — will be part of Phase 3G customer account polish
 - Hardware key (WebAuthn) for God Admin — Phase 2 Admin Polish
 - Per-shop (rather than per-user) IP allowlist for merchants
 - Rate-limit tuning for the new admin endpoints under load
```

---

## 9. OWNER REVIEW CHECKLIST (Rule 3)

```
 [ ] Thai xem mindmap, bo sung / chinh sua
 [ ] Thai duyet password 'Thaimui@99' cho thaibq@gbox.co
     (hoac doi thanh password khac truoc khi migrate)
 [ ] Thai duyet placement: docs/superpowers/specs/  ← dang o day
 [ ] Thai duyet git commit + push len GBox-Company remote
 [ ] Thai chay migration 013 tren server 2 (truy cap duoc PG)
 [ ] Thai verify manual smoke test 1-8 o §7
```

---

## 10. FILES TOUCHED (toan bo Phase 0 close-the-loop)

```
 CREATED (Phase 0 initial close-the-loop):
   packages/db/src/migrations/013_god_admin_hardening.ts
   docs/superpowers/specs/2026-04-11-phase-0-admin-hierarchy-security-mindmap.md

 CREATED (Phase 0.7 deferred-item sweep — §8.A):
   packages/core/src/modules/audit/retention.ts
   packages/core/src/modules/audit/export.ts
   packages/core/src/modules/audit/index.ts
   packages/core/src/modules/auth/ip-allowlist.ts
   packages/core/src/modules/auth/ip-allowlist.test.ts
   packages/db/src/migrations/016_admin_ip_allowlist.ts
   apps/god-admin/src/pages/settings-ip-allowlist.ts
   scripts/cron/prune-audit-logs.ts
   scripts/ops/rotate-webhook-secret.ts

 MODIFIED:
   packages/db/src/migrations/run.ts              (register 013, 016)
   packages/db/src/schema/tables.ts               (ip_allowlist column type)
   packages/core/src/modules/security/index.ts    (export sanitize wrapper)
   packages/core/src/modules/auth/session.ts      (exceptToken param)
   packages/core/src/modules/webhooks/hmac.ts     (rotation bundle + grace)
   packages/core/src/modules/webhooks/service.ts  (dual-header signing)
   apps/god-admin/src/server.ts                   (cors + sanitize + ip-allowlist routes)
   apps/god-admin/src/layouts/god-layout.ts       (nav + command palette)
   apps/god-admin/src/middleware/god-auth.ts      (2FA + IP allowlist gates)
   apps/god-admin/src/pages/security.ts           (CSV export + date filters)
   apps/accounts/src/server.ts                    (cors + sanitize)
   apps/accounts/src/pages/login-2fa.ts           (admin 2FA challenge)
   apps/store-admin/src/server.ts                 (cors + sanitize)
   apps/store-admin/src/middleware/store-auth.ts  (2FA + IP allowlist gates)
   apps/store-admin/src/middleware/session-auth.ts(2FA + IP allowlist gates)
   apps/storefront/src/app.ts                     (sanitize)
   apps/checkout/src/server.ts                    (sanitize)
   server.ts                                      (sanitize, monolith)
   apps/accounts/src/pages/account-settings.ts    (rotate on password change)
   apps/god-admin/src/pages/settings-2fa.ts       (rotate on 2FA change x3)
   apps/god-admin/src/pages/users.ts              (kill sessions on admin reset)
   apps/storefront/src/app.test.ts                (new sanitize integration test)
```

---

## 11. CROSS-REFERENCES

- **Iron Rules:** CLAUDE.md §Rule 1, §Rule 2, §Rule 3
- **Master plan:** docs/superpowers/specs/2026-04-06-gbox-complete-platform-masterplan.md
- **Merchant journey:** docs/superpowers/specs/2026-04-06-merchant-journey-detailed.md
- **Infra:** memory/infra_topology.md (3-server layout, ports, creds)
- **Smoke runbook:** memory/smoke_test_runbook.md (local box cannot reach PG)
- **Windows test skips:** memory/vitest_windows_symlinks.md
