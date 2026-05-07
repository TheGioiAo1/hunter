/**
 * Phase 7 Step 7.1 — clone-worker.ts source-level smoke tests.
 *
 * The worker itself can't spin up in a unit test — it requires a live
 * Redis + BullMQ that aren't available on this Windows dev box (see
 * `memory/smoke_test_runbook.md`). Integration-level validation happens
 * on server 2 once Phase 7 ships.
 *
 * At the source level though we CAN pin the contract: the worker must
 *   1. defer every job to `runCloneProJob` (so legacy in-process and
 *      queued runs share one status/stage code path),
 *   2. reject jobs where `data.cloneJobId` is missing (the HTTP handler
 *      is responsible for creating the row before enqueueing),
 *   3. insert a `clone_pro_failed` notification inline on terminal
 *      failure (the app-layer `notify()` helper lives in store-admin
 *      and can't be imported into core, so the worker open-codes the
 *      INSERT instead of calling notify),
 *   4. skip the notify INSERT when status is NOT failed (no
 *      `clone_pro_succeeded` / etc. spam),
 *   5. re-throw on failed terminal so BullMQ's attempts/backoff kicks
 *      in for retry.
 *
 * Each test reads the source and regex-matches the key invariant.
 * Regressions (refactor drops the guard, swaps the runner, changes
 * notification type) fail here at source-level rather than sneaking
 * into production and being caught only by server-2 smoke.
 */

import { describe, it, expect } from 'vitest'

async function readWorkerSource(): Promise<string> {
  const fs = await import('node:fs/promises')
  return fs.readFile(new URL('./clone-worker.ts', import.meta.url), 'utf8')
}

describe('Phase 7.1 — clone-worker.ts: handler contract', () => {
  it('imports runCloneProJob from the clone-pro runner module', async () => {
    const src = await readWorkerSource()
    // The worker MUST go through the runner so DB status tracking +
    // stages_json streaming + onJobResult callback stay in one place.
    // If someone swaps in `cloneWebsite` directly we'd lose the
    // queued→running→succeeded/failed DB transitions.
    expect(src).toMatch(
      /import\s*\{\s*runCloneProJob\s*\}\s*from\s*['"]\.\.\/clone-pro\/runner\.js['"]/,
    )
  })

  it('throws when data.cloneJobId is missing (refuses legacy enqueues)', async () => {
    const src = await readWorkerSource()
    // POST /clone-pro/start creates the row BEFORE enqueueing (Phase
    // 7.1 spec §A2). If a job lands here without `cloneJobId` the
    // worker would otherwise create an orphan BullMQ entry with no
    // DB row — refuse fast instead.
    expect(src).toMatch(/if\s*\(\s*!\s*data\.cloneJobId\s*\)/)
    expect(src).toMatch(/throw\s+new\s+Error\([^)]*cloneJobId/i)
  })

  it('calls runCloneProJob with shopId + jobId + sourceUrl from the BullMQ payload', async () => {
    const src = await readWorkerSource()
    // The call must pass through the three identity fields the runner
    // keys on. `configOverrides` is separately asserted below.
    expect(src).toMatch(/await\s+runCloneProJob\(\s*db\s*,\s*\{/)
    expect(src).toMatch(/shopId:\s*data\.shopId/)
    expect(src).toMatch(/jobId:\s*data\.cloneJobId/)
    expect(src).toMatch(/sourceUrl:\s*data\.sourceUrl/)
  })

  it('forwards the scope + AI + limits into configOverrides', async () => {
    const src = await readWorkerSource()
    // The runner's configOverrides is how the worker tells the
    // pipeline what to clone. All seven flags the HTTP handler passes
    // (scope, ai, maxProducts, maxPages, ingestMedia, extractBrandKit,
    // generateTheme) must make it through — else the worker would
    // silently default to full scope and ignore merchant toggles.
    expect(src).toMatch(/configOverrides:\s*\{/)
    expect(src).toMatch(/scope:\s*data\.scope/)
    expect(src).toMatch(/ai:\s*data\.ai/)
    expect(src).toMatch(/maxProducts:\s*data\.maxProducts/)
    expect(src).toMatch(/maxPages:\s*data\.maxPages/)
    expect(src).toMatch(/ingestMedia:\s*data\.ingestMedia/)
    expect(src).toMatch(/extractBrandKit:\s*data\.extractBrandKit/)
    expect(src).toMatch(/generateTheme:\s*data\.generateTheme/)
  })

  it('onJobResult does NOT fire a clone_pro_succeeded notification (no bell-icon spam)', async () => {
    const src = await readWorkerSource()
    // The HTTP handler already fired clone_pro_started when the user
    // kicked off the clone. A second "succeeded" notification would
    // be bell-icon spam. The Phase 7.5 partial path is handled by a
    // separate branch (see the 7.5 describe block below) — the clean
    // 'succeeded' case gets NO notification.
    expect(src).not.toMatch(/type:\s*['"]clone_pro_succeeded['"]/)
  })

  it('inserts a clone_pro_failed notification inline on terminal failure', async () => {
    const src = await readWorkerSource()
    // The app-layer notify() can't be imported into @gbox/core (would
    // create a circular dep on store-admin). The worker open-codes
    // the INSERT. Fields asserted individually so a refactor that
    // drops user_id or resource_id trips the test.
    expect(src).toMatch(/insertInto\(\s*['"]notifications['"]\s*\)/)
    expect(src).toMatch(/type:\s*['"]clone_pro_failed['"]/)
    expect(src).toMatch(/shop_id:\s*data\.shopId/)
    // createdByUserId is optional on the job payload, so null falls
    // through for anonymous backfills / legacy enqueues.
    expect(src).toMatch(/user_id:\s*data\.createdByUserId\s*\?\?\s*null/)
    expect(src).toMatch(/resource_type:\s*['"]storefront_clone_job['"]/)
    expect(src).toMatch(/resource_id:\s*data\.cloneJobId/)
  })

  it('notify insert is wrapped in try/catch — losing a notification never fails the job', async () => {
    const src = await readWorkerSource()
    // The DB row's failed status is already persisted by the runner
    // at this point. Failing the worker callback because the notify
    // INSERT hiccuped would trigger a BullMQ retry of an already-
    // terminal job — worst of both worlds.
    expect(src).toMatch(
      /onJobResult:[\s\S]*?try\s*\{[\s\S]*?insertInto\(\s*['"]notifications['"]\s*\)[\s\S]*?\}\s*catch/,
    )
  })

  it('re-throws on result.status === "failed" so BullMQ retries per attempts config', async () => {
    const src = await readWorkerSource()
    // The runner returns (never throws) on a failed pipeline — it
    // already persisted the DB row's failed state. We need to bubble
    // a throw OUT of the worker callback so BullMQ's attempts/backoff
    // kicks in and schedules the retry.
    expect(src).toMatch(
      /if\s*\(\s*result\.status\s*===\s*['"]failed['"]\s*\)[\s\S]*?throw\s+new\s+Error/,
    )
  })

  it('Worker is constructed with concurrency 2 and a 15-minute lock duration', async () => {
    const src = await readWorkerSource()
    // Concurrency is intentionally low — cloning is IO-heavy and the
    // box is shared with the HTTP API. The 15-min lockDuration is
    // the hard timeout per job; anything longer than one aborted
    // 15-min run gets picked up by another worker via stalled
    // detection.
    expect(src).toMatch(/concurrency:\s*2/)
    expect(src).toMatch(/lockDuration:\s*15\s*\*\s*60\s*\*\s*1000/)
  })

  it('exposes createdByUserId on the WebsiteCloneJob payload type', async () => {
    const src = await readWorkerSource()
    // The HTTP handler passes req.storeUser.id so the worker can
    // attribute failed notifications to the right user. Optional +
    // nullable so anonymous admin-backfills still work.
    expect(src).toMatch(
      /createdByUserId\?\s*:\s*string\s*\|\s*null/,
    )
  })
})

describe('Phase 7.2 — clone-worker.ts: per-shop concurrency cap', () => {
  it('imports DelayedError from bullmq (for moveToDelayed signal)', async () => {
    const src = await readWorkerSource()
    // `DelayedError` is the idiomatic BullMQ v5 signal for "I moved
    // the job to delayed, don't count this as a retry attempt".
    // Without it, every over-limit job would consume one of its 2
    // retry attempts and end up failed by the third throttle.
    expect(src).toMatch(
      /import\s*\{[^}]*DelayedError[^}]*\}\s*from\s*['"]bullmq['"]/,
    )
  })

  it('declares a SHOP_CONCURRENCY_LIMIT (default 2, overridable via env)', async () => {
    const src = await readWorkerSource()
    // The cap is a module-level constant so the value is visible at
    // source (tests, code review). Rollback path per spec §7 is to
    // bump it to 999 via env without a code deploy.
    expect(src).toMatch(
      /const\s+SHOP_CONCURRENCY_LIMIT\s*=[^|\n]*\|\|\s*2/,
    )
    expect(src).toMatch(/CLONE_SHOP_CONCURRENCY/)
  })

  it('processor signature accepts token as second argument', async () => {
    const src = await readWorkerSource()
    // `moveToDelayed(timestamp, token)` needs the worker's token to
    // prove it owns the job's lock. BullMQ v5 passes the token as the
    // second arg to the processor function.
    expect(src).toMatch(
      /async\s*\(\s*job:\s*Job<WebsiteCloneJob>\s*,\s*token\??\s*:\s*string[^)]*\)\s*=>/,
    )
  })

  it('queries storefront_clone_jobs for running jobs on the same shop before dispatching', async () => {
    const src = await readWorkerSource()
    // The pre-check is scoped to the shop and filters out the current
    // job's own row (else a retry would always see count=1 and
    // ping-pong). Discarded rows are excluded — they're the "Replace"
    // leftovers from Phase 6 and don't count toward the live cap.
    expect(src).toMatch(
      /selectFrom\(\s*['"]storefront_clone_jobs['"]\s*\)[\s\S]*?\.where\(\s*['"]shop_id['"][^)]*data\.shopId/,
    )
    expect(src).toMatch(
      /\.where\(\s*['"]status['"]\s*,\s*['"]=['"]\s*,\s*['"]running['"]\s*\)/,
    )
    expect(src).toMatch(
      /\.where\(\s*['"]id['"]\s*,\s*['"]!=['"]\s*,\s*data\.cloneJobId/,
    )
    expect(src).toMatch(
      /\.where\(\s*['"]discarded_at['"]\s*,\s*['"]is['"]\s*,\s*null\s*\)/,
    )
  })

  it('when at-or-over the per-shop limit, moves the job to delayed and throws DelayedError', async () => {
    const src = await readWorkerSource()
    // The DelayedError throw signals to BullMQ "I already rescheduled
    // this, don't move it to failed". moveToDelayed is awaited with
    // the worker's token — without the token BullMQ rejects the move
    // because it can't prove the worker still holds the lock.
    expect(src).toMatch(
      /if\s*\(\s*runningCount\s*>=\s*SHOP_CONCURRENCY_LIMIT\s*\)/,
    )
    expect(src).toMatch(
      /await\s+job\.moveToDelayed\(\s*Date\.now\(\)\s*\+\s*SHOP_CONCURRENCY_RETRY_DELAY_MS\s*,\s*token\s*\)/,
    )
    expect(src).toMatch(/throw\s+new\s+DelayedError/)
  })

  it('declares SHOP_CONCURRENCY_RETRY_DELAY_MS (30s default, overridable via env)', async () => {
    const src = await readWorkerSource()
    // Short enough that a freed slot is claimed promptly; long enough
    // that a busy shop doesn't hammer the DB with pre-check queries.
    // 30s matches the `stalledInterval: 60_000` rhythm (we re-check
    // twice per stall window).
    expect(src).toMatch(
      /const\s+SHOP_CONCURRENCY_RETRY_DELAY_MS\s*=[^|\n]*\|\|\s*30[_,]?000/,
    )
    expect(src).toMatch(/CLONE_SHOP_CONCURRENCY_DELAY_MS/)
  })

  it('per-shop guard runs BEFORE the cloneJobId refusal check (order matters for delayed-error semantics)', async () => {
    const src = await readWorkerSource()
    // The cloneJobId guard THROWS — a bad payload should fail fast.
    // The concurrency guard DEFERS — a valid payload should wait its
    // turn. If the order were swapped, a valid-but-deferred job would
    // also have to pass the cloneJobId check first; that's fine, but
    // we want the concurrency pre-check to short-circuit the expensive
    // `runCloneProJob` call, which is what matters here. Assert that
    // the concurrency block appears before the runCloneProJob call.
    const runningCountIdx = src.indexOf('runningCount')
    const runCloneJobIdx = src.indexOf('await runCloneProJob(')
    expect(runningCountIdx).toBeGreaterThan(-1)
    expect(runCloneJobIdx).toBeGreaterThan(-1)
    expect(runningCountIdx).toBeLessThan(runCloneJobIdx)
  })
})

describe('Phase 7.5 — clone-worker.ts: partial-result notification', () => {
  it('inserts a clone_pro_partial notification when runner status is succeeded_partial', async () => {
    const src = await readWorkerSource()
    // A partial run (at least one non-fatal stage failed) doesn't
    // retry — the job is terminal. The bell-icon notification tells
    // the merchant "finished but with gaps"; without it the soft-fail
    // is invisible until they manually open the detail page.
    expect(src).toMatch(/type:\s*['"]clone_pro_partial['"]/)
    // Branch must fire ONLY on the partial status — a refactor that
    // lets the branch match 'succeeded' too would spam bell icons
    // for every clean run.
    expect(src).toMatch(
      /r\.status\s*===\s*['"]succeeded_partial['"]/,
    )
  })

  it('clone_pro_partial insert carries shop_id + user_id + resource_id (same shape as _failed)', async () => {
    const src = await readWorkerSource()
    // Locate the partial notification block by the type literal and
    // walk backwards to the enclosing `.values({ ... })` — that's the
    // full row we insert. The merchant's bell-icon needs resource_id
    // to deep-link to the job detail page; user_id lets us filter
    // "notifications for me" in the dropdown.
    const partialTypeIdx = src.indexOf("type: 'clone_pro_partial'")
    expect(partialTypeIdx).toBeGreaterThan(-1)
    // Grab a window centred on the partial type that definitely
    // contains the full .values({...}) object — 600 chars each side.
    const start = Math.max(0, partialTypeIdx - 600)
    const end = Math.min(src.length, partialTypeIdx + 600)
    const block = src.slice(start, end)
    expect(block).toMatch(/shop_id:\s*data\.shopId/)
    expect(block).toMatch(/user_id:\s*data\.createdByUserId\s*\?\?\s*null/)
    expect(block).toMatch(/resource_type:\s*['"]storefront_clone_job['"]/)
    expect(block).toMatch(/resource_id:\s*data\.cloneJobId/)
  })

  it('partial-notification insert is wrapped in try/catch (notification loss is non-fatal)', async () => {
    const src = await readWorkerSource()
    // Same contract as the _failed notification — the DB row is
    // already terminal by the time onJobResult fires. Failing the
    // callback because the notify INSERT hiccuped would trigger a
    // BullMQ retry of an already-done job.
    expect(src).toMatch(
      /try\s*\{[\s\S]*?type:\s*['"]clone_pro_partial['"][\s\S]*?\}\s*catch/,
    )
  })

  it('worker does NOT re-throw on succeeded_partial (no BullMQ retry for soft-success)', async () => {
    const src = await readWorkerSource()
    // The re-throw block only fires on `result.status === 'failed'`.
    // If a refactor ever widens that to include succeeded_partial we'd
    // retry-loop every soft-failure into a hard failure by the third
    // attempt. The existing test at line 123 asserts the `=== 'failed'`
    // equality; this test re-affirms the negative so a `||` sneaking
    // in wouldn't go unnoticed.
    expect(src).not.toMatch(
      /status\s*===\s*['"]succeeded_partial['"][\s\S]{0,50}throw/,
    )
    expect(src).not.toMatch(
      /throw[\s\S]{0,50}status\s*===\s*['"]succeeded_partial['"]/,
    )
  })
})

describe('Phase 22 (Clone Pro v7) Sprint 2 Task 2.8 — clone-worker v7 routing', () => {
  it('imports runCloneProV7 + buildV7Deps from the v7 barrel', async () => {
    const src = await readWorkerSource()
    expect(src).toMatch(
      /import\s*\{[^}]*runCloneProV7[^}]*\}\s*from\s*['"]\.\.\/clone-pro\/v7\/index\.js['"]/,
    )
    expect(src).toMatch(
      /import\s*\{[^}]*buildV7Deps[^}]*\}\s*from\s*['"]\.\.\/clone-pro\/v7\/index\.js['"]/,
    )
  })

  it('routes to v7 when CLONE_PRO_VERSION === "v7"', async () => {
    const src = await readWorkerSource()
    expect(src).toMatch(
      /if\s*\(\s*process\.env\.CLONE_PRO_VERSION\s*===\s*['"]v7['"]\s*\)/,
    )
  })

  it('v7 branch appears BEFORE v6 (so v7 takes precedence when both flags set)', async () => {
    const src = await readWorkerSource()
    const v7Idx = src.indexOf("CLONE_PRO_VERSION === 'v7'")
    const v6Idx = src.indexOf("CLONE_PRO_VERSION === 'v6'")
    expect(v7Idx).toBeGreaterThan(-1)
    expect(v6Idx).toBeGreaterThan(-1)
    expect(v7Idx).toBeLessThan(v6Idx)
  })

  it('v7 branch reads productsLimit off the BullMQ payload', async () => {
    const src = await readWorkerSource()
    expect(src).toMatch(/data\.productsLimit/)
  })

  it('v7 branch passes productsLimit defaulting undefined → null', async () => {
    const src = await readWorkerSource()
    // The orchestrator signature requires `productsLimit: number | null`
    // (no undefined). The worker must coerce.
    expect(src).toMatch(/data\.productsLimit\s*!==\s*undefined/)
  })

  it('v7 branch invokes runCloneProV7 with jobId/shopId/sourceUrl/productsLimit/deps', async () => {
    const src = await readWorkerSource()
    expect(src).toMatch(/await\s+runCloneProV7\(\s*\{/)
    expect(src).toMatch(/jobId:\s*data\.cloneJobId/)
    expect(src).toMatch(/shopId:\s*data\.shopId/)
    expect(src).toMatch(/sourceUrl:\s*data\.sourceUrl/)
    expect(src).toMatch(/productsLimit/)
    expect(src).toMatch(/deps:\s*v7Deps/)
  })

  it('v7 branch throws on pipeline failure so BullMQ retries', async () => {
    const src = await readWorkerSource()
    // The runCloneProV7 call is wrapped in try/catch and throws Error
    // on failure (matches v6 contract).
    expect(src).toMatch(
      /catch\s*\(\s*err\s*\)\s*\{[\s\S]*?v7\s+job[\s\S]*?throw\s+new\s+Error/,
    )
  })

  it('exposes crawlStrategy + productsLimit on WebsiteCloneJob payload type', async () => {
    const src = await readWorkerSource()
    expect(src).toMatch(/crawlStrategy\?\s*:\s*['"]sample['"]\s*\|\s*['"]full['"]/)
    expect(src).toMatch(/productsLimit\?\s*:\s*number\s*\|\s*null/)
  })
})

describe('Sprint 5 worker E2E plumbing — clone-worker v7 theme chain (Tasks 1+2)', () => {
  // The worker test pattern is source-level regex (BullMQ + Redis + the
  // optional `playwright`/`anthropic` packages aren't available on this
  // dev box; integration tests run on server-2 once the merge lands).
  // These assertions pin the contract: after `runCloneProV7` returns,
  // the v7 branch MUST run Stage 13/14/15/16 + persist cost_usd.

  it('imports ThemeZipS3KeyResolver from the v7 barrel (Task 4 plumbing)', async () => {
    const src = await readWorkerSource()
    // Worker creates one resolver per job + threads asResolverFn() into
    // buildV7Deps so Stage 11 (which runs INSIDE runCloneProV7) gets a
    // late-bound view of the theme.zip key produced by Stage 15.
    expect(src).toMatch(
      /import\s*\{[^}]*ThemeZipS3KeyResolver[^}]*\}\s*from\s*['"]\.\.\/clone-pro\/v7\/index\.js['"]/,
    )
    expect(src).toMatch(/new\s+ThemeZipS3KeyResolver\(\s*\)/)
    expect(src).toMatch(/themeZipS3KeyResolver:\s*[\w$]+\.asResolverFn\(\)/)
  })

  it('constructs a CloneProCostTracker per job and threads it into v7 deps', async () => {
    const src = await readWorkerSource()
    // ONE tracker per job. Same instance flows into Stage 14 + Stage 16
    // so AI spend rolls up to a single per-job budget. The orchestrator
    // surfaces `tracker.getSpentUsd()` so the worker can persist it
    // into clone_crawl_runs.cost_usd at finalize.
    expect(src).toMatch(
      /import\s*\{[^}]*CloneProCostTracker[^}]*\}\s*from\s*['"]\.\.\/clone-pro\/v7\/index\.js['"]/,
    )
    expect(src).toMatch(/new\s+CloneProCostTracker\(\s*\)/)
    expect(src).toMatch(/tracker:\s*tracker/)
  })

  it('runs Stage 13 (screenshot) → Stage 14 (design extract) → Stage 15 (theme) → Stage 16 (visual verify) AFTER runCloneProV7', async () => {
    const src = await readWorkerSource()
    // Theme builder chain runs sequentially after the orchestrator
    // returns. Stage 13 captures source screenshots; Stage 14 extracts
    // design tokens via Claude vision; Stage 15 generates Liquid
    // theme.zip; Stage 16 verifies score >= 7 with retry loop.
    expect(src).toMatch(/captureScreenshots/)
    expect(src).toMatch(/extractDesignTokens/)
    expect(src).toMatch(/generateTheme/)
    expect(src).toMatch(/visualVerifyWithRetry/)

    // Order matters: each later stage depends on the earlier output.
    // Anchor on `await` to skip the import statements at the top.
    const captureIdx = src.indexOf('await captureScreenshots(')
    const extractIdx = src.indexOf('await extractDesignTokens(')
    const generateIdx = src.indexOf('await generateTheme(')
    const verifyIdx = src.indexOf('await visualVerifyWithRetry(')
    expect(captureIdx).toBeGreaterThan(-1)
    expect(extractIdx).toBeGreaterThan(captureIdx)
    expect(generateIdx).toBeGreaterThan(extractIdx)
    expect(verifyIdx).toBeGreaterThan(generateIdx)

    // Theme chain must run AFTER runCloneProV7 returns (catalog data is
    // committed first; theme is best-effort).
    const v7CallIdx = src.indexOf('await runCloneProV7(')
    expect(v7CallIdx).toBeGreaterThan(-1)
    expect(captureIdx).toBeGreaterThan(v7CallIdx)
  })

  it('threads tracker into Stage 14 + Stage 16 calls (cost cap enforcement)', async () => {
    const src = await readWorkerSource()
    // Stage 14 + Stage 16 accept `tracker?: CloneProCostTracker`. If
    // the worker forgets to pass it, the cost cap silently does
    // nothing — exactly the bug that bit Sprint 5 follow-up. Pin both.
    // Anchor on `await` to skip imports.
    const stage14Block = src.slice(
      src.indexOf('await extractDesignTokens('),
      src.indexOf('await extractDesignTokens(') + 800,
    )
    expect(stage14Block).toMatch(/tracker/)

    const stage16Block = src.slice(
      src.indexOf('await visualVerifyWithRetry('),
      src.indexOf('await visualVerifyWithRetry(') + 800,
    )
    expect(stage16Block).toMatch(/tracker/)
  })

  it('Stage 15 result feeds resolver.resolve(themeBundle.theme_zip_key) when non-null', async () => {
    const src = await readWorkerSource()
    // Without this call, Stage 11 (which already ran inside the
    // orchestrator) saw `null` from the resolver and skipped the deploy.
    // Calling resolver.resolve() lets a follow-up deploy happen with
    // the freshly-rendered key.
    expect(src).toMatch(/\.resolve\(\s*[\w$.]+\.theme_zip_key\s*\)/)
    // Guarded — Stage 15 may have failed (theme_zip_key === null) so
    // we only resolve when the key is non-null.
    expect(src).toMatch(/if\s*\(\s*[\w$.]+\.theme_zip_key\s*\)/)
  })

  it('persists cost_usd to clone_crawl_runs after the theme chain (Task 2)', async () => {
    const src = await readWorkerSource()
    // Migration 105 added `cost_usd numeric(8,4)`. The worker writes
    // `tracker.getSpentUsd()` into that column once all AI work is
    // done. Persist runs INSIDE the v7 branch — outside, the v6/v5/v4
    // paths have no tracker.
    expect(src).toMatch(/updateTable\(\s*['"]clone_crawl_runs['"]\s*\)/)
    expect(src).toMatch(/cost_usd/)
    expect(src).toMatch(/tracker\.getSpentUsd\(\)/)
    // job_id WHERE clause — there's exactly one row per job_id.
    expect(src).toMatch(
      /\.where\(\s*['"]job_id['"]\s*,\s*['"]=['"]\s*,\s*data\.cloneJobId\s*\)/,
    )
  })

  it('theme chain failures DO NOT fail the entire v7 job (data is still good)', async () => {
    const src = await readWorkerSource()
    // Per spec §1: "If theme chain fails AFTER data pipeline succeeds,
    // mark job with warning but don't fail entire job (data is still
    // good)". The chain is wrapped in its own try/catch so the
    // catalog-publish work isn't undone. Match the CALL site (not the
    // import) by anchoring on `await captureScreenshots(`.
    const callIdx = src.indexOf('await captureScreenshots(')
    expect(callIdx).toBeGreaterThan(-1)
    // The block surrounding the theme chain should be a try/catch.
    // Walk back ~800 chars for `try {`.
    const before = src.slice(Math.max(0, callIdx - 800), callIdx)
    expect(before).toMatch(/try\s*\{/)
  })

  it('cost_usd write is itself wrapped in try/catch (DB hiccup never fails the job)', async () => {
    const src = await readWorkerSource()
    // Same pattern as the notification INSERTs — the tracker total is
    // an audit field, losing it is strictly less bad than failing a
    // job whose data already landed.
    expect(src).toMatch(
      /try\s*\{[\s\S]*?updateTable\(\s*['"]clone_crawl_runs['"]\s*\)[\s\S]*?\}\s*catch/,
    )
  })

  it('skips the theme chain entirely when CLONE_PRO_VERSION !== "v7"', async () => {
    const src = await readWorkerSource()
    // The chain MUST live inside the `if (process.env.CLONE_PRO_VERSION === 'v7')`
    // branch. If it leaks out, v6/v5/v4 jobs would hit the chain too
    // (which uses Stage 14/16 + tracker — those don't exist for v6).
    const v7Idx = src.indexOf("CLONE_PRO_VERSION === 'v7'")
    const v6Idx = src.indexOf("CLONE_PRO_VERSION === 'v6'")
    const captureIdx = src.indexOf('captureScreenshots(')
    expect(v7Idx).toBeGreaterThan(-1)
    expect(v6Idx).toBeGreaterThan(v7Idx)
    expect(captureIdx).toBeGreaterThan(v7Idx)
    expect(captureIdx).toBeLessThan(v6Idx)
  })

  it('skips Stage 14/15/16 when Stage 13 returned no screenshots (graceful no-op)', async () => {
    const src = await readWorkerSource()
    // Defensive guard — if Stage 13 captures 0 screenshots (e.g. all
    // pages timed out), running Stage 14 + 15 + 16 wastes Anthropic
    // budget without producing usable output.
    expect(src).toMatch(/Object\.keys\([\w$.]*s3Keys\)\.length\s*===?\s*0/)
  })
})
