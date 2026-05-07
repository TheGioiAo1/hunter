# Clone Pro Phase 7 — BullMQ Worker + Production Hardening

**Date:** 2026-04-17
**Owner:** Thai Bui
**Source plan:** `docs/superpowers/plans/2026-04-13-website-cloner-pro-plan.md` (Phase 7, lines 625-672)
**Status:** Approved by owner 2026-04-17 (Q1=A full, Q2=shared process, Q3=migration 046, Q4=sanitize-html, Q5=strict robots)

---

## 1. Why

Clone Pro Phase 6 finished **domain-level dedupe** and shipped the `Block + Replace` escape hatch. The pipeline itself, however, still runs **fire-and-forget inside the store-admin HTTP process**:

```ts
// apps/store-admin/src/pages/clone-pro/start.ts:348
// 5. Fire the pipeline — fire-and-forget, must never throw.
void Promise.resolve().then(() => runJob(db, { ... }))
```

Concrete gaps this creates:

1. **Restart = data loss.** `pm2 restart gbox-store-admin` during a 12-minute clone → the job vanishes mid-stage. The DB row stays at `running` forever; merchant sees a permanently stuck progress bar.
2. **No retry.** A transient `ECONNRESET` to the source site kills the whole clone. Second attempt = full restart from 0%.
3. **No per-shop cap.** A merchant firing 10 clones in parallel can starve the shared event loop and freeze the admin for every other shop on the box.
4. **No politeness.** Current crawler hits source sites as fast as `safeFetch` will go, with no `User-Agent` identification, no `robots.txt` respect, and no crawl-delay.
5. **XSS surface.** Cloned HTML lands in our storefront verbatim. `<script>`, `<iframe>`, `onclick="…"`, `data:` image URIs, and `@import` from hostile CDNs all round-trip today.
6. **Partial failure = total failure.** A single stage throw aborts the pipeline. Products + pages imported so far are discarded even though they're valid.
7. **No audit trail.** God Admin cannot answer *"who cloned bibliobloom.com yesterday, from which IP, against which shop?"* — there's no row in `audit_logs` for clone events.

Phase 7 closes every one of these gaps in a single rollout.

---

## 2. Scope

Seven sub-phases, all shipped together:

| # | Sub-phase | Goal |
|---|---|---|
| 7.1 | **Wire the Worker** | `POST /clone-pro/start` enqueues to BullMQ; `gbox-store-admin` starts `cloneWorker` at boot; jobs survive `pm2 restart`. |
| 7.2 | **Per-Shop Concurrency Cap** | Max 2 concurrent clone jobs per `shop_id`. Excess jobs wait in queue, don't fail. |
| 7.3 | **Crawler Politeness** | `robots.txt` strict enforcement (Disallow = skip + log); 5 req/s rate limit per host; stable `User-Agent`. |
| 7.4 | **Content Sanitization** | XSS defense on cloned HTML + CSS + image URLs, via `sanitize-html`. |
| 7.5 | **Partial Results** | One stage failure does NOT abort subsequent stages; terminal status = `succeeded_partial` when at least one stage failed but others produced content. |
| 7.6 | **Audit Logging** | One `audit_logs` row per clone job (started + terminal). God Admin queryable. |
| 7.7 | **Smoke Test & Deploy** | Full local test suite green; migration 046 on server 1; `pm2 restart`; manual e2e smoke on bibliobloom. |

**Out of scope (deferred to a future phase):**
- Splitting the worker into a separate PM2 process (Q2 confirms same-process for now).
- Per-source-host concurrency cap (only per-shop is in scope).
- Distributed rate-limiting (single-process `p-limit` is sufficient until we scale to multiple clone workers).
- God Admin Clone Dashboard UI — that's Phase 8, independent.
- Resume-from-stage after a crash (BullMQ will retry from job start; stage-level resume is a future optimization).

---

## 3. Decisions Locked

### 3.1 Q1 — Full Phase 7 (owner approved)

All seven sub-phases ship together. No MVP cut.

### 3.2 Q2 — Same-process worker (owner approved)

`startCloneWorker(db)` is called from `startWorkers(db)` in `packages/core/src/modules/queue/workers.ts` — same function that already starts the webhook worker. That means one `pm2` process (`gbox-store-admin`, PID 482172 at the time of writing) runs:
- the HTTP server
- the webhook worker
- the new clone worker

Rationale: simpler ops (one PM2 entry to monitor), `db` / `redis` connections shared. If concurrent clones saturate the shared event loop in production, we split later by adding a new `gbox-clone-worker` PM2 entry that calls `startCloneWorker()` only — no code change to producers needed.

### 3.3 Q3 — Migration 046 (owner approved)

Add `bullmq_job_id VARCHAR(64) NULL` to `storefront_clone_jobs`. Populated by the `POST /start` handler the moment `enqueueWebsiteClone()` returns. Used for:
- **Cancel from UI** (future): look up BullMQ job by id, call `.remove()`.
- **Debug**: God Admin can jump from `storefront_clone_jobs.id` → BullMQ dashboard entry for the same job.
- **Reconciliation**: on worker boot, we can scan `status = 'pending'` rows and re-enqueue any job whose `bullmq_job_id` is no longer in the queue (stalled recovery).

Index: `CREATE INDEX IF NOT EXISTS idx_clone_jobs_bullmq_job_id ON storefront_clone_jobs (bullmq_job_id) WHERE bullmq_job_id IS NOT NULL;` — partial, so legacy rows don't bloat the B-tree.

Down migration drops the column + index.

### 3.4 Q4 — `sanitize-html` (owner approved)

Install `sanitize-html` + `@types/sanitize-html` as deps of `@gbox/core`. Wrap behind a single helper `sanitizeClonedHtml(html: string): string` so the dependency is swappable.

Default config (locked by this spec):
```ts
{
  allowedTags: [
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'p', 'br', 'hr',
    'ul', 'ol', 'li',
    'strong', 'em', 'b', 'i', 'u', 's',
    'a', 'img',
    'blockquote', 'code', 'pre',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
    'div', 'span',  // needed for theme class hooks
  ],
  allowedAttributes: {
    a: ['href', 'name', 'target', 'rel', 'title'],
    img: ['src', 'alt', 'title', 'width', 'height', 'loading'],
    '*': ['class', 'id', 'style'],  // style sanitized separately
  },
  allowedSchemes: ['http', 'https', 'mailto'],  // NO data:, NO javascript:, NO file:
  allowedSchemesByTag: {
    img: ['http', 'https'],  // images must be http(s) so we can rehost
  },
  disallowedTagsMode: 'discard',
}
```

`<script>`, `<iframe>`, `<object>`, `<embed>`, `<form>`, and every event-handler attribute (`onclick`, `onload`, `onerror`, `onmouseover`, …) are NOT in `allowedTags`/`allowedAttributes` → `sanitize-html` strips them by default.

CSS `@import` allowlist (separate helper `sanitizeClonedCss(css: string): string`):
```
ALLOWED_IMPORT_HOSTS = [
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'cdn.jsdelivr.net',
  'cdnjs.cloudflare.com',
  'unpkg.com',
]
```

Any `@import url(...)` to a host not on the list is deleted from the CSS. Logged at `warn` level with the source host for observability.

### 3.5 Q5 — Strict robots.txt (owner approved)

Before fetching any URL from the source domain, the crawler:

1. Fetches `<source>/robots.txt` (best-effort — 404 = no restrictions).
2. Parses with `robots-parser` (adding as a new dep — ~2k weekly, zero-dep).
3. For each candidate URL, calls `robots.isAllowed(url, 'GboxCloneBot')`.
4. If `false`: **skip** the URL, append a warning to the stage's log: `"robots.txt disallows /path/x"`. The job continues with the remaining allowed URLs.
5. `robots.txt` response is cached for the duration of the job (one fetch per host per job).

### 3.6 User-Agent

All `safeFetch` calls originating from clone-pro use:

```
GboxCloneBot/4.0 (+https://gbox.co/bot)
```

(Pinned in a new constant `CLONE_BOT_USER_AGENT` exported from `packages/core/src/modules/clone-pro/constants.ts`.)

### 3.7 Rate limit — 5 req/s per host

Implemented with `p-limit` (already in deps from the orders system) OR a hand-rolled token bucket in `packages/core/src/modules/clone-pro/rate-limiter.ts` — decision deferred to implementation, whichever is simpler. Contract:

```ts
export function rateLimitedFetch(host: string, fn: () => Promise<Response>): Promise<Response>
```

Max 5 concurrent resolves per `host` per second. Per-worker-process (sufficient because concurrency is 2 and jobs rarely cluster on one host).

### 3.8 Partial results

New terminal status: `succeeded_partial`.

State machine:
```
pending → running → succeeded
                 → succeeded_partial   (NEW — at least one stage threw, but others produced content)
                 → failed              (every stage threw, OR a fatal pre-stage error)
```

The runner already wraps each stage in `try/catch` and appends to `stages_json`. Change: instead of re-throwing from the first failed stage, we capture the error into the stage row and **continue**. At the end of the pipeline:
- All stages succeeded → `succeeded`
- Some stages succeeded, some failed → `succeeded_partial`
- All stages failed OR pre-stage crash → `failed`

Bell-icon notification:
- `succeeded` → no notification (user sees green on detail page).
- `succeeded_partial` → `clone_pro_partial` notification: `"Clone finished with X failed stages"`, links to detail page.
- `failed` → `clone_pro_failed` (existing).

### 3.9 Audit logging

Every clone job writes **two** `audit_logs` rows:

| When | `action` | `details` (jsonb) |
|---|---|---|
| `POST /start` returns 200 + job created | `clone_pro.started` | `{ job_id, source_url, canonical_domain, scope }` |
| Pipeline reaches terminal status | `clone_pro.<status>` | `{ job_id, duration_ms, products_imported, pages_imported, failed_stages? }` |

Columns:
- `shop_id` — from the clone job
- `user_id` — from the request (session); `NULL` on terminal log (worker has no user context)
- `resource_type` — `'storefront_clone_job'`
- `resource_id` — `job.id`
- `ip_address` — from req, `NULL` on terminal log

---

## 4. Database Migration — 046

**File:** `packages/db/src/migrations/046_clone_jobs_bullmq_link.ts`

`up()`:
```sql
ALTER TABLE storefront_clone_jobs
  ADD COLUMN bullmq_job_id VARCHAR(64) NULL;

CREATE INDEX IF NOT EXISTS idx_clone_jobs_bullmq_job_id
  ON storefront_clone_jobs (bullmq_job_id)
  WHERE bullmq_job_id IS NOT NULL;
```

`down()`:
```sql
DROP INDEX IF EXISTS idx_clone_jobs_bullmq_job_id;
ALTER TABLE storefront_clone_jobs DROP COLUMN IF EXISTS bullmq_job_id;
```

No data backfill — existing jobs have `bullmq_job_id = NULL` forever; new jobs populate on insert.

Register in `packages/db/src/migrations/run.ts` alongside 045.

Schema change in `packages/db/src/schema/tables.ts`:
```ts
export interface StorefrontCloneJobTable {
  // … existing columns …
  bullmq_job_id: string | null   // Phase 7 — BullMQ job link
}
```

---

## 5. Code-Level Contracts

### 5.1 `startWorkers(db)` wires the clone worker

`packages/core/src/modules/queue/workers.ts`:
```ts
import { startCloneWorker } from './clone-worker.js'

export function startWorkers(db: Kysely<Database>): void {
  if (workersStarted) return
  workersStarted = true

  // … existing webhook worker …

  const cloneWorker = startCloneWorker(db)
  activeWorkers.push(cloneWorker)
}
```

### 5.2 `start.ts` enqueues instead of running in-process

```ts
// OLD:
void Promise.resolve().then(() => runJob(db, { … }))

// NEW:
const bullmqJob = await enqueueWebsiteClone({
  shopId: store.id,
  sourceUrl: normalisedUrl,
  scope: config.scope,
  cloneJobId: job.id,
  // … rest of config …
})

await db.updateTable('storefront_clone_jobs')
  .set({ bullmq_job_id: bullmqJob.id })
  .where('id', '=', job.id)
  .execute()
```

### 5.3 `clone-worker.ts` — per-shop limiter

```ts
cloneWorker = new Worker<WebsiteCloneJob>(
  QUEUE_NAME,
  handler,
  {
    connection: getQueueConnection(),
    concurrency: 2,
    // Per-shop cap via BullMQ group concurrency (5.x feature)
    group: {
      concurrency: 2,     // max 2 per group
      limit: { max: 2, duration: Infinity },
    },
    settings: {
      stalledInterval: 60_000,
      maxStalledCount: 2,
    },
  }
)
```

Jobs are tagged with `groupId = shopId` at enqueue time:
```ts
await websiteCloneQueue().add(jobName, data, {
  group: { id: data.shopId },
  // … rest …
})
```

### 5.4 `runner.ts` — partial-result state machine

```ts
// NEW: collect failures instead of throwing
const failedStages: string[] = []
for (const stage of STAGES) {
  try {
    await runStage(stage, …)
  } catch (err) {
    failedStages.push(stage.name)
    stagesJson.push({ stage: stage.name, status: 'failed', error: err.message })
    continue    // DO NOT throw — move to next stage
  }
}

const finalStatus =
  failedStages.length === 0 ? 'succeeded'
  : failedStages.length < STAGES.length ? 'succeeded_partial'
  : 'failed'
```

### 5.5 `sanitize.ts` (new module)

`packages/core/src/modules/clone-pro/sanitize.ts`:
```ts
export function sanitizeClonedHtml(html: string): string
export function sanitizeClonedCss(css: string): string
export function isSafeImageUrl(url: string): boolean
```

Called from `persist-pages.ts`, `persist-collections.ts`, `persist-blog.ts` before writing to DB. Called from `theme-gen/*.ts` on the generated CSS before writing the Liquid theme file.

### 5.6 `robots-guard.ts` (new module)

`packages/core/src/modules/clone-pro/robots-guard.ts`:
```ts
export class RobotsGuard {
  constructor(sourceUrl: string)
  async load(): Promise<void>           // fetch + parse once per host
  isAllowed(url: string): boolean
}
```

Instantiated once per job, injected into crawler entry points.

### 5.7 Audit log writer

`packages/core/src/modules/clone-pro/audit.ts`:
```ts
export async function logCloneStarted(db, { shopId, userId, ip, jobId, sourceUrl, canonicalDomain, scope }): Promise<void>
export async function logCloneTerminal(db, { shopId, jobId, status, durationMs, productsImported, pagesImported, failedStages }): Promise<void>
```

---

## 6. Test Plan

Unit tests (Vitest, `*.test.ts` alongside each module):

| Module | Test file | Cases |
|---|---|---|
| Migration 046 | `046_clone_jobs_bullmq_link.test.ts` | `up()`/`down()` shape assertions, index DDL, schema type exposed |
| `sanitize.ts` | `sanitize.test.ts` | `<script>` stripped, `<iframe>` stripped, `onclick` stripped, `javascript:` href stripped, `data:` image src stripped, `@import url(malicious.com)` dropped, `@import url(fonts.googleapis.com)` kept |
| `robots-guard.ts` | `robots-guard.test.ts` | 404 on robots.txt = allow all, Disallow matched = `isAllowed=false`, User-Agent-specific rules, caching (one fetch per host) |
| `audit.ts` | `audit.test.ts` | started row written with correct columns, terminal row written, failures are non-fatal (logged, not thrown) |
| `runner.ts` | `runner.test.ts` (extend existing) | one stage fails → subsequent stages still run, terminal status = `succeeded_partial`, all stages fail → `failed`, no stages fail → `succeeded` |
| `start.ts` | `start.test.ts` (extend) | success path enqueues to BullMQ, persists `bullmq_job_id`, audit row `clone_pro.started` written, race still 409s, runner is NOT called directly anymore |
| `clone-worker.ts` | `clone-worker.test.ts` (new) | group concurrency config present, 15-min lockDuration, partial-result terminal statuses propagate to DB correctly, terminal audit log fires |
| `queues.ts` | `queues.test.ts` (extend) | `enqueueWebsiteClone` tags job with `group.id = shopId` |

Integration smoke test (runs on server 2, production-like):
1. Migrate 046 on `gbox_test` DB.
2. Enqueue a clone job via HTTP POST.
3. Assert `bullmq_job_id` populated on the DB row.
4. Wait for worker to complete; assert terminal audit row exists.

---

## 7. Ordering & Dependencies

```
Step 7.1 (Wire Worker + Migration 046)     ← start here, unblocks everything
    ↓
Step 7.2 (Per-shop concurrency) ─┐
    ↓                            │
Step 7.5 (Partial results)       │  can be parallelized — no code overlap
    ↓                            │  with 7.3 / 7.4
Step 7.6 (Audit logs) ───────────┘
    ↓
Step 7.3 (Robots + politeness) ─┐
    ↓                           │  — crawler-only changes, isolated
Step 7.4 (Sanitization) ────────┘
    ↓
Step 7.7 (Smoke test + server deploy)
```

Each step = one commit. Push to GitHub at end of each step. Deploy step-by-step if anything's risky; otherwise batch 7.1-7.6 and deploy once with 7.7.

---

## 8. Rollback Plan

- **Migration 046** is additive — `down()` drops the column cleanly. No data loss.
- **Wire the worker (7.1)** — if BullMQ misbehaves, revert `start.ts` to in-process `runJob(…)` and skip `startCloneWorker`. Pipeline keeps working the old way.
- **Sanitization (7.4)** — if it's over-aggressive and clones lose too much content, feature-flag via `CLONE_SANITIZE_ENABLED=true|false` (env var) and ship with `true` in prod; merchants hit by false positives can be unblocked by flipping to `false` on a per-shop basis via `shop_settings`.
- **Per-shop cap (7.2)** — set `group.concurrency = 999` to effectively disable.
- **Robots (7.3)** — feature-flag `CLONE_ROBOTS_ENFORCED=true|false`; default `true`, flip to `false` if a merchant insists on cloning a site that blocks bots (owner sign-off required).

---

## 9. Acceptance Criteria

| # | Criterion | Verification |
|---|---|---|
| A1 | `pm2 restart gbox-store-admin` mid-clone doesn't lose the job | Manual: start clone, restart PM2, confirm job resumes + reaches terminal status |
| A2 | Queuing 3 clones for same shop runs max 2 at a time | Manual: enqueue 3 jobs, inspect BullMQ dashboard, third waits |
| A3 | Cloned HTML has no `<script>`/`<iframe>`/event handlers | Unit test assertions on `sanitizeClonedHtml` output |
| A4 | Cloning a site with `Disallow: /admin` skips `/admin/*` URLs | Unit test on `RobotsGuard` + integration test on a fixture |
| A5 | A job where only `theme-gen` fails still imports products | Unit test on runner's partial-result machine |
| A6 | `audit_logs` contains one `clone_pro.started` + one terminal row per job | Integration smoke |
| A7 | All existing clone-pro tests still pass | `vitest run` green |
| A8 | Server 1 migration 046 applied; restart clean; smoke clone succeeds | Manual on 192.168.1.13 |

---

## 10. References

- Source plan: `docs/superpowers/plans/2026-04-13-website-cloner-pro-plan.md` Phase 7 (lines 625-672)
- Existing worker code: `packages/core/src/modules/queue/clone-worker.ts`
- Existing producer: `apps/store-admin/src/pages/clone-pro/start.ts:348` (line to replace)
- BullMQ group concurrency: <https://docs.bullmq.io/guide/queues/concurrency>
- `sanitize-html`: <https://www.npmjs.com/package/sanitize-html>
- `robots-parser`: <https://www.npmjs.com/package/robots-parser>
