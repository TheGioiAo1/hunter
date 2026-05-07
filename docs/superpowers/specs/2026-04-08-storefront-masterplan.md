# Gbox Storefront — Master Plan Tong Quan

> **Muc tieu:** Xay dung he thong website ban hang cap Shopify voi AI tich hop sau
> **Ngay:** 2026-04-08
> **Trang thai:** Ke hoach chi tiet, cho Thai duyet

---

## MUC LUC

1. [Tong Quan Kien Truc](#1-tong-quan-kien-truc)
2. [Module A: Theme Engine & Website Builder](#2-module-a-theme-engine--website-builder)
3. [Module B: Storefront Rendering & Performance](#3-module-b-storefront-rendering--performance)
4. [Module C: Cart & Checkout Flow](#4-module-c-cart--checkout-flow)
5. [Module D: Order Management & Fulfillment](#5-module-d-order-management--fulfillment)
6. [Module E: Analytics, Tracking & Conversion](#6-module-e-analytics-tracking--conversion)
7. [Module F: AI Expert System](#7-module-f-ai-expert-system)
8. [Module G: Theme Cloner — Copy Any Website](#8-module-g-theme-cloner--copy-any-website)
9. [Module H: SEO & Marketing Automation](#9-module-h-seo--marketing-automation)
10. [Module I: Customer Portal & Accounts](#10-module-i-customer-portal--accounts)
11. [Timeline & Priorities](#11-timeline--priorities)

---

## 1. TONG QUAN KIEN TRUC

### 1.1 Hien Trang (Da Co)

```
✅ Da co:
├── Database schema day du (56 tables)
├── Product/Variant/Collection/Discount CRUD (18 API endpoints)
├── Checkout service (Redis-backed, 8 endpoints)
├── Payment gateways (Stripe + PayPal)
├── Email service (4 templates)
├── Basic storefront server (5 routes, hardcoded HTML)
├── Astro theme system (packages/storefront/ — chua tich hop)
├── Theme service (CRUD + duplicate)
├── CMS (pages, blog, menus)
├── AI Agent (10+ functions — hardcoded responses)
├── Analytics service (dashboard stats, trends)
├── Store Admin dashboard (80+ routes)

❌ Chua co:
├── Theme Engine (render dynamic templates)
├── Visual Theme Builder / Editor
├── Theme Cloner (copy website khac)
├── Conversion tracking (funnel, events)
├── External analytics (GA4, Pixel, GTM)
├── AI Expert thuc su (LLM integration)
├── Customer storefront account (login, order history)
├── Cart persistence (cookie/localStorage)
├── Product reviews (UI)
├── Wishlist (UI)
├── Search (storefront UI)
├── Multi-language / i18n
├── Custom domain SSL auto-provision
```

### 1.2 Kien Truc Muc Tieu

```
                    [Customer Browser]
                          |
                    [Cloudflare CDN]
                    (Edge cache, SSL, WAF)
                          |
                ┌─────────┼──────────┐
                |         |          |
          [Storefront] [API]    [Admin]
          :4326        :4321    :4325
              |         |          |
              +---------+----------+
                        |
              ┌─────────┼──────────┐
              |         |          |
          [Redis]  [PostgreSQL]  [S3/R2]
          (cache)  (data)        (media)
                        |
                  [AI Service]
                  (Claude API)
                        |
              ┌─────────┼──────────┐
              |         |          |
        [Theme      [Content   [Analytics
         Cloner]     Generator]  Engine]
```

### 1.3 Data Flow — Tu Setup Den Ban Hang

```
1. Merchant tao store → /accounts/create-store
2. Chon/import theme → AI suggest + Theme Cloner
3. Them san pham → AI generate mo ta, SEO
4. Setup thanh toan → Stripe/PayPal connect
5. Setup shipping → Zone-based rates
6. Ket noi domain → SSL auto-provision
7. Go live → Storefront accessible

Customer flow:
1. Visit store → Theme rendered, SEO optimized
2. Browse products → Search, filter, sort
3. Add to cart → Persistent cart (cookie + Redis)
4. Checkout → Email, shipping, payment
5. Order confirmed → Email + tracking
6. Post-purchase → Reviews, reorder, account
```

---

## 2. MODULE A: THEME ENGINE & WEBSITE BUILDER

### 2.1 Theme Architecture

```
packages/core/src/modules/themes/
├── engine.ts          ← Template rendering engine
├── service.ts         ← Theme CRUD (da co)
├── builder.ts         ← Visual builder API
├── sections.ts        ← Section/block system
├── presets.ts         ← Theme presets/defaults
└── marketplace.ts     ← Theme store

Theme Structure (trong DB theme_assets):
theme/
├── layout/
│   ├── base.html         ← Master layout
│   ├── header.html       ← Header section
│   └── footer.html       ← Footer section
├── templates/
│   ├── index.html        ← Home page
│   ├── product.html      ← Product detail
│   ├── collection.html   ← Collection page
│   ├── cart.html         ← Cart page
│   ├── page.html         ← CMS page
│   ├── blog.html         ← Blog listing
│   └── blog-post.html    ← Blog post
├── sections/
│   ├── hero.html         ← Hero banner
│   ├── featured-products.html
│   ├── testimonials.html
│   ├── newsletter.html
│   ├── image-with-text.html
│   └── custom-html.html
├── snippets/
│   ├── product-card.html
│   ├── price.html
│   ├── pagination.html
│   └── breadcrumb.html
├── assets/
│   ├── theme.css
│   ├── theme.js
│   └── fonts/
└── config/
    ├── settings_schema.json  ← Theme settings definition
    └── settings_data.json    ← Current theme settings values
```

### 2.2 Template Engine

**Chon Nunjucks** (tuong tu Shopify Liquid nhung manh hon):

```typescript
// packages/core/src/modules/themes/engine.ts

import nunjucks from 'nunjucks'

interface RenderContext {
  shop: ShopData
  page_title: string
  canonical_url: string
  // Product page
  product?: ProductData
  // Collection page
  collection?: CollectionData
  products?: ProductData[]
  // Cart
  cart?: CartData
  // Customer
  customer?: CustomerData
  // Global
  settings: ThemeSettings
  menus: MenuData[]
  current_url: string
  request: { path: string; params: Record<string, string> }
}

// Custom filters (Shopify-compatible)
// {{ product.price | money }}
// {{ product.title | truncate: 50 }}
// {{ product.images | first }}
// {{ "now" | date: "%Y-%m-%d" }}
// {{ product.description | strip_html | truncatewords: 30 }}

// Custom tags
// {% section 'hero' %}
// {% render 'product-card', product: product %}
// {% form 'cart' %} ... {% endform %}
```

### 2.3 Section System (Shopify-style)

```json
// sections/hero.html — Schema o cuoi file
{
  "name": "Hero Banner",
  "settings": [
    {
      "type": "image_picker",
      "id": "background_image",
      "label": "Background Image"
    },
    {
      "type": "text",
      "id": "heading",
      "label": "Heading",
      "default": "Welcome to our store"
    },
    {
      "type": "richtext",
      "id": "subheading",
      "label": "Subheading"
    },
    {
      "type": "url",
      "id": "button_link",
      "label": "Button Link"
    },
    {
      "type": "text",
      "id": "button_text",
      "label": "Button Text",
      "default": "Shop Now"
    },
    {
      "type": "color",
      "id": "overlay_color",
      "label": "Overlay Color",
      "default": "#000000"
    },
    {
      "type": "range",
      "id": "overlay_opacity",
      "label": "Overlay Opacity",
      "min": 0,
      "max": 100,
      "default": 40
    }
  ]
}
```

### 2.4 Visual Theme Builder (Store Admin)

```
/admin/store/:slug/online-store/editor

┌──────────────────────────────────────────────────┐
│ [←] Theme Editor          [Preview] [Save] [Pub] │
├──────────┬───────────────────────────────────────┤
│          │                                        │
│ Sections │   ┌────────────────────────────┐      │
│          │   │     LIVE PREVIEW            │      │
│ [+] Add  │   │     (iframe)               │      │
│          │   │                             │      │
│ ▼ Header │   │   ┌──────────────────┐     │      │
│   Logo   │   │   │   HERO BANNER    │     │      │
│   Menu   │   │   │                  │     │      │
│   Cart   │   │   └──────────────────┘     │      │
│          │   │                             │      │
│ ▼ Hero   │   │   ┌──────────────────┐     │      │
│   Image  │   │   │  FEATURED PRODS  │     │      │
│   Text   │   │   │  ┌──┐ ┌──┐ ┌──┐ │     │      │
│   Button │   │   │  └──┘ └──┘ └──┘ │     │      │
│          │   │   └──────────────────┘     │      │
│ ▼ Feat.  │   │                             │      │
│   Count  │   └────────────────────────────┘      │
│   Layout │                                        │
│          │   ─── Settings Panel ───               │
│ ▼ Footer │   Heading: [Welcome to...]             │
│          │   Button:  [Shop Now   ]               │
│ [+] Add  │   Color:   [■ #6366f1 ]               │
│          │   Image:   [Upload ▲  ]               │
└──────────┴───────────────────────────────────────┘
```

**Theme Editor Features:**
- Drag-and-drop sections (reorder, add, remove)
- Live preview trong iframe (real-time update)
- Settings panel cho moi section
- Color picker, image upload, font selector
- Responsive preview (mobile/tablet/desktop)
- Undo/redo history
- Auto-save draft
- Publish khi san sang

### 2.5 Built-in Themes (5 themes free)

| Theme | Style | Best For |
|-------|-------|----------|
| **Gbox Dawn** | Clean, minimal | Clothing, lifestyle |
| **Gbox Starter** | Simple, fast | Any store |
| **Gbox Bold** | Dark, premium | Tech, electronics |
| **Gbox Fresh** | Colorful, playful | Food, beauty |
| **Gbox Pro** | Corporate, trust | B2B, professional |

---

## 3. MODULE B: STOREFRONT RENDERING & PERFORMANCE

### 3.1 Request Flow

```
Customer request: https://mystore.gbox.co/products/blue-shirt

1. Cloudflare CDN (edge cache check)
   → Cache HIT: serve cached HTML (0ms)
   → Cache MISS: forward to origin

2. Nginx (reverse proxy)
   → Route to storefront upstream

3. Storefront Server (:4326)
   a. Resolve shop from domain/subdomain
   b. Load active theme from Redis cache
   c. Load product data from Redis/DB
   d. Render template via Nunjucks engine
   e. Inject tracking scripts (GA4, Pixel)
   f. Set cache headers
   g. Return HTML

4. Cache layers:
   - Redis: theme templates (600s TTL)
   - Redis: product data (60s TTL)
   - Redis: shop settings (600s TTL)
   - Nginx: rendered HTML (30s TTL)
   - Cloudflare: rendered HTML (60s TTL)
```

### 3.2 Storefront Routes

```
GET  /                          → Home page
GET  /products                  → All products (paginated)
GET  /products/:slug            → Product detail page (PDP)
GET  /collections               → All collections
GET  /collections/:slug         → Collection page
GET  /collections/:slug/:page   → Collection pagination
GET  /cart                      → Cart page
GET  /checkout                  → Checkout (redirect to checkout service)
GET  /pages/:slug               → CMS page
GET  /blogs                     → Blog listing
GET  /blogs/:slug               → Blog post
GET  /search                    → Search results
GET  /search?q=keyword          → Search with query
GET  /account                   → Customer account (login required)
GET  /account/login             → Customer login
GET  /account/register          → Customer registration
GET  /account/orders            → Order history
GET  /account/orders/:id        → Order detail
GET  /account/addresses         → Saved addresses
GET  /account/wishlist          → Wishlist
GET  /sitemap.xml               → Dynamic sitemap
GET  /robots.txt                → SEO robots
GET  /favicon.ico               → Shop favicon
```

### 3.3 Performance Targets

| Metric | Target | How |
|--------|--------|-----|
| TTFB | <200ms | Redis cache + edge CDN |
| FCP | <1.5s | Critical CSS inline, lazy load images |
| LCP | <2.5s | Preload hero image, font-display: swap |
| CLS | <0.1 | Fixed image dimensions, no layout shift |
| TTI | <3.5s | Defer non-critical JS, code splitting |
| Lighthouse | >90 | All above combined |

### 3.4 Image Optimization Pipeline

```
Upload: Merchant uploads product-photo.jpg (5MB)
   ↓
Processing (background job):
   ├── Original: product-photo.jpg (S3/R2)
   ├── Large:  product-photo_1200x1200.webp (100KB)
   ├── Medium: product-photo_600x600.webp (40KB)
   ├── Small:  product-photo_300x300.webp (15KB)
   └── Thumb:  product-photo_100x100.webp (5KB)
   ↓
Storefront HTML:
   <picture>
     <source srcset="...300.webp 300w, ...600.webp 600w, ...1200.webp 1200w"
             type="image/webp" sizes="(max-width:768px) 100vw, 50vw">
     <img src="...600.jpg" alt="Blue Shirt" width="600" height="600"
          loading="lazy" decoding="async">
   </picture>
```

---

## 4. MODULE C: CART & CHECKOUT FLOW

### 4.1 Cart System

```
Cart Flow:
1. Customer click "Add to Cart"
   → JavaScript tao/update cart token (cookie: gbox_cart)
   → POST /api/storefront/cart/add {variant_id, quantity}
   → Redis: cart:{token} = {items, totals}

2. Cart page render
   → GET /cart
   → Load cart from Redis
   → Render: items, quantities, subtotal

3. Cart modifications
   → PUT  /api/storefront/cart/update {line_id, quantity}
   → DELETE /api/storefront/cart/remove {line_id}
   → Cart recalculates totals

4. Cart → Checkout
   → POST /api/storefront/cart/checkout
   → Creates checkout session from cart
   → Redirect to /checkout/{checkout_id}
```

### 4.2 Checkout Flow (Shopify-style 3-step)

```
Step 1: THONG TIN (Information)
┌─────────────────────────────────────────────┐
│ Email: [customer@example.com          ]     │
│                                             │
│ Shipping Address:                           │
│ First name: [Thai    ] Last: [Bui      ]    │
│ Address:    [123 Main St              ]     │
│ City:       [HCMC    ] Province: [HCM ]     │
│ Zip:        [70000   ] Country: [VN ▼ ]     │
│ Phone:      [+84-888-123456           ]     │
│                                             │
│              [Continue to Shipping →]       │
└─────────────────────────────────────────────┘

Step 2: VAN CHUYEN (Shipping)
┌─────────────────────────────────────────────┐
│ Shipping to: Thai Bui, 123 Main St, HCMC    │
│                                [Change]     │
│                                             │
│ Shipping Methods:                           │
│ ○ Standard Shipping (5-7 days)    $5.99     │
│ ● Express Shipping (2-3 days)     $12.99    │
│ ○ Free Shipping (7-14 days)       FREE      │
│                                             │
│              [Continue to Payment →]        │
└─────────────────────────────────────────────┘

Step 3: THANH TOAN (Payment)
┌─────────────────────────────────────────────┐
│ Order Summary:                              │
│ Blue T-Shirt (M) × 2        $59.98         │
│ Red Sneakers × 1            $89.99         │
│ ─────────────────────────────────           │
│ Subtotal:                    $149.97        │
│ Shipping (Express):          $12.99         │
│ Tax (10%):                   $14.99         │
│ Discount (SAVE10):          -$14.99         │
│ ─────────────────────────────────           │
│ TOTAL:                      $162.96         │
│                                             │
│ Discount: [SAVE10    ] [Apply]              │
│                                             │
│ Payment:                                    │
│ [💳 Credit Card (Stripe)]                   │
│ [🅿️ PayPal]                                │
│ [📱 Apple Pay / Google Pay]                 │
│                                             │
│ Card: [4242 4242 4242 4242         ]        │
│ Exp:  [12/28  ] CVC: [123 ]                │
│                                             │
│         [Complete Order — $162.96]          │
└─────────────────────────────────────────────┘
```

### 4.3 Post-Purchase Flow

```
Order confirmed:
1. Order created in DB (financial_status: paid)
2. Email: Order confirmation (to customer)
3. Email: New order notification (to merchant)
4. Webhook: orders/create
5. Customer redirect → /checkout/thank-you?order=ORD-1234

Thank You Page:
┌─────────────────────────────────────────────┐
│ ✅ Order Confirmed!                         │
│ Order #ORD-1234                             │
│                                             │
│ Thank you, Thai! Your order is confirmed.   │
│ You'll receive a shipping confirmation      │
│ email when your items ship.                 │
│                                             │
│ [Track Your Order]  [Continue Shopping]      │
│                                             │
│ ── Order Details ──                         │
│ Blue T-Shirt (M) × 2        $59.98         │
│ Red Sneakers × 1            $89.99         │
│ Shipping: Express            $12.99         │
│ Total:                      $162.96         │
│                                             │
│ 🎯 AI Recommendation:                       │
│ "Customers who bought this also bought..."  │
│ [Product A] [Product B] [Product C]         │
└─────────────────────────────────────────────┘
```

---

## 5. MODULE D: ORDER MANAGEMENT & FULFILLMENT

### 5.1 Order Lifecycle

```
┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
│ PENDING  │───→│  PAID    │───→│ SHIPPED  │───→│DELIVERED │
│(created) │    │(captured)│    │(tracking)│    │(complete)│
└────┬─────┘    └────┬─────┘    └────┬─────┘    └──────────┘
     │               │               │
     ▼               ▼               ▼
┌──────────┐    ┌──────────┐    ┌──────────┐
│ CANCELLED│    │ REFUNDED │    │ RETURNED │
│(by merch │    │(full/    │    │(RMA      │
│ or cust) │    │ partial) │    │ process) │
└──────────┘    └──────────┘    └──────────┘
```

### 5.2 Merchant Order Dashboard

```
/admin/store/:slug/orders

┌─────────────────────────────────────────────────────────┐
│ Orders                              [Export] [+ Create] │
├─────────────────────────────────────────────────────────┤
│ Filters: [All ▼] [Unfulfilled ▼] [Last 30 days ▼]     │
│ Search:  [Search orders, customers, products...    🔍]  │
├─────────────────────────────────────────────────────────┤
│ ☐ Order    Date       Customer    Total    Payment Ful. │
│ ☐ #1234   Apr 7      Thai B.    $162.96  ● Paid   ○    │
│ ☐ #1233   Apr 7      John D.     $45.99  ● Paid   ●    │
│ ☐ #1232   Apr 6      Sarah M.    $89.99  ○ Pending ○   │
│ ☐ #1231   Apr 6      Mike L.    $234.00  ● Paid   ◐    │
├─────────────────────────────────────────────────────────┤
│ 🤖 AI Insight: "Order volume up 23% vs last week.      │
│    3 orders awaiting fulfillment — prioritize #1234     │
│    (high-value customer, 5th purchase)"                 │
└─────────────────────────────────────────────────────────┘
```

### 5.3 Fulfillment Workflow

```
Merchant clicks "Fulfill" on order #1234:

1. Select items to ship
   ☑ Blue T-Shirt (M) × 2
   ☑ Red Sneakers × 1

2. Enter tracking info
   Carrier: [UPS ▼]
   Tracking: [1Z999AA10123456784]

3. Notify customer: ☑ Send shipping confirmation email

4. System actions:
   → Create fulfillment record
   → Update order fulfillment_status
   → Send email with tracking link
   → Webhook: orders/fulfilled
   → AI updates conversion metrics
```

---

## 6. MODULE E: ANALYTICS, TRACKING & CONVERSION

### 6.1 Analytics Dashboard

```
/admin/store/:slug/analytics

┌─────────────────────────────────────────────────────────┐
│ Analytics            Period: [Last 30 days ▼] [Compare] │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  Revenue        Orders        Conversion     AOV        │
│  $12,450       156           3.2%           $79.80     │
│  ▲ +18%        ▲ +12%       ▲ +0.4%        ▲ +5%      │
│                                                         │
│  ┌──── Revenue Trend (30 days) ────────────────────┐   │
│  │     $600 ╭─╮                                    │   │
│  │     $400 │ ╰╮  ╭──╮      ╭──╮                  │   │
│  │     $200 ╯  ╰──╯  ╰──────╯  ╰──╮ ╭───╮        │   │
│  │     $0   Apr 1        Apr 15       Apr 30       │   │
│  └──────────────────────────────────────────────────┘   │
│                                                         │
│  ┌──── Conversion Funnel ──────────────────────────┐   │
│  │                                                  │   │
│  │  Visitors    4,875  ████████████████████ 100%    │   │
│  │  Product     2,340  ██████████           48%     │   │
│  │  Add Cart      487  ████                 10%     │   │
│  │  Checkout      234  ██                   4.8%    │   │
│  │  Purchase      156  █                    3.2%    │   │
│  │                                                  │   │
│  │  Drop-off points:                                │   │
│  │  • 52% leave before viewing products             │   │
│  │  • 79% don't add to cart                         │   │
│  │  • 52% abandon cart (AI: offer exit popup?)      │   │
│  └──────────────────────────────────────────────────┘   │
│                                                         │
│  🤖 AI Analysis:                                        │
│  "Your biggest drop-off is Product → Cart (79%).       │
│   Suggestions:                                          │
│   1. Add 'Quick Add' buttons on collection pages        │
│   2. Show trust badges near Add to Cart                 │
│   3. Enable exit-intent popup with 10% discount         │
│   4. Your best converting products are in Electronics   │
│      — feature them more prominently on homepage"       │
└─────────────────────────────────────────────────────────┘
```

### 6.2 Event Tracking System

```typescript
// Storefront tracking — inject vao moi page

interface TrackingEvent {
  event: string
  shop_id: string
  session_id: string     // Anonymous visitor session
  customer_id?: string   // If logged in
  timestamp: string
  properties: Record<string, any>
  page_url: string
  referrer: string
  user_agent: string
  ip: string             // Hashed for privacy
  device: 'mobile' | 'tablet' | 'desktop'
}

// Events tracked:
const EVENTS = {
  // Navigation
  'page_view':           { url, title, referrer },
  'product_viewed':      { product_id, variant_id, price, collection },
  'collection_viewed':   { collection_id, product_count },
  'search_performed':    { query, results_count },

  // Cart
  'product_added':       { product_id, variant_id, quantity, price },
  'product_removed':     { product_id, variant_id, quantity },
  'cart_viewed':         { item_count, cart_total },

  // Checkout
  'checkout_started':    { checkout_id, item_count, total },
  'checkout_email_set':  { checkout_id },
  'checkout_shipping':   { checkout_id, shipping_method, cost },
  'checkout_payment':    { checkout_id, payment_method },
  'checkout_completed':  { order_id, total, item_count, discount },
  'checkout_abandoned':  { checkout_id, step, total },

  // Engagement
  'newsletter_signup':   { email_hash },
  'review_submitted':    { product_id, rating },
  'wishlist_added':      { product_id },
  'share_clicked':       { product_id, platform },

  // Marketing
  'discount_applied':    { code, amount },
  'popup_shown':         { popup_id, trigger },
  'popup_converted':     { popup_id, action },
  'email_opened':        { campaign_id },
  'email_clicked':       { campaign_id, link },
}
```

### 6.3 Third-Party Tracking Integration

```
Store Admin → Settings → Tracking

┌─────────────────────────────────────────────┐
│ Tracking & Analytics                        │
├─────────────────────────────────────────────┤
│                                             │
│ Google Analytics 4                          │
│ Measurement ID: [G-XXXXXXXXXX      ]       │
│ Status: ● Connected                         │
│ Events: page_view, purchase, add_to_cart    │
│                                             │
│ Google Tag Manager                          │
│ Container ID:  [GTM-XXXXXXX        ]       │
│ Status: ● Connected                         │
│                                             │
│ Facebook Pixel                              │
│ Pixel ID:     [123456789012345     ]       │
│ Status: ● Connected                         │
│ Events: PageView, ViewContent, AddToCart,   │
│         InitiateCheckout, Purchase          │
│                                             │
│ TikTok Pixel                                │
│ Pixel ID:     [                    ]       │
│ Status: ○ Not Connected                     │
│                                             │
│ Custom Scripts                              │
│ ┌──────────────────────────────────────┐   │
│ │ <script>                              │   │
│ │   // Your custom tracking code        │   │
│ │ </script>                             │   │
│ └──────────────────────────────────────┘   │
│ Injection: [Head ▼]  [Save]               │
│                                             │
│ 🤖 AI: "Based on your traffic sources,    │
│   setting up Facebook Pixel could increase │
│   retargeting ROI by ~40%. Want me to     │
│   generate the pixel events mapping?"      │
└─────────────────────────────────────────────┘
```

### 6.4 Conversion Rate Tracking

```
DB Tables (New):

-- Visitor sessions (anonymous tracking)
CREATE TABLE storefront_sessions (
  id UUID PRIMARY KEY,
  shop_id UUID REFERENCES shops(id),
  visitor_id TEXT NOT NULL,         -- Hashed cookie/fingerprint
  customer_id UUID REFERENCES customers(id),
  device TEXT,                      -- mobile/tablet/desktop
  browser TEXT,
  os TEXT,
  country TEXT,
  city TEXT,
  referrer TEXT,                    -- utm_source tracking
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  landing_page TEXT,
  pages_viewed INTEGER DEFAULT 0,
  products_viewed INTEGER DEFAULT 0,
  cart_additions INTEGER DEFAULT 0,
  checkout_started BOOLEAN DEFAULT false,
  order_completed BOOLEAN DEFAULT false,
  order_id UUID REFERENCES orders(id),
  total_value NUMERIC(10,2),
  first_seen_at TIMESTAMP,
  last_seen_at TIMESTAMP,
  duration_seconds INTEGER DEFAULT 0
);

-- Individual events for detailed analysis
CREATE TABLE storefront_events (
  id UUID PRIMARY KEY,
  shop_id UUID REFERENCES shops(id),
  session_id UUID REFERENCES storefront_sessions(id),
  event_type TEXT NOT NULL,         -- page_view, product_viewed, etc.
  properties JSONB,                 -- Event-specific data
  page_url TEXT,
  created_at TIMESTAMP DEFAULT now()
);

-- Indexes cho analytics queries
CREATE INDEX idx_sessions_shop_time ON storefront_sessions(shop_id, first_seen_at DESC);
CREATE INDEX idx_sessions_shop_converted ON storefront_sessions(shop_id, order_completed);
CREATE INDEX idx_events_shop_type_time ON storefront_events(shop_id, event_type, created_at DESC);
```

### 6.5 Real-time Dashboard (Optional — Phase 2)

```
Server-Sent Events (SSE) stream:

/admin/store/:slug/analytics/live

┌─────────────────────────────────────────────┐
│ 🔴 LIVE — 23 visitors right now             │
├─────────────────────────────────────────────┤
│                                             │
│ Active Pages:                               │
│ • /products/blue-shirt (7 visitors)         │
│ • / (5 visitors)                            │
│ • /collections/new-arrivals (4 visitors)    │
│ • /checkout (3 visitors)                    │
│ • /cart (2 visitors)                        │
│ • Other (2 visitors)                        │
│                                             │
│ Recent Events:                              │
│ 🛒 +Cart  Blue T-Shirt (M)       3s ago    │
│ 👀 View   Red Sneakers           15s ago    │
│ 💳 Order  #1235 ($89.99)         1m ago     │
│ 🔍 Search "summer dress"         2m ago     │
│                                             │
│ 🤖 AI: "Checkout has 3 visitors but 0      │
│   completed in last 10 min. Consider        │
│   adding live chat support."                │
└─────────────────────────────────────────────┘
```

---

## 7. MODULE F: AI EXPERT SYSTEM

### 7.1 Tong Quan AI Architecture

```
┌──────────────────────────────────────────────┐
│              AI EXPERT SYSTEM                 │
│                                              │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  │
│  │ Content  │  │ Business │  │ Technical │  │
│  │ Expert   │  │ Expert   │  │ Expert    │  │
│  └─────┬────┘  └─────┬────┘  └─────┬────┘  │
│        │             │             │         │
│        ▼             ▼             ▼         │
│  ┌─────────────────────────────────────┐    │
│  │       Claude API (Anthropic)        │    │
│  │       Model: claude-sonnet-4-20250514     │    │
│  └─────────────────────────────────────┘    │
│        │             │             │         │
│  ┌─────┴──┐    ┌────┴───┐   ┌────┴───┐    │
│  │Product │    │Analytic│   │Theme   │    │
│  │Writer  │    │Advisor │   │Builder │    │
│  │        │    │        │   │        │    │
│  │-Titles │    │-Revenue│   │-Clone  │    │
│  │-Desc   │    │-Funnel │   │-CSS    │    │
│  │-SEO    │    │-AOV    │   │-Layout │    │
│  │-Tags   │    │-Predict│   │-Colors │    │
│  │-Images │    │-Compare│   │-Fonts  │    │
│  └────────┘    └────────┘   └────────┘    │
└──────────────────────────────────────────────┘
```

### 7.2 AI Functions Chi Tiet

#### A. Content Expert (Chuyen Gia Noi Dung)

```
1. PRODUCT DESCRIPTION GENERATOR
   Input: product title, images, category, target audience
   Output: SEO-optimized description (3 variations)

   Merchant: "Write description for 'Classic Leather Wallet'"
   AI: "Crafted from premium full-grain leather, the Classic
        Leather Wallet combines timeless elegance with everyday
        durability. Featuring 8 card slots, 2 bill compartments,
        and RFID-blocking technology..."

2. SEO META GENERATOR
   Input: page content, target keywords
   Output: title tag, meta description, URL slug, schema markup

3. BLOG POST WRITER
   Input: topic, target audience, tone, length
   Output: full blog post with headers, images suggestions

4. EMAIL CAMPAIGN WRITER
   Input: campaign type (welcome, abandoned cart, promo)
   Output: subject lines (5 variations), email body, CTA

5. COLLECTION CURATOR
   Input: store products, trend data
   Output: suggested collections with names, descriptions

6. FAQ GENERATOR
   Input: product catalog, common questions
   Output: product-specific FAQs

7. SOCIAL MEDIA POST GENERATOR
   Input: product, platform (IG, FB, TikTok, Twitter)
   Output: platform-optimized captions, hashtags
```

#### B. Business Expert (Chuyen Gia Kinh Doanh)

```
8. PRICING ADVISOR
   Input: product cost, competitors, market data
   Output: optimal price, margin analysis, pricing strategy

   AI: "Your 'Blue T-Shirt' is priced at $29.99.
        Analysis:
        • Cost: $8.50 → Current margin: 72%
        • Competitor avg: $34.99
        • Recommendation: Raise to $34.99 (+17% revenue)
        • Or offer bundle: 2 for $54.99 (increases AOV)"

9. INVENTORY FORECASTER
   Input: sales history, seasonality, trends
   Output: reorder recommendations, stock predictions

   AI: "Based on 90-day trend:
        • 'Blue T-Shirt (M)' sells 12/week — reorder in 8 days
        • 'Red Sneakers' peak season starting → order 2x
        • 'Winter Jacket' declining — run clearance sale"

10. CUSTOMER SEGMENTATION
    Input: customer data, purchase history
    Output: segments with strategies

    Segments:
    • VIP (>$500/year, 4+ orders): 23 customers
      → Send exclusive early access, loyalty rewards
    • At-Risk (no order in 60 days): 45 customers
      → Send win-back email with 15% discount
    • New (1st order <30 days): 18 customers
      → Send welcome series, suggest complementary products

11. REVENUE PREDICTOR
    Input: historical data, marketing plans
    Output: 30/60/90 day revenue forecast

12. DISCOUNT OPTIMIZER
    Input: current discounts, performance data
    Output: optimal discount strategies

    AI: "Your 'SUMMER20' code (20% off) has 156 uses
         but avg cart is $45. Switch to:
         • 'SAVE10' (10% off) for carts < $50
         • 'SAVE20' (20% off) for carts > $100
         This could increase revenue 12% while
         maintaining similar conversion rate."

13. COMPETITOR ANALYSIS
    Input: competitor URLs
    Output: pricing comparison, feature gaps, opportunities

14. A/B TEST ADVISOR
    Input: current metrics, proposed changes
    Output: test plan, expected impact, duration needed
```

#### C. Technical Expert (Chuyen Gia Ky Thuat)

```
15. THEME OPTIMIZER
    Input: current theme performance
    Output: specific CSS/HTML optimizations

    AI: "Your storefront loads in 4.2s. Issues:
         • Hero image: 2.1MB → Compress to WebP (200KB) — saves 1.5s
         • 3 render-blocking CSS files → Combine + inline critical
         • No lazy loading on below-fold images → Add loading='lazy'
         Estimated improvement: 4.2s → 2.1s (50% faster)"

16. THEME CLONER
    Input: target website URL
    Output: cloned theme structure (HTML, CSS, layout)
    → Chi tiet o Module G

17. ACCESSIBILITY CHECKER
    Input: storefront URL
    Output: WCAG compliance report, fixes

18. SECURITY SCANNER
    Input: store configuration
    Output: security recommendations

19. MIGRATION ASSISTANT
    Input: source platform (Shopify, WooCommerce, etc.)
    Output: migration plan, data mapping, import scripts

20. CUSTOM CODE HELPER
    Input: merchant's request ("I want a countdown timer")
    Output: ready-to-use HTML/CSS/JS snippet
```

### 7.3 AI Integration Points (Tich Hop AI Vao Moi Trang)

```
Dashboard:
  → AI daily briefing: "Good morning! Yesterday: 12 orders ($856),
     3 items low stock, 2 pending reviews. Priority: Fulfill order #1234"

Products:
  → [🤖 Generate Description] button on product edit
  → [🤖 Suggest Tags] auto-tag from title + description
  → [🤖 SEO Score] real-time SEO grade (A-F) while editing

Orders:
  → AI flags: fraud risk, unusual patterns, VIP customer alerts
  → "This customer has 5 orders — consider adding loyalty note"

Customers:
  → AI segments shown as colored badges
  → "Send win-back campaign?" suggestion for at-risk customers

Analytics:
  → AI insights below every chart
  → "Your best day is Thursday — schedule promotions accordingly"

Online Store:
  → [🤖 Optimize Theme] one-click performance analysis
  → [🤖 Clone Website] paste URL, get theme

Marketing:
  → AI generates email content, subject lines
  → Suggests optimal send times based on open rates

Settings:
  → AI recommends shipping zones based on order history
  → Suggests tax settings based on customer locations
```

### 7.4 AI Chat Interface

```
/admin/store/:slug — Bottom-right floating button

┌─────────────────────────────────────┐
│ 🤖 Gbox AI Assistant               │
├─────────────────────────────────────┤
│                                     │
│ 👤 How can I increase my           │
│    conversion rate?                 │
│                                     │
│ 🤖 Based on your store data:       │
│                                     │
│ Your current conversion: 3.2%       │
│ Industry avg: 2.8% — you're above! │
│                                     │
│ Top 3 improvements:                 │
│                                     │
│ 1. 📦 Free Shipping Threshold      │
│    Add "Free shipping over $50"     │
│    Your avg cart is $45 — this      │
│    could increase AOV by 15%        │
│    [Apply This →]                   │
│                                     │
│ 2. 🏷️ Exit-Intent Popup            │
│    Show 10% discount popup when     │
│    visitor moves to close tab       │
│    Expected: +8% checkout recovery  │
│    [Create Popup →]                 │
│                                     │
│ 3. ⭐ Product Reviews              │
│    Products with reviews convert    │
│    270% better. You have 0 reviews. │
│    [Request Reviews →]              │
│                                     │
│ ─── Quick Actions ───               │
│ [Write Product Desc] [SEO Check]    │
│ [Analyze Sales] [Clone Theme]       │
│                                     │
│ [Type a message...          ] [↑]   │
└─────────────────────────────────────┘
```

---

## 8. MODULE G: THEME CLONER — COPY ANY WEBSITE

### 8.1 Flow

```
Merchant: "I want my store to look like nike.com"

1. Input URL: https://nike.com
   ↓
2. AI Crawler extracts:
   ├── HTML structure (layout, sections, grid)
   ├── CSS styles (colors, fonts, spacing, animations)
   ├── Images (hero, product cards, banners)
   ├── Navigation structure
   ├── Typography (font families, sizes, weights)
   └── Color palette (primary, secondary, accent, bg, text)
   ↓
3. AI Analysis:
   ├── Identify sections: header, hero, featured, grid, footer
   ├── Map to Gbox section types
   ├── Extract design tokens (colors, fonts, spacing)
   ├── Generate responsive CSS
   └── Create section configuration
   ↓
4. Theme Generation:
   ├── Create new theme in DB
   ├── Generate template files (base, product, collection, etc.)
   ├── Create theme.css from extracted styles
   ├── Map sections to Gbox section system
   └── Configure settings_data.json (colors, fonts)
   ↓
5. Preview & Customize:
   ├── Show side-by-side: Original vs Clone
   ├── Merchant adjusts colors, fonts, content
   └── Publish when ready
```

### 8.2 Technical Implementation

```typescript
// packages/core/src/modules/themes/cloner.ts

interface CloneResult {
  theme_id: string
  sections: Section[]
  colors: ColorPalette
  fonts: FontConfig
  layout: LayoutConfig
  css: string
  score: number        // 0-100 similarity score
  warnings: string[]   // "Could not clone: animated carousel"
}

interface ColorPalette {
  primary: string      // Main brand color
  secondary: string    // Secondary accent
  background: string   // Page background
  surface: string      // Card/section background
  text: string         // Primary text
  text_muted: string   // Secondary text
  border: string       // Border color
  success: string
  error: string
}

interface FontConfig {
  heading_family: string    // "Helvetica Neue, Arial, sans-serif"
  body_family: string       // "Inter, system-ui, sans-serif"
  heading_weight: string    // "700"
  body_weight: string       // "400"
  base_size: string         // "16px"
  line_height: string       // "1.6"
}

// AI prompt for theme cloning:
const CLONE_PROMPT = `
Analyze this website HTML/CSS and extract:
1. Color palette (primary, secondary, bg, text, accent)
2. Typography (font families, sizes, weights)
3. Layout structure (header type, grid system, footer)
4. Section types (hero, features, testimonials, etc.)
5. Spacing system (padding, margins, gaps)
6. Border/shadow styles
7. Animation patterns

Output as JSON matching our ThemeConfig schema.
Do NOT copy content/images — only design structure.
Ensure responsive (mobile-first) CSS.
`
```

### 8.3 Cloner UI

```
/admin/store/:slug/online-store/clone

┌─────────────────────────────────────────────┐
│ 🤖 AI Theme Cloner                         │
├─────────────────────────────────────────────┤
│                                             │
│ Paste any website URL:                      │
│ [https://example.com              ] [Clone] │
│                                             │
│ Popular inspirations:                       │
│ [Nike.com] [Apple.com] [Glossier.com]       │
│ [Allbirds.com] [Gymshark.com]               │
│                                             │
│ ──── Clone Progress ────                    │
│ ✅ Fetching page...           (1/5)         │
│ ✅ Extracting styles...       (2/5)         │
│ 🔄 AI analyzing layout...    (3/5)         │
│ ○ Generating theme...         (4/5)         │
│ ○ Creating preview...         (5/5)         │
│                                             │
│ ──── Preview ────                           │
│ ┌──────────────┬──────────────┐             │
│ │  Original    │  Your Clone  │             │
│ │  ┌────────┐  │  ┌────────┐  │             │
│ │  │ NIKE   │  │  │ YOUR   │  │             │
│ │  │ HERO   │  │  │ STORE  │  │             │
│ │  │ BANNER │  │  │ HERO   │  │             │
│ │  └────────┘  │  └────────┘  │             │
│ │  ┌──┐┌──┐   │  ┌──┐┌──┐   │             │
│ │  │  ││  │   │  │  ││  │   │             │
│ │  └──┘└──┘   │  └──┘└──┘   │             │
│ └──────────────┴──────────────┘             │
│                                             │
│ Similarity: 87% | Sections: 6 | Colors: 5  │
│                                             │
│ [Customize Colors] [Change Fonts] [Apply]   │
└─────────────────────────────────────────────┘
```

---

## 9. MODULE H: SEO & MARKETING AUTOMATION

### 9.1 SEO Auto-Optimization

```
Every product/page automatically gets:

1. Meta tags (AI-generated):
   <title>Blue T-Shirt — Premium Cotton | MyStore</title>
   <meta name="description" content="Shop our Classic Blue T-Shirt...">
   <link rel="canonical" href="https://mystore.gbox.co/products/blue-tshirt">

2. Schema.org markup (auto-generated):
   <script type="application/ld+json">
   {
     "@context": "https://schema.org",
     "@type": "Product",
     "name": "Blue T-Shirt",
     "image": "https://...",
     "description": "...",
     "brand": { "@type": "Brand", "name": "MyBrand" },
     "offers": {
       "@type": "Offer",
       "price": "29.99",
       "priceCurrency": "USD",
       "availability": "https://schema.org/InStock"
     },
     "aggregateRating": {
       "@type": "AggregateRating",
       "ratingValue": "4.5",
       "reviewCount": "23"
     }
   }
   </script>

3. Open Graph tags (for social sharing):
   <meta property="og:title" content="Blue T-Shirt">
   <meta property="og:image" content="https://...">
   <meta property="og:price:amount" content="29.99">

4. Dynamic sitemap.xml (auto-updated):
   /sitemap.xml
   ├── /products/* (all active products)
   ├── /collections/* (all published collections)
   ├── /pages/* (all published pages)
   └── /blogs/* (all published posts)

5. robots.txt:
   User-agent: *
   Allow: /
   Disallow: /cart
   Disallow: /checkout
   Disallow: /account
   Sitemap: https://mystore.gbox.co/sitemap.xml
```

### 9.2 Marketing Automation

```
Email Automation Flows:

1. WELCOME SERIES (new customer)
   Day 0: Welcome email + 10% first-order discount
   Day 3: Brand story + bestsellers
   Day 7: Social proof (reviews) + reminder

2. ABANDONED CART RECOVERY
   +1 hour: "You left something behind" + cart items
   +24 hours: "Still thinking?" + social proof
   +72 hours: "Last chance" + 10% discount code

3. POST-PURCHASE
   +0: Order confirmation + tracking
   +3 days: "How's your order?" + review request
   +14 days: Related products recommendation
   +30 days: Reorder reminder (consumables)

4. WIN-BACK (inactive customers)
   +60 days: "We miss you" + what's new
   +90 days: Exclusive offer + personalized picks

5. VIP REWARDS
   After 3rd order: Thank you + loyalty perk
   After $500 spent: VIP status + early access
   Birthday: Birthday discount code

AI writes ALL email content automatically based on:
- Customer segment
- Purchase history
- Store products
- Brand voice (configured by merchant)
```

---

## 10. MODULE I: CUSTOMER PORTAL & ACCOUNTS

### 10.1 Customer Account Pages

```
/account (after customer login)

┌─────────────────────────────────────────────┐
│ 👤 Welcome back, Thai!                      │
├──────────┬──────────────────────────────────┤
│          │                                  │
│ Account  │  ── Recent Orders ──             │
│ ────     │                                  │
│ Overview │  #1234  Apr 7  $162.96  Shipped  │
│ Orders   │  #1201  Mar 28  $45.99  Delivered│
│ Addresses│  #1189  Mar 15  $89.99  Delivered│
│ Wishlist │                                  │
│ Reviews  │  [View All Orders]               │
│ Settings │                                  │
│          │  ── Saved Addresses ──           │
│ Logout   │  🏠 Home: 123 Main St, HCMC     │
│          │  🏢 Work: 456 Office Rd, HN      │
│          │                                  │
│          │  ── Recommendations ──            │
│          │  🤖 Based on your purchases:     │
│          │  [Product A] [Product B]          │
└──────────┴──────────────────────────────────┘
```

### 10.2 Customer Features

```
1. Order Tracking
   → Real-time status updates
   → Tracking number link to carrier
   → Estimated delivery date
   → Order timeline (placed → confirmed → shipped → delivered)

2. Reorder
   → "Buy Again" button on past orders
   → One-click reorder entire order
   → Quick add individual items to cart

3. Wishlist
   → Save products for later
   → Share wishlist via link
   → "Back in stock" notification

4. Product Reviews
   → Rate products (1-5 stars)
   → Write review with photos
   → Review incentive (discount on next order)

5. Address Book
   → Multiple saved addresses
   → Default shipping/billing address
   → Auto-fill at checkout

6. Account Settings
   → Update name, email, phone
   → Change password
   → Email preferences (marketing opt-in/out)
   → Delete account (GDPR compliance)
```

---

## 11. TIMELINE & PRIORITIES

### Phase 1: Core Storefront (2-3 weeks)

```
Week 1-2:
├── Theme Engine (Nunjucks template rendering)
├── 5 built-in themes (Dawn, Starter, Bold, Fresh, Pro)
├── Storefront routes (all 20+ routes)
├── Cart system (Redis-backed, persistent)
├── Cart ↔ Checkout integration
├── Product page (variants, images, pricing)
├── Collection page (filter, sort, paginate)
├── Search (full-text PostgreSQL)

Week 3:
├── Customer accounts (login, register, orders)
├── Order tracking page
├── Wishlist & reviews UI
├── Dynamic sitemap.xml
├── robots.txt
├── Meta tags + Schema.org
├── Image optimization pipeline
```

### Phase 2: AI Integration (1-2 weeks)

```
Week 4:
├── Claude API integration (real LLM calls)
├── Product description generator
├── SEO meta generator
├── Blog post writer
├── Email content generator
├── AI chat interface (upgraded from hardcoded)

Week 5:
├── Theme Cloner (crawl + analyze + generate)
├── AI pricing advisor
├── AI inventory forecaster
├── AI conversion insights
├── AI A/B test advisor
```

### Phase 3: Analytics & Tracking (1 week)

```
Week 6:
├── Event tracking system (DB + API)
├── Conversion funnel dashboard
├── GA4 integration
├── Facebook Pixel integration
├── GTM support
├── Custom script injection
├── Real-time visitor counter (SSE)
```

### Phase 4: Marketing & Automation (1 week)

```
Week 7:
├── Email automation flows (5 flows)
├── Abandoned cart recovery
├── Exit-intent popup system
├── Discount auto-generation
├── Customer segmentation (AI-powered)
├── Newsletter signup widget
```

### Phase 5: Theme Builder & Polish (1-2 weeks)

```
Week 8-9:
├── Visual theme editor (drag-and-drop sections)
├── Live preview in iframe
├── Section settings panel
├── Color/font customization
├── Theme export/import
├── Theme marketplace (browse, install)
├── Custom domain SSL provisioning
├── Multi-language support (i18n)
```

### Tong Ket Timeline

| Phase | Thoi Gian | Noi Dung | Impact |
|-------|-----------|----------|--------|
| Phase 1 | 3 weeks | Core storefront, cart, checkout | Merchants can sell |
| Phase 2 | 2 weeks | AI integration, content generation | 10x faster setup |
| Phase 3 | 1 week | Analytics, tracking, conversion | Data-driven decisions |
| Phase 4 | 1 week | Marketing automation | Revenue growth |
| Phase 5 | 2 weeks | Theme builder, polish | Professional stores |
| **TOTAL** | **~9 weeks** | | **Full Shopify competitor** |

---

## TOM TAT EXECUTIVE

### Gbox Storefront se co:

**Cho Merchant (Nguoi Ban):**
- 🎨 5 themes mien phi + Theme Cloner (copy bat ky website nao)
- 🤖 AI Expert: viet mo ta, SEO, phan tich doanh thu, du doan ton kho
- 📊 Analytics chi tiet: conversion funnel, revenue trend, customer segments
- 📧 Marketing automation: abandoned cart, welcome series, win-back
- 🏗️ Visual builder: drag-and-drop, live preview, no code

**Cho Customer (Nguoi Mua):**
- ⚡ Website nhanh (<2s load, Lighthouse >90)
- 🛒 Cart persistent + 3-step checkout
- 👤 Account: order tracking, wishlist, reviews, reorder
- 🔍 Search nhanh (full-text PostgreSQL)
- 📱 Responsive tren moi thiet bi

**AI Co The Lam:**
- Viet mo ta san pham tu 1 dong title
- Phan tich 30 ngay data va de xuat cai thien
- Du doan doanh thu 90 ngay toi
- Clone giao dien bat ky website nao trong 2 phut
- Tu dong tao email marketing content
- De xuat gia ban toi uu dua tren margin + doi thu
- Phat hien don hang fraud risk
- Tao blog post, social media content
- Kiem tra va toi uu SEO tu dong
- Phan loai khach hang va de xuat chien luoc

**Con so muc tieu:**
- 100K RPS (da co infrastructure tu Phase truoc)
- <200ms TTFB (Redis + CDN)
- >90 Lighthouse score
- 3.2%+ conversion rate (industry avg: 2.8%)
- 5 phut tu setup den go-live (voi AI)
