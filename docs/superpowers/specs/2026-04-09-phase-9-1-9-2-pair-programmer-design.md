# Phase 9.1 + 9.2 — AI Pair Programmer (God Admin Default)

**Status:** Design approved, ready for implementation plan
**Author:** Claude (Sonnet 4.5) + Thai Bui
**Date:** 2026-04-09
**Scope:** Phase 9.1 (Agent Foundation) + Phase 9.2 (Pair Programmer)
**Owner constraint:** ONLY the default god admin account (`buithai3107@gmail.com` / `thaibq@gbox.co`) can access the agent in this phase. All other roles (sub god admin, platform admin, store owner, store admin, staff, customer) get "Coming Soon" placeholders. Each role gets its own brainstorm + phase later.

---

## 1. Goal

Build an AI agent as capable as Claude Code — able to read, edit, run tests, commit, and execute ops scripts inside the Gbox Platform — accessible from the god admin dashboard via a chat panel. The agent is a pair programmer for Thai Bui: he asks, it proposes, he approves, it executes. No unattended automation, no "approve always" shortcut, no sandbox escape.

Primary use cases:
1. **Code changes** — "sửa bug ở file X", "thêm endpoint Y", "refactor service Z"
2. **Ops investigation** — "user_77 login bất thường không?", "tail log 1h qua", "smoke test sau deploy"
3. **Data exploration** — "top 10 merchants by revenue", "list order hôm nay trạng thái pending"
4. **Security operations** — rotate token, disable user, revoke session (Tier 3, strict approval)
5. **Deployment assistance** — propose deploy into next maintenance window, never touch customer-facing during peak

## 2. Scope

### In-scope (Phase 9.1 + 9.2)
- Sidecar Node process `apps/god-admin-agent` running Claude Agent SDK
- Chat panel integrated into god admin dashboard (`apps/god-admin`)
- 20 tool slots across Tier 1–4 (27 distinct tool names — some slots group related ops like `git.status`/`git.diff`/`git.log`) + 3 deployment tools. 19 slots / 26 distinct tools enabled in 9.2. Tier 4 (`db.execute`) disabled.
- 6-layer agent guard
- `agent_sessions` table + `audit_log` extension for delegated identity
- Conversation compaction with dual storage (full + compacted)
- Blue/green deployment pattern for storefront, accounts portal
- `packages/agent-guard` + `packages/agent-core` new packages
- Kill switch (UI button + filesystem flag)
- System prompt bootstrap bundle (versioned in git)
- "Coming Soon" placeholder pages for non-god-admin-default roles

### Out of scope (deferred to later phases)
- Docker sandboxing for `bash.run` — deferred to Phase 9.5
- Unattended/cron mode — deferred to Phase 9.6
- `db.execute` (UPDATE/DELETE) — deferred to Phase 9.3 after approval gate proves stable
- Multi-user agent access — deferred to per-role phases later
- Vector store / RAG — not needed, compaction covers context problem
- Worker pool / job queue — overkill for single-user scope
- Agent access to stores/merchant data — merchants get their own phase
- PR-mode (agent creates branch, opens PR for async review) — deferred to 9.5

## 3. Architecture

### 3.1 Process Topology

```
┌─────────────────────────────────────────────────────────┐
│  Server 2 (192.168.1.13)                                │
│                                                          │
│  nginx (443 public) ──┬──► god-admin-blue  :4322        │
│                       └──► god-admin-green :4422 (standby)│
│                                                          │
│  PM2 processes:                                          │
│  ┌──────────────┐  HTTP+SSE   ┌──────────────────┐     │
│  │ god-admin    │─────────────►│ god-admin-agent  │     │
│  │ Express +    │◄─────────────│ Sidecar          │     │
│  │ Vue admin    │  localhost   │ Claude Agent SDK │     │
│  │ :4322        │  :4324       │ Tool executor    │     │
│  └──────────────┘              └──────────────────┘     │
│         │                              │                │
│         ▼                              ▼                │
│  PostgreSQL (via @gbox/db) + Redis (@gbox/redis)        │
│                                                          │
│  apps/storefront  :4321 (blue) / :4421 (green)          │
│  apps/accounts    :4323 (blue) / :4423 (green)          │
└─────────────────────────────────────────────────────────┘
```

### 3.2 Process responsibilities

**`apps/god-admin` (4322, blue/green):**
- Serves god admin dashboard UI (Vue + EmDash)
- Owns session cookie, verifies god admin auth
- Proxies `/god-admin/api/agent/**` requests to sidecar via localhost HTTP
- Forwards SSE streams from sidecar to browser
- Hosts the kill switch endpoint (`POST /god-admin/api/agent/kill`) — this route does NOT go through sidecar
- Renders "Coming Soon" placeholder for non-default god admin accounts

**`apps/god-admin-agent` (4324, single instance, NO blue/green):**
- Runs Claude Agent SDK instance per active session
- Executes tool calls through the agent guard chain
- Streams responses back via SSE
- Writes to `agent_sessions` and `audit_log`
- Watches system prompt file for hot reload
- Respects `/tmp/gbox-agent-killswitch` file flag
- Polls storefront `/_health` every 30s for circuit breaker state

### 3.3 Inter-process auth

God admin dashboard mints a short-lived HS256 JWT per agent request:
- **Signing secret:** `AGENT_INTERNAL_JWT_SECRET` (env, min 64 bytes random, rotated monthly)
- **TTL:** 5 minutes (covers longest tool call + generous buffer)
- **Claims:** `{ sub: 'god_admin_default', sid: <god_admin_session_id>, aid: <agent_session_id>, iat, exp }`
- **Transport:** `Authorization: Bearer <jwt>` header on every request from dashboard → sidecar
- Sidecar verifies signature + issuer + audience. Reject non-default god admin immediately (belt-and-suspenders — the dashboard already gates this, but sidecar does not trust dashboard blindly).

### 3.4 Streaming protocol

- Request: `POST /agent/chat { sessionId, messages, userMessage }` from dashboard → sidecar
- Response: `text/event-stream` with event types:
  - `assistant_delta` — partial text
  - `tool_use` — agent wants to call a tool (includes `tool_call_id`, name, input)
  - `tool_guard_rejected` — guard blocked (includes layer + reason)
  - `approval_required` — Tier 3 tool awaiting user click (includes parsed/normalized payload)
  - `approval_resolved` — user clicked Approve/Deny
  - `tool_result` — execution outcome
  - `compact_triggered` — context compaction happened
  - `circuit_breaker` — storefront unhealthy, mutating tools disabled
  - `done` — turn complete
  - `error` — fatal error
- Dashboard forwards events verbatim to browser via its own SSE endpoint (no re-serialization).

## 4. Tool Catalog (20 slots across 4 tiers, + 3 deployment tools)

Tool "slots" are grouped by related operation. Some slots expose multiple distinct tool names (e.g. slot #6 exposes `git.status`, `git.diff`, `git.log`) because they share a code path and guard treatment. Slot count is what the agent sees as callable categories; distinct tool count is what appears in audit_log `action` column.

### Tier 1 — Read-only (8 tools, auto-approve)

| # | Tool | Description | Guard layers |
|---|------|-------------|--------------|
| 1 | `repo.read` | Read file content (any path in whitelist) | Path whitelist |
| 2 | `repo.glob` | Find files by glob pattern | Path whitelist |
| 3 | `repo.grep` | Ripgrep search in repo | Path whitelist |
| 4 | `db.select` | Run SELECT on Postgres (read-only role) | Query parser rejects non-SELECT |
| 5 | `audit.search` | Search `audit_log` table | Parameterized, read-only |
| 6 | `git.status` / `git.diff` / `git.log` | Git read operations | Path whitelist (repo root) |
| 7 | `logs.tail` | Tail PM2/nginx/systemd logs via SSH | Whitelisted remote commands only |
| 8 | `plan.todos` | Create/update todo list for current task | No side effects, in-memory |

### Tier 2 — Expensive read / dev tooling (4 tools, auto-approve)

| # | Tool | Description | Resource limit |
|---|------|-------------|----------------|
| 9 | `tests.run` | `vitest run [path]` | 5 min timeout, CPU nice |
| 10 | `typecheck.run` | `tsc --noEmit` on a package | 5 min timeout |
| 11 | `ops.smoke` | `scripts/ops/smoke-all.ts` | 2 min timeout |
| 12 | `ops.health` | GET `/_health` for all apps | 30s timeout |

### Tier 3 — Mutating, approval REQUIRED (7 tools)

| # | Tool | Description | Approval modal shows |
|---|------|-------------|----------------------|
| 13 | `repo.edit` | Edit existing file (old → new) | Diff view |
| 14 | `repo.write` | Create new file or full rewrite | Full content |
| 15 | `bash.run` | Shell command | Parsed AST + command string |
| 16 | `git.commit` | Local commit with Co-Authored-By | Message + file list |
| 17 | `git.push` | Push to remote | Branch + remote, double-confirm for `main` |
| 18 | `user.disable` / `user.enable` | User state change | User info + reason |
| 19 | `session.revoke` / `token.rotate` / `backup.now` | Security ops | Target + effect |

### Tier 4 — Destructive, disabled in 9.2 (1 tool)

| # | Tool | Description | Reason disabled |
|---|------|-------------|-----------------|
| 20 | `db.execute` | Free-form UPDATE/DELETE SQL | Defer to 9.3 after approval gate proven |

### Deployment tool (special, added in response to operational posture)

| # | Tool | Description | Notes |
|---|------|-------------|-------|
| D1 | `deploy.run(target, env)` | Invoke blue/green deploy script | Target must be `god-admin` in 9.2; `storefront` / `accounts` refused in 9.2 unless inside maintenance window AND explicit approval |
| D2 | `deploy.schedule(change_set, window_id)` | Enqueue change for next window | Agent cannot execute customer-facing changes in peak hours |
| D3 | `ops.current_window()` | Read current time + window status | System prompt injects static schedule; this tool reads live clock |

## 5. Auth & Audit Model — Delegated Identity

### 5.1 `audit_logs` schema extension

**Table name:** The existing table is `audit_logs` (plural) as defined in `packages/db/src/schema/tables.ts:793` with columns `id, shop_id, user_id, action, resource_type, resource_id, details, ip_address, created_at`. This spec extends that table. The column for actor is `user_id` (existing) — we do NOT rename it; we add new columns only.

**Migration order:** `agent_sessions` (section 5.2) MUST be created before the `ALTER TABLE audit_logs` below, because the new `on_behalf_of` column has a foreign key reference. The migration file `packages/db/src/migrations/012_agent_sessions.ts` must follow this order: (1) create `agent_sessions`, (2) alter `audit_logs`.

```sql
ALTER TABLE audit_logs
  ADD COLUMN IF NOT EXISTS on_behalf_of UUID REFERENCES agent_sessions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS via TEXT NOT NULL DEFAULT 'ui'
    CHECK (via IN ('ui', 'agent', 'api', 'cron')),
  ADD COLUMN IF NOT EXISTS tool_call_id TEXT,
  ADD COLUMN IF NOT EXISTS guard_layer TEXT,
  ADD COLUMN IF NOT EXISTS guard_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_audit_logs_on_behalf_of ON audit_logs(on_behalf_of) WHERE on_behalf_of IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_audit_logs_via ON audit_logs(via);
```

Every mutating tool call produces one audit_logs row with `user_id=<god_admin_default_user_id>`, `via='agent'`, `on_behalf_of=<agent_session_id>`, `tool_call_id=<unique>`. Human clicks in dashboard UI produce rows with `via='ui'`, `on_behalf_of=NULL`.

Guard rejections ALSO produce audit rows: `via='agent'`, `guard_layer='blocklist'`, `guard_reason='rm -rf pattern'` — so Thai can later review what was blocked (including false positives).

### 5.2 `agent_sessions` table (new)

```sql
CREATE TABLE agent_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  god_admin_id UUID NOT NULL REFERENCES users(id),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  ended_reason TEXT, -- 'user_closed' | 'timeout' | 'killed' | 'crashed' | 'circuit_breaker'

  -- Metrics
  prompt_count INT NOT NULL DEFAULT 0,
  tool_call_count INT NOT NULL DEFAULT 0,
  tool_call_rejected_count INT NOT NULL DEFAULT 0,
  approval_count INT NOT NULL DEFAULT 0,
  approval_denied_count INT NOT NULL DEFAULT 0,
  total_input_tokens INT NOT NULL DEFAULT 0,
  total_output_tokens INT NOT NULL DEFAULT 0,
  cost_usd NUMERIC(10, 4) NOT NULL DEFAULT 0,

  -- Context
  conversation JSONB NOT NULL DEFAULT '[]'::jsonb,  -- full, immutable append
  compacted_context JSONB,                           -- current working memory
  compact_count INT NOT NULL DEFAULT 0,
  last_compact_at TIMESTAMPTZ,
  token_budget INT NOT NULL DEFAULT 180000,

  -- Identity
  system_prompt_version TEXT NOT NULL,               -- git hash of prompt file
  model TEXT NOT NULL DEFAULT 'claude-sonnet-4-5',

  CONSTRAINT agent_sessions_god_admin_only CHECK (god_admin_id IS NOT NULL)
);

CREATE INDEX idx_agent_sessions_god_admin ON agent_sessions(god_admin_id, started_at DESC);
CREATE INDEX idx_agent_sessions_active ON agent_sessions(god_admin_id) WHERE ended_at IS NULL;
```

### 5.3 Retention

- Full conversation: 90 days in PG
- After 90 days: archive `conversation` JSONB to object storage (R2), keep metadata row in PG
- `audit_log` retention follows existing platform policy (untouched by this spec)

### 5.4 Session replay

God admin dashboard route `/god-admin/agent/sessions`:
- List all sessions for current god admin, sortable by started_at / cost_usd / tool_call_count
- Click session → replay viewer renders `conversation` JSONB as chat thread
- Each tool call is expandable, shows input + output + audit_log_id + approval decision
- Filter by session state (active/ended), date range, cost threshold

## 6. Conversation Storage & Context Strategy

### 6.1 Thresholds

- **Soft (140k tokens)** — UI shows yellow pill "Context: 78%"
- **Hard (160k tokens)** — auto-trigger compact before next assistant turn
- **Ceiling (180k tokens)** — reject new user messages until compact runs

### 6.2 Compact function

```ts
async function compactConversation(
  messages: Message[],
  systemPrompt: string,
  keepLastTurns: number = 5,
  targetSummaryTokens: number = 3000
): Promise<{
  summary: ContentBlock,
  preserved: Message[],
  inputTokens: number,
  outputTokens: number,
  costUsd: number
}>
```

Compact call uses Claude Sonnet 4.5 with a dedicated prompt that MUST preserve:
1. Decisions the user has explicitly locked ("em lock lại...")
2. File paths currently being edited
3. Operational constraints mentioned ("chỉ god admin default", "storefront zero-downtime")
4. Approval history (what was approved/denied in this session)
5. Current task and next intended step

Compacted conversation shape:
```
[system prompt + tool defs]       ~7.5k tokens (persistent)
[compact summary as system msg]   ~2-3k tokens (injected)
[last 5 turns verbatim]           ~10-20k tokens
[current user message]            ~0.5k tokens
```

### 6.3 Dual storage

- `agent_sessions.conversation` = ground truth, append-only, never mutated by compact
- `agent_sessions.compacted_context` = current "working memory" the agent sees
- Session replay always uses `conversation` (shows everything that happened)
- Resuming a session reloads from `compacted_context` (so agent has efficient working set)

## 7. Agent Guard — 6-Layer Defense in Depth

Package: `packages/agent-guard`

### Layer 1 — Path whitelist

```
ALLOW:
  <repo>/apps/**
  <repo>/packages/**
  <repo>/scripts/**
  <repo>/docs/**
  <repo>/tests/**

DENY (overrides allow):
  **/.env*
  **/.env.local
  **/.superpowers/**
  **/node_modules/**
  **/.git/objects/**
  **/.git/hooks/**
  **/dist/**
  **/build/**

CROSS-REPO:
  gbox-platform + gbox-emdash-admin whitelisted
  Everything else denied.
```

All paths resolved to absolute form before check. Symlinks followed to target, then re-checked. Path traversal (`../`) resolved.

### Layer 2 — Command parser + blocklist (`bash.run`)

Parse via `shell-quote` into AST. Reject if AST contains:

- `rm -rf /`, `rm -rf ~`, `rm -rf *`, `rm -rf .`
- `sudo` (always blocked — no whitelist)
- `dd if=/dev/zero`, `dd of=/dev/sd*`, `mkfs.*`, `fdisk`, `parted`
- Fork bomb patterns (`:(){ :|:& };:`, infinite subshells)
- Pipe-to-shell: `curl ... | sh`, `wget ... | bash`, `curl ... | python`
- Redirect to device: `> /dev/sda`, `> /dev/null` allowed but `> /dev/*sd*` blocked
- `chmod 777` on system paths, `chown` on `/etc`, `/var`, `/usr`
- Backticks / `$(...)` containing blocked patterns (recursive check)
- Direct killswitch tampering: `rm /tmp/gbox-agent-killswitch`

Blocklist lives in `packages/agent-guard/src/blocklist.ts`, fully unit-tested with ~60 cases.

### Layer 3 — Resource limits (`bash.run`)

```ts
{
  timeout_ms: 300_000,          // 5 min hard kill
  kill_grace_ms: 5_000,          // SIGTERM then SIGKILL
  max_output_bytes: 10_485_760,  // 10 MB
  memory_mb: 2048,               // ulimit -v
  cpu_nice: 10,                  // nice -n 10
  max_concurrent_bash: 1,        // serialize bash.run calls
  working_dir_must_be: '<whitelisted path>'
}
```

Wrapper command:
```bash
ulimit -v 2097152 && cd "<wd>" && nice -n 10 timeout --kill-after=5s 300s bash -c "<command>"
```

### Layer 4 — Rate limits (per session)

- Max 100 tool calls / session → auto-stop, require explicit "continue" from user
- Max 20 Tier 3 calls / 5-minute window
- Max 3 consecutive failed `repo.edit` on the same file → stop (detects retry loops)
- Max 1 `bash.run` in flight at any time

Counters stored in-memory in sidecar, reset on session end or process restart.

### Layer 5 — Approval gate

- Tier 3 tool call emits `approval_required` event with **parsed/normalized** payload (not raw string — prevents character-level tricks)
- UI modal shows:
  - Tool name
  - Normalized input (diff for edit, parsed command for bash, full content for write)
  - Estimated impact (1-line summary)
  - Only "Approve" and "Deny" buttons — NO "Approve always"
- Approval timeout: 120 seconds. After that, tool call auto-denied as `timeout`
- `git.push` to `main` branch requires a secondary confirmation ("Are you absolutely sure?" with the branch name typed in)

### Layer 6 — Deployment Safety Gate

Reads `apps/storefront/**`, `apps/accounts/**`, `packages/db/schema/**`, `packages/core/**` are classified as `customer-facing`.

**Rules:**

1. **Traffic awareness:**
   - `traffic_level=peak` → block ALL customer-facing mutating tool calls, require explicit manual override from user typed in chat
   - `traffic_level=normal` → warn in approval modal, allow with approval
   - `traffic_level=low` → allow normally
2. **Maintenance window:**
   - Outside daily 03:00-04:00 window AND outside Sunday extended window → refuse customer-facing mutations, offer `deploy.schedule` instead
   - Inside window → proceed with approval
3. **Circuit breaker:**
   - Sidecar polls storefront `/_health` every 30s
   - If unhealthy (5xx rate > 1%, p95 > 2s, 3 consecutive health fails) → OPEN state
   - OPEN state disables ALL Tier 3 tools, including admin-only targets (safer to freeze everything than investigate which is safe)
   - Recovery: 3 consecutive healthy probes → CLOSED state, tools re-enabled
   - UI shows red banner "Circuit breaker open" while OPEN
4. **Blue/green only for customer-facing:**
   - Agent cannot execute raw `pm2 restart storefront` — blocklist pattern
   - Agent must use `deploy.run(target='storefront', env='prod')` which invokes `scripts/deploy/blue-green-swap.ts`
   - Script is canonical, handles health check + auto-rollback

### Guard composition

```ts
const guardChain = composeGuards([
  pathWhitelist,
  commandParser,
  resourceLimits,
  rateLimit,
  deploymentSafety,
  approvalGate,
]);

const result = await guardChain.check(toolCall, sessionContext);
if (!result.allowed) {
  await auditReject(toolCall, result.layer, result.reason);
  throw new GuardRejection(result.layer, result.reason);
}
await executeTool(toolCall);
```

Each guard layer is independently unit-tested. Composition is integration-tested with realistic scenarios.

## 8. UX — Chat Panel (3 States)

### State 1 — Collapsed (default)

- Claude icon 56×56px, gold gradient, bottom-right corner of god admin dashboard
- Badge shows notification count (background task completed, circuit breaker state change, cron audit warnings)
- Click → expands to State 2

### State 2 — Expanded sidebar

- Sidebar 280–400px wide, slides in from right
- Chat stream with user + assistant messages
- Assistant can emit **choice cards** — interactive A/B/C/D buttons rendered from a `<choices>` markdown block
- Click choice → automatically sent as user message (no typing required)
- Header: session ID, context usage pill ("Context: 87.3k / 180k"), compact icon, close button
- Auto-scroll on new message, collapsible on long tool outputs
- Context of current dashboard page auto-attached to prompt ("anh đang ở trang /shops")

### State 3 — Approval modal (inline in chat)

- Red-bordered card inserted into chat stream (NOT a blocking overlay)
- Shows: tool name, normalized payload, impact summary
- Two buttons: `✓ Approve` (green) and `✗ Deny` (red)
- Small footer text: "no 'approve always' — every mutating action needs fresh consent"
- 120-second auto-deny timer with visible countdown
- For `git.push main`: secondary prompt "type 'main' to confirm"

### Session management

- Route `/god-admin/agent/sessions` for history/replay
- Kill switch button (red, top-right of chat panel): "Emergency stop" → `POST /god-admin/api/agent/kill`
- Coming Soon placeholder for non-default god admin accounts at same chat panel slot

## 9. System Prompt & Personality

### Personality — Conversational bilingual VN-EN

Identity:
- Address user as "anh", refer to self as "em"
- Mix Vietnamese for explanation + English for technical terms
- Recommend clearly, explain tradeoffs, ask before destructive actions
- Short acknowledgments, long explanations only when justified

### Bootstrap bundle

System prompt lives at `packages/agent-core/prompts/god-admin-default.md`, git-tracked, versioned by commit hash. Sidecar watches file and hot-reloads for new sessions (existing sessions keep their version for consistency).

Composition (approximately 7.5k tokens):

1. **Identity & personality** (~0.5k)
2. **CLAUDE.md content inlined** (~2k) — iron rules, admin hierarchy, project identity, god admin seed
3. **MEMORY.md content inlined** (~1.5k) — infra topology, server credentials reference (NOT credentials themselves), nginx routing, deployment quirks
4. **Tool catalog with signatures and tier** (~1.5k)
5. **Operational posture summary** (~1k) — SLO numbers, maintenance window, blue/green rule, Expand-Migrate-Contract
6. **Communication patterns** (~0.5k) — before/during/after mutating actions
7. **Current phase status** (~0.5k, dynamically injected at session start) — active phase, recent commits top 10, pending tasks

### Hot reload

```
fs.watch(promptFile) → on change:
  1. Validate new file (parseable, non-empty, contains required sections)
  2. Compute git hash of new content
  3. Update in-memory prompt for new sessions
  4. Log reload event with old_hash → new_hash
  5. Do NOT touch active sessions
```

## 10. Operational Posture & Change Management

This section applies platform-wide, not just Phase 9.2. Phase 9.2 must respect these constraints from day one.

### 10.1 SLOs

| Component | Availability | Planned downtime / deploy | Max budget / month |
|-----------|--------------|---------------------------|---------------------|
| Storefront | 99.95% | **0 seconds** | ~21 min total, planned = 0 |
| Accounts portal | 99.9% | ≤ 30 seconds | ~43 min |
| God admin dashboard | 99.5% | ≤ 2 minutes | ~3.6 hours |
| God admin agent sidecar | 99% | unrestricted restart | no constraint |

### 10.2 Blue/green deployment

Storefront, accounts, and god admin dashboard all use blue/green with nginx upstream swap:

```
upstream storefront_blue  { server 127.0.0.1:4321; }
upstream storefront_green { server 127.0.0.1:4421; }

Active → blue. Deploy to green, health check, smoke test, swap upstream via
`nginx -s reload`, observe 30s, drain old slot.
```

Script: `scripts/deploy/blue-green-swap.ts` (to be built in Phase 9.2 as a dependency of the `deploy.run` tool)

Auto-rollback triggers:
- 5xx rate > 1% in the 30s window after swap
- p95 latency > 2s
- Any `/_health` fail within 30s

Graceful drain: old slot receives SIGTERM, waits for in-flight requests (max 30s), then SIGKILL.

### 10.3 Maintenance windows

| Window | Time (GMT+7) | Cadence | Use for |
|--------|--------------|---------|---------|
| Primary | 03:00 – 04:00 | Daily | Regular customer-facing deploys |
| Extended | 02:00 – 05:00 Sunday | Weekly | DB migrations, major changes |
| Emergency | On-demand | Rare | Security patches, manually enabled by god admin |

### 10.4 Expand-Migrate-Contract DB migrations

Three-phase migration mandatory for any schema change touching customer-facing tables:

1. **Expand** — add new column/table, backward compatible, old code still works
2. **Migrate** — backfill data, deploy new code using new schema
3. **Contract** — drop old column/table, only after 1 week of stable new-schema operation

Agent tool `db.migration_propose` generates migrations following this pattern. Single-phase destructive migrations rejected.

### 10.5 Kill switch

- **UI button:** Red "Emergency stop agent" button in god admin dashboard → `POST /god-admin/api/agent/kill` route owned by dashboard process (NOT sidecar) → kills sidecar PM2 process + rotates `AGENT_INTERNAL_JWT_SECRET`
- **Filesystem flag:** `/tmp/gbox-agent-killswitch` — sidecar refuses to start if file exists; cron every 60s force-kills running sidecar if flag appears
- **SSH access:** `touch /tmp/gbox-agent-killswitch` works even if dashboard is down

## 11. Package Layout

### New packages

```
packages/agent-core/
├── src/
│   ├── index.ts                      -- exports
│   ├── agent-runtime.ts              -- Claude Agent SDK wrapper
│   ├── session-manager.ts            -- session lifecycle + PG persistence
│   ├── compaction.ts                 -- context compaction logic
│   ├── tool-registry.ts              -- tool definitions + dispatch
│   ├── sse-stream.ts                 -- SSE event emitter
│   ├── jwt.ts                        -- internal JWT mint/verify
│   └── prompts/
│       └── god-admin-default.md      -- system prompt, versioned
├── test/
└── package.json

packages/agent-guard/
├── src/
│   ├── index.ts                      -- composeGuards + guard chain runner
│   ├── path-whitelist.ts             -- Layer 1
│   ├── command-parser.ts             -- Layer 2 AST parser
│   ├── blocklist.ts                  -- Layer 2 dangerous patterns
│   ├── resource-limits.ts            -- Layer 3 timeout/mem/cpu
│   ├── rate-limit.ts                 -- Layer 4 per-session counters
│   ├── deployment-safety.ts          -- Layer 6 window/traffic/circuit
│   ├── approval-gate.ts              -- Layer 5 modal emitter
│   └── types.ts                      -- GuardResult, GuardRejection
├── test/
│   ├── path-whitelist.test.ts
│   ├── command-parser.test.ts
│   ├── blocklist.test.ts             -- ~60 cases
│   ├── resource-limits.test.ts
│   ├── rate-limit.test.ts
│   ├── deployment-safety.test.ts
│   └── guard-chain.integration.test.ts
└── package.json

packages/agent-tools/
├── src/
│   ├── index.ts                      -- exports tool implementations
│   ├── tier1/
│   │   ├── repo-read.ts
│   │   ├── repo-glob.ts
│   │   ├── repo-grep.ts
│   │   ├── db-select.ts
│   │   ├── audit-search.ts
│   │   ├── git-readonly.ts
│   │   ├── logs-tail.ts
│   │   └── plan-todos.ts
│   ├── tier2/
│   │   ├── tests-run.ts
│   │   ├── typecheck-run.ts
│   │   ├── ops-smoke.ts
│   │   └── ops-health.ts
│   ├── tier3/
│   │   ├── repo-edit.ts
│   │   ├── repo-write.ts
│   │   ├── bash-run.ts
│   │   ├── git-commit.ts
│   │   ├── git-push.ts
│   │   ├── user-disable.ts
│   │   ├── session-revoke.ts
│   │   ├── token-rotate.ts
│   │   └── backup-now.ts
│   └── deploy/
│       ├── deploy-run.ts
│       ├── deploy-schedule.ts
│       └── ops-current-window.ts
├── test/
└── package.json
```

### New app

```
apps/god-admin-agent/
├── src/
│   ├── server.ts                     -- Express server on :4324
│   ├── routes/
│   │   ├── chat.ts                   -- POST /agent/chat (SSE stream)
│   │   ├── session.ts                -- CRUD agent_sessions
│   │   └── health.ts                 -- GET /_health
│   ├── middleware/
│   │   ├── verify-internal-jwt.ts
│   │   └── killswitch-check.ts
│   ├── circuit-breaker.ts            -- polls storefront health
│   └── prompt-watcher.ts             -- file watcher + hot reload
├── test/
├── ecosystem.config.js               -- PM2 config
└── package.json
```

### Extensions to existing apps

```
apps/god-admin/
├── src/
│   ├── routes/
│   │   └── agent-proxy.ts            -- proxy to sidecar + SSE forward
│   │   └── agent-kill.ts              -- emergency stop (direct, not via sidecar)
│   └── views/
│       ├── chat-panel/                -- 3-state chat UI
│       ├── agent-sessions/            -- history + replay
│       └── coming-soon.vue            -- for non-default accounts
```

### New scripts

```
scripts/deploy/
├── blue-green-swap.ts                -- canonical deploy script
└── check-deploy-window.ts             -- enforce window + traffic
```

### Schema migration

```
packages/db/src/migrations/
└── 012_agent_sessions.ts    -- Kysely-based migration matching existing numbered pattern (001-011)
```

The migration follows the existing numbered `.ts` file pattern (001_initial → 011_domain_verification) using `Kysely` + `sql` template strings. It is registered in `packages/db/src/migrations/run.ts` as migration #012.

## 12. API Contracts

### `POST /god-admin/api/agent/chat` (dashboard endpoint)

Request:
```ts
{
  sessionId?: string,   // null = new session
  message: string,
  pageContext?: {       // auto-attached by frontend
    route: string,
    selectedEntityId?: string
  }
}
```

Response: `text/event-stream` — events forwarded from sidecar verbatim.

### `POST /agent/chat` (sidecar internal endpoint)

Request: same as above, plus `Authorization: Bearer <internal-jwt>` header.

Response: same SSE format.

### `POST /god-admin/api/agent/kill`

Request: empty body, god admin session cookie required.

Response:
```ts
{
  killed: boolean,
  previous_pid: number,
  rotated_jwt_secret: boolean,
  timestamp: string
}
```

Side effects:
1. `pm2 stop god-admin-agent`
2. Rotate `AGENT_INTERNAL_JWT_SECRET` (invalidates any in-flight JWTs)
3. Write audit_log entry with `via='ui'`, `action='agent.killed'`
4. Close all active `agent_sessions` rows with `ended_reason='killed'`

### `GET /god-admin/api/agent/sessions`

Returns paginated session list for session replay UI.

## 13. Phase 9.1 vs 9.2 split

Phase 9.1 is the foundation layer that 9.2 builds on. Both are shipped together in this spec but implemented in order.

### Phase 9.1 — Foundation (~week 1-2)

1. `packages/agent-core` — runtime wrapper, session manager, SSE, JWT
2. `packages/agent-guard` — all 6 layers with full unit tests
3. `packages/db/migrations/20260409-phase-9-agent-sessions.sql`
4. `apps/god-admin-agent` — sidecar skeleton, PM2 config, killswitch, prompt watcher
5. God admin dashboard: coming-soon placeholder component
6. Internal JWT mint/verify in god admin dashboard
7. Chat panel UI skeleton (State 1 collapsed, State 2 empty expanded)

**Exit criteria:**
- Sidecar starts, accepts JWT, returns mock SSE stream
- Chat panel opens/closes, no real agent yet
- Coming soon page works for non-default accounts
- All guard layer unit tests pass

### Phase 9.2 — Pair Programmer (~week 3-4)

1. `packages/agent-tools` — all 20 tools with per-tool tests
2. Claude Agent SDK integration in `packages/agent-core`
3. Compaction logic + dual storage
4. Chat panel State 2 full (messages, choice cards, context pill)
5. Chat panel State 3 (approval modals)
6. Session replay UI
7. `scripts/deploy/blue-green-swap.ts` (required for `deploy.run` tool)
8. Circuit breaker polling
9. System prompt `god-admin-default.md`
10. End-to-end test: "ask agent to read a file", "ask agent to run tests", "ask agent to edit a file with approval"

**Exit criteria:**
- All 19 enabled slots (Tier 1+2+3) + 3 deployment tools callable via chat
- Approval gate works for Tier 3 tools (no "approve always" present)
- Context compaction triggers at 160k tokens and preserves locked decisions
- Session replay renders a completed session correctly
- Blue/green deploy script passes smoke test on a dummy app
- Circuit breaker opens when storefront is unhealthy
- Kill switch works (both UI button and filesystem flag)

## 14. Testing Strategy

### 14.1 Unit tests

- `packages/agent-guard` — every layer tested in isolation. Blocklist has ~60 cases covering rm variants, fork bombs, pipe-to-shell, path traversal, sudo, device redirects, symlink tricks
- `packages/agent-core` — session manager, compaction, JWT, SSE encoder
- `packages/agent-tools` — each tool tested with mock filesystem/DB/SSH

### 14.2 Integration tests

- Guard chain composition with realistic tool calls
- Sidecar + god admin dashboard HTTP+SSE round trip (vitest + supertest)
- Compaction triggered at threshold, decisions preserved
- Circuit breaker opens/closes based on fake health endpoint

### 14.3 End-to-end smoke tests

- Start sidecar, start dashboard, open chat panel, send message "read CLAUDE.md", verify response contains expected content
- Trigger `repo.edit`, approve in UI, verify file changed, verify audit_log row
- Trigger `repo.edit`, deny in UI, verify file NOT changed, verify audit_log row with `guard_layer='approval'`, `guard_reason='denied'`
- Trigger killswitch via filesystem flag, verify sidecar stops within 60s

### 14.4 Manual acceptance by Thai

Thai manually drives these scenarios before Phase 9.2 ships:
1. "Sửa 1 typo trong README.md"
2. "Chạy vitest cho packages/core"
3. "Grep tìm tất cả usage của function X"
4. "Commit changes hiện tại với message Y"
5. "Rotate token cho user_X" (security op)
6. "Deploy god-admin" (inside window) — verify blue/green works
7. "Deploy storefront" (outside window, peak traffic) — verify refused with `deploy.schedule` alternative
8. Trigger kill switch — verify everything dies cleanly

## 15. Rollout Plan

### 15.1 Non-god-admin-default accounts

- Coming Soon placeholder renders at chat panel slot
- Message: "AI agent sẽ mở cho role này trong phase sau. Anh Thai sẽ brainstorm riêng từng role với Claude."
- Placeholder has a "Notify me" button (writes to a `notify_list` table) so future phases know who wants it

### 15.2 Ship order

1. PR 1 — `packages/db` migration (agent_sessions, audit_log extension)
2. PR 2 — `packages/agent-guard` with all 6 layers + tests
3. PR 3 — `packages/agent-core` runtime + session manager + JWT
4. PR 4 — `packages/agent-tools` all 20 tools
5. PR 5 — `apps/god-admin-agent` sidecar + PM2 config
6. PR 6 — `apps/god-admin` chat panel UI + proxy + kill switch
7. PR 7 — `scripts/deploy/blue-green-swap.ts` + window checker
8. PR 8 — System prompt file + session replay UI + coming-soon placeholder
9. PR 9 — End-to-end smoke test + manual acceptance runbook

Each PR separately reviewed, separately merged, separately deployable. Phase 9.1 ships at PR 5. Phase 9.2 ships at PR 9.

### 15.3 Monitoring after ship

- Dashboard card in god admin: "Agent health" — session count last 24h, total cost, tool call counts, circuit breaker state, last kill event
- Daily digest email to buithai3107@gmail.com: sessions, cost, top denied tool calls, any guard layer rejections suggesting false positives
- Alert if `cost_usd` for a single session > $5 (likely runaway loop)

## 16. Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Prompt injection via file content | Layer 1 whitelist + Layer 2 blocklist — attacker must bypass both + layer 5 approval |
| Runaway tool loop | Layer 4 rate limits (100 calls/session, 3 retry cap) |
| Dashboard freezing if sidecar crashes | Sidecar is separate process — dashboard shows "Agent unavailable" banner, still functions |
| Agent hangs mid-tool-call | Layer 3 hard timeout 5 min, SIGKILL escalation |
| Cost blowup | Soft warning at 140k, hard compact at 160k, daily digest alert > $5 |
| Secret JWT leaked | 5-min TTL, rotated on kill switch, rotated monthly by cron |
| Storefront broken by agent deploy | Blue/green + auto-rollback + circuit breaker — worst case 30s detection then automatic revert |
| Agent bypasses killswitch flag check | Cron every 60s independently force-kills sidecar if flag exists; ops can always SSH + kill PID manually |
| Thai loses track of what agent did | Delegated identity audit + session replay UI + daily digest |
| Compaction loses critical context | Compact prompt explicitly preserves decisions, constraints, current task; last 5 turns always verbatim; full history always in `conversation` for forensics |

## 17. Glossary

- **God admin default** — The two seeded god admin accounts (`buithai3107@gmail.com`, `thaibq@gbox.co`) with level 0 role. Only account type that can access the agent in Phase 9.2.
- **Sidecar** — Separate Node process (`apps/god-admin-agent`) running Claude Agent SDK, isolated from dashboard HTTP server.
- **Agent guard** — 6-layer defense chain that wraps every tool call.
- **Delegated identity** — Audit pattern where agent actions are recorded as `actor=god_admin_default, via=agent, on_behalf_of=<session_id>`.
- **Blue/green deploy** — Two parallel slots (blue active, green standby), swap via nginx upstream reload for zero-downtime.
- **Expand-Migrate-Contract** — Three-phase migration pattern to avoid any single-point DB downtime.
- **Circuit breaker** — Auto-disable mutating tools when storefront health degrades.
- **Maintenance window** — Scheduled low-traffic period (03:00-04:00 GMT+7 daily) when customer-facing changes are allowed.
- **Choice cards** — Interactive A/B/C/D buttons rendered from agent-emitted `<choices>` block, clicked to reply without typing.
- **Kill switch** — Emergency stop for agent sidecar, accessible via UI button AND filesystem flag AND SSH.

---

**End of design.** Next step: invoke `writing-plans` skill to produce the implementation plan for PR 1 through PR 9.
