# SELLER DASHBOARD — DESIGN SPEC
## He Thong Quan Tri Cua Hang Gbox (Store Admin)

**Date**: 2026-04-07
**Author**: Claude (cho Thai Bui duyet)
**Status**: DRAFT — CHO DUYET
**Scope**: Nang cap Store Admin tu ~60% len 95% Shopify-level

---

## 1. TONG QUAN

### 1.1 Hien trang
Store Admin hien tai co 5 pages (Dashboard, Products, Orders, Customers, Settings) va 1 AI Agent co ban. Tong cong ~15 routes. Database da co 63 tables san sang nhung chua co UI cho phan lon.

### 1.2 Muc tieu
Nang cap thanh **Seller Dashboard cap Shopify** voi:
- **60 chuc nang** chia thanh **12 nhom (A-L)**
- AI tich hop **MOI page** (khong chi chat, ma AI xu ly truc tiep)
- Tu 15 routes → **~80 routes**
- Tu 5 pages → **~25 pages**
- Full dark theme nhat quan (giong God Admin)

### 1.3 Port & Route
```
Port: 4325
Base URL: /_emdash/admin/store/:slug

Route prefix: /_emdash/admin/store/:slug/[page]
AI endpoint: /_emdash/admin/store/:slug/ai/chat
```

---

## 2. MINDMAP — 12 NHOM CHUC NANG

```
                            SELLER DASHBOARD
                                  |
    +--------+--------+--------+--+--+--------+--------+--------+
    |        |        |        |     |        |        |        |
    A        B        C        D     E        F        G        H
  TONG     SAN     DON     KHACH  GIAM    MARKETING  ANALYTICS  ONLINE
  QUAN     PHAM    HANG    HANG   GIA                           STORE
    |        |        |        |     |        |        |        |
  A1-A7   B1-B8   C1-C7   D1-D6  E1-E5   F1-F5   G1-G6   H1-H6
    |
    +--------+--------+--------+
    |        |        |        |
    I        J        K        L
  SHIPPING  TAX    SETTINGS  AI
  & INV           & STAFF   AGENT
    |        |        |        |
  I1-I5   J1-J3   K1-K7   L1-L8
```

---

## 3. CHI TIET 12 NHOM

### A. TONG QUAN CUA HANG (7 chuc nang)

```
A1. Dashboard Tong (da co — nang cap)
    - Revenue, Orders, AOV, Customers (co so sanh period)
    - Revenue chart 7/30 ngay (CSS bar chart)
    - Orders chart theo ngay
    - Top 5 san pham ban chay
    - Don hang can xu ly (unfulfilled)
    - Low stock alerts
    → AI: "Hom nay ban hang the nao?" → analyzeSales()

A2. Live Sales Feed
    - Real-time don hang moi (auto-refresh 30s)
    - Notification sound option
    - Today's revenue ticker
    → AI: Notify unusual order patterns

A3. Store Health Score
    - Diem 0-100 dua tren:
      * Co san pham (0-15)
      * Co don hang 7 ngay (0-15)
      * Chat luong san pham — co anh, mo ta (0-15)
      * Khach hang quay lai (0-15)
      * SEO score (0-15)
      * Settings hoan thien (0-15)
      * Toc do xu ly don (0-10)
    - Recommendations cai thien
    → AI: storeHealthCheck() + actionable tips

A4. Quick Actions Panel
    - Tao san pham moi
    - Tao don hang thu cong
    - Tao giam gia
    - Xem don hang chua xu ly
    - Gui email marketing
    → AI: "Toi nen lam gi tiep?" → suggestions dua tren data

A5. Notification Center
    - Don hang moi, low stock, payment failed
    - Customer reviews
    - System alerts
    - Mark as read/unread
    → AI: Priority ranking

A6. AI Store Advisor (da co — nang cap)
    - Chat panel ben phai (da co)
    - NANG CAP: Them cac function moi cho moi page
    - Quick action buttons theo context page hien tai
    - Chat history per session
    → 30+ AI functions (xem Group L)

A7. Period Selector
    - Today / 7 days / 30 days / 90 days / Custom range
    - Apply cho tat ca stats tren dashboard
    - So sanh voi period truoc
```

### B. QUAN LY SAN PHAM (8 chuc nang)

```
B1. Product List (da co — nang cap)
    - Grid view + List view toggle
    - Bulk actions: delete, archive, change status
    - Sort by: name, price, inventory, created, best-selling
    - Advanced filters: status, type, vendor, tag, price range
    - Inventory indicator (in stock / low / out of stock)
    → AI: "San pham nao ban chay nhat?" → analyzeProducts()

B2. Product Detail/Edit (da co — nang cap)
    - Title, description (rich text — bold, italic, lists)
    - Media upload (drag & drop, multi-image)
    - Pricing: price, compare_at_price, cost_per_item
    - Inventory: track qty, SKU, barcode
    - Variants: option1/2/3 combinations
    - SEO: meta title, meta description, URL handle
    - Organization: product_type, vendor, tags, collections
    → AI: "Viet mo ta cho san pham nay" → writeProductDescription()
    → AI: "Goi y gia ban" → analyzePricing()

B3. Create Product (da co — nang cap)
    - Same form as B2 nhung trang tao moi
    - AI auto-suggest: title → description, tags, SEO
    → AI: "Tao san pham tu hinh anh" → analyzeImage() (future)

B4. Inventory Management (MOI)
    - Inventory levels per location
    - Adjust quantity (+/- with reason)
    - Transfer between locations
    - Inventory history log
    - Low stock report
    → AI: "Khi nao can nhap them hang?" → inventoryForecast()

B5. Collections (MOI)
    - Manual collections (chon san pham thu cong)
    - Auto collections (rules: price > X, tag = Y)
    - Collection image, description, SEO
    - Sort order: best-selling, price, date, manual
    → AI: "Goi y collections cho store" → suggestCollections()

B6. Gift Cards (MOI)
    - Create gift card (amount, code, expiry)
    - Gift card list + search
    - Transaction history per card
    - Disable/enable
    → AI: "Bao cao gift card" → analyzeGiftCards()

B7. Product Reviews (MOI)
    - Review list: rating, customer, product, date
    - Approve/reject/reply
    - Average rating per product
    - Review analytics
    → AI: "Phan tich danh gia" → analyzeReviews()

B8. AI Product Optimizer
    - Bulk SEO optimization suggestions
    - Price optimization (competitive analysis concept)
    - Description quality score
    - Image quality check
    → AI: "Toi uu hoa tat ca san pham" → bulkOptimize()
```

### C. QUAN LY DON HANG (7 chuc nang)

```
C1. Order List (da co — nang cap)
    - Enhanced filters: date range, amount range, payment gateway
    - Bulk actions: fulfill, archive, print
    - Export CSV
    - Order tags/notes
    → AI: "Don hang chua thanh toan" → analyzeOrders()

C2. Order Detail (da co — nang cap)
    - Timeline: created → paid → fulfilled → delivered
    - Edit shipping address
    - Add order notes (internal + customer-visible)
    - Print packing slip / invoice
    → AI: "Tom tat don hang nay" → summarizeOrder()

C3. Fulfill Order (da co — nang cap)
    - Partial fulfillment support
    - Tracking number + carrier
    - Notify customer via email
    - Fulfillment timeline
    → AI: Auto-suggest carrier based on address

C4. Refund/Cancel (MOI)
    - Full refund / partial refund
    - Restock items option
    - Refund reason (dropdown)
    - Refund to original payment method
    - Refund timeline in order detail
    → AI: "Nen refund khong?" → analyzeRefundRisk()

C5. Create Manual Order (MOI)
    - Search products to add
    - Set custom price / discount
    - Customer: existing or new
    - Payment: mark as paid / pending / COD
    - Shipping: calculate or custom
    → AI: Auto-fill customer details from email

C6. Order Analytics (MOI)
    - Orders by day/week/month chart
    - Average fulfillment time
    - Refund rate
    - Repeat order rate
    - Payment method distribution
    → AI: "Phan tich don hang thang nay" → orderAnalytics()

C7. AI Order Assistant
    - Fraud detection (unusual orders)
    - Auto-tag high-value orders
    - Predict delivery time
    - Suggest upsell for repeat customers
    → AI: "Co don hang bat thuong khong?" → detectFraud()
```

### D. QUAN LY KHACH HANG (6 chuc nang)

```
D1. Customer List (da co — nang cap)
    - Segments: VIP, New, At-risk, Inactive
    - Tags + notes
    - Export CSV
    - Bulk email
    → AI: "Phan loai khach hang" → segmentCustomers()

D2. Customer Detail (da co — nang cap)
    - Full profile + addresses
    - Order history timeline
    - Total spent, order count, AOV
    - Customer notes (internal)
    - Tags
    → AI: "Khach hang nay co gi dac biet?" → analyzeCustomer()

D3. Create Customer (MOI)
    - Form: name, email, phone, address
    - Tags, notes
    - Marketing consent (accepts_marketing)
    → AI: Auto-detect duplicate by email

D4. Customer Segments (MOI)
    - Auto segments: VIP (spent > X), New (< 30 days), Returning, At-risk
    - Custom segments: filter builder (spent, orders, location, tags)
    - Segment size + revenue contribution
    → AI: "Tao segment khach hang VIP" → createSegment()

D5. Customer Reviews (linked to B7)
    - View all reviews by customer
    - Response management

D6. AI Customer Insights
    - Lifetime value prediction
    - Churn risk score per customer
    - Next purchase prediction
    - Personalized marketing suggestions
    → AI: "Khach hang nao sap roi bo?" → predictChurn()
```

### E. GIAM GIA & KHUYEN MAI (5 chuc nang)

```
E1. Discount List (MOI)
    - Active / Scheduled / Expired tabs
    - Code + auto-apply discounts
    - Usage count, total savings
    → AI: "Giam gia nao hieu qua nhat?" → analyzeDiscounts()

E2. Create Discount (MOI)
    - Types: percentage, fixed amount, free shipping, BOGO
    - Applies to: all products, specific collections, specific products
    - Conditions: minimum purchase, minimum qty, customer eligibility
    - Usage limits: total uses, per customer
    - Schedule: start date, end date
    → AI: "Goi y giam gia cho Black Friday" → suggestDiscount()

E3. Discount Detail (MOI)
    - Edit all fields
    - Performance stats: uses, revenue generated, average discount amount
    - Customer list who used

E4. Automatic Discounts (MOI)
    - Volume discounts (buy 3+ get 10% off)
    - Bundle deals
    - Customer loyalty tiers
    → AI: "Tao chuong trinh loyalty" → createLoyaltyProgram()

E5. AI Promotion Engine
    - Optimal discount % suggestion
    - Best time to run promotion
    - Revenue impact prediction
    - A/B test suggestions
    → AI: "Chay promotion nao tot nhat?" → optimizePromotion()
```

### F. MARKETING (5 chuc nang)

```
F1. Marketing Dashboard (MOI)
    - Campaign overview
    - Channel performance (email, social, search)
    - Conversion tracking
    → AI: "Kenh marketing nao tot nhat?" → analyzeMarketing()

F2. Email Campaigns (MOI)
    - Template builder (chon template, edit content)
    - Recipient: all customers / segment / manual
    - Schedule send
    - Open rate, click rate tracking
    → AI: "Viet email marketing" → writeEmail()

F3. Abandoned Cart Recovery (MOI)
    - List abandoned checkouts
    - Auto-email reminder (1h, 24h, 72h)
    - Recovery rate stats
    → AI: "Bao nhieu gio hang bi bo?" → analyzeAbandoned()

F4. SEO Manager (MOI)
    - Store-wide SEO score
    - Page-by-page SEO audit
    - Meta title/description editor
    - Sitemap status
    - Structured data (JSON-LD)
    → AI: "Kiem tra SEO store" → seoAudit()

F5. AI Marketing Assistant
    - Content calendar suggestions
    - Social media post ideas
    - Product launch strategy
    - Competitor analysis concept
    → AI: "Lap ke hoach marketing thang nay" → marketingPlan()
```

### G. ANALYTICS & REPORTS (6 chuc nang)

```
G1. Analytics Dashboard (MOI)
    - Revenue chart (line, bar, area)
    - Orders chart
    - Visitors vs conversion (placeholder — need tracking)
    - Top products, top categories
    - Customer acquisition
    → AI: "Phan tich doanh thu" → analyzeRevenue()

G2. Sales Reports (MOI)
    - Sales by date range
    - Sales by product
    - Sales by location (customer address)
    - Sales by discount code
    - Export CSV/PDF
    → AI: "Bao cao doanh thu thang 3" → salesReport()

G3. Product Reports (MOI)
    - Best sellers
    - Slow movers
    - Inventory value
    - Product views → orders conversion (placeholder)
    → AI: "San pham nao can push?" → productReport()

G4. Customer Reports (MOI)
    - New vs returning
    - Customer lifetime value distribution
    - Geographic distribution
    - Cohort analysis (placeholder)
    → AI: "Bao cao khach hang" → customerReport()

G5. Financial Reports (MOI)
    - Gross revenue vs net revenue
    - Refunds & returns
    - Tax collected
    - Payment method breakdown
    - Profit margin per product (need cost_per_item)
    → AI: "Bao cao tai chinh" → financialReport()

G6. AI Report Generator
    - Natural language → auto-generate report
    - "Show me revenue by product for March"
    - Export to CSV
    → AI: "Tao bao cao..." → generateReport()
```

### H. ONLINE STORE (6 chuc nang)

```
H1. Theme Manager (MOI)
    - Current theme preview
    - Theme library (pre-built themes)
    - Activate / deactivate themes
    → AI: "Goi y theme phu hop" → suggestTheme()

H2. Page Builder (MOI)
    - CRUD pages (About, Contact, FAQ, etc.)
    - Rich text editor
    - SEO fields per page
    - Published / Draft status
    → AI: "Viet trang About Us" → writePage()

H3. Blog Manager (MOI)
    - CRUD blog posts
    - Categories / tags
    - Featured image
    - Published / Draft / Scheduled
    → AI: "Viet bai blog ve san pham moi" → writeBlog()

H4. Navigation Editor (MOI)
    - Main menu, footer menu
    - Drag & drop reorder (JS)
    - Nested menu items (2 levels)
    - Link to: page, collection, product, URL
    → AI: "Goi y cau truc menu" → suggestNavigation()

H5. Domain Manager (MOI)
    - Primary domain
    - Custom domain setup
    - SSL certificate status
    - DNS instructions
    → AI: Domain health check

H6. Files Manager (MOI)
    - Upload images, videos, documents
    - File browser with search
    - Used in: products, pages, blogs
    - Storage usage
    → AI: Image optimization suggestions
```

### I. SHIPPING & INVENTORY (5 chuc nang)

```
I1. Shipping Zones (MOI)
    - Create zones (US, EU, Asia, etc.)
    - Rates per zone: flat rate, weight-based, price-based, free
    - Carrier integration concept (USPS, UPS, FedEx)
    → AI: "Goi y gia ship" → suggestShipping()

I2. Shipping Rates (MOI)
    - Rate table per zone
    - Free shipping threshold
    - Local delivery option
    - Calculated rates (placeholder for carrier API)

I3. Locations (MOI)
    - Multi-location inventory
    - Add/edit locations (warehouse, store, etc.)
    - Default fulfillment location
    - Location-based inventory levels

I4. Inventory Transfers (MOI)
    - Transfer stock between locations
    - Transfer history
    - Pending / In-transit / Received status
    → AI: "Can chuyen hang tu kho A sang kho B" → suggestTransfer()

I5. AI Inventory Forecaster
    - Demand prediction per product
    - Reorder point suggestions
    - Seasonal trend detection
    - Stock-out risk alerts
    → AI: "Khi nao can nhap them hang?" → inventoryForecast()
```

### J. TAX (3 chuc nang)

```
J1. Tax Settings (MOI)
    - Tax regions (US states, EU countries, etc.)
    - Tax rates per region
    - Tax-inclusive / exclusive pricing
    - Auto-calculate tax

J2. Tax Exemptions (MOI)
    - Tax-exempt customers
    - Tax-exempt products
    - Certificate management (placeholder)

J3. Tax Reports (MOI)
    - Tax collected by region
    - Tax collected by period
    - Export for filing
    → AI: "Bao cao thue" → taxReport()
```

### K. SETTINGS & STAFF (7 chuc nang)

```
K1. General Settings (da co — nang cap)
    - Store name, email, phone
    - Address
    - Currency, timezone
    - Unit system (metric/imperial)

K2. Payment Settings (MOI)
    - Stripe configuration
    - PayPal configuration
    - Manual payment methods (COD, bank transfer)
    - Payment method priority
    → AI: "Nen dung payment gateway nao?" → suggestPayment()

K3. Notification Settings (MOI)
    - Email templates: order confirmation, shipping, refund
    - Enable/disable notifications
    - Custom sender name/email
    → AI: "Viet email template" → writeEmailTemplate()

K4. Staff Management (da co — nang cap)
    - Invite staff by email
    - Role assignment: admin, staff, limited
    - Permission matrix (per feature)
    - Remove staff access
    → AI: "Ai lam gi hom nay?" → staffActivity()

K5. Billing & Plan (MOI)
    - Current plan info
    - Usage stats
    - Upgrade/downgrade (placeholder)
    - Invoice history

K6. Legal Pages (MOI)
    - Privacy Policy generator
    - Terms of Service generator
    - Refund Policy generator
    - Cookie Policy
    → AI: "Tao chinh sach bao mat" → generateLegalPage()

K7. Store Activity Log (MOI)
    - All actions by staff
    - Filter by user, action type, date
    - Timeline view
```

### L. AI AGENT NANG CAP (8 chuc nang)

```
L1. AI Chat Panel (da co — nang cap)
    - Persistent chat history
    - Context-aware (biet page hien tai)
    - Suggested questions dua tren page
    - Rich HTML responses (tables, charts, cards)

L2. AI Sales Analyst
    - analyzeSales(period) — nang cap with charts
    - Revenue forecasting (7-day trend)
    - Peak hours analysis
    - Compare periods

L3. AI Product Writer
    - writeProductDescription(title, keywords)
    - writeSEO(product)
    - suggestTags(product)
    - translateProduct(product, lang) — placeholder

L4. AI Customer Analyst
    - segmentCustomers()
    - predictChurn(customerId)
    - calculateLTV(customerId)
    - suggestRetention(segment)

L5. AI Marketing Advisor
    - suggestCampaign(event)
    - writeEmail(purpose, segment)
    - writeSocialPost(product)
    - suggestDiscount(goal)

L6. AI Operations
    - inventoryForecast(productId)
    - fulfillmentPriority()
    - detectFraud(orderId)
    - suggestShippingRate(zone)

L7. AI Report Generator
    - generateReport(query)
    - "Doanh thu theo san pham thang 3"
    - Auto-format as table/chart
    - Export support

L8. AI Multilingual (Placeholder)
    - Vietnamese + English intent detection (da co)
    - Auto-translate product descriptions
    - Auto-translate emails
    - Multi-language storefront content
```

---

## 4. SO SANH VOI SHOPIFY

| Feature | Shopify | Gbox Hien Tai | Gbox Sau Upgrade |
|---------|---------|---------------|------------------|
| Dashboard | Full analytics | Basic 4 stats | A1-A7 with AI |
| Products | CRUD + variants + images | CRUD basic | B1-B8 + AI optimizer |
| Orders | Full lifecycle | List + fulfill | C1-C7 + AI fraud |
| Customers | Segments + marketing | List + detail | D1-D6 + AI churn |
| Discounts | Full coupon system | None | E1-E5 + AI engine |
| Marketing | Email + SMS + social | None | F1-F5 + AI assistant |
| Analytics | Full reports | None | G1-G6 + AI reports |
| Online Store | Theme + pages + blog | Placeholder | H1-H6 + AI content |
| Shipping | Zones + carriers | None | I1-I5 + AI forecast |
| Tax | Auto-calculate | None | J1-J3 |
| Settings | Full config | Basic general | K1-K7 + AI |
| AI | Shopify Magic (limited) | 10 functions | 30+ functions |

**Sau upgrade: ~95% Shopify feature parity + AI vuot troi Shopify**

---

## 5. DESIGN SYSTEM

```
DARK THEME (nhat quan voi God Admin):
  --seller-bg:         #0f172a
  --seller-sidebar:    #0c1222
  --seller-topbar:     #111827
  --seller-card:       #1e293b
  --seller-border:     #1e293b
  --seller-accent:     #6366f1 (indigo — phan biet voi God Admin blue)
  --seller-text:       #e2e8f0
  --seller-text-muted: #94a3b8
  --seller-success:    #22c55e
  --seller-warning:    #f59e0b
  --seller-danger:     #ef4444

LAYOUT:
  Sidebar: 240px (giu nguyen)
  Topbar: 56px (giu nguyen)
  AI Panel: 360px (giu nguyen, nang cap UI)
  Content: padding 24px

LUU Y: Accent color = indigo (#6366f1) de phan biet:
  - God Admin: blue (#3b82f6)
  - Seller Dashboard: indigo (#6366f1)
  - Accounts Portal: neutral
```

---

## 6. ROUTE MAP DAY DU (~80 routes)

```
A. Overview:
  GET  /store/:slug                          — Dashboard
  GET  /store/:slug/live-feed                — Live sales feed
  GET  /store/:slug/health                   — Store health score
  GET  /store/:slug/notifications            — Notification center

B. Products:
  GET  /store/:slug/products                 — Product list
  GET  /store/:slug/products/new             — Create product
  GET  /store/:slug/products/:id             — Product detail/edit
  POST /store/:slug/products                 — Save new product
  POST /store/:slug/products/:id             — Update product
  POST /store/:slug/products/:id/delete      — Delete product
  GET  /store/:slug/products/inventory       — Inventory management
  GET  /store/:slug/products/collections     — Collections list
  GET  /store/:slug/products/collections/new — Create collection
  GET  /store/:slug/products/collections/:id — Collection detail
  POST /store/:slug/products/collections     — Save collection
  GET  /store/:slug/products/gift-cards      — Gift cards
  POST /store/:slug/products/gift-cards      — Create gift card
  GET  /store/:slug/products/reviews         — Product reviews

C. Orders:
  GET  /store/:slug/orders                   — Order list
  GET  /store/:slug/orders/new               — Create manual order
  GET  /store/:slug/orders/:id               — Order detail
  POST /store/:slug/orders                   — Save manual order
  POST /store/:slug/orders/:id/fulfill       — Fulfill order
  POST /store/:slug/orders/:id/refund        — Refund order
  POST /store/:slug/orders/:id/cancel        — Cancel order
  GET  /store/:slug/orders/analytics         — Order analytics

D. Customers:
  GET  /store/:slug/customers                — Customer list
  GET  /store/:slug/customers/new            — Create customer
  GET  /store/:slug/customers/:id            — Customer detail
  POST /store/:slug/customers                — Save customer
  GET  /store/:slug/customers/segments       — Customer segments

E. Discounts:
  GET  /store/:slug/discounts                — Discount list
  GET  /store/:slug/discounts/new            — Create discount
  GET  /store/:slug/discounts/:id            — Discount detail
  POST /store/:slug/discounts                — Save discount
  POST /store/:slug/discounts/:id/delete     — Delete discount

F. Marketing:
  GET  /store/:slug/marketing                — Marketing dashboard
  GET  /store/:slug/marketing/campaigns      — Email campaigns
  GET  /store/:slug/marketing/campaigns/new  — Create campaign
  GET  /store/:slug/marketing/abandoned      — Abandoned carts
  GET  /store/:slug/marketing/seo            — SEO manager

G. Analytics:
  GET  /store/:slug/analytics                — Analytics dashboard
  GET  /store/:slug/analytics/sales          — Sales reports
  GET  /store/:slug/analytics/products       — Product reports
  GET  /store/:slug/analytics/customers      — Customer reports
  GET  /store/:slug/analytics/finance        — Financial reports

H. Online Store:
  GET  /store/:slug/online-store             — Overview
  GET  /store/:slug/online-store/themes      — Theme manager
  GET  /store/:slug/online-store/pages       — Pages list
  GET  /store/:slug/online-store/pages/new   — Create page
  GET  /store/:slug/online-store/pages/:id   — Edit page
  POST /store/:slug/online-store/pages       — Save page
  GET  /store/:slug/online-store/blog        — Blog posts
  GET  /store/:slug/online-store/blog/new    — Create blog post
  GET  /store/:slug/online-store/blog/:id    — Edit blog post
  POST /store/:slug/online-store/blog        — Save blog post
  GET  /store/:slug/online-store/navigation  — Menu editor
  POST /store/:slug/online-store/navigation  — Save menu
  GET  /store/:slug/online-store/domains     — Domain manager
  GET  /store/:slug/online-store/files       — File manager

I. Shipping:
  GET  /store/:slug/settings/shipping        — Shipping zones
  POST /store/:slug/settings/shipping        — Save shipping
  GET  /store/:slug/settings/locations        — Locations
  POST /store/:slug/settings/locations        — Save location

J. Tax:
  GET  /store/:slug/settings/taxes           — Tax settings
  POST /store/:slug/settings/taxes           — Save taxes

K. Settings:
  GET  /store/:slug/settings                 — Settings home
  GET  /store/:slug/settings/general         — General
  POST /store/:slug/settings/general         — Save general
  GET  /store/:slug/settings/payments        — Payment settings
  POST /store/:slug/settings/payments        — Save payments
  GET  /store/:slug/settings/notifications   — Notification settings
  GET  /store/:slug/settings/staff           — Staff management
  POST /store/:slug/settings/staff/invite    — Invite staff
  POST /store/:slug/settings/staff/:id/remove — Remove staff
  GET  /store/:slug/settings/billing         — Billing & plan
  GET  /store/:slug/settings/legal           — Legal pages
  GET  /store/:slug/settings/activity        — Activity log

L. AI:
  POST /store/:slug/ai/chat                  — AI chat (da co)
  GET  /store/:slug/ai/suggestions           — AI context suggestions
```

---

## 7. IMPLEMENTATION PRIORITY

### Dot 1: Core (high impact, schema da co) — 30 chuc nang
Groups: A (nang cap), B (nang cap + B4-B7), C (nang cap + C4-C6), D (nang cap + D3-D4), L (nang cap)

### Dot 2: Commerce (revenue features) — 16 chuc nang
Groups: E (E1-E5), G (G1-G6), I (I1-I5)

### Dot 3: Growth (marketing + content) — 14 chuc nang
Groups: F (F1-F5), H (H1-H6), J (J1-J3)

---

## 8. ESTIMATED IMPACT

- **~25 page files** moi/nang cap
- **~80 routes** (tu 15 hien tai)
- **~15,000-20,000 LOC** moi
- **30+ AI functions** (tu 10 hien tai)
- **95% Shopify feature parity**

---

**STATUS: CHO THAI DUYET TRUOC KHI IMPLEMENT**
