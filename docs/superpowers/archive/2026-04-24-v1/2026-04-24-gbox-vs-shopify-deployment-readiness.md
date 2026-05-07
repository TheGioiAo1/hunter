# GBOX PLATFORM vs SHOPIFY — PHÂN TÍCH TOÀN DIỆN + DEPLOYMENT READINESS

**Ngày:** 2026-04-24 (v3 — scope locked after 2 owner reviews)
**Scope:** Audit + Gap Analysis + Module Mindmap + Roadmap tới Oct 2026
**Business Model:** Sellers tại Vietnam & Bangladesh bán **CROSS-BORDER** cho customers tại **US** (Phase 15-19 focus)
**Target Customers:** Mid-market + SMB POD + Dropship sellers (VN/BD base, bán US; EU/UK/Canada defer)
**Goods flow:** VN/BD origin → Lenful fulfillment + third-party logistics agent → US destination
**Payment flow:** Customer (US) pays USD → **PayPal (default) / Stripe / Airwallex** → Merchant (VN/BD) receives USD
**Hard Blockers:** Security (MUST) + 3 gateways prod-hardening (MUST) + Fraud engine (MUST) + Data integrity (MUST)
**Phương pháp:** Audit trước (tìm risks), Roadmap sau (remediation plan)

> **⚠️ SCOPE LOCK (owner directive 2026-04-24, v3 clarification):**
> - **Market:** US only. EU/UK/Canada DEFER Phase 20+ (IOSS, UK VAT, CA GST gác lại)
> - **Payments:** **PayPal priority 100%** (có BN code `Gbox_Ecom`, app đã partner — default on new shop; biggest button on checkout). **Stripe + Airwallex tích hợp HOÀN CHỈNH** (prod-hardened full: 3DS + Radar/fraud + disputes + payouts + settlement reporting) để **sellers có quyền lựa chọn gateway**. Gbox không lock sellers vào 1 provider. **Không** Apple Pay / Google Pay / Klarna / Afterpay / Amazon Pay (customer-facing methods) trong scope Phase 15-19
> - **Fulfillment:** Lenful-only (công ty của owner, POD + sourcing + logistics agent). **Không** thêm Printful / Printify / Gelato / CustomCat / CJ Dropshipping
> - **Shipping:** Label PDF cấp bởi agent bên thứ 3 → Gbox attach + print. **Không** tự tích hợp USPS/UPS/FedEx/DHL live APIs (defer Phase 20+)
> - **Tax:** US sales tax nexus only (10-15 states). **Không** EU VAT / UK VAT / IOSS / Canada GST trong scope
> - **Customs:** HS codes + Commercial Invoice PDF (text fields + PDF gen, không live API)
> - **NEW: Importer tool** (AliExpress + 1688 + Taobao + Shopee + Temu) — cross-border dropship sellers cần import products từ Chinese + SEA marketplaces
>
> **Gateway strategy nuance:** "PayPal 100% priority" áp dụng cho **default ordering + UI prominence + onboarding setup wizard** (sellers mới mặc định dùng PayPal). "Stripe + Airwallex tích hợp hoàn chỉnh" áp dụng cho **code quality + feature parity with PayPal** để sellers có option switch-over. Cả 3 gateways prod-ready, chỉ khác nhau về UX prominence.

---

## 🎯 EXECUTIVE SUMMARY — TRUNG THỰC, KHÔNG GIẤU DIẾM

### Verdict ngắn gọn

**Gbox Platform đạt ~72% feature parity với Shopify.** Sau scope lock của owner, **chỉ ~35% còn lại là blocker** cho target US-only + Lenful + PayPal-first. Có thể launch **beta đóng** (3-5 seller thân thiện) trong **4-6 tuần** nếu ship với gaps đã biết. **Launch công khai** cần **5-6 tháng** vá: (1) PayPal prod hardening, (2) fraud engine full, (3) Lenful-native fulfillment, (4) HS codes + Commercial Invoice, (5) US sales tax nexus, (6) multi-platform importer tool, (7) 5 risks data integrity.

### Top 5 điểm Gbox VƯỢT Shopify

1. **Email system** — 97 templates (Shopify: ~50), forced-send categories, unsubscribe tokens SHA-256 hashed, Iron Rule 5 chokepoint (no god-admin leaks)
2. **Support ticketing** — Phase 12.5 full system (CSAT, SLA, canned replies, quiet hours), Shopify Inbox chỉ là chat bề mặt
3. **Liquid theme engine** — 987+ unit tests, Shopify Liquid-compatible, handle edge cases Shopify's Ruby Liquid không dùng
4. **Admin RBAC** — 25-entry permission catalog + 4 role templates + per-member overrides, Shopify dùng preset roles
5. **Clone Pro v4** — Autonomous site cloning ~50% complete, Shopify không có tương đương

### Top 10 GAP LỚN so với Shopify — SCOPED cho US market + Lenful + PayPal (2026-04-24 LOCKED)

> **📌 Scope lock sau 2 rounds review của owner (v3):** Phase 15-19 focus **US market only** (EU/UK/Canada defer), **PayPal priority default + Stripe FULL + Airwallex FULL** (seller choice, tất cả 3 gateways tích hợp hoàn chỉnh), **Lenful-only fulfillment** (không thêm POD vendor), **label print + live carrier rates DEFERRED** (Lenful lo sourcing + agent logistics).

1. **❌ 3 gateways prod-hardened (PayPal priority + Stripe FULL + Airwallex FULL)** — PayPal có BN code `Gbox_Ecom` làm default nhưng chưa prod-verified. Stripe + Airwallex cần tích hợp hoàn chỉnh (Payment Intents + SCA/3DS + Radar/fraud + Disputes + Payouts + Settlement) cho seller choice. Gateway switcher UI + per-shop encrypted credentials.
2. **❌ Fraud detection engine (FULL, không phải shell)** — Cross-border orders chargebacks cao, cần: velocity rules + BIN check + device fingerprint + blacklist + manual review queue + auto-hold cho orders score ≥ threshold
3. **❌ Multi-currency product display** — Customer ở US thấy giá VND sẽ drop off → cần show USD default + currency picker, seller quản lý giá VND nội bộ
4. **❌ HS codes + Commercial Invoice PDF** — Product table thiếu field `hs_code` + `country_of_origin`, không có PDF gen → US CBP reject hoặc hold package
5. **❌ US sales tax nexus engine** — Stub catalog có, nhưng thiếu auto-detect nexus threshold per state (Wayfair 2018 rules), marketplace facilitator flag, tax calculation tại checkout cho 10-15 major states
6. **❌ Lenful-native fulfillment** — Order → Lenful API hiện manual, cần: auto-push order, sync production status, pull tracking, handle cancel/refund round-trip
7. **❌ Product importer multi-platform** (AliExpress, 1688, Taobao, Shopee, Temu) — Cross-border dropship sellers cần công cụ import sản phẩm từ nguồn Trung Quốc + SEA marketplaces → copy title/desc/images/variants + markup rules + currency convert
8. **❌ Customer 2FA + account security** — Chỉ staff có TOTP, customer chưa. High-value US accounts dễ bị takeover → cần customer TOTP + email OTP fallback + device trust list
9. **❌ Webhook idempotency + reconciliation** — PayPal/Stripe webhooks không có explicit `idempotency_key` column → risk duplicate charges + double-fulfillment. Cần idempotent handler + nightly reconciliation job
10. **❌ Data integrity hardening** — No PostgreSQL Row-Level Security, no explicit transaction isolation level trong checkout, no automated backup → 3 landmines lớn cho production

### GÁC LẠI — Phase 20+ (sau Oct 2026 launch)

- 🔵 **International shipping label APIs** (USPS/UPS/FedEx/DHL direct) — Phase 15-19 dùng flow "agent cấp PDF → Gbox attach"
- 🔵 **Real-time carrier rates** (USPS/UPS/FedEx/DHL live API) — Lenful + agent logistics lo, Gbox show flat rates
- 🔵 **EU market** (IOSS + UK VAT + Canada GST/PST) — defer until EU strategic decision
- 🔵 **Apple Pay / Google Pay / Klarna / Afterpay / Amazon Pay** — 3 gateways (PayPal + Stripe + Airwallex) đủ cho Phase 15-19 MVP
- 🔵 **POD vendor khác** (Printful / Printify / Gelato / CustomCat) — Lenful-only per owner directive

### Top 5 RISK NGHIÊM TRỌNG

1. **🚨 Multi-tenant isolation** — Application-layer only, KHÔNG có PostgreSQL Row-Level Security → risk data leak nếu bug trong query
2. **🚨 Transaction isolation** — Không specify `isolationLevel` trong checkout → risk race condition khi oversell inventory
3. **🚨 No automated backup** — Không tìm thấy backup/restore script → risk data loss nếu DB crash
4. **🚨 Customer 2FA** — Chỉ staff có, customer không → account takeover risk cho high-value accounts (US customers nhạy cảm)
5. **🚨 Webhook idempotency** — PayPal/Stripe webhooks không có explicit `idempotency_key` column → risk duplicate charges (cross-border chargebacks càng đắt)

---

## 🗺 PHẦN 1: MINDMAP CHI TIẾT TOÀN BỘ GBOX PLATFORM

Mindmap được tổ chức theo **12 nhánh lớn** (like the reference image), mỗi nhánh có sub-branches chi tiết.

```
                    ┌──────────────────────────────────────────┐
                    │          GBOX PLATFORM v4                │
                    │     (EmDash CMS + TypeScript + PG)        │
                    │    77 modules • 89 migrations • 14 phases│
                    └──────────────────────────────────────────┘
                                       │
        ┌──────────┬──────────┬────────┼────────┬──────────┬──────────┐
        │          │          │        │        │          │          │
     🔐 AUTH   📊 DATA    🛒 COMMERCE 📣 MARKETING 💬 SUPPORT 🎨 STOREFRONT
    & SECURITY & STORAGE                                        & THEMES
```

### NHÁNH 1: 🔐 AUTH & SECURITY (10 modules)

```
🔐 AUTH & SECURITY
│
├─ 👤 Customer Auth
│  ├─ Email/Password (bcrypt, SHA-256 migration path)
│  ├─ Passkey/WebAuthn (FIDO2)
│  ├─ Google OAuth (OIDC, token AES-256-GCM encrypted)
│  ├─ Magic Link (email-based)
│  └─ ❌ 2FA — KHÔNG CÓ cho customer
│
├─ 🔑 Staff/Admin Auth
│  ├─ TOTP 2FA (RFC 6238, 30-sec step, ±1 skew)
│  ├─ Email OTP
│  ├─ Backup codes
│  ├─ Passkey/WebAuthn
│  ├─ IP Allowlist (CIDR IPv4/IPv6, god-admin only)
│  └─ Forced 2FA cho god-admin (Phase 0.6)
│
├─ 🛡 Session Management
│  ├─ Token: 32 bytes (256 bits) hex-encoded
│  ├─ Storage: PG sessions + Redis cache
│  ├─ TTL: 30-day sliding (extend <24h)
│  ├─ Cookie: HttpOnly + Secure + SameSite=Lax
│  ├─ Rotate-on-privilege-change middleware
│  └─ Domain-scoped (SESSION_COOKIE_DOMAIN env)
│
├─ 🚫 Rate Limiting
│  ├─ 5 attempts/min/IP on auth endpoints
│  ├─ 5-min lockout sau 5 failures
│  ├─ Cap 60 tries/hour/IP
│  └─ Redis-backed với in-memory fallback
│
├─ 🔐 CSRF Protection
│  ├─ One-time token pattern
│  ├─ Timing-safe comparison (crypto.timingSafeEqual)
│  ├─ Redis/in-memory storage với TTL
│  └─ Issue on GET, verify+burn on POST
│
├─ 🔒 Encryption at Rest
│  ├─ Passwords: bcrypt (12 rounds, salt unique)
│  ├─ OAuth tokens: AES-256-GCM (oauth_accounts)
│  ├─ Unsubscribe tokens: SHA-256 hashed
│  ├─ Staff device fingerprints: SHA-256
│  └─ Session tokens: random 32-byte hex
│
├─ 📋 Audit Logging
│  ├─ Retention: 365 days (configurable)
│  ├─ Events: login_success, login_failure, 2fa_verified, logout, permission_change
│  ├─ Background cleanup (1k rows/batch, sleep between)
│  ├─ Export to zip (SHA-256 token, 24h download TTL)
│  └─ IP + device + user-agent tracked
│
├─ 🚪 Admin Hierarchy (8 levels)
│  ├─ L0: God Admin (buithai3107@gmail.com / thaibq@gbox.co)
│  ├─ L1: Platform Admin
│  ├─ L3: Support L3-L5
│  ├─ L2: Store Owner (Merchant)
│  ├─ L3: Store Admin
│  ├─ L4: Store Staff (permissions-based)
│  └─ L5: Customer
│
├─ 🔑 API Access
│  ├─ Session-based authentication
│  ├─ ❌ Per-shop API keys — KHÔNG CÓ
│  ├─ ❌ OAuth scopes — KHÔNG CÓ
│  └─ ❌ Token rotation UI — KHÔNG CÓ
│
└─ 🛡 Seller-Safe Error Handling (Iron Rule 5)
   ├─ NEVER expose "god admin" / "/god-admin/*" to sellers
   ├─ Generic error: "Please contact Gbox support"
   ├─ Server-side logging (pino/audit) for platform team
   └─ Lint checks catch leak attempts (HTML comments, etc.)
```

**Status:** 🟢 Mạnh hơn Shopify ở RBAC + Iron Rule 5 chokepoint. ⚠️ Gaps: Customer 2FA, API keys, OAuth scopes.

---

### NHÁNH 2: 📊 DATA & STORAGE (7 modules)

```
📊 DATA & STORAGE
│
├─ 🗄 PostgreSQL 14+ Database
│  ├─ Schema-first với Kysely ORM
│  ├─ 89 migrations (001-089)
│  ├─ Triggers: updated_at auto, referential integrity
│  └─ Constraints: FK, UNIQUE partial indexes, CHECK
│
├─ 🔢 Migration Ledger
│  ├─ File-based migrations: packages/db/src/migrations/NNN_*.ts
│  ├─ Drift detector: compare disk vs registry array
│  ├─ Checks: missing registrations, orphans, imports-not-in-array
│  ├─ Allowlist: 053-056 cluster (9 files, explicitly accepted)
│  └─ CI gate: fails if drift detected
│
├─ 🔐 Multi-Tenant Isolation
│  ├─ Application-layer: every query filters by shop_id
│  ├─ ❌ PostgreSQL RLS: KHÔNG CÓ policies
│  ├─ ⚠️ Risk: bug trong query = data leak cross-tenant
│  └─ Mitigation: unit tests + code review required
│
├─ 🔄 Transaction Management
│  ├─ Kysely db.transaction() pattern
│  ├─ ❌ Isolation level: KHÔNG SPECIFY (default READ_COMMITTED)
│  ├─ ⚠️ Checkout/orders: risk race condition oversell
│  └─ Shopify dùng SERIALIZABLE cho critical flows
│
├─ 🔁 Idempotency
│  ├─ Automation flows: idempotency keys (abandoned_cart:ORDER_ID)
│  ├─ ❌ Webhook idempotency_key column: KHÔNG CÓ
│  ├─ ⚠️ PayPal/Stripe webhooks: dedup via row uniqueness only
│  └─ Shopify dùng Idempotency-Key header pattern
│
├─ 🗑 Deletion & GDPR
│  ├─ Soft delete: deleted_at + deleted_by_user_id
│  ├─ GDPR right-to-erasure: customer_privacy_requests table
│  ├─ Deletion finalizer: customers.email = NULL (keep lower for audit)
│  ├─ Data export: zip + SHA-256(token), 24h download TTL
│  └─ Consent tracking: migration 088
│
├─ 📦 Backup & Restore
│  ├─ ❌ Automated backup script: KHÔNG TÌM THẤY
│  ├─ ❌ Point-in-time restore procedure: KHÔNG CÓ doc
│  ├─ ⚠️ Infrastructure-layer concern (VPS-level)
│  └─ Shopify: daily snapshots + PITR guaranteed
│
└─ 📈 Cache Layer
   ├─ Redis: checkout sessions, cart, auth
   ├─ LRU in-memory: R2-aware fallback
   ├─ Cloudflare KV: edge caching
   └─ Graceful degradation: Redis-absent mode (checkoutFallbackStore)
```

**Status:** 🟡 Trung bình. ⚠️ Critical gaps: RLS, isolation levels, webhook idempotency, automated backups.

---

### NHÁNH 3: 💳 PAYMENTS (7 modules, but mostly incomplete)

```
💳 PAYMENTS
│
├─ 🅿 PayPal Partner (COMPLETE)
│  ├─ On-behalf-of flow (money never touches Gbox)
│  ├─ PPCP Commerce Platform SDK
│  ├─ Order: create, capture, refund (partial + full)
│  ├─ Venmo support (US)
│  ├─ Webhook verify: signature validation + event handler
│  ├─ Routing rules: per-shop config
│  ├─ Tracking sync: carrier data back to PayPal
│  ├─ BN code: Gbox_Ecom (hardcoded)
│  └─ Credentials: encrypted per-shop
│
├─ 💳 Stripe (FULL INTEGRATION — seller choice parity)
│  ├─ ⚠️ Phase 16 Track D PR11: prod keys per-shop + webhook idempotency + signature verification
│  ├─ ⚠️ Phase 16 Track D PR12: Payment Intents + SCA/3DS automatic for EEA cards
│  ├─ ⚠️ Phase 16 Track D PR13: refund + partial (admin UI matches PayPal UX)
│  ├─ ⚠️ Phase 16 Track D PR14: Stripe Radar (fraud) merge với Gbox engine
│  ├─ ⚠️ Phase 16 Track D PR15: Disputes API + auto-evidence (parity PayPal PR4)
│  ├─ ⚠️ Phase 16 Track D PR16: Balance Transactions payout/settlement reporting
│  └─ 🔵 Stripe Connect (platform/marketplace) — DEFERRED Phase 20+
│
├─ 🌏 Airwallex (FULL INTEGRATION — seller choice parity, merchant receiving)
│  ├─ ⚠️ Phase 16 Track E PR17: merchant KYC + account create + sandbox→prod promotion
│  ├─ ⚠️ Phase 16 Track E PR18: collect flow (customer pays USD) + hosted checkout + 3DS
│  ├─ ⚠️ Phase 16 Track E PR19: pay flow (USD→VND/BDT bank) + beneficiary + Payouts API
│  ├─ ⚠️ Phase 16 Track E PR20: multi-currency wallet (USD/VND/BDT balances + transfer)
│  ├─ ⚠️ Phase 16 Track E PR21: dispute handling + evidence upload + auto-reply
│  ├─ ⚠️ Phase 16 Track E PR22: daily statement API + settlement reporting
│  ├─ ⚠️ Phase 16 Track E PR23: FX rates + 24h spot-rate lock (predictable settlement)
│  └─ 🔵 Payoneer / Wise Business DEFERRED Phase 20+ (Airwallex covers VN/BD)
│
├─ 🎛️ Gateway Switcher + Multi-gateway Checkout (NEW v3 — seller choice)
│  ├─ ⚠️ Phase 16 Track F PR24: admin UI gateway selection (PayPal pre-checked default)
│  ├─ ⚠️ Phase 16 Track F PR25: per-shop encrypted credentials (AES-256-GCM matches OAuth crypto)
│  ├─ ⚠️ Phase 16 Track F PR26: fallback logic (primary fails → secondary retry)
│  └─ ⚠️ Phase 16 Track F PR27: multi-gateway checkout UI (PayPal biggest button + tabbed alternatives)
│
├─ 💳 Customer-facing Payment Methods (US focus per owner directive)
│  ├─ ⚠️ PayPal Checkout (Smart Buttons) — Phase 16 Track A PR1 prod hardening + biggest button
│  ├─ ⚠️ PayPal Pay via Card (Advanced Checkout) — Phase 16 Track A PR2 (US buyers không có PP)
│  ├─ ⚠️ Stripe card (SCA/3DS) — Phase 16 Track D PR12 (full parity)
│  ├─ ⚠️ Airwallex card — Phase 16 Track E PR18 (full parity)
│  ├─ 🔵 Apple Pay — DEFERRED Phase 20+ (3 gateways đủ MVP)
│  ├─ 🔵 Google Pay — DEFERRED Phase 20+
│  ├─ 🔵 Klarna BNPL — DEFERRED (PayPal Pay-in-4 covers)
│  ├─ 🔵 Afterpay BNPL — DEFERRED Phase 20+
│  ├─ 🔵 Amazon Pay — DEFERRED Phase 20+
│  └─ ❌ Shop Pay (Shopify) — N/A (Gbox không có equivalent)
│
├─ ❌ Local payment methods VN/BD — KHÔNG CẦN THIẾT
│  └─ (Gbox serves cross-border sellers, customers ở US không dùng VNPay/Momo/bKash)
│
├─ 🔐 PCI Compliance
│  ├─ Gbox never handles card data (delegated to PayPal/Stripe/Airwallex hosted fields)
│  ├─ ⚠️ 3DS/SCA: PayPal native + Stripe automatic + Airwallex hosted (Phase 16 all 3 tracks)
│  └─ Legal pass-through design (SAQ-A eligible across all 3 gateways)
│
├─ 🚨 Fraud Engine (FULL per owner directive, multi-gateway signal aggregation)
│  ├─ ⚠️ Velocity rules — Phase 16 Track B PR6 (card/IP/email windows)
│  ├─ ⚠️ BIN lookup + geo mismatch — Phase 16 Track B PR6
│  ├─ ⚠️ Device fingerprint — Phase 16 Track B PR7
│  ├─ ⚠️ Blacklist CRUD — Phase 16 Track B PR7
│  ├─ ⚠️ Manual review queue — Phase 16 Track B PR8
│  ├─ ⚠️ Auto-cancel stale holds — Phase 16 Track B PR9
│  └─ ⚠️ Stripe Radar signals ingestion — Phase 16 Track D PR14 (augments Gbox engine)
│
└─ 💸 Refunds & Disputes (all 3 gateways parity)
   ├─ ⚠️ PayPal refund + partial — Phase 16 Track A PR3
   ├─ ⚠️ PayPal chargeback + auto-evidence — Phase 16 Track A PR4 (Dispute API)
   ├─ ⚠️ PayPal payout/settlement reporting — Phase 16 Track A PR5
   ├─ ⚠️ Stripe refund + disputes + settlement — Phase 16 Track D PR13/15/16
   ├─ ⚠️ Airwallex refund + disputes + settlement — Phase 16 Track E PR21/22
   └─ 🔵 Order risk engine (ML-based, Shopify-level) — DEFERRED Phase 20+
```

**Status (after v3 scope lock):** 🟡 **TRACK-ABLE BLOCKER**. Gbox có PayPal partner sẵn (BN code `Gbox_Ecom`) làm default priority. **Stripe + Airwallex tích hợp HOÀN CHỈNH** song song (3DS + fraud + disputes + payouts + settlement) để **sellers có quyền lựa chọn** — không lock vào 1 provider. Phase 16 27 PRs / 10 tuần (6 parallel tracks). Apple/Google Pay/Klarna/Afterpay DEFERRED post-Oct 2026 (3 gateways đủ MVP).

---

### NHÁNH 4: 🛒 COMMERCE CORE (22 modules)

```
🛒 COMMERCE CORE
│
├─ 📦 Products
│  ├─ Variants (unlimited, no explicit cap)
│  ├─ Metafields (full CRUD, typed values)
│  ├─ Product images, rich media
│  ├─ SEO: seo_title, seo_description per product
│  ├─ Tags, vendor, type, status
│  ├─ Product Pro (custom variants, options, swatches)
│  └─ Import/Export: CSV, Excel
│
├─ 📂 Collections
│  ├─ Smart collections (auto-populate by rules)
│  │  ├─ Rules: title, vendor, type, tags, status, price, inventory
│  │  └─ Async sync via BullMQ when product changes
│  ├─ Manual collections (direct product assoc)
│  └─ Collection pages (storefront)
│
├─ 🛍 Cart & Checkout
│  ├─ Cart: single-cart per session
│  ├─ Checkout: single-page (SPA)
│  ├─ Guest checkout: ✅ YES (email optional)
│  ├─ Cart abandonment recovery (multi-step email drip)
│  ├─ B2B reorder flows (50+ line items optimized)
│  ├─ Delta calculation (applyLineDelta for high-freq updates)
│  └─ ❌ One-page checkout UX: chưa optimal
│
├─ 📜 Orders
│  ├─ Order status: pending, confirmed, fulfilled, cancelled, refunded
│  ├─ Fulfillment: unfulfilled | partial | fulfilled
│  ├─ ❌ Order splitting (by vendor/location): KHÔNG CÓ
│  ├─ Line items, taxes, discounts tracked per line
│  ├─ ❌ Order risk scoring: stub UI only, no engine
│  ├─ ❌ Chargebacks: deferred
│  ├─ Returns/RMA: YES (migration refunds table)
│  └─ Order export: CSV, Excel, API
│
├─ 🏪 Inventory
│  ├─ Multi-location: YES (locations table, shop-scoped)
│  ├─ States: available | incoming | committed
│  ├─ Per-variant core (inventory_items)
│  ├─ Per-location state (inventory_levels)
│  ├─ Denormalized total (product_variants.inventory_quantity)
│  ├─ ❌ Forecasting: KHÔNG CÓ
│  └─ ❌ Auto-reorder: KHÔNG CÓ
│
├─ 👥 Customers
│  ├─ Customer accounts (email/password/Passkey/OAuth)
│  ├─ Segments (VIP, new, at_risk, custom)
│  ├─ Tags, custom fields (metafields)
│  ├─ Order history
│  ├─ Quick filters (saved searches)
│  ├─ Privacy: consent tracking + GDPR workflows
│  └─ ❌ Customer 2FA: KHÔNG CÓ
│
├─ 💵 Pricing & Promotions
│  ├─ Discount types: percentage, fixed, free_shipping
│  ├─ ❌ BOGO: KHÔNG CÓ
│  ├─ ❌ Tiered discounts: KHÔNG CÓ
│  ├─ ❌ Volume pricing: KHÔNG CÓ
│  ├─ Segment targeting (VIP/new/at_risk)
│  ├─ Once-per-customer limit
│  ├─ Min spend threshold
│  ├─ Gift cards (CRUD, delivery, redemption, balance check)
│  └─ Automatic discounts (cart/shipping level)
│
└─ 🎁 Gift Cards
   ├─ Create, deliver, redeem
   ├─ Balance check endpoint
   ├─ Scheduled delivery (send_at + cron)
   ├─ Customer portal validation
   ├─ Sender/personal message fields
   └─ Storefront POST /gift-cards/validate
```

**Status:** 🟢 Đủ cho launch beta. ⚠️ Gaps: BOGO, tiered/volume discounts, order splitting, fraud detection, customer 2FA.

---

### NHÁNH 5: 🚚 SHIPPING & TAX (3 modules)

```
🚚 SHIPPING & TAX
│
├─ 📦 Shipping (US FOCUS + LENFUL + AGENT flow)
│  ├─ 13 carriers seeded: USPS, UPS, FedEx, DHL (Express + Paket), Royal Mail, La Poste, Colissimo, DPD, PostNL, GLS, Hermes, Bpost
│  ├─ Shipping zones: country-based rules
│  ├─ Shipping rates: flat, by-weight, by-price
│  ├─ ⚠️ Lenful native fulfillment — Phase 17 PR1-5 (order push + status + tracking + SKU map + profile)
│  ├─ ⚠️ Label attach from agent — Phase 18 PR7 (upload PDF, no direct carrier API)
│  ├─ ⚠️ HS codes on products — Phase 17 PR6 (field + seed 150 common codes)
│  ├─ ⚠️ Commercial Invoice PDF gen — Phase 17 PR7 (for UPS/FedEx/DHL parcels)
│  ├─ ⚠️ CN22/CN23 form gen (optional) — Phase 17 PR8 (USPS post parcels)
│  ├─ 🔵 Real-time carrier APIs: DEFERRED Phase 20+ (Lenful + agent logistics lo)
│  ├─ 🔵 Direct carrier label print: DEFERRED Phase 20+ (agent cấp PDF)
│  ├─ 🔵 Multi-origin warehouses: DEFERRED Phase 20+ (Lenful single-source)
│  └─ ❌ Local carriers VN/BD — KHÔNG CẦN (cross-border outbound only)
│
├─ 🧾 Tax (US FOCUS, EU/CA DEFERRED)
│  ├─ ⚠️ US sales tax nexus engine — Phase 18 PR1 (10-15 major states: CA, TX, NY, FL, WA, IL, PA, OH, GA, NC, NJ, VA, AZ, CO)
│  ├─ ⚠️ US tax calc at checkout — Phase 18 PR2 (destination-based + state + county + city)
│  ├─ ⚠️ US tax report export — Phase 18 PR3 (per-state CSV filing prep)
│  ├─ ⚠️ B2B tax-exempt (resale cert) — Phase 18 PR4 (upload + admin review)
│  ├─ ✅ EU VAT code + reverse charge — có sẵn (Phase 9) nhưng 🔵 DEFERRED go-live
│  ├─ 🔵 IOSS scheme (EU <€150): DEFERRED Phase 20+ (EU market expansion)
│  ├─ 🔵 UK VAT post-Brexit: DEFERRED Phase 20+
│  ├─ 🔵 Canada GST/PST/HST: DEFERRED Phase 20+
│  ├─ Tax-inclusive back-solve ✅
│  ├─ Compounded rates ✅
│  ├─ VAT number validation + EIN support ✅
│  ├─ Per-order line-item tax trails ✅
│  ├─ 🔵 Tax providers (Avalara/TaxJar): DEFERRED Phase 20+
│  └─ ❌ Local VN/BD VAT — KHÔNG CẦN (bán ra US, không domestic)
│
└─ 🌐 Markets
   ├─ Region grouping (countries array per market)
   ├─ Currency per market (37+ currencies in catalog)
   ├─ Language per market (15+ languages)
   ├─ FK on shipping_zones (market_id)
   ├─ FK on tax_registrations (market_id)
   ├─ 7 region templates: US, EU, Global, APAC, SEA, Americas, MENA (US primary, rest DEFERRED)
   ├─ ⚠️ Multi-currency product display — Phase 16 Track C PR10 (USD default for US visitor)
   └─ 🔵 Per-region pricing overrides: DEFERRED Phase 20+
```

**Status:** 🟡 US/EU OK, ⚠️ **Vietnam shipping carriers + Bangladesh tax + BD carriers = BLOCKERS cho target market**.

---

### NHÁNH 6: 📣 MARKETING & ENGAGEMENT (12 modules)

```
📣 MARKETING & ENGAGEMENT
│
├─ 📧 Email System (97 templates, Phase 14)
│  ├─ Registry: 97 templates total
│  │  ├─ Transactional (23): order confirmation, shipping, refund
│  │  ├─ Marketing (18): campaigns, newsletter
│  │  ├─ Lifecycle (14): welcome, win-back, post-purchase
│  │  ├─ Reviews (6): request, approval, reply
│  │  ├─ Ops (17): merchant-facing alerts
│  │  ├─ Platform (9): god-admin only (Iron Rule 5 safe)
│  │  └─ Legal (8): GDPR, ToS, forced send
│  ├─ Transports: Gmail SMTP, Console, SES (stub)
│  ├─ Delivery audit: email_deliveries table
│  ├─ Webhook events: email_events (bounce, open, click)
│  ├─ Preferences: per-customer opt-out + SHA-256 unsubscribe token
│  ├─ Unsubscribe landing: /accounts/unsubscribe (seller-safe)
│  └─ Iron Rule 5: getMerchantVisibleTemplates filters god_admin
│
├─ 📨 Email Automation (Workflows)
│  ├─ Abandoned cart recovery (multi-step drip)
│  ├─ Welcome series
│  ├─ Review request/approval
│  ├─ Post-purchase upsell
│  ├─ First order milestone
│  ├─ Customer win-back
│  ├─ BullMQ async dispatcher
│  └─ Idempotency keys per flow
│
├─ 📣 Campaigns
│  ├─ Campaigns service + cron
│  ├─ AI campaign angle suggester
│  ├─ Subject line variants (AI-generated)
│  ├─ Segment targeting
│  ├─ A/B testing: basic support
│  └─ Analytics: open/click rates
│
├─ 📱 SMS Marketing
│  ├─ ❌ Twilio wire: STUB ONLY
│  ├─ Admin UI mentions SMS (not wired)
│  ├─ ❌ Shopify SMS: KHÔNG CÓ
│  └─ 🚨 CRITICAL cho VN/BD markets (SMS heavy)
│
├─ 🔔 Web Push
│  └─ ❌ Chưa implement
│
├─ ⭐ Reviews (Phase 10 PR3)
│  ├─ Product reviews (5-star, comment)
│  ├─ Photo upload
│  ├─ Vote helpful (flip-vote, SHA-256 voter hash)
│  ├─ Profanity filter (EN + VN with NFD/diacritic strip)
│  ├─ Merchant reply
│  ├─ Moderation queue + approval
│  └─ Email notifications (review_approved, review_replied)
│
├─ 🎁 Gift Cards (Phase 10 PR2)
│  ├─ CRUD UI
│  ├─ Delivery email (scheduled via send_at + cron)
│  ├─ Customer portal validation
│  ├─ Balance check endpoint
│  └─ Redemption at checkout
│
├─ 🎯 Abandoned Cart
│  ├─ Multi-step drip (1h, 24h, 72h typical)
│  ├─ Cart stale detection
│  └─ Admin override thresholds
│
├─ 🔍 SEO Infrastructure (Phase 8 PR3)
│  ├─ Sitemap.xml generation (dynamic)
│  ├─ Robots.txt generation
│  ├─ Meta tags per product/collection/page/blog
│  ├─ ❌ Structured data (JSON-LD): KHÔNG CÓ
│  ├─ ❌ Crawl audit tool: KHÔNG CÓ
│  └─ ❌ Schema.org validation: KHÔNG CÓ
│
├─ 🎪 Loyalty Programs
│  └─ ❌ Chưa implement
│
├─ 🤝 Affiliate Programs
│  └─ ❌ Chưa implement
│
└─ 🤖 AI Assistant (Phase 10 PR1)
   ├─ Product description drafts (Anthropic SDK)
   ├─ Email subject variants
   ├─ Campaign angle suggester
   └─ Per-shop API key (platform_settings)
```

**Status:** 🟢 Email = outstanding (vượt Shopify). ⚠️ Critical: SMS, web push, loyalty, live chat.

---

### NHÁNH 7: 🎨 STOREFRONT & THEMES (4 modules)

```
🎨 STOREFRONT & THEMES
│
├─ 🌿 Liquid Theme Engine (LiquidJS)
│  ├─ 987+ unit tests (Shopify-compatible parity)
│  ├─ 25+ filters: string, URL, money, numeric, image, form
│  ├─ Tags: section, layout, form, paginate, content_for_*
│  ├─ Section Schema Resolver (Shopify-exact JSON)
│  ├─ Config: strictFilters:true, cache:true, no auto-escape
│  ├─ JSON + Liquid dual templates (build-time + runtime)
│  └─ ❌ App embed blocks: KHÔNG CÓ (Shopify-specific)
│
├─ 🏪 Storefront Router (16 Shopify-exact routes)
│  ├─ / (Home, dynamic featured collections)
│  ├─ /products/:id
│  ├─ /collections/:id
│  ├─ /blogs/:id
│  ├─ /cart
│  ├─ /checkout
│  ├─ /account (orders, addresses, prefs)
│  ├─ /search (product + content)
│  ├─ /gift-cards (redemption, balance)
│  ├─ /policies/privacy, /policies/tos, /policies/returns
│  └─ /404 (custom)
│
├─ 🔧 Storefront Middleware (26 handlers)
│  ├─ Locale & i18n (multi-language, Accept-Language)
│  ├─ Customer session (cookie-based)
│  ├─ Cart management (wishlist)
│  ├─ Email tracking (pixel injection)
│  ├─ UTM capture (campaign attribution)
│  ├─ SEO & sitemap
│  ├─ Theme preview (domain-scoped)
│  ├─ Asset serving (optimized)
│  ├─ Error handling (no leaks)
│  ├─ Request context (shop/locale/customer threading)
│  ├─ Cache headers (edge directives)
│  └─ Marketing pixel injection (GA, TikTok, etc.)
│
└─ 🎨 Themes
   ├─ Gbox Dawn (1 seeded theme, Shopify Dawn-compatible)
   │  ├─ 61 files (56 templates/assets/sections)
   │  ├─ 16 templates (3 JSON + 13 Liquid)
   │  ├─ 20 sections with {% schema %}
   │  ├─ 9 snippets
   │  └─ Localized: en/vi
   ├─ Theme editor (code + visual hybrid)
   │  ├─ Liquid syntax highlighting
   │  ├─ JSON template editor
   │  ├─ Settings schema resolver
   │  └─ Preview window
   ├─ Theme upload/activation (shop-scoped)
   ├─ Theme clone (copy internal + apply custom)
   ├─ Theme sync (multi-device realtime)
   └─ ❌ Theme store/marketplace: KHÔNG CÓ
```

**Status:** 🟢 Engine mạnh hơn Shopify (test coverage). ⚠️ Chỉ 1 theme, không có theme store.

---

### NHÁNH 8: 💬 SUPPORT SYSTEM (8 modules, Phase 12.5 + 13)

```
💬 SUPPORT SYSTEM
│
├─ 🎫 Ticket Management
│  ├─ Full CRUD (create, assign, resolve, close)
│  ├─ Categories: payment, shipping, product, other
│  ├─ Priority: urgent, high, normal, low
│  ├─ Assignment to agents
│  ├─ SLA tracking (first response, resolution)
│  │  ├─ Category-based: payment 2h/12h, others 4h/24h
│  │  └─ Time-in-pending tracking (sla_paused_total_ms)
│  ├─ Audit trail (support_ticket_events)
│  ├─ Message threading (with edits)
│  ├─ Soft delete (deleted_at + deleted_by_user_id)
│  └─ Private notes (internal only)
│
├─ 👥 Staff & Permissions
│  ├─ 25-entry permission catalog
│  ├─ 4 role templates: owner, admin, staff, limited
│  ├─ Override-aware resolver (per-member customization)
│  ├─ staff_invitations (SHA-256 token_hash, 7-day TTL)
│  ├─ UNIQUE partial index (shop_id, email) WHERE status='pending'
│  ├─ Owner-immutable guard (prevent demote)
│  ├─ Self-demote guard (prevent staff lock-out)
│  ├─ Staff login events (SHA-256 device fingerprint)
│  ├─ is_new_device detection
│  ├─ user_shops: permissions_computed, disabled_at, invited_by
│  └─ last_active_at tracking
│
├─ 🔔 Support Notifications (Phase 14 P0 fix)
│  ├─ Channel selection: email, in-app, push
│  ├─ Quiet hours (per-shop, per-user)
│  ├─ Rate limiting (1 per ticket per hour)
│  ├─ Email envelope templates:
│  │  ├─ support_notification_seller (ops/merchant)
│  │  └─ support_notification_agent (platform/god_admin)
│  ├─ Iron Rule 5: audience routing via SELLER_NOTIFICATION_TYPES
│  └─ Escape HTML for XSS safety
│
├─ 📝 Canned Replies
│  ├─ Template library (shop-scoped)
│  ├─ Context variables (agent, customer, ticket data)
│  ├─ Categorization
│  └─ Usage analytics
│
├─ 😊 CSAT Survey (Phase 12.5)
│  ├─ CSAT score (1-5)
│  ├─ Comment field
│  ├─ Prompt workflow (post-resolution email)
│  └─ Aggregate reporting
│
├─ 🤖 AI Support Assistant
│  ├─ Ticket summary generation
│  ├─ Reply suggestions (Anthropic SDK)
│  └─ Sentiment analysis
│
├─ 💬 Live Chat
│  └─ ❌ Chưa implement (ticket-only)
│
└─ 📚 Knowledge Base / Help Center
   └─ ❌ Chưa implement
```

**Status:** 🟢 Vượt Shopify ở ticketing. ⚠️ Thiếu live chat + help center.

---

### NHÁNH 9: 📊 ANALYTICS & REPORTS (5 modules, Phase 6)

```
📊 ANALYTICS & REPORTS
│
├─ 📈 Dashboards
│  ├─ Order analytics (revenue, count, avg)
│  ├─ Inventory analytics (levels, turnover)
│  ├─ Email analytics (send, open, click)
│  ├─ Campaign performance
│  ├─ Live views (world paths, real-time)
│  └─ Top products/collections
│
├─ 📋 Pre-built Reports
│  ├─ Order by date/status/revenue
│  ├─ Inventory levels (by location/product)
│  ├─ Email performance
│  ├─ Customer lifetime value
│  ├─ Abandonment funnel
│  └─ Payout reconciliation (basic)
│
├─ 🎨 Custom Report Builder
│  └─ ❌ Chưa implement (chỉ pre-built)
│
├─ 🎯 Attribution
│  ├─ UTM capture (middleware)
│  ├─ ❌ Last-click only (simple)
│  ├─ ❌ Multi-touch attribution: KHÔNG CÓ
│  ├─ ❌ ML-based attribution: KHÔNG CÓ
│  └─ Shopify: multi-touch + last-click + first-click
│
└─ 📤 Export
   ├─ CSV, Excel, API
   ├─ Background export (large datasets)
   └─ Email delivery when ready
```

**Status:** 🟡 Đủ cho cơ bản. ⚠️ Gaps: custom builder, multi-touch attribution.

---

### NHÁNH 10: 🌏 SITE CLONING (Clone Pro v4)

```
🌏 SITE CLONING (Unique Gbox Feature — No Shopify equivalent)
│
├─ 🤖 Clone Pro Engine (~50% complete)
│  ├─ Autonomous crawling
│  ├─ Product extraction
│  ├─ Theme replication
│  ├─ Asset download
│  └─ Design library integration
│
├─ 🖼 Design Library
│  ├─ Reusable design assets
│  ├─ Component catalog
│  └─ Watermark system
│
├─ 🧠 Intelligent Cloning
│  ├─ AI-assisted field mapping
│  ├─ Variant detection
│  └─ SEO preservation
│
└─ 🎯 Clone Shopify (legacy)
   ├─ Shopify store mirroring
   └─ Bibliobloom import script (precedent)
```

**Status:** 🟢 Unique feature, no Shopify equivalent. ⚠️ ~50% complete, needs more work.

---

### NHÁNH 11: 🏢 ADMIN DASHBOARDS (157 pages total)

```
🏢 ADMIN DASHBOARDS
│
├─ 👨‍💼 Store Admin (112 pages, Shopify-class)
│  ├─ Home (5 pages): overview, dashboard, activity feed
│  ├─ Products (12 pages): list, detail, variants, collections, import/export
│  ├─ Orders (10 pages): list, detail, fulfillment, returns, risks
│  ├─ Customers (8 pages): list, segments, quick filters, details
│  ├─ Marketing (15 pages): campaigns, abandoned carts, automations
│  ├─ Discounts (6 pages): list, create, gift cards
│  ├─ Content (10 pages): pages, blog, navigation, design library
│  ├─ Settings (20 pages): general, payments, shipping, tax, markets, staff, domain
│  ├─ Support (8 pages): tickets, staff, security, alerts
│  ├─ AI (4 pages): copywriter, campaigns, assistant
│  ├─ Cloning (5 pages): dashboard, jobs, history
│  ├─ Reports (5 pages): orders, inventory, customer, campaign
│  └─ Advanced (4 pages): webhooks, API, integrations
│
├─ 👑 God Admin (45 pages, platform-level only)
│  ├─ System (10 pages): platform overview, alerts, audit, retention
│  ├─ Users/Shops (12 pages): all users, all shops, impersonate
│  ├─ Content/Config (8 pages): templates, platform policies
│  ├─ AI/Agents (6 pages): global AI config, cost monitoring
│  ├─ Security/Audit (5 pages): global audit, IP allowlist, 2FA enforcement
│  └─ Advanced (4 pages): feature flags, integrations, webhooks
│
├─ 👤 Accounts Portal (13 pages)
│  ├─ Register, Login (with Passkey/OAuth)
│  ├─ Profile, Security (2FA, Passkey)
│  ├─ Shops list, create shop
│  ├─ Billing (basic)
│  ├─ Unsubscribe landing (Iron Rule 5 safe)
│  └─ Support tickets (customer-facing)
│
└─ 🎧 Supporter Portal (8 pages)
   ├─ Ticket queue
   ├─ Canned replies
   ├─ CSAT reports
   └─ Staff management
```

**Status:** 🟢 Scope tương đương Shopify admin. Clone Pro + Iron Rule 5 là unique.

---

### NHÁNH 12: 🧱 INFRASTRUCTURE & DEVOPS

```
🧱 INFRASTRUCTURE & DEVOPS
│
├─ 🏗 Architecture
│  ├─ Monorepo: packages/core, packages/db, packages/api, packages/storefront, etc.
│  ├─ 7 npm packages (agent-core, agent-guard, agent-tools, api, core, db, storefront)
│  ├─ Apps: store-admin, god-admin, accounts, storefront, checkout, supporter
│  └─ 0 circular dependencies (hierarchical: apps → core → db)
│
├─ 💻 Languages & Frameworks
│  ├─ TypeScript (all packages)
│  ├─ Kysely ORM (type-safe SQL)
│  ├─ Astro SSR (storefront)
│  ├─ EmDash CMS (admin)
│  ├─ Express (API server)
│  └─ LiquidJS (themes)
│
├─ 🔄 Job Queue
│  ├─ BullMQ (Redis-backed)
│  ├─ Scheduled crons: SLA, email sends, cleanup
│  ├─ Event streaming: webhook fan-out
│  └─ Retry logic per job type
│
├─ 📡 Logging & Monitoring
│  ├─ Pino (structured logging)
│  ├─ Platform alerts (real-time system monitoring)
│  ├─ Activity tracking (user/shop audit trail)
│  ├─ Error tracking (Sentry-style)
│  └─ Live analytics (world paths)
│
├─ 🚀 Deployment
│  ├─ Dev/Preview: Cloudflare Workers + Pages
│  ├─ Production: Node.js on VPS/Dedicated
│  ├─ Infra: 3 Ubuntu servers (DB/API/Storefront)
│  ├─ DB: PostgreSQL on 192.168.1.13
│  └─ PM2 process management
│
├─ 🧪 Testing
│  ├─ Vitest (unit + integration)
│  ├─ Smoke tests: 48 total (43/48 baseline passing)
│  ├─ Smoke matrix runner (scripts/ops/smoke-matrix.ts)
│  ├─ Regression baseline JSON (smoke-baseline.json)
│  ├─ Migration ledger drift gate
│  └─ ❌ E2E tests (Playwright): MINIMAL
│
├─ 🛡 Release Gates (Phase 11)
│  ├─ Migration ledger drift check
│  ├─ Preflight orchestrator (release-check.ts)
│  ├─ Smoke matrix (33 phase smokes + 15 unit smokes)
│  ├─ Git-clean check
│  ├─ Node-floor check (>=20)
│  └─ Runbook: docs/ops/release-checklist.md
│
└─ 📚 Documentation
   ├─ CLAUDE.md (project brain, <200 lines)
   ├─ CLAUDE-EXTENDED.md (overflow)
   ├─ docs/superpowers/specs/ (specs)
   ├─ docs/superpowers/plans/ (impl plans)
   ├─ docs/ops/ (runbooks)
   └─ docs/email-system/ (email deferred checklist)
```

**Status:** 🟢 Release gates + smoke matrix là outstanding. ⚠️ E2E tests minimal.

---

## 📊 PHẦN 2: BẢNG FEATURE COMPARISON CHI TIẾT (100+ features)

| # | Feature | Shopify | Gbox | Gap | Notes (HONEST) |
|---|---------|---------|------|-----|----------------|
| **=== CORE PLATFORM ===** | | | | | |
| 1 | Multi-tenant architecture | ✅ DB-level RLS | ⚠️ App-layer only | **P1 HIGH** | Gbox risk data leak nếu bug query |
| 2 | Real-time DB updates | ✅ Webhooks + events | ✅ BullMQ events | ✓ EQUAL | |
| 3 | Caching (Redis + edge) | ✅ Full | ✅ Full | ✓ EQUAL | Redis + LRU + Cloudflare KV |
| 4 | API rate limiting | ✅ Yes | ✅ 5/min auth | ✓ EQUAL | |
| 5 | Automated backup | ✅ Daily + PITR | ❌ Infra-level only | **P1 CRITICAL** | No script in codebase |
| 6 | Point-in-time restore | ✅ Yes | ❌ No | **P1 CRITICAL** | |
| 7 | DB migrations versioned | ✅ Yes | ✅ 89 migrations | ✓ EQUAL | Ledger drift detector |
| 8 | Transaction isolation levels | ✅ Explicit | ❌ Default only | **P1 MEDIUM** | Checkout risk oversell |
| **=== SECURITY ===** | | | | | |
| 9 | Password hashing | ✅ bcrypt | ✅ bcrypt + SHA-256 migration | ✓ EQUAL | |
| 10 | 2FA for staff | ✅ TOTP + recovery | ✅ TOTP + email OTP + backup | ✓ EQUAL | |
| 11 | 2FA for customer | ✅ Optional | ❌ NOT IMPLEMENTED | **P2 HIGH** | Account takeover risk |
| 12 | Passkey/WebAuthn | ✅ Yes | ✅ Yes | ✓ EQUAL | |
| 13 | Rate limit auth endpoints | ✅ Yes | ✅ 5/min | ✓ EQUAL | |
| 14 | CSRF protection | ✅ Yes | ✅ One-time token | ✓ EQUAL | |
| 15 | Session management | ✅ 30-day cookie | ✅ 30-day sliding | ✓ EQUAL | |
| 16 | OAuth providers | ✅ Google/Apple/FB | ⚠️ Google only | **P2 MEDIUM** | |
| 17 | OAuth token encryption | ✅ Vault | ✅ AES-256-GCM | ✓ EQUAL | |
| 18 | IP allowlist (admin) | ✅ Yes | ✅ god-admin only | ✓ EQUAL | |
| 19 | Audit logging retention | ✅ 90 days | ✅ 365 days default | ✓ Gbox BETTER | |
| 20 | Per-shop API keys | ✅ Yes + scopes | ❌ Session-based only | **P1 HIGH** | Blocker cho apps |
| 21 | PCI compliance | ✅ Level 1 | ⚠️ Pass-through | ✓ EQUAL | Delegated to PayPal/Stripe |
| 22 | GDPR right-to-erasure | ✅ Yes | ✅ Yes (migration 088) | ✓ EQUAL | |
| 23 | Data export on request | ✅ Yes | ✅ Zip + SHA-256 token | ✓ EQUAL | |
| 24 | DPA (Data Processing Agreement) | ✅ Yes | ⚠️ Legal docs needed | **P2 MEDIUM** | |
| **=== DATA INTEGRITY ===** | | | | | |
| 25 | Row-Level Security (RLS) | ✅ DB-level | ❌ App-layer only | **P1 HIGH** | Critical gap |
| 26 | Idempotency keys (webhooks) | ✅ Idempotency-Key header | ❌ Row uniqueness only | **P1 HIGH** | Risk duplicate charges |
| 27 | Idempotency (automation) | ✅ Yes | ✅ flow-catalog keys | ✓ EQUAL | |
| 28 | Soft delete + deleted_at | ✅ Yes | ✅ Yes | ✓ EQUAL | |
| 29 | DB triggers (updated_at) | ✅ Yes | ✅ Yes | ✓ EQUAL | |
| **=== COMMERCE CORE ===** | | | | | |
| 30 | Products (variants) | ✅ 100/product | ✅ Unlimited (no cap) | ✓ Gbox BETTER | |
| 31 | Metafields | ✅ Yes (50+ types) | ✅ Full CRUD, typed | ✓ EQUAL | |
| 32 | Smart collections | ✅ Yes | ✅ Rules-based auto | ✓ EQUAL | |
| 33 | Manual collections | ✅ Yes | ✅ Yes | ✓ EQUAL | |
| 34 | Cart (session-based) | ✅ Yes | ✅ Single-cart | ✓ EQUAL | |
| 35 | Multi-cart (B2B) | ✅ Yes | ⚠️ B2B reorder only | **P2 MEDIUM** | |
| 36 | Single-page checkout | ✅ Yes (one-page) | ✅ SPA | ✓ EQUAL | |
| 37 | Guest checkout | ✅ Yes | ✅ Yes | ✓ EQUAL | |
| 38 | Abandoned cart recovery | ✅ Email + SMS | ✅ Email only | **P2 MEDIUM** | SMS stub |
| 39 | Order splitting (vendor) | ✅ Yes | ❌ No | **P2 HIGH** | POD/Dropship needs |
| 40 | Order fulfillment status | ✅ Yes | ✅ Yes | ✓ EQUAL | |
| 41 | Multi-location inventory | ✅ Yes | ✅ Yes | ✓ EQUAL | |
| 42 | Inventory forecasting | ✅ Shopify Plus | ❌ No | **P3 LOW** | |
| 43 | Returns/RMA | ✅ Yes | ✅ Yes (refunds tables) | ✓ EQUAL | |
| 44 | Order risk/fraud scoring | ✅ ML engine | ❌ Shell UI only | **P1 CRITICAL** | Launch blocker cho high-risk |
| 45 | Chargeback management | ✅ Yes | ❌ Deferred | **P3 LOW** | Revisit at payments phase |
| **=== SHIPPING ===** | | | | | |
| 46 | Shipping zones & rates | ✅ Yes | ✅ 13 carriers seeded | ✓ EQUAL | |
| 47 | Real-time carrier rates | ✅ USPS/UPS/FedEx live | ❌ Stub only | **P1 HIGH** | |
| 48 | Shipping label print | ✅ Yes | ❌ No | **P1 HIGH** | |
| 49 | Multi-origin warehouses | ✅ Yes | ❌ No | **P3 LOW** | |
| 50 | USPS real-time rates | ✅ Live API | ❌ Stub only | 🔵 DEFERRED Phase 20+ | Lenful + agent logistics lo routing |
| 51 | UPS/FedEx/DHL Express live rates | ✅ Yes | ❌ Stub only | 🔵 DEFERRED Phase 20+ | Lenful + agent lo |
| 52 | Royal Mail + Canada Post rates | ✅ Via apps | ❌ No | 🔵 DEFERRED Phase 20+ | EU/CA expansion defer |
| 53 | International shipping label print (direct API) | ✅ Yes | ❌ No | 🔵 DEFERRED Phase 20+ | Agent cấp PDF, Gbox attach-only |
| 53b | Label attach flow (from agent) | ⚠️ Via apps | ⚠️ Phase 18 PR7 | **P1 HIGH** | Upload agent PDF → attach to order |
| 54 | HS codes on products | ✅ Yes | ❌ No | **P1 HIGH** | Phase 17 PR6 — field + seed + UI |
| 55 | Commercial Invoice PDF gen | ✅ Yes | ❌ No | **P1 HIGH** | Phase 17 PR7 — for UPS/FedEx/DHL |
| 55b | CN22/CN23 form gen | ✅ Yes | ❌ No | **P2 MEDIUM** | Phase 17 PR8 — optional for USPS |
| 56 | Multi-origin warehouses | ✅ Yes | ❌ No | 🔵 DEFERRED | Lenful single-source for now |
| **=== TAX (US-FOCUSED, EU DEFERRED) ===** | | | | | |
| 57 | US sales tax nexus engine | ✅ Full | ⚠️ Stub catalog | **P1 HIGH** | Phase 18 PR1-4 — 10-15 states |
| 57b | US sales tax calc at checkout | ✅ Destination-based | ❌ No | **P1 HIGH** | Phase 18 PR2 |
| 57c | US tax report export (state filing) | ✅ Yes | ❌ No | **P1 HIGH** | Phase 18 PR3 |
| 57d | B2B tax-exempt customer (resale cert) | ✅ Yes | ❌ No | **P2 HIGH** | Phase 18 PR4 |
| 58 | EU VAT + B2B reverse charge | ✅ Yes | ✅ Yes (Phase 9) | 🔵 DEFERRED EU | Code có sẵn, chưa go-live EU market |
| 59 | IOSS scheme (EU <€150 goods) | ✅ Yes | ❌ No | 🔵 DEFERRED Phase 20+ | EU market defer |
| 60 | UK VAT post-Brexit | ✅ Yes | ⚠️ Partial | 🔵 DEFERRED Phase 20+ | UK market defer |
| 61 | Canada GST/PST/HST | ✅ Yes | ⚠️ Partial | 🔵 DEFERRED Phase 20+ | CA market defer |
| 62 | Tax providers (Avalara/TaxJar) | ✅ Integration | ❌ No | **P3 LOW** | Strategic post-launch |
| 63 | Markets (region grouping) | ✅ Yes | ✅ Yes (Phase 9) | ✓ EQUAL | |
| 64 | Per-region pricing | ✅ Yes | ❌ No (currency only) | 🔵 DEFERRED Phase 20+ | EU expansion |
| **=== PAYMENTS (3 GATEWAYS FULL, PAYPAL PRIORITY DEFAULT — OWNER DIRECTIVE v3) ===** | | | | | |
| 65 | Payment gateways (count) | ✅ 100+ | ✅ 3 (PayPal + Stripe + Airwallex FULL) | ✓ STRATEGIC | PayPal priority default, Stripe + Airwallex parity cho seller choice |
| 66 | **PayPal Checkout (Smart Buttons)** | ✅ Yes | ⚠️ Dev mode | **P1 CRITICAL** | Phase 16 Track A PR1 — prod harden + biggest button |
| 66b | **PayPal Pay via Card (Advanced)** | ✅ Yes | ❌ No | **P1 CRITICAL** | Phase 16 Track A PR2 — card buyers không có PP account |
| 66c | PayPal refund + partial | ✅ Yes | ⚠️ Manual | **P1 HIGH** | Phase 16 Track A PR3 |
| 66d | PayPal chargeback + auto-evidence | ✅ Yes | ❌ No | **P1 HIGH** | Phase 16 Track A PR4 |
| 66e | PayPal payout/settlement reporting | ✅ Yes | ❌ No | **P1 HIGH** | Phase 16 Track A PR5 |
| 66f | BN code `Gbox_Ecom` enforce | N/A | ✅ Already partnered | ✓ Gbox UNIQUE | Partner status |
| 67 | **Stripe prod + webhook idempotency** | ✅ Yes | ⚠️ Dev mode | **P1 HIGH** | Phase 16 Track D PR11 |
| 67b | **Stripe Payment Intents + SCA/3DS** | ✅ Yes | ❌ No | **P1 HIGH** | Phase 16 Track D PR12 — full parity với PayPal Advanced |
| 67c | Stripe refund + partial | ✅ Yes | ⚠️ Manual | **P1 HIGH** | Phase 16 Track D PR13 |
| 67d | **Stripe Radar (fraud)** | ✅ Yes | ❌ No | **P1 HIGH** | Phase 16 Track D PR14 — merge với Gbox fraud engine |
| 67e | **Stripe disputes + auto-evidence** | ✅ Yes | ❌ No | **P1 HIGH** | Phase 16 Track D PR15 — parity với PayPal PR4 |
| 67f | Stripe payout/settlement | ✅ Yes | ❌ No | **P1 HIGH** | Phase 16 Track D PR16 — Balance Transactions API |
| 68 | **Airwallex merchant KYC + account** | ✅ Via apps | ❌ No | **P1 HIGH** | Phase 16 Track E PR17 |
| 68b | **Airwallex collect flow (USD in)** | ✅ Via apps | ❌ No | **P1 HIGH** | Phase 16 Track E PR18 |
| 68c | **Airwallex pay flow (VN/BD bank out)** | ✅ Shopify Payments | ❌ No | **P1 HIGH** | Phase 16 Track E PR19 |
| 68d | **Airwallex multi-currency wallet** | ⚠️ Via apps | ❌ No | **P1 HIGH** | Phase 16 Track E PR20 |
| 68e | Airwallex disputes | ✅ Via apps | ❌ No | **P1 HIGH** | Phase 16 Track E PR21 |
| 68f | Airwallex settlement reporting | ✅ Via apps | ❌ No | **P1 HIGH** | Phase 16 Track E PR22 |
| 68g | **Airwallex FX rates + spot-rate lock** | ⚠️ Via apps | ❌ No | **P1 HIGH** | Phase 16 Track E PR23 — 24h lock cho predictable settlement |
| **=== GATEWAY SWITCHER (NEW v3 — seller choice) ===** | | | | | |
| 68h | **Gateway selection admin UI** | ✅ Yes | ❌ No | **P1 HIGH** | Phase 16 Track F PR24 — PayPal pre-checked default |
| 68i | **Per-shop gateway config + encrypted credentials** | ✅ Yes | ❌ No | **P1 HIGH** | Phase 16 Track F PR25 — AES-256-GCM matches OAuth crypto |
| 68j | **Gateway fallback logic** | ⚠️ Limited | ❌ No | **P2 HIGH** | Phase 16 Track F PR26 — primary fails → secondary retry |
| 68k | **Multi-gateway checkout UI** | ✅ Yes | ❌ No | **P1 HIGH** | Phase 16 Track F PR27 — PayPal prominent + tabbed alternatives |
| 69 | Payoneer | ⚠️ Via apps | ❌ No | 🔵 DEFERRED Phase 20+ | Airwallex covers VN/BD payouts |
| 70 | Wise Business | ⚠️ Via apps | ❌ No | 🔵 DEFERRED Phase 20+ | Airwallex covers |
| 71 | Apple Pay | ✅ Yes | ❌ No | 🔵 DEFERRED Phase 20+ | PayPal + 3 gateways đủ cho MVP |
| 72 | Google Pay | ✅ Yes | ❌ No | 🔵 DEFERRED Phase 20+ | |
| 73 | Klarna BNPL | ✅ Yes | ❌ No | 🔵 DEFERRED Phase 20+ | PayPal có Pay-in-4 built-in |
| 74 | Afterpay BNPL | ✅ Yes | ❌ No | 🔵 DEFERRED Phase 20+ | |
| 75 | Amazon Pay | ✅ Yes | ❌ No | 🔵 DEFERRED Phase 20+ | |
| 76 | 3D Secure / SCA | ✅ Enforced | ⚠️ PayPal native | **P1 HIGH** | Phase 16 Track A PR2 + Track D PR12 — all 3 gateways |
| 77 | Webhook idempotency (all gateways) | ✅ Idempotency-Key | ❌ Row dedup only | **P1 CRITICAL** | Phase 15 PR4 foundation, applied Phase 16 per gateway |
| 78 | Refunds (full/partial, all gateways) | ✅ Yes | ✅ Yes | ✓ EQUAL | All 3 gateways parity |
| 79 | Payout management (to VN/BD) | ✅ Shopify Payments | ⚠️ Via PayPal direct | **P2 MEDIUM** | Airwallex Phase 16 Track E PR19 — Shopify Payments equivalent |
| 80 | Multi-currency product display | ✅ Yes | ❌ No | **P1 HIGH** | Phase 16 Track C PR10 — USD default for US |
| **=== FRAUD ENGINE (OWNER DIRECTIVE: FULL, TRÁNH CHARGEBACK) ===** | | | | | |
| 80a | Velocity rules engine | ✅ Kount/Forter | ❌ Shell UI | **P1 CRITICAL** | Phase 16 Track B PR6 — card/IP/email |
| 80b | BIN lookup + geo mismatch | ✅ Yes | ❌ No | **P1 HIGH** | Phase 16 Track B PR6 |
| 80c | Device fingerprint | ✅ Yes | ❌ No | **P1 HIGH** | Phase 16 Track B PR7 |
| 80d | Blacklist (email/IP/card) | ✅ Yes | ⚠️ Partial | **P1 HIGH** | Phase 16 Track B PR7 |
| 80e | Manual review queue | ✅ Yes | ❌ No | **P1 CRITICAL** | Phase 16 Track B PR8 |
| 80f | Auto-cancel stale holds | ⚠️ Manual | ❌ No | **P2 HIGH** | Phase 16 Track B PR9 |
| **=== MARKETING ===** | | | | | |
| 74 | Email templates (count) | ✅ 50+ | ✅ **97** | ✓ Gbox BETTER | |
| 75 | Email automation workflows | ✅ Yes | ✅ BullMQ + catalogs | ✓ EQUAL | |
| 76 | Email delivery audit | ✅ Yes | ✅ email_deliveries | ✓ EQUAL | |
| 77 | Email webhook events | ✅ Yes | ✅ email_events | ✓ EQUAL | |
| 78 | Unsubscribe (SHA-256 token) | ✅ Yes | ✅ Iron Rule 5 safe | ✓ EQUAL | |
| 79 | SMS marketing | ✅ Twilio wired | ❌ Stub only | **P1 HIGH** | Critical VN/BD |
| 80 | Web push notifications | ✅ Yes | ❌ No | **P2 MEDIUM** | |
| 81 | Abandoned cart (multi-step) | ✅ Yes | ✅ Drip flow | ✓ EQUAL | |
| 82 | Discounts (types) | ✅ 5+ types | ⚠️ 3 (%, fixed, free_ship) | **P2 MEDIUM** | Missing BOGO, tiered |
| 83 | Gift cards | ✅ Yes | ✅ Full (delivery + redeem) | ✓ EQUAL | |
| 84 | Loyalty programs | ✅ Apps | ❌ No | **P2 MEDIUM** | |
| 85 | Affiliate programs | ✅ Apps | ❌ No | **P3 LOW** | |
| 86 | Reviews + photos | ✅ Shopify Reviews | ✅ Phase 10 PR3 | ✓ EQUAL | |
| 87 | Review moderation | ✅ Yes | ✅ Queue + profanity filter | ✓ Gbox BETTER | |
| 88 | Reviews notifications | ✅ Yes | ✅ review_approved email | ✓ EQUAL | |
| 89 | AI copywriter (descriptions) | ✅ Shopify Magic | ✅ Anthropic SDK | ✓ EQUAL | |
| 90 | AI email subject variants | ⚠️ Beta | ✅ Yes | ✓ Gbox BETTER | |
| 91 | AI campaign suggester | ⚠️ Beta | ✅ Yes | ✓ Gbox BETTER | |
| **=== STOREFRONT ===** | | | | | |
| 92 | Liquid theme engine | ✅ Ruby Liquid | ✅ LiquidJS (987 tests) | ✓ EQUAL | |
| 93 | Theme store | ✅ 100+ themes | ⚠️ 1 theme (Gbox Dawn) | **P2 MEDIUM** | |
| 94 | Theme editor | ✅ Visual + code | ✅ Hybrid | ✓ EQUAL | |
| 95 | Mobile responsive | ✅ Enforced | ⚠️ Not enforced | **P1 HIGH** | Need validation |
| 96 | SEO (sitemap/robots/meta) | ✅ Yes | ✅ Yes | ✓ EQUAL | |
| 97 | Structured data (JSON-LD) | ✅ Yes | ❌ No | **P2 MEDIUM** | |
| 98 | Hydrogen (headless) | ✅ Yes | ❌ No | **P3 LOW** | |
| 99 | Storefront API (GraphQL) | ✅ Yes | ❌ REST only | **P2 MEDIUM** | |
| 100 | i18n / multi-language | ✅ 20+ | ✅ 15+ languages | ✓ EQUAL | |
| 101 | Multi-currency | ✅ 130+ | ✅ 37+ | **P3 LOW** | |
| **=== SUPPORT ===** | | | | | |
| 102 | Support tickets | ⚠️ Shopify Inbox | ✅ Phase 12.5 full | ✓ Gbox BETTER | |
| 103 | SLA tracking | ⚠️ Manual | ✅ Category-based | ✓ Gbox BETTER | |
| 104 | Canned replies | ⚠️ Shopify Inbox | ✅ Yes | ✓ EQUAL | |
| 105 | CSAT survey | ⚠️ Apps | ✅ 1-5 score | ✓ Gbox BETTER | |
| 106 | Live chat | ✅ Shopify Inbox | ❌ Ticket-only | **P2 HIGH** | |
| 107 | Knowledge base | ⚠️ Apps | ❌ No | **P2 MEDIUM** | |
| 108 | Chatbot | ⚠️ Apps | ❌ No | **P3 LOW** | |
| 109 | Staff permissions (count) | ⚠️ ~10 | ✅ 25-entry catalog | ✓ Gbox BETTER | |
| 110 | Role templates | ⚠️ 4-5 | ✅ 4 + per-member overrides | ✓ EQUAL | |
| **=== ANALYTICS ===** | | | | | |
| 111 | Dashboards | ✅ Yes | ✅ Yes | ✓ EQUAL | |
| 112 | Custom report builder | ✅ Shopify Plus | ❌ No | **P2 MEDIUM** | |
| 113 | Multi-touch attribution | ✅ Yes | ❌ UTM last-click only | **P2 HIGH** | |
| 114 | Real-time analytics | ✅ Yes | ✅ Live views | ✓ EQUAL | |
| 115 | Scheduled reports | ✅ Yes | ✅ Background export | ✓ EQUAL | |
| **=== POD / DROPSHIP (LENFUL-ONLY + IMPORTER, OWNER DIRECTIVE) ===** | | | | | |
| 116 | POD: Printful | ⚠️ App | ❌ No | 🔵 DEFERRED (not opened) | Lenful-only strategic |
| 117 | POD: Printify | ⚠️ App | ❌ No | 🔵 DEFERRED (not opened) | Lenful-only strategic |
| 118 | POD: Gelato | ⚠️ App | ❌ No | 🔵 DEFERRED (not opened) | Lenful-only strategic |
| 118b | POD: CustomCat | ⚠️ App | ❌ No | 🔵 DEFERRED (not opened) | Lenful-only strategic |
| 119 | **POD: Lenful (VN — owner's company)** | ❌ N/A | ⚠️ Phase 17 PR1-5 | **P1 CRITICAL** | Native fulfillment loop |
| 119a | Lenful order push + retry | N/A | ❌ No | **P1 CRITICAL** | Phase 17 PR1 |
| 119b | Lenful status + tracking sync | N/A | ❌ No | **P1 CRITICAL** | Phase 17 PR2 |
| 119c | Lenful cancel/refund round-trip | N/A | ❌ No | **P1 HIGH** | Phase 17 PR3 |
| 119d | SKU mapping (Gbox ↔ Lenful) | N/A | ❌ No | **P1 HIGH** | Phase 17 PR4 |
| 119e | Lenful shipping profile per-SKU | N/A | ❌ No | **P1 HIGH** | Phase 17 PR5 |
| 120 | Dropship: AliExpress (full sync) | ⚠️ App | ❌ No | 🔵 DEFERRED Phase 20+ | Importer tool covers product import |
| 121 | Dropship: CJ Dropshipping | ⚠️ App | ❌ No | 🔵 DEFERRED (not opened) | Importer covers |
| 122 | Multi-vendor split | ⚠️ Apps | ❌ No | 🔵 DEFERRED Phase 20+ | Single Lenful vendor now |
| **=== PRODUCT IMPORTER TOOL (NEW — OWNER DIRECTIVE 2026-04-24) ===** | | | | | |
| 122a | **AliExpress single-URL import** | ⚠️ App (DSers) | ❌ No | **P1 HIGH** | Phase 17 PR10 — DS Center API |
| 122b | **1688.com import** | ❌ No Shopify option | ❌ No | **P1 HIGH** | Phase 17 PR11 — scrape-based |
| 122c | Taobao import | ❌ No Shopify option | ❌ No | **P2 HIGH** | Phase 18 PR5 — scrape |
| 122d | Shopee import | ⚠️ App | ❌ No | **P2 HIGH** | Phase 18 PR5 — limited API |
| 122e | Temu import | ❌ No Shopify option | ❌ No | **P3 LOW** | Phase 20+ |
| 122f | Amazon import (PA-API 5.0) | ⚠️ App | ❌ No | **P3 LOW** | Phase 20+ |
| 122g | eBay import (Finding API) | ⚠️ App | ❌ No | **P3 LOW** | Phase 20+ |
| 122h | Image download to Gbox CDN | ✅ Via apps | ❌ No | **P1 HIGH** | Phase 17 PR12 |
| 122i | Variant mapping (color/size) | ✅ Via apps | ❌ No | **P1 HIGH** | Phase 17 PR12 |
| 122j | Markup rules engine | ✅ Via apps | ❌ No | **P1 HIGH** | Phase 17 PR13 |
| 122k | Bulk CSV URL import | ✅ Via apps | ❌ No | **P2 HIGH** | Phase 17 PR14 |
| 122l | Chrome extension (1688/Taobao) | ⚠️ Via apps | ❌ No | **P2 HIGH** | Phase 18 PR6 |
| 122m | Auto-sync price/stock (cron) | ✅ Via apps | ❌ No | 🔵 DEFERRED Phase 20+ | Importer v3 |
| 122n | Review import | ⚠️ Apps | ❌ No | 🔵 DEFERRED Phase 20+ | Importer v3 |
| 122o | Auto-fulfillment bridge (AE DS) | ✅ Via apps | ❌ No | 🔵 DEFERRED Phase 20+ | Importer v3 |
| **=== DEVELOPER ===** | | | | | |
| 123 | REST API | ✅ Full | ✅ Full (Shopify-compat) | ✓ EQUAL | |
| 124 | GraphQL Admin API | ✅ Yes | ❌ No | **P2 MEDIUM** | |
| 125 | GraphQL Storefront API | ✅ Yes | ❌ No | **P1 HIGH** | Blocks Hydrogen |
| 126 | Webhooks | ✅ Yes | ✅ Yes | ✓ EQUAL | |
| 127 | App store / marketplace | ✅ 8,000+ | ❌ No | **P3 LOW** | Long-term |
| 128 | Custom app scopes | ✅ Yes | ❌ No | **P2 MEDIUM** | |
| 129 | Official SDK (JS/Ruby) | ✅ Yes | ❌ No | **P3 LOW** | |
| 130 | Postman collection | ✅ Yes | ⚠️ Partial | **P3 LOW** | |
| **=== MOBILE & POS ===** | | | | | |
| 131 | Native iOS app | ✅ Yes | ❌ No | **P3 LOW** | Strategic |
| 132 | Native Android app | ✅ Yes | ❌ No | **P3 LOW** | Strategic |
| 133 | Admin mobile app | ✅ Yes | ❌ No | **P3 LOW** | |
| 134 | POS system | ✅ Shopify POS | ❌ No | **P3 LOW** | Not applicable POD/dropship |

### Tổng kết bảng (sau scope lock)

- **✓ EQUAL hoặc Gbox BETTER:** 56 features (~38%)
- **⚠️ P1 HIGH/CRITICAL gaps (scope Phase 15-19):** ~36 features (~24%) — PayPal prod + Fraud + Lenful + HS codes + US tax + Importer
- **⚠️ P2 MEDIUM gaps (scope Phase 15-19):** ~15 features (~10%)
- **⚠️ P3 LOW gaps:** ~10 features (~7%)
- **🔵 DEFERRED Phase 20+:** ~30 features (~20%) — EU/UK/Canada market, Apple Pay/Google Pay/Klarna, direct carrier APIs, Printful/Printify
- **✗ Not applicable:** ~3 features (~2%, POS)

**Scoped verdict:** ~72% parity nhưng **sau scope lock, chỉ ~35% còn là blocker** (PayPal prod + Fraud FULL + Lenful + Importer + HS + US tax + 5 risks). Các gaps liên quan EU / multi-vendor POD / direct carrier APIs đều DEFERRED — không phải blocker cho Oct 2026 launch.

---

## 🚨 PHẦN 3: GAP ANALYSIS (SCOPED: US + LENFUL + PAYPAL — POST OWNER REVIEW)

### Gap critical cho launch (P0 hoặc P1-CRITICAL)

**Nhóm 1 — Platform Hardening (5 RISKS NGHIÊM TRỌNG — FIX NGAY, Phase 15)**

| # | Gap | Impact | Remediation | Effort |
|---|-----|--------|-------------|--------|
| 1 | **Row-Level Security (RLS)** | Data leak cross-shop nếu bug query → vi phạm Iron Rule 2 | PG RLS policies cho shop_id isolation, session variable `app.current_shop_id`, 100% integration test cover | 2 tuần |
| 2 | **Transaction isolation** | Race condition oversell inventory, double-spend gift card, duplicate order numbers | Explicit `SERIALIZABLE` / `REPEATABLE READ` cho checkout + gift card + inventory adjust | 3 ngày |
| 3 | **Automated backup + restore drill** | DB crash = data loss, không có recovery procedure | `pg_dump` cron → S3/B2 + nightly restore drill to staging + RTO/RPO docs | 3 ngày |
| 4 | **Customer 2FA** | US high-value accounts bị ATO (account takeover) → chargeback + support cost | TOTP + email OTP fallback + device trust list + recovery codes (merchant already has TOTP) | 1 tuần |
| 5 | **Webhook idempotency + reconciliation** | PayPal/Stripe duplicate charges, double-fulfillment cross-border cực đắt | `idempotency_key` column + dedup handler + nightly reconciliation job vs PayPal | 1 tuần |

**Nhóm 2 — 3 Gateways tích hợp HOÀN CHỈNH (Phase 16 primary)**

> Gbox ưu tiên PayPal 100% (BN code `Gbox_Ecom`, app partner). Nhưng Stripe + Airwallex **cũng phải tích hợp hoàn chỉnh** để sellers có quyền chọn. Cả 3 gateways đều prod-hardened với feature parity ở mức cơ bản: charge + 3DS + refund + dispute + payout + reconciliation. Khác biệt chỉ ở UX prominence (PayPal default on new shop).

**PayPal (priority default):**

| # | Gap | Impact | Remediation | Effort |
|---|-----|--------|-------------|--------|
| 6 | PayPal Checkout (Smart Buttons) prod-verified | Conversion + trust seal cho US buyers | Prod client ID, Smart Payment Buttons, vault, shipping calc callback, return_url/cancel_url | 1 tuần |
| 7 | PayPal Pay via Card (Advanced Checkout) | US buyers không có PayPal account vẫn trả được | PayPal Advanced Checkout (card fields hosted), 3DS required, CAPTCHA | 1 tuần |
| 8 | PayPal refund + partial | Customer service xử lý hoàn tiền | Admin UI refund button, partial refund logic, email notify | 4 ngày |
| 9 | PayPal chargeback + dispute auto-evidence | Giảm chargeback loss, auto-submit evidence | Webhook `CUSTOMER.DISPUTE.CREATED` → collect tracking + order + invoice PDF → submit to Disputes API | 1 tuần |
| 10 | PayPal payout/settlement reporting | Seller track doanh thu | Daily settlement webhook + reconciliation table + admin report | 4 ngày |

**Stripe (FULL integration — sellers có quyền chọn):**

| # | Gap | Impact | Remediation | Effort |
|---|-----|--------|-------------|--------|
| 11 | Stripe prod setup + webhook verify + idempotency | Sellers chọn Stripe có prod-ready gateway | Prod key + webhook signature verify + `idempotency_key` column + retry logic | 3 ngày |
| 12 | Stripe Payment Intents (card + SCA/3DS) | EU-compliant card flow (US 3DS optional nhưng nên enable) | Payment Intents API + 3DS auto-trigger based on card issuer | 1 tuần |
| 13 | Stripe refund + partial refund | Feature parity với PayPal | Admin UI + Refunds API + email notify | 3 ngày |
| 14 | Stripe Radar (fraud) | Built-in fraud rules + ML scoring | Enable Radar, configure rules, sync verdicts với Gbox fraud engine | 4 ngày |
| 15 | Stripe dispute + chargeback auto-evidence | Submit evidence via Stripe Disputes API | Webhook `charge.dispute.created` → collect + submit Disputes API | 1 tuần |
| 16 | Stripe payout/settlement | Daily payouts + Balance Transactions reconciliation | `Balance Transactions` API + admin report | 4 ngày |
| 17 | Stripe Connect (optional, P2) | Nếu marketplace model cần | Stripe Connect Standard account, P2 defer nếu không cần | N/A P2 |

**Airwallex (FULL integration — merchant receiving alternative):**

| # | Gap | Impact | Remediation | Effort |
|---|-----|--------|-------------|--------|
| 18 | Airwallex merchant KYC + account create | Onboarding seller sang Airwallex | API: create corporate account + KYC submission + status webhook | 1 tuần |
| 19 | Airwallex collect flow (customer → Airwallex) | Card + bank transfer + local methods cho customer | Payment Links / Payment Intents, webhook on success | 1 tuần |
| 20 | Airwallex pay flow (Airwallex → VN/BD bank) | Settlement về tài khoản VND/BDT | Payouts API + batch scheduling + FX lock | 1 tuần |
| 21 | Airwallex multi-currency wallet | Hold USD/EUR/GBP/CAD → convert optimal | `wallet-balances` API + currency convert flow | 4 ngày |
| 22 | Airwallex dispute handling | Feature parity với PayPal/Stripe | Webhook `payment_intent.disputed` + evidence submission | 3 ngày |
| 23 | Airwallex settlement reporting | Seller track doanh thu Airwallex | Transactions API + reconciliation | 3 ngày |
| 24 | Airwallex FX rates + spot-rate lock | Sellers lock rate khi quote to customer | `/api/v1/fx/rates` + spot-rate UI trong checkout | 3 ngày |

**Gateway switcher UI (new for v3):**

| # | Gap | Impact | Remediation | Effort |
|---|-----|--------|-------------|--------|
| 25 | Gateway selection admin UI | Seller chọn gateway nào làm primary | Admin settings page: PayPal (default) | Stripe | Airwallex; radio + test connection | 4 ngày |
| 26 | Per-shop gateway config + credentials | Each seller có credentials riêng | Encrypted credentials per-shop (AES-256-GCM) + UI form | 3 ngày |
| 27 | Gateway fallback logic | Primary fails → fallback gateway | Checkout logic: try primary → retry fallback → error gracefully | 4 ngày |
| 28 | Multi-gateway on checkout (customer pick) | Customer chọn PayPal hoặc Stripe hoặc Airwallex | Checkout UI: 3 buttons, default PayPal biggest; seller có thể disable methods | 4 ngày |

**Nhóm 3 — Fraud Engine FULL (Phase 16 parallel)**

> Owner directive: "làm cho a shell UI hoàn chỉnh và hoàn hảo tránh chargeback"

| # | Gap | Impact | Remediation | Effort |
|---|-----|--------|-------------|--------|
| 13 | Velocity rules engine | Card testing, burst order patterns | Per-card/per-IP/per-email velocity windows (1h, 24h, 7d) + configurable limits | 1 tuần |
| 14 | BIN lookup + geo mismatch | Detect card origin ≠ billing country | BIN DB (local cached) + geo IP + flag mismatch ≥ score threshold | 4 ngày |
| 15 | Device fingerprint | Re-identify fraud actors across sessions | Fingerprint.js + server-side hash + link to fraud_events table | 4 ngày |
| 16 | Blacklist (email/IP/card/address) | Block known fraud patterns | Admin UI CRUD + auto-populate từ past fraud + import từ feed | 3 ngày |
| 17 | Manual review queue | High-risk orders hold chờ review | Score ≥ threshold → status='review_hold' + admin queue page + approve/reject flow | 1 tuần |
| 18 | Auto-cancel hold > N hours | Prevent stuck orders | Cron job: review_hold + age > 48h → notify seller, escalate | 2 ngày |
| 19 | Multi-currency product display | US customer thấy giá VND → drop off cart | Session currency (USD default for US visitor), server-side conversion (FX rate cache), seller nhập VND, display USD | 1 tuần |

**Nhóm 4 — Lenful Native Fulfillment (Phase 17 primary)**

> Owner directive: "Gbox sẽ đảm nhận việc fullfillment và hoàn toàn qua Lenful, việc setup sourcing hoặc agent logictics Lenful sẽ lo tất cả"

| # | Gap | Impact | Remediation | Effort |
|---|-----|--------|-------------|--------|
| 20 | Lenful order push API | Auto-push order from Gbox → Lenful production queue | REST: `POST /lenful/orders` (order + products + shipping address), retry + idempotency | 1 tuần |
| 21 | Production status sync | Seller + customer biết order đang ở đâu | Webhook `lenful.status.changed` (queued/printing/packed/shipped) → update Gbox order | 3 ngày |
| 22 | Tracking number pull | Customer nhận tracking email | Webhook `lenful.shipped` với tracking → update order + trigger email | 2 ngày |
| 23 | Cancel/refund round-trip | Handle customer cancel trước khi ship | `POST /lenful/orders/:id/cancel` + verify Lenful state + refund if cancellable | 4 ngày |
| 24 | SKU mapping (Gbox ↔ Lenful) | Seller catalog ≠ Lenful catalog | Mapping table: gbox_product_id + variant_id → lenful_sku + print_area + mockup | 4 ngày |
| 25 | Shipping profile per Lenful SKU | Flat rates based on product type + destination | Profile: SKU + destination → cost + ETA (stored from Lenful catalog) | 3 ngày |

**Nhóm 5 — HS Codes + Commercial Invoice (Phase 17 parallel)**

| # | Gap | Impact | Remediation | Effort |
|---|-----|--------|-------------|--------|
| 26 | HS code field on products | US CBP reject/hold package nếu thiếu | `ALTER products ADD hs_code VARCHAR(10), country_of_origin CHAR(2)` + UI + autocomplete 150-code seed | 4 ngày |
| 27 | Commercial Invoice PDF gen | UPS/FedEx/DHL commercial parcels | PDF library (pdfkit/puppeteer) + template: products + HS + COO + value + exporter + importer | 1 tuần |
| 28 | CN22/CN23 form gen (optional) | USPS international post parcels | Smaller PDF + USPS regulation format | 3 ngày |
| 29 | De minimis threshold UI warning | US = $800, cảnh báo nếu order value vượt → extra duty | Checkout UI + admin order page warning | 2 ngày |
| 30 | Country-of-origin required validation | Block save product nếu missing | Form validation + data migration cho existing products | 2 ngày |

**Nhóm 6 — US Sales Tax Nexus (Phase 18 primary)**

| # | Gap | Impact | Remediation | Effort |
|---|-----|--------|-------------|--------|
| 31 | US state nexus engine | Wayfair 2018 — seller phải collect sales tax nếu vượt threshold per state | Nexus config per-shop (enabled states + threshold tracking), 10-15 major states (CA, TX, NY, FL, WA, etc.) | 1 tuần |
| 32 | Marketplace facilitator flag | Nếu seller bán qua marketplace (Amazon, eBay), marketplace đã nộp tax | Per-order flag + tax exemption logic | 3 ngày |
| 33 | US sales tax calc at checkout | Display tax correctly in cart + checkout | Destination-based + state + county + city rates (seed major metros) | 1 tuần |
| 34 | Tax report export (state filing) | Monthly/quarterly tax filing prep | Admin report: per-state collected + refunded + net | 3 ngày |
| 35 | Tax-exempt customer (B2B) | Resale certificate upload + validation | Customer tax exemption field + certificate storage + admin review | 3 ngày |

**Nhóm 7 — Product Importer (Phase 17-18, NEW per owner directive)**

> Owner directive (2026-04-24): "a nghĩ là phần importer này rất cần cho những người làm dropship, em lên kế hoạch viết cho a 1 tool importer cho toàn bộ các nền tảng như aliexpress. 1688..."

Đây là **tool riêng biệt** (có thể là app EmDash plugin hoặc built-in admin page) cho cross-border dropship sellers.

**Supported platforms (priority order):**
1. **AliExpress** — P0, biggest source, có official API (Dropshipping Center) + OAuth seller auth
2. **1688.com** — P0, Chinese B2B, không có public API → scrape + Chrome extension path
3. **Taobao** — P1, consumer marketplace, no public API → scrape
4. **Shopee** — P1 (SEA), có open API nhưng giới hạn
5. **Temu** — P2, mới, no API → scrape
6. **Amazon** — P2, có PA-API 5.0 (cần approved account)
7. **eBay** — P2, có Finding API + Browse API (official)
8. **Walmart** — P3, marketplace API

**Core features (v1):**

| # | Feature | Detail | Effort |
|---|---------|--------|--------|
| 36 | Single-URL import (paste + fetch) | User paste AliExpress URL → fetch title/desc/images/variants/price | 1 tuần (per platform) |
| 37 | Markup rules engine | Auto-apply markup: fixed (+$5), %, or tier (cost < $10 → ×3, $10-50 → ×2, etc.) | 3 ngày |
| 38 | Image download to Gbox CDN | Copy source images → CDN (R2/S3), avoid hotlink | 3 ngày |
| 39 | Variant mapping | Source color/size → Gbox variants | 4 ngày |
| 40 | Description cleanup | Strip source links, translate (optional), convert HTML → safe | 3 ngày |
| 41 | Currency conversion (CNY/USD) | Source price → display price in seller's currency | 2 ngày |
| 42 | Bulk import (CSV URL list) | Paste 100 URLs → batch fetch + import | 3 ngày |
| 43 | Chrome extension (1688/Taobao) | Inject "Import to Gbox" button on source page | 1 tuần |
| 44 | Duplicate detection | Warn nếu import URL đã có trong store | 2 ngày |

**Advanced (v2, Phase 18 if time permits):**
- Price/stock auto-sync (cron nightly fetch + update)
- Review import (copy source reviews, filter profanity, translate)
- Fulfillment bridge (Gbox order → AliExpress DS order auto-place via API)

**Effort v1:** ~6-8 tuần người (tight cho Phase 17-18 nếu parallel với Lenful).

**Nhóm 8 — DEFERRED (Phase 20+ after Oct 2026 launch)**

| # | Item | Why deferred | Unlock later |
|---|------|--------------|---------------|
| D1 | USPS/UPS/FedEx/DHL live rate APIs | Lenful + agent logistics lo sourcing + carrier | Khi Lenful cần multi-carrier routing tự động |
| D2 | Carrier direct label print API | Agent cấp PDF, Gbox chỉ attach | Khi volume cao cần self-serve |
| D3 | EU market (IOSS + UK VAT) | US-first per owner directive | Khi mở EU strategic push |
| D4 | Canada GST/PST/HST | US-first focus | Cùng EU expansion |
| D5 | Apple Pay / Google Pay | PayPal 100% trong Phase 15-19 | Nếu conversion data chứng minh cần |
| D6 | Klarna / Afterpay BNPL | PayPal có Pay-in-4 (built-in) | Sau khi PayPal Pay-in-4 enable |
| D7 | Printful / Printify / Gelato | Lenful-only per owner | Không mở — Lenful strategic |
| D8 | CJ Dropshipping | Importer đã cover AliExpress + 1688 | Nếu seller demand |
| D9 | Multi-vendor order split | Single Lenful vendor hiện tại | Khi có vendor khác |
| D10 | Loyalty + SMS + Live chat | Post-launch growth features | Phase 20 experience push |

**Tổng effort đã scoped (Phase 15-19): ~42 tuần người** → team 3 người × 14 tuần parallel + 1 người fulltime 6 tháng. Oct 2026 launch khả thi.

---

## 🛠 PHẦN 4: ROADMAP TỚI OCT 2026 (5-6 THÁNG) — US + LENFUL + PAYPAL FOCUS

> **Timeline:** 22 tuần (5.5 tháng) từ May 2026 → Oct 2026. Team 3-4 devs parallel.

### Phase 15 — FOUNDATION LOCK (Tháng 1, 6 tuần) — 5 RISKS FIX

**Mục tiêu:** Fix ngay 5 risks nghiêm trọng + foundation cho mọi phase sau.

- **PR1 (2 tuần): Row-Level Security (RLS)** — PG RLS policies cho shop_id isolation, session var `app.current_shop_id`, integration test cover 100% cross-shop read/write, rollback guard
- **PR2 (3 ngày): Transaction isolation levels** — Explicit `SERIALIZABLE` / `REPEATABLE READ` cho checkout + inventory adjust + gift card redeem; retry logic on serialization failure
- **PR3 (3 ngày): Automated backup + restore drill** — `pg_dump` cron → S3/B2; nightly restore-to-staging drill; RTO/RPO docs; ops runbook
- **PR4 (1 tuần): Webhook idempotency + reconciliation** — Add `idempotency_key` columns to `paypal_webhook_events` + `stripe_webhook_events`; dedup handler; nightly reconciliation job vs PayPal API (orders matching)
- **PR5 (1 tuần): Customer 2FA (opt-in)** — TOTP + email OTP fallback + device trust list + recovery codes (8 codes SHA-256 hashed); customer settings page UI
- **PR6 (3 ngày): Per-shop API keys** — Generate/rotate + scopes + rate limit per key; for Phase 20+ app ecosystem but seed now
- **PR7 (4 ngày): Pen-test prep + security audit** — Static analysis (CodeQL), dependency audit, secrets scan, OWASP top-10 self-assessment

**Smoke coverage:** +40 tests. **Risk:** RLS migration trên 89 tables cần ordering carefully. **Output:** Iron Rule 1+2 fully enforced, audit-ready.

---

### Phase 16 — PAYMENT GATEWAYS FULL (PAYPAL + STRIPE + AIRWALLEX) + FRAUD + MULTI-CURRENCY DISPLAY (Tháng 2-4, 10 tuần)

**Mục tiêu:** PayPal prod-hardened (priority default) + **Stripe FULL + Airwallex FULL (seller choice)** + Gateway switcher UI + Fraud engine FULL + Multi-currency display. Sellers pick gateway khi setup shop, Gbox defaults mới = PayPal.

**Execution strategy:** 6 parallel tracks với 2 waves:
- **Wave 1 (Weeks 1-6) — Beta-ready:** PayPal + Fraud + Display
- **Wave 2 (Weeks 5-10, overlap) — GA-ready:** Stripe FULL + Airwallex FULL + Gateway switcher

**Với 2 dev streams:** 10 tuần total. **Với 1 dev:** ~14 tuần (Phase 16 block to Tháng 5).

---

**Track A — PayPal priority default (Wave 1, 5 tuần sequential — owner directive: default ordering + UI prominence):**
- **PR1 (1 tuần): PayPal Checkout (Smart Buttons) prod** — Prod client ID, Smart Payment Buttons, vault, shipping callback, return/cancel URLs, BN code `Gbox_Ecom` enforce. **Biggest button on checkout** (visual prominence).
- **PR2 (1 tuần): PayPal Pay via Card (Advanced Checkout)** — Card fields hosted, 3DS required, CAPTCHA on failure, Hosted Fields PCI SAQ-A
- **PR3 (4 ngày): PayPal refund + partial refund** — Admin UI refund flow, partial refund calc, email notify customer + seller
- **PR4 (1 tuần): PayPal chargeback + dispute auto-evidence** — Webhook `CUSTOMER.DISPUTE.CREATED` → auto-collect tracking + order + invoice → submit to Disputes API
- **PR5 (4 ngày): PayPal payout/settlement reporting** — Daily settlement webhook + reconciliation table + admin report per-shop

**Track B — Fraud engine FULL (Wave 1 parallel, 3 tuần — owner directive: hoàn chỉnh, tránh chargeback):**
- **PR6 (1 tuần): Velocity + BIN + geo rules** — Velocity windows 1h/24h/7d per card/IP/email; BIN lookup (cached DB); geo mismatch flag
- **PR7 (4 ngày): Device fingerprint + blacklist** — Fingerprint.js + server hash + blacklist CRUD (email/IP/card/address) + auto-populate from past fraud
- **PR8 (1 tuần): Manual review queue** — Score ≥ threshold → `status='review_hold'`; admin queue page with approve/reject/escalate; email notify seller
- **PR9 (2 ngày): Auto-cancel stale holds** — Cron: age > 48h on review_hold → notify

**Track C — Multi-currency display (Wave 1 parallel, 1 tuần — owner directive: fix luôn kèm):**
- **PR10 (1 tuần): Session-based currency** — Default USD for US visitor (geo IP), currency picker UI, FX rate cache (daily refresh từ openexchangerates.org); server-side conversion; seller nhập VND, display USD

---

**Track D — Stripe FULL (Wave 2, 4 tuần — owner directive: tích hợp hoàn chỉnh, seller choice):**
- **PR11 (3 ngày): Stripe prod setup + webhook** — Prod keys per-shop, webhook endpoint với idempotency + signature verification + dedup via `stripe_event_id` UNIQUE; `platform_settings` encrypted config
- **PR12 (1 tuần): Stripe Payment Intents + SCA/3DS** — Full Payment Intents flow, `payment_method_types=['card']`, automatic 3DS for EEA cards, SCA handling, confirmation flow matching PayPal UX
- **PR13 (3 ngày): Stripe refund + partial** — Admin UI refund (matches PayPal PR3), email notify, audit trail
- **PR14 (4 ngày): Stripe Radar (fraud)** — Enable Radar rules, feed custom signals (velocity + BIN from Track B), read `outcome.risk_level` → merge vào Gbox fraud engine
- **PR15 (1 tuần): Stripe disputes + chargeback auto-evidence** — Webhook `charge.dispute.created` → auto-collect tracking + order + invoice + proof-of-delivery → submit via Disputes API (parity với PayPal PR4)
- **PR16 (4 ngày): Stripe payout/settlement** — Balance Transactions API daily cron → reconciliation table + admin report (parity với PayPal PR5)

**Track E — Airwallex FULL (Wave 2 parallel, 4 tuần — owner directive: tích hợp hoàn chỉnh, seller choice):**
- **PR17 (1 tuần): Airwallex merchant KYC + account create** — OAuth/API key, business verification flow, KYC document upload UI, sandbox → prod promotion
- **PR18 (1 tuần): Airwallex collect flow (customer pays USD)** — Payment Intent API, hosted checkout OR card form, 3DS, webhook signature verification
- **PR19 (1 tuần): Airwallex pay flow (payout to VN/BD bank)** — Beneficiary management, Payouts API, FX conversion USD→VND/BDT, bank account verification
- **PR20 (4 ngày): Airwallex multi-currency wallet** — Account holding USD/VND/BDT balances, transfer between currencies, admin UI
- **PR21 (3 ngày): Airwallex dispute handling** — Dispute webhook → evidence upload → auto-reply (parity với PayPal + Stripe)
- **PR22 (3 ngày): Airwallex settlement reporting** — Daily statement API → reconciliation + admin report
- **PR23 (3 ngày): Airwallex FX rates + spot-rate lock** — Rate quote API, 24h rate lock option for predictable settlement, FX fee display

**Track F — Gateway switcher + multi-gateway checkout (Wave 2 final, 1.5 tuần — NEW for v3):**
- **PR24 (4 ngày): Gateway selection admin UI** — Shop settings page: pick primary gateway + enable alternatives; PayPal defaulted pre-checked; warnings nếu chọn gateway chưa KYC
- **PR25 (3 ngày): Per-shop gateway config + encrypted credentials** — Migration: `shop_payment_gateways` table với AES-256-GCM encrypted creds (matches OAuth token crypto from Phase 11 PR3)
- **PR26 (4 ngày): Gateway fallback logic** — Primary gateway fails → auto-retry with secondary (seller opt-in); log failover events; no customer-facing error if fallback succeeds
- **PR27 (4 ngày): Multi-gateway checkout UI** — Customer sees enabled gateways on checkout với PayPal prominent (biggest button). If only PayPal enabled, card form fallback via Advanced Checkout. If multiple, tabbed UI.

---

**Phase 16 totals:**
- **27 PRs** (was 12 in v2)
- **10 tuần** parallel (14 tuần single-dev)
- **Smoke coverage:** +220 tests (PayPal 60 + Stripe 50 + Airwallex 50 + Fraud 40 + Switcher 20)

**Risks:**
1. Stripe Radar pricing ($0.05/transaction screened) — budget impact ~$500/mo @ 10k tx/mo. Accept as cost of doing business.
2. Airwallex KYC latency (2-5 business days) — sellers may be frustrated. Document expected timeline in onboarding wizard.
3. Gateway fallback complexity — test matrix for PayPal→Stripe, Stripe→Airwallex, etc. Limit fallback to 1 retry to avoid customer confusion.
4. 3-gateway smoke coverage triples cost of end-to-end test runs. Mitigate with per-gateway tagged smokes (skip non-active by default, full matrix weekly).

**Output:** PayPal default prod-battle-tested với biggest checkout button; **Stripe + Airwallex full parity** (3DS, Radar/Airwallex fraud, disputes, payouts, settlement); sellers pick gateway via admin UI với per-shop encrypted credentials; fallback logic; chargeback defense via fraud engine; US buyers see USD.

---

### Phase 17 — LENFUL FULFILLMENT + HS CODES + IMPORTER v1 (Tháng 4, 5 tuần)

**Mục tiêu:** Lenful-native fulfillment loop + Commercial Invoice + Importer foundation.

**Lenful fulfillment (owner directive: Lenful-only):**
- **PR1 (1 tuần): Lenful order push** — `POST /lenful/orders` API client, retry + idempotency, SKU mapping lookup
- **PR2 (3 ngày): Status sync + tracking** — Webhook `lenful.status.changed` + `lenful.shipped` → update Gbox order + trigger customer email
- **PR3 (4 ngày): Cancel/refund round-trip** — `POST /lenful/orders/:id/cancel` + state verify + refund nếu cancellable
- **PR4 (4 ngày): SKU mapping table + UI** — `gbox_product_variant_id` → `lenful_sku` + `print_area` + `mockup_url`; admin page để map
- **PR5 (3 ngày): Shipping profile per Lenful SKU** — Flat rates per SKU + destination (US states); catalog pulled từ Lenful periodic

**HS codes + Commercial Invoice:**
- **PR6 (4 ngày): HS code field + seed** — Migration: `ALTER products ADD hs_code VARCHAR(10), country_of_origin CHAR(2)`; seed 150 common codes; autocomplete UI
- **PR7 (1 tuần): Commercial Invoice PDF gen** — pdfkit/puppeteer template: items + HS + COO + value + exporter + importer; attach to order admin page
- **PR8 (3 ngày): CN22/CN23 form gen (optional)** — USPS format; smaller PDF for low-value shipments
- **PR9 (2 ngày): De minimis warning + validation** — Order value > $800 → warn seller; COO required on product save

**Importer v1 (owner directive NEW — AliExpress + 1688 priority):**
- **PR10 (1 tuần): AliExpress single-URL import** — DS Center API; paste URL → fetch title/desc/images/variants/price; markup rules; CNY→USD convert
- **PR11 (1 tuần): 1688 single-URL import** — Scrape-based (no public API); title/desc/variants/price parse; Chinese → English description cleanup
- **PR12 (4 ngày): Image download + variant mapping** — Copy source images → Gbox CDN (R2/S3); variant color/size map to Gbox schema
- **PR13 (3 ngày): Markup rules engine** — Fixed / % / tier-based markup config per shop
- **PR14 (3 ngày): Bulk CSV URL import** — Parse URL list, batch fetch, queue + progress

**Smoke coverage:** +80 tests. **Risk:** 1688 scrape may break nếu anti-bot thay đổi. **Output:** Orders flow to Lenful automatically; customs paperwork auto-gen; sellers import products từ AliExpress + 1688.

---

### Phase 18 — US SALES TAX + IMPORTER v2 + LABEL FLOW (Tháng 5, 3 tuần)

**Mục tiêu:** US tax compliance + importer expansion + shipping label "attach from agent" flow.

**US sales tax nexus:**
- **PR1 (1 tuần): Nexus engine** — Per-shop config: enabled states + threshold tracking (economic nexus); 10-15 major states (CA, TX, NY, FL, WA, IL, PA, OH, GA, NC, NJ, VA, AZ, CO)
- **PR2 (1 tuần): Tax calc at checkout** — Destination-based + state + county + city rates (seed major metros ~100 ZIPs); display line in cart + checkout
- **PR3 (3 ngày): Tax report export** — Per-state collected + refunded + net; CSV export for accountant; filing prep
- **PR4 (3 ngày): B2B tax-exempt customer** — Resale certificate upload + admin review + per-customer exemption flag

**Importer v2 (expansion):**
- **PR5 (1 tuần): Taobao + Shopee importer** — Scrape-based (Taobao) + limited Shopee API
- **PR6 (1 tuần): Chrome extension (1688/Taobao)** — Browser extension injecting "Import to Gbox" button on source pages; OAuth to shop

**Shipping label "attach from agent" flow:**
- **PR7 (3 ngày): Label PDF attach flow** — Admin order page upload label PDF (from agent) → attach to order → print button; audit trail

**Smoke coverage:** +50 tests. **Risk:** Tax rate accuracy (use external lib like `us-tax` or Tax API provider). **Output:** US sales tax collected per-state; importer covers 5 platforms; agent-label flow operational.

---

### Phase 19 — EXPERIENCE POLISH + LAUNCH PREP (Tháng 5-6, 2 tuần)

**Mục tiêu:** Launch polish + mobile audit.

- **PR1 (4 ngày): SMS via Twilio** — Wire + template registry + opt-in flows (US phone numbers); order status SMS
- **PR2 (3 ngày): Mobile-first theme validation** — Storefront mobile audit + responsive enforcement
- **PR3 (3 ngày): Web push notifications** — Service worker + VAPID + opt-in; abandoned cart push + order update
- **PR4 (3 ngày): Structured data (JSON-LD)** — Product/article/breadcrumb schemas (US Google SEO)
- **PR5 (2 ngày): Launch readiness checklist** — Pen-test report review, backup drill verify, load test, go/no-go review

**Launch:** **Oct 2026** 🎯 cho Mid-market + SMB POD/Dropship sellers VN/BD bán **US market**.

---

### Phase 20+ (Post-Launch) — Strategic Long-Term

**From gác-lại list (owner-directive defers):**
- International shipping live rates (USPS/UPS/FedEx/DHL direct API) — khi Lenful cần multi-carrier auto-routing
- Carrier label print API — khi volume vượt agent capability
- **EU market expansion** — IOSS + UK VAT + Canada GST/PST (strategic push sau khi US stable)
- Apple Pay / Google Pay / Klarna / Afterpay — khi conversion data justify
- Printful / Printify / Gelato / CustomCat — **không mở** (Lenful-only strategic)
- CJ Dropshipping — covered by importer đã có
- Live chat + Loyalty program v1 — Phase 20 experience push

**Long-term strategic:**
- GraphQL API (6-8 tuần)
- Theme marketplace (3 tháng)
- Native mobile apps (6 tháng)
- POS (N/A for target cross-border)
- App Store/plugin ecosystem (long-term, 6+ tháng)
- Multi-touch attribution ML (4-6 tuần)
- Importer v3: Amazon PA-API + eBay + Walmart + Temu

---

## 🔗 PHẦN 5: MODULE CONNECTIONS (DEPENDENCIES)

### Dependency Graph (Hierarchical)

```
┌─────────────────────────────────────────────────────────┐
│                    APPS (UI Layer)                      │
├─────────────────────────────────────────────────────────┤
│  store-admin │ god-admin │ accounts │ storefront │ ...  │
└──────────────────────────┬──────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────┐
│                packages/core (Business Logic)           │
├─────────────────────────────────────────────────────────┤
│  77 modules: auth, payments, orders, email, support...  │
└──────────────────────────┬──────────────────────────────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
              ▼            ▼            ▼
┌─────────────────┐  ┌──────────┐  ┌──────────────────┐
│  packages/db    │  │packages/ │  │ packages/        │
│  (Schema +      │  │api       │  │ storefront       │
│   migrations)   │  │          │  │                  │
└─────────────────┘  └──────────┘  └──────────────────┘
```

**Key observations:**
- **0 circular dependencies** (verified)
- Apps → core → db pattern enforced
- `packages/core` is the hub (imported by every app)
- `packages/db` has no dependencies on core (clean separation)

### Most-imported Core Modules

1. **`auth/session`** — used by all 6 apps (session middleware)
2. **`db/schema/tables`** — used by every service layer (Kysely types)
3. **`payments/paypal-partner`** — checkout + storefront + admin
4. **`email/send`** — 40+ service files (notifications, automations)
5. **`audit`** — all mutation endpoints (compliance)
6. **`cache`** — all read-heavy queries (Redis + LRU)

### Shared Infrastructure Services

```
┌───────────────────────────────────────────────────┐
│           SHARED INFRASTRUCTURE SERVICES          │
├───────────────────────────────────────────────────┤
│                                                   │
│  🔐 Auth ─────┬── Customer Session                │
│               ├── Staff Session                    │
│               └── API Auth                         │
│                                                    │
│  📧 Email ────┬── Transactional (orders, ship)    │
│               ├── Marketing (campaigns)            │
│               ├── Lifecycle (welcome, win-back)    │
│               ├── Ops (merchant alerts)            │
│               ├── Platform (god-admin)             │
│               └── Legal (GDPR, ToS)                │
│                                                    │
│  💾 Cache ────┬── Redis (primary)                 │
│               ├── LRU (fallback)                   │
│               └── Cloudflare KV (edge)             │
│                                                    │
│  📋 Audit ────┬── Auth events                     │
│               ├── Order events                     │
│               ├── Payment events                   │
│               └── Admin actions                    │
│                                                    │
│  🔄 Jobs ─────┬── BullMQ (primary)                │
│               ├── Scheduled crons                  │
│               └── Event streaming                  │
│                                                    │
└────────────────────────────────────────────────────┘
```

### Critical Data Flow Paths

#### A. Checkout Flow
```
Customer Cart
    │
    ▼
POST /api/2026-04/checkouts  (packages/api)
    │
    ├── Cart validation (core/checkout/service)
    ├── Tax calculation (core/tax/compute)
    ├── Shipping rates (core/shipping/compute)
    ├── Discount apply (core/discounts/apply)
    │
    ▼
PayPal/Stripe Order (core/payments/paypal-partner | stripe)
    │
    ├── Create order row (db/orders)
    ├── Reserve inventory (db/inventory_levels)
    ├── Log audit (core/audit)
    │
    ▼
Webhook received (core/payments/webhooks)
    │
    ├── Verify signature
    ├── Dedup (via row uniqueness)
    ├── Update order status
    ├── Enqueue fulfillment (BullMQ → Lenful)
    ├── Send order confirmation email (core/email/send)
    └── Log delivery (db/email_deliveries)
```

#### B. POD Order Flow (Current: Lenful only)
```
Order Confirmed
    │
    ▼
pushOrderToLenful (core/fulfillment/lenful)
    │
    ├── Map variants to Lenful products
    ├── HMAC-signed API call
    ├── Store Lenful order ID
    │
    ▼
Cron: syncTrackingGlobal (every 15 min)
    │
    ├── Poll Lenful for tracking updates
    ├── Update order.tracking_number
    ├── Send shipment_created email
    └── Fire webhook to merchant
```

### Circular Dependency Risks (Current State)

**Verified 0 circulars** in dependency graph. Monitored via:
- TypeScript strict mode
- ESLint `import/no-cycle` rule
- CI test: scan for imports between packages

---

## ⚖ PHẦN 6: HONEST ASSESSMENT — NƠI GBOX MẠNH, NGANG, YẾU

### 🟢 NƠI GBOX MẠNH HƠN SHOPIFY

1. **Email system depth** — 97 templates vs 50+, forced-send categories, unsubscribe SHA-256, Iron Rule 5 chokepoint
2. **Support ticketing** — Full Phase 12.5 system with SLA, CSAT, canned replies, quiet hours. Shopify Inbox là chat-only
3. **Iron Rule 5 safety** — No god-admin leaks to sellers. Unique architectural decision không có ở Shopify
4. **Liquid engine tests** — 987+ unit tests catches edge cases Ruby Liquid không test
5. **Admin RBAC** — 25-entry permission catalog + per-member overrides. Shopify dùng preset roles
6. **Clone Pro** — Autonomous site cloning. Shopify không có tương đương
7. **Audit retention** — 365 days default vs Shopify 90
8. **Marketing automation** — Full workflow builder (Phase 13 đã lock)
9. **Product variants** — Unlimited vs Shopify 100/product cap
10. **Review moderation** — Profanity filter + photo votes + merchant reply. Shopify Reviews cơ bản hơn

### 🟡 NƠI GBOX NGANG SHOPIFY

1. **Core commerce** — Products, orders, cart, checkout, inventory, returns
2. **Tax US/EU/VN** — Full parity (B2B reverse charge, inclusive/exclusive)
3. **Markets** — Region grouping + currency + language per market
4. **Passkey/WebAuthn** — FIDO2 standard compliance
5. **bcrypt + 2FA staff** — Industry standard
6. **Soft delete + GDPR** — Full right-to-erasure workflow
7. **Webhook + event system** — BullMQ + fan-out
8. **Smart collections** — Rule-based auto-populate
9. **Gift cards** — Full lifecycle (create, deliver, redeem, balance)
10. **Metafields** — Full CRUD với typed values

### 🔴 NƠI GBOX YẾU HƠN SHOPIFY (HONEST — nhưng trong scope lock nhiều không phải blocker)

**Critical blockers (Phase 15-19 phải fix):**
1. **PayPal prod hardening (priority default)** — Partner sẵn nhưng chưa battle-tested. Fix Phase 16 Track A PR1-5.
2. **Stripe FULL integration** — Dev mode only, cần Payment Intents + 3DS + Radar + Disputes + Payouts đầy đủ cho seller choice. Fix Phase 16 Track D PR11-16.
3. **Airwallex FULL integration** — Không có, cần merchant KYC + collect + Payouts + multi-currency wallet + disputes + FX lock cho VN/BD merchants nhận USD. Fix Phase 16 Track E PR17-23.
4. **Gateway switcher UI + per-shop encrypted credentials** — Không có infrastructure cho seller chọn gateway. Fix Phase 16 Track F PR24-27.
5. **Fraud detection** — Shell UI only, Shopify có ML engine. Owner directive: FULL engine + Stripe Radar signal merge. Fix Phase 16 Track B PR6-9 + Track D PR14.
6. **Multi-currency display** — Không show USD cho US visitor. Fix Phase 16 Track C PR10.
7. **Lenful native fulfillment** — Đang manual, cần auto-push. Fix Phase 17 PR1-5.
8. **HS codes + Commercial Invoice** — Missing. Fix Phase 17 PR6-9.
9. **US sales tax nexus engine** — Stub catalog only. Fix Phase 18 PR1-4.
10. **Product Importer tool** — None, Shopify có apps (DSers, AutoDS). Fix Phase 17-18 (NEW).
11. **Webhook idempotency** — Risk double charges (all 3 gateways). Fix Phase 15 PR4.
12. **Customer 2FA** — Missing. Fix Phase 15 PR5.
13. **RLS + transaction isolation + backup** — 3 risks data integrity. Fix Phase 15 PR1-3.

**DEFERRED (yếu hơn Shopify nhưng không phải blocker cho Oct 2026):**
11. Apple Pay / Google Pay — PayPal 100% focus
12. Klarna / Afterpay — PayPal Pay-in-4 đủ
13. IOSS + UK VAT + Canada GST — US-first
14. Printful / Printify / Gelato — Lenful-only strategic
15. Live carrier rate APIs — Lenful + agent logistics lo
16. Direct label print API — Agent cấp PDF
17. Mobile apps (native iOS/Android) — strategic Phase 20+
18. App ecosystem — network effect impossible short-term
19. GraphQL API — Phase 20+
20. Multi-touch attribution — Phase 20+
21. Inventory forecasting (ML) — Phase 20+
22. Custom report builder — Phase 20+
23. Theme marketplace — 1 theme đủ cho launch, expand Phase 20+
24. Loyalty programs — Phase 20+
25. Live chat real-time — Phase 20+

---

## 🎯 PHẦN 7: DEPLOYMENT DECISION MATRIX (US-ONLY + LENFUL + PAYPAL SCOPE)

### Seller Type vs Launch Readiness

**Context:** All sellers = VN/BD based. **US market only** trong Phase 15-19. EU/CA DEFERRED.

| Seller Segment | Customer Market | Phase 15-19 Timeline | Readiness | Blockers |
|----------------|-----------------|----------------------|-----------|----------|
| **POD seller → US** (Lenful fulfillment) | US buyers only | **22 tuần (5.5 tháng)** | 🟢 ON TRACK for Oct 2026 | Phase 15-19 roadmap cover đầy đủ |
| **Dropship seller → US** (imported from AliExpress/1688) | US buyers only | 22 tuần | 🟢 ON TRACK | Importer Phase 17-18 + Lenful fulfillment fallback |
| **Hybrid POD + Dropship → US** | US buyers only | 22 tuần | 🟢 ON TRACK | Full Phase 15-19 |
| **Any seller → US + EU** | US + EU | 22 + 12 extra tuần | 🔵 DEFERRED Phase 20+ | IOSS + UK VAT + Canada GST + EU expansion strategic |
| **Any seller → US + CA** | US + CA | 22 + 6 extra tuần | 🔵 DEFERRED Phase 20+ | Canada GST/PST/HST + Canada Post rates |

**Note:**
- **Lenful** là strategic fulfillment (owner's company) — ship từ VN sang US qua carrier partner. ETA 7-14 ngày (hơn Printful US warehouse ~5-7 ngày, acceptable tradeoff cho launch).
- **Importer tool** đưa AliExpress/1688/Taobao/Shopee products vào Gbox catalog → sellers có thể list + sell → khi đặt hàng, seller tự order trên source platform → fulfillment manual OR defer to Phase 20+ auto-fulfillment bridge.
- Post-launch, nếu EU/CA demand cao → Phase 20 expansion với IOSS + UK VAT + Canada GST.

### Recommendation

**Option A: BETA ĐÓNG (Tháng 3, 12 tuần — sau Phase 15-16)**
- Chỉ fix 5 risks + PayPal prod + fraud engine + multi-currency display
- Beta với 3-5 POD sellers thân thiện → US buyers only
- Learn real-world: chargeback patterns, Lenful bottlenecks, customer UX
- Revenue tính dần + iterate

**Option B: SOFT LAUNCH (Tháng 5, 20 tuần — sau Phase 15-18)**
- Tất cả Phase 15-18 done: security + PayPal + fraud + Lenful native + HS + US tax + Importer
- 10-30 sellers POD + Dropship → US
- Monitor chargebacks + support load

**Option C: FULL LAUNCH (Tháng 6, Oct 2026 — sau Phase 19)**
- Experience polish done
- Public listing + onboarding automation
- Marketing push

**Em recommend:** Làm cả 3 theo thứ tự — A → B → C. Beta đóng Tháng 3 là key value: catch bugs, learn customer behavior, iterate fraud scoring trên real data trước khi full launch.

---

## 📋 PHẦN 8: CRITICAL ISSUES — MUST FIX BEFORE LAUNCH

### Must Fix — Security (Iron Rule 1-5)

1. ✅ **bcrypt password** (done)
2. ✅ **TOTP 2FA staff** (done)
3. ✅ **Rate limit auth** (done)
4. ✅ **CSRF on forms** (done)
5. ✅ **Session cookie flags** (done)
6. ✅ **OAuth token encryption** (done, AES-256-GCM)
7. ✅ **IP allowlist god-admin** (done)
8. ✅ **Iron Rule 5 seller-safe errors** (done, lint checks live)
9. ⚠️ **Customer 2FA** (P1, need before launch for high-value)
10. ⚠️ **Per-shop API keys** (P1 for app ecosystem)
11. ⚠️ **Database RLS policies** (P1 for defense-in-depth)
12. ⚠️ **Pen-test** (scheduled pre-launch)

### Must Fix — Data Integrity

1. ⚠️ **Transaction isolation levels** — set SERIALIZABLE on checkout
2. ⚠️ **Webhook idempotency keys** — add column + dedup
3. ⚠️ **Automated backup cron** — pg_dump + cloud storage + test restore
4. ⚠️ **Backup/restore runbook** — documented procedure
5. ⚠️ **RLS policies** — PostgreSQL shop_id isolation

### Must Fix — Payments (3 GATEWAYS FULL, PAYPAL PRIORITY — owner directive v3)

**PayPal priority default (Track A, 5 PRs):**
1. ⚠️ **PayPal Checkout (Smart Buttons) prod** — BN code `Gbox_Ecom`, vault, shipping callback, **biggest checkout button** (Phase 16 Track A PR1)
2. ⚠️ **PayPal Pay via Card (Advanced Checkout)** — 3DS required, hosted fields PCI SAQ-A (Phase 16 Track A PR2)
3. ⚠️ **PayPal refund + partial** — Admin UI flow (Phase 16 Track A PR3)
4. ⚠️ **PayPal chargeback + auto-evidence** — Dispute API integration (Phase 16 Track A PR4)
5. ⚠️ **PayPal settlement reporting** — Daily webhook + reconciliation (Phase 16 Track A PR5)

**Stripe FULL integration (Track D, 6 PRs — seller choice parity):**
6. ⚠️ **Stripe prod setup + webhook** — Prod keys per-shop, idempotency, signature verification, dedup (Phase 16 Track D PR11)
7. ⚠️ **Stripe Payment Intents + SCA/3DS** — Full Payment Intents flow + automatic 3DS for EEA (Phase 16 Track D PR12)
8. ⚠️ **Stripe refund + partial** — Admin UI parity với PayPal (Phase 16 Track D PR13)
9. ⚠️ **Stripe Radar (fraud)** — Enable Radar + feed velocity/BIN signals + merge vào Gbox engine (Phase 16 Track D PR14)
10. ⚠️ **Stripe disputes + auto-evidence** — Webhook + Disputes API parity với PayPal (Phase 16 Track D PR15)
11. ⚠️ **Stripe payout/settlement** — Balance Transactions API daily cron + admin report (Phase 16 Track D PR16)

**Airwallex FULL integration (Track E, 7 PRs — seller choice parity, VN/BD merchant strength):**
12. ⚠️ **Airwallex merchant KYC + account create** — OAuth, business verification, sandbox→prod (Phase 16 Track E PR17)
13. ⚠️ **Airwallex collect flow** — Payment Intent + hosted checkout + 3DS + webhook signature (Phase 16 Track E PR18)
14. ⚠️ **Airwallex pay flow (VN/BD bank)** — Beneficiary management + Payouts API + FX USD→VND/BDT (Phase 16 Track E PR19)
15. ⚠️ **Airwallex multi-currency wallet** — USD/VND/BDT balances + transfer + admin UI (Phase 16 Track E PR20)
16. ⚠️ **Airwallex disputes** — Evidence upload + auto-reply parity (Phase 16 Track E PR21)
17. ⚠️ **Airwallex settlement reporting** — Daily statement + reconciliation (Phase 16 Track E PR22)
18. ⚠️ **Airwallex FX + spot-rate lock** — Rate quote API + 24h lock for predictable settlement (Phase 16 Track E PR23)

**Gateway switcher (Track F, 4 PRs — NEW v3, seller choice infrastructure):**
19. ⚠️ **Gateway selection admin UI** — Shop settings page, PayPal pre-checked default, KYC warnings (Phase 16 Track F PR24)
20. ⚠️ **Per-shop encrypted credentials** — Migration `shop_payment_gateways` + AES-256-GCM (Phase 16 Track F PR25)
21. ⚠️ **Gateway fallback logic** — Primary fails → secondary retry (seller opt-in) (Phase 16 Track F PR26)
22. ⚠️ **Multi-gateway checkout UI** — PayPal prominent (biggest button) + tabbed alternatives (Phase 16 Track F PR27)

**Deferred post-Oct 2026:**
23. 🔵 **DEFERRED:** Apple Pay, Google Pay, Klarna, Afterpay, Amazon Pay (Phase 20+ — 3 gateways đủ MVP)
24. 🔵 **DEFERRED:** Stripe Connect marketplace mode (Phase 20+ — không cần cho single-store flow)
25. 🔵 **DEFERRED:** Payoneer / Wise Business (Phase 20+ — Airwallex covers VN/BD payouts)

### Must Fix — Fraud Engine (FULL, owner directive)

1. ⚠️ **Velocity rules** — Card/IP/email windows 1h/24h/7d (Phase 16 Track B PR6)
2. ⚠️ **BIN lookup + geo mismatch** — BIN DB cached + flag (Phase 16 Track B PR6)
3. ⚠️ **Device fingerprint** — Fingerprint.js + hash (Phase 16 Track B PR7)
4. ⚠️ **Blacklist (email/IP/card/address)** — CRUD + auto-populate (Phase 16 Track B PR7)
5. ⚠️ **Manual review queue** — Hold + admin page + approve/reject (Phase 16 Track B PR8)
6. ⚠️ **Auto-cancel stale holds** — Cron (Phase 16 Track B PR9)
7. ⚠️ **Stripe Radar signals integration** — Merge Radar risk_level vào Gbox engine (Phase 16 Track D PR14)

### Must Fix — Fulfillment (LENFUL-NATIVE)

1. ⚠️ **Lenful order push** — Auto-push + retry + idempotency (Phase 17 PR1)
2. ⚠️ **Status + tracking sync** — Webhook consumer (Phase 17 PR2)
3. ⚠️ **Cancel/refund round-trip** — Lenful state verify (Phase 17 PR3)
4. ⚠️ **SKU mapping table + UI** — Gbox variant → Lenful SKU (Phase 17 PR4)
5. ⚠️ **Shipping profile per Lenful SKU** — Flat rates (Phase 17 PR5)

### Must Fix — Customs (US-FOCUSED)

1. ⚠️ **HS code field + seed** — Products table migration + 150 seed codes (Phase 17 PR6)
2. ⚠️ **Commercial Invoice PDF gen** — Template + generator (Phase 17 PR7)
3. ⚠️ **CN22/CN23 form gen (optional)** — USPS format (Phase 17 PR8)
4. ⚠️ **De minimis $800 warning** — UI check (Phase 17 PR9)
5. ⚠️ **Country-of-origin required** — Validation (Phase 17 PR9)

### Must Fix — US Sales Tax

1. ⚠️ **Nexus engine** — 10-15 major states config + threshold tracking (Phase 18 PR1)
2. ⚠️ **Tax calc at checkout** — Destination-based (Phase 18 PR2)
3. ⚠️ **Tax report export** — State filing prep CSV (Phase 18 PR3)
4. ⚠️ **B2B tax-exempt** — Resale cert upload (Phase 18 PR4)

### Must Fix — Importer Tool (NEW per owner directive)

1. ⚠️ **AliExpress import (DS Center API)** — Single URL paste (Phase 17 PR10)
2. ⚠️ **1688 import (scrape)** — Chinese source (Phase 17 PR11)
3. ⚠️ **Image download to CDN** — Avoid hotlink (Phase 17 PR12)
4. ⚠️ **Variant mapping** — Color/size (Phase 17 PR12)
5. ⚠️ **Markup rules engine** — Fixed/%/tier (Phase 17 PR13)
6. ⚠️ **Bulk CSV URL import** — Batch (Phase 17 PR14)
7. ⚠️ **Taobao + Shopee import** — Phase 18 PR5
8. ⚠️ **Chrome extension** — 1688/Taobao injector (Phase 18 PR6)

### Must Fix — Compliance (US-SCOPED)

1. ⚠️ **DPA template** — California CPRA + basic GDPR
2. ⚠️ **Cookie banner** — CCPA + state privacy (US focus)
3. ⚠️ **Terms of Service + Privacy Policy** — US buyer focus, VN/BD seller DPA
4. ⚠️ **Multi-currency display (USD default)** — Phase 16 PR12
5. 🔵 **DEFERRED:** IOSS, UK VAT, Canada GST/PST (EU/CA expansion Phase 20+)

---

## 🔚 KẾT LUẬN

**Gbox Platform = 72% Shopify feature parity. Sau scope lock (US + Lenful + PayPal), chỉ ~35% là blocker.**

- **Mạnh hơn Shopify:** Email system (97 templates), Support ticketing (Phase 12.5 full), Iron Rule 5 chokepoint, Admin RBAC (25 perms), Clone Pro v4, Theme engine tests (987+), **Lenful POD unique** (owner's company)
- **Ngang Shopify:** Core commerce, Markets, Passkey/WebAuthn, GDPR workflows, Gift cards, Metafields, AI copywriter
- **Yếu hơn nhưng scoped Phase 15-19 (MUST FIX):** PayPal prod hardening, Fraud engine FULL, Lenful native fulfillment, HS codes + Commercial Invoice, US sales tax nexus, Product Importer tool, Webhook idempotency, Customer 2FA, RLS + backup
- **Yếu hơn nhưng DEFERRED Phase 20+:** Apple Pay / Google Pay / Klarna / Afterpay, IOSS + UK VAT + Canada GST, Printful / Printify / Gelato, Live carrier rate APIs, Direct label print APIs, Mobile apps, GraphQL, Live chat, Loyalty

**Launch timeline (26 tuần / 6.5 tháng tới Nov 2026) — US + LENFUL + 3 GATEWAYS FULL:**

| Phase | Focus | Duration | Output |
|-------|-------|----------|--------|
| 15 | **Foundation lock** (5 risks fix) | 6 tuần | RLS + tx isolation + backup + webhook idempotency + customer 2FA + API keys + pen-test prep |
| 16 | **3 Gateways FULL + Fraud + Multi-currency display** | 10 tuần (6 parallel tracks) | PayPal priority default + Stripe FULL (Payment Intents/3DS/Radar/Disputes/Payouts) + Airwallex FULL (KYC/collect/pay/wallet/FX lock) + Gateway switcher UI + Fraud FULL + USD display |
| 17 | **Lenful + HS codes + Importer v1** | 5 tuần | Lenful order push/status/SKU/profile + HS code + Commercial Invoice PDF + AliExpress/1688 importer |
| 18 | **US sales tax + Importer v2 + Label flow** | 3 tuần | Nexus + tax calc + B2B exempt + Taobao/Shopee + Chrome extension + label attach |
| 19 | **Polish + Launch prep** | 2 tuần | SMS + mobile audit + web push + JSON-LD + launch readiness checklist |

**Target launch:** **Early November 2026** cho **Mid-market + SMB POD + Dropship sellers tại Vietnam + Bangladesh bán US market** (EU/CA expansion Phase 20+).

**Phase 16 parallel execution strategy:**
- **Wave 1 (Weeks 1-6) — Beta-ready:** Track A (PayPal) + Track B (Fraud) + Track C (Multi-currency display)
- **Wave 2 (Weeks 5-10, overlap with Wave 1) — GA-ready:** Track D (Stripe FULL) + Track E (Airwallex FULL) + Track F (Gateway switcher)
- Beta launch possible end of Week 6 (PayPal-only); full public launch after Week 10.

**Immediate blockers (next 2 weeks before Phase 15 PR1):**
1. Lock spec v3 (THIS doc) with owner final approval — **DONE 2026-04-24**
2. Write Phase 15 implementation plan via `writing-plans` skill
3. Schedule pen-test vendor
4. Scope PayPal Advanced Checkout (card fields) sandbox access
5. Scope Stripe sandbox — full Payment Intents + Radar + Disputes API access
6. Scope Airwallex sandbox — merchant onboarding + Payouts + multi-currency wallet
7. Scope AliExpress DS Center API (app key + OAuth seller)
8. Scope Lenful internal API docs (owner-provided, internal)

**Document status:** ✅ Locked (v3 — 2 rounds review: scope lock 2026-04-24 AM, gateway parity clarification 2026-04-24 PM). Next: `writing-plans` skill → Phase 15 detailed impl plan.

---

## 📁 APPENDIX: FILE PATH CONVENTIONS

**Workspace layout:**

```
E:\Gbox Platform vibecode\                  ← Root (no docs folder here)
├── gbox-platform\                           ← MAIN REPO (docs + code live here)
│   ├── docs\superpowers\specs\              ← Specs (including this file)
│   ├── docs\superpowers\plans\              ← Implementation plans
│   ├── docs\ops\                            ← Operational runbooks
│   ├── docs\email-system\                   ← Email-specific docs
│   ├── packages\                            ← Monorepo packages
│   │   ├── core\                            ← Business logic (77 modules)
│   │   ├── db\                              ← Schema + migrations
│   │   ├── api\                             ← REST API routes
│   │   ├── storefront\                      ← Storefront logic
│   │   ├── agent-core\                      ← AI agent session
│   │   ├── agent-guard\                     ← Agent safety guards
│   │   └── agent-tools\                     ← Agent tool registry
│   ├── apps\                                ← Deployable apps
│   │   ├── store-admin\                     ← Merchant dashboard
│   │   ├── god-admin\                       ← Platform admin (never seller-visible)
│   │   ├── accounts\                        ← Auth portal
│   │   ├── storefront\                      ← Customer storefront
│   │   ├── checkout\                        ← Checkout flow
│   │   └── supporter\                       ← Support agent UI
│   ├── scripts\                             ← Ops + smoke + seed scripts
│   └── CLAUDE.md + CLAUDE-EXTENDED.md       ← Project brain
├── gbox-emdash-admin\                       ← EmDash admin plugins (separate repo)
├── gbox-paypal\                             ← Legacy PayPal plugin (predecessor)
├── emdash\                                  ← EmDash CMS (upstream)
├── Clone_pro\                               ← Clone Pro AI
├── superpowers\                             ← Superpowers skill definitions
├── .claude\                                 ← Claude Code project settings
└── .superpowers\                            ← Superpowers runtime data
```

**Canonical spec path:** `E:\Gbox Platform vibecode\gbox-platform\docs\superpowers\specs\YYYY-MM-DD-<topic>.md`
