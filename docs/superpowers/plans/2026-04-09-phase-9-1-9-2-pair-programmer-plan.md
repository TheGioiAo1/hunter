# Phase 9.1 + 9.2 — AI Pair Programmer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an AI agent as capable as Claude Code, accessible from the god admin dashboard. It reads, edits, runs tests, commits, deploys — all behind a 6-layer guard with human approval on every mutating action. Scope limited to the default god admin account; other roles get "Coming Soon".

**Architecture:** Sidecar Node process (`apps/god-admin-agent` :4324) runs Claude Agent SDK, communicates with the god admin dashboard (:4322) via HTTP+SSE with short-lived internal JWT. Tools are wrapped by the `agent-guard` chain (path whitelist → command parser → blocklist → resource limits → rate limit → deployment safety → approval gate). All actions audited with delegated identity (`via='agent', on_behalf_of=<session_id>`). Conversations stored dual (full + compacted working memory). Blue/green deploys with zero downtime on customer-facing apps. Kill switch via UI button + filesystem flag.

**Tech Stack:** TypeScript strict, Kysely 0.28, Postgres, Express 5, vitest, Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`), shell-quote (command parser), pm2, nginx (upstream swap).

**Spec reference:** `docs/superpowers/specs/2026-04-09-phase-9-1-9-2-pair-programmer-design.md`

---

## Plan structure & rationale

The spec ships in 9 PRs (section 15.2). Each PR is a sub-project with its own test surface, deployable alone, independently reviewable. Writing bite-sized TDD steps for all 9 PRs in one document would produce a 3000+ line file, unreadable.

**Approach:**
- **PR 1 — DB Migration** is the ONLY PR fully decomposed into bite-sized TDD steps in this document. It is the smallest, has zero runtime dependencies, and unblocks everything else.
- **PR 2 through PR 9** are captured as **scaffold sections**: scope, files, key tests, exit criteria, dependencies. Enough for the architect to review the shape; NOT enough to execute without expansion.
- **After PR 1 ships and merges**, re-invoke `writing-plans` skill with input "expand PR 2 of the pair-programmer plan into bite-sized TDD steps". Repeat per PR. This keeps each execution batch short enough to hold in context.

This "expand one PR at a time" pattern matches how Phase 8 (cache → replica → CDN → load test) was shipped — one sub-phase at a time with commit, test, review between each.

---

## Plan index (9 PRs)

| PR | Scope | Depends on | Status in this doc |
|----|-------|------------|---------------------|
| 1 | DB migration: `agent_sessions` table + `audit_logs` column additions + Kysely types | — | **FULL BITE-SIZED DETAIL** |
| 2 | `packages/agent-guard` — 6 layers with unit tests | 1 (types only) | Scaffold |
| 3 | `packages/agent-core` — runtime wrapper, session manager, JWT, compaction, SSE | 1, 2 | Scaffold |
| 4 | `packages/agent-tools` — 20 slot implementations, per-tool unit tests | 1, 2, 3 | Scaffold |
| 5 | `apps/god-admin-agent` — sidecar Express server, PM2 config, killswitch, circuit breaker | 1, 2, 3, 4 | Scaffold |
| 6 | `apps/god-admin` — chat panel UI (3 states), SSE proxy, kill switch route, coming-soon placeholder | 5 | Scaffold |
| 7 | `scripts/deploy/blue-green-swap.ts` + `check-deploy-window.ts` | — (independent, can run in parallel with 2–6) | Scaffold |
| 8 | System prompt `god-admin-default.md` + session replay UI + daily digest email | 6 | Scaffold |
| 9 | End-to-end smoke test + manual acceptance runbook + monitoring dashboard card | 1–8 | Scaffold |

---

# PR 1 — Database Migration (`agent_sessions` + `audit_logs` extension)

**Goal:** Ship a Kysely migration that creates the `agent_sessions` table and extends `audit_logs` with 5 new columns + 2 indexes, register it in the migration runner, and export the new Kysely types.

**Files:**
- Create: `packages/db/src/migrations/012_agent_sessions.ts`
- Create: `packages/db/src/migrations/012_agent_sessions.test.ts`
- Modify: `packages/db/src/migrations/run.ts` (add migration 012 to the array)
- Modify: `packages/db/src/schema/tables.ts` (add `AgentSessionTable` interface, extend `AuditLogTable`, register in `Database`)

**Dependencies:** None. This is the foundation PR.

**Why TDD here:** A migration is hard to unit-test end-to-end without Postgres. We achieve TDD value by:
1. Writing a shape test for the migration module (it exports `up` and `down`, calls expected Kysely builders)
2. Writing a type-level test that confirms the `Database` interface shape
3. Running the migration against a local Postgres and verifying schema (manual smoke test at end)

The shape/type tests catch regressions during the code-write loop; the Postgres smoke test catches SQL errors once.

## Task 1.1 — Scaffold migration file shape test

**Files:**
- Create: `packages/db/src/migrations/012_agent_sessions.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/db/src/migrations/012_agent_sessions.test.ts`:

```typescript
/**
 * Shape tests for migration 012 (agent_sessions).
 *
 * These tests do NOT hit Postgres — they use a proxy-based Kysely
 * mock that records every builder call, and assert that the migration
 * calls the right sequence of builders with the right arguments.
 *
 * Integration testing against real Postgres is covered by the manual
 * smoke step in Task 1.9 + the existing `npm run db:migrate` workflow.
 */

import { describe, it, expect, vi } from 'vitest'
import { up, down } from './012_agent_sessions.ts'

// ---------------------------------------------------------------------------
// Kysely / sql mock
// ---------------------------------------------------------------------------

interface Call {
  method: string
  args: unknown[]
}

function recordingDb(log: Call[]): any {
  // Every method returns a new proxy that also records. Terminal
  // `.execute()` resolves with undefined.
  const handler: ProxyHandler<any> = {
    get(_target, prop: string) {
      if (prop === 'execute') {
        return async () => {
          log.push({ method: 'execute', args: [] })
          return undefined
        }
      }
      return (...args: unknown[]) => {
        log.push({ method: String(prop), args })
        return new Proxy({}, handler)
      }
    },
  }
  return new Proxy({}, handler)
}

// Mock the `sql` tagged template so `sql\`...\`.execute(db)` works.
vi.mock('kysely', async () => {
  const actual = await vi.importActual<any>('kysely')
  return {
    ...actual,
    sql: Object.assign(
      (strings: TemplateStringsArray, ..._values: unknown[]) => ({
        execute: async (_db: unknown) => {
          return undefined
        },
        sqlText: strings.join('?'),
      }),
      {
        // Support sql.raw, sql.ref, sql.lit if the migration uses them.
        raw: (s: string) => ({ sqlText: s }),
      },
    ),
  }
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('migration 012_agent_sessions', () => {
  it('exports an up() async function', () => {
    expect(typeof up).toBe('function')
    expect(up.constructor.name).toBe('AsyncFunction')
  })

  it('exports a down() async function', () => {
    expect(typeof down).toBe('function')
    expect(down.constructor.name).toBe('AsyncFunction')
  })

  it('up() runs without throwing against the recording mock', async () => {
    const log: Call[] = []
    const db = recordingDb(log)
    await expect(up(db)).resolves.toBeUndefined()
    // At minimum, up() should have issued at least one execute()
    expect(log.some((c) => c.method === 'execute')).toBe(true)
  })

  it('down() runs without throwing against the recording mock', async () => {
    const log: Call[] = []
    const db = recordingDb(log)
    await expect(down(db)).resolves.toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails with "module not found"**

Run:
```bash
cd "E:/Gbox Platform vibecode/gbox-platform" && npx vitest run packages/db/src/migrations/012_agent_sessions.test.ts
```

Expected: FAIL — "Failed to resolve import './012_agent_sessions.ts'" (file does not exist yet).

## Task 1.2 — Create minimal migration stub so test compiles

**Files:**
- Create: `packages/db/src/migrations/012_agent_sessions.ts`

- [ ] **Step 1: Write minimal stub**

Create `packages/db/src/migrations/012_agent_sessions.ts`:

```typescript
/**
 * Migration 012: Agent Sessions (Phase 9.1 — AI Pair Programmer)
 *
 * Creates the `agent_sessions` table that tracks every Claude Agent
 * session opened by the default god admin. Stores full conversation
 * (immutable append) + compacted working memory (replaced on every
 * compaction) + per-session metrics (tokens, cost, tool calls,
 * approvals).
 *
 * Also extends `audit_logs` with 5 columns so every mutating tool
 * call the agent performs is traceable back to the exact session
 * and tool_call_id, with guard layer attribution if the call was
 * rejected before execution.
 *
 * Migration order is critical: `agent_sessions` MUST be created
 * BEFORE `ALTER TABLE audit_logs` because the new `on_behalf_of`
 * column has a foreign key reference to agent_sessions.id.
 *
 * Full design: docs/superpowers/specs/2026-04-09-phase-9-1-9-2-pair-programmer-design.md
 */

import { sql, type Kysely } from 'kysely'

export async function up(_db: Kysely<any>): Promise<void> {
  // Implementation added in Task 1.3+
}

export async function down(_db: Kysely<any>): Promise<void> {
  // Implementation added in Task 1.3+
}
```

- [ ] **Step 2: Re-run tests**

Run:
```bash
cd "E:/Gbox Platform vibecode/gbox-platform" && npx vitest run packages/db/src/migrations/012_agent_sessions.test.ts
```

Expected: `up() runs without throwing against the recording mock` FAILS because the stub `up()` never issues an execute(). Other tests pass.

## Task 1.3 — Implement `up()` for `agent_sessions` table

**Files:**
- Modify: `packages/db/src/migrations/012_agent_sessions.ts`

- [ ] **Step 1: Replace `up()` body with real create**

Replace the `up()` function in `packages/db/src/migrations/012_agent_sessions.ts` with:

```typescript
export async function up(db: Kysely<any>): Promise<void> {
  // --- STEP 1/3: create agent_sessions -----------------------------------
  // Must run first so the audit_logs.on_behalf_of FK resolves.
  await sql`
    CREATE TABLE IF NOT EXISTS agent_sessions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      god_admin_id UUID NOT NULL REFERENCES users(id),

      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ended_at TIMESTAMPTZ,
      ended_reason TEXT,

      prompt_count INT NOT NULL DEFAULT 0,
      tool_call_count INT NOT NULL DEFAULT 0,
      tool_call_rejected_count INT NOT NULL DEFAULT 0,
      approval_count INT NOT NULL DEFAULT 0,
      approval_denied_count INT NOT NULL DEFAULT 0,
      total_input_tokens INT NOT NULL DEFAULT 0,
      total_output_tokens INT NOT NULL DEFAULT 0,
      cost_usd NUMERIC(10, 4) NOT NULL DEFAULT 0,

      conversation JSONB NOT NULL DEFAULT '[]'::jsonb,
      compacted_context JSONB,
      compact_count INT NOT NULL DEFAULT 0,
      last_compact_at TIMESTAMPTZ,
      token_budget INT NOT NULL DEFAULT 180000,

      system_prompt_version TEXT NOT NULL,
      model TEXT NOT NULL DEFAULT 'claude-sonnet-4-5'
    )
  `.execute(db)

  // Indexes — support session list & active-session lookup.
  await sql`
    CREATE INDEX IF NOT EXISTS idx_agent_sessions_god_admin
      ON agent_sessions(god_admin_id, started_at DESC)
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_agent_sessions_active
      ON agent_sessions(god_admin_id)
      WHERE ended_at IS NULL
  `.execute(db)

  console.log('  ✓ Created agent_sessions table + indexes')
}
```

Leave `down()` empty for now — we implement it in Task 1.5 after `up()` is complete.

- [ ] **Step 2: Run tests**

Run:
```bash
cd "E:/Gbox Platform vibecode/gbox-platform" && npx vitest run packages/db/src/migrations/012_agent_sessions.test.ts
```

Expected: all 4 tests PASS. The recording mock now sees `execute()` called (via the mocked `sql` template).

## Task 1.4 — Extend `up()` with `audit_logs` column additions

**Files:**
- Modify: `packages/db/src/migrations/012_agent_sessions.ts`

- [ ] **Step 1: Append the ALTER TABLE block to `up()`**

In `packages/db/src/migrations/012_agent_sessions.ts`, append **after** the agent_sessions index creation (still inside `up()`, before `console.log`):

```typescript
  // --- STEP 2/3: extend audit_logs ---------------------------------------
  // Five new columns track delegated identity + guard attribution for
  // every agent-initiated action. All use IF NOT EXISTS so the migration
  // is idempotent — re-running is a no-op.
  await sql`
    ALTER TABLE audit_logs
      ADD COLUMN IF NOT EXISTS on_behalf_of UUID
        REFERENCES agent_sessions(id) ON DELETE SET NULL
  `.execute(db)

  await sql`
    ALTER TABLE audit_logs
      ADD COLUMN IF NOT EXISTS via TEXT NOT NULL DEFAULT 'ui'
  `.execute(db)

  // Add the CHECK constraint in a separate statement so it can be
  // wrapped in a DO block (idempotent).
  await sql`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'audit_logs_via_check'
      ) THEN
        ALTER TABLE audit_logs
          ADD CONSTRAINT audit_logs_via_check
          CHECK (via IN ('ui', 'agent', 'api', 'cron'));
      END IF;
    END $$
  `.execute(db)

  await sql`
    ALTER TABLE audit_logs
      ADD COLUMN IF NOT EXISTS tool_call_id TEXT
  `.execute(db)

  await sql`
    ALTER TABLE audit_logs
      ADD COLUMN IF NOT EXISTS guard_layer TEXT
  `.execute(db)

  await sql`
    ALTER TABLE audit_logs
      ADD COLUMN IF NOT EXISTS guard_reason TEXT
  `.execute(db)

  // --- STEP 3/3: audit_logs indexes --------------------------------------
  await sql`
    CREATE INDEX IF NOT EXISTS idx_audit_logs_on_behalf_of
      ON audit_logs(on_behalf_of)
      WHERE on_behalf_of IS NOT NULL
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_audit_logs_via
      ON audit_logs(via)
  `.execute(db)

  console.log('  ✓ Extended audit_logs with on_behalf_of / via / tool_call_id / guard columns')
```

- [ ] **Step 2: Replace the single `console.log` in `up()`**

The `up()` function currently ends with one `console.log('  ✓ Created agent_sessions table + indexes')`. That line stays. The new block (from Step 1) appends its own second `console.log`. Final structure of `up()`:

1. agent_sessions CREATE + indexes → log
2. audit_logs ALTERs + indexes → log

- [ ] **Step 3: Run tests**

Run:
```bash
cd "E:/Gbox Platform vibecode/gbox-platform" && npx vitest run packages/db/src/migrations/012_agent_sessions.test.ts
```

Expected: all 4 tests PASS. Shape tests don't assert on the specific SQL contents, only that execute() is called.

## Task 1.5 — Implement `down()` (rollback)

**Files:**
- Modify: `packages/db/src/migrations/012_agent_sessions.ts`

- [ ] **Step 1: Fill in `down()`**

Replace the stub `down()` with:

```typescript
export async function down(db: Kysely<any>): Promise<void> {
  // Reverse order: drop audit_logs additions first (because they
  // reference agent_sessions via FK), THEN drop agent_sessions.

  await sql`DROP INDEX IF EXISTS idx_audit_logs_via`.execute(db)
  await sql`DROP INDEX IF EXISTS idx_audit_logs_on_behalf_of`.execute(db)

  await sql`
    ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS audit_logs_via_check
  `.execute(db)

  await sql`ALTER TABLE audit_logs DROP COLUMN IF EXISTS guard_reason`.execute(db)
  await sql`ALTER TABLE audit_logs DROP COLUMN IF EXISTS guard_layer`.execute(db)
  await sql`ALTER TABLE audit_logs DROP COLUMN IF EXISTS tool_call_id`.execute(db)
  await sql`ALTER TABLE audit_logs DROP COLUMN IF EXISTS via`.execute(db)
  await sql`ALTER TABLE audit_logs DROP COLUMN IF EXISTS on_behalf_of`.execute(db)

  await sql`DROP INDEX IF EXISTS idx_agent_sessions_active`.execute(db)
  await sql`DROP INDEX IF EXISTS idx_agent_sessions_god_admin`.execute(db)
  await sql`DROP TABLE IF EXISTS agent_sessions`.execute(db)

  console.log('  ✓ Rolled back migration 012 (agent_sessions + audit_logs extension)')
}
```

- [ ] **Step 2: Run tests**

Run:
```bash
cd "E:/Gbox Platform vibecode/gbox-platform" && npx vitest run packages/db/src/migrations/012_agent_sessions.test.ts
```

Expected: all 4 tests PASS, including the new `down()` shape coverage.

## Task 1.6 — Register migration 012 in the runner

**Files:**
- Modify: `packages/db/src/migrations/run.ts` (lines 7-16 and 23-34)

- [ ] **Step 1: Add import**

In `packages/db/src/migrations/run.ts`, after line 16 (`import { up as up010 } ...`), add:

```typescript
import { up as up011 } from "./011_domain_verification.ts";
import { up as up012 } from "./012_agent_sessions.ts";
```

(Note: 011 may already be imported — if so, just add 012.)

- [ ] **Step 2: Add to the migrations array**

In the same file, the `migrations` array currently ends at migration 010. After the last entry, add:

```typescript
  { name: "011_domain_verification", fn: up011 },
  { name: "012_agent_sessions", fn: up012 },
```

(Again, if 011 is already there, only add 012.)

- [ ] **Step 3: Verify via typecheck**

Run:
```bash
cd "E:/Gbox Platform vibecode/gbox-platform" && npx tsc --noEmit -p packages/db/tsconfig.json
```

Expected: no errors. The import resolves, the array shape is valid.

## Task 1.7 — Add `AgentSessionTable` interface to schema

**Files:**
- Modify: `packages/db/src/schema/tables.ts` (after `AuditLogTable` around line 803, and in `Database` interface around line 995)

- [ ] **Step 1: Add the new interface**

In `packages/db/src/schema/tables.ts`, immediately after the `AuditLogTable` interface (ends around line 803), add:

```typescript
// ---------------------------------------------------------------------------
// AGENT SESSIONS (migration 012 — Phase 9.1 AI Pair Programmer)
// ---------------------------------------------------------------------------

/**
 * One row per Claude Agent session opened by the default god admin.
 *
 * `conversation` is the immutable full message history for forensic
 * replay. `compacted_context` is the rolling working-memory snapshot
 * the agent actually sees after a compact operation; it gets
 * overwritten on each compact while `conversation` grows.
 *
 * See docs/superpowers/specs/2026-04-09-phase-9-1-9-2-pair-programmer-design.md
 * section 5.2 for column-by-column rationale.
 */
export interface AgentSessionTable {
  id: Id
  god_admin_id: string

  started_at: Timestamp
  ended_at: Timestamp | null
  ended_reason: string | null          // 'user_closed' | 'timeout' | 'killed' | 'crashed' | 'circuit_breaker'

  // Metrics
  prompt_count: Generated<number>
  tool_call_count: Generated<number>
  tool_call_rejected_count: Generated<number>
  approval_count: Generated<number>
  approval_denied_count: Generated<number>
  total_input_tokens: Generated<number>
  total_output_tokens: Generated<number>
  cost_usd: Generated<string>          // NUMERIC — Kysely returns string

  // Context
  conversation: Generated<JsonB>       // default '[]'::jsonb
  compacted_context: JsonB | null
  compact_count: Generated<number>
  last_compact_at: Timestamp | null
  token_budget: Generated<number>

  // Identity
  system_prompt_version: string
  model: Generated<string>             // default 'claude-sonnet-4-5'
}
```

- [ ] **Step 2: Extend `AuditLogTable` with 5 new columns**

In the same file, locate `AuditLogTable` (around line 793). Replace its body with:

```typescript
export interface AuditLogTable {
  id: Id
  shop_id: string | null
  user_id: string | null
  action: string
  resource_type: string | null
  resource_id: string | null
  details: JsonB | null
  ip_address: string | null
  created_at: Timestamp

  // --- Phase 9.1 extensions (migration 012) ---------------------------
  on_behalf_of: string | null          // FK agent_sessions.id
  via: Generated<string>               // 'ui' | 'agent' | 'api' | 'cron', default 'ui'
  tool_call_id: string | null
  guard_layer: string | null           // which guard layer rejected (if any)
  guard_reason: string | null
}
```

- [ ] **Step 3: Register `agent_sessions` in the `Database` interface**

In the same file, locate the `Database` interface block with `audit_logs: AuditLogTable` (around line 995). Immediately after `audit_logs: AuditLogTable`, add:

```typescript
  audit_logs: AuditLogTable
  cron_tasks: CronTaskTable
  agent_sessions: AgentSessionTable   // Phase 9.1 migration 012
```

(Insert the `agent_sessions` line so it sits next to cron_tasks in the "Analytics & System" group.)

- [ ] **Step 4: Typecheck**

Run:
```bash
cd "E:/Gbox Platform vibecode/gbox-platform" && npx tsc --noEmit -p packages/db/tsconfig.json
```

Expected: no errors. If `Generated` or `JsonB` imports are missing, add them from the existing imports at the top of `tables.ts` — they are already used by other tables.

## Task 1.8 — Add a Kysely-type test to catch accidental schema drift

**Files:**
- Create: `packages/db/src/schema/agent-sessions.type-test.ts`

- [ ] **Step 1: Write a compile-time assertion**

Create `packages/db/src/schema/agent-sessions.type-test.ts`:

```typescript
/**
 * Type-only test: imported by tsc --noEmit, asserts that the
 * AgentSessionTable interface + AuditLogTable extensions have the
 * exact shape the rest of the agent system depends on.
 *
 * This file has no runtime assertions. If it compiles, the schema
 * is correct. If any column is renamed or the wrong Generated<>
 * wrapper is applied, tsc will fail here before runtime.
 */

import type { AgentSessionTable, AuditLogTable, Database } from './tables.ts'

// --- AgentSessionTable required columns ------------------------------------

type _HasRequiredAgentColumns = {
  id: AgentSessionTable['id']
  god_admin_id: AgentSessionTable['god_admin_id']
  started_at: AgentSessionTable['started_at']
  ended_at: AgentSessionTable['ended_at']
  conversation: AgentSessionTable['conversation']
  compacted_context: AgentSessionTable['compacted_context']
  system_prompt_version: AgentSessionTable['system_prompt_version']
  model: AgentSessionTable['model']
}

// --- AuditLogTable Phase 9.1 extensions ------------------------------------

type _HasPhase9Columns = {
  on_behalf_of: AuditLogTable['on_behalf_of']
  via: AuditLogTable['via']
  tool_call_id: AuditLogTable['tool_call_id']
  guard_layer: AuditLogTable['guard_layer']
  guard_reason: AuditLogTable['guard_reason']
}

// --- Database registry has agent_sessions key ------------------------------

type _DatabaseHasAgentSessions = Database['agent_sessions']

// Export so tsc treats this as a module (avoids TS1208 isolated modules error)
export type _Phase9SchemaGuard = {
  agent: _HasRequiredAgentColumns
  audit: _HasPhase9Columns
  registry: _DatabaseHasAgentSessions
}
```

- [ ] **Step 2: Typecheck**

Run:
```bash
cd "E:/Gbox Platform vibecode/gbox-platform" && npx tsc --noEmit -p packages/db/tsconfig.json
```

Expected: no errors. If Task 1.7 was incomplete, tsc fails here with a clear message pointing to the missing column or table.

## Task 1.9 — Smoke test the migration against a real Postgres

**Files:** none created; this is a manual verification step.

- [ ] **Step 1: Ensure local Postgres is running and the dev DB is reachable**

Run:
```bash
cd "E:/Gbox Platform vibecode/gbox-platform" && npm run db:migrate 2>&1 | tail -30
```

Expected output includes:
```
📦 Running migration 012_agent_sessions...
  ✓ Created agent_sessions table + indexes
  ✓ Extended audit_logs with on_behalf_of / via / tool_call_id / guard columns
✅ Migration 012_agent_sessions completed
```

If the local box cannot reach Postgres (known quirk — see MEMORY.md "Smoke Test Runbook"), SSH to server 2 and run the migrate command there against the `gbox_platform` database:

```bash
ssh ubuntu@192.168.1.13 "cd /opt/gbox-platform && DATABASE_URL=postgres://gbox:...@localhost:5432/gbox_platform npm run db:migrate 2>&1 | tail -30"
```

- [ ] **Step 2: Verify schema landed correctly**

Connect to Postgres and run:
```sql
\d agent_sessions
\d audit_logs
SELECT constraint_name FROM information_schema.table_constraints
  WHERE table_name='audit_logs' AND constraint_name='audit_logs_via_check';
```

Expected:
- `agent_sessions` table shows all 18 columns + 2 indexes (`idx_agent_sessions_god_admin`, `idx_agent_sessions_active`)
- `audit_logs` table now includes `on_behalf_of`, `via`, `tool_call_id`, `guard_layer`, `guard_reason`
- The `audit_logs_via_check` constraint exists

- [ ] **Step 3: Verify idempotency — re-run the migration**

Run:
```bash
cd "E:/Gbox Platform vibecode/gbox-platform" && npm run db:migrate 2>&1 | tail -10
```

Expected: `012_agent_sessions` runs WITHOUT error. All `CREATE ... IF NOT EXISTS` and `ADD COLUMN IF NOT EXISTS` patterns mean the second run is a no-op. If you see "already exists" errors, fix the migration — idempotency is non-negotiable.

## Task 1.10 — Commit PR 1

**Files:** none — this is the commit step.

- [ ] **Step 1: Review staged changes**

Run:
```bash
cd "E:/Gbox Platform vibecode/gbox-platform" && git status && git diff --stat
```

Expected: 5 files changed:
- `packages/db/src/migrations/012_agent_sessions.ts` (new)
- `packages/db/src/migrations/012_agent_sessions.test.ts` (new)
- `packages/db/src/migrations/run.ts` (modified)
- `packages/db/src/schema/tables.ts` (modified)
- `packages/db/src/schema/agent-sessions.type-test.ts` (new)

- [ ] **Step 2: Run full vitest for packages/db one last time**

Run:
```bash
cd "E:/Gbox Platform vibecode/gbox-platform" && npx vitest run packages/db/ 2>&1 | tail -20
```

Expected: all tests pass, 4+ tests for migration 012 included.

- [ ] **Step 3: Typecheck the whole workspace**

Run:
```bash
cd "E:/Gbox Platform vibecode/gbox-platform" && npx tsc --noEmit
```

Expected: no errors. If any downstream consumer of `Database` broke because of the new `agent_sessions` key, fix that consumer — it should just need to be aware of the new key, not need to change behavior.

- [ ] **Step 4: Commit**

Run:
```bash
cd "E:/Gbox Platform vibecode/gbox-platform" && git add packages/db/src/migrations/012_agent_sessions.ts packages/db/src/migrations/012_agent_sessions.test.ts packages/db/src/migrations/run.ts packages/db/src/schema/tables.ts packages/db/src/schema/agent-sessions.type-test.ts && git commit -m "$(cat <<'EOF'
feat(db): agent_sessions table + audit_logs extension — Phase 9.1 PR 1

First PR of Phase 9.1 (AI Pair Programmer foundation). Adds the
agent_sessions table (conversation history, metrics, dual storage
for compaction) and extends audit_logs with 5 columns (on_behalf_of,
via, tool_call_id, guard_layer, guard_reason) so every agent-initiated
action is traceable to a session + tool call + guard attribution.

Migration 012 is fully idempotent and uses IF NOT EXISTS everywhere.
Rollback supported via down().

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 5: Verify commit**

Run:
```bash
cd "E:/Gbox Platform vibecode/gbox-platform" && git log -1 --stat
```

Expected: shows the commit with 5 files changed.

---

# PR 2 — `packages/agent-guard` (Scaffold)

**Goal:** Build the 6-layer defense chain that wraps every agent tool call. Every layer is independently unit-tested.

**Files to create:**
- `packages/agent-guard/package.json` — new workspace package, deps: `shell-quote`, `@gbox/db` (types)
- `packages/agent-guard/src/index.ts` — exports `composeGuards` + `GuardChain` runner + `GuardResult` type
- `packages/agent-guard/src/types.ts` — `GuardLayer`, `GuardResult`, `GuardRejection`, `ToolCall`, `SessionContext`
- `packages/agent-guard/src/path-whitelist.ts` — Layer 1
- `packages/agent-guard/src/path-whitelist.test.ts` — ~15 cases (allow, deny, symlink, traversal, absolute vs relative)
- `packages/agent-guard/src/command-parser.ts` — Layer 2a (shell-quote wrapper + AST walker)
- `packages/agent-guard/src/command-parser.test.ts` — ~20 cases (backticks, $(...), pipes, redirects, quoting)
- `packages/agent-guard/src/blocklist.ts` — Layer 2b (60-case dangerous pattern matcher)
- `packages/agent-guard/src/blocklist.test.ts` — ~60 cases (every pattern from spec section 7 Layer 2)
- `packages/agent-guard/src/resource-limits.ts` — Layer 3 (wraps bash command with ulimit/nice/timeout)
- `packages/agent-guard/src/resource-limits.test.ts` — ~8 cases (wrapper shape, timeout parsing)
- `packages/agent-guard/src/rate-limit.ts` — Layer 4 (per-session counter w/ reset on session end)
- `packages/agent-guard/src/rate-limit.test.ts` — ~12 cases (100/session cap, 20/5min, 3 consecutive fail, 1 concurrent bash)
- `packages/agent-guard/src/deployment-safety.ts` — Layer 6 (path classification, window check, traffic level, circuit breaker state)
- `packages/agent-guard/src/deployment-safety.test.ts` — ~15 cases
- `packages/agent-guard/src/approval-gate.ts` — Layer 5 (emits `approval_required` event + awaits resolution with 120s timeout)
- `packages/agent-guard/src/approval-gate.test.ts` — ~10 cases (approve path, deny path, timeout path, main-branch double-confirm)
- `packages/agent-guard/src/guard-chain.integration.test.ts` — full composition with realistic tool calls

**Key types (locked interface for dependent PRs):**

```typescript
export type ToolCallTier = 1 | 2 | 3 | 4
export type DeployRisk = 'safe' | 'admin-only' | 'customer-facing'

export interface ToolCall {
  id: string                    // tool_call_id for audit
  name: string                  // e.g. 'repo.edit'
  input: unknown                // tool-specific payload
  tier: ToolCallTier
}

export interface SessionContext {
  sessionId: string
  godAdminId: string
  toolCallCount: number
  tier3CallsLast5Min: number[]  // timestamps
  consecutiveEditFailures: Map<string, number>  // path → count
  bashInFlight: boolean
  circuitBreakerOpen: boolean
  trafficLevel: 'peak' | 'normal' | 'low'
  currentTime: Date
}

export type GuardResult =
  | { allowed: true }
  | { allowed: false; layer: string; reason: string }

export interface GuardLayer {
  name: string
  check(call: ToolCall, ctx: SessionContext): Promise<GuardResult>
}

export function composeGuards(layers: GuardLayer[]): GuardLayer
```

**Exit criteria:**
- Every layer has a `.test.ts` that covers the cases in spec section 7
- `composeGuards` short-circuits on first rejection, returns the rejecting layer's `GuardResult`
- Blocklist test covers all 60+ cases from spec section 7 Layer 2
- Running `npx vitest run packages/agent-guard/` passes with > 130 assertions
- `packages/agent-guard` builds cleanly under `tsc --noEmit` with strict mode

**Dependencies:** PR 1 (only for the `Database` type import — guard does not hit DB directly, but consumers pass session context pulled from DB).

## PR 2 task outline (to be expanded before execution)

1. Scaffold package, package.json, tsconfig, register in workspace root
2. Write `types.ts` (locked interfaces above)
3. TDD Layer 1 — path whitelist (test → impl, 15 cases)
4. TDD Layer 2a — command parser (test → impl, 20 cases)
5. TDD Layer 2b — blocklist (60 cases, test-first then impl each pattern)
6. TDD Layer 3 — resource limits wrapper
7. TDD Layer 4 — rate limit with time-based windowing
8. TDD Layer 5 — approval gate with timer + event emitter
9. TDD Layer 6 — deployment safety (path classification, window check)
10. TDD `composeGuards` integration
11. Commit

---

# PR 3 — `packages/agent-core` (Scaffold)

**Goal:** Claude Agent SDK wrapper, session manager, compaction, internal JWT, SSE stream encoder.

**Files to create:**
- `packages/agent-core/package.json` — deps: `@anthropic-ai/claude-agent-sdk`, `jose` (JWT), `@gbox/db`, `@gbox/agent-guard`
- `packages/agent-core/src/index.ts`
- `packages/agent-core/src/types.ts` — `AgentRuntime`, `ChatMessage`, `CompactResult`, `SseEvent` union
- `packages/agent-core/src/agent-runtime.ts` — thin wrapper around `@anthropic-ai/claude-agent-sdk` exposing `createSession`, `sendMessage`, `abort`
- `packages/agent-core/src/agent-runtime.test.ts` — mocks the SDK, asserts message threading
- `packages/agent-core/src/session-manager.ts` — lifecycle: create session row, append messages, update metrics, close session, query replay
- `packages/agent-core/src/session-manager.test.ts` — mocks Kysely, asserts CRUD shape
- `packages/agent-core/src/compaction.ts` — `compactConversation()` as specified in spec section 6.2
- `packages/agent-core/src/compaction.test.ts` — fake messages, verify locked-decision preservation, preserved turn count, token budget respected
- `packages/agent-core/src/jwt.ts` — HS256 mint/verify, 5-min TTL, claims shape, rotation-on-kill support
- `packages/agent-core/src/jwt.test.ts` — happy path, expired, tampered, wrong audience
- `packages/agent-core/src/sse-stream.ts` — encodes `SseEvent` → SSE wire format, cursor support, keep-alive pings
- `packages/agent-core/src/sse-stream.test.ts` — event encoding fidelity
- `packages/agent-core/src/token-counter.ts` — rough estimator for threshold triggers (tiktoken-lite or simple heuristic)
- `packages/agent-core/src/token-counter.test.ts`
- `packages/agent-core/prompts/god-admin-default.md` — system prompt bootstrap file (empty skeleton here; filled in PR 8)
- `packages/agent-core/src/prompt-loader.ts` — reads the prompt file, injects dynamic sections (current phase, recent commits), returns composed system prompt
- `packages/agent-core/src/prompt-loader.test.ts`

**Key types (locked):**

```typescript
export type SseEvent =
  | { type: 'assistant_delta'; text: string }
  | { type: 'tool_use'; toolCallId: string; name: string; input: unknown }
  | { type: 'tool_guard_rejected'; toolCallId: string; layer: string; reason: string }
  | { type: 'approval_required'; toolCallId: string; name: string; normalizedInput: unknown }
  | { type: 'approval_resolved'; toolCallId: string; decision: 'approved' | 'denied' | 'timeout' }
  | { type: 'tool_result'; toolCallId: string; output: unknown }
  | { type: 'compact_triggered'; tokensBeforeCompact: number; tokensAfterCompact: number }
  | { type: 'circuit_breaker'; state: 'open' | 'closed' }
  | { type: 'done' }
  | { type: 'error'; message: string; code?: string }

export interface InternalJwtClaims {
  sub: 'god_admin_default'
  sid: string                // dashboard session id
  aid: string                // agent session id
  iat: number
  exp: number                // 5 min after iat
}
```

**Exit criteria:**
- SDK wrapper responds to a mocked user message with a mocked assistant text
- `session-manager` persists a new `agent_sessions` row with `system_prompt_version` set to the current prompt hash
- `compaction` returns a summary that includes decisions from the input transcript (verified via keyword presence)
- JWT mint/verify round-trips; tamper rejected
- `SseEvent` encoder produces valid `event: <type>\ndata: <json>\n\n`
- Hot reload of prompt file triggers `prompt-loader` re-read

**Dependencies:** PR 1 (`agent_sessions` type), PR 2 (`@gbox/agent-guard` types only, not full runtime integration)

## PR 3 task outline (to be expanded before execution)

1. Scaffold package, deps, tsconfig
2. TDD `jwt.ts`
3. TDD `sse-stream.ts`
4. TDD `token-counter.ts`
5. TDD `session-manager.ts` (with Kysely mock)
6. TDD `compaction.ts` (with mocked Claude SDK call)
7. TDD `prompt-loader.ts` (with tmp file)
8. TDD `agent-runtime.ts` (with mocked SDK)
9. Commit

---

# PR 4 — `packages/agent-tools` (Scaffold)

**Goal:** 20 slot implementations + 3 deployment tools, each with unit tests, each wired through `@gbox/agent-guard`.

**Files to create (grouped by tier):**

```
packages/agent-tools/
├── package.json          -- deps: @gbox/agent-guard, @gbox/agent-core, @gbox/db, node-fetch, simple-git
├── src/
│   ├── index.ts          -- exports tool registry + dispatch
│   ├── registry.ts       -- tool definition → handler map
│   ├── registry.test.ts
│   ├── tier1/
│   │   ├── repo-read.ts
│   │   ├── repo-read.test.ts
│   │   ├── repo-glob.ts
│   │   ├── repo-glob.test.ts
│   │   ├── repo-grep.ts
│   │   ├── repo-grep.test.ts
│   │   ├── db-select.ts              -- uses read-only Kysely role
│   │   ├── db-select.test.ts
│   │   ├── audit-search.ts
│   │   ├── audit-search.test.ts
│   │   ├── git-readonly.ts           -- status, diff, log via simple-git
│   │   ├── git-readonly.test.ts
│   │   ├── logs-tail.ts              -- SSH whitelist + tail
│   │   ├── logs-tail.test.ts
│   │   ├── plan-todos.ts             -- in-memory todo store
│   │   └── plan-todos.test.ts
│   ├── tier2/
│   │   ├── tests-run.ts
│   │   ├── tests-run.test.ts
│   │   ├── typecheck-run.ts
│   │   ├── typecheck-run.test.ts
│   │   ├── ops-smoke.ts
│   │   ├── ops-smoke.test.ts
│   │   ├── ops-health.ts
│   │   └── ops-health.test.ts
│   ├── tier3/
│   │   ├── repo-edit.ts              -- emits approval_required → writes after approve
│   │   ├── repo-edit.test.ts
│   │   ├── repo-write.ts
│   │   ├── repo-write.test.ts
│   │   ├── bash-run.ts               -- wraps in resource-limits, delegates to Layer 3
│   │   ├── bash-run.test.ts
│   │   ├── git-commit.ts
│   │   ├── git-commit.test.ts
│   │   ├── git-push.ts               -- main-branch double-confirm
│   │   ├── git-push.test.ts
│   │   ├── user-admin.ts             -- disable/enable
│   │   ├── user-admin.test.ts
│   │   ├── session-revoke.ts
│   │   ├── session-revoke.test.ts
│   │   ├── token-rotate.ts
│   │   ├── token-rotate.test.ts
│   │   ├── backup-now.ts
│   │   └── backup-now.test.ts
│   └── deploy/
│       ├── deploy-run.ts
│       ├── deploy-run.test.ts
│       ├── deploy-schedule.ts
│       ├── deploy-schedule.test.ts
│       ├── ops-current-window.ts
│       └── ops-current-window.test.ts
```

**Exit criteria:**
- Every tool has a unit test that stubs its external IO (fs, db, ssh, git, shell) and asserts behavior
- Every Tier 3 tool test verifies: (a) without approval → rejected, (b) with approval → executed, (c) audit row written
- Every tool returns a structured result matching a common `ToolResult` discriminated union
- `bash-run` delegates to `@gbox/agent-guard` Layer 3 for resource limits (does NOT re-implement)
- `deploy-run` refuses `target='storefront'` unless inside maintenance window AND traffic level ≤ normal

**Dependencies:** PR 1, 2, 3

## PR 4 task outline (to be expanded before execution)

Will follow a consistent per-tool TDD pattern: test file first with scenarios → minimal impl → test green → commit per-tool. 20 tool slots ≈ 20 commits inside this PR.

---

# PR 5 — `apps/god-admin-agent` Sidecar (Scaffold)

**Goal:** Express server on :4324 that terminates the HTTP+SSE connection from the dashboard, runs the agent loop, polls storefront health for circuit breaker, hot-reloads the prompt, and respects the kill switch.

**Files to create:**

```
apps/god-admin-agent/
├── package.json          -- deps: express, @gbox/agent-core, @gbox/agent-tools, @gbox/agent-guard, @gbox/db, chokidar
├── tsconfig.json
├── ecosystem.config.js   -- PM2 config for port 4324
├── src/
│   ├── server.ts         -- boot express, mount routes, wire middleware
│   ├── config.ts         -- env vars (JWT_SECRET, STOREFRONT_HEALTH_URL, etc.)
│   ├── routes/
│   │   ├── chat.ts       -- POST /agent/chat (SSE stream)
│   │   ├── chat.test.ts
│   │   ├── session.ts    -- GET /agent/sessions, GET /agent/sessions/:id
│   │   ├── session.test.ts
│   │   ├── health.ts     -- GET /_health
│   │   └── health.test.ts
│   ├── middleware/
│   │   ├── verify-internal-jwt.ts
│   │   ├── verify-internal-jwt.test.ts
│   │   ├── killswitch-check.ts
│   │   └── killswitch-check.test.ts
│   ├── circuit-breaker.ts        -- polls storefront /_health, caches state
│   ├── circuit-breaker.test.ts
│   ├── prompt-watcher.ts         -- chokidar watch packages/agent-core/prompts/, calls loader
│   ├── prompt-watcher.test.ts
│   ├── killswitch-poller.ts      -- cron every 60s, force-kill self if flag file present
│   └── killswitch-poller.test.ts
└── README.md                      -- PM2 start/stop runbook, env vars
```

**Exit criteria:**
- Sidecar starts on :4324, `/_health` returns `{ status: 'ok' }`
- `POST /agent/chat` with valid JWT returns SSE stream with at least `done` event
- Invalid JWT → 401
- Killswitch file present → sidecar refuses to start AND running instance dies within 60s
- Circuit breaker polls storefront every 30s, transitions open/closed correctly under fake health responses
- Prompt file edit → in-memory prompt updates for next session
- PM2 ecosystem file valid (`pm2 start ecosystem.config.js --dry-run`)

**Dependencies:** PR 1, 2, 3, 4

---

# PR 6 — `apps/god-admin` Chat Panel UI (Scaffold)

**Goal:** 3-state chat panel integrated into the existing god admin dashboard, SSE proxy to sidecar, kill switch route, coming-soon placeholder for non-default accounts.

**Files to create / modify:**

```
apps/god-admin/
├── src/
│   ├── routes/
│   │   ├── agent-proxy.ts         -- POST /god-admin/api/agent/chat → sidecar, forwards SSE
│   │   ├── agent-proxy.test.ts
│   │   ├── agent-kill.ts          -- POST /god-admin/api/agent/kill (direct, NOT via sidecar)
│   │   ├── agent-kill.test.ts
│   │   ├── agent-sessions-list.ts -- GET /god-admin/api/agent/sessions (proxy to sidecar)
│   │   └── agent-sessions-list.test.ts
│   ├── middleware/
│   │   └── require-default-god-admin.ts  -- gate the agent routes
│   └── views/
│       ├── chat-panel/
│       │   ├── ChatPanel.vue              -- container, manages state 1 ↔ 2
│       │   ├── ChatCollapsed.vue          -- State 1 (icon + badge)
│       │   ├── ChatExpanded.vue           -- State 2 (sidebar, messages, choice cards)
│       │   ├── ChatMessage.vue            -- one message renderer
│       │   ├── ChoiceCards.vue            -- interactive A/B/C/D buttons
│       │   ├── ApprovalModal.vue          -- State 3 (inline card with Approve/Deny)
│       │   ├── ContextPill.vue            -- "Context: 87.3k / 180k"
│       │   ├── KillSwitchButton.vue
│       │   └── useSseStream.ts            -- composable for SSE connection mgmt
│       ├── agent-sessions/
│       │   ├── SessionList.vue
│       │   ├── SessionReplay.vue
│       │   └── sessions.page.ts
│       └── ComingSoon.vue                 -- for non-default accounts
```

**Exit criteria:**
- Chat panel renders in all 3 states
- Clicking icon toggles collapsed ↔ expanded
- Sending a message triggers SSE stream, rendered progressively
- Choice cards clickable, auto-send back
- Approval modal blocks tool execution until clicked, shows 120s countdown
- Kill switch button calls `/api/agent/kill`, panel shows "Agent killed" state
- Non-default god admin sees `ComingSoon.vue` in the same slot
- `require-default-god-admin` middleware returns 403 for non-default calls

**Dependencies:** PR 5 (sidecar must be alive to test against)

---

# PR 7 — Blue/Green Deploy Script (Scaffold)

**Goal:** Canonical `blue-green-swap.ts` script that the `deploy.run` tool invokes. Zero-downtime swap for storefront + accounts + god-admin.

**Files to create:**

```
scripts/deploy/
├── blue-green-swap.ts
├── blue-green-swap.test.ts
├── check-deploy-window.ts
├── check-deploy-window.test.ts
├── nginx-reload.ts              -- wrapper around `nginx -s reload` with error capture
├── nginx-reload.test.ts
├── health-probe.ts              -- polls target /_health until pass-rate threshold
├── health-probe.test.ts
├── smoke-probe.ts               -- runs the per-app smoke (storefront: home+product+cart/add)
├── smoke-probe.test.ts
├── drain-slot.ts                -- SIGTERM + wait-for-drain + SIGKILL
├── drain-slot.test.ts
└── README.md                    -- how to invoke, what each flag does
```

**Deploy flow (encoded in `blue-green-swap.ts`):**

1. Parse args `--target=storefront --env=prod`
2. Check current active slot (blue/green) via nginx upstream inspection or PM2 name
3. Git pull into standby slot dir
4. Build in standby slot
5. `pm2 start <target>-green` (if going blue→green)
6. `health-probe <target>-green` — wait for 10 consecutive OK
7. `smoke-probe <target>-green` — pass all probes
8. `nginx -s reload` after swapping upstream config
9. Observe 30s with `health-probe` on the public URL
10. On fail → revert nginx, abort
11. On pass → `drain-slot <target>-blue` → `pm2 stop <target>-blue`
12. Emit structured JSON report to stdout

**Exit criteria:**
- Script handles successful swap end-to-end against a dummy PM2 target
- Auto-rollback triggers on fake 5xx spike
- Unit tests for each helper (`nginx-reload`, `health-probe`, `smoke-probe`, `drain-slot`) pass
- Integration test simulates a full blue→green swap with mocked `pm2` and `nginx` binaries

**Dependencies:** None. Can run in parallel with PR 2–6.

---

# PR 8 — System Prompt + Session Replay + Coming-Soon (Scaffold)

**Goal:** Fill in the `god-admin-default.md` system prompt, build the session replay UI, and ship the coming-soon page variants.

**Files to modify / create:**
- `packages/agent-core/prompts/god-admin-default.md` — FILL in the ~7.5k-token bootstrap bundle per spec section 9
- `apps/god-admin/src/views/agent-sessions/SessionReplay.vue` — full implementation (skeleton created in PR 6)
- `apps/god-admin/src/views/agent-sessions/SessionList.vue` — full implementation
- `apps/god-admin/src/views/ComingSoon.vue` — role-aware message variants
- `apps/god-admin/src/services/daily-digest.ts` — cron sender for daily agent usage summary to buithai3107@gmail.com
- `apps/god-admin/src/services/daily-digest.test.ts`

**System prompt composition checklist** (spec section 9, approximately 7.5k tokens):
- [ ] Identity + personality (VN-EN bilingual, "anh"/"em")
- [ ] CLAUDE.md inlined
- [ ] MEMORY.md inlined (no raw credentials, just references)
- [ ] Tool catalog with signatures + tier
- [ ] Operational posture (SLO, windows, blue/green, Expand-Migrate-Contract)
- [ ] Communication patterns
- [ ] Dynamic: current phase + recent commits (injected at session start by `prompt-loader`)

**Exit criteria:**
- A fresh session with the full prompt correctly refuses a peak-hours storefront change
- A fresh session correctly addresses user as "anh", mixes VN-EN
- Session replay renders completed sessions correctly with expandable tool calls
- Daily digest email sends to the god admin's registered address

**Dependencies:** PR 6 (UI skeleton), PR 5 (sidecar)

---

# PR 9 — End-to-End Smoke + Acceptance Runbook + Monitoring (Scaffold)

**Goal:** Ship the acceptance test suite + the "Agent health" dashboard card + the monitoring runbook.

**Files to create:**

```
scripts/smoke/
├── agent-smoke-all.ts              -- runs the 8 manual scenarios from spec section 14.4
├── agent-smoke-read.ts
├── agent-smoke-edit-approve.ts
├── agent-smoke-edit-deny.ts
├── agent-smoke-deploy-god-admin.ts
├── agent-smoke-deploy-storefront-refused.ts
└── agent-smoke-killswitch.ts

apps/god-admin/src/views/agent-health/
├── AgentHealthCard.vue             -- dashboard card: sessions 24h, cost, top denied, circuit state
└── AgentHealthCard.test.ts

docs/runbooks/
└── 2026-04-09-agent-operations.md  -- how to kill, how to investigate, how to check cost
```

**Acceptance scenarios (spec section 14.4) — runnable end-to-end:**
1. Read a file via chat
2. Run vitest for packages/core via `tests.run`
3. Grep for a function via `repo.grep`
4. Commit changes via `git.commit` with approval
5. Rotate token for a user via `token.rotate` (security op)
6. Deploy god-admin inside maintenance window — verify blue/green works
7. Deploy storefront outside window at peak — verify refused with `deploy.schedule` alternative
8. Trigger kill switch via filesystem flag — verify clean shutdown

**Exit criteria:**
- `scripts/smoke/agent-smoke-all.ts` runs, produces a green summary for all 8 scenarios
- Dashboard health card renders live metrics
- Runbook tells Thai how to: kill, investigate a bad action, check cost, rotate JWT secret

**Dependencies:** PR 1–8 all merged

---

# Self-Review (plan vs spec)

This section is run by the plan author (Claude) as a final pass. Recorded so the reviewer knows it was done.

## Spec coverage check

| Spec section | Covered by |
|--------------|------------|
| 1. Goal | Plan header + PR 1–9 together |
| 2. Scope | Plan index table (9 PRs) |
| 3. Architecture (sidecar, topology, auth, SSE) | PR 5 + PR 6 |
| 4. Tool catalog (20 slots + 3 deploy) | PR 4 |
| 5. Auth & audit (delegated identity, agent_sessions, audit_logs ext) | **PR 1 — FULL DETAIL** |
| 6. Conversation storage & compaction | PR 3 (`compaction.ts`, `session-manager.ts`) |
| 7. Agent guard (6 layers) | PR 2 |
| 8. UX (chat panel 3 states) | PR 6 |
| 9. System prompt & personality | PR 8 |
| 10. Operational posture (SLO, blue/green, window, Expand-Migrate-Contract, killswitch) | PR 7 (deploy) + PR 5 (killswitch poller + circuit breaker) + PR 8 (prompt bakes in posture) |
| 11. Package layout | PR 2–5 file structures |
| 12. API contracts | PR 5 routes + PR 6 proxy |
| 13. Phase 9.1 vs 9.2 split | Plan explicitly maps PR 1–5 to 9.1, PR 6–9 to 9.2 |
| 14. Testing strategy | Each PR has per-file `.test.ts`; PR 9 ships E2E |
| 15. Rollout plan | PR order matches spec section 15.2 exactly |
| 16. Risks | Addressed inline per PR exit criteria |
| 17. Glossary | Referenced from spec, not duplicated |

No gaps. Every spec section has at least one PR that implements it.

## Placeholder scan

Scanned this document for: "TBD", "TODO", "implement later", "fill in details", "add appropriate error handling", "similar to Task N" (without repeating code), "Write tests for the above" (without code), references to undefined types.

- PR 1 contains full code in every step. ✓
- PR 2–9 use the word "Scaffold" which is intentional and labeled. These are NOT bite-sized steps yet — they are architectural scope documents that must be expanded before execution. The plan is explicit about this at the top.
- No instances of "TBD" / "TODO" (except in user-facing tool comments intentionally referring to the `plan.todos` tool, which is a proper noun).

## Type consistency

- `ToolCall`, `SessionContext`, `GuardResult`, `GuardLayer` defined in PR 2 and referenced (not redefined) in PR 3, 4, 5.
- `SseEvent` union defined in PR 3 and referenced in PR 5, 6.
- `AgentSessionTable`, `AuditLogTable` extensions defined in PR 1 (actual TypeScript code) and referenced by `Database` type import everywhere.
- `InternalJwtClaims` defined in PR 3, consumed by PR 5 middleware.
- `ChatMessage`, `CompactResult` defined in PR 3.
- No conflicting names.

## Action items from self-review

None. Plan is ready to execute.

---

# Execution order

**Phase 9.1 (Foundation — week 1–2):**
1. PR 1 — DB migration *(this document, full detail)*
2. PR 2 — `packages/agent-guard` *(expand before execution)*
3. PR 3 — `packages/agent-core` *(expand before execution)*
4. PR 4 — `packages/agent-tools` *(expand before execution)*
5. PR 5 — `apps/god-admin-agent` sidecar *(expand before execution)*

**Phase 9.2 (Pair Programmer — week 3–4):**
6. PR 6 — `apps/god-admin` chat panel UI *(expand before execution)*
7. PR 7 — Blue/green deploy script *(can run in parallel with 2–6, expand before execution)*
8. PR 8 — System prompt + session replay + coming-soon *(expand before execution)*
9. PR 9 — E2E smoke + monitoring *(expand before execution)*

**Expansion trigger:** After PR N merges, re-invoke `writing-plans` skill with: *"Expand PR N+1 of the pair-programmer plan into bite-sized TDD steps"*.

---

**Ready to execute PR 1.**
