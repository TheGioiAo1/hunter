# GOD ADMIN PLATFORM — IMPLEMENTATION PLAN
## Chi Tiet Tung Buoc Trien Khai

**Date**: 2026-04-07
**Spec**: docs/superpowers/specs/2026-04-07-god-admin-platform-spec.md
**Status**: APPROVED by Thai Bui

---

## TONG QUAN KE HOACH

```
PHASE 1: FOUNDATION (Nen tang)
  Step 1.1: DB migration — is_default_admin column
  Step 1.2: Seed script — default God Admin account
  Step 1.3: Login page — /god-admin/login (public)
  Step 1.4: Layout system — sidebar + topbar + AI panel (dark theme)
  Step 1.5: Auth middleware — update for isolated login
  Step 1.6: Server.ts — rewrite route registration

PHASE 2: GROUP A — TONG QUAN HE THONG (7 chuc nang)
  Step 2.1: A1 Dashboard — stats, charts, tables
  Step 2.2: A2 Real-time metrics — auto-refresh polling
  Step 2.3: A3 System health — server/DB/service status
  Step 2.4: A4 Alert center — aggregated alerts
  Step 2.5: A5 Activity feed — audit timeline
  Step 2.6: A6+A7 AI Platform Advisor + Anomaly Detection

PHASE 3: GROUP B — QUAN LY STORES (8 chuc nang)
  Step 3.1: B1 Store list — search, filter, pagination
  Step 3.2: B2 Store detail — full info + stats
  Step 3.3: B3 Create store form
  Step 3.4: B4+B5 Suspend/Activate/Delete actions
  Step 3.5: B6 Store health score
  Step 3.6: B7+B8 AI Store Analyst (via AI chat)

PHASE 4: GROUP C — QUAN LY USERS (8 chuc nang)
  Step 4.1: C1 User list — search, filter, pagination
  Step 4.2: C2 User detail — profile + stores + sessions + audit
  Step 4.3: C3 Create user form
  Step 4.4: C4 Disable/Enable (with God Admin protection)
  Step 4.5: C5 Reset password
  Step 4.6: C6 Impersonate (Default God Admin only)
  Step 4.7: C7+C8 AI User Segmentation + Churn (via AI chat)

PHASE 5: GROUP H — BAO MAT & AUDIT (6 chuc nang)
  Step 5.1: H1 Audit log viewer — filter, paginate
  Step 5.2: H2 Login history
  Step 5.3: H3 Suspicious activity detection
  Step 5.4: H4 API token management
  Step 5.5: H5+H6 AI Security Monitor + Compliance (via AI chat)

PHASE 6: GOD ADMIN HIERARCHY
  Step 6.1: Admins page — list God Admins
  Step 6.2: Create God Admin 2
  Step 6.3: Delete God Admin 2 (Default only)

PHASE 7: SKELETON UI (Groups D,E,F,G,I,J,K)
  Step 7.1: skeleton.ts — 7 placeholder pages

PHASE 8: DEPLOY & TEST
  Step 8.1: Commit + push to both remotes
  Step 8.2: Deploy to server (git pull + pm2 restart)
  Step 8.3: Run DB migration + seed
  Step 8.4: E2E test full system
```

---

## PHASE 1: FOUNDATION

### Step 1.1: DB Migration — is_default_admin column

**File**: `packages/db/src/migrations/002_god_admin.ts`

```
What to do:
  - CREATE migration file 002_god_admin.ts
  - ALTER TABLE users ADD COLUMN is_default_admin BOOLEAN DEFAULT FALSE
  - Add unique partial index: only 1 row can have is_default_admin = true

What to verify:
  - Migration runs without error
  - Column exists in users table
  - Existing users have is_default_admin = false
```

**File**: `packages/db/src/schema/tables.ts`

```
What to do:
  - Add is_default_admin: Generated<boolean> to UserTable interface

What to verify:
  - TypeScript compiles without error
```

### Step 1.2: Seed Script — Default God Admin

**File**: `apps/god-admin/src/seed/god-admin-seed.ts`

```
What to do:
  - Import getDb, hashPassword
  - Hash 'Thaimui@99' with bcrypt
  - UPSERT into users:
    email = 'buithai3107@gmail.com'
    name = 'Thai Bui'
    role = 'owner'
    status = 'active'
    is_default_admin = true
  - ON CONFLICT (email): update role, status, is_default_admin
    BUT keep existing password_hash if not null
  - Console log success

What to verify:
  - Script runs: npx tsx apps/god-admin/src/seed/god-admin-seed.ts
  - User exists in DB with correct fields
  - Running again does NOT overwrite password if already set
```

### Step 1.3: Login Page

**File**: `apps/god-admin/src/pages/login.ts`

```
What to do:
  - Export getLogin(req, res, db): render login form
    - Dark theme matching god admin design tokens
    - Logo "GBOX PLATFORM" centered
    - Email + Password fields
    - CSRF hidden input
    - "Sign In" button
    - Error message display
    - Rate limit message display

  - Export postLogin(req, res, db):
    - Validate CSRF token
    - Rate limit check (5/min per IP)
    - getUserByEmail WHERE role = 'owner'
    - If no user or role != 'owner': error "Invalid credentials"
    - verifyPassword(input, user.password_hash)
    - If fail: error "Invalid credentials", audit log: god_admin.login_failed
    - If success:
      - createSession(db, user.id, { ipAddress, userAgent })
      - Set gbox_session cookie
      - Audit log: god_admin.login
      - Redirect to /god-admin

  - Export getLogout(req, res, db):
    - Get session token from cookie
    - deleteSession(db, token)
    - Clear cookie
    - Redirect to /god-admin/login

UI specs:
  - Background: #0f172a (slate-900)
  - Card: #1e293b (slate-800), 400px wide, centered
  - Border radius: 16px
  - Input: #0f172a bg, #334155 border, white text
  - Button: #3b82f6 bg, white text, full width
  - Logo: "GBOX" bold 32px blue + "PLATFORM" 32px white
  - Error: #ef4444 text below form
```

### Step 1.4: Layout System

**File**: `apps/god-admin/src/layouts/god-layout.ts`

```
What to do:
  - REWRITE entire layout with new dark theme design
  - Sidebar (260px):
    - Logo at top
    - 10 navigation groups A-K with icons (SVG)
    - "Admins" section (only visible if is_default_admin)
    - Active page highlight
    - Collapse on mobile (hamburger menu)
  - Topbar (56px):
    - Page title (left)
    - Alert bell icon with count (right)
    - User dropdown: name, email, role badge, logout link
  - Main content area
  - AI Assistant Panel (collapsible, right side, 360px)
    - Toggle button in topbar
    - Chat input + message history
    - Quick action buttons
    - Ctrl+K shortcut

  - CSS: All design tokens from spec section 2.3
  - JS: Sidebar toggle, user dropdown, AI panel, Ctrl+K

Parameters:
  godLayout({
    title: string,
    userName: string,
    userEmail: string,
    isDefaultAdmin: boolean,
    activePage: string,       // 'dashboard' | 'stores' | 'users' | etc
    activeGroup: string,      // 'A' | 'B' | 'C' | etc
    content: string,          // HTML content
    alerts?: number,          // alert badge count
  })
```

### Step 1.5: Auth Middleware Update

**File**: `apps/god-admin/src/middleware/god-auth.ts`

```
What to do:
  - Update middleware to redirect to /god-admin/login (NOT /accounts/login)
  - Add is_default_admin to context:
    interface GodAdminContext {
      user: SessionUser & { is_default_admin: boolean }
      session: SessionData
    }
  - Query is_default_admin from users table after session validation
  - Attach to req.godAdmin

What to verify:
  - Unauthenticated → redirect to /god-admin/login
  - Non-owner → 403
  - Valid owner → req.godAdmin populated with is_default_admin
```

### Step 1.6: Server.ts Rewrite

**File**: `apps/god-admin/src/server.ts`

```
What to do:
  - Register PUBLIC routes (no middleware):
    GET  /god-admin/login  → getLogin
    POST /god-admin/login  → postLogin
    GET  /god-admin/logout → getLogout
    GET  /health           → health check

  - Register PROTECTED routes (with godAuth middleware):
    All routes from spec section 1.3

  - Import all page modules
  - Cookie parser middleware
  - URL-encoded body parser (for forms)
  - JSON body parser (for AI chat)

What to verify:
  - Server starts on port 4324
  - /god-admin/login accessible without auth
  - /god-admin redirects to login if no session
  - /god-admin shows dashboard if valid session
```

---

## PHASE 2: GROUP A — TONG QUAN HE THONG

### Step 2.1: A1 Dashboard

**File**: `apps/god-admin/src/pages/dashboard.ts`

```
What to do:
  - REWRITE dashboard with new layout
  - 8 stat cards in 2 rows of 4:
    Row 1: Revenue, Orders, Stores, Users
    Row 2: AOV, Conversion Rate, Active Sessions, Uptime
  - Revenue chart (7 days, line) — simple SVG/canvas
  - Orders chart (7 days, bar) — simple SVG/canvas
  - Top 5 stores by revenue table
  - Recent 10 orders table
  - Recent 5 users table
  - System info card

  Queries (13 parallel via Promise.all):
    1. SUM(total_price) from orders WHERE created_at > now() - interval
    2. SUM(total_price) from orders WHERE created_at in previous period
    3. COUNT orders current period
    4. COUNT orders previous period
    5. COUNT shops WHERE status = 'active'
    6. COUNT users
    7. COUNT orders WHERE created_at > today
    8. SUM(total_price) WHERE created_at > today
    9. COUNT orders WHERE created_at > yesterday AND < today
    10. SUM(total_price) yesterday
    11. Top 5 stores: shops JOIN orders GROUP BY shop_id ORDER BY revenue DESC LIMIT 5
    12. Recent 10 orders: orders JOIN shops, customers
    13. Recent 5 users
    14. COUNT sessions WHERE expires_at > now()

  Period selector: 7d, 30d, 90d (query param ?period=)
```

### Step 2.2: A2 Real-time Metrics

**File**: `apps/god-admin/src/pages/metrics.ts`

```
What to do:
  - Page with auto-refresh (30s interval via JS fetch)
  - Endpoint: GET /god-admin/api/metrics (JSON)
  - Metrics:
    - Orders in last 60 minutes (minute-by-minute breakdown)
    - Active sessions right now
    - Revenue today vs same time yesterday
    - Last 20 activity entries

  - Display: Live-updating cards + mini sparkline charts
  - JS: setInterval → fetch → update DOM
```

### Step 2.3: A3 System Health

**File**: `apps/god-admin/src/pages/health.ts`

```
What to do:
  - Server metrics: process.memoryUsage(), os.cpuUsage(), os.totalmem(), os.freemem()
  - Disk: child_process exec 'df -h /' (Linux)
  - DB pool: connection count, idle count
  - Service status: HTTP GET each port (4321, 4323, 4324, 4325)
    - Status: UP/DOWN, response time
  - DB metrics: pg_stat_activity count, estimated table sizes
  - Display as gauge cards + service table
```

### Step 2.4: A4 Alert Center

**File**: `apps/god-admin/src/pages/alerts.ts`

```
What to do:
  - Aggregate alerts from multiple sources:
    a. Low stock: products JOIN product_variants WHERE inventory_quantity < 5
    b. Payment failures: transactions WHERE status = 'failure' AND created_at > now()-24h
    c. Security: COUNT failed logins > 10/hour (from audit_logs)
    d. Inactive stores: shops with 0 orders in 7 days
    e. System: memory/CPU thresholds
  - Display as card list with severity badge (critical/warning/info)
  - Each alert: icon, title, description, timestamp, action button
```

### Step 2.5: A5 Activity Feed

**File**: `apps/god-admin/src/pages/activity.ts`

```
What to do:
  - Query audit_logs JOIN users ORDER BY created_at DESC LIMIT 50
  - Display as timeline (vertical line with dots)
  - Each entry: icon (based on action), user name/email, action description, timestamp
  - Filter: action type dropdown, user dropdown, date range
  - Auto-format action strings:
    'god_admin.login' → "Thai Bui logged into God Admin"
    'store.suspended' → "Admin suspended store Fashion Hub"
    'user.disabled' → "Admin disabled user merchant@..."
```

### Step 2.6: A6+A7 AI Platform Advisor + Anomaly Detection

**File**: `apps/god-admin/src/ai/platform-agent.ts`

```
What to do:
  - POST /god-admin/ai/chat handler
  - Accept: { message, context }
  - Intent detection (keyword matching, English + Vietnamese):
    - revenue/doanh thu → analyzePlatformRevenue()
    - store/cua hang → analyzeStores()
    - user/nguoi dung → analyzeUsers()
    - order/don hang → analyzeOrders()
    - health/suc khoe → systemHealthCheck()
    - anomaly/bat thuong → detectAnomalies()
    - recommend/goi y → generateRecommendations()
    - security/bao mat → securityAnalysis()

  - Each function:
    - Queries DB for relevant data
    - Formats response as rich HTML (cards, tables, badges)
    - Returns { html, suggested_actions[] }

  - Functions detail:
    analyzePlatformRevenue(period):
      - Total revenue current vs previous
      - Top 5 stores by revenue
      - Revenue trend (daily for period)
      - AI insight: growth/decline reasons

    analyzeStores():
      - Total active/suspended/new
      - Stores with 0 orders (last 7 days)
      - Top performing vs underperforming
      - Recommendations

    detectAnomalies():
      - Orders per store per hour vs 7-day avg
      - Revenue spikes/drops > 30%
      - Login attempt spikes
      - New account registration spikes

  - Response format: HTML with stat cards, tables, colored badges
  - Quick actions: preset buttons in AI panel
    "Platform overview", "Revenue this week", "Problem stores",
    "User activity", "Security check", "System health"
```

---

## PHASE 3: GROUP B — QUAN LY STORES

### Step 3.1: B1 Store List

**File**: `apps/god-admin/src/pages/stores.ts` — getStores()

```
  - Query: shops LEFT JOIN orders aggregate (revenue, order_count)
  - Search: name/slug/email ilike
  - Filters: status dropdown, plan dropdown
  - Sort: name, created_at, revenue (query param ?sort=)
  - Pagination: 20/page
  - Display: table with store name (link), slug, plan badge, status badge, revenue, order count
  - Button: "+ Create Store"
```

### Step 3.2: B2 Store Detail

**File**: `apps/god-admin/src/pages/stores.ts` — getStoreDetail()

```
  - 4 stat cards: revenue, orders, products, customers
  - Store info card: name, slug, email, phone, address, plan, currency, timezone, created_at
  - Staff card: user_shops JOIN users (role per user)
  - Top products: products JOIN order_line_items (top 10 by quantity)
  - Recent orders: orders (last 10)
  - Actions: [Suspend] [Reactivate] [Delete] buttons (with confirm)
```

### Step 3.3: B3 Create Store

**File**: `apps/god-admin/src/pages/stores.ts` — getCreateStore(), postCreateStore()

```
  - Form: name, slug (auto-generate from name), email, currency (dropdown), timezone (dropdown), plan (dropdown)
  - POST: INSERT into shops, redirect to store detail
  - Audit log: store.created
```

### Step 3.4: B4+B5 Suspend/Activate/Delete

**File**: `apps/god-admin/src/pages/stores.ts` — postSuspend(), postActivate(), postDelete()

```
  - Suspend: UPDATE shops SET status = 'suspended', audit log
  - Activate: UPDATE shops SET status = 'active', audit log
  - Delete: confirm dialog (type slug), UPDATE status = 'deleted', audit log
  - All: redirect back to store detail (or list if deleted)
```

### Step 3.5: B6 Store Health Score

**File**: `apps/god-admin/src/pages/stores.ts` — getStoreHealth()

```
  - Score 0-100, 5 categories (20 pts each):
    1. Products: count + has images + has descriptions
    2. Orders: orders last 7 days count
    3. Customers: returning %, marketing opt-in %
    4. Content: has about page, has shipping policy, has refund policy
    5. Technical: has domain, has shipping zones, complete settings
  - Display: circular score + breakdown bars + recommendations
```

### Step 3.6: B7+B8 AI Store Analyst

```
  Handled by platform-agent.ts:
  - User asks about specific store → query that store's data
  - Generate analysis + recommendations
  - (No separate page — uses AI chat panel)
```

---

## PHASE 4: GROUP C — QUAN LY USERS

### Step 4.1: C1 User List

**File**: `apps/god-admin/src/pages/users.ts` — getUsers()

```
  - Query: users LEFT JOIN user_shops (count), LEFT JOIN sessions (last login)
  - Search: email/name ilike
  - Filters: role, status
  - Pagination: 20/page
  - Display: email, name, role badge, status badge, store count, last login, created
  - God Admin badge: special gold badge for role='owner'
  - Default badge: crown icon for is_default_admin
  - Button: "+ Create User"
```

### Step 4.2: C2 User Detail

**File**: `apps/god-admin/src/pages/users.ts` — getUserDetail()

```
  - Profile card: all user fields
  - Stores card: user_shops JOIN shops (role per store)
  - Active sessions: sessions WHERE user_id (last 10)
  - Audit log: audit_logs WHERE user_id (last 20)
  - Actions: [Disable] [Enable] [Reset Password] [Impersonate]
  - Protection: Default God Admin shows "Protected" instead of action buttons
```

### Step 4.3: C3 Create User

**File**: `apps/god-admin/src/pages/users.ts` — getCreateUser(), postCreateUser()

```
  - Form: email, name, role (staff/admin), password (input or auto-generate button)
  - POST: hash password, INSERT users, audit log
  - Option: assign to store(s) immediately
  - Redirect to user detail
```

### Step 4.4: C4 Disable/Enable

**File**: `apps/god-admin/src/pages/users.ts` — postDisable(), postEnable()

```
  - Disable: check NOT is_default_admin, UPDATE status='disabled', kill sessions, audit log
  - Enable: UPDATE status='active', audit log
  - God Admin 2: CAN be disabled by Default, CANNOT be disabled by other God Admin 2
```

### Step 4.5: C5 Reset Password

**File**: `apps/god-admin/src/pages/users.ts` — postResetPassword()

```
  - Generate random 16-char password
  - Hash with bcrypt
  - UPDATE users SET password_hash
  - Kill all sessions for that user
  - Display new password ONCE in success flash message
  - Audit log: user.password_reset
```

### Step 4.6: C6 Impersonate

**File**: `apps/god-admin/src/pages/users.ts` — postImpersonate()

```
  ONLY if req.godAdmin.user.is_default_admin === true:
  - Cannot impersonate other God Admins (role='owner')
  - Create session for target user (1-hour expiry)
  - Set gbox_session cookie with new session
  - Audit log: user.impersonated { by: god_admin_id, target: user_id }
  - Redirect to /accounts/stores
  - (Future: show impersonation banner)
```

### Step 4.7: C7+C8 AI User Segmentation + Churn

```
  Handled by platform-agent.ts:
  - Segmentation query: group users by behavior metrics
  - Churn: analyze login frequency, order trends, support tickets
  - (Uses AI chat panel)
```

---

## PHASE 5: GROUP H — BAO MAT & AUDIT

### Step 5.1: H1 Audit Log Viewer

**File**: `apps/god-admin/src/pages/security.ts` — getAuditLog()

```
  - Query: audit_logs JOIN users ORDER BY created_at DESC
  - Filters: action (dropdown of distinct), user_id, date range
  - Pagination: 50/page
  - Display: timestamp, user email, action, resource_type:resource_id, IP, details (expandable)
  - Color code by action type (green=create, blue=update, red=delete, yellow=auth)
```

### Step 5.2: H2 Login History

**File**: `apps/god-admin/src/pages/security.ts` — getLoginHistory()

```
  - Query: audit_logs WHERE action LIKE '%login%'
  - Display: timestamp, email, action (login/login_failed), IP, user_agent
  - Failed logins highlighted red
  - Group by IP: show count of attempts per IP
```

### Step 5.3: H3 Suspicious Activity

**File**: `apps/god-admin/src/pages/security.ts` — getSuspicious()

```
  Auto-detect:
  - IPs with >10 failed logins in 1 hour
  - Users with login from >3 different IPs in 1 hour
  - Bulk operations: >50 write actions in 1 hour by single user
  - API tokens used from new IP (never seen before for that token)

  Display: alert cards with severity, explanation, recommended action
```

### Step 5.4: H4 API Token Management

**File**: `apps/god-admin/src/pages/security.ts` — getTokens(), postCreateToken(), postRevokeToken()

```
  - List: api_tokens JOIN users, shops
  - Display: label, user email, shop name, scopes, last_used, created
  - Create form: user_id, shop_id, label, scopes checkboxes
  - Revoke: DELETE api_tokens WHERE id, audit log
```

### Step 5.5: H5+H6 AI Security + Compliance

```
  Handled by platform-agent.ts:
  - Security: analyze failed logins, IP patterns, session anomalies
  - Compliance: check stores for policy pages, verified emails, tax settings
  - (Uses AI chat panel)
```

---

## PHASE 6: GOD ADMIN HIERARCHY

### Step 6.1: Admins Page

**File**: `apps/god-admin/src/pages/admins.ts` — getAdmins()

```
  ONLY VISIBLE if req.godAdmin.user.is_default_admin === true
  - Query: users WHERE role = 'owner'
  - Display: email, name, is_default badge, created_at
  - Default God Admin: crown icon, "Default — Cannot be removed"
  - God Admin 2: [Delete] button
  - Button: "+ Create God Admin"
```

### Step 6.2: Create God Admin 2

**File**: `apps/god-admin/src/pages/admins.ts` — getCreateAdmin(), postCreateAdmin()

```
  ONLY if is_default_admin:
  - Form: email, name, password
  - POST: hash password, INSERT users with role='owner', is_default_admin=false
  - Audit log: god_admin.created
  - Redirect to admins list
```

### Step 6.3: Delete God Admin 2

**File**: `apps/god-admin/src/pages/admins.ts` — postDeleteAdmin()

```
  ONLY if is_default_admin:
  - Cannot delete self (is_default_admin = true)
  - DELETE users WHERE id AND role='owner' AND is_default_admin = false
  - Kill all sessions for that user
  - Audit log: god_admin.deleted
  - Redirect to admins list
```

---

## PHASE 7: SKELETON UI

### Step 7.1: Placeholder Pages

**File**: `apps/god-admin/src/pages/skeleton.ts`

```
  Export function for each group:
  - getOrders(req, res) → "Order Management — Coming in Phase 2"
  - getOrderAnalytics(req, res)
  - getFulfillments(req, res) → "Fulfillment Center — Coming in Phase 2"
  - getFinance(req, res) → "Financial Dashboard — Coming in Phase 2"
  - getFinanceTransactions(req, res)
  - getStaff(req, res) → "Staff Management — Coming in Phase 2"
  - getAIAgents(req, res) → "AI Agents — Coming in Phase 2"
  - getContent(req, res) → "Content & Marketing — Coming in Phase 2"
  - getCampaigns(req, res)
  - getConfig(req, res) → "Platform Configuration — Coming in Phase 2"
  - getDeveloper(req, res) → "Developer Hub — Coming in Phase 2"
  - getWebhooks(req, res)
  - getApps(req, res)

  Each: uses godLayout with correct activePage/activeGroup
  Card content: icon + title + description + "This feature is under development"
  Consistent look across all placeholders
```

---

## PHASE 8: DEPLOY & TEST

### Step 8.1: Commit

```bash
git add apps/god-admin/ packages/db/
git commit -m "feat: God Admin Platform — complete rebuild with 29 functions + AI"
git push origin master && git push org master
```

### Step 8.2: Deploy

```bash
ssh botesty@192.168.1.13
cd /home/botesty/gbox-platform
git pull origin master
npx tsx packages/db/src/migrations/run.ts    # Run migration 002
npx tsx apps/god-admin/src/seed/god-admin-seed.ts  # Seed default admin
pm2 restart gbox-god-admin
```

### Step 8.3: E2E Test Script

```
Test 1: Login page accessible
  GET /god-admin/login → 200

Test 2: Protected routes redirect
  GET /god-admin → 302 to /god-admin/login

Test 3: Login with default credentials
  POST /god-admin/login (buithai3107@gmail.com / Thaimui@99) → 302 to /god-admin

Test 4: Dashboard loads
  GET /god-admin → 200, contains "Dashboard"

Test 5: All Group A pages
  GET /god-admin/metrics → 200
  GET /god-admin/health → 200
  GET /god-admin/alerts → 200
  GET /god-admin/activity → 200

Test 6: All Group B pages
  GET /god-admin/stores → 200
  GET /god-admin/stores/:id → 200

Test 7: All Group C pages
  GET /god-admin/users → 200
  GET /god-admin/users/:id → 200

Test 8: All Group H pages
  GET /god-admin/security → 200
  GET /god-admin/security/logins → 200
  GET /god-admin/security/suspicious → 200
  GET /god-admin/security/tokens → 200

Test 9: God Admin hierarchy
  GET /god-admin/admins → 200

Test 10: All skeleton pages
  GET /god-admin/orders → 200
  GET /god-admin/fulfillments → 200
  GET /god-admin/finance → 200
  GET /god-admin/staff → 200
  GET /god-admin/content → 200
  GET /god-admin/config → 200
  GET /god-admin/developer → 200

Test 11: AI chat
  POST /god-admin/ai/chat { message: "Platform overview" } → 200 + html

Test 12: Logout
  GET /god-admin/logout → 302 to /god-admin/login

Test 13: Non-owner rejected
  Login as non-owner user → 403
```

---

## PARALLEL EXECUTION STRATEGY

```
Cac buoc co the chay song song (parallel agents):

PHASE 1 (sequential — foundation phai xong truoc):
  1.1 → 1.2 → 1.3 + 1.4 + 1.5 (parallel) → 1.6

PHASE 2 (parallel sau khi foundation xong):
  Agent 1: 2.1 (dashboard) + 2.2 (metrics) + 2.3 (health)
  Agent 2: 2.4 (alerts) + 2.5 (activity)
  Agent 3: 2.6 (AI agent)

PHASE 3 (parallel):
  Agent 1: 3.1 (list) + 3.2 (detail) + 3.5 (health score)
  Agent 2: 3.3 (create) + 3.4 (suspend/delete)

PHASE 4 (parallel):
  Agent 1: 4.1 (list) + 4.2 (detail)
  Agent 2: 4.3 (create) + 4.4 (disable) + 4.5 (reset pw)
  Agent 3: 4.6 (impersonate)

PHASE 5 (parallel):
  Agent 1: 5.1 (audit) + 5.2 (logins)
  Agent 2: 5.3 (suspicious) + 5.4 (tokens)

PHASE 6 + 7 (parallel):
  Agent 1: 6.1 + 6.2 + 6.3 (admins)
  Agent 2: 7.1 (skeleton pages)

PHASE 8 (sequential):
  8.1 → 8.2 → 8.3 → 8.4
```

---

## FILE DELIVERABLES

```
MODIFIED:
  packages/db/src/schema/tables.ts          — Add is_default_admin
  packages/db/src/migrations/run.ts         — Register migration 002

NEW:
  packages/db/src/migrations/002_god_admin.ts   — Migration
  apps/god-admin/src/seed/god-admin-seed.ts     — Seed script
  apps/god-admin/src/pages/login.ts             — Login page
  apps/god-admin/src/pages/dashboard.ts         — A1 Dashboard (rewrite)
  apps/god-admin/src/pages/metrics.ts           — A2 Real-time metrics
  apps/god-admin/src/pages/health.ts            — A3 System health
  apps/god-admin/src/pages/alerts.ts            — A4 Alert center
  apps/god-admin/src/pages/activity.ts          — A5 Activity feed
  apps/god-admin/src/pages/stores.ts            — B1-B6 (rewrite)
  apps/god-admin/src/pages/users.ts             — C1-C6 (rewrite)
  apps/god-admin/src/pages/security.ts          — H1-H4 (rewrite)
  apps/god-admin/src/pages/admins.ts            — God Admin hierarchy
  apps/god-admin/src/pages/skeleton.ts          — Placeholder pages
  apps/god-admin/src/ai/platform-agent.ts       — AI advisor
  apps/god-admin/src/layouts/god-layout.ts      — Layout (rewrite)
  apps/god-admin/src/middleware/god-auth.ts      — Auth middleware (update)
  apps/god-admin/src/server.ts                  — Server (rewrite)

TOTAL: ~17 files, estimated 8,000-10,000 LOC
```

---

**STATUS: PLAN HOAN THANH — SAN SANG IMPLEMENT**
**CHO THAI DUYET PLAN TRUOC KHI BAT DAU BUILD**
