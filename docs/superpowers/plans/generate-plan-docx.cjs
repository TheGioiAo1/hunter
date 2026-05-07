const fs = require("fs");
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  Header, Footer, AlignmentType, HeadingLevel, BorderStyle, WidthType,
  ShadingType, PageNumber, PageBreak, LevelFormat,
} = require("docx");

const C = {
  primary: "1B4F72", accent: "2E86C1", dark: "1A5276",
  white: "FFFFFF", gray: "5D6D7E", grayLight: "F2F3F4",
  border: "BDC3C7", red: "E74C3C", green: "27AE60", orange: "F39C12",
  slate900: "0F172A", slate800: "1E293B", slate700: "334155",
  blue500: "3B82F6",
};

const border = { style: BorderStyle.SINGLE, size: 1, color: C.border };
const borders = { top: border, bottom: border, left: border, right: border };
const cellM = { top: 60, bottom: 60, left: 100, right: 100 };

function h1(text) {
  return new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { before: 360, after: 200 }, children: [new TextRun({ text, bold: true })] });
}
function h2(text) {
  return new Paragraph({ heading: HeadingLevel.HEADING_2, spacing: { before: 280, after: 160 }, children: [new TextRun({ text, bold: true })] });
}
function h3(text) {
  return new Paragraph({ heading: HeadingLevel.HEADING_3, spacing: { before: 200, after: 120 }, children: [new TextRun({ text, bold: true })] });
}
function p(text, opts = {}) {
  return new Paragraph({ spacing: { after: 100 }, children: [new TextRun({ text, size: 22, font: "Arial", ...opts })] });
}
function pBold(text, color) {
  return new Paragraph({ spacing: { after: 100 }, children: [new TextRun({ text, size: 22, font: "Arial", bold: true, color })] });
}
function code(lines) {
  return lines.map(line => new Paragraph({
    spacing: { after: 20 },
    shading: { fill: "F0F4F8", type: ShadingType.CLEAR },
    indent: { left: 200 },
    children: [new TextRun({ text: line, font: "Consolas", size: 18, color: "2C3E50" })],
  }));
}
function bullet(text, bold = false) {
  return new Paragraph({
    numbering: { reference: "bullets", level: 0 },
    spacing: { after: 60 },
    children: [new TextRun({ text, size: 22, font: "Arial", bold })],
  });
}
function numItem(text) {
  return new Paragraph({
    numbering: { reference: "numbers", level: 0 },
    spacing: { after: 60 },
    children: [new TextRun({ text, size: 22, font: "Arial" })],
  });
}
function makeTable(headers, rows, colWidths) {
  const tw = colWidths.reduce((a, b) => a + b, 0);
  return new Table({
    width: { size: tw, type: WidthType.DXA },
    columnWidths: colWidths,
    rows: [
      new TableRow({ tableHeader: true, children: headers.map((h, i) =>
        new TableCell({ borders, width: { size: colWidths[i], type: WidthType.DXA },
          shading: { fill: C.primary, type: ShadingType.CLEAR }, margins: cellM,
          children: [new Paragraph({ children: [new TextRun({ text: h, bold: true, color: C.white, size: 20, font: "Arial" })] })] })) }),
      ...rows.map(row => new TableRow({ children: row.map((c, i) =>
        new TableCell({ borders, width: { size: colWidths[i], type: WidthType.DXA }, margins: cellM,
          children: [new Paragraph({ children: [new TextRun({ text: c, size: 20, font: "Arial" })] })] })) })),
    ],
  });
}

function stepBlock(stepNum, title, file, whatToDo, whatToVerify) {
  const items = [];
  items.push(h3(`Step ${stepNum}: ${title}`));
  if (file) items.push(pBold(`File: ${file}`, C.accent));
  items.push(pBold("What to do:", C.dark));
  whatToDo.forEach(t => items.push(bullet(t)));
  if (whatToVerify && whatToVerify.length > 0) {
    items.push(pBold("Verify:", C.green));
    whatToVerify.forEach(t => items.push(bullet(t)));
  }
  return items;
}

const doc = new Document({
  styles: {
    default: { document: { run: { font: "Arial", size: 22 } } },
    paragraphStyles: [
      { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 36, bold: true, font: "Arial", color: C.primary },
        paragraph: { spacing: { before: 360, after: 200 }, outlineLevel: 0 } },
      { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 30, bold: true, font: "Arial", color: C.dark },
        paragraph: { spacing: { before: 280, after: 160 }, outlineLevel: 1 } },
      { id: "Heading3", name: "Heading 3", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 26, bold: true, font: "Arial", color: C.accent },
        paragraph: { spacing: { before: 200, after: 120 }, outlineLevel: 2 } },
    ],
  },
  numbering: {
    config: [
      { reference: "bullets", levels: [{ level: 0, format: LevelFormat.BULLET, text: "\u2022", alignment: AlignmentType.LEFT,
        style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] },
      { reference: "numbers", levels: [{ level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.LEFT,
        style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] },
    ],
  },
  sections: [
    // COVER PAGE
    {
      properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } } },
      children: [
        new Paragraph({ spacing: { before: 2500 } }),
        new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 200 },
          children: [new TextRun({ text: "GBOX PLATFORM", size: 60, bold: true, font: "Arial", color: C.primary })] }),
        new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 100 },
          children: [new TextRun({ text: "GOD ADMIN PLATFORM", size: 48, bold: true, font: "Arial", color: C.accent })] }),
        new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 400 },
          children: [new TextRun({ text: "IMPLEMENTATION PLAN", size: 40, bold: true, font: "Arial", color: C.slate700 })] }),
        new Paragraph({ alignment: AlignmentType.CENTER,
          border: { top: { style: BorderStyle.SINGLE, size: 3, color: C.accent, space: 10 } },
          spacing: { before: 200, after: 80 },
          children: [new TextRun({ text: "Chi Tiet Tung Buoc Trien Khai", size: 28, italics: true, color: C.gray })] }),
        new Paragraph({ alignment: AlignmentType.CENTER,
          children: [new TextRun({ text: "He Thong Quan Tri Gbox Chuyen Nghiep", size: 24, color: C.gray })] }),
        new Paragraph({ spacing: { before: 800 } }),
        new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: "Date: 2026-04-07", size: 24, color: C.gray })] }),
        new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: "Status: APPROVED by Thai Bui", size: 24, bold: true, color: C.green })] }),
        new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 60 },
          children: [new TextRun({ text: "Estimated: 17 files, 8,000-10,000 LOC", size: 22, color: C.gray })] }),
        new Paragraph({ spacing: { before: 1500 } }),
        new Paragraph({ alignment: AlignmentType.CENTER,
          children: [new TextRun({ text: "CONFIDENTIAL", size: 20, bold: true, color: C.red, allCaps: true })] }),
      ],
    },
    // MAIN CONTENT
    {
      properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: 1440, right: 1200, bottom: 1440, left: 1200 } } },
      headers: { default: new Header({ children: [new Paragraph({ alignment: AlignmentType.RIGHT,
        children: [new TextRun({ text: "God Admin Platform \u2014 Implementation Plan", size: 16, color: C.gray, italics: true })] })] }) },
      footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER,
        children: [new TextRun({ text: "Page ", size: 18, color: C.gray }), new TextRun({ children: [PageNumber.CURRENT], size: 18, color: C.gray })] })] }) },
      children: [
        // OVERVIEW TABLE
        h1("TONG QUAN KE HOACH"),
        p("8 Phases, 38 Steps, 17 files, estimated 8,000-10,000 LOC"),
        makeTable(
          ["Phase", "Noi dung", "Steps", "Parallel"],
          [
            ["1. Foundation", "DB migration, seed, login, layout, auth, server", "6", "1.3+1.4+1.5 parallel"],
            ["2. Group A", "Dashboard, metrics, health, alerts, activity, AI", "6", "3 agents parallel"],
            ["3. Group B", "Store list/detail/create/suspend/delete/health/AI", "6", "2 agents parallel"],
            ["4. Group C", "User list/detail/create/disable/reset/impersonate/AI", "7", "3 agents parallel"],
            ["5. Group H", "Audit log, logins, suspicious, tokens, AI security", "5", "2 agents parallel"],
            ["6. Hierarchy", "Admin list, create admin 2, delete admin 2", "3", "Sequential"],
            ["7. Skeleton", "7 placeholder pages (D,E,F,G,I,J,K)", "1", "Parallel with Phase 6"],
            ["8. Deploy", "Commit, push, deploy, migrate, seed, E2E (13 tests)", "4", "Sequential"],
          ],
          [1400, 4200, 800, 2960]
        ),

        new Paragraph({ children: [new PageBreak()] }),

        // PHASE 1
        h1("PHASE 1: FOUNDATION (Nen Tang)"),
        p("Tat ca phases sau deu phu thuoc vao Phase 1. Phai hoan thanh day du truoc khi tiep tuc."),

        ...stepBlock("1.1", "DB Migration \u2014 is_default_admin column",
          "packages/db/src/migrations/002_god_admin.ts",
          [
            "CREATE migration file 002_god_admin.ts",
            "ALTER TABLE users ADD COLUMN is_default_admin BOOLEAN DEFAULT FALSE",
            "Add unique partial index: only 1 row can have is_default_admin = true",
            "Update packages/db/src/schema/tables.ts: add is_default_admin to UserTable",
          ],
          ["Migration runs without error", "Column exists in users table", "TypeScript compiles"]),

        ...stepBlock("1.2", "Seed Script \u2014 Default God Admin",
          "apps/god-admin/src/seed/god-admin-seed.ts",
          [
            "Import getDb from @gbox/db, hashPassword from @gbox/core",
            "Hash password 'Thaimui@99' with bcrypt (12 rounds)",
            "UPSERT into users: email=buithai3107@gmail.com, name=Thai Bui, role=owner, is_default_admin=true",
            "ON CONFLICT: update role/status/is_default_admin, keep existing password_hash if not null",
            "Console log success message",
          ],
          ["Script runs: npx tsx apps/god-admin/src/seed/god-admin-seed.ts", "User exists in DB with correct fields", "Running again does NOT overwrite existing password"]),

        ...stepBlock("1.3", "Login Page (Public)",
          "apps/god-admin/src/pages/login.ts",
          [
            "getLogin(): render dark-theme login form (slate-900 bg, slate-800 card, 400px centered)",
            "Logo: 'GBOX' bold blue + 'PLATFORM' white, 32px",
            "Fields: email + password + CSRF hidden input",
            "Button: blue-500, full width, 'Sign In to God Admin'",
            "Error display: red text below form",
            "postLogin(): validate CSRF, rate limit (5/min/IP), find user WHERE role='owner'",
            "Verify password with bcrypt, create session, set gbox_session cookie",
            "Audit log: god_admin.login or god_admin.login_failed",
            "Redirect to /god-admin on success",
            "getLogout(): delete session, clear cookie, redirect to /god-admin/login",
          ],
          ["Login page renders at /god-admin/login", "Wrong credentials show error", "Correct credentials redirect to /god-admin", "Logout clears session"]),

        ...stepBlock("1.4", "Layout System (Dark Theme Enterprise)",
          "apps/god-admin/src/layouts/god-layout.ts",
          [
            "REWRITE entire layout with dark theme design tokens",
            "Sidebar 260px: logo, 10 nav groups A-K with SVG icons, 'Admins' section (only if is_default_admin)",
            "Topbar 56px: page title (left), alert bell + user dropdown + logout (right)",
            "Main content area with padding 24px",
            "AI Assistant Panel: collapsible right side (360px), chat input, message history, quick actions",
            "CSS variables: --god-bg: #0f172a, --god-sidebar: #1e293b, --god-accent: #3b82f6, etc",
            "JS: sidebar toggle (mobile), user dropdown, AI panel toggle, Ctrl+K shortcut",
            "Responsive: sidebar collapses on < 768px",
          ],
          ["Layout renders correctly with all sections", "Sidebar navigation works", "AI panel toggles", "Mobile responsive"]),

        ...stepBlock("1.5", "Auth Middleware Update",
          "apps/god-admin/src/middleware/god-auth.ts",
          [
            "Change redirect from /accounts/login to /god-admin/login",
            "After session validation, query is_default_admin from users table",
            "Attach to req.godAdmin.user.is_default_admin",
            "Keep role='owner' check (403 for non-owners)",
          ],
          ["Unauthenticated requests redirect to /god-admin/login", "Non-owner gets 403", "req.godAdmin has is_default_admin field"]),

        ...stepBlock("1.6", "Server.ts Rewrite",
          "apps/god-admin/src/server.ts",
          [
            "Register PUBLIC routes (no middleware): login, logout, health",
            "Register PROTECTED routes (with godAuth): all 30+ routes from spec",
            "Import all page modules (login, dashboard, metrics, health, alerts, activity, stores, users, security, admins, skeleton)",
            "Cookie parser, URL-encoded body parser, JSON body parser",
            "AI chat endpoint: POST /god-admin/ai/chat",
          ],
          ["Server starts on port 4324", "/god-admin/login works without auth", "Protected routes require auth"]),

        new Paragraph({ children: [new PageBreak()] }),

        // PHASE 2
        h1("PHASE 2: GROUP A \u2014 TONG QUAN HE THONG (7 chuc nang)"),
        p("Co the chay 3 agents song song sau khi Phase 1 hoan thanh."),

        ...stepBlock("2.1", "A1 Dashboard Tong",
          "apps/god-admin/src/pages/dashboard.ts",
          [
            "8 stat cards (2 rows x 4): Revenue, Orders, Stores, Users, AOV, Conv Rate, Sessions, Uptime",
            "Period selector: 7d/30d/90d via query param",
            "Revenue chart (line) + Orders chart (bar) \u2014 simple inline SVG",
            "Top 5 stores by revenue table",
            "Recent 10 orders table (with store name, customer, status badges)",
            "Recent 5 users table",
            "System info card (Node version, memory, uptime)",
            "13 parallel DB queries via Promise.all()",
            "All numbers with % change vs previous period",
          ],
          ["Dashboard loads with real data", "Period selector changes data", "Tables show correct data"]),

        ...stepBlock("2.2", "A2 Real-time Metrics",
          "apps/god-admin/src/pages/metrics.ts",
          [
            "Auto-refresh page (30s interval via JS setInterval + fetch)",
            "JSON endpoint: GET /god-admin/api/metrics",
            "Metrics: orders last 60 min (per-minute), active sessions, revenue today vs yesterday",
            "Last 20 activity entries (live feed)",
            "Display: live-updating stat cards + sparkline mini-charts",
          ],
          ["Page auto-refreshes without reload", "Data updates every 30s"]),

        ...stepBlock("2.3", "A3 System Health",
          "apps/god-admin/src/pages/health.ts",
          [
            "Server: process.memoryUsage(), os.cpuUsage(), os.totalmem(), os.freemem()",
            "Disk: child_process exec 'df -h /' on Linux",
            "DB pool: connection stats from Kysely/pg pool",
            "Service status: HTTP GET to ports 4321, 4323, 4324, 4325 with timing",
            "DB metrics: active connections, table sizes estimate",
            "Display: gauge-style cards + service status table",
          ],
          ["All 4 service statuses shown", "Memory/CPU values are real", "DB pool info accurate"]),

        ...stepBlock("2.4", "A4 Alert Center",
          "apps/god-admin/src/pages/alerts.ts",
          [
            "Aggregate alerts from: low stock products, payment failures (24h), failed logins (>10/hr), inactive stores (0 orders 7d), system thresholds",
            "Display: card list with severity badge (critical=red, warning=orange, info=blue)",
            "Each alert: icon, title, description, timestamp, action button",
            "Sort by severity then timestamp",
          ],
          ["Alerts appear for known conditions", "Severity badges correct"]),

        ...stepBlock("2.5", "A5 Activity Feed",
          "apps/god-admin/src/pages/activity.ts",
          [
            "Query audit_logs JOIN users ORDER BY created_at DESC LIMIT 50",
            "Display as vertical timeline with action icons",
            "Auto-format actions to human-readable text",
            "Filters: action type dropdown, user dropdown, date range",
          ],
          ["Timeline shows real audit entries", "Filters work correctly"]),

        ...stepBlock("2.6", "A6+A7 AI Platform Advisor + Anomaly Detection",
          "apps/god-admin/src/ai/platform-agent.ts",
          [
            "POST /god-admin/ai/chat endpoint",
            "Accept: { message, context }",
            "Intent detection via keyword matching (English + Vietnamese)",
            "8 AI functions: analyzePlatformRevenue, analyzeStores, analyzeUsers, analyzeOrders, systemHealthCheck, detectAnomalies, generateRecommendations, securityAnalysis",
            "Each function: query DB, compute metrics, format as rich HTML (stat cards, tables, badges)",
            "Return: { html, suggested_actions[] }",
            "Quick action buttons: 'Platform overview', 'Revenue this week', 'Problem stores', etc",
            "Anomaly detection: orders/hour vs 7d avg (>5x = anomaly), revenue spikes >30%, login spikes",
          ],
          ["AI responds to 'platform overview'", "AI responds to 'revenue analysis'", "Anomaly detection finds test data"]),

        new Paragraph({ children: [new PageBreak()] }),

        // PHASE 3
        h1("PHASE 3: GROUP B \u2014 QUAN LY STORES (8 chuc nang)"),

        ...stepBlock("3.1", "B1 Store List",
          "apps/god-admin/src/pages/stores.ts \u2014 getStores()",
          [
            "Query: shops LEFT JOIN orders (SUM revenue, COUNT orders)",
            "Search: name/slug/email ilike",
            "Filters: status dropdown, plan dropdown",
            "Sort: name, created_at, revenue (via ?sort= param)",
            "Pagination: 20/page",
            "Table: store name (link), slug, plan badge, status badge, revenue, order count",
            "Button: '+ Create Store'",
          ],
          ["List shows all stores", "Search works", "Filters work", "Pagination works"]),

        ...stepBlock("3.2", "B2 Store Detail",
          "apps/god-admin/src/pages/stores.ts \u2014 getStoreDetail()",
          [
            "4 stat cards: revenue, orders, products, customers (for this store)",
            "Store info card: name, slug, email, phone, address, plan, currency, timezone, dates",
            "Staff card: user_shops JOIN users (role per user)",
            "Top 10 products by order quantity",
            "Recent 10 orders",
            "Action buttons: [Suspend] [Reactivate] [Delete] with confirm dialogs",
          ],
          ["Detail shows correct store data", "Staff list accurate", "Actions work"]),

        ...stepBlock("3.3", "B3 Create Store",
          "apps/god-admin/src/pages/stores.ts \u2014 getCreateStore(), postCreateStore()",
          [
            "Form: name (required), slug (auto-generate from name), email, currency dropdown, timezone dropdown, plan dropdown",
            "POST: INSERT into shops, audit log: store.created",
            "Redirect to new store detail page",
          ],
          ["Store created successfully", "Slug auto-generated", "Appears in store list"]),

        ...stepBlock("3.4", "B4+B5 Suspend / Activate / Delete",
          "apps/god-admin/src/pages/stores.ts",
          [
            "postSuspend(): UPDATE shops SET status='suspended', audit log",
            "postActivate(): UPDATE shops SET status='active', audit log",
            "postDelete(): confirm dialog (type slug), UPDATE status='deleted', audit log",
            "Redirect back to store detail (or list if deleted)",
          ],
          ["Suspend changes status to suspended", "Activate restores to active", "Delete requires slug confirmation"]),

        ...stepBlock("3.5", "B6 Store Health Score",
          "apps/god-admin/src/pages/stores.ts \u2014 getStoreHealth()",
          [
            "Score 0-100, 5 categories (20 pts each):",
            "  Products (20): count, images, descriptions",
            "  Orders (20): last 7 days count",
            "  Customers (20): returning %, marketing opt-in %",
            "  Content (20): about page, shipping policy, refund policy",
            "  Technical (20): domain, shipping zones, complete settings",
            "Display: score circle + breakdown bars + text recommendations",
          ],
          ["Score calculated correctly", "Breakdown shows per-category"]),

        ...stepBlock("3.6", "B7+B8 AI Store Analyst + Recommendations",
          "(via platform-agent.ts AI chat)",
          [
            "User asks: 'Analyze store Fashion Hub' or 'Phan tich store XYZ'",
            "AI queries store-specific data: revenue, orders, products, customers",
            "Generates analysis with performance metrics + top issues + recommendations",
            "Recommendations: actionable items like 'add product images', 'set up shipping zones'",
          ],
          ["AI responds with store-specific analysis"]),

        new Paragraph({ children: [new PageBreak()] }),

        // PHASE 4
        h1("PHASE 4: GROUP C \u2014 QUAN LY USERS (8 chuc nang)"),

        ...stepBlock("4.1", "C1 User List",
          "apps/god-admin/src/pages/users.ts \u2014 getUsers()",
          [
            "Query: users LEFT JOIN user_shops (count), LEFT JOIN sessions (last login)",
            "Search: email/name ilike",
            "Filters: role dropdown, status dropdown",
            "Pagination: 20/page",
            "Table: email, name, role badge (gold for owner), status badge, store count, last login",
            "Crown icon for is_default_admin",
            "Button: '+ Create User'",
          ],
          ["List shows all users", "God Admin highlighted", "Search/filters work"]),

        ...stepBlock("4.2", "C2 User Detail",
          "apps/god-admin/src/pages/users.ts \u2014 getUserDetail()",
          [
            "Profile card: all user fields",
            "Stores card: user_shops JOIN shops (role per store)",
            "Active sessions table (last 10)",
            "Audit log entries (last 20)",
            "Actions: [Disable] [Enable] [Reset Password] [Impersonate]",
            "Default God Admin: show 'Protected' instead of action buttons",
          ],
          ["Detail shows correct user data", "Default admin is protected"]),

        ...stepBlock("4.3", "C3 Create User",
          "apps/god-admin/src/pages/users.ts \u2014 getCreateUser(), postCreateUser()",
          [
            "Form: email, name, role (staff/admin), password (manual or auto-generate)",
            "POST: hash password with bcrypt, INSERT users, audit log: user.created",
            "Redirect to user detail",
          ],
          ["User created successfully", "Password hashed with bcrypt"]),

        ...stepBlock("4.4", "C4 Disable / Enable (with God Admin protection)",
          "apps/god-admin/src/pages/users.ts",
          [
            "postDisable(): check NOT is_default_admin, UPDATE status='disabled', kill all sessions, audit log",
            "postEnable(): UPDATE status='active', audit log",
            "God Admin 2 (role=owner, is_default_admin=false): CAN be disabled by Default only",
            "Default God Admin: CANNOT be disabled by anyone",
          ],
          ["Regular user can be disabled", "Default admin cannot be disabled", "Sessions killed on disable"]),

        ...stepBlock("4.5", "C5 Reset Password",
          "apps/god-admin/src/pages/users.ts \u2014 postResetPassword()",
          [
            "Generate random 16-char alphanumeric password",
            "Hash with bcrypt (12 rounds)",
            "UPDATE users SET password_hash",
            "Kill all sessions for that user",
            "Display new password ONCE in success flash message",
            "Audit log: user.password_reset",
          ],
          ["Password changed", "Old sessions invalidated", "New password shown once"]),

        ...stepBlock("4.6", "C6 Impersonate (Default God Admin Only)",
          "apps/god-admin/src/pages/users.ts \u2014 postImpersonate()",
          [
            "ONLY if req.godAdmin.user.is_default_admin === true",
            "Cannot impersonate other God Admins (role='owner')",
            "Create NEW session for target user with 1-hour expiry",
            "Set gbox_session cookie with new session token",
            "Audit log: user.impersonated { by: god_admin_id, target: user_id }",
            "Redirect to /accounts/stores (as that user)",
          ],
          ["Default admin can impersonate regular user", "Non-default admin cannot impersonate", "Audit log recorded"]),

        ...stepBlock("4.7", "C7+C8 AI User Segmentation + Churn Prediction",
          "(via platform-agent.ts AI chat)",
          [
            "Segmentation: VIP (>$10K/mo), At-risk (dropped 30%), New (<7d), Inactive (>30d no login)",
            "Churn prediction: analyze login frequency, order volume, revenue trend per user",
            "Generate risk score 0-100 with explanation",
          ],
          ["AI responds with user segments", "Churn prediction with reasoning"]),

        new Paragraph({ children: [new PageBreak()] }),

        // PHASE 5
        h1("PHASE 5: GROUP H \u2014 BAO MAT & AUDIT (6 chuc nang)"),

        ...stepBlock("5.1", "H1 Audit Log Viewer",
          "apps/god-admin/src/pages/security.ts \u2014 getAuditLog()",
          [
            "Query: audit_logs JOIN users ORDER BY created_at DESC",
            "Filters: action dropdown (distinct actions), user_id, date range (from/to)",
            "Pagination: 50/page",
            "Table: timestamp, user email, action, resource_type:resource_id, IP, expandable details",
            "Color code by type: green=create, blue=update, red=delete, yellow=auth",
          ],
          ["Audit log shows real entries", "Filters work", "Pagination works"]),

        ...stepBlock("5.2", "H2 Login History",
          "apps/god-admin/src/pages/security.ts \u2014 getLoginHistory()",
          [
            "Query: audit_logs WHERE action LIKE '%login%'",
            "Table: timestamp, email, action (success/fail), IP, user_agent",
            "Failed logins highlighted red",
            "Group-by-IP summary: show count of attempts per IP address",
          ],
          ["Login successes and failures shown", "Failed attempts red"]),

        ...stepBlock("5.3", "H3 Suspicious Activity Detection",
          "apps/god-admin/src/pages/security.ts \u2014 getSuspicious()",
          [
            "Auto-detect: IPs with >10 failed logins/hour",
            "Users with login from >3 different IPs in 1 hour",
            "Bulk operations: >50 write actions in 1 hour by single user",
            "Display: alert cards with severity, explanation, recommended action",
          ],
          ["Suspicious patterns detected from test data"]),

        ...stepBlock("5.4", "H4 API Token Management",
          "apps/god-admin/src/pages/security.ts \u2014 getTokens(), postCreateToken(), postRevokeToken()",
          [
            "List: api_tokens JOIN users, shops",
            "Table: label, user email, shop name, scopes, last_used, created_at",
            "Create form: select user, select shop, label, scopes checkboxes",
            "Revoke button: DELETE api_tokens, audit log: token.revoked",
          ],
          ["Token list shows real tokens", "Create works", "Revoke works"]),

        ...stepBlock("5.5", "H5+H6 AI Security Monitor + Compliance Checker",
          "(via platform-agent.ts AI chat)",
          [
            "Security: analyze failed login patterns, IP activity, session anomalies",
            "Compliance: check stores for Privacy Policy, Terms, verified emails, tax settings",
            "Generate reports with findings + recommendations",
          ],
          ["AI responds to 'security check'", "AI responds to 'compliance check'"]),

        new Paragraph({ children: [new PageBreak()] }),

        // PHASE 6
        h1("PHASE 6: GOD ADMIN HIERARCHY"),

        ...stepBlock("6.1", "Admins Page \u2014 List God Admins",
          "apps/god-admin/src/pages/admins.ts \u2014 getAdmins()",
          [
            "ONLY VISIBLE if req.godAdmin.user.is_default_admin === true",
            "Query: users WHERE role = 'owner'",
            "Table: email, name, is_default badge (crown), created_at",
            "Default: 'Default God Admin \u2014 Cannot be removed'",
            "God Admin 2: [Delete] button with confirm",
            "Button: '+ Create God Admin'",
          ],
          ["List shows all god admins", "Default marked with crown", "Only default can access this page"]),

        ...stepBlock("6.2", "Create God Admin 2",
          "apps/god-admin/src/pages/admins.ts \u2014 postCreateAdmin()",
          [
            "ONLY if is_default_admin",
            "Form: email, name, password",
            "POST: hash password, INSERT users with role='owner', is_default_admin=false",
            "Audit log: god_admin.created",
            "Redirect to admins list",
          ],
          ["New god admin created", "Can login at /god-admin/login", "Has full access"]),

        ...stepBlock("6.3", "Delete God Admin 2",
          "apps/god-admin/src/pages/admins.ts \u2014 postDeleteAdmin()",
          [
            "ONLY if is_default_admin",
            "Cannot delete self (is_default_admin = true check)",
            "Confirm dialog required",
            "DELETE users WHERE id AND role='owner' AND is_default_admin = false",
            "Kill all sessions for deleted admin",
            "Audit log: god_admin.deleted",
          ],
          ["God Admin 2 deleted", "Sessions killed", "Default cannot be deleted"]),

        // PHASE 7
        h1("PHASE 7: SKELETON UI (Groups D,E,F,G,I,J,K)"),

        ...stepBlock("7.1", "7 Placeholder Pages",
          "apps/god-admin/src/pages/skeleton.ts",
          [
            "Export one function per placeholder group",
            "Each uses godLayout with correct activePage/activeGroup",
            "Content: professional 'Coming Soon' card with group icon + title + description",
            "Groups: Orders (D), Fulfillment (E), Finance (F), Staff & AI (G), Content (I), Config (J), Developer (K)",
            "Also sub-pages: order analytics, transactions, campaigns, webhooks, apps",
          ],
          ["All 13 skeleton routes return 200", "Correct sidebar item highlighted"]),

        new Paragraph({ children: [new PageBreak()] }),

        // PHASE 8
        h1("PHASE 8: DEPLOY & TEST"),

        ...stepBlock("8.1", "Commit & Push", null,
          [
            "git add apps/god-admin/ packages/db/",
            "git commit with descriptive message",
            "git push origin master && git push org master",
          ], []),

        ...stepBlock("8.2", "Deploy to Server", null,
          [
            "SSH to 192.168.1.13 as botesty",
            "cd /home/botesty/gbox-platform && git pull origin master",
            "pm2 restart gbox-god-admin",
          ], []),

        ...stepBlock("8.3", "Run Migration + Seed", null,
          [
            "npx tsx packages/db/src/migrations/run.ts (migration 002)",
            "npx tsx apps/god-admin/src/seed/god-admin-seed.ts",
            "Verify: user buithai3107@gmail.com exists with role=owner, is_default_admin=true",
          ], []),

        ...stepBlock("8.4", "E2E Test (13 tests)", null,
          [
            "Test 1: GET /god-admin/login \u2192 200",
            "Test 2: GET /god-admin \u2192 302 to /god-admin/login (no auth)",
            "Test 3: POST /god-admin/login (default creds) \u2192 302 to /god-admin",
            "Test 4: GET /god-admin \u2192 200, contains 'Dashboard'",
            "Test 5: Group A pages (metrics, health, alerts, activity) \u2192 200",
            "Test 6: Group B pages (stores, stores/:id) \u2192 200",
            "Test 7: Group C pages (users, users/:id) \u2192 200",
            "Test 8: Group H pages (security, logins, suspicious, tokens) \u2192 200",
            "Test 9: God Admin hierarchy (admins) \u2192 200",
            "Test 10: All skeleton pages \u2192 200",
            "Test 11: AI chat \u2192 200 + html response",
            "Test 12: Logout \u2192 302 to /god-admin/login",
            "Test 13: Non-owner login \u2192 rejected",
          ],
          ["All 13 tests pass \u2714"]),

        // FILE DELIVERABLES
        new Paragraph({ children: [new PageBreak()] }),
        h1("FILE DELIVERABLES"),
        p("Tong cong 17 files:"),

        pBold("MODIFIED (2 files):", C.dark),
        bullet("packages/db/src/schema/tables.ts \u2014 Add is_default_admin to UserTable"),
        bullet("packages/db/src/migrations/run.ts \u2014 Register migration 002"),

        pBold("NEW (15 files):", C.dark),
        bullet("packages/db/src/migrations/002_god_admin.ts \u2014 Migration"),
        bullet("apps/god-admin/src/seed/god-admin-seed.ts \u2014 Seed script"),
        bullet("apps/god-admin/src/pages/login.ts \u2014 Login page"),
        bullet("apps/god-admin/src/pages/dashboard.ts \u2014 A1 Dashboard (rewrite)"),
        bullet("apps/god-admin/src/pages/metrics.ts \u2014 A2 Real-time metrics"),
        bullet("apps/god-admin/src/pages/health.ts \u2014 A3 System health"),
        bullet("apps/god-admin/src/pages/alerts.ts \u2014 A4 Alert center"),
        bullet("apps/god-admin/src/pages/activity.ts \u2014 A5 Activity feed"),
        bullet("apps/god-admin/src/pages/stores.ts \u2014 B1-B6 Stores (rewrite)"),
        bullet("apps/god-admin/src/pages/users.ts \u2014 C1-C6 Users (rewrite)"),
        bullet("apps/god-admin/src/pages/security.ts \u2014 H1-H4 Security (rewrite)"),
        bullet("apps/god-admin/src/pages/admins.ts \u2014 God Admin hierarchy"),
        bullet("apps/god-admin/src/pages/skeleton.ts \u2014 Placeholder pages"),
        bullet("apps/god-admin/src/ai/platform-agent.ts \u2014 AI advisor"),
        bullet("apps/god-admin/src/layouts/god-layout.ts \u2014 Layout (rewrite)"),
        bullet("apps/god-admin/src/middleware/god-auth.ts \u2014 Auth middleware (update)"),
        bullet("apps/god-admin/src/server.ts \u2014 Server (rewrite)"),

        new Paragraph({ spacing: { before: 600 } }),
        new Paragraph({
          alignment: AlignmentType.CENTER,
          shading: { fill: "D5F5E3", type: ShadingType.CLEAR },
          border: { top: { style: BorderStyle.SINGLE, size: 2, color: C.green }, bottom: { style: BorderStyle.SINGLE, size: 2, color: C.green } },
          spacing: { before: 400 },
          children: [new TextRun({ text: "  PLAN APPROVED \u2014 READY TO BUILD  ", size: 28, bold: true, color: C.green })],
        }),
      ],
    },
  ],
});

Packer.toBuffer(doc).then(buffer => {
  const outPath = "E:/Gbox Platform vibecode/gbox-platform/docs/superpowers/plans/2026-04-07-god-admin-platform-plan.docx";
  fs.writeFileSync(outPath, buffer);
  console.log("DOCX created:", buffer.length, "bytes");
});
