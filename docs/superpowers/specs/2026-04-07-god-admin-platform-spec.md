# GOD ADMIN PLATFORM — DESIGN SPEC
## He Thong Quan Tri Gbox Chuyen Nghiep

**Date**: 2026-04-07
**Author**: Claude (cho Thai Bui duyet)
**Status**: DRAFT
**Scope**: Foundation + Groups A, B, C, H (29 chuc nang) — Groups D,E,F,G,I,J,K skeleton UI

---

## 1. TONG QUAN

### 1.1 Muc tieu
Rebuild God Admin tu "basic dashboard" thanh **He thong quan tri platform cap enterprise** voi:
- Login page rieng tai `/god-admin/login` (tach biet hoan toan khoi accounts portal)
- God Admin hierarchy: Default (khong the xoa) + God Admin 2 (co the xoa)
- 60 chuc nang chia 10 nhom (A-K) voi AI Integration
- API rieng ket noi toan he thong
- Dot 1: Foundation + A + B + C + H (29 chuc nang implement day du)
- Dot 1b: D + E + F + G + I + J + K (31 chuc nang skeleton UI)

### 1.2 God Admin Hierarchy

```
GOD ADMIN DEFAULT (buithai3107@gmail.com)
│  - Seeded tu dong khi DB init
│  - Password: Thaimui@99 (bcrypt hashed)
│  - role = 'owner', is_default_admin = true
│  - KHONG THE XOA, KHONG THE DEMOTE
│  - Co the tao/xoa God Admin 2
│
└── GOD ADMIN 2 (do Default tao)
    - role = 'owner' (same role, same power)
    - is_default_admin = false (hoac NULL)
    - CO THE bi xoa boi Default ONLY
    - KHONG THE tu xoa chinh minh
    - KHONG THE xoa Default
```

### 1.3 Port & Route

```
Port: 4324 (giu nguyen)
Base URL: /god-admin

PUBLIC (khong can auth):
  GET  /god-admin/login         — Login page
  POST /god-admin/login         — Submit login
  GET  /god-admin/logout        — Clear session, redirect to login

PROTECTED (can god admin session):
  GET  /god-admin               — Dashboard (A1)
  GET  /god-admin/metrics       — Real-time metrics (A2)
  GET  /god-admin/health        — System health (A3)
  GET  /god-admin/alerts        — Alert center (A4)
  GET  /god-admin/activity      — Activity feed (A5)
  POST /god-admin/ai/chat       — AI Platform Advisor (A6, A7)

  GET  /god-admin/stores              — Store list (B1)
  GET  /god-admin/stores/:id          — Store detail (B2)
  POST /god-admin/stores              — Create store (B3)
  POST /god-admin/stores/:id/suspend  — Suspend store (B4)
  POST /god-admin/stores/:id/activate — Reactivate store (B4)
  POST /god-admin/stores/:id/delete   — Delete store (B5)
  GET  /god-admin/stores/:id/health   — Store health score (B6)

  GET  /god-admin/users               — User list (C1)
  GET  /god-admin/users/:id           — User detail (C2)
  POST /god-admin/users               — Create user (C3)
  POST /god-admin/users/:id/disable   — Disable user (C4)
  POST /god-admin/users/:id/enable    — Enable user (C4)
  POST /god-admin/users/:id/reset-pw  — Reset password (C5)
  POST /god-admin/users/:id/impersonate — Impersonate (C6)

  GET  /god-admin/orders              — Orders (D1) [skeleton]
  GET  /god-admin/orders/analytics    — Order analytics (D2) [skeleton]
  GET  /god-admin/fulfillments        — Fulfillment queue (E1) [skeleton]
  GET  /god-admin/finance             — Finance dashboard (F1) [skeleton]
  GET  /god-admin/finance/transactions — Transaction log (F2) [skeleton]
  GET  /god-admin/staff               — Staff list (G1) [skeleton]
  GET  /god-admin/staff/ai-agents     — AI Agents panel (G5-G8) [skeleton]
  GET  /god-admin/security            — Audit log (H1)
  GET  /god-admin/security/logins     — Login history (H2)
  GET  /god-admin/security/suspicious — Suspicious activity (H3)
  GET  /god-admin/security/tokens     — API tokens (H4)
  GET  /god-admin/content             — Content management (I1) [skeleton]
  GET  /god-admin/content/campaigns   — Email campaigns (I2) [skeleton]
  GET  /god-admin/config              — Platform config (J1-J5) [skeleton]
  GET  /god-admin/developer           — Developer hub (K1) [skeleton]
  GET  /god-admin/developer/webhooks  — Webhook log (K2) [skeleton]
  GET  /god-admin/developer/apps      — App marketplace (K3) [skeleton]

  GET  /god-admin/admins              — God Admin management (DEFAULT only)
  POST /god-admin/admins/create       — Create God Admin 2
  POST /god-admin/admins/:id/delete   — Delete God Admin 2
```

---

## 2. FOUNDATION ARCHITECTURE

### 2.1 Login System (Rieng biet)

```
+------------------+     +------------------+     +------------------+
|   BROWSER        |     |   NGINX          |     |  GOD ADMIN APP   |
|                  | --> | /god-admin/*     | --> |  :4324           |
|  /god-admin/login|     | proxy to :4324   |     |                  |
+------------------+     +------------------+     +--------+---------+
                                                           |
                              +----------------------------+
                              |
                    +---------v----------+
                    |  @gbox/core        |
                    |  - verifyPassword  |
                    |  - createSession   |
                    |  - validateSession |
                    +---------+----------+
                              |
                    +---------v----------+
                    |   PostgreSQL       |
                    |   users table      |
                    |   sessions table   |
                    +--------------------+

FLOW:
1. GET /god-admin/login → render login form (dark theme, professional)
2. POST /god-admin/login
   a. Validate CSRF token
   b. Rate limit: 5 attempts/minute per IP
   c. Find user by email WHERE role = 'owner'
   d. Verify password (bcrypt)
   e. Create session (shared gbox_session cookie)
   f. Audit log: god_admin.login
   g. Redirect to /god-admin
3. Middleware: check gbox_session → validate → role must be 'owner'
4. GET /god-admin/logout → delete session → redirect to /god-admin/login
```

### 2.2 Database Changes

```sql
-- Migration: Add is_default_admin column to users
ALTER TABLE users ADD COLUMN is_default_admin BOOLEAN DEFAULT FALSE;

-- Seed: Create default God Admin
INSERT INTO users (id, email, password_hash, name, role, status, is_default_admin)
VALUES (
  gen_random_uuid(),
  'buithai3107@gmail.com',
  '$2b$12$...', -- bcrypt hash of 'Thaimui@99'
  'Thai Bui',
  'owner',
  'active',
  TRUE
) ON CONFLICT (email) DO UPDATE SET
  role = 'owner',
  status = 'active',
  is_default_admin = TRUE,
  password_hash = CASE
    WHEN users.password_hash IS NULL THEN EXCLUDED.password_hash
    ELSE users.password_hash  -- keep existing if already set
  END;
```

### 2.3 Layout System

```
+------------------------------------------------------------------+
|  TOP BAR (56px, dark)                                             |
|  [Logo: GBOX PLATFORM]          [Alerts 🔔] [Admin ▼] [Logout]  |
+----------+-------------------------------------------------------+
|          |                                                        |
| SIDEBAR  |  MAIN CONTENT AREA                                    |
| (260px)  |                                                        |
|          |  +--------------------------------------------------+  |
| A. Tong  |  |  Page Header + Breadcrumbs                       |  |
|    Quan  |  +--------------------------------------------------+  |
|          |  |                                                  |  |
| B. Stores|  |  Content (cards, tables, charts, forms)          |  |
|          |  |                                                  |  |
| C. Users |  |                                                  |  |
|          |  |                                                  |  |
| D. Orders|  +--------------------------------------------------+  |
|          |                                                        |
| E. Ship  |  +--------------------------------------------------+  |
|          |  |  AI ASSISTANT PANEL (collapsible, right side)     |  |
| F. Money |  |  [Chat input] [Quick actions]                    |  |
|          |  +--------------------------------------------------+  |
| G. Staff |                                                        |
|          +--------------------------------------------------------+
| H. Sec   |
|          |
| I. CMS   |
|          |
| J. Config|
|          |
| K. Dev   |
|          |
| -------- |
| Admins   | ← Chi hien khi is_default_admin = true
+----------+
```

**Design Tokens:**
```
Colors:
  --god-bg:         #0f172a (slate-900, main background)
  --god-sidebar:    #1e293b (slate-800)
  --god-sidebar-hover: #334155 (slate-700)
  --god-topbar:     #1e293b
  --god-card:       #1e293b (cards on dark bg)
  --god-card-hover: #334155
  --god-text:       #f1f5f9 (slate-100)
  --god-text-muted: #94a3b8 (slate-400)
  --god-accent:     #3b82f6 (blue-500, primary action)
  --god-success:    #22c55e (green-500)
  --god-warning:    #f59e0b (amber-500)
  --god-danger:     #ef4444 (red-500)
  --god-border:     #334155 (slate-700)

Typography:
  Font: Inter (headings), system-ui (body)
  H1: 24px bold
  H2: 20px semibold
  Body: 14px regular
  Small: 12px

Spacing:
  Sidebar: 260px fixed
  Topbar: 56px fixed
  Content padding: 24px
  Card padding: 20px
  Card gap: 16px
  Card radius: 12px
```

---

## 3. GROUP A: TONG QUAN HE THONG (7 chuc nang)

### A1. Dashboard Tong
```
+------------------------------------------------------------+
| Dashboard                                   Period: [7 days▼]|
+------------------------------------------------------------+
|                                                              |
| +----------+ +----------+ +----------+ +----------+         |
| | Revenue  | | Orders   | | Stores   | | Users    |         |
| | $45,230  | | 1,234    | | 156      | | 2,340    |         |
| | +12.5%   | | +8.3%    | | +3       | | +45      |         |
| +----------+ +----------+ +----------+ +----------+         |
|                                                              |
| +----------+ +----------+ +----------+ +----------+         |
| | AOV      | | Conv Rate| | Sessions | | Uptime   |         |
| | $36.65   | | 3.2%     | | 89       | | 99.98%   |         |
| +----------+ +----------+ +----------+ +----------+         |
|                                                              |
| +---------------------------+ +---------------------------+ |
| | Revenue Chart (7 days)    | | Orders Chart (7 days)     | |
| | [line chart with trend]   | | [bar chart by day]        | |
| +---------------------------+ +---------------------------+ |
|                                                              |
| +---------------------------+ +---------------------------+ |
| | Top 5 Stores by Revenue   | | Recent Orders (10)        | |
| | Store | Revenue | Orders  | | #1234 | Fashion Hub | $89 | |
| +---------------------------+ +---------------------------+ |
|                                                              |
| +---------------------------+ +---------------------------+ |
| | Recent Users (5)          | | System Info               | |
| | email | role | joined     | | Node | Memory | CPU | DB  | |
| +---------------------------+ +---------------------------+ |
+------------------------------------------------------------+

Data queries:
- SUM revenue (current period vs previous)
- COUNT orders (current vs previous)
- COUNT shops WHERE status = 'active'
- COUNT users
- AVG order value
- Top 5 stores by revenue (join orders + shops)
- Recent 10 orders (join shops + customers)
- Recent 5 users
- Active sessions count
- Process memory, uptime
```

### A2. Real-time Metrics
```
Live dashboard (auto-refresh moi 30s):
- Orders per minute (last 60 minutes chart)
- Active sessions now
- Revenue today vs yesterday same time
- Live activity feed (last 20 actions)

Implementation: polling via setInterval + fetch /god-admin/api/metrics
```

### A3. System Health
```
+------------------------------------------------------------+
| System Health                                                |
+------------------------------------------------------------+
| Server Status: [HEALTHY ✓]                                   |
|                                                              |
| +----------+ +----------+ +----------+ +----------+         |
| | CPU      | | Memory   | | Disk     | | DB Pool  |         |
| | 23%      | | 412MB    | | 45%      | | 8/20     |         |
| | [gauge]  | | [gauge]  | | [gauge]  | | [gauge]  |         |
| +----------+ +----------+ +----------+ +----------+         |
|                                                              |
| Service Status:                                              |
| +----------------------------------------------------------+|
| | Service        | Port | Status  | Uptime  | Memory      ||
| | API Gateway    | 4321 | ✓ UP    | 2d 5h   | 73MB        ||
| | Accounts       | 4323 | ✓ UP    | 2d 5h   | 98MB        ||
| | God Admin      | 4324 | ✓ UP    | 2d 5h   | 102MB       ||
| | Store Admin    | 4325 | ✓ UP    | 0d 3h   | 99MB        ||
| +----------------------------------------------------------+|
|                                                              |
| Database:                                                    |
| +----------------------------------------------------------+|
| | Metric            | Value                                ||
| | Active connections | 8                                   ||
| | Avg query time     | 12ms                                ||
| | Slowest query      | GET /products (145ms)               ||
| | DB size            | 256MB                               ||
| +----------------------------------------------------------+|
+------------------------------------------------------------+

Implementation:
- process.memoryUsage(), process.cpuUsage(), os.totalmem()
- pg pool stats: pool.totalCount, pool.idleCount, pool.waitingCount
- HTTP check each service: fetch('http://127.0.0.1:PORT/health')
- Disk: fs.statfs or df command
```

### A4. Alert Center
```
Alerts aggregated from:
- Low stock: products WHERE inventory_quantity < 5
- Payment failures: transactions WHERE status = 'failure' (last 24h)
- Security: failed logins > 10/hour from same IP
- Store issues: stores with 0 orders in 7 days
- System: memory > 80%, CPU > 90%, disk > 90%

Display: Card list with severity (critical/warning/info), timestamp, action button
Mark as read/dismissed
```

### A5. Activity Feed
```
Query audit_logs ORDER BY created_at DESC LIMIT 50
Display: timeline with icon, action, user, resource, timestamp
Filter by: action type, user, date range
```

### A6. AI Platform Advisor
```
POST /god-admin/ai/chat
Body: { message, context: 'platform' }

AI functions (query DB, analyze, respond):
- analyzePlatformRevenue(period)
- analyzeStorePerformance(storeId?)
- analyzeUserActivity()
- detectAnomalies()
- generateRecommendations()

Response: { html (formatted cards/tables), suggested_actions[] }

UI: Collapsible panel on right side, persistent chat history per session
Quick action buttons: "Platform overview", "Revenue analysis", "Problem stores"
```

### A7. AI Anomaly Detection
```
Integrated into A6 AI chat + automatic alerts in A4
Checks (run on dashboard load):
- Orders per store per hour vs 7-day average (>5x = anomaly)
- Revenue spikes/drops >30% vs same day last week
- Login attempts >20/hour from single IP
- New accounts >50/hour (possible bot registration)

Display in Alert Center (A4) with AI explanation
```

---

## 4. GROUP B: QUAN LY STORES (8 chuc nang)

### B1. Store List
```
+------------------------------------------------------------+
| Stores                                    [+ Create Store]  |
+------------------------------------------------------------+
| Search: [_______________] Status: [All▼] Plan: [All▼]      |
|                                                              |
| +----------------------------------------------------------+|
| | Store        | Slug       | Plan  | Status | Revenue     ||
| | Fashion Hub  | fashion-hub| basic | Active | $12,340     ||
| | Tech Gadgets | tech-gadgets| pro  | Active | $8,560      ||
| | ...          |            |       |        |             ||
| +----------------------------------------------------------+|
| Page 1 of 5  [< Prev] [Next >]                             |
+------------------------------------------------------------+

Query: shops LEFT JOIN (SELECT shop_id, SUM(total_price) FROM orders GROUP BY shop_id)
Filters: status, plan, search (name/slug/email ilike)
Sort: name, created_at, revenue
Pagination: 20 per page
```

### B2. Store Detail
```
+------------------------------------------------------------+
| ← Back | Fashion Hub                    [Suspend] [Delete]  |
+------------------------------------------------------------+
| +----------+ +----------+ +----------+ +----------+         |
| | Revenue  | | Orders   | | Products | | Customers|         |
| | $12,340  | | 234      | | 56       | | 189      |         |
| +----------+ +----------+ +----------+ +----------+         |
|                                                              |
| +---------------------------+ +---------------------------+ |
| | Store Info                 | | Staff                     | |
| | Name: Fashion Hub          | | owner@fashion.com (owner) | |
| | Slug: fashion-hub          | | staff1@... (admin)        | |
| | Email: hello@fashionhub.com| | staff2@... (staff)        | |
| | Plan: basic                | +---------------------------+ |
| | Created: Apr 6, 2026       |                               |
| +---------------------------+ +---------------------------+ |
|                               | | Recent Orders (10)        | |
| +---------------------------+ | | #1234 | $89 | paid        | |
| | Top Products              | | +---------------------------+ |
| | T-Shirt | 45 sold | $450 | |                               |
| +---------------------------+                                |
+------------------------------------------------------------+

Queries:
- shops WHERE id = :id
- COUNT/SUM from orders WHERE shop_id
- COUNT from products WHERE shop_id
- COUNT from customers WHERE shop_id
- user_shops JOIN users WHERE shop_id
- Recent orders
- Top products by order count
```

### B3. Create Store
```
Form: name, slug (auto-generate), email, currency, timezone, plan
POST /god-admin/stores
  → INSERT shops
  → Redirect to store detail
```

### B4. Suspend/Reactivate
```
POST /god-admin/stores/:id/suspend
  → UPDATE shops SET status = 'suspended'
  → Audit log: store.suspended
  → (Future: email notification to owner)

POST /god-admin/stores/:id/activate
  → UPDATE shops SET status = 'active'
  → Audit log: store.reactivated
```

### B5. Delete Store (Vinh vien)
```
POST /god-admin/stores/:id/delete
  → Confirm dialog: "Type store slug to confirm"
  → Soft delete: UPDATE shops SET status = 'deleted', updated_at = now()
  → Audit log: store.deleted
  → (Data retained for 30 days, then hard delete via cron)
```

### B6. Store Health Score
```
GET /god-admin/stores/:id/health

Score 0-100 based on:
- Has products (0-20 points): >10 products = 20, >5 = 10, >0 = 5
- Has orders last 7 days (0-20): >10 = 20, >5 = 15, >0 = 10
- Product quality (0-20): has images, descriptions, variants
- Customer engagement (0-20): returning customers %, accepts_marketing %
- Technical (0-20): all settings filled, has domain, has shipping

Display: Score with breakdown, recommendations
```

### B7. AI Store Analyst (via AI chat)
```
User asks: "Analyze store Fashion Hub"
AI queries: revenue, orders, products, customers, conversion data
AI responds with analysis + recommendations in HTML cards
```

### B8. AI Store Recommendations (via AI chat)
```
User asks: "What should Fashion Hub do to grow?"
AI generates: top 5 actionable recommendations based on store data
```

---

## 5. GROUP C: QUAN LY USERS (8 chuc nang)

### C1. User List
```
+------------------------------------------------------------+
| Users                                      [+ Create User]  |
+------------------------------------------------------------+
| Search: [_______________] Role: [All▼] Status: [All▼]      |
|                                                              |
| +----------------------------------------------------------+|
| | Email           | Name    | Role   | Status | Stores     ||
| | admin@gbox.co   | Admin   | owner  | Active | 3          ||
| | merchant@...    | John    | admin  | Active | 1          ||
| +----------------------------------------------------------+|
+------------------------------------------------------------+

Query: users LEFT JOIN (SELECT user_id, COUNT(*) FROM user_shops GROUP BY user_id)
Filters: role, status, search
```

### C2. User Detail
```
Full profile + stores access + sessions + audit log (same as current but enhanced)
```

### C3. Create User
```
Form: email, name, role (staff/admin), password (auto-generate option)
POST creates user + sends welcome email (future)
```

### C4. Disable/Enable
```
Same as current, with protection:
- Cannot disable default God Admin (is_default_admin = true)
- God Admin 2 CAN be disabled by Default
- Kills all sessions on disable
```

### C5. Reset Password
```
POST /god-admin/users/:id/reset-pw
  → Generate random password (16 chars)
  → Hash with bcrypt
  → UPDATE users SET password_hash
  → Show password ONCE in success message
  → Audit log: user.password_reset
```

### C6. Impersonate
```
POST /god-admin/users/:id/impersonate
  → Create session for target user
  → Set cookie with target user's session
  → Add header X-Impersonated-By: god_admin_id
  → Audit log: user.impersonated (with god_admin_id)
  → Redirect to /accounts/stores (as that user)
  → Show banner: "You are impersonating user@email.com [End]"

SECURITY:
  - Only Default God Admin can impersonate
  - Cannot impersonate other God Admins
  - Session expires in 1 hour (shorter than normal)
  - All actions logged with impersonation flag
```

### C7. AI User Segmentation (via AI chat)
```
AI auto-segments users:
- VIP merchants: total_revenue > $10K/month
- At-risk: revenue dropped >30% vs previous month
- New: created < 7 days ago
- Inactive: no login > 30 days
Displays as cards with count and action suggestions
```

### C8. AI Churn Prediction (via AI chat)
```
AI analyzes per user:
- Login frequency trend
- Order volume trend
- Support ticket count
- Revenue trend
Generates risk score 0-100 with explanation
```

---

## 6. GROUP H: BAO MAT & AUDIT (6 chuc nang)

### H1. Audit Log Viewer
```
+------------------------------------------------------------+
| Audit Log                                                    |
+------------------------------------------------------------+
| Action: [All▼] User: [All▼] From: [____] To: [____]       |
|                                                              |
| +----------------------------------------------------------+|
| | Time        | User          | Action          | Resource ||
| | 14:23:05    | admin@gbox.co | god_admin.login | -        ||
| | 14:20:12    | admin@gbox.co | store.suspended | store:abc||
| | 14:15:00    | merchant@...  | order.created   | order:123||
| +----------------------------------------------------------+|
+------------------------------------------------------------+

Query: audit_logs JOIN users
Filters: action (dropdown of distinct actions), user_id, date range
Pagination: 50 per page
Export: CSV (future)
```

### H2. Login History
```
Query: audit_logs WHERE action IN ('god_admin.login', 'god_admin.login_failed', 'user.login')
Display: user, IP, user_agent, success/fail, timestamp
Highlight: failed attempts in red
```

### H3. Suspicious Activity
```
Auto-detected patterns:
- >10 failed logins from same IP in 1 hour
- Login from new country/IP range
- Bulk actions (>50 deletes in 1 hour)
- API token used from unusual IP

Display: Alert cards with severity, details, suggested action
(Manual review + dismiss/block)
```

### H4. API Token Management
```
List all API tokens across all users/shops
Create/revoke tokens
Show: token label, user, shop, scopes, last_used, created
```

### H5. AI Security Monitor (via AI chat)
```
AI analyzes:
- Failed login patterns
- Unusual IP activity
- Bulk operations
- Session anomalies
Generates security report with recommendations
```

### H6. AI Compliance Checker (via AI chat)
```
AI checks stores for:
- Missing Privacy Policy page
- Missing Terms of Service
- Unverified email domains
- Products without proper descriptions
- Missing tax settings
Generates compliance report per store
```

---

## 7. SKELETON UI (Groups D, E, F, G, I, J, K)

Moi nhom co:
- Navigation item trong sidebar (voi icon)
- Landing page voi "Coming Soon" card + description
- Breadcrumbs va layout dung

```
D. Orders         → "Order Management — Coming in Phase 2"
E. Fulfillment    → "Fulfillment Center — Coming in Phase 2"
F. Finance        → "Financial Dashboard — Coming in Phase 2"
G. Staff & AI     → "Staff Management & AI Agents — Coming in Phase 2"
I. Content        → "Content & Marketing — Coming in Phase 2"
J. Config         → "Platform Configuration — Coming in Phase 2"
K. Developer      → "Developer Hub & Apps — Coming in Phase 2"
```

---

## 8. GOD ADMIN API ENDPOINTS

API phuc vu cho God Admin frontend (internal, not public):

```
PREFIX: /god-admin/api/

AUTH:
  POST /god-admin/api/login        — Authenticate + return session
  GET  /god-admin/api/session       — Validate current session
  POST /god-admin/api/logout        — Destroy session

DASHBOARD (A):
  GET  /god-admin/api/stats         — Platform stats (revenue, orders, etc)
  GET  /god-admin/api/metrics       — Real-time metrics
  GET  /god-admin/api/health        — System health data
  GET  /god-admin/api/alerts        — Active alerts
  GET  /god-admin/api/activity      — Activity feed

STORES (B):
  GET  /god-admin/api/stores        — List stores (with filters)
  GET  /god-admin/api/stores/:id    — Store detail
  POST /god-admin/api/stores        — Create store
  PUT  /god-admin/api/stores/:id    — Update store
  POST /god-admin/api/stores/:id/suspend
  POST /god-admin/api/stores/:id/activate
  DELETE /god-admin/api/stores/:id  — Soft delete
  GET  /god-admin/api/stores/:id/health — Health score

USERS (C):
  GET  /god-admin/api/users         — List users
  GET  /god-admin/api/users/:id     — User detail
  POST /god-admin/api/users         — Create user
  POST /god-admin/api/users/:id/disable
  POST /god-admin/api/users/:id/enable
  POST /god-admin/api/users/:id/reset-password
  POST /god-admin/api/users/:id/impersonate

SECURITY (H):
  GET  /god-admin/api/audit-log     — Audit entries
  GET  /god-admin/api/logins        — Login history
  GET  /god-admin/api/suspicious    — Suspicious activity
  GET  /god-admin/api/tokens        — API tokens
  POST /god-admin/api/tokens        — Create token
  DELETE /god-admin/api/tokens/:id  — Revoke token

GOD ADMINS:
  GET  /god-admin/api/admins        — List god admins
  POST /god-admin/api/admins        — Create god admin 2
  DELETE /god-admin/api/admins/:id  — Delete god admin 2

AI:
  POST /god-admin/api/ai/chat      — AI platform advisor
```

---

## 9. FILE STRUCTURE

```
apps/god-admin/
├── src/
│   ├── server.ts                    — Express app, route registration
│   ├── middleware/
│   │   ├── god-auth.ts              — Session + role validation
│   │   └── csrf.ts                  — CSRF protection
│   ├── layouts/
│   │   └── god-layout.ts            — Master layout (sidebar + topbar + AI panel)
│   ├── pages/
│   │   ├── login.ts                 — Login page (public)
│   │   ├── dashboard.ts             — A1: Main dashboard
│   │   ├── metrics.ts               — A2: Real-time metrics
│   │   ├── health.ts                — A3: System health
│   │   ├── alerts.ts                — A4: Alert center
│   │   ├── activity.ts              — A5: Activity feed
│   │   ├── stores.ts                — B1-B6: Store management
│   │   ├── users.ts                 — C1-C6: User management
│   │   ├── security.ts              — H1-H4: Security & audit
│   │   ├── admins.ts                — God Admin management
│   │   └── skeleton.ts              — D,E,F,G,I,J,K placeholders
│   ├── ai/
│   │   └── platform-agent.ts        — AI advisor (A6, A7, B7, B8, C7, C8, H5, H6)
│   └── seed/
│       └── god-admin-seed.ts        — Seed default God Admin account
├── package.json
└── tsconfig.json
```

---

## 10. SEED SCRIPT

```typescript
// god-admin-seed.ts
// Run: npx tsx apps/god-admin/src/seed/god-admin-seed.ts

import { getDb } from '@gbox/db'
import { hashPassword } from '@gbox/core/modules/auth/password.js'

const DEFAULT_GOD_ADMIN = {
  email: 'buithai3107@gmail.com',
  password: 'Thaimui@99',
  name: 'Thai Bui',
  role: 'owner',
  status: 'active',
  is_default_admin: true,
}

async function seed() {
  const db = getDb()
  const hash = await hashPassword(DEFAULT_GOD_ADMIN.password)

  // Upsert: create if not exists, update role/status if exists
  await db.insertInto('users')
    .values({
      email: DEFAULT_GOD_ADMIN.email,
      password_hash: hash,
      name: DEFAULT_GOD_ADMIN.name,
      role: DEFAULT_GOD_ADMIN.role,
      status: DEFAULT_GOD_ADMIN.status,
      is_default_admin: true,
    })
    .onConflict(oc => oc.column('email').doUpdateSet({
      role: 'owner',
      status: 'active',
      is_default_admin: true,
    }))
    .execute()

  console.log('Default God Admin seeded:', DEFAULT_GOD_ADMIN.email)
}
```

---

## 11. SECURITY RULES

```
1. Login page: CSRF token required
2. Rate limit: 5 login attempts / minute / IP
3. Password: bcrypt 12 rounds
4. Session: 64-char hex token, SHA-256 hashed in DB
5. Cookie: HttpOnly, Secure (prod), SameSite=Lax
6. Default God Admin: CANNOT be deleted, disabled, or demoted
7. God Admin 2: CAN be deleted by Default only
8. Impersonate: Default only, audit logged, 1-hour session
9. All write operations: audit logged
10. Sensitive data: password_hash, token_hash NEVER in responses
```

---

## 12. TECHNOLOGY STACK

```
- Express.js (server-rendered HTML, same pattern as current)
- Kysely (PostgreSQL ORM)
- bcrypt (password hashing)
- @gbox/core (shared auth, session)
- @gbox/db (database access)
- HTML templates (no React/Vue — server-side rendering)
- CSS variables (dark theme, professional)
- Vanilla JS (charts via simple canvas, no heavy libraries)
- AI: Internal function calling (DB queries → formatted HTML)
```

---

**STATUS: CHO THAI DUYET TRUOC KHI IMPLEMENT**

**Estimated LOC**: ~8,000-10,000 lines
**Estimated files**: ~15 files
**Deploy**: Port 4324, Nginx /god-admin/*
