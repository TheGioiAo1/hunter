/**
 * Clone-Pro runner — `onJobResult` callback (Phase I3).
 *
 * We only unit-test the terminal-callback plumbing here; the fuller
 * pipeline behaviour is covered by the storefront-clone + clone-pro
 * integration suites. The runner's contract is:
 *
 *   - `onJobResult` fires exactly once per run, after the DB write
 *     that records the terminal status.
 *   - A success or failure in the pipeline each produces a single
 *     callback with the matching `{ status, errorCode?, errorMessage? }`.
 *   - If the callback throws, the runner logs and swallows — the
 *     caller's `RunCloneProJobResult` promise still resolves with the
 *     correct terminal status.
 *
 * Phase 7 Step 7.5 — Partial results:
 *   The second describe block below locks the `succeeded_partial`
 *   state machine. A NON_FATAL stage failure already gets captured
 *   into `pipelineResult.stages` (see pipeline.ts `runStage`). The
 *   runner inspects that list at the success branch and chooses
 *   between `succeeded` and `succeeded_partial` accordingly. Fatal
 *   stages still throw out of the pipeline so they land in the
 *   existing `failed` branch — that path isn't changed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import { runCloneProJob } from './runner.js'
import * as pipelineMod from './pipeline.js'
import * as jobStoreMod from '../storefront-clone/job-store.js'
import type { CloneStageResult } from './types.js'

describe('runCloneProJob — onJobResult callback', () => {
  beforeEach(() => {
    // Silence the runner's own console.error noise during these tests;
    // we assert outcomes through the callback + resolved promise, not
    // log output.
    vi.spyOn(console, 'error').mockImplementation(() => {})
    // Stub the job-store writes — the runner calls these at each
    // transition but we don't care about the actual row state here.
    vi.spyOn(jobStoreMod, 'updateStorefrontCloneJob').mockResolvedValue(
      undefined as any,
    )
    vi.spyOn(jobStoreMod, 'appendCloneJobStage').mockResolvedValue(
      undefined as any,
    )
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('fires with { status: "succeeded" } when the pipeline resolves', async () => {
    vi.spyOn(pipelineMod, 'cloneWebsite').mockResolvedValue(undefined as any)

    const onJobResult = vi.fn()
    const result = await runCloneProJob({} as any, {
      shopId: 'shop-1',
      jobId: 'job-1',
      sourceUrl: 'https://example.com',
      onJobResult,
    })

    expect(result.status).toBe('succeeded')
    expect(onJobResult).toHaveBeenCalledTimes(1)
    expect(onJobResult).toHaveBeenCalledWith({ status: 'succeeded' })
  })

  it('fires with { status: "failed", errorCode, errorMessage } when pipeline throws', async () => {
    vi.spyOn(pipelineMod, 'cloneWebsite').mockRejectedValue(
      new Error('pipeline exploded'),
    )

    const onJobResult = vi.fn()
    const result = await runCloneProJob({} as any, {
      shopId: 'shop-1',
      jobId: 'job-2',
      sourceUrl: 'https://example.com',
      onJobResult,
    })

    expect(result.status).toBe('failed')
    expect(result.errorCode).toBe('pipeline_failed')
    expect(onJobResult).toHaveBeenCalledTimes(1)
    expect(onJobResult).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        errorCode: 'pipeline_failed',
        errorMessage: 'pipeline exploded',
      }),
    )
  })

  it('callback errors are swallowed — runner still resolves with the terminal status', async () => {
    vi.spyOn(pipelineMod, 'cloneWebsite').mockResolvedValue(undefined as any)

    const onJobResult = vi.fn().mockImplementation(() => {
      throw new Error('notify failed')
    })

    const result = await runCloneProJob({} as any, {
      shopId: 'shop-1',
      jobId: 'job-3',
      sourceUrl: 'https://example.com',
      onJobResult,
    })

    expect(result.status).toBe('succeeded')
    expect(onJobResult).toHaveBeenCalledTimes(1)
  })

  it('runs happily when no onJobResult is provided (back-compat)', async () => {
    vi.spyOn(pipelineMod, 'cloneWebsite').mockResolvedValue(undefined as any)

    const result = await runCloneProJob({} as any, {
      shopId: 'shop-1',
      jobId: 'job-4',
      sourceUrl: 'https://example.com',
    })

    expect(result.status).toBe('succeeded')
  })
})

// ---------------------------------------------------------------------------
// Phase 7 Step 7.5 — Partial result state machine
// ---------------------------------------------------------------------------

/**
 * Helpers for the partial-result describe block. Stage rows in a
 * real `ClonePipelineResult` carry a lot of fields the runner never
 * looks at — we only need `stage` + `status` for the state machine
 * decision, so these helpers keep the test payload readable.
 */
function stageSucceeded(stage: CloneStageResult['stage']): CloneStageResult {
  return {
    stage,
    status: 'succeeded',
    startedAt: '2026-04-17T00:00:00.000Z',
    finishedAt: '2026-04-17T00:00:01.000Z',
  }
}

function stageFailed(
  stage: CloneStageResult['stage'],
  message = 'boom',
): CloneStageResult {
  return {
    stage,
    status: 'failed',
    startedAt: '2026-04-17T00:00:00.000Z',
    finishedAt: '2026-04-17T00:00:01.000Z',
    message,
    errorCode: 'stage_failed',
  }
}

describe('runCloneProJob — partial result state machine (Phase 7.5)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(jobStoreMod, 'updateStorefrontCloneJob').mockResolvedValue(
      undefined as any,
    )
    vi.spyOn(jobStoreMod, 'appendCloneJobStage').mockResolvedValue(
      undefined as any,
    )
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('every stage succeeded → terminal status stays "succeeded" (no regression)', async () => {
    vi.spyOn(pipelineMod, 'cloneWebsite').mockResolvedValue({
      stages: [
        stageSucceeded('detect'),
        stageSucceeded('crawl'),
        stageSucceeded('extract_design'),
        stageSucceeded('import_data'),
        stageSucceeded('finalize'),
      ],
      result: {} as any,
    } as any)

    const onJobResult = vi.fn()
    const result = await runCloneProJob({} as any, {
      shopId: 'shop-1',
      jobId: 'job-partial-clean',
      sourceUrl: 'https://example.com',
      onJobResult,
    })

    expect(result.status).toBe('succeeded')
    expect(result.failedStages).toBeUndefined()
    expect(onJobResult).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'succeeded' }),
    )
  })

  it('pipeline resolves with one non-fatal stage failed → status = "succeeded_partial"', async () => {
    // Real-world: `seo_optimize` threw but the rest of the pipeline
    // produced content. The runner should NOT fail the job — one bad
    // stage is exactly what `succeeded_partial` is for.
    vi.spyOn(pipelineMod, 'cloneWebsite').mockResolvedValue({
      stages: [
        stageSucceeded('detect'),
        stageSucceeded('crawl'),
        stageSucceeded('extract_design'),
        stageSucceeded('import_data'),
        stageFailed('seo_optimize', 'AI key expired'),
        stageSucceeded('finalize'),
      ],
      result: {} as any,
    } as any)

    const onJobResult = vi.fn()
    const result = await runCloneProJob({} as any, {
      shopId: 'shop-1',
      jobId: 'job-partial-one-fail',
      sourceUrl: 'https://example.com',
      onJobResult,
    })

    expect(result.status).toBe('succeeded_partial')
    expect(result.failedStages).toEqual(['seo_optimize'])
    expect(onJobResult).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'succeeded_partial',
        failedStages: ['seo_optimize'],
      }),
    )
  })

  it('multiple non-fatal failures → all listed in failedStages, order preserved', async () => {
    vi.spyOn(pipelineMod, 'cloneWebsite').mockResolvedValue({
      stages: [
        stageSucceeded('detect'),
        stageSucceeded('crawl'),
        stageFailed('extract_design'),
        stageSucceeded('import_data'),
        stageFailed('ingest_media'),
        stageFailed('apply_brand'),
        stageSucceeded('finalize'),
      ],
      result: {} as any,
    } as any)

    const result = await runCloneProJob({} as any, {
      shopId: 'shop-1',
      jobId: 'job-partial-many-fail',
      sourceUrl: 'https://example.com',
    })

    expect(result.status).toBe('succeeded_partial')
    // Order matches the stage list — callers rendering "X, Y and Z failed"
    // in the bell-icon notification rely on a deterministic order.
    expect(result.failedStages).toEqual([
      'extract_design',
      'ingest_media',
      'apply_brand',
    ])
  })

  it('terminal DB write uses "succeeded_partial" status when partial', async () => {
    vi.spyOn(pipelineMod, 'cloneWebsite').mockResolvedValue({
      stages: [
        stageSucceeded('detect'),
        stageFailed('apply_brand'),
      ],
      result: {} as any,
    } as any)

    const updateSpy = vi
      .spyOn(jobStoreMod, 'updateStorefrontCloneJob')
      .mockResolvedValue(undefined as any)

    await runCloneProJob({} as any, {
      shopId: 'shop-1',
      jobId: 'job-partial-db',
      sourceUrl: 'https://example.com',
    })

    // Find the terminal-state update (the one with finishedAt set).
    // Arg order is (db, jobId, patch) — we want the 3rd slot.
    const terminalCall = updateSpy.mock.calls.find(
      ([, , patch]) => patch?.finishedAt != null,
    )
    expect(terminalCall).toBeDefined()
    expect(terminalCall![2]).toMatchObject({
      status: 'succeeded_partial',
    })
  })

  it('pipeline throw → status = "failed" (partial machine does not swallow fatals)', async () => {
    // Fatal pre-stage crash (e.g. `detect` or `crawl` threw) must still
    // fail the job. Partial status is only for the success branch.
    vi.spyOn(pipelineMod, 'cloneWebsite').mockRejectedValue(
      new Error('crawl hard crash'),
    )

    const onJobResult = vi.fn()
    const result = await runCloneProJob({} as any, {
      shopId: 'shop-1',
      jobId: 'job-partial-fatal',
      sourceUrl: 'https://example.com',
      onJobResult,
    })

    expect(result.status).toBe('failed')
    expect(onJobResult).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        errorCode: 'pipeline_failed',
      }),
    )
  })

  it('legacy pipelines that return undefined still produce "succeeded"', async () => {
    // The old runner.test.ts cases mock cloneWebsite as returning
    // undefined. The partial-result machine must cope with that
    // (no stages → treat as clean success) — otherwise we'd break
    // every upstream test that doesn't construct a ClonePipelineResult.
    vi.spyOn(pipelineMod, 'cloneWebsite').mockResolvedValue(undefined as any)

    const result = await runCloneProJob({} as any, {
      shopId: 'shop-1',
      jobId: 'job-partial-undef',
      sourceUrl: 'https://example.com',
    })

    expect(result.status).toBe('succeeded')
  })
})

// ---------------------------------------------------------------------------
// Phase E Task E3 (2026-04-18) — onboarding completion hook
//
// When a wizard-origin clone-pro job hits a terminal state, the runner
// must mirror that onto the `shops.onboarding_state` machine:
//
//   - succeeded | succeeded_partial → `completeOnboardingFromCloneJob`
//     (sets state=completed, choice=clone_from_url, completed_at=now).
//   - failed                         → `rollbackCloningForJob`
//     (sets state=pending, clone_job_id=null).
//
// Both helpers are double-guarded in SQL on (state=cloning AND
// onboarding_clone_job_id=$jobId), so the runner calls them
// unconditionally — non-wizard jobs are a zero-row no-op. That
// keeps this HTTP-free path free of any "is this a wizard origin?"
// branching which would otherwise require re-reading the job config.
// ---------------------------------------------------------------------------

import * as onboardingStateMod from '../onboarding/state.js'

describe('runCloneProJob — onboarding completion hook (Phase E Task E3)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(jobStoreMod, 'updateStorefrontCloneJob').mockResolvedValue(
      undefined as any,
    )
    vi.spyOn(jobStoreMod, 'appendCloneJobStage').mockResolvedValue(
      undefined as any,
    )
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('calls completeOnboardingFromCloneJob on clean success', async () => {
    vi.spyOn(pipelineMod, 'cloneWebsite').mockResolvedValue(undefined as any)
    const completeSpy = vi
      .spyOn(onboardingStateMod, 'completeOnboardingFromCloneJob')
      .mockResolvedValue(undefined)

    await runCloneProJob({} as any, {
      shopId: 'shop-wizard',
      jobId: 'job-ob-1',
      sourceUrl: 'https://example.com',
    })

    expect(completeSpy).toHaveBeenCalledTimes(1)
    expect(completeSpy).toHaveBeenCalledWith(
      expect.anything(),
      'shop-wizard',
      'job-ob-1',
    )
  })

  it('calls completeOnboardingFromCloneJob on succeeded_partial', async () => {
    // Partial is still a happy-ish terminal — the seller has content,
    // the wizard is done. Treat it as onboarding completion so the
    // banner doesn't linger forever on a partial-run store.
    vi.spyOn(pipelineMod, 'cloneWebsite').mockResolvedValue({
      stages: [stageSucceeded('detect'), stageFailed('seo_optimize')],
      result: {} as any,
    } as any)
    const completeSpy = vi
      .spyOn(onboardingStateMod, 'completeOnboardingFromCloneJob')
      .mockResolvedValue(undefined)

    await runCloneProJob({} as any, {
      shopId: 'shop-wizard',
      jobId: 'job-ob-partial',
      sourceUrl: 'https://example.com',
    })

    expect(completeSpy).toHaveBeenCalledTimes(1)
    expect(completeSpy).toHaveBeenCalledWith(
      expect.anything(),
      'shop-wizard',
      'job-ob-partial',
    )
  })

  it('calls rollbackCloningForJob on pipeline failure', async () => {
    vi.spyOn(pipelineMod, 'cloneWebsite').mockRejectedValue(
      new Error('pipeline exploded'),
    )
    const rollbackSpy = vi
      .spyOn(onboardingStateMod, 'rollbackCloningForJob')
      .mockResolvedValue(undefined)

    await runCloneProJob({} as any, {
      shopId: 'shop-wizard',
      jobId: 'job-ob-failed',
      sourceUrl: 'https://example.com',
    })

    expect(rollbackSpy).toHaveBeenCalledTimes(1)
    expect(rollbackSpy).toHaveBeenCalledWith(
      expect.anything(),
      'shop-wizard',
      'job-ob-failed',
    )
  })

  it('completion hook errors are swallowed — runner still resolves success', async () => {
    // The runner must treat the onboarding hook as fire-and-forget so
    // a DB hiccup on the `shops` write can't retroactively poison a
    // succeeded clone job. Matches the `fireJobResultCallback`
    // swallow contract already used for `onJobResult`.
    vi.spyOn(pipelineMod, 'cloneWebsite').mockResolvedValue(undefined as any)
    vi.spyOn(onboardingStateMod, 'completeOnboardingFromCloneJob').mockRejectedValue(
      new Error('shops table locked'),
    )

    const result = await runCloneProJob({} as any, {
      shopId: 'shop-wizard',
      jobId: 'job-ob-hook-throws',
      sourceUrl: 'https://example.com',
    })

    expect(result.status).toBe('succeeded')
  })

  it('rollback hook errors are swallowed — runner still resolves failure', async () => {
    vi.spyOn(pipelineMod, 'cloneWebsite').mockRejectedValue(
      new Error('pipeline exploded'),
    )
    vi.spyOn(onboardingStateMod, 'rollbackCloningForJob').mockRejectedValue(
      new Error('shops table locked'),
    )

    const result = await runCloneProJob({} as any, {
      shopId: 'shop-wizard',
      jobId: 'job-ob-rollback-throws',
      sourceUrl: 'https://example.com',
    })

    expect(result.status).toBe('failed')
  })
})
