# GBOX PLATFORM — API ARCHITECTURE MINDMAP
## Ke Hoach Ket Noi Toan He Thong (Chi Tiet Nhat)

**Date**: 2026-04-07
**Author**: Claude (approved by Thai Bui)
**Status**: DRAFT — Cho duyet

---

## 1. HIEN TRANG (Current State) — VAN DE PHAT HIEN

```
                    +-----------+
                    |  BROWSER  |
                    | 192.168.1.13
                    +-----+-----+
                          |
                    +-----+-----+
                    |   NGINX   |  :80
                    +-----+-----+
                          |
        +---------+-------+--------+-----------+
        |         |                |            |
   /accounts/  /god-admin    /_emdash/      /api/
        |         |          admin/store/      |
   +----+---+ +---+----+  +----+-----+  +----+----+
   |Accounts| |God     |  |Store     |  |API      |
   |:4323   | |Admin   |  |Admin     |  |Server   |
   |        | |:4324   |  |:4325     |  |:4321    |
   +---+----+ +---+----+  +----+-----+  +----+----+
       |          |             |             |
       +----------+-------------+             |
       |                                      |
       v                                      v
   +--------+                          +----------+
   |PostgreSQL| <-- TRUC TIEP ---      | PostgreSQL|
   |  (Kysely)|    (khong qua API)     | (Kysely)  |
   +----------+                        +-----------+
```

### VAN DE 1: God Admin KHONG HOAT DONG tu Browser

**Nguyen nhan goc:**
```
Browser (192.168.1.13) --> /accounts/login
  Nginx REWRITE: /accounts/login --> strip /accounts/ --> proxy to :4323 /login
  Accounts server at :4323 --> POST /login --> Set-Cookie: gbox_session (Path=/)

  Cookie duoc set cho domain 192.168.1.13 ✓

Browser --> /god-admin
  Nginx proxy to :4324/god-admin
  God Admin middleware kiem tra cookie

  *** VAN DE: God Admin doc cookie TRUC TIEP tu req.cookies ***
  *** Accounts dang return redirect to /accounts/stores (KHONG redirect den god-admin) ***
  *** Login flow khong co "return_to" parameter handling dung ***
```

**Chi tiet loi:**
1. Login tai /accounts/login --> redirect den /accounts/stores (LUON LUON)
2. God Admin /god-admin --> middleware thay khong co session --> redirect den /accounts/login?return_to=/god-admin
3. Nhung /accounts/login KHONG XU LY return_to param --> luon redirect ve /accounts/stores
4. User bi loop: god-admin -> login -> stores -> phai click thu cong vao God Admin

### VAN DE 2: KHONG CO KET NOI GIUA CAC MODULE

```
HIEN TAI (SAI):                          CAN PHAI LA (DUNG):

Accounts  --> DB truc tiep               Accounts --> @gbox/core services --> DB
God Admin --> DB truc tiep               God Admin --> REST API (/api/) --> DB
Store Admin --> DB truc tiep             Store Admin --> REST API (/api/) --> DB
API Server --> @gbox/core --> DB  ✓      Storefront --> REST API (/api/) --> DB

Van de:                                  Loi ich:
- Trung lap code query DB               - Single source of truth
- Khong co validation thong nhat         - Validation 1 cho
- Khong co rate limiting                 - Rate limiting toan bo
- Khong co audit logging                 - Audit log moi thay doi
- Admin apps bypass API                  - Security nhat quan
- Storefront khong ket noi gi ca         - Cache layer tai API
```

---

## 2. KIEN TRUC MUC TIEU (Target Architecture)

```
                         +------------------+
                         |    BROWSER       |
                         | (User/Merchant)  |
                         +--------+---------+
                                  |
                         +--------+---------+
                         |     NGINX        |
                         | Reverse Proxy    |
                         | + SSL Termination|
                         +--------+---------+
                                  |
         +----------+-------------+-------------+-----------+
         |          |             |              |           |
    /accounts/  /god-admin  /_emdash/        /api/       / (root)
         |          |       admin/store/        |           |
    +----+----+ +---+-----+ +----+-----+  +----+----+ +----+----+
    |ACCOUNTS | |GOD      | |STORE     |  |   API   | |STORE-   |
    |Portal   | |ADMIN    | |ADMIN     |  | GATEWAY | |FRONT    |
    |:4323    | |:4324    | |:4325     |  |  :4321  | |:4326    |
    |         | |         | |          |  |         | |         |
    |HTML+Auth| |HTML+Mgmt| |HTML+AI   |  |JSON REST| |Astro SSR|
    +----+----+ +----+----+ +----+-----+  +----+----+ +----+----+
         |           |           |             |           |
         |      +----+-----------+-------------+           |
         |      |    INTERNAL API CALLS (HTTP)  |          |
         |      +----+-----------+-------------+           |
         |           |           |             |           |
    +----+----+ +----+----+ +---+-----+  +----+----+ +----+----+
    |@gbox/   | |         | |         |  |@gbox/   | |         |
    |core     | |  fetch  | |  fetch  |  |core     | |  fetch  |
    |auth     | |  :4321  | |  :4321  |  |services | |  :4321  |
    |module   | |  /api/* | |  /api/* |  |modules  | |  /api/* |
    +----+----+ +----+----+ +----+----+  +----+----+ +----+----+
         |           |           |             |           |
         +------+----+-----------+------+------+-----------+
                |                       |
         +------+------+        +-------+-------+
         |  PostgreSQL  |        |    Redis      |
         |  (Primary)   |        | (Sessions +   |
         |  50+ tables  |        |  Cache)       |
         +--------------+        +---------------+
```

---

## 3. API GATEWAY — TAT CA ENDPOINTS

### 3.1 Authentication & Session API

```
/api/2026-04/auth/
│
├── POST /login.json
│   Body: { email, password }
│   Response: { user, session_token, shops[] }
│   Sets: gbox_session cookie
│   Rate: 5/minute per IP
│
├── POST /signup.json
│   Body: { email, password, name }
│   Response: { user, otp_sent: true }
│   Rate: 3/minute per IP
│
├── POST /verify-email.json
│   Body: { email, otp }
│   Response: { user, session_token }
│   Rate: 5/minute per email
│
├── POST /logout.json
│   Clears: gbox_session cookie
│   Response: { success: true }
│
├── POST /forgot-password.json
│   Body: { email }
│   Response: { sent: true }
│
├── POST /reset-password.json
│   Body: { token, new_password }
│   Response: { success: true }
│
├── GET /session.json
│   Headers: Cookie: gbox_session=xxx
│   Response: { user, session, shops[], role }
│   *** CRITICAL: Day la API ket noi CORE ***
│   *** Moi app goi endpoint nay de validate session ***
│
├── POST /session/refresh.json
│   Response: { new_token, expires_at }
│
├── DELETE /sessions.json
│   Revoke all sessions except current
│
├── GET /me.json
│   Response: { user profile, preferences }
│
└── PUT /me.json
    Body: { name, avatar_url, ... }
    Response: { updated user }
```

### 3.2 Shop Management API

```
/api/2026-04/shops/
│
├── GET /shops.json                    ← God Admin list all
│   Auth: god_admin only
│   Query: ?status=active&plan=pro&page=1&limit=20
│   Response: { shops[], total, page }
│
├── POST /shops.json                   ← Create new store
│   Auth: authenticated user
│   Body: { name, slug, email, currency, timezone }
│   Response: { shop, user_shop_link }
│   Side-effects: create user_shops entry
│
├── GET /shops/:id.json                ← Shop detail
│   Auth: shop_member OR god_admin
│   Response: { shop, settings, domains }
│
├── PUT /shops/:id.json                ← Update shop
│   Auth: shop_owner OR god_admin
│   Body: { name, email, address, ... }
│
├── POST /shops/:id/suspend.json       ← God Admin only
│   Auth: god_admin
│   Response: { shop: { status: 'suspended' } }
│
├── POST /shops/:id/reactivate.json    ← God Admin only
│   Auth: god_admin
│
├── GET /shops/:id/staff.json          ← List store staff
│   Auth: shop_owner/admin
│   Response: { staff: [{ user, role, permissions }] }
│
├── POST /shops/:id/staff.json         ← Invite staff
│   Auth: shop_owner/admin
│   Body: { email, role, permissions }
│
├── PUT /shops/:id/staff/:userId.json  ← Update staff role
│   Auth: shop_owner
│
└── DELETE /shops/:id/staff/:userId.json ← Remove staff
    Auth: shop_owner
```

### 3.3 Products API (Shopify-compatible)

```
/api/2026-04/products/
│
├── GET /products.json
│   Auth: shop_member (admin) OR api_token (storefront)
│   Query: ?status=active&vendor=X&product_type=Y&collection_id=Z
│          &ids=1,2,3&created_at_min=&created_at_max=
│          &page=1&limit=50&fields=id,title,price
│   Response: { products: [{ id, title, variants[], images[], ... }] }
│
├── GET /products/:id.json
│   Response: { product: { ...full detail with variants, images, options } }
│
├── POST /products.json
│   Auth: shop_admin+
│   Body: { title, body_html, vendor, product_type, status, tags[],
│           variants: [{ price, sku, inventory_quantity, ... }],
│           images: [{ src, alt, position }] }
│   Response: { product }
│   Side-effects: create variants, images, inventory_items
│
├── PUT /products/:id.json
│   Auth: shop_admin+
│   Body: { ...partial update }
│
├── DELETE /products/:id.json
│   Auth: shop_admin+
│   Side-effects: archive (soft-delete) product
│
├── GET /products/:id/variants.json
├── POST /products/:id/variants.json
├── PUT /products/:id/variants/:variantId.json
├── DELETE /products/:id/variants/:variantId.json
│
├── GET /products/:id/images.json
├── POST /products/:id/images.json
├── PUT /products/:id/images/:imageId.json
├── DELETE /products/:id/images/:imageId.json
│
└── GET /products/count.json
    Query: ?status=active
    Response: { count: 42 }
```

### 3.4 Orders API

```
/api/2026-04/orders/
│
├── GET /orders.json
│   Auth: shop_member
│   Query: ?financial_status=paid&fulfillment_status=unfulfilled
│          &customer_id=X&created_at_min=&created_at_max=
│          &status=open&page=1&limit=50
│   Response: { orders: [{ id, order_number, customer, line_items[], ... }] }
│
├── GET /orders/:id.json
│   Response: { order: { ...full detail with line_items, fulfillments, transactions } }
│
├── POST /orders.json                  ← Manual order creation
│   Auth: shop_admin+
│   Body: { customer_id, line_items[], shipping_address, note }
│
├── PUT /orders/:id.json
│   Auth: shop_admin+
│   Body: { note, tags, shipping_address }
│
├── POST /orders/:id/cancel.json
│   Auth: shop_admin+
│   Body: { reason, restock: true, email_customer: true }
│
├── POST /orders/:id/close.json
│   Auth: shop_admin+
│
├── POST /orders/:id/fulfillments.json
│   Auth: shop_staff+
│   Body: { line_items: [{ id, quantity }], tracking_number, tracking_company }
│   Side-effects: update fulfillment_status, create fulfillment record
│
├── POST /orders/:id/transactions.json
│   Auth: shop_admin+
│   Body: { kind: 'capture'|'refund', amount }
│
├── POST /orders/:id/refunds.json
│   Auth: shop_admin+
│   Body: { line_items: [{ id, quantity, restock_type }], note, amount }
│
└── GET /orders/count.json
    Response: { count: 156 }
```

### 3.5 Customers API

```
/api/2026-04/customers/
│
├── GET /customers.json
│   Auth: shop_member
│   Query: ?q=search&status=active&accepts_marketing=true
│          &created_at_min=&page=1&limit=50
│   Response: { customers[] }
│
├── GET /customers/:id.json
│   Response: { customer: { ...with addresses[], orders_count, total_spent } }
│
├── POST /customers.json
│   Auth: shop_admin+
│   Body: { first_name, last_name, email, phone, tags[], note, addresses[] }
│
├── PUT /customers/:id.json
│   Auth: shop_admin+
│
├── DELETE /customers/:id.json
│   Auth: shop_admin+  (soft delete — set status=disabled)
│
├── GET /customers/:id/addresses.json
├── POST /customers/:id/addresses.json
├── PUT /customers/:id/addresses/:addrId.json
├── DELETE /customers/:id/addresses/:addrId.json
│
├── GET /customers/:id/orders.json
│   Response: { orders[] } — all orders by this customer
│
├── GET /customers/count.json
└── GET /customers/search.json
    Query: ?q=john
    Response: { customers[] } — fast autocomplete
```

### 3.6 Collections API

```
/api/2026-04/collections/
│
├── GET /collections.json
├── GET /collections/:id.json
├── POST /collections.json
├── PUT /collections/:id.json
├── DELETE /collections/:id.json
├── GET /collections/:id/products.json
├── POST /collections/:id/products.json     ← Add product to collection
└── DELETE /collections/:id/products/:pid.json
```

### 3.7 Inventory API

```
/api/2026-04/inventory/
│
├── GET /inventory_levels.json
│   Query: ?location_id=X&inventory_item_ids=1,2,3
│   Response: { inventory_levels: [{ item_id, location_id, available }] }
│
├── POST /inventory_levels/set.json
│   Body: { inventory_item_id, location_id, available }
│
├── POST /inventory_levels/adjust.json
│   Body: { inventory_item_id, location_id, adjustment: +5 or -3 }
│
├── GET /locations.json
├── GET /locations/:id.json
├── POST /locations.json
├── PUT /locations/:id.json
└── GET /locations/:id/inventory_levels.json
```

### 3.8 Discounts API

```
/api/2026-04/discounts/
│
├── GET /discounts.json
│   Query: ?status=active&type=percentage
├── GET /discounts/:id.json
├── POST /discounts.json
│   Body: { title, code, type, value, applies_to, minimum_requirement,
│           usage_limit, once_per_customer, starts_at, ends_at }
├── PUT /discounts/:id.json
├── DELETE /discounts/:id.json
└── POST /discounts/validate.json      ← Check if code is valid
    Body: { code, cart_total, customer_id }
    Response: { valid, discount_amount, message }
```

### 3.9 Content (CMS) API

```
/api/2026-04/content/
│
├── GET /pages.json
├── GET /pages/:id.json
├── POST /pages.json
├── PUT /pages/:id.json
├── DELETE /pages/:id.json
│
├── GET /blogs.json
├── GET /blogs/:id.json
├── POST /blogs.json
├── PUT /blogs/:id.json
├── DELETE /blogs/:id.json
│
├── GET /menus.json
├── GET /menus/:id.json
├── POST /menus.json
├── PUT /menus/:id.json
└── DELETE /menus/:id.json
```

### 3.10 Checkout & Cart API (Storefront)

```
/api/2026-04/checkout/
│
├── POST /checkouts.json
│   Body: { line_items: [{ variant_id, quantity }], email }
│   Response: { checkout: { id, token, line_items, subtotal, total } }
│
├── GET /checkouts/:token.json
│
├── PUT /checkouts/:token.json
│   Body: { email, shipping_address, billing_address, note }
│
├── POST /checkouts/:token/line_items.json
│   Body: { variant_id, quantity }
│
├── PUT /checkouts/:token/line_items/:id.json
│   Body: { quantity }
│
├── DELETE /checkouts/:token/line_items/:id.json
│
├── POST /checkouts/:token/shipping_rates.json
│   Response: { shipping_rates: [{ id, title, price }] }
│
├── POST /checkouts/:token/discount.json
│   Body: { code }
│
├── DELETE /checkouts/:token/discount.json
│
├── POST /checkouts/:token/complete.json
│   Body: { payment_method: 'stripe'|'paypal', payment_token }
│   Response: { order }
│   Side-effects: create order, line_items, transaction, decrement inventory
│
└── GET /checkouts/:token/payment_methods.json
    Response: { methods: ['stripe', 'paypal'] }
```

### 3.11 Analytics API (Admin)

```
/api/2026-04/analytics/
│
├── GET /dashboard.json
│   Auth: shop_member
│   Query: ?period=7d|30d|90d|12m
│   Response: {
│     revenue: { current, previous, change_pct },
│     orders: { current, previous, change_pct },
│     aov: { current, previous },
│     customers: { new, returning },
│     top_products: [{ id, title, revenue, units }],
│     revenue_chart: [{ date, amount }],
│     orders_chart: [{ date, count }]
│   }
│
├── GET /reports/sales.json
│   Query: ?group_by=day|week|month&start=&end=
│
├── GET /reports/products.json
│   Query: ?sort_by=revenue|units&limit=20
│
├── GET /reports/customers.json
│   Query: ?segment=new|returning|at_risk
│
└── GET /reports/traffic.json
    Query: ?period=30d
```

### 3.12 AI Agent API

```
/api/2026-04/ai/
│
├── POST /chat.json
│   Auth: shop_member
│   Body: { message, context: 'dashboard'|'products'|'orders'|... }
│   Response: { html, suggested_actions[] }
│
├── POST /generate/description.json
│   Body: { product_title, product_type, keywords[] }
│   Response: { description_html }
│
├── POST /analyze/store-health.json
│   Auth: shop_member
│   Response: { score, issues[], recommendations[] }
│
├── POST /analyze/seo.json
│   Body: { url, title, description }
│   Response: { score, issues[], suggestions[] }
│
└── POST /suggest/marketing.json
    Auth: shop_member
    Response: { campaigns: [{ title, type, description, target }] }
```

### 3.13 God Admin Platform API

```
/api/2026-04/platform/
│
├── GET /stats.json
│   Auth: god_admin ONLY
│   Response: { total_shops, total_users, total_orders,
│               total_revenue, active_shops, mrr }
│
├── GET /shops.json                    ← All shops across platform
│   Auth: god_admin
│   Query: ?status=&plan=&page=&search=
│
├── GET /users.json                    ← All users across platform
│   Auth: god_admin
│   Query: ?role=&status=&search=
│
├── POST /users/:id/disable.json
│   Auth: god_admin
│
├── POST /users/:id/enable.json
│   Auth: god_admin
│
├── GET /security/audit-log.json
│   Auth: god_admin
│   Query: ?action=&user_id=&from=&to=
│   Response: { events: [{ action, user, ip, timestamp, details }] }
│
├── GET /security/sessions.json
│   Auth: god_admin
│   Response: { active_sessions: [{ user, ip, last_active, created }] }
│
├── GET /config.json
│   Auth: god_admin
│   Response: { platform settings }
│
└── PUT /config.json
    Auth: god_admin
    Body: { ...settings }
```

### 3.14 Webhooks API

```
/api/2026-04/webhooks/
│
├── GET /webhooks.json
├── POST /webhooks.json
│   Body: { topic: 'orders/create', address: 'https://...', format: 'json' }
├── PUT /webhooks/:id.json
├── DELETE /webhooks/:id.json
│
│   Supported topics:
│   - orders/create, orders/update, orders/paid, orders/fulfilled, orders/cancelled
│   - products/create, products/update, products/delete
│   - customers/create, customers/update, customers/delete
│   - checkouts/create, checkouts/update
│   - refunds/create
│   - shop/update
│   - inventory_levels/update
└── GET /webhooks/topics.json
```

### 3.15 Files & Media API

```
/api/2026-04/files/
│
├── POST /upload.json
│   Auth: shop_admin+
│   Content-Type: multipart/form-data
│   Body: file + { folder: 'products'|'content'|'theme' }
│   Response: { file: { id, url, content_type, size } }
│   Storage: R2 (Cloudflare) or S3
│
├── GET /files.json
│   Query: ?folder=products&type=image
│
├── GET /files/:id.json
│
└── DELETE /files/:id.json
```

---

## 4. MODULE CONNECTION MAP (SO DO KET NOI)

### 4.1 Accounts Portal (:4323) --> API Gateway (:4321)

```
ACCOUNTS PORTAL (Server-rendered HTML)
│
├── GET /login (render form)
│   └── POST /login
│       └── INTERNAL: POST /api/2026-04/auth/login.json
│           └── @gbox/core auth.service.login()
│               └── DB: users, sessions
│
├── GET /signup (render form)
│   └── POST /signup
│       └── INTERNAL: POST /api/2026-04/auth/signup.json
│           └── @gbox/core auth.service.createUser()
│
├── GET /stores (render store list)
│   └── INTERNAL: GET /api/2026-04/auth/session.json  <-- validate
│   └── INTERNAL: GET /api/2026-04/shops.json?user=me  <-- get user's shops
│
├── POST /create-store
│   └── INTERNAL: POST /api/2026-04/shops.json
│
├── GET /account (profile page)
│   └── INTERNAL: GET /api/2026-04/auth/me.json
│
└── POST /account/profile
    └── INTERNAL: PUT /api/2026-04/auth/me.json

*** QUAN TRONG: Accounts la app DUY NHAT xu ly truc tiep auth ***
*** Vi no SET cookie — can truc tiep @gbox/core ***
*** Nhung data (shops, profile) nen qua API ***
```

### 4.2 God Admin (:4324) --> API Gateway (:4321)

```
GOD ADMIN (Server-rendered HTML)
│
├── Middleware: godAuthMiddleware
│   └── INTERNAL: GET /api/2026-04/auth/session.json
│       └── Verify role === 'owner'
│
├── GET /god-admin (Dashboard)
│   └── INTERNAL: GET /api/2026-04/platform/stats.json
│
├── GET /god-admin/stores
│   └── INTERNAL: GET /api/2026-04/platform/shops.json
│
├── GET /god-admin/stores/:id
│   └── INTERNAL: GET /api/2026-04/shops/:id.json
│
├── POST /god-admin/stores/:id/suspend
│   └── INTERNAL: POST /api/2026-04/platform/shops/:id/suspend.json
│
├── GET /god-admin/users
│   └── INTERNAL: GET /api/2026-04/platform/users.json
│
├── GET /god-admin/orders
│   └── INTERNAL: GET /api/2026-04/orders.json?all_shops=true  (god_admin flag)
│
├── GET /god-admin/finance
│   └── INTERNAL: GET /api/2026-04/platform/stats.json?detail=finance
│
└── GET /god-admin/security
    └── INTERNAL: GET /api/2026-04/platform/security/audit-log.json
```

### 4.3 Store Admin (:4325) --> API Gateway (:4321)

```
STORE ADMIN (Server-rendered HTML + AI)
│
├── Middleware: storeAuthMiddleware
│   └── INTERNAL: GET /api/2026-04/auth/session.json
│       └── Check shop access via user_shops OR role=owner
│
├── GET /:slug/dashboard
│   └── INTERNAL: GET /api/2026-04/analytics/dashboard.json?shop_id=X&period=7d
│
├── GET /:slug/orders
│   └── INTERNAL: GET /api/2026-04/orders.json?shop_id=X&page=1
│
├── GET /:slug/orders/:id
│   └── INTERNAL: GET /api/2026-04/orders/:id.json
│
├── POST /:slug/orders/:id/fulfill
│   └── INTERNAL: POST /api/2026-04/orders/:id/fulfillments.json
│
├── GET /:slug/products
│   └── INTERNAL: GET /api/2026-04/products.json?shop_id=X
│
├── POST /:slug/products
│   └── INTERNAL: POST /api/2026-04/products.json
│
├── GET /:slug/customers
│   └── INTERNAL: GET /api/2026-04/customers.json?shop_id=X
│
├── GET /:slug/settings
│   └── INTERNAL: GET /api/2026-04/shops/:id.json
│
├── POST /:slug/settings/general
│   └── INTERNAL: PUT /api/2026-04/shops/:id.json
│
├── GET /:slug/settings/staff
│   └── INTERNAL: GET /api/2026-04/shops/:id/staff.json
│
└── POST /:slug/ai/chat
    └── INTERNAL: POST /api/2026-04/ai/chat.json?shop_id=X
```

### 4.4 Storefront (:4326 Astro) --> API Gateway (:4321)

```
STOREFRONT (Astro SSR — Customer-facing)
│
├── Middleware: shopResolver
│   └── INTERNAL: GET /api/2026-04/shop.json?domain=xxx
│       └── Resolve shop by domain/slug
│
├── GET / (Homepage)
│   └── INTERNAL: GET /api/2026-04/collections.json?shop_id=X&featured=true
│   └── INTERNAL: GET /api/2026-04/products.json?shop_id=X&limit=12
│
├── GET /products (Catalog)
│   └── INTERNAL: GET /api/2026-04/products.json?shop_id=X&page=1
│
├── GET /products/:slug (Product detail)
│   └── INTERNAL: GET /api/2026-04/products/:id.json
│
├── GET /collections/:slug
│   └── INTERNAL: GET /api/2026-04/collections/:id/products.json
│
├── GET /cart (Cart page)
│   └── INTERNAL: GET /api/2026-04/checkouts/:token.json
│
├── POST /cart/add
│   └── INTERNAL: POST /api/2026-04/checkouts/:token/line_items.json
│
├── GET /checkout
│   └── INTERNAL: GET /api/2026-04/checkouts/:token.json
│
├── POST /checkout/complete
│   └── INTERNAL: POST /api/2026-04/checkouts/:token/complete.json
│
├── GET /account/login (Customer login — SEPARATE from merchant)
│   └── INTERNAL: POST /api/2026-04/customers/auth/login.json
│
├── GET /account/orders (Customer order history)
│   └── INTERNAL: GET /api/2026-04/customers/:id/orders.json
│
├── GET /pages/:slug (CMS pages)
│   └── INTERNAL: GET /api/2026-04/content/pages/:slug.json
│
└── GET /blog/:slug (Blog posts)
    └── INTERNAL: GET /api/2026-04/content/blogs/:slug.json
```

---

## 5. LUONG DU LIEU CHI TIET (Data Flow Details)

### 5.1 Login --> God Admin Flow (FIX)

```
HIEN TAI (BI LOI):
Browser --> /god-admin --> 302 to /accounts/login?return_to=/god-admin
Browser --> /accounts/login --> POST login --> 302 to /accounts/stores  ← KHONG DUNG
User phai click thu cong "God Admin" tren /stores page

SAU KHI FIX:
Browser --> /god-admin --> 302 to /accounts/login?return_to=/god-admin
Browser --> /accounts/login --> POST login
  IF return_to exists AND user.role === 'owner':
    --> 302 to /god-admin  ← REDIRECT DUNG CHO
  IF return_to exists AND return_to starts with /_emdash:
    --> 302 to /_emdash/admin/store/xxx  ← REDIRECT DUNG CHO
  ELSE:
    --> 302 to /accounts/stores  ← DEFAULT
```

### 5.2 Session Validation Flow (SHARED)

```
MOI REQUEST VAO ADMIN:
1. Middleware doc cookie gbox_session
2. INTERNAL HTTP: GET http://127.0.0.1:4321/api/2026-04/auth/session.json
   Headers: Cookie: gbox_session=xxx
   OR Headers: X-Session-Token: xxx
3. API response:
   {
     "valid": true,
     "user": { "id", "email", "name", "role", "status" },
     "session": { "id", "expires_at", "ip", "user_agent" },
     "shops": [{ "id", "slug", "name", "role_in_shop" }]
   }
4. Middleware attach user/session to request
5. Continue to route handler

TAI SAO CACH NAY TOT HON:
- 1 noi validate session (API) thay vi 3 noi (god-admin, store-admin, accounts)
- Thay doi logic validate → chi sua 1 cho
- Co the add Redis cache o API layer
- Rate limit tai API
- Audit log tai API
```

### 5.3 Multi-tenant Data Isolation

```
MOI API CALL CAN:
1. Authentication: ai dang goi?
2. Authorization: co quyen truy cap shop nay khong?
3. Data scoping: chi tra ve data cua shop do

IMPLEMENTATION:

// API middleware
function shopScopeMiddleware(req, res, next) {
  const shopId = req.query.shop_id || req.headers['x-shop-id']

  // God Admin: access any shop
  if (req.user.role === 'owner') {
    req.shopId = shopId  // can be any shop or null (all shops)
    return next()
  }

  // Normal user: must have access to this shop
  const userShop = req.user.shops.find(s => s.id === shopId)
  if (!userShop) return res.status(403).json({ error: 'No access to this shop' })

  req.shopId = shopId
  req.shopRole = userShop.role
  next()
}
```

---

## 6. IMPLEMENTATION PHASES (KE HOACH THUC HIEN)

### PHASE A: Fix God Admin + Login Flow (1 ngay)

```
A1. Fix login redirect logic
    - accounts/src/pages/login.ts: handle return_to parameter
    - Validate return_to (chi accept /god-admin, /_emdash/*)
    - Security: prevent open redirect (chi accept internal paths)

A2. Fix God Admin middleware
    - Ensure cookie forwarding qua Nginx works
    - Test full flow: browser -> nginx -> god-admin -> accounts -> god-admin

A3. Test E2E
    - Login as god_admin -> redirect to /god-admin
    - Login as merchant -> redirect to /accounts/stores
    - Login with return_to -> redirect to correct URL
```

### PHASE B: Build Internal API Client (2 ngay)

```
B1. Create @gbox/core/api-client.ts
    - HTTP client (fetch-based) for internal API calls
    - Auto-attach session token
    - Error handling + retry
    - TypeScript response types

    class GboxApiClient {
      constructor(baseUrl: string = 'http://127.0.0.1:4321')

      // Auth
      validateSession(token: string): Promise<SessionResponse>

      // Shops
      getShops(params?): Promise<ShopsResponse>
      getShop(id: string): Promise<ShopResponse>
      createShop(data): Promise<ShopResponse>

      // Products
      getProducts(shopId, params?): Promise<ProductsResponse>
      getProduct(id): Promise<ProductResponse>
      createProduct(shopId, data): Promise<ProductResponse>

      // Orders
      getOrders(shopId, params?): Promise<OrdersResponse>
      getOrder(id): Promise<OrderResponse>

      // Customers
      getCustomers(shopId, params?): Promise<CustomersResponse>

      // Analytics
      getDashboardStats(shopId, period): Promise<DashboardResponse>

      // AI
      aiChat(shopId, message, context): Promise<AIChatResponse>

      // Platform (God Admin)
      getPlatformStats(): Promise<PlatformStatsResponse>
      getPlatformUsers(params?): Promise<UsersResponse>
    }

B2. Add missing API routes to @gbox/api
    - /api/2026-04/auth/session.json (session validation)
    - /api/2026-04/platform/* (god admin endpoints)
    - /api/2026-04/analytics/* (dashboard data)
    - /api/2026-04/ai/* (AI agent endpoints)

B3. Add middleware to API server
    - Session validation middleware
    - Shop scope middleware
    - Rate limiting
    - Audit logging
```

### PHASE C: Rewire Admin Apps to Use API (3 ngay)

```
C1. Rewire God Admin
    - Replace direct DB queries with API client calls
    - god-admin/pages/dashboard.ts: apiClient.getPlatformStats()
    - god-admin/pages/stores.ts: apiClient.getShops()
    - god-admin/pages/users.ts: apiClient.getPlatformUsers()
    etc.

C2. Rewire Store Admin
    - Replace direct DB queries with API client calls
    - store-admin/pages/dashboard.ts: apiClient.getDashboardStats()
    - store-admin/pages/orders.ts: apiClient.getOrders()
    - store-admin/pages/products.ts: apiClient.getProducts()
    etc.

C3. Rewire Accounts Portal
    - Auth endpoints: keep direct @gbox/core (vi can set cookie)
    - Data endpoints: use API client
    - stores.ts: apiClient.getShops({ user: 'me' })
    - create-store.ts: apiClient.createShop()
    etc.
```

### PHASE D: Connect Storefront (2 ngay)

```
D1. Setup Astro storefront
    - Configure api-client.ts with base URL
    - Shop resolver middleware
    - SSR rendering with API data

D2. Build core pages
    - Homepage: featured products + collections
    - Product listing: paginated
    - Product detail: variants, images, add-to-cart
    - Cart + Checkout flow

D3. Customer auth (SEPARATE from merchant)
    - Customer login/register
    - Order history
    - Account settings
```

### PHASE E: Production Hardening (1 ngay)

```
E1. API Security
    - Rate limiting per endpoint
    - CORS configuration
    - API key authentication (for storefront)
    - Request validation (zod schemas)

E2. Performance
    - Redis session cache
    - API response caching
    - Database query optimization
    - Connection pooling

E3. Monitoring
    - Audit log for all write operations
    - Error tracking
    - Health check endpoints
    - PM2 cluster mode
```

---

## 7. NGINX ROUTING (FINAL)

```nginx
# Production Nginx Config for Gbox Platform

upstream gbox_api {
    server 127.0.0.1:4321;
    keepalive 32;
}

server {
    listen 80;
    server_name 192.168.1.13 _;

    gzip on;
    gzip_types text/plain text/css application/json application/javascript;

    # === API GATEWAY (TRUNG TAM) ===
    # Moi admin app goi qua day
    location /api/ {
        proxy_pass http://gbox_api;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Connection "";
        proxy_read_timeout 30s;
    }

    # === GOD ADMIN ===
    location /god-admin {
        proxy_pass http://127.0.0.1:4324;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Cookie $http_cookie;  # Forward cookies!
    }

    # === ACCOUNTS ===
    location /accounts/ {
        rewrite ^/accounts/(.*) /$1 break;
        proxy_pass http://127.0.0.1:4323;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Cookie $http_cookie;
    }
    location = /accounts {
        return 302 /accounts/login;
    }

    # === STORE ADMIN (EmDash) ===
    location /_emdash/admin/store/ {
        proxy_pass http://127.0.0.1:4325;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Cookie $http_cookie;
        proxy_read_timeout 30s;
    }

    # === STOREFRONT (DEFAULT) ===
    location / {
        proxy_pass http://127.0.0.1:4326;  # Astro SSR
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    client_max_body_size 50M;
}
```

---

## 8. PORT MAP (FINAL)

```
+-------+------------------+---------------------------+-------------------+
| Port  | Service          | Tinh nang                 | Truy cap          |
+-------+------------------+---------------------------+-------------------+
| 4321  | API Gateway      | REST API (JSON)           | /api/*            |
|       |                  | Session validation        | Internal + Public |
|       |                  | All business logic        |                   |
+-------+------------------+---------------------------+-------------------+
| 4323  | Accounts Portal  | Login/Signup/Password     | /accounts/*       |
|       |                  | Store list/create         |                   |
|       |                  | Account settings          |                   |
+-------+------------------+---------------------------+-------------------+
| 4324  | God Admin        | Platform management       | /god-admin/*      |
|       |                  | All stores/users/finance  |                   |
+-------+------------------+---------------------------+-------------------+
| 4325  | Store Admin      | Per-store management      | /_emdash/admin/*  |
|       |                  | Products/Orders/Customers |                   |
|       |                  | AI Agent                  |                   |
+-------+------------------+---------------------------+-------------------+
| 4326  | Storefront       | Customer-facing shop      | / (default)       |
|       |                  | Product catalog/Cart      |                   |
|       |                  | Checkout/Blog/Pages       |                   |
+-------+------------------+---------------------------+-------------------+
```

---

## 9. SECURITY MATRIX

```
+------------------+----------+---------+---------+---------+-----------+
| Endpoint Group   | God      | Store   | Store   | Store   | Customer  |
|                  | Admin    | Owner   | Admin   | Staff   | (Public)  |
+------------------+----------+---------+---------+---------+-----------+
| /api/platform/*  | ✅ FULL  | ❌      | ❌      | ❌      | ❌        |
| /api/shops/*     | ✅ ALL   | ✅ OWN  | ❌      | ❌      | ❌        |
| /api/products/*  | ✅ ALL   | ✅ OWN  | ✅ OWN  | ✅ READ | ✅ READ   |
| /api/orders/*    | ✅ ALL   | ✅ OWN  | ✅ OWN  | ✅ READ | ✅ OWN*   |
| /api/customers/* | ✅ ALL   | ✅ OWN  | ✅ OWN  | ✅ READ | ❌        |
| /api/analytics/* | ✅ ALL   | ✅ OWN  | ✅ OWN  | ❌      | ❌        |
| /api/checkout/*  | ✅ ALL   | ✅ OWN  | ✅ OWN  | ❌      | ✅ OWN    |
| /api/content/*   | ✅ ALL   | ✅ OWN  | ✅ OWN  | ✅ READ | ✅ READ   |
| /api/auth/*      | ✅       | ✅      | ✅      | ✅      | ✅        |
| /api/files/*     | ✅ ALL   | ✅ OWN  | ✅ OWN  | ❌      | ❌        |
+------------------+----------+---------+---------+---------+-----------+
* Customer chi xem order cua chinh minh
```

---

## 10. TOM TAT QUYET DINH

| # | Quyet dinh | Ly do |
|---|-----------|-------|
| 1 | API Gateway la trung tam | Single source of truth, 1 noi validate, 1 noi cache |
| 2 | Admin apps goi API qua HTTP internal | Decouple, co the scale rieng |
| 3 | Accounts giu truc tiep @gbox/core auth | Vi can set cookie truc tiep |
| 4 | Storefront goi API qua HTTP | Giong nhu Shopify Storefront API |
| 5 | God Admin qua API | Khong query DB truc tiep, bao mat tot hon |
| 6 | Redis cho session cache | Giam tai DB, tang toc validate |
| 7 | Audit log o API layer | Moi thay doi deu duoc ghi nhan |
| 8 | Shopify-compatible endpoints | De migrate tu/den Shopify |

---

**STATUS: CHO THAI DUYET TRUOC KHI IMPLEMENT**
