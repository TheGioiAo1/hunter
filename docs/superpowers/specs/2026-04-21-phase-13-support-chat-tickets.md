# GBOX PLATFORM — PHASE 12.5 + 13 SPEC (v3 — LOCKED)
## Seller ↔ Support Chat + Ticket System — Zero External Bridges + Staff Portal + AI Layer 1

**Date:** 2026-04-22 (v3 lock: all 29 Q + 3 C decisions captured; 4-PR MVP → 6-PR MVP)
**Author:** Claude (for Thai Bui)
**Status:** **LOCKED v3 — execution authorized under standing directive "làm 1 mạch"**
**Branch:** `feat/phase-12-5-support-mvp` (active), then `feat/phase-13-support-polish`
**Related:** CLAUDE.md §Rule 1-5, Phase 12 PayPal-first spec, Phase 11 PR3 (oauth-token-crypto reuse)

---

## 0. BỐI CẢNH (Context) — scope revision

**Owner direction (2026-04-21, lần 2):**

> "Bỏ hoàn toàn Zalo và Telegram khỏi project này, support nội bộ qua
> ticket và chat nội bộ toàn platform. Build 1 hệ thống hoàn hảo."

**Scope khóa lại:**

1. **CHỈ internal chat + ticket.** Không Telegram, không Zalo, không SMS, không email-bridge 2-way.
2. **Email vẫn dùng nhưng 1-way outbound only:** seller nhận notification "bạn có reply mới" → click mở lại widget trong store-admin. Không parse email inbound thành ticket (tránh spoofing + spam surface).
3. **God admin kiểm soát toàn bộ nội dung** — mọi message, mọi ticket, mọi shop, đọc được hết.
4. **Perfect system target:** Shopify/Zendesk-class depth. Giải pháp cho 1 agent (Thai) solo handle 5K-10K sellers tuần đầu, scale team sau.

**Tại sao bỏ bridges:**

- Telegram/Zalo = extra surface tấn công (bot spoofing, webhook abuse) mà lợi ích marginal cho beta.
- Agent split attention giữa 3 kênh = latency cao hơn, dễ miss.
- Mirror pattern phức tạp (dedupe, channel_message_id mapping) — cắt bỏ giải phóng ~5 ngày dev.
- Zalo OA approval 7-14 ngày — risk cho timeline beta.
- Internal-only = control 100%, audit trail sạch, không phụ thuộc 3rd party uptime.

**Trade-off chấp nhận:**

- Sellers phải vào store-admin để xem reply (không có push notification tới điện thoại qua Telegram/Zalo). Bù: email notification + browser push (nếu bật) + badge trong widget.
- Khi seller offline, agent reply "chờ" trong DB đến khi seller login. Bù: email "bạn có reply mới" gửi sau 5 phút nếu seller chưa xem.

---

## 1. NGUYÊN TẮC LOCKED (10 rules, không thay đổi sau duyệt)

| # | Nguyên tắc | Rationale |
|---|-----------|-----------|
| 1 | **Single source of truth = `support_messages` table** | God admin query 1 chỗ, không miss. |
| 2 | **Internal-only, no external bridges** | Scope lock per owner 2026-04-21. Nếu future cần, re-open spec riêng. |
| 3 | **God admin sees everything, sellers see only their shop** | Iron Rule 2. Cross-shop query protected by `WHERE shop_id = $auth_shop_id` + unit tests. |
| 4 | **Message body encrypted at rest (AES-256-GCM)** | Reuse `oauth-token-crypto.ts` từ Phase 11 PR3. Key trong env, ciphertext trong `support_messages.body_ciphertext`. |
| 5 | **Real-time qua polling trước, WebSocket sau** | MVP 3s polling chạy ngay được. WS latency thấp hơn nhưng thêm infra (Redis pubsub, sticky session). Phase 13 PR1. |
| 6 | **No attachments in MVP** | File upload cần virus scan + S3 private bucket + signed URL TTL. Phase 13 PR3. |
| 7 | **SLA engine là cron-driven, không inline** | Không block gửi tin để check SLA. Cron mỗi 5 phút quét ticket quá hạn, escalate. |
| 8 | **Iron Rule 5 — zero god-admin leak in seller UI** | Seller thấy "Gbox Support" / "Minh (Gbox)" — không thấy email agent thật, không thấy route `/god-admin/*`, không thấy user_id internal. |
| 9 | **Internal notes never leave the server for seller eyes** | `sender_type='agent_internal_note'` — seller API endpoint filters these out at query layer, not just UI. Defense in depth. |
| 10 | **Audit-first: every state change logged** | `support_ticket_events` append-only. Ticket status change, priority change, agent assignment, message edit, message delete — all leave a trail. |

---

## 2. MINDMAP WORKFLOW (Iron Rule 3)

```
┌──────────────────── SELLER WORLD (store-admin) ────────────────────┐
│                                                                      │
│  Seller đăng nhập qua accounts.gbox.co → admin.gbox.co/admin/store/:slug │
│                             │                                         │
│                             ↓                                         │
│  ┌──────────────────────────────────────────────┐                    │
│  │ Help widget góc phải dưới                    │                    │
│  │ - Badge unread count                         │                    │
│  │ - Browser push notification (opt-in)         │                    │
│  │ - Click → sliding panel                      │                    │
│  └──────────────────────────────────────────────┘                    │
│                             │                                         │
│                             ↓                                         │
│  ┌──────────────────────────────────────────────┐                    │
│  │ Panel 3 tab:                                 │                    │
│  │ - "Đang trao đổi" (open tickets)             │                    │
│  │ - "Đã xong" (resolved, last 30d)             │                    │
│  │ - "Trung tâm trợ giúp" (KB link — Phase 14)  │                    │
│  │                                               │                    │
│  │ Button "Tạo yêu cầu mới" → form              │                    │
│  │ Button "Tìm kiếm" → tsvector search          │                    │
│  └──────────────────────────────────────────────┘                    │
│                             │                                         │
│                             ↓                                         │
│  ┌──────────────────────────────────────────────┐                    │
│  │ FORM tạo ticket:                             │                    │
│  │   - Danh mục [dropdown]:                     │                    │
│  │     * Thanh toán (PayPal)                    │                    │
│  │     * Kỹ thuật (lỗi storefront/admin)        │                    │
│  │     * Onboarding                             │                    │
│  │     * Tài khoản / bảo mật                    │                    │
│  │     * Sản phẩm / đơn hàng                    │                    │
│  │     * Khác                                    │                    │
│  │   - Tiêu đề [text, max 120]                  │                    │
│  │   - Mô tả [textarea + markdown]              │                    │
│  │   - [Gửi]                                     │                    │
│  └──────────────────────────────────────────────┘                    │
│                             │                                         │
│                             ↓                                         │
│  POST /api/support/tickets                                            │
│                             │                                         │
└─────────────────────────────┼────────────────────────────────────────┘
                              ↓
┌──────────────── PLATFORM (gbox-api on server 1) ───────────────────┐
│                                                                      │
│  1. Validate CSRF + session (merchant auth)                          │
│  2. Rate limit: 10 tickets/hour/shop, 60 messages/hour/user          │
│  3. Detect duplicate: same shop, same category, open ticket last 1h? │
│     → prompt "Bạn đã có ticket đang mở, thêm vào đó?"                │
│  4. Auto-categorize (Phase 13 PR6 AI assist): nếu detect "paypal"    │
│     trong subject+body → auto-tag category=payment                   │
│  5. INSERT support_tickets                                           │
│       (shop_id, opener_user_id, category, subject, status='open',    │
│        priority='normal', sla_first_response_at=now+4h,              │
│        sla_resolution_at=now+24h)                                    │
│  6. INSERT support_messages                                          │
│       (ticket_id, sender_type='seller', sender_user_id,              │
│        body_ciphertext=encrypt(body), created_at)                    │
│  7. INSERT support_ticket_events                                     │
│       (ticket_id, event='ticket_opened', actor_user_id)              │
│  8. Smart routing (Phase 13 PR8):                                    │
│     - If category=payment && any agent has skill_tags @> ['paypal']  │
│       → auto-assign                                                  │
│     - Else → unassigned queue                                        │
│  9. Notify god admin:                                                │
│     - INSERT notifications (scope='god_admin', type='new_ticket')    │
│     - Push to Socket.IO room god-admin:inbox (Phase 13 PR1)          │
│     - If no agent online → email fallback sau 5 phút                 │
│  10. Return { ticketId } to seller                                   │
│                                                                      │
└─────────────────────────────┼────────────────────────────────────────┘
                              ↓
┌─────────────── GOD ADMIN WORLD (god-admin.gbox.co) ────────────────┐
│                                                                      │
│  Agent vào /god-admin/support/inbox                                  │
│                             │                                         │
│                             ↓                                         │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │ Inbox với Views (custom filters saved per agent):            │   │
│  │ - [Tất cả unassigned]  [Của tôi]  [Đến hạn hôm nay]          │   │
│  │ - [Priority cao]  [Waiting on seller]  [+ tạo view mới]      │   │
│  │                                                                │   │
│  │ Filter bar: Category ▼ Priority ▼ Status ▼ Agent ▼ Tag ▼    │   │
│  │ Sort: Created ↓ | Priority | SLA deadline | Last updated    │   │
│  │ Search: [_______________________]                             │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                             │                                         │
│                             ↓                                         │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │ Row: T_1234 | shop-xyz | "Không kết nối PayPal" | 2h ago    │   │
│  │     | priority=high | unassigned | SLA: 2h left              │   │
│  │                                                                │   │
│  │ [Claim] [Reassign ▼] [Merge with...] [Tag...] [Priority ▼]  │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                             │                                         │
│                             ↓                                         │
│  Click row → detail page                                              │
│                             ↓                                         │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │ Ticket T_1234                                                 │   │
│  │ Shop: shop-xyz (vào shop →)                                  │   │
│  │ Opener: lan@shop-xyz (lan+gbox-test@gmail.com)               │   │
│  │ Category: payment  Priority: high  Status: open              │   │
│  │ SLA: first-response 2h 14min left | resolution 22h left      │   │
│  │ Tags: [paypal] [onboarding] [+ thêm]                         │   │
│  │                                                                │   │
│  │ ═════════════ CONVERSATION ═════════════                     │   │
│  │                                                                │   │
│  │ 👤 Lan (seller, 10:30):                                      │   │
│  │    "Em connect PayPal không được..."                          │   │
│  │    [✓✓ Đã đọc lúc 10:32] [👍 reaction] [Reply] [...]        │   │
│  │                                                                │   │
│  │ 🔒 INTERNAL NOTE — Minh (10:35):                             │   │
│  │    "Shop này đăng ký hôm qua, check onboarding_logs..."      │   │
│  │    [@ mention Thai] [edit] [delete]                          │   │
│  │                                                                │   │
│  │ 💬 Minh (agent, 10:36):                                      │   │
│  │    "Chào chị, em đang check..."                              │   │
│  │    [Edit (within 5min)] [Delete (soft)]                      │   │
│  │                                                                │   │
│  │ 👤 Lan đang gõ...                                            │   │
│  │                                                                │   │
│  │ ═════════════ REPLY ═════════════                             │   │
│  │ [Tab: Reply | Internal note]                                 │   │
│  │ ┌──────────────────────────────────────────────────────────┐ │   │
│  │ │ Cảm ơn chị đã báo. Em check hệ thống...                  │ │   │
│  │ │                                                          │ │   │
│  │ └──────────────────────────────────────────────────────────┘ │   │
│  │ [📎 Attach] [Canned ▼] [🤖 AI suggest] [Save draft] [Gửi]  │   │
│  │                                                                │   │
│  │ ═════════════ ACTIONS ═════════════                          │   │
│  │ [Đóng ticket] [Chuyển agent] [Merge] [Escalate] [Snooze]    │   │
│  │                                                                │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                             │                                         │
└─────────────────────────────┼────────────────────────────────────────┘
                              ↓
┌──────────────── PLATFORM (gbox-api) ───────────────────────────────┐
│                                                                      │
│  POST /api/god-admin/support/tickets/:id/reply                       │
│  1. Validate session + permission (`support:respond:write`)          │
│  2. INSERT support_messages (sender_type='agent', body_ciphertext)   │
│  3. INSERT support_ticket_events (event='agent_replied')             │
│  4. If first agent response → UPDATE support_tickets                 │
│       SET first_responded_at = now()                                 │
│  5. UPDATE ticket status open → pending_seller (optional)            │
│  6. Push to Socket.IO room ticket:{id}                               │
│  7. If seller offline > 5min → queue email notification job          │
│                                                                      │
└─────────────────────────────┼────────────────────────────────────────┘
                              ↓
                     SELLER sees reply via
                     WS push OR next 3s poll
                              │
                              ↓
                    Seller reads, replies, rates CSAT
                              │
                              ↓
                     Agent "Đóng ticket" → status=closed
                              │
                              ↓
               CSAT prompt gửi seller (nếu chưa rate)
                              │
                              ↓
                  Auto-close sau 7 ngày inactivity
```

---

## 3. DATABASE SCHEMA

### 3.1 Migration 078 — core tables

```sql
-- Ticket aggregate
CREATE TABLE support_tickets (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id                 UUID NOT NULL REFERENCES shops(id),
  opener_user_id          UUID NOT NULL REFERENCES users(id),
  category                TEXT NOT NULL CHECK (category IN (
                            'payment','technical','onboarding',
                            'account','product_order','other'
                          )),
  subject                 TEXT NOT NULL CHECK (char_length(subject) <= 120),
  status                  TEXT NOT NULL DEFAULT 'open' CHECK (status IN (
                            'open','pending_agent','pending_seller',
                            'resolved','closed','merged'
                          )),
  priority                TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN (
                            'low','normal','high','urgent'
                          )),
  assigned_agent_id       UUID REFERENCES users(id),
  merged_into_ticket_id   UUID REFERENCES support_tickets(id),

  -- SLA tracking
  sla_first_response_at   TIMESTAMPTZ NOT NULL,
  sla_resolution_at       TIMESTAMPTZ NOT NULL,
  first_responded_at      TIMESTAMPTZ,
  resolved_at             TIMESTAMPTZ,
  closed_at               TIMESTAMPTZ,
  sla_paused_at           TIMESTAMPTZ,  -- set when status=pending_seller
  sla_paused_total_ms     BIGINT NOT NULL DEFAULT 0,

  -- CSAT
  csat_score              SMALLINT CHECK (csat_score BETWEEN 1 AND 5),
  csat_comment            TEXT,
  csat_rated_at           TIMESTAMPTZ,

  -- Audit
  last_message_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  unread_by_seller_count  INT NOT NULL DEFAULT 0,
  unread_by_agent_count   INT NOT NULL DEFAULT 0,

  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_support_tickets_shop_status ON support_tickets(shop_id, status);
CREATE INDEX idx_support_tickets_assigned ON support_tickets(assigned_agent_id) WHERE status NOT IN ('closed','merged');
CREATE INDEX idx_support_tickets_sla_breach ON support_tickets(sla_first_response_at) WHERE first_responded_at IS NULL;
CREATE INDEX idx_support_tickets_last_msg ON support_tickets(last_message_at DESC);

-- Messages (encrypted body)
CREATE TABLE support_messages (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id             UUID NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  sender_type           TEXT NOT NULL CHECK (sender_type IN (
                          'seller','agent','agent_internal_note','system'
                        )),
  sender_user_id        UUID REFERENCES users(id),  -- NULL for system
  body_ciphertext       BYTEA NOT NULL,              -- AES-256-GCM payload
  body_iv               BYTEA NOT NULL,              -- 12-byte IV
  body_tag              BYTEA NOT NULL,              -- 16-byte auth tag
  body_key_version      SMALLINT NOT NULL DEFAULT 1, -- for key rotation

  -- Edit/delete tracking
  edited_at             TIMESTAMPTZ,
  edit_count            SMALLINT NOT NULL DEFAULT 0,
  deleted_at            TIMESTAMPTZ,                 -- soft delete
  deleted_by_user_id    UUID REFERENCES users(id),

  -- Read receipts (Phase 13 PR7)
  seller_read_at        TIMESTAMPTZ,
  agent_read_at         TIMESTAMPTZ,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_support_messages_ticket ON support_messages(ticket_id, created_at);
CREATE INDEX idx_support_messages_unread_seller ON support_messages(ticket_id)
  WHERE seller_read_at IS NULL AND sender_type='agent';

-- Edit history (append-only, for audit)
CREATE TABLE support_message_edits (
  id                  BIGSERIAL PRIMARY KEY,
  message_id          UUID NOT NULL REFERENCES support_messages(id) ON DELETE CASCADE,
  prior_ciphertext    BYTEA NOT NULL,
  prior_iv            BYTEA NOT NULL,
  prior_tag           BYTEA NOT NULL,
  prior_key_version   SMALLINT NOT NULL,
  edited_by_user_id   UUID NOT NULL REFERENCES users(id),
  edited_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Event log (append-only)
CREATE TABLE support_ticket_events (
  id                BIGSERIAL PRIMARY KEY,
  ticket_id         UUID NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  event_type        TEXT NOT NULL,  -- ticket_opened, agent_assigned, status_changed, sla_breached, csat_rated, message_edited, message_deleted, merged, escalated, etc.
  actor_user_id     UUID REFERENCES users(id),
  metadata          JSONB NOT NULL DEFAULT '{}',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_support_ticket_events_ticket ON support_ticket_events(ticket_id, created_at);
CREATE INDEX idx_support_ticket_events_type ON support_ticket_events(event_type, created_at);

-- @mentions in internal notes
CREATE TABLE support_mentions (
  id                 BIGSERIAL PRIMARY KEY,
  message_id         UUID NOT NULL REFERENCES support_messages(id) ON DELETE CASCADE,
  mentioned_user_id  UUID NOT NULL REFERENCES users(id),
  read_at            TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_support_mentions_unread ON support_mentions(mentioned_user_id) WHERE read_at IS NULL;
```

### 3.2 Migration 079 — canned replies + agent profile + ticket templates

```sql
-- Canned replies (macros with variables)
CREATE TABLE support_canned_replies (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title           TEXT NOT NULL,          -- "PayPal onboarding hướng dẫn"
  body_template   TEXT NOT NULL,          -- "Chào {{seller.display_name}}, ..."
  category        TEXT,                   -- nullable, optional tie to ticket category
  tags            TEXT[] DEFAULT ARRAY[]::TEXT[],
  created_by      UUID NOT NULL REFERENCES users(id),
  usage_count     INT NOT NULL DEFAULT 0,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Ticket templates (pre-filled forms for common seller issues)
CREATE TABLE support_ticket_templates (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title           TEXT NOT NULL,          -- "Báo lỗi thanh toán"
  category        TEXT NOT NULL,
  subject_prefill TEXT NOT NULL,
  body_prefill    TEXT NOT NULL,
  required_fields JSONB NOT NULL DEFAULT '[]',  -- [{ key, label, type }]
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order      INT NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Agent profile (display name shown to sellers)
CREATE TABLE support_agent_profiles (
  user_id          UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  display_name     TEXT NOT NULL,          -- "Minh" hoặc "Thai" — shown to seller
  avatar_url       TEXT,
  skill_tags       TEXT[] DEFAULT ARRAY[]::TEXT[],   -- ['paypal','technical','vn']
  workload_cap     INT NOT NULL DEFAULT 20,          -- max concurrent tickets
  business_hours   JSONB NOT NULL DEFAULT '{"tz":"Asia/Ho_Chi_Minh","days":[1,2,3,4,5],"start":"08:00","end":"18:00"}',
  is_active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Saved views per agent (custom filters)
CREATE TABLE support_saved_views (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  filter_json  JSONB NOT NULL,         -- { category, priority, status, tags, ... }
  sort_by      TEXT NOT NULL DEFAULT 'last_message_at',
  is_shared    BOOLEAN NOT NULL DEFAULT FALSE,  -- shared with all agents
  sort_order   INT NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_support_saved_views_agent ON support_saved_views(agent_id, sort_order);
```

### 3.3 Migration 080 — attachments

```sql
CREATE TABLE support_attachments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id      UUID NOT NULL REFERENCES support_messages(id) ON DELETE CASCADE,
  s3_key          TEXT NOT NULL,          -- private bucket path
  original_name   TEXT NOT NULL,
  mime_type       TEXT NOT NULL,
  size_bytes      BIGINT NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 10485760), -- 10MB
  scan_status     TEXT NOT NULL DEFAULT 'pending' CHECK (scan_status IN (
                    'pending','clean','infected','scan_error'
                  )),
  scan_result     JSONB,                  -- ClamAV output
  uploaded_by     UUID NOT NULL REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_support_attachments_message ON support_attachments(message_id);
CREATE INDEX idx_support_attachments_scan ON support_attachments(scan_status) WHERE scan_status = 'pending';
```

### 3.4 Migration 081 — full-text search

```sql
-- Denormalize decrypted body into searchable tsvector.
-- Populated by application-level hook after decrypt (can't index encrypted data).
-- Stored in separate table to keep hot path messages table lean.
CREATE TABLE support_message_search (
  message_id   UUID PRIMARY KEY REFERENCES support_messages(id) ON DELETE CASCADE,
  ticket_id    UUID NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  shop_id      UUID NOT NULL REFERENCES shops(id),
  search_vec   TSVECTOR NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_support_message_search_vec ON support_message_search USING GIN (search_vec);
CREATE INDEX idx_support_message_search_shop ON support_message_search(shop_id);

-- Subject is not encrypted → can index in-place
CREATE INDEX idx_support_tickets_subject_search ON support_tickets
  USING GIN (to_tsvector('simple', subject));
```

### 3.5 Migration 082 — advanced message features

```sql
-- Reactions (emoji on messages, agent + seller)
CREATE TABLE support_message_reactions (
  id           BIGSERIAL PRIMARY KEY,
  message_id   UUID NOT NULL REFERENCES support_messages(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES users(id),
  emoji        TEXT NOT NULL CHECK (emoji IN ('👍','❤️','🎉','😄','😢','🙏')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (message_id, user_id, emoji)
);

CREATE INDEX idx_support_message_reactions_msg ON support_message_reactions(message_id);

-- Presence (who's viewing the ticket right now)
-- Ephemeral — cleaned up by cron every 2min, entries older than 30s = gone
CREATE TABLE support_presence (
  ticket_id   UUID NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id),
  last_seen   TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_typing   BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (ticket_id, user_id)
);

CREATE INDEX idx_support_presence_ticket ON support_presence(ticket_id, last_seen DESC);
```

### 3.6 Migration 083 — workflow polish

```sql
-- Tags (cross-cutting labels on tickets)
CREATE TABLE support_tags (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL UNIQUE,       -- 'paypal', 'urgent-vip', 'bug-reproduced'
  color        TEXT NOT NULL DEFAULT '#6B7280',
  description  TEXT,
  created_by   UUID NOT NULL REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE support_ticket_tags (
  ticket_id   UUID NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  tag_id      UUID NOT NULL REFERENCES support_tags(id) ON DELETE CASCADE,
  added_by    UUID NOT NULL REFERENCES users(id),
  added_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (ticket_id, tag_id)
);

CREATE INDEX idx_support_ticket_tags_tag ON support_ticket_tags(tag_id);

-- Bulk action log (audit for mass close/assign)
CREATE TABLE support_bulk_actions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id UUID NOT NULL REFERENCES users(id),
  action        TEXT NOT NULL,              -- 'close', 'assign', 'tag', 'priority'
  ticket_ids    UUID[] NOT NULL,
  payload       JSONB NOT NULL,
  affected_count INT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Automations (trigger rules — Zendesk-style)
CREATE TABLE support_automations (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name           TEXT NOT NULL,
  trigger_event  TEXT NOT NULL,              -- 'ticket_created', 'message_received', 'sla_breached', 'inactivity_7d'
  conditions     JSONB NOT NULL,             -- [{field, op, value}]
  actions        JSONB NOT NULL,             -- [{type, payload}]
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  run_count      INT NOT NULL DEFAULT 0,
  last_run_at    TIMESTAMPTZ,
  created_by     UUID NOT NULL REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_support_automations_trigger ON support_automations(trigger_event) WHERE is_active = TRUE;

-- KB articles linked to tickets (for future knowledge base)
CREATE TABLE support_kb_article_links (
  ticket_id    UUID NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  article_slug TEXT NOT NULL,              -- slug of KB article
  linked_by    UUID NOT NULL REFERENCES users(id),
  linked_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (ticket_id, article_slug)
);
```

---

## 4. API SURFACE

### 4.1 Seller endpoints (store-admin, merchant session required)

```
GET    /api/support/tickets               — list own shop's tickets (paginated, filter by status)
GET    /api/support/tickets/:id           — detail + messages (agent_internal_note filtered out at SQL)
POST   /api/support/tickets               — create ticket (body: {category, subject, body})
GET    /api/support/tickets/:id/messages  — paginated messages (agent_internal_note excluded)
POST   /api/support/tickets/:id/messages  — seller reply (body: {body})
POST   /api/support/tickets/:id/csat      — rate CSAT (body: {score, comment?})
POST   /api/support/tickets/:id/close     — seller closes own ticket
POST   /api/support/tickets/:id/reopen    — reopen within 7d of close
GET    /api/support/templates             — list active ticket templates
GET    /api/support/unread-count          — widget badge
POST   /api/support/messages/:id/read     — mark seller_read_at
POST   /api/support/messages/:id/react    — add/remove reaction (Phase 13 PR7)
GET    /api/support/search?q=...          — tsvector search own shop's tickets (Phase 13 PR4)
POST   /api/support/tickets/:id/attachments  — upload (Phase 13 PR3)
GET    /api/support/presence/:ticketId    — heartbeat + fetch others' presence (Phase 13 PR1)
```

### 4.2 God admin endpoints

```
GET    /api/god-admin/support/inbox              — cross-shop inbox with filters
GET    /api/god-admin/support/inbox/counts       — counts per view (unassigned, sla_breached, etc.)
GET    /api/god-admin/support/saved-views        — agent's saved filter views
POST   /api/god-admin/support/saved-views        — create view
DELETE /api/god-admin/support/saved-views/:id    — delete view

GET    /api/god-admin/support/tickets/:id        — full detail (includes internal notes)
POST   /api/god-admin/support/tickets/:id/claim  — assign to self
POST   /api/god-admin/support/tickets/:id/assign — assign to agent (body: {agent_id})
POST   /api/god-admin/support/tickets/:id/status — change status
POST   /api/god-admin/support/tickets/:id/priority — change priority
POST   /api/god-admin/support/tickets/:id/tags   — add tags (body: {tag_ids[]})
DELETE /api/god-admin/support/tickets/:id/tags/:tagId — remove tag
POST   /api/god-admin/support/tickets/:id/merge  — merge into another (body: {target_ticket_id})
POST   /api/god-admin/support/tickets/:id/snooze — snooze (body: {until}) — hides from queue

POST   /api/god-admin/support/tickets/:id/messages         — reply or internal note (body: {body, is_internal_note})
POST   /api/god-admin/support/tickets/:id/messages/draft   — save draft (auto-saved every 10s)
GET    /api/god-admin/support/tickets/:id/messages/draft   — retrieve saved draft
PUT    /api/god-admin/support/messages/:id                 — edit (within 5min + audit to support_message_edits)
DELETE /api/god-admin/support/messages/:id                 — soft delete (sets deleted_at)

GET    /api/god-admin/support/canned-replies     — list
POST   /api/god-admin/support/canned-replies     — create
PUT    /api/god-admin/support/canned-replies/:id — update
DELETE /api/god-admin/support/canned-replies/:id — deactivate

GET    /api/god-admin/support/templates          — list ticket templates
POST   /api/god-admin/support/templates          — create (CRUD)

GET    /api/god-admin/support/tags               — list tags
POST   /api/god-admin/support/tags               — create

GET    /api/god-admin/support/agents             — list agents with profiles
PUT    /api/god-admin/support/agents/:userId/profile — update display_name, skills, etc.

POST   /api/god-admin/support/bulk-actions       — bulk close/assign/tag/priority (body: {ticket_ids[], action, payload})

GET    /api/god-admin/support/audit              — cross-shop audit browser (paginated)
GET    /api/god-admin/support/audit/search?q=..  — tsvector search across all shops
GET    /api/god-admin/support/audit/export       — CSV export (PII-redacted)

GET    /api/god-admin/support/analytics          — avg response, avg resolution, CSAT, workload
GET    /api/god-admin/support/analytics/agent/:userId — per-agent scorecard

POST   /api/god-admin/support/ai/suggest-reply   — AI suggest (Phase 13 PR6)
POST   /api/god-admin/support/ai/summarize/:id   — AI summarize ticket

GET    /api/god-admin/support/automations        — list automation rules
POST   /api/god-admin/support/automations        — create
```

### 4.3 Rate limits

| Endpoint | Limit | Scope |
|----------|-------|-------|
| POST /api/support/tickets | 10/hour | per shop |
| POST /api/support/tickets/:id/messages | 60/hour | per user |
| POST /api/support/tickets/:id/attachments | 10/hour | per shop |
| POST /api/support/search | 30/min | per user |
| All god-admin endpoints | 300/min | per agent |
| POST /bulk-actions | 10/hour | per agent, max 500 tickets per call |

### 4.4 Response shape (seller) — Iron Rule 5

```typescript
// Seller GET /api/support/tickets/:id — internal notes filtered, no user_id leak
{
  id: "uuid",
  category: "payment",
  subject: "Không kết nối PayPal",
  status: "pending_seller",
  priority: "high",       // visible so seller knows urgency tier
  assigned_to: {
    display_name: "Minh",  // from support_agent_profiles — NEVER email
    avatar_url: "https://cdn.gbox.co/avatars/..."
  },
  messages: [
    {
      id: "uuid",
      sender: {
        type: "agent",
        display_name: "Minh"
        // NO user_id, NO email, NO user.username
      },
      body: "Chào chị, em đang check...",
      attachments: [],
      reactions: [{emoji:"👍", count:1, self:false}],
      edited: false,
      created_at: "..."
    }
    // agent_internal_note rows EXCLUDED at SQL level (WHERE sender_type != 'agent_internal_note')
  ],
  sla_first_response_met: true,
  csat: null
}
```

---

## 5. UI WIREFRAMES

### 5.1 Seller widget (store-admin bottom-right)

```
                                           ┌─────────────────────┐
                                           │ Hỗ trợ Gbox      ×  │
                                           ├─────────────────────┤
                                           │ [Mới] [Đang mở (2)] │
                                           │ [Đã xong]           │
                                           ├─────────────────────┤
                                           │ 🔔 T_1234  [HIGH]   │
                                           │ "Không kết nối..."  │
                                           │ Minh: "Em check..."  │
                                           │ 5 phút trước • 1 mới│
                                           ├─────────────────────┤
                                           │ T_1230              │
                                           │ "Theme không apply" │
                                           │ Thai: "Đã fix..."    │
                                           │ 2 giờ trước         │
                                           ├─────────────────────┤
                                           │ [+ Tạo yêu cầu mới] │
                                           │ [🔍 Tìm kiếm]       │
                                           └─────────────────────┘
                                            ╮──────────────────╮
                                             [?] 2   ← FAB button
                                                     (unread badge)
```

### 5.2 Seller ticket detail view (sliding panel, expanded)

```
┌─────────────────────────────────────────────┐
│ ← [T_1234] Không kết nối PayPal         ×   │
│ ──────────────────────────────────────────  │
│ payment • HIGH • đang xử lý                 │
│ Minh đang phản hồi • SLA còn 2h 14m         │
├─────────────────────────────────────────────┤
│                                              │
│           👤 Bạn (10:30)                    │
│  ┌────────────────────────────────────┐     │
│  │ Em connect PayPal không được,      │     │
│  │ báo lỗi "invalid_client"...        │     │
│  └────────────────────────────────────┘     │
│  ✓✓ đã đọc                                  │
│                                              │
│  💬 Minh (Gbox) 10:36                        │
│  ┌────────────────────────────────────┐     │
│  │ Chào chị, em đang check...         │     │
│  │ [👍 1]                              │     │
│  └────────────────────────────────────┘     │
│                                              │
│  💬 Minh đang gõ...                          │
│                                              │
├─────────────────────────────────────────────┤
│ ┌──────────────────────────────────────┐    │
│ │ Nhập tin nhắn...                     │    │
│ └──────────────────────────────────────┘    │
│ [📎]                                  [Gửi] │
└─────────────────────────────────────────────┘
```

### 5.3 God admin inbox

```
/god-admin/support/inbox

┌─────────────────────────────────────────────────────────────────┐
│ Support Inbox                          [🔍 Search]  [⚙ Settings]│
├─────────────────────────────────────────────────────────────────┤
│ VIEWS:                                                           │
│ ▸ [Tất cả chưa phân công (12)]  [Của tôi (3)]  [Đến hạn (2)]  │
│ ▸ [HIGH priority (5)]  [VIP shops (1)]  [+ Tạo view]           │
├─────────────────────────────────────────────────────────────────┤
│ FILTERS: Category ▼ Priority ▼ Status ▼ Agent ▼ Tag ▼ Date ▼  │
│ SORT: Last updated ↓                                             │
├─────────────────────────────────────────────────────────────────┤
│ ☐ T_1234 🔴 shop-xyz  "Không kết nối PayPal"     2 phút trước   │
│    payment • HIGH • unassigned • SLA: 2h 14m                    │
│    👤 lan@shop-xyz • [Claim] [Assign ▼]                         │
├─────────────────────────────────────────────────────────────────┤
│ ☐ T_1233 🟡 big-store "Theme custom CSS"        15 phút trước   │
│    technical • normal • Minh • SLA: 3h left                     │
├─────────────────────────────────────────────────────────────────┤
│ ☐ T_1232 🔵 shop-abc  "Hỏi về phí"              1 giờ trước     │
│    onboarding • low • Thai • waiting on seller                  │
├─────────────────────────────────────────────────────────────────┤
│ [Select all]  [Bulk: Close ▼] [Assign ▼] [Tag ▼]  [Export CSV] │
└─────────────────────────────────────────────────────────────────┘
```

### 5.4 God admin ticket detail

```
/god-admin/support/tickets/T_1234

┌──────────────────────────────────────────────────────────────┐
│ ← Inbox  /  T_1234                                            │
│ ┌────────────────────────────────────────────────────────┐   │
│ │ Shop: shop-xyz (→ mở shop)                             │   │
│ │ Opener: lan@shop-xyz  (user_id: uuid — hover to reveal)│   │
│ │ Category: payment   Priority: [HIGH ▼]                 │   │
│ │ Status: [open ▼]    Assignee: [Minh ▼] [Claim]         │   │
│ │ Tags: [paypal ×] [onboarding ×] [+ thêm]              │   │
│ │ SLA first: 2h 14m left | Resolution: 22h left          │   │
│ │ Created: 10:30 | Last msg: 10:36                       │   │
│ └────────────────────────────────────────────────────────┘   │
│                                                                │
│ ═══════════════════ CONVERSATION ═══════════════════          │
│                                                                │
│ 👤 Lan (seller, 10:30)                                        │
│    "Em connect PayPal không được, báo lỗi invalid_client"     │
│    ✓✓ đọc bởi Minh 10:32 • [👍] [💬 Reply]                    │
│                                                                │
│ 🔒 INTERNAL NOTE — Minh (10:35)                                │
│    "Shop đăng ký hôm qua, check onboarding_logs"               │
│    @Thai ← mentioned                                           │
│    [Edit (4m left)] [Delete]                                  │
│                                                                │
│ 💬 Minh (agent, 10:36)                                         │
│    "Chào chị, em đang check..."                                │
│    [👍 1] [Edit (4m)] [Delete] [Đánh dấu solution]            │
│                                                                │
│ 👤 Lan đang gõ...                                              │
│                                                                │
│ ═══════════════════ REPLY ═══════════════════                 │
│ ┌─ [Reply] [🔒 Internal note] [📋 Template ▼] ────────────┐   │
│ │ Cảm ơn chị đã báo. Em đang check...                    │   │
│ │                                                         │   │
│ │ [Draft đã lưu 10s trước]                               │   │
│ └────────────────────────────────────────────────────────┘   │
│ [📎 Attach] [Canned ▼] [🤖 AI suggest] [KB link 🔗]          │
│                                                                │
│                          [Lưu nháp] [Gửi & đóng] [Gửi]       │
│                                                                │
│ ═══════════════════ ACTIONS ═══════════════════               │
│ [Đóng ticket] [Chuyển agent] [Merge...] [Snooze ▼] [Escalate]│
│                                                                │
│ ═══════════════════ AUDIT TRAIL ═══════════════════           │
│ ▸ 10:30 Lan opened ticket                                     │
│ ▸ 10:32 Minh claimed (was unassigned)                         │
│ ▸ 10:35 Minh added internal note                              │
│ ▸ 10:36 Minh replied                                          │
└──────────────────────────────────────────────────────────────┘
```

### 5.5 God admin audit view (cross-shop)

```
/god-admin/support/audit

┌──────────────────────────────────────────────────────────────┐
│ Support Audit — Full Platform History                         │
│ Filter: Shop ▼  Agent ▼  Category ▼  DateRange ▼             │
│ Search: [_________________________]  [🔍]  [Export CSV]       │
├──────────────────────────────────────────────────────────────┤
│ Showing 1-50 of 2,341 tickets                                │
│                                                                │
│ T_1234 shop-xyz   payment    CLOSED  ⭐⭐⭐⭐⭐                  │
│   [42 msgs] [Minh → Thai (escalated)] [Resolved in 3h]       │
│   [Open full transcript ▼]                                   │
│                                                                │
│ T_1235 big-store  technical  RESOLVED  ⭐⭐⭐                  │
│   [8 msgs] [Minh] [Resolved in 45m] [Tags: theme, css]       │
│                                                                │
│ [...]                                                         │
└──────────────────────────────────────────────────────────────┘
```

### 5.6 Agent analytics (god-admin dashboard)

```
/god-admin/support/analytics

┌──────────────────────────────────────────────────────────────┐
│ Support Analytics — Last 30 days                              │
├──────────────────────────────────────────────────────────────┤
│ ┌──────────────┬──────────────┬──────────────┬──────────────┐ │
│ │ Open tickets │ First resp.  │ Resolution   │ CSAT avg     │ │
│ │     42       │    1h 23m    │    8h 45m    │   4.6/5      │ │
│ │  (↓ 12%)     │  (↑ 15%)     │  (↓ 5%)      │  (↑ 0.2)     │ │
│ └──────────────┴──────────────┴──────────────┴──────────────┘ │
│                                                                │
│ Volume by day: [bar chart 30 days]                           │
│ Category mix:  payment 42% | technical 28% | onboarding 18% │
│ SLA breach:    3 tickets (0.8%)                              │
│                                                                │
│ Agent scorecard:                                              │
│  Thai:  95 tickets | 1h 12m avg | CSAT 4.7 | 0 SLA breach   │
│  Minh:  38 tickets | 1h 48m avg | CSAT 4.5 | 2 SLA breach   │
│                                                                │
└──────────────────────────────────────────────────────────────┘
```

---

## 6. FEATURE DEPTH ("perfect system" breakdown)

### 6.1 Message UX
- [x] Markdown rendering (subset: bold, italic, code, link, list)
- [x] Emoji picker
- [x] Reactions (6 emojis: 👍 ❤️ 🎉 😄 😢 🙏)
- [x] Read receipts (✓ sent, ✓✓ read — toggleable per-shop setting)
- [x] Typing indicators (Phase 13 PR1 WS)
- [x] Message edit within 5min window (audit to `support_message_edits`)
- [x] Soft delete (deleted_at + deleted_by, god admin still sees)
- [x] Draft auto-save every 10s (reply + internal note separately)
- [x] Keyboard shortcut Cmd+Enter to send
- [x] @mention support agents in internal notes

### 6.2 Ticket lifecycle
- [x] 6 statuses: `open` → `pending_agent` → `pending_seller` → `resolved` → `closed` + `merged`
- [x] 4 priorities: `low`, `normal`, `high`, `urgent`
- [x] 6 categories + extensible via admin
- [x] Manual claim / assign / reassign
- [x] Smart auto-assign (skill-based, Phase 13 PR8)
- [x] Merge duplicates (two tickets same seller same issue → one canonical)
- [x] Snooze (hide from active queue until X)
- [x] Escalation chain: level 1 agent → level 2 → Thai
- [x] Seller can reopen within 7d of close
- [x] Auto-close after 7d inactivity on `pending_seller` (configurable)

### 6.3 Agent workflow
- [x] Saved views (custom filters per agent, sharable)
- [x] Inbox sort by priority / SLA deadline / last updated
- [x] Workload cap (max N concurrent per agent — auto-decline new auto-assigns)
- [x] Business hours (SLA only counts business hours if flag set)
- [x] SLA pause when `status=pending_seller` (clock resumes when seller replies)
- [x] Canned replies with variable interpolation (`{{seller.display_name}}`, `{{shop.name}}`, `{{ticket.subject}}`)
- [x] Ticket templates (pre-filled forms seller picks from)
- [x] Bulk actions (close N, assign N, tag N, priority N)
- [x] Internal @mentions trigger notifications
- [x] Keyboard command palette (agents-only): `/` opens quick actions
- [x] Agent presence: online/away/offline (derived from last WS heartbeat)
- [x] Side conversation / consult internally (future Phase 14)

### 6.4 SLA + automation
- [x] Per-category SLA defaults (payment=2h first/12h resolve, others=4h/24h)
- [x] Per-shop overrides via `support_sla_overrides` (future, if VIP shops)
- [x] Cron every 5 min: detect breach → INSERT event → escalate → notify
- [x] Automations (Zendesk-style triggers):
  - `ticket_created` → auto-tag if subject matches regex
  - `no_agent_response_1h` → reassign to next available
  - `inactivity_3d` → auto-reminder email to seller
  - `inactivity_7d` → auto-close + CSAT prompt
- [x] CSAT prompt auto-fires 1h after ticket close
- [x] CSAT low score (<3) triggers escalation to Thai

### 6.5 Search + audit
- [x] Seller can search own shop's tickets (tsvector on subject + decrypted-then-reindexed body)
- [x] God admin can search cross-platform
- [x] Filter by agent, shop, category, priority, status, tag, date range
- [x] Export CSV (PII-redacted when `--redact-pii` flag set)
- [x] Full transcript export per ticket (TXT + JSON)

### 6.6 Analytics
- [x] Platform-wide: open count, first-response avg, resolution avg, CSAT, SLA breach rate
- [x] Category mix, time-of-day heatmap, day-of-week pattern
- [x] Per-agent: tickets handled, avg times, CSAT, breach count, workload history
- [x] Top canned replies (usage count — helps identify new macros to create)
- [x] Top tags (what's trending)
- [x] Exports for Thai's quarterly reviews

### 6.7 AI assist (Phase 13 PR6)
- [x] "Suggest reply" button → Claude via `@gbox/core/modules/ai`
- [x] "Summarize this ticket" → 3-bullet summary for long threads
- [x] Auto-categorize on ticket create (suggest category, agent confirms)
- [x] Sentiment analysis on incoming seller messages (flag angry → priority bump)
- [x] Budget cap: $50/mo configurable via platform_settings

### 6.8 Notifications
- [x] Browser push (Web Push API, opt-in) for seller when agent replies
- [x] Email fallback if seller offline > 5min (rate-limited: max 1/hour per ticket)
- [x] Agent notifications:
  - New unassigned ticket in my view
  - Ticket assigned to me
  - @mention in internal note
  - SLA breach on my ticket
  - Seller replied to my ticket
- [x] Notification channels: in-app toast + browser push + email digest
- [x] Preferences per user: toggle each notification type

### 6.9 Security + privacy
- [x] AES-256-GCM encryption at rest on message body
- [x] Key rotation support (`body_key_version` column)
- [x] PII redaction in exports (credit cards, SSNs, Vietnamese CMND)
- [x] Rate limits on every write endpoint
- [x] CSRF protection on every mutation
- [x] Iron Rule 5 guard: seller API response schema stripped of god-admin terms
- [x] Separate permissions: `support:respond:write` vs `support:audit:read`
- [x] Cross-shop leak prevention: every seller query WHERE-clause gated

### 6.10 Accessibility + i18n
- [x] aria-live region announces new messages
- [x] Keyboard navigation through inbox + detail
- [x] Focus trap in modal dialogs
- [x] VN + EN UI strings (via existing `@gbox/core/modules/i18n`)
- [x] RTL preparation (future Arabic/Hebrew)
- [x] WCAG 2.1 AA compliance target

---

## 7. PHASE BREAKDOWN

### 7.1 Phase 12.5 — MVP (parallel với beta launch) — **6 PRs, ~10 days eng**

**Scope:** đủ cho 5K-10K sellers beta week 1 + dedicated staff portal +
AI Support layer 1 (Hybrid Sonnet+Opus). Ship 10 ngày sau khi Sprint 0
merge (merged 2026-04-22 as 0060f2c).

| PR | Scope | Effort | Tests target |
|----|-------|--------|--------------|
| **PR1** | DB migrations 078-083 + crypto (reuse oauth-token-crypto pattern) + rate limit + core service | 2 ngày | 50+ unit |
| **PR2** | Seller widget UI (Option B ticket list, Messenger blue #0084FF, pulse ring, silent) + merchant API + polling 3s + CSAT | 1.5 ngày | 15 integ |
| **PR3** | **supporter.gbox.co staff portal** — new Astro app (:4325) + nginx + PM2 + 3 permission presets (L1/L2/Lead) + staff invite flow (migrations 086-087) + god-admin mirror | 2 ngày | 30 integ |
| **PR4** | **AI Support Hybrid Sonnet+Opus** — @gbox/core/modules/support-ai (pickModel logic, confidence ≥0.85 trigger Opus, $200/mo budget cap, per-shop key under platform_settings) | 2 ngày | 25 unit |
| **PR5** | SLA cron (payment 2h/12h, others 4h/24h, hybrid BH) + notifications (in-app + email fallback) + CSAT auto-prompt +1h | 1.5 ngày | 15 unit |
| **PR6** | Polish + smoke-phase12-5-support end-to-end + release-check + deploy | 1 ngày | E2E smoke |

**MVP boundaries (explicit cut — deferred to Phase 13):**
- No WebSocket (polling 3s only — Phase 13 PR1)
- No attachments / GDrive (Phase 13 PR3 full defense stack)
- No presence/typing (Phase 13 PR1)
- No edit/delete messages (Phase 13 PR7)
- No full-text search (seller scrolls; god admin uses filters — Phase 13 PR4)
- No AI layer 2 fully-auto replies (Phase 14+ after accuracy proof; MVP = layer 1 suggest-only)
- No bulk actions (Phase 13 PR8)
- No tags (use categories for now; Phase 13 PR8)
- No saved views (hardcoded: All / Mine / Due today / HIGH priority; Phase 13 PR8)
- No auto-assign algorithm (manual claim; Phase 13 PR8)

**Acceptance (Phase 12.5):**
- [ ] Seller tạo ticket → 3s sau supporter thấy
- [ ] Agent reply → 3s sau seller thấy
- [ ] Internal note invisible in seller API response (SQL-layer filter + unit test)
- [ ] Message body encrypted at rest AES-256-GCM (verify via DB dump)
- [ ] Rate limit enforced (10 tickets/hour/shop, 60 messages/hour/user)
- [ ] Iron Rule 5: grep seller API responses for 'god'/'admin'/'god_admin' → 0 hits
- [ ] SLA cron fires + auto-escalates (payment=2h, others=4h)
- [ ] CSAT prompt gửi 1h sau close
- [ ] AI Support hybrid pickModel selects Opus only when confidence ≥0.85 + keywords present
- [ ] supporter.gbox.co reachable via nginx + PM2 online
- [ ] L1 preset denied: orders, customers, revenue, billing (403 on route gate)
- [ ] Staff invite token SHA-256 hash + 7-day TTL works
- [ ] Release-check green
- [ ] Smoke matrix green on server 2

### 7.2 Phase 13 — Full polish

| PR | Scope | Effort |
|----|-------|--------|
| **PR1** | WebSocket (Socket.IO + Redis adapter) + presence + typing | 3 ngày |
| **PR2** | Canned replies DB CRUD + macros variables + ticket templates + agent profile | 2 ngày |
| **PR3** | Attachments (S3 + ClamAV + signed URL) | 3 ngày |
| **PR4** | Full-text search + god-admin audit view + exports | 2 ngày |
| **PR5** | Analytics dashboard + agent scorecard + CSV exports | 2 ngày |
| **PR6** | AI assist (Claude): suggest reply, summarize, auto-categorize, sentiment | 3 ngày |
| **PR7** | Advanced messages: edit+history, soft delete, reactions, read receipts | 2 ngày |
| **PR8** | Workflow: tags + bulk actions + merge + workload cap + auto-close + @mentions + business hours SLA + automations | 3-4 ngày |

**Total Phase 13:** ~20-22 engineering days.

---

## 8. SECURITY

| Layer | Control |
|-------|---------|
| Transport | HTTPS everywhere, WSS for Socket.IO |
| Session | Existing merchant + god-admin session middleware |
| CSRF | Double-submit cookie on all POST/PUT/DELETE |
| Rate limit | Per-user + per-shop + per-endpoint (see §4.3) |
| Encryption at rest | AES-256-GCM body + IV + tag + key_version |
| Key management | Env var `SUPPORT_MESSAGE_ENCRYPTION_KEY` (64-char hex) |
| Key rotation | Multi-key: new key encrypts, old key still decrypts until `scripts/ops/reencrypt-support.ts` migration |
| PII scrubbing | Regex detect on export (CC, SSN, VN CMND) → redact before serialize |
| Impersonation | `sender_user_id` always from authenticated session, never from request body |
| Cross-shop leak | Every seller query `WHERE shop_id = $auth_shop_id` + automated unit test |
| Internal notes | `sender_type='agent_internal_note'` filtered at SQL layer, not just UI |
| Audit | `support_ticket_events` append-only, retained 7 years |
| Attachment scan | ClamAV pre-persist → reject + quarantine if infected |
| Attachment serve | Signed S3 URL, 7-day TTL for seller, indefinite for god admin |
| Permission matrix | `support:respond:write` (reply) vs `support:audit:read` (read any shop) — Thai has both |

---

## 9. TELEMETRY + OBSERVABILITY

**Metrics (prometheus-compatible):**
- `gbox_support_tickets_open` (gauge, by category + priority)
- `gbox_support_tickets_unassigned` (gauge)
- `gbox_support_first_response_seconds` (histogram)
- `gbox_support_resolution_hours` (histogram)
- `gbox_support_messages_total` (counter, by sender_type)
- `gbox_support_csat_score` (histogram)
- `gbox_support_sla_breaches_total` (counter)
- `gbox_support_agent_workload` (gauge, by agent)
- `gbox_support_ai_suggestions_accepted_ratio` (gauge)

**Logs (pino):**
- Every state change: `{ ticketId, shopId, agentId, from, to, action, durationMs }`
- Every message: `{ ticketId, messageId, senderType, bodyLength }`
- Rate limit hits: `{ userId, endpoint, limit, window }`
- Encryption failures: `{ messageId, error }` — these are pages

**Alerts:**
- SLA breach rate > 5% in 1h → page Thai
- Encryption round-trip failure → page (data loss risk)
- Unassigned > 50 → warn in slack-equivalent
- Agent workload > cap for 30min → warn (auto-scale or hire signal)
- AI budget 80% monthly → warn

---

## 10. DECISION POINTS — **LOCKED v3** (29 Q + 3 C, all owner-confirmed 2026-04-21/22)

> Locked. No further changes without new spec revision.

### 10.1 Q1–Q7 Fundamentals

| # | Decision | LOCK |
|---|----------|------|
| **Q1.1** | Ship Phase 12.5 MVP parallel beta week 1 | **YES** (parallel) |
| **Q1.2** | Seller widget position + identity | **Bottom-right "G" button, Messenger blue #0084FF** |
| **Q1.3** | Agent interface location | **Top-right messenger-style icon (store-admin) + full dashboard on supporter.gbox.co** |
| **Q1.4** | Real-time transport MVP | **Polling 3s (WebSocket → Phase 13 PR1)** |
| **Q1.5** | Encryption at rest | **From PR1 day 1. AES-256-GCM reuse oauth-token-crypto pattern** |
| **Q1.6** | AI Support tier | **Hybrid Sonnet 4.5 + Opus 4, $200/mo cap, per-shop key under platform_settings** |
| **Q1.7** | Storage for attachments | **DB pointers + S3 (hot 90d) + NAS mirror (30d) + Glacier Deep Archive (forever)** |

### 10.2 Q8–Q14 UX + Notifications

| # | Decision | LOCK |
|---|----------|------|
| **Q2.8** | Widget animation when agent replies | **Gentle pulse radial ring (no bounce, no spin)** |
| **Q2.9** | Widget sound | **SILENT by default. Browser push optional opt-in.** |
| **Q2.10** | Ticket list UX | **Option B: Full list with search + filter + tabs (Open / Resolved / KB)** |
| **Q2.11** | SLA defaults | **Payment 2h/12h, others 4h/24h, hybrid BH (payment 24/7, others 8-18 ICT)** |
| **Q2.12** | Agent display name to seller | **"FirstName (Gbox)" per-agent display_name. No email leak.** |
| **Q2.13** | CSAT trigger | **Auto 1h after close. <3 score escalates to Thai.** |
| **Q2.14** | Auto-close inactivity on pending_seller | **7d inactive → auto-close. Reopen window +7d.** |

### 10.3 Q15–Q21 Staff Portal + Permissions

| # | Decision | LOCK |
|---|----------|------|
| **Q3.15** | Staff portal location | **supporter.gbox.co (dedicated subdomain, Astro SSR :4325)** |
| **Q3.16** | Contact/help page | **support.gbox.co** (public, links to widget + KB) |
| **Q3.17** | Permission presets | **3 presets: L1 Support / L2 Support Senior / Lead Support** (see §10.7) |
| **Q3.18** | Preset deny list (L1+L2+Lead) | **orders / customers / revenue / billing — ZERO access** |
| **Q3.19** | God-admin-only (not in any preset) | **Staff management, AI config, platform settings, payment data** |
| **Q3.20** | Staff login model | **Email invite → SHA-256 token_hash → 7-day TTL → bcrypt password + 2FA required for Lead** |
| **Q3.21** | Agent workload cap | **Default 20 concurrent. Auto-decline new auto-assigns past cap.** |

### 10.4 Q22–Q29 Infrastructure + Ops

| # | Decision | LOCK |
|---|----------|------|
| **Q4.22** | Office NAS | **Synology DS1821+ RAID6 48TB + mirror support attachments 30d** |
| **Q4.23** | Cold archive | **AWS S3 Glacier Deep Archive forever, $0.00099/GB/mo** |
| **Q4.24** | DB retention | **1 year hot in Postgres. Quarterly cleanup script archives to cold + deletes.** |
| **Q4.25** | Dev mini-PC | **Existing dev mini-PC (192.168.1.13 = botesty) unchanged. AI GPU local deferred to Phase 14+.** |
| **Q4.26** | Backup strategy | **Daily pg_dump to NAS + weekly S3 upload. Retention: 30 daily + 12 weekly + 7 yearly.** |
| **Q4.27** | Attachment defense | **7-layer stack: size + mime + magic + ClamAV + sharp re-encode + pdf-lib sanitize + signed URL** |
| **Q4.28** | Virus scanner | **ClamAV on server 1 (botesty, not managed AWS Macie)** |
| **Q4.29** | GDrive service account | **support-archiver@gbox-platform-prod.iam.gserviceaccount.com, OAuth2 offline refresh token** |

### 10.5 C1–C5 Clarifications

| # | Clarify | LOCK |
|---|---------|------|
| **C1** | AI model tier confirm | **Hybrid Sonnet+Opus (API pay-per-token, not Claude Max consumer)** |
| **C2** | When AI API key configured | **Thai adds later via god-admin /settings/ai. Code supports null key → falls back to human-only mode.** |
| **C3** | Staff portal hostname | **supporter.gbox.co (not agent. or support-portal. — locked)** |
| **C4** | Public support contact page | **support.gbox.co (separate from supporter. — staff vs public split)** |
| **C5** | 3 permission presets | **ACCEPTED as drafted: L1, L2, Lead with explicit deny matrix** |

---

## 10.6 AI SUPPORT ARCHITECTURE (Hybrid Sonnet + Opus — layer 1)

**Module:** `packages/core/src/modules/support-ai/`
**Status:** Phase 12.5 PR4 ships layer 1 (suggest-only). Layer 2 (auto-reply) deferred to Phase 14+ after 30-day accuracy proof.

### 10.6.1 Decision logic — `pickModel()`

```ts
// packages/core/src/modules/support-ai/pick-model.ts
export function pickModel(ticket: TicketSnapshot, confidence: number): 'sonnet-4-5' | 'opus-4' {
  // Payment + legal + refund-dispute: always Opus (high cost of error)
  if (ticket.category === 'payment' && ticket.priority !== 'low') return 'opus-4';
  if (/(chargeback|dispute|legal|lawyer|report|fraud)/i.test(ticket.subject)) return 'opus-4';
  // High-confidence judgment needed: Opus
  if (confidence >= 0.85) return 'opus-4';
  // Everything else: Sonnet
  return 'sonnet-4-5';
}
```

### 10.6.2 Budget cap + kill-switch

- Monthly cap: **$200** (configurable in `platform_settings` via god-admin).
- Hard stop at cap: `isAIEnabled = false` — all AI surfaces gray out, agents work unassisted.
- Soft warn at 80%: pager alert to Thai.
- Per-call cost logged in `support_ai_usage` (month_key, model, input_tokens, output_tokens, cost_usd, ticket_id).

### 10.6.3 Four AI surfaces (layer 1)

| Surface | Model | Trigger |
|---------|-------|---------|
| Suggest reply | Sonnet (default) or Opus (high-stakes) | Agent clicks "AI suggest" |
| Summarize thread | Sonnet | Agent opens ticket with >10 messages |
| Auto-categorize on create | Sonnet | Incoming ticket (agent confirms in 1 click) |
| Sentiment flag | Sonnet | Every incoming seller message (bulk batch every 5min) |

### 10.6.4 PII redaction before prompt

Regex strip: credit cards (Luhn), SSN, VN CMND (9-12 digits), PayPal email addresses. Replace with `[REDACTED-CC]`, `[REDACTED-SSN]`, `[REDACTED-ID]`, `[REDACTED-EMAIL]` before sending to Claude.

### 10.6.5 Null-key fallback (C2)

If `platform_settings.ai.anthropic_api_key` is null:
- All AI buttons render disabled with tooltip "AI trợ lý chưa cấu hình"
- `pickModel()` returns null → calling code throws `AINotConfiguredError` → UI catches → toast "Liên hệ Gbox support để bật AI"
- God admin sees actionable hint in `/god-admin/settings/ai`: "Chưa có key. Dán key vào đây."

---

## 10.7 PERMISSION PRESETS MATRIX (3 presets — LOCKED)

**Module:** `packages/core/src/modules/support-staff/permissions.ts`
**Enforcement:** route middleware `requireSupportPermission(scope)` + SQL-layer `WHERE`.

| Permission scope | L1 Support | L2 Support Senior | Lead Support | God Admin |
|------------------|:----------:|:-----------------:|:------------:|:---------:|
| `support:ticket:read` | ✅ | ✅ | ✅ | ✅ |
| `support:ticket:reply` | ✅ | ✅ | ✅ | ✅ |
| `support:ticket:internal_note` | ✅ | ✅ | ✅ | ✅ |
| `support:ticket:claim` | ✅ | ✅ | ✅ | ✅ |
| `support:ticket:assign_others` | ❌ | ✅ | ✅ | ✅ |
| `support:ticket:priority_change` | ❌ | ✅ | ✅ | ✅ |
| `support:ticket:status_change` | partial (open/pending only) | ✅ | ✅ | ✅ |
| `support:ticket:merge` | ❌ | ✅ | ✅ | ✅ |
| `support:ticket:delete_message` | ❌ | ❌ | ✅ | ✅ |
| `support:canned_replies:manage` | ❌ | ✅ | ✅ | ✅ |
| `support:audit:cross_shop` | ❌ | partial (assigned only) | ✅ | ✅ |
| `support:analytics:self` | ✅ | ✅ | ✅ | ✅ |
| `support:analytics:team` | ❌ | ❌ | ✅ | ✅ |
| `support:ai:use` | ✅ | ✅ | ✅ | ✅ |
| `support:ai:configure` | ❌ | ❌ | ❌ | ✅ god-only |
| `support:staff:invite` | ❌ | ❌ | ❌ | ✅ god-only |
| `support:staff:manage` | ❌ | ❌ | ❌ | ✅ god-only |
| `support:shop:orders_read` | **❌ DENY** | **❌ DENY** | **❌ DENY** | ✅ |
| `support:shop:customers_read` | **❌ DENY** | **❌ DENY** | **❌ DENY** | ✅ |
| `support:shop:revenue_read` | **❌ DENY** | **❌ DENY** | **❌ DENY** | ✅ |
| `support:shop:billing_read` | **❌ DENY** | **❌ DENY** | **❌ DENY** | ✅ |
| 2FA required | optional | recommended | **mandatory** | mandatory |

**Rationale for deny list:**
Support agents need ticket content + shop name + seller display name + category.
They do NOT need order data, customer PII, revenue, or billing. Minimizes blast radius
of a compromised L1 account. Iron Rule 1 data minimization.

**Audit:** every `requireSupportPermission()` denial → `support_audit_log` (actor, scope, deny_reason, request_path, ts).

---

## 10.8 ATTACHMENT DEFENSE STACK (7 layers — Phase 13 PR3 full, Phase 12.5 PR1 schema-only)

1. **Size limit:** max 25 MB/file, max 5 files/message.
2. **MIME whitelist:** `image/{jpeg,png,webp,gif}`, `application/pdf`, `video/mp4`, `text/plain`. Everything else rejected.
3. **Magic byte verification:** `file-type` package sniffs actual bytes; MIME header ignored. Mismatch → reject.
4. **ClamAV scan (server 1):** `clamd` daemon + `clamdscan` call. Signature DB updated daily via `freshclam` cron. Quarantine + alert on hit.
5. **Sharp re-encode (images):** decode → strip EXIF → re-encode at quality 85 → upload only re-encoded file. Strips embedded scripts + polyglot attacks.
6. **pdf-lib sanitize (PDF):** parse → drop JavaScript actions, drop embedded files, drop forms (if !`preserve_forms`) → re-emit.
7. **Signed URL TTL:** seller downloads via S3 pre-signed URL, 7d TTL for seller, indefinite for god admin via separate signing path. Never direct-link.

Schema in migration 080 `support_attachments`:
```
id, message_id, uploader_user_id, mime, size_bytes, sha256,
s3_key, nas_key, glacier_archive_id, status (pending|clean|infected|quarantine),
scan_result_json, original_filename, safe_filename, created_at
```

---

## 10.9 GOOGLE DRIVE INTEGRATION (long-term cold mirror — Phase 13+ optional)

**Service account:** `support-archiver@gbox-platform-prod.iam.gserviceaccount.com`
**Auth:** OAuth2 offline refresh token, stored encrypted in `platform_settings.gdrive`.
**Scope:** `https://www.googleapis.com/auth/drive.file` (only files created by this app).

**Flow:**
- Weekly cron: collect `support_attachments` older than 90d, status=clean.
- Upload to GDrive folder `Gbox Support Archive / YYYY / MM / shop_{id} /`.
- Update `support_attachments.gdrive_file_id`.
- Primary S3 copy stays until 180d, then Lifecycle → Glacier Deep Archive.
- Retrieval path: Glacier restore job (12-48h) OR GDrive download (<5 min).

**Benefit:** GDrive gives Thai eyeball access without AWS console; Glacier gives cheap long-term forever.

---

## 11. RISK REGISTER (revised, bridges removed)

| # | Risk | Likelihood | Impact | Mitigation |
|---|------|------------|--------|------------|
| 1 | Sellers không biết widget — spam email Thai | HIGH | MEDIUM | Onboarding wizard hiển thị widget; email footer "reply không vào inbox Thai — click here" |
| 2 | Solo Thai agent SLA burn | MEDIUM | HIGH | D5 — hire backup Minh tuần 2; auto-escalate critical về Thai only |
| 3 | Encryption key rotation làm cũ messages unreadable | LOW | CRITICAL | Multi-key support (`body_key_version`); re-encrypt migration script |
| 4 | Cross-shop leak qua agent interface | LOW | CRITICAL | Unit test: agent claim shop X, GET /tickets?shop=Y returns empty; smoke daily |
| 5 | God admin audit export chứa PII | MEDIUM | HIGH | Export path redact regex + test fixture |
| 6 | Internal notes leak to seller via wrong API | LOW | HIGH | Unit test: INSERT agent_internal_note, GET seller API expect absent |
| 7 | WS Redis adapter down → all agents offline | MEDIUM | MEDIUM | Polling fallback always available as graceful degrade |
| 8 | AI suggest leaks sensitive data into prompt | LOW | HIGH | Redact PII from prompt before send; log prompt hash for audit |
| 9 | Ticket storm: 1 bug affects 1000 sellers | MEDIUM | HIGH | Admin "broadcast" feature (Phase 13 PR8 stretch): merge duplicates, single reply to N |
| 10 | Seller opens 10K spam tickets to abuse agents | LOW | MEDIUM | Rate limit 10/hour/shop + abuse detection (>20 tickets in 24h → auto-flag for review) |

---

## 12. ACCEPTANCE CRITERIA

### Phase 12.5 MVP ready khi:

- [ ] PR1-PR4 merged to master
- [ ] Unit tests green (target 80+ tests across support module)
- [ ] Smoke test `scripts/smoke-phase12-5-support.ts` end-to-end:
  - seller creates ticket → god admin sees within 3s
  - agent claims + replies → seller sees within 3s
  - seller rates CSAT → stored + visible in analytics
  - seller closes ticket → state=closed
  - agent adds internal note → invisible in seller API response
- [ ] Iron Rule 5 check: grep seller API responses for 'god' / 'admin' / 'god_admin' → 0 hits (excluding legitimate like 'domain', 'administration' in body content)
- [ ] Encryption round-trip verified (decrypt returns original body)
- [ ] SLA cron tick fires on staging
- [ ] Release-check green
- [ ] Thai tested widget in seed shop, Thai as solo agent

### Beta opens với support khi:

- [ ] Phase 12.5 acceptance criteria met
- [ ] 10 canned replies soạn trước cho PayPal onboarding
- [ ] Thai commits 8am-10pm ICT ngày đầu cho beta support
- [ ] Backup agent roster defined (§D5)

### Phase 13 ready khi (post-beta):

- [ ] PR1-PR8 merged
- [ ] 200+ unit tests across support module
- [ ] WS failure mode tested: kill Redis → polling takes over gracefully
- [ ] Attachments: virus scan positive case tested (EICAR test file)
- [ ] AI budget: synthetic burn test hit $40/mo pace, alert fires
- [ ] Analytics dashboard loads < 2s on 10K ticket dataset
- [ ] All wireframe features shipped

---

## 13. OPEN QUESTIONS — **ALL RESOLVED 2026-04-22**

All prior open questions resolved via Q1–Q29 + C1–C5 lock. See §10.

| Prior question | Resolution |
|----------------|-----------|
| Agent roster for beta | Thai solo + staff invite via supporter.gbox.co for backup. Q3.20 locked flow. |
| Ship parallel with beta | YES. Q1.1 locked. |
| AI budget | **$200/mo** hybrid Sonnet+Opus (was $50/mo in v2). Q1.6 locked. |
| Notification channel | Browser push + email fallback + widget badge. Q2.9 locked silent by default. |
| Business hours SLA | Hybrid (payment 24/7, others 8-18 ICT). Q2.11 locked. |
| Customer↔shop-owner chat | Out of scope Phase 12.5/13. See §14.1 future extension. |

---

## 14. FUTURE EXTENSIONS (không trong Phase 13, ghi để architecture không lock-in)

### 14.1 Customer ↔ shop-owner chat
Nếu Phase 14 cần customer chat với shop owner (trên storefront):
- Reuse `support_*` tables với thêm cột `scope` = 'platform' (seller↔Gbox) hoặc 'shop' (customer↔shop)
- `shop_id` + `scope='shop'` = customer tickets, không cross-leak vào inbox Gbox
- Agent-side UI: shop owner mở /{slug}/admin/support — thấy tickets của shop mình chỉ
- God admin vẫn thấy toàn platform (cả 2 scope) để audit

### 14.2 Staff-internal chat (Slack-replacement)
Nếu team support có 5+ agents cần chat nội bộ (không qua ticket):
- Thêm `support_rooms` + `support_room_members` tables
- Reuse message crypto + WS infra
- Keep ticket system untouched

### 14.3 Knowledge base integration
- `support_kb_article_links` đã có ở migration 083 cho hook này
- Phase 14 build KB (Markdown articles), agent reply suggest "đọc thêm: {article}"
- AI assist include KB in prompt context for better replies

### 14.4 Public status page
- Khi platform incident, auto-broadcast sang status.gbox.co + pause SLA on all affected tickets
- Phase 14+ feature

---

## 15. IRON RULE COMPLIANCE MATRIX

| Rule | How spec enforces |
|------|-------------------|
| 1 Security First | §8 full security stack; encryption at rest day 1 |
| 2 Admin hierarchy | §4 permission matrix (`support:respond:write` vs `support:audit:read`); Thai = god_admin inherits both |
| 3 Workflow-first | §2 mindmap; §10 decision points; no code until owner signs off |
| 4 Logging | §9 telemetry + alerts; `support_ticket_events` append-only for 7 years |
| 5 No god-admin leak | §4.4 seller response shape; §6.1 `sender_type` filter at SQL; §12 grep test |

---

---

## 16. INFRASTRUCTURE STRATEGY (hybrid cloud + on-prem — LOCKED)

### 16.1 Role split

| Role | Host | Purpose |
|------|------|---------|
| Production API + DB + admin + accounts + storefront | **3 Ubuntu servers** (current, 192.168.1.13-15) | Same as today; deploy pipeline unchanged |
| Support staff portal | **supporter.gbox.co → server 1 :4325** | New Astro app, nginx-proxied, PM2 |
| AI inference | **Anthropic API (cloud)** | Hybrid Sonnet+Opus pay-per-token, $200/mo cap |
| Hot attachments (0-90d) | **AWS S3 Standard** | `gbox-support-attachments-prod` |
| Mirror attachments (0-30d) | **Synology DS1821+ NAS (48TB RAID6)** | Office LAN; rsync nightly |
| Cold attachments (90d+) | **AWS S3 Glacier Deep Archive** | Lifecycle rule; retrieval 12-48h |
| Long-term human-access mirror | **Google Drive (service account)** | Weekly cron upload for easy eyeball |
| Daily DB dumps | **NAS + weekly S3** | 30 daily + 12 weekly + 7 yearly retention |
| Dev + experimentation | **Mini-PC (existing, 192.168.1.13 role)** | Unchanged; AI GPU local = **Phase 14+ only** |

### 16.2 NAS details

- Model: Synology DS1821+
- Disks: 8× 8TB NAS-grade in SHR2 (RAID6 equivalent) = ~48TB usable
- Network: 2.5GbE to office switch; connects to server 1 via IPsec VPN
- Role: attachment mirror + DB dump destination + offline backup vault
- SMB share name: `\\nas.gbox.local\support-archive\`

### 16.3 Why hybrid (not pure cloud, not pure on-prem)

- **Pure cloud:** S3 Glacier retrieval 12-48h kills support agent productivity when they need a 90-day-old attachment now.
- **Pure on-prem:** office power/internet outage = platform down. Sellers lose trust.
- **Hybrid:** cloud for production uptime; on-prem for warm archive + zero-cost experimentation (dev mini-PC).

### 16.4 GDrive as tertiary

GDrive isn't a primary store — it's a human-friendly preview layer on top of Glacier.
Glacier has SLA + compliance guarantees; GDrive has Thai-can-browse-from-phone convenience.
If GDrive goes away tomorrow, Glacier still has every file.

### 16.5 AI GPU local (deferred)

Deferred to **Phase 14+**. Rationale:
- Anthropic API Sonnet+Opus quality > any self-hosted <70B model.
- $200/mo cap = much cheaper than amortized GPU cost for MVP volume.
- Revisit when Gbox has >100K tickets/mo AND workload has stable, narrow patterns suitable for fine-tuned open model.

---

## END OF SPEC v3 — **LOCKED 2026-04-22**

**Status:** LOCKED for execution. 29 Q + 3 C decisions captured in §10.
**Next:** implementation plan → `feat/phase-12-5-support-mvp` branch → PR1-PR6.
**Execution authority:** Standing directive "làm 1 mạch, anh cho em toàn quyền" (2026-04-22).
**Không rollback spec without new revision.**
