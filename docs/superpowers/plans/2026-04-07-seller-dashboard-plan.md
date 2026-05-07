# SELLER DASHBOARD — KE HOACH IMPLEMENT CHI TIET
## 10 Phase Tu Co Ban Den Shopify-Level + AI

**Date**: 2026-04-07
**Author**: Claude (cho Thai Bui duyet)
**Status**: DRAFT — CHO DUYET
**Estimated**: 10 phases, ~25 page files, ~80 routes, ~15,000-20,000 LOC

---

## PHASE 1: Foundation — Layout, Auth, Nang cap Dashboard (A1, A4, A7)

### Muc tieu
Xay dung nen tang: seller-layout.ts moi (dark theme, indigo accent), auth middleware cho multi-tenant, va nang cap dashboard tong.

### Tasks

**1.1 Seller Layout (seller-layout.ts)**
- Dark theme giong God Admin nhung accent = indigo (#6366f1)
- Light/Dark mode toggle (luu vao cookie, default = dark) — co the polish sau
- Sidebar: 12 nhom A-L voi icons
- Topbar: store name, user info, AI toggle, theme toggle
- AI Panel: 360px ben phai (giu nguyen co che, nang cap UI)
- Mobile responsive hamburger menu
- CSS custom properties (--seller-*)

**1.2 Auth Middleware Nang Cap (seller-auth.ts)**
- Kiem tra user co quyen truy cap store (qua user_shops table)
- req.storeAdmin = { user, shop, role, permissions }
- Role check: owner > admin > staff
- Redirect den /accounts/login neu chua dang nhap
- **MOI: Audit logging** — MOI hanh dong cua store user deu ghi vao audit_logs (shop_id + user_id + action + ip)
  → God Admin co the xem TOAN BO activity cua moi store

**1.3 Dashboard Nang Cap (A1)**
- Revenue, Orders, AOV, Customers voi period comparison
- Revenue chart 7/30 ngay (CSS bar chart)
- Orders chart theo ngay
- Top 5 san pham ban chay
- Don hang can xu ly (unfulfilled count)
- Low stock alerts
- AI: "Hom nay ban hang the nao?" → analyzeSales()

**1.4 Quick Actions Panel (A4)**
- Shortcuts: tao san pham, tao don hang, tao giam gia, xem unfulfilled
- AI: "Toi nen lam gi tiep?" → context-based suggestions

**1.5 Period Selector (A7)**
- Today / 7d / 30d / 90d / Custom range
- Apply cho tat ca dashboard stats
- So sanh period truoc (vs yesterday, vs last week, vs last month)

### Files moi/sua
- `apps/store-admin/src/layouts/seller-layout.ts` (MOI)
- `apps/store-admin/src/middleware/seller-auth.ts` (SUA)
- `apps/store-admin/src/pages/dashboard.ts` (SUA lon)

### Ket qua
Dashboard hoan chinh voi dark theme, 4 main stats + charts + alerts, hoat dong cho moi store.

---

## PHASE 2: Products Power-Up — CRUD Nang Cap + Inventory + Collections (B1-B5)

### Muc tieu
Nang cap product management thanh Shopify-level: grid/list view, bulk actions, inventory management, collections.

### Tasks

**2.1 Product List Nang Cap (B1)**
- Grid view + List view toggle
- Bulk actions: delete, archive, change status (draft/active)
- Sort: name, price, inventory, created, best-selling
- Advanced filters: status, type, vendor, tag, price range
- Inventory badge: in stock (green) / low (yellow) / out (red)
- AI: "San pham nao ban chay nhat?" → analyzeProducts()

**2.1b AI Product Research & Spy Tool (MOI — QUAN TRONG)**
- Tich hop API Claude AI de nghien cuu thi truong san pham
- **Product Spy**: Seller nhap tu khoa/niche → AI phan tich va suggest:
  * San pham Print-on-Demand (POD) hot trend
  * San pham Dropship tiem nang
  * Phan tich hanh vi ban hang cua seller → goi y san pham phu hop
- **Deep Product Research**: Seller hoi ve 1 san pham cu the → AI danh gia sau:
  * Market demand (xu huong tim kiem)
  * Competition level (do canh tranh)
  * Profit margin potential
  * Target audience
  * Marketing strategy suggestions
- **Keyword Intelligence**: AI phan tich keywords cua seller → suggest san pham lien quan
- UI: Tab "AI Product Research" tren trang products, hoac hoi qua AI chat
- AI functions: spyProducts(keyword), researchProduct(query), suggestPOD(niche), suggestDropship(niche)

**2.2 Product Detail/Edit Nang Cap (B2)**
- Rich text editor cho description (bold, italic, lists, links)
- Media section: drag & drop, multi-image, reorder
- Pricing: price, compare_at_price, cost_per_item (cho profit calc)
- Inventory: track qty, SKU, barcode
- Variants: option1/2/3 combinations voi rieng gia/inventory
- SEO: meta_title, meta_description, url_handle
- Organization: product_type, vendor, tags (multi-select), collections
- AI: "Viet mo ta san pham" → writeProductDescription()
- AI: "Goi y gia ban" → analyzePricing()

**2.3 Create Product Nang Cap (B3)**
- Same form B2 nhung create mode
- AI auto-suggest: nhap title → auto-fill description, tags, SEO meta

**2.4 Inventory Management (B4 — MOI)**
- Inventory levels overview (all products)
- Adjust quantity: +/- voi reason (received, damaged, counted, etc.)
- Inventory history log per product
- Low stock report (configurable threshold)
- AI: "Khi nao can nhap them hang?" → inventoryForecast()

**2.5 Collections (B5 — MOI)**
- Manual collections: chon san pham thu cong
- Auto collections: rules (price > X, tag contains Y, vendor = Z)
- Collection image, title, description, SEO fields
- Sort: best-selling, price, date, A-Z, manual drag
- AI: "Goi y collections cho store" → suggestCollections()

### Files moi/sua
- `apps/store-admin/src/pages/products.ts` (SUA lon)
- `apps/store-admin/src/pages/inventory.ts` (MOI)
- `apps/store-admin/src/pages/collections.ts` (MOI)

### Ket qua
Product management ngang Shopify: full CRUD, variants, inventory tracking, collections, bulk actions.

---

## PHASE 3: Orders Full Lifecycle — Fulfill + Refund + Manual Orders (C1-C6)

### Muc tieu
Order management day du: full lifecycle tu create → paid → fulfilled → delivered, refund/cancel, manual orders.

### Tasks

**3.1 Order List Nang Cap (C1)**
- Enhanced filters: date range, amount range, status, payment method
- Bulk actions: fulfill selected, archive, export CSV
- Order tags + internal notes
- Status badges: pending / paid / fulfilled / delivered / cancelled / refunded
- AI: "Don hang chua thanh toan" → filterOrders()

**3.2 Order Detail Nang Cap (C2)**
- Timeline: created → paid → fulfilled → shipped → delivered
- Edit shipping address (post-order correction)
- Order notes: internal (staff only) + customer-visible
- Print: packing slip, invoice (HTML print-friendly)
- AI: "Tom tat don hang" → summarizeOrder()

**3.3 Order Tracking & Fulfillment View (C3 — DIEU CHINH)**
- **Gbox Fulfills ALL orders** — Seller KHONG tu fulfill
- Seller xem trang thai fulfillment tu he thong Gbox (God Admin)
- Tracking info tu dong cap nhat tu fulfillment center
- Timeline: order created → Gbox received → picking → shipped → delivered
- Seller co the xem tracking number, carrier, estimated delivery
- Notify customer button (gui email voi tracking info)
- AI: "Trang thai don hang #1234?" → checkFulfillmentStatus()

**3.4 Refund Request (C4 — DIEU CHINH)**
- Seller TAO YEU CAU refund (khong tu refund truc tiep)
- Refund request gui ve God Admin de duyet
- Form: chon line items, so tien, ly do (defective, wrong item, customer request)
- Restock option (God Admin quyet dinh)
- Trang thai: Pending → Approved/Rejected boi God Admin
- Timeline hien thi tren order detail
- AI: "Nen yeu cau refund khong?" → analyzeRefundRisk()

**3.5 Create Manual Order (C5 — MOI)**
- Search & add products (inline product picker)
- Set custom price / line-item discount
- Customer: search existing or create new inline
- Payment: mark as paid / pending / COD
- Shipping: auto-calculate or custom amount
- AI: Auto-fill customer details from email

**3.6 Order Analytics (C6 — MOI)**
- Orders by day/week/month (bar chart)
- Average fulfillment time
- Refund rate + refund amount
- Repeat order rate
- Payment method distribution (pie chart)
- AI: "Phan tich don hang thang nay" → orderAnalytics()

### Files moi/sua
- `apps/store-admin/src/pages/orders.ts` (SUA lon)
- `apps/store-admin/src/pages/order-detail.ts` (MOI hoac SUA)
- `apps/store-admin/src/pages/order-analytics.ts` (MOI)

### Ket qua
Full order lifecycle giong Shopify: create → pay → fulfill → deliver → refund, voi analytics.

---

## PHASE 4: Customer CRM — Segments + AI Insights (D1-D6)

### Muc tieu
Nang cap customer management thanh CRM mini: segments, lifecycle tracking, AI churn prediction.

### Tasks

**4.1 Customer List Nang Cap (D1)**
- Auto segments: VIP, New (< 30 days), Returning, At-risk, Inactive
- Tags + internal notes
- Export CSV
- Quick stats: total customers, new this month, VIP count
- AI: "Phan loai khach hang" → segmentCustomers()

**4.2 Customer Detail Nang Cap (D2)**
- Full profile: name, email, phone, addresses
- Order history timeline (click to view order)
- Lifetime stats: total spent, order count, AOV, first order, last order
- Customer notes (internal, timestamps)
- Tags management
- AI: "Khach hang nay co gi dac biet?" → analyzeCustomer()

**4.3 Create Customer (D3 — MOI)**
- Form: first_name, last_name, email, phone
- Default address fields
- Tags, notes, marketing consent (accepts_marketing)
- AI: Auto-detect duplicate by email before save

**4.4 Customer Segments (D4 — MOI)**
- Auto segments: VIP (spent > threshold), New, Returning, At-risk (no order 60d), Inactive (no order 90d)
- Custom segments: filter builder (spent range, order count, location, tags, last order date)
- Segment stats: size, revenue contribution, AOV
- AI: "Tao segment khach hang VIP" → createSegment()

**4.5 Customer Reviews (D5)**
- View all reviews by customer (linked to B7)
- Response management

**4.6 AI Customer Insights (D6 — MOI)**
- Lifetime value prediction per customer
- Churn risk score (0-100)
- Next purchase prediction
- Personalized marketing suggestions
- AI: "Khach hang nao sap roi bo?" → predictChurn()

### Files moi/sua
- `apps/store-admin/src/pages/customers.ts` (SUA lon)
- `apps/store-admin/src/pages/customer-detail.ts` (MOI hoac SUA)
- `apps/store-admin/src/pages/customer-segments.ts` (MOI)

### Ket qua
CRM mini voi segments, lifecycle tracking, AI churn prediction — vuot Shopify co ban.

---

## PHASE 5: Discounts & Promotions — Full Coupon System (E1-E5)

### Muc tieu
Xay dung he thong discount day du: codes, automatic discounts, BOGO, volume pricing, AI optimization.

### Tasks

**5.1 Discount List (E1 — MOI)**
- Tabs: Active / Scheduled / Expired
- Show: code, type, value, usage count, total savings
- Quick enable/disable toggle
- AI: "Giam gia nao hieu qua nhat?" → analyzeDiscounts()

**5.2 Create Discount (E2 — MOI)**
- Type: percentage, fixed amount, free shipping, BOGO
- Applies to: all products, specific collections, specific products
- Conditions: minimum purchase amount, minimum quantity, customer eligibility (all/specific segments)
- Usage limits: total uses, per-customer limit
- Schedule: start date/time, end date/time (or no end)
- Auto-generate code or custom code
- AI: "Goi y giam gia cho Black Friday" → suggestDiscount()

**5.3 Discount Detail (E3 — MOI)**
- Edit all fields from E2
- Performance dashboard: total uses, revenue generated, avg discount amount
- Customer list who used this discount

**5.4 Automatic Discounts (E4 — MOI)**
- Volume discounts: buy 3+ get 10% off
- Bundle deals: buy A + B get 15% off
- Customer loyalty tiers: VIP auto 5% off
- AI: "Tao chuong trinh loyalty" → createLoyaltyProgram()

**5.5 AI Promotion Engine (E5 — MOI)**
- Optimal discount % suggestion (margin-aware)
- Best time to run promotion (based on order patterns)
- Revenue impact prediction
- A/B test suggestions
- AI: "Chay promotion nao tot nhat?" → optimizePromotion()

### Files moi/sua
- `apps/store-admin/src/pages/discounts.ts` (MOI)
- `apps/store-admin/src/pages/discount-detail.ts` (MOI)

### Ket qua
He thong coupon Shopify-level: codes, auto-apply, BOGO, volume, scheduling, AI optimization.

---

## PHASE 6: Analytics & Reports — Data-Driven Dashboard (G1-G6)

### Muc tieu
Full analytics suite: sales, products, customers, finance reports voi AI report generator.

### Tasks

**6.1 Analytics Dashboard (G1 — MOI)**
- Revenue chart (CSS bar/area chart, 7d/30d/90d)
- Orders chart (daily trend)
- Top products (by revenue + by quantity)
- Top categories/collections
- Customer acquisition (new vs returning per week)
- AI: "Phan tich doanh thu" → analyzeRevenue()

**6.2 Sales Reports (G2 — MOI)**
- Sales by date range (table + chart)
- Sales by product (ranked)
- Sales by customer location (state/country)
- Sales by discount code
- Export CSV
- AI: "Bao cao doanh thu thang 3" → salesReport()

**6.3 Product Reports (G3 — MOI)**
- Best sellers (by revenue, by qty)
- Slow movers (lowest sales in period)
- Inventory value (total cost, total retail)
- Product performance comparison
- AI: "San pham nao can push?" → productReport()

**6.4 Customer Reports (G4 — MOI)**
- New vs returning customers chart
- Customer LTV distribution
- Geographic distribution map (table-based)
- Top customers by spend
- AI: "Bao cao khach hang" → customerReport()

**6.5 Financial Reports (G5 — MOI)**
- Gross revenue vs net revenue (after refunds/discounts)
- Refunds & returns summary
- Tax collected by region
- Payment method breakdown
- Profit margin per product (need cost_per_item from B2)
- AI: "Bao cao tai chinh" → financialReport()

**6.6 AI Report Generator (G6 — MOI)**
- Natural language → auto-generate report
- "Doanh thu theo san pham thang 3" → table + chart
- "So sanh tuan nay voi tuan truoc" → comparison view
- Export to CSV
- AI: "Tao bao cao..." → generateReport()

### Files moi/sua
- `apps/store-admin/src/pages/analytics.ts` (MOI)
- `apps/store-admin/src/pages/reports-sales.ts` (MOI)
- `apps/store-admin/src/pages/reports-products.ts` (MOI)
- `apps/store-admin/src/pages/reports-customers.ts` (MOI)
- `apps/store-admin/src/pages/reports-finance.ts` (MOI)

### Ket qua
Full analytics suite voi 5 report types + AI report generator — seller co data de ra quyet dinh.

---

## PHASE 7: Online Store — Themes, Pages, Blog, Navigation (H1-H6)

### Muc tieu
Content management cho storefront: theme manager, page builder, blog, navigation, domain, files.

### Tasks

**7.1 Theme Manager (H1 — MOI)**
- Hien thi current theme (name, screenshot placeholder)
- Theme library: 3-5 pre-built theme options
- Activate/deactivate theme
- AI: "Goi y theme phu hop" → suggestTheme()

**7.2 Page Builder (H2 — MOI)**
- CRUD pages: About, Contact, FAQ, Terms, Privacy, etc.
- Rich text editor (same as product description)
- SEO fields: meta title, meta description, URL handle
- Status: Published / Draft
- AI: "Viet trang About Us" → writePage()

**7.3 Blog Manager (H3 — MOI)**
- CRUD blog posts: title, content, excerpt
- Categories/tags
- Featured image
- Status: Published / Draft / Scheduled
- Author attribution
- AI: "Viet bai blog ve san pham moi" → writeBlog()

**7.4 Navigation Editor (H4 — MOI)**
- Main menu + footer menu
- Add items: page, collection, product, custom URL
- Nested items (2 levels)
- Reorder (up/down buttons — JS drag later)
- AI: "Goi y cau truc menu" → suggestNavigation()

**7.5 Domain Manager (H5 — MOI)**
- Primary domain: shop-slug.gbox.co (auto)
- Custom domain: CNAME instructions
- SSL status indicator
- AI: Domain health check

**7.6 Files Manager (H6 — MOI)**
- Upload files (images, videos, docs)
- File browser: grid view voi thumbnails
- Search files by name
- File usage: linked products, pages, blogs
- Storage usage stats
- AI: Image optimization suggestions

### Files moi/sua
- `apps/store-admin/src/pages/online-store.ts` (MOI)
- `apps/store-admin/src/pages/pages.ts` (MOI)
- `apps/store-admin/src/pages/blog.ts` (MOI)
- `apps/store-admin/src/pages/navigation.ts` (MOI)
- `apps/store-admin/src/pages/domains.ts` (MOI)
- `apps/store-admin/src/pages/files.ts` (MOI)

### Ket qua
Seller co the quan ly content storefront: themes, pages, blog, menus, domains, files.

---

## PHASE 8: Marketing — Campaigns, Abandoned Cart, SEO (F1-F5)

### Muc tieu
Marketing tools: email campaigns, abandoned cart recovery, SEO audit, AI marketing assistant.

### Tasks

**8.1 Marketing Dashboard (F1 — MOI)**
- Campaign overview: active, scheduled, completed
- Channel performance summary
- Quick stats: emails sent, open rate, revenue from marketing
- AI: "Kenh marketing nao tot nhat?" → analyzeMarketing()

**8.2 Email Campaigns (F2 — MOI)**
- Template selection (3-5 pre-built templates)
- Content editor: subject, body (rich text), CTA button
- Recipients: all customers / specific segment / manual list
- Schedule: send now or schedule
- Stats: sent, opened, clicked (tracking via redirect links)
- AI: "Viet email marketing" → writeEmail()

**8.3 Abandoned Cart Recovery (F3 — MOI)**
- List abandoned checkouts (cart items, customer, time)
- Auto-reminder configuration: 1h, 24h, 72h emails
- Recovery rate stats
- Manual send reminder
- AI: "Bao nhieu gio hang bi bo?" → analyzeAbandoned()

**8.4 SEO Manager (F4 — MOI)**
- Store-wide SEO score (0-100)
- Page-by-page audit: missing titles, descriptions, images without alt
- Bulk meta title/description editor
- Sitemap status
- AI: "Kiem tra SEO store" → seoAudit()

**8.5 AI Marketing Assistant (F5 — MOI)**
- Content calendar suggestions (holidays, events)
- Social media post ideas for products
- Product launch strategy
- AI: "Lap ke hoach marketing thang nay" → marketingPlan()

### Files moi/sua
- `apps/store-admin/src/pages/marketing.ts` (MOI)
- `apps/store-admin/src/pages/campaigns.ts` (MOI)
- `apps/store-admin/src/pages/abandoned-carts.ts` (MOI)
- `apps/store-admin/src/pages/seo.ts` (MOI)

### Ket qua
Marketing suite co ban: email campaigns, abandoned cart recovery, SEO audit, AI content suggestions.

---

## PHASE 9: Shipping, Tax, Settings, Staff (I1-I5, J1-J3, K1-K7)

### Muc tieu
Configuration: shipping zones/rates, tax settings, payment config, staff management, legal pages.

### Tasks

**9.1 Shipping Zones (I1 — MOI)**
- Create zones: Domestic, International, Asia, EU, etc.
- Rates per zone: flat rate, weight-based, price-based, free shipping
- Free shipping threshold
- AI: "Goi y gia ship" → suggestShipping()

**9.2 Shipping Rates (I2 — MOI)**
- Rate table editor per zone
- Conditions: weight range, price range
- Local delivery option
- Carrier rate placeholder (USPS, UPS, FedEx — future API)

**9.3 Locations (I3 — MOI)**
- Multi-location: warehouse, retail store, pop-up
- Default fulfillment location
- Address per location
- Inventory levels per location (links to B4)

**9.4 Inventory Transfers (I4 — MOI)**
- Transfer stock between locations
- Transfer record: from, to, items, qty, status
- Status: Pending / In-transit / Received
- AI: "Can chuyen hang?" → suggestTransfer()

**9.5 Tax Settings (J1-J2 — MOI)**
- Tax regions (US states, EU countries)
- Tax rates per region
- Tax inclusive/exclusive toggle
- Tax-exempt customers/products
- AI: Tax calculation check

**9.6 Tax Reports (J3 — MOI)**
- Tax collected by region + period
- Export for filing
- AI: "Bao cao thue" → taxReport()

**9.7 General Settings Nang Cap (K1)**
- Store name, email, phone, address
- Currency, timezone, unit system
- Logo upload
- Social media links

**9.8 Payment Settings (K2 — MOI)**
- Stripe config (API keys)
- PayPal config
- Manual: COD, bank transfer
- Payment method priority order
- AI: "Nen dung payment gateway nao?" → suggestPayment()

**9.9 Notification Settings (K3 — MOI)**
- Email templates: order confirmation, shipping notification, refund
- Enable/disable per notification type
- Custom sender name/email
- AI: "Viet email template" → writeEmailTemplate()

**9.10 Staff Management Nang Cap (K4)**
- Invite staff by email
- Role: owner, admin, staff
- Permission matrix: products, orders, customers, settings, analytics
- Remove staff access
- Staff activity log
- AI: "Ai lam gi hom nay?" → staffActivity()

**9.11 Billing & Plan (K5 — MOI)**
- Current plan info + usage
- Plan comparison table
- Placeholder: upgrade/downgrade

**9.12 Legal Pages (K6 — MOI)**
- Privacy Policy generator (fill form → generate)
- Terms of Service generator
- Refund Policy generator
- AI: "Tao chinh sach bao mat" → generateLegalPage()

**9.13 Store Activity Log (K7 — MOI)**
- All staff actions: created, updated, deleted
- Filter: by user, action type, date range
- Timeline view

### Files moi/sua
- `apps/store-admin/src/pages/shipping.ts` (MOI)
- `apps/store-admin/src/pages/locations.ts` (MOI)
- `apps/store-admin/src/pages/taxes.ts` (MOI)
- `apps/store-admin/src/pages/settings.ts` (SUA lon)
- `apps/store-admin/src/pages/staff.ts` (MOI)
- `apps/store-admin/src/pages/billing.ts` (MOI)
- `apps/store-admin/src/pages/legal.ts` (MOI)
- `apps/store-admin/src/pages/activity-log.ts` (MOI)

### Ket qua
Full store configuration: shipping, tax, payments, staff, billing, legal — store san sang hoat dong.

---

## PHASE 10: AI Agent Nang Cap + Gift Cards + Reviews + Final Polish (L1-L8, B6-B8)

### Muc tieu
Nang cap AI Agent voi 30+ functions, them gift cards, product reviews, va polish toan bo.

### Tasks

**10.1 AI Chat Panel Nang Cap (L1)**
- Persistent chat history (per session, stored in DB)
- Context-aware: AI biet page hien tai, data tren page
- Suggested questions dua tren context
- Rich responses: tables, mini-charts, action cards
- Quick action buttons noi lien tu AI response

**10.2 AI Sales Analyst (L2)**
- analyzeSales(period) — revenue, orders, AOV voi trend
- Revenue forecasting (7-day linear trend)
- Peak hours/days analysis
- Period comparison (auto vs last period)

**10.3 AI Product Writer (L3)**
- writeProductDescription(title, keywords) — SEO-optimized
- writeSEO(product) — meta title + description
- suggestTags(product) — smart tag suggestions
- translateProduct(product, lang) — placeholder for multi-lang

**10.4 AI Customer Analyst (L4)**
- segmentCustomers() — auto VIP/new/at-risk
- predictChurn(customerId) — 0-100 score
- calculateLTV(customerId) — predicted lifetime value
- suggestRetention(segment) — retention strategy

**10.5 AI Marketing Advisor (L5)**
- suggestCampaign(event) — holiday, seasonal
- writeEmail(purpose, segment) — full email content
- writeSocialPost(product) — social media copy
- suggestDiscount(goal) — optimal discount for goal

**10.6 AI Operations (L6)**
- inventoryForecast(productId) — reorder timing
- fulfillmentPriority() — which orders to ship first
- detectFraud(orderId) — suspicious order detection
- suggestShippingRate(zone) — competitive rate analysis

**10.7 AI Report Generator (L7)**
- Natural language → SQL-like query → formatted report
- Vietnamese + English intent
- Auto table/chart formatting
- CSV export

**10.8 Gift Cards (B6 — MOI)**
- Create: amount, custom code, expiry date
- List + search + filter (active/used/expired)
- Transaction history per card
- Enable/disable
- AI: "Bao cao gift card" → analyzeGiftCards()

**10.9 Product Reviews (B7 — MOI)**
- Review list: rating (1-5 stars), customer, product, date
- Approve / reject / reply actions
- Average rating per product (displayed on product detail)
- Review analytics: avg rating trend, sentiment
- AI: "Phan tich danh gia" → analyzeReviews()

**10.10 AI Product Optimizer (B8 — MOI)**
- Bulk SEO optimization scan
- Price optimization suggestions
- Description quality score (0-100)
- Image quality check (has image, size, alt text)
- AI: "Toi uu hoa tat ca san pham" → bulkOptimize()

**10.11 Live Sales Feed (A2)**
- Real-time orders (auto-refresh 30s)
- Today's revenue ticker
- AI: Unusual pattern detection

**10.12 Store Health Score (A3)**
- Score 0-100: products, orders, quality, returning customers, SEO, settings, speed
- Actionable recommendations
- AI: storeHealthCheck()

**10.13 Notification Center (A5)**
- New orders, low stock, payment failed, reviews
- Mark read/unread
- AI: Priority ranking

### Files moi/sua
- `apps/store-admin/src/pages/ai-agent.ts` (SUA lon — them 30+ functions)
- `apps/store-admin/src/pages/gift-cards.ts` (MOI)
- `apps/store-admin/src/pages/reviews.ts` (MOI)
- `apps/store-admin/src/pages/live-feed.ts` (MOI)
- `apps/store-admin/src/pages/store-health.ts` (MOI)
- `apps/store-admin/src/pages/notifications.ts` (MOI)

### Ket qua
AI Agent voi 30+ functions, gift cards, reviews, live feed, store health — hoan thien 95% Shopify.

---

## PHASE 11: Deploy, Test, QA (FINAL)

### Tasks
- Deploy len server 192.168.1.13:4325
- E2E test tat ca routes (~80)
- Test multi-tenant (2+ stores)
- Test role permissions (owner vs admin vs staff)
- Test AI functions (30+ functions)
- Performance check: page load < 500ms
- Security review: CSRF, auth, data isolation
- Push code to GitHub

---

## TONG KET

| Phase | Nhom | Chuc nang | Uoc tinh |
|-------|------|-----------|----------|
| 1 | A | Layout + Dashboard + Auth | ~3 files |
| 2 | B | Products + Inventory + Collections | ~3 files |
| 3 | C | Orders full lifecycle | ~3 files |
| 4 | D | Customers CRM | ~3 files |
| 5 | E | Discounts & Promotions | ~2 files |
| 6 | G | Analytics & Reports | ~5 files |
| 7 | H | Online Store (themes, pages, blog) | ~6 files |
| 8 | F | Marketing & SEO | ~4 files |
| 9 | I,J,K | Shipping, Tax, Settings, Staff | ~8 files |
| 10 | L,B6-B8,A2-A5 | AI Agent + Gift Cards + Reviews + Polish | ~6 files |
| 11 | ALL | Deploy + Test + QA | 0 files |
| **TOTAL** | **A-L** | **60 chuc nang, ~80 routes** | **~43 files** |

---

## AI INTEGRATION MAP

| AI Function | Phase | Trigger |
|-------------|-------|---------|
| analyzeSales() | 1 | "Hom nay ban hang the nao?" |
| analyzeProducts() | 2 | "San pham nao ban chay?" |
| writeProductDescription() | 2 | "Viet mo ta san pham" |
| analyzePricing() | 2 | "Goi y gia ban" |
| inventoryForecast() | 2 | "Khi nao can nhap them hang?" |
| suggestCollections() | 2 | "Goi y collections" |
| analyzeOrders() | 3 | "Don hang chua thanh toan" |
| summarizeOrder() | 3 | "Tom tat don hang" |
| analyzeRefundRisk() | 3 | "Nen refund khong?" |
| orderAnalytics() | 3 | "Phan tich don hang thang nay" |
| detectFraud() | 3 | "Don hang bat thuong?" |
| segmentCustomers() | 4 | "Phan loai khach hang" |
| analyzeCustomer() | 4 | "Khach hang nay co gi dac biet?" |
| predictChurn() | 4 | "Khach hang nao sap roi bo?" |
| analyzeDiscounts() | 5 | "Giam gia nao hieu qua?" |
| suggestDiscount() | 5 | "Goi y giam gia" |
| optimizePromotion() | 5 | "Chay promotion nao tot?" |
| analyzeRevenue() | 6 | "Phan tich doanh thu" |
| salesReport() | 6 | "Bao cao doanh thu" |
| generateReport() | 6 | "Tao bao cao..." |
| writePage() | 7 | "Viet trang About Us" |
| writeBlog() | 7 | "Viet bai blog" |
| suggestNavigation() | 7 | "Goi y cau truc menu" |
| writeEmail() | 8 | "Viet email marketing" |
| analyzeAbandoned() | 8 | "Bao nhieu gio hang bi bo?" |
| seoAudit() | 8 | "Kiem tra SEO store" |
| suggestShipping() | 9 | "Goi y gia ship" |
| suggestPayment() | 9 | "Nen dung payment gateway nao?" |
| generateLegalPage() | 9 | "Tao chinh sach bao mat" |
| storeHealthCheck() | 10 | "Kiem tra suc khoe store" |
| analyzeReviews() | 10 | "Phan tich danh gia" |
| bulkOptimize() | 10 | "Toi uu hoa san pham" |

**Tong: 30+ AI functions tich hop trong MOI page**

---

**STATUS: CHO THAI DUYET TRUOC KHI BAT DAU IMPLEMENT**
