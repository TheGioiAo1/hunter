# GBOX Orders System — Masterplan & Mindmap
> Created: 2026-04-13 | Owner: Thai Bui | Status: DRAFT — Awaiting approval

---

## MINDMAP TONG QUAN

```
                              ORDERS SYSTEM
                                   |
        ┌──────────┬──────────┬────┴────┬──────────┬──────────┬──────────┐
        │          │          │         │          │          │          │
   ORDER LIST  ORDER DETAIL  DRAFT   FULFILLMENT  RETURNS   IMPORT/    ANALYTICS
   & FILTERS   & ACTIONS    ORDERS   & SHIPPING   & REFUNDS  EXPORT     & REPORTS
        │          │          │         │          │          │          │
   ┌────┴────┐  ┌──┴───┐   (done)  ┌──┴───┐  ┌──┴───┐  ┌──┴───┐  ┌──┴───┐
   │         │  │      │           │      │  │      │  │      │  │      │
  Tabs    Saved Edit  Timeline  Create  Partial Full   CSV   Platform Revenue
  Bulk    Views Order  Notes   Fulfill Fulfill Refund Import Import   KPIs
  Search  Custom      Print    Track#  Split  Partial Export Amazon   Trends
  Sort    Filters     Dup      Label   Ship   Return  JSON  Shopify  Geo
                                                       XML  TikTok
                                                            WooCommerce
```

---

## PHASE BREAKDOWN

### PHASE A: Order List Enhancement (Uu tien: CAO)
> Reference: Shopify /admin/orders

**A1. Multi-axis Status Model**
```
Payment Status:    pending | authorized | paid | partially_paid | partially_refunded | refunded | voided
Fulfillment:       unfulfilled | partial | fulfilled | on_hold | scheduled
Return Status:     none | return_in_progress | returned
Order Status:      open | archived | cancelled
```

**A2. Enhanced Tab System**
- [x] All (da co — exclude drafts)
- [x] Unfulfilled (da co)
- [x] Unpaid (da co)
- [x] Fulfilled (da co)
- [x] Closed (da co)
- [ ] **NEW: Open** — orders not archived/cancelled
- [ ] **NEW: Returned** — orders with return_in_progress or returned items
- [ ] **NEW: Custom Saved Views** — user saves filter combo as named tab

**A3. Enhanced Filters**
- [ ] Payment status dropdown
- [ ] Fulfillment status dropdown
- [ ] Date range picker (from–to)
- [ ] Risk level (low/medium/high)
- [ ] Sales channel filter
- [ ] Tag filter
- [ ] Customer filter
- [ ] Amount range (min–max)

**A4. Enhanced Search**
- [ ] Search by order number, customer name, email, phone, SKU
- [ ] Fuzzy matching

**A5. Sortable Columns**
- [ ] Click column header to sort (order#, date, total, customer, status)
- [ ] Sort direction toggle (asc/desc)

**A6. Enhanced Bulk Actions**
- [x] Archive (da co — as cancel)
- [x] Mark paid (da co)
- [x] Mark fulfilled (da co)
- [x] Add tag (da co)
- [ ] **NEW: Remove tag**
- [ ] **NEW: Capture payment** (for authorized orders)
- [ ] **NEW: Print packing slips** (selected orders)
- [ ] **NEW: Export selected** (CSV)
- [ ] **NEW: Unarchive**

---

### PHASE B: Order Detail Enhancement (Uu tien: CAO)
> Reference: Shopify order detail page

**B1. Order Timeline / Activity Log**
```
  ┌─────────────────────────────────────────┐
  │  TIMELINE                               │
  │  ─────────                              │
  │  📦 Apr 13 14:30 — Order fulfilled      │
  │     Tracking: VN123456 (GHN Express)    │
  │                                         │
  │  💬 Apr 13 10:15 — Staff note           │
  │     "Customer requested gift wrapping"  │
  │                                         │
  │  💳 Apr 12 20:00 — Payment captured     │
  │     $125.00 via Stripe (****4242)       │
  │                                         │
  │  🛒 Apr 12 19:55 — Order created        │
  │     From Online Store                   │
  │                                         │
  │  [Add internal note...]                 │
  └─────────────────────────────────────────┘
```
- [ ] Auto-log: created, paid, fulfilled, refunded, edited, cancelled
- [ ] Manual staff notes/comments
- [ ] Stored in `order_events` table (new)

**B2. Inline Order Editing**
- [ ] Edit shipping/billing address
- [ ] Edit customer email/phone
- [ ] Edit order note
- [ ] Add/remove tags
- [ ] Add/remove line items (unfulfilled only)
- [ ] Adjust quantities
- [ ] Add discount
- [ ] Recalculate totals automatically

**B3. Order Actions Menu**
```
  ┌─────────────────────────┐
  │  Actions ▼              │
  ├─────────────────────────┤
  │  ✏️  Edit order          │
  │  📋 Duplicate order     │
  │  📄 Print packing slip  │
  │  📧 Print invoice       │
  │  📧 Resend confirmation │
  │  💰 Capture payment     │
  │  💸 Refund              │
  │  📦 Create fulfillment  │
  │  🔄 Create return       │
  │  ❌ Cancel order        │
  │  📁 Archive order       │
  └─────────────────────────┘
```

**B4. Fraud / Risk Analysis Panel**
- [ ] Risk score badge (Low/Medium/High)
- [ ] Indicators: AVS check, CVV match, IP geolocation, velocity
- [ ] Color-coded (green/yellow/red)
- [ ] Rule-based engine v1 (ML later)

**B5. Payment Info Panel**
- [ ] Show payment method, gateway, last 4 digits
- [ ] Transaction history (authorizations, captures, refunds)
- [ ] Manual capture / void buttons
- [ ] Balance due indicator

**B6. Print Documents**
- [ ] Packing slip (HTML template → print)
- [ ] Invoice (HTML template → print)
- [ ] Pick list
- [ ] Customizable templates (future)

---

### PHASE C: Fulfillment System (Uu tien: CAO)
> Hien tai fulfillment chi co trong god-admin — can enable cho store-admin

**C1. Create Fulfillment from Store-Admin**
```
  ┌──────────────────────────────────────────┐
  │  FULFILL ITEMS                           │
  │  ─────────────                           │
  │  ☑ Product A (Red, L)     x2  ☑ All     │
  │  ☑ Product B (Blue, M)    x1  ☑ All     │
  │  ☐ Product C (Gift card)  x1  (digital) │
  │                                          │
  │  Tracking company: [GHN Express    ▼]    │
  │  Tracking number:  [VN123456789     ]    │
  │  Tracking URL:     [https://ghn.vn/...]  │
  │                                          │
  │  ☑ Notify customer via email             │
  │                                          │
  │  [Fulfill selected items]                │
  └──────────────────────────────────────────┘
```
- [ ] Select items to fulfill (partial fulfillment)
- [ ] Enter tracking info
- [ ] Auto-update fulfillment_status (unfulfilled → partial → fulfilled)
- [ ] Send shipment notification email
- [ ] Multiple fulfillments per order (split shipments)

**C2. Fulfillment Management**
- [ ] View all fulfillments for an order
- [ ] Cancel fulfillment
- [ ] Update tracking info
- [ ] Fulfillment timeline entries

**C3. Shipping Carriers**
- [ ] Pre-configured Vietnam carriers: GHN, GHTK, Viettel Post, J&T, Ninja Van
- [ ] International: DHL, FedEx, UPS, USPS
- [ ] Custom carrier name + URL template
- [ ] Auto-generate tracking URL from number + carrier

---

### PHASE D: Returns & Refunds (Uu tien: TRUNG BINH)

**D1. Refund Processing (not just requests)**
```
  ┌──────────────────────────────────────────┐
  │  REFUND ORDER #1042                      │
  │  ──────────────────                      │
  │  REFUND ITEMS:                           │
  │  ☑ Product A x2  @ $25.00  = $50.00     │
  │  ☐ Product B x1  @ $15.00  = $15.00     │
  │                                          │
  │  Items subtotal:        $50.00           │
  │  Refund shipping:  ☐   $0.00            │
  │  Adjustment:            [$0.00]          │
  │  ─────────────────────────────           │
  │  Refund total:          $50.00           │
  │                                          │
  │  ☑ Restock items                         │
  │  ☐ Send notification to customer         │
  │  Reason: [Customer changed mind    ▼]    │
  │                                          │
  │  [Refund $50.00]                         │
  └──────────────────────────────────────────┘
```
- [ ] Partial refund (select items + quantities)
- [ ] Full refund
- [ ] Refund shipping optionally
- [ ] Custom refund amount (adjustment)
- [ ] Restock toggle per item
- [ ] Record in `refunds` + `refund_line_items` tables
- [ ] Create `refund` transaction

**D2. Returns Workflow**
- [ ] Create return from order detail
- [ ] Select items for return
- [ ] Return reasons (defective, wrong item, changed mind, etc.)
- [ ] Return status tracking (requested → approved → received → refunded)
- [ ] Customer self-serve return portal (Phase 3+)
- [ ] Exchange flow: return item + add new item

**D3. Return Merchandise Authorization (RMA)**
- [ ] Generate RMA number
- [ ] Return shipping label (future integration)
- [ ] Return instructions email

---

### PHASE E: Import / Export System (Uu tien: CAO)
> Day la feature Shopify KHONG co native — Gbox lam tot hon se la competitive advantage

**E1. Export Orders**
```
  ┌──────────────────────────────────────────┐
  │  EXPORT ORDERS                           │
  │  ─────────────                           │
  │                                          │
  │  What to export:                         │
  │  ○ Current page (20 orders)              │
  │  ○ All orders matching filters (156)     │
  │  ○ Date range: [2026-01-01] to [today]   │
  │  ○ Selected orders (5 selected)          │
  │                                          │
  │  Format:                                 │
  │  ○ CSV (Excel compatible)                │
  │  ○ JSON                                  │
  │  ○ XLSX (Excel native)                   │
  │                                          │
  │  Include:                                │
  │  ☑ Order details                         │
  │  ☑ Line items                            │
  │  ☑ Customer info                         │
  │  ☑ Shipping address                      │
  │  ☐ Transaction history                   │
  │  ☐ Fulfillment details                   │
  │                                          │
  │  [Export]                                │
  └──────────────────────────────────────────┘
```

**E1 CSV Columns (Shopify-compatible):**
```
Order Number, Order ID, Created At, Updated At, Financial Status,
Fulfillment Status, Currency, Subtotal, Total Discounts, Total Shipping,
Total Tax, Total Price, Note, Tags,
Customer ID, Customer Email, Customer Name, Customer Phone,
Billing Name, Billing Address1, Billing Address2, Billing City,
Billing Province, Billing Zip, Billing Country, Billing Phone,
Shipping Name, Shipping Address1, Shipping Address2, Shipping City,
Shipping Province, Shipping Zip, Shipping Country, Shipping Phone,
Line Item Product ID, Line Item SKU, Line Item Title, Line Item Variant,
Line Item Quantity, Line Item Price, Line Item Discount, Line Item Total,
Payment Method, Payment Gateway, Transaction ID, Risk Level
```
- [ ] Stream large exports (>1000 orders) → email download link
- [ ] Small exports (<100) → instant download

**E2. Import Orders**
```
  ┌──────────────────────────────────────────┐
  │  IMPORT ORDERS                           │
  │  ─────────────                           │
  │                                          │
  │  Source:                                 │
  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ │
  │  │ 📄 CSV   │ │ 📋 JSON  │ │ 📊 XLSX  │ │
  │  └──────────┘ └──────────┘ └──────────┘ │
  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ │
  │  │🛍Shopify │ │📦 Amazon │ │🎵TikTok  │ │
  │  └──────────┘ └──────────┘ └──────────┘ │
  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ │
  │  │🛒 WooCom │ │🏪 eBay   │ │📦 Lazada │ │
  │  └──────────┘ └──────────┘ └──────────┘ │
  │                                          │
  │  [Upload file or drag & drop here]       │
  │                                          │
  └──────────────────────────────────────────┘
```

**E2a. Generic CSV/JSON/XLSX Import:**
```
  Step 1: Upload file
  Step 2: Column mapping (auto-detect + manual adjust)
     ┌────────────────────┬──────────────────────┐
     │  Your Column       │  Gbox Field          │
     ├────────────────────┼──────────────────────┤
     │  "Order No"        │  → Order Number      │
     │  "Cust Email"      │  → Customer Email    │
     │  "Product Name"    │  → Line Item Title   │
     │  "Qty"             │  → Line Item Qty     │
     │  "Amount"          │  → Total Price       │
     │  "Date"            │  → Created At        │
     └────────────────────┴──────────────────────┘
  Step 3: Preview (show first 5 rows parsed)
  Step 4: Validate (check required fields, duplicates)
  Step 5: Import with progress bar
  Step 6: Summary (imported: 150, skipped: 3, errors: 2)
```
- [ ] Save column mapping as template for reuse
- [ ] Skip duplicate detection (by external order number or email+date)
- [ ] Dry-run mode (validate without importing)
- [ ] Error log downloadable

**E2b. Platform-Specific Importers:**

| Platform | Export Format | Key Fields Mapping | Notes |
|----------|-------------|-------------------|-------|
| **Shopify** | CSV | Direct 1:1 mapping (same field names) | Easiest — Gbox dung format giong Shopify |
| **Amazon** | TSV/CSV | amazon-order-id → external_id, ASIN → sku | Separate "items" and "orders" files |
| **TikTok Shop** | CSV/XLSX | package_id, sku_id, buyer_message | Order + package are separate entities |
| **WooCommerce** | CSV/JSON | post_id → external_id, _billing_email → email | WP post structure, meta fields |
| **eBay** | CSV | eBay item number → external_id, PayPal txn → gateway_txn_id | Legacy PayPal refs |
| **Lazada** | XLSX | orderNumber, itemName, trackingCode | Southeast Asia market |
| **Tiki** | XLSX | Ma don hang, Ten san pham | Vietnam market |
| **Sendo** | XLSX/CSV | Similar to Tiki | Vietnam market |

**E2c. Import Architecture:**
```
                    ┌──────────────┐
                    │  Upload File │
                    └──────┬───────┘
                           │
                    ┌──────▼───────┐
                    │  Detect      │  ← Auto-detect format + platform
                    │  Platform    │    (by column headers / file structure)
                    └──────┬───────┘
                           │
                    ┌──────▼───────┐
                    │  Platform    │  ← Each platform has its own parser
                    │  Parser      │    that normalizes to GboxOrder format
                    └──────┬───────┘
                           │
                    ┌──────▼───────┐
                    │  Normalize   │  ← Convert to unified GboxOrder schema
                    │  to Gbox     │
                    └──────┬───────┘
                           │
                    ┌──────▼───────┐
                    │  Validate    │  ← Check required fields, data types
                    │  & Preview   │    Show preview to user
                    └──────┬───────┘
                           │
                    ┌──────▼───────┐
                    │  User        │  ← User confirms import
                    │  Confirm     │
                    └──────┬───────┘
                           │
                    ┌──────▼───────┐
                    │  Batch       │  ← Insert in batches of 50
                    │  Insert      │    with progress updates
                    └──────┬───────┘
                           │
                    ┌──────▼───────┐
                    │  Report      │  ← Success/error summary
                    │  Summary     │
                    └──────────────┘
```

---

### PHASE F: Order Notifications & Emails (Uu tien: TRUNG BINH)

- [ ] Order confirmation email (da co 1 phan)
- [ ] Shipping confirmation + tracking link
- [ ] Delivery confirmation
- [ ] Refund confirmation
- [ ] Return instructions
- [ ] Invoice email (attached PDF)
- [ ] Abandoned checkout recovery email
- [ ] Resend any email from order detail

---

### PHASE G: Advanced Features (Uu tien: THAP — Phase 3+)

**G1. Saved Views / Custom Tabs**
- [ ] Save any filter combination as a named view
- [ ] Pin views as tabs
- [ ] Share views with store staff

**G2. Order Automation (Shopify Flow equivalent)**
- [ ] Auto-tag orders by rules (amount > $100 → tag "VIP")
- [ ] Auto-fulfill digital products
- [ ] Auto-capture payment for low-risk orders
- [ ] Auto-archive fulfilled+paid orders
- [ ] Webhook triggers on order events

**G3. Multi-Currency**
- [ ] Display in presentment currency
- [ ] Store in shop currency
- [ ] Exchange rate at time of order
- [ ] Multi-currency reports

**G4. Subscriptions / Recurring Orders**
- [ ] Selling plans (billing frequency, pricing)
- [ ] Customer portal: manage, skip, cancel
- [ ] Auto-create orders on schedule

**G5. POS Integration**
- [ ] POS orders in same list (tagged "POS")
- [ ] Register/location tracking
- [ ] Cash/card payment types

**G6. B2B Orders**
- [ ] Company accounts
- [ ] Net payment terms (Net 30, Net 60)
- [ ] Purchase orders
- [ ] Tax-exempt customers
- [ ] Volume pricing

---

## DATABASE CHANGES NEEDED

### New Tables

**1. `order_events` — Timeline / Activity Log**
```sql
CREATE TABLE order_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id      uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  shop_id       uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  user_id       uuid REFERENCES users(id) ON DELETE SET NULL,
  event_type    varchar(50) NOT NULL,
    -- created, paid, fulfilled, partially_fulfilled, refunded,
    -- edited, cancelled, archived, unarchived, note_added,
    -- email_sent, tracking_updated, return_requested, return_received
  title         varchar(255) NOT NULL,
  description   text,
  metadata      jsonb,       -- flexible: {tracking_number, email_to, old_value, new_value}
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_order_events_order ON order_events(order_id, created_at DESC);
```

**2. `order_import_jobs` — Import tracking**
```sql
CREATE TABLE order_import_jobs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id       uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id),
  platform      varchar(30) NOT NULL,  -- csv, shopify, amazon, tiktok, woocommerce, etc.
  file_name     varchar(255) NOT NULL,
  status        varchar(20) NOT NULL DEFAULT 'pending',
    -- pending, processing, completed, failed
  total_rows    integer DEFAULT 0,
  imported      integer DEFAULT 0,
  skipped       integer DEFAULT 0,
  errors        integer DEFAULT 0,
  error_log     jsonb,                 -- [{row: 5, field: 'email', error: 'invalid format'}]
  column_mapping jsonb,                -- saved mapping for reuse
  created_at    timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz
);
```

**3. `order_import_templates` — Saved column mappings**
```sql
CREATE TABLE order_import_templates (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id       uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  name          varchar(100) NOT NULL,
  platform      varchar(30) NOT NULL,
  column_mapping jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
```

**4. `returns` — Return tracking**
```sql
CREATE TABLE returns (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id      uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  shop_id       uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  rma_number    varchar(50) UNIQUE,
  status        varchar(20) NOT NULL DEFAULT 'requested',
    -- requested, approved, declined, received, refunded, closed
  reason        varchar(50),   -- defective, wrong_item, changed_mind, damaged, other
  note          text,
  tracking_number varchar(255),
  tracking_company varchar(100),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE return_line_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  return_id     uuid NOT NULL REFERENCES returns(id) ON DELETE CASCADE,
  line_item_id  uuid NOT NULL REFERENCES order_line_items(id) ON DELETE CASCADE,
  quantity      integer NOT NULL,
  reason        varchar(50),
  restock       boolean NOT NULL DEFAULT false
);
```

### Schema Changes to Existing Tables

**orders table:**
```sql
-- Add columns
ALTER TABLE orders ADD COLUMN external_id        varchar(255);   -- ID from imported platform
ALTER TABLE orders ADD COLUMN external_platform   varchar(30);    -- shopify, amazon, tiktok, etc.
ALTER TABLE orders ADD COLUMN source_channel      varchar(50) DEFAULT 'online_store';
ALTER TABLE orders ADD COLUMN risk_level          varchar(10);    -- low, medium, high
ALTER TABLE orders ADD COLUMN archived_at         timestamptz;
ALTER TABLE orders ADD COLUMN return_status       varchar(30);    -- null, return_in_progress, returned

-- Index for imports dedup
CREATE UNIQUE INDEX idx_orders_external ON orders(shop_id, external_platform, external_id)
  WHERE external_id IS NOT NULL;
```

---

## FILE STRUCTURE (CODE ORGANIZATION)

```
apps/store-admin/src/pages/
├── orders.ts                    (existing — list + detail + bulk)
├── orders-edit.ts               (NEW — inline edit order)
├── orders-fulfill.ts            (NEW — fulfillment from store-admin)
├── orders-refund.ts             (NEW — refund processing)
├── orders-returns.ts            (NEW — returns management)
├── orders-import.ts             (NEW — import wizard)
├── orders-export.ts             (NEW — export handler)
├── orders-print.ts              (NEW — packing slip + invoice templates)
├── draft-orders.ts              (existing)
├── abandoned-checkouts.ts       (existing)
├── order-analytics.ts           (existing)
└── refund-requests.ts           (existing — merge into orders-refund.ts later)

packages/core/src/modules/orders/
├── service.ts                   (existing — extend)
├── import/
│   ├── parser.ts                (NEW — base parser interface)
│   ├── csv-parser.ts            (NEW — generic CSV)
│   ├── shopify-parser.ts        (NEW — Shopify CSV format)
│   ├── amazon-parser.ts         (NEW — Amazon order report)
│   ├── tiktok-parser.ts         (NEW — TikTok Shop export)
│   ├── woocommerce-parser.ts    (NEW — WooCommerce CSV/JSON)
│   ├── lazada-parser.ts         (NEW — Lazada XLSX)
│   └── validator.ts             (NEW — validate normalized orders)
├── export/
│   ├── csv-exporter.ts          (NEW)
│   ├── json-exporter.ts         (NEW)
│   └── xlsx-exporter.ts         (NEW)
└── risk/
    └── analyzer.ts              (NEW — rule-based risk scoring)
```

---

## IMPLEMENTATION PRIORITY & TIMELINE

### Sprint 1 (1-2 ngay): Core Fixes — HOAN THANH
- [x] Fix `req.params.id` → `req.params.orderId` in getOrderDetail
- [x] Exclude draft orders from Orders list
- [x] Verify convert draft → order flow end-to-end

### Sprint 2 (3-4 ngay): Order Detail Enhancement — HOAN THANH
- [x] Order timeline (`order_events` table + UI)
- [x] Inline edit (address, note, tags, email, phone)
- [x] Google Places address autocomplete + interactive map
- [x] POD file upload per line item (R2 storage)
- [ ] Actions menu (cancel, archive, duplicate) — LATER
- [ ] Print packing slip + invoice — LATER

### Sprint 3: Fulfillment Page — HOAN THANH
- [x] Store-admin fulfillments page with sidebar nav item
- [x] Fulfillment list (unfulfilled/fulfilled/all, search, pagination)
- [x] Fulfillment detail with POD upload per line item
- [x] POD file preview with thumbnail + download + replace
- [x] Fulfillment stays god-admin only (per owner decision)

### Sprint 4 (3-4 ngay): Export System — HOAN THANH
- [x] CSV export (Shopify-compatible format, one row per line item)
- [x] JSON export
- [x] Export all / date range / unfulfilled / paid
- [x] Include options: line items, customer, addresses, transactions, fulfillments
- [x] UTF-8 BOM for Excel compatibility
- [x] Export UI with format selection, scope options

### Sprint 5 (5-7 ngay): Import System — HOAN THANH
- [x] Generic CSV import with auto-detected column mapping
- [x] Shopify CSV importer (auto-detect by header names)
- [x] Amazon order report importer (TSV/CSV)
- [x] TikTok Shop importer
- [x] Import wizard: upload → preview → validate → confirm
- [x] Duplicate detection (external_id + platform per shop)
- [x] Error reporting with row numbers
- [x] Auto-tag imported orders ("imported", "import:platform")
- [x] Database migration 022 (external_id, external_platform, import tables)
- [ ] WooCommerce importer — LATER
- [ ] Save mapping templates — LATER
- [ ] Progress bar for large imports — LATER

### Sprint 6 (3-4 ngay): Refunds & Returns — HOAN THANH
- [x] Full return flow: requested → approved → received → refunded → closed
- [x] Create return from order detail (select items, quantities, reasons)
- [x] Refund amount calculation (item prices + optional shipping)
- [x] Restock option (auto-increment inventory on refund)
- [x] RMA number generation (unique per return)
- [x] Returns list page with status filter tabs
- [x] Return detail page with status flow visualization
- [x] Action buttons: approve, receive, refund, cancel
- [x] Order timeline events for each return status change
- [x] Order return_status tracking (return_in_progress → returned)
- [x] Database migration 023 (returns, return_line_items tables)

### Sprint 7 (2-3 ngay): Risk & Analytics
- [ ] Rule-based risk scoring
- [ ] Risk badge on order list + detail
- [ ] Enhanced analytics (returns rate, avg order value trend)

### Sprint 8+ (ongoing): Advanced
- [ ] Saved views / custom tabs
- [ ] Order automation rules
- [ ] Multi-currency display
- [ ] B2B features

---

## SHOPIFY SO SANH — GBOX COMPETITIVE ADVANTAGES

| Feature | Shopify | Gbox (Planned) |
|---------|---------|----------------|
| Order Import | ❌ No native (need app) | ✅ Built-in multi-platform |
| Custom Order Status | ❌ Tags workaround | 🔄 Tags + custom status (future) |
| Vietnam Carriers | ❌ Need app | ✅ GHN, GHTK, VTP built-in |
| VN Market Import | ❌ No support | ✅ Lazada, Tiki, Sendo parsers |
| Self-hosted | ❌ SaaS only | ✅ On-premise option |
| Platform Fee | 💰 2.9% + $0.30/txn | ✅ No platform fee |

---

## GHI CHU CHO OWNER (Thai)

1. **Phase E (Import/Export) la feature khac biet lon nhat** — Shopify khong co native import, phai dung app $20-50/thang. Gbox lam native se la selling point manh.

2. **Phase C (Fulfillment)** hien dang lock cho god-admin only — can quyet dinh: cho seller tu fulfill hay phai qua god-admin approve?

3. **Platform-specific importers** — anh muon uu tien platforms nao truoc? Em de nghi:
   - Tier 1 (lam truoc): CSV generic, Shopify, Amazon
   - Tier 2: TikTok Shop, WooCommerce
   - Tier 3: Lazada, Tiki, Sendo, eBay

4. **Returns workflow** — anh muon simple (refund only) hay full flow (return request → approve → receive → refund)?

5. **Risk analysis** — v1 rule-based (IP, email, velocity), v2 ML. OK khong?

---

*Anh review va cho y kien, em se bat tay vao lam theo thu tu anh chon.*
