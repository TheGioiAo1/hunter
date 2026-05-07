/**
 * Onboarding state machine — unit tests (Phase A / Task A3).
 *
 * Splits into two tiers matching the upsert.test.ts / design-library
 * pattern:
 *
 *   1. Pure predicates (isOnboardingPending, shouldShowOnboardingBanner)
 *      — fully unit-testable, no DB mocks needed.
 *   2. Mutators (markOnboardingSkipped / Completed / Cloning, rollback,
 *      getOnboardingCloneJobId) — source-level SQL-intent assertions +
 *      spy-style query-builder behavioural tests against a recording
 *      fake Kysely.
 *
 * Full-DB behaviour (CHECK-constraint rejection, FK cascade, partial
 * index hit) is validated during the server 2 smoke run — mocking
 * Postgres invariants at the unit layer tests a layer we don't own.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  isOnboardingPending,
  shouldShowOnboardingBanner,
  markOnboardingSkipped,
  markOnboardingCompleted,
  markOnboardingCloning,
  rollbackOnboardingToPending,
  getOnboardingCloneJobId,
  completeOnboardingFromCloneJob,
  rollbackCloningForJob,
  type ShopOnboardingView,
} from './state.js'

const STATE_SRC = readFileSync(
  new URL('./state.ts', import.meta.url),
  'utf8',
)

// ---------------------------------------------------------------------------
// 1. Pure predicates
// ---------------------------------------------------------------------------

function shopWithState(state: ShopOnboardingView['onboarding_state']): ShopOnboardingView {
  return {
    id: 'shop-1',
    onboarding_state: state,
    onboarding_clone_job_id: null,
  }
}

describe('isOnboardingPending', () => {
  it('returns true when state is pending', () => {
    expect(isOnboardingPending(shopWithState('pending'))).toBe(true)
  })
  it('returns false for cloning / completed / skipped', () => {
    expect(isOnboardingPending(shopWithState('cloning'))).toBe(false)
    expect(isOnboardingPending(shopWithState('completed'))).toBe(false)
    expect(isOnboardingPending(shopWithState('skipped'))).toBe(false)
  })
})

describe('shouldShowOnboardingBanner', () => {
  it('returns true only for skipped state', () => {
    expect(shouldShowOnboardingBanner(shopWithState('skipped'))).toBe(true)
  })
  it('returns false for pending / cloning / completed', () => {
    expect(shouldShowOnboardingBanner(shopWithState('pending'))).toBe(false)
    expect(shouldShowOnboardingBanner(shopWithState('cloning'))).toBe(false)
    expect(shouldShowOnboardingBanner(shopWithState('completed'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 2. Mutators — source-level SQL-intent assertions
//
//    These lock the WHERE-guards that prevent one state from clobbering
//    another. E.g. markOnboardingCompleted must only transition from
//    cloning or skipped, never from pending, because completing a
//    pending shop (no setup happened) is a state-machine violation.
// ---------------------------------------------------------------------------

describe('state.ts source invariants', () => {
  it('markOnboardingSkipped only transitions from pending', () => {
    // Guard: state='pending' in the WHERE clause. Without it, a re-POST
    // of /onboarding/skip could clobber a shop that already completed.
    expect(STATE_SRC).toMatch(/markOnboardingSkipped[\s\S]*?where[\s\S]*?['"]pending['"]/i)
    expect(STATE_SRC).toMatch(/markOnboardingSkipped[\s\S]*?set[\s\S]*?['"]skipped['"]/i)
    expect(STATE_SRC).toMatch(/markOnboardingSkipped[\s\S]*?onboarding_choice[\s\S]*?['"]skipped['"]/i)
  })

  it('markOnboardingCompleted transitions only from cloning or skipped', () => {
    // completed-from-pending would mean "we claim onboarded without
    // the seller ever finishing the wizard" — bug. Lock both valid
    // predecessors in the WHERE clause.
    const completedBlock = STATE_SRC.split(/markOnboardingCompleted/i)[1]?.split(/export\s+(?:async\s+)?function/i)[0] ?? ''
    expect(completedBlock).toMatch(/['"]cloning['"]/)
    expect(completedBlock).toMatch(/['"]skipped['"]/)
    expect(completedBlock).toMatch(/onboarding_completed_at/)
    expect(completedBlock).toMatch(/onboarding_choice/)
  })

  it('markOnboardingCloning transitions only from pending and stamps clone_job_id', () => {
    const cloningBlock = STATE_SRC.split(/markOnboardingCloning/i)[1]?.split(/export\s+(?:async\s+)?function/i)[0] ?? ''
    expect(cloningBlock).toMatch(/['"]pending['"]/)
    expect(cloningBlock).toMatch(/['"]cloning['"]/)
    expect(cloningBlock).toMatch(/onboarding_clone_job_id/)
  })

  it('rollbackOnboardingToPending transitions only from cloning + clears clone_job_id', () => {
    const rollbackBlock = STATE_SRC.split(/rollbackOnboardingToPending/i)[1]?.split(/export\s+(?:async\s+)?function/i)[0] ?? ''
    expect(rollbackBlock).toMatch(/['"]cloning['"]/)
    expect(rollbackBlock).toMatch(/['"]pending['"]/)
    // Null-out the job id so the wizard doesn't try to resume a dead job.
    expect(rollbackBlock).toMatch(/onboarding_clone_job_id[\s\S]{0,60}null/i)
  })
})

// ---------------------------------------------------------------------------
// 3. Mutators — behavioural via recording fake Kysely
//
//    Fake Kysely records the chain of calls (updateTable → set → where
//    → execute) so we can assert that the right columns are targeted
//    with the right values at the right shop id.
// ---------------------------------------------------------------------------

interface RecordedUpdate {
  table: string
  set: Record<string, unknown>
  where: Array<{ col: string; op: string; val: unknown }>
}

interface RecordedSelect {
  table: string
  select: string[]
  where: Array<{ col: string; op: string; val: unknown }>
}

function makeFakeDb(readRow?: Record<string, unknown> | null) {
  const updates: RecordedUpdate[] = []
  const selects: RecordedSelect[] = []
  const db = {
    updateTable(table: string) {
      const record: RecordedUpdate = { table, set: {}, where: [] }
      updates.push(record)
      const builder: any = {
        set(obj: Record<string, unknown>) { record.set = obj; return builder },
        where(col: string, op: string, val: unknown) { record.where.push({ col, op, val }); return builder },
        execute: async () => ({ numUpdatedRows: BigInt(1) }),
      }
      return builder
    },
    selectFrom(table: string) {
      const record: RecordedSelect = { table, select: [], where: [] }
      selects.push(record)
      const builder: any = {
        select(cols: string[] | string) { record.select = Array.isArray(cols) ? cols : [cols]; return builder },
        where(col: string, op: string, val: unknown) { record.where.push({ col, op, val }); return builder },
        executeTakeFirst: async () => readRow ?? null,
      }
      return builder
    },
  }
  return { db: db as any, updates, selects }
}

describe('markOnboardingSkipped — behaviour', () => {
  it('updates shops.onboarding_state to skipped for the right shop_id with pending guard', async () => {
    const { db, updates } = makeFakeDb()
    await markOnboardingSkipped(db, 'shop-123')
    expect(updates).toHaveLength(1)
    expect(updates[0].table).toBe('shops')
    expect(updates[0].set.onboarding_state).toBe('skipped')
    expect(updates[0].set.onboarding_choice).toBe('skipped')
    const whereById = updates[0].where.find((w) => w.col === 'id')
    expect(whereById).toEqual({ col: 'id', op: '=', val: 'shop-123' })
    const whereByState = updates[0].where.find((w) => w.col === 'onboarding_state')
    expect(whereByState).toEqual({ col: 'onboarding_state', op: '=', val: 'pending' })
  })
})

describe('markOnboardingCompleted — behaviour', () => {
  it('sets state=completed, completed_at not-null, and records choice', async () => {
    const { db, updates } = makeFakeDb()
    await markOnboardingCompleted(db, 'shop-77', 'clone_from_url')
    expect(updates[0].set.onboarding_state).toBe('completed')
    expect(updates[0].set.onboarding_choice).toBe('clone_from_url')
    expect(updates[0].set.onboarding_completed_at).toBeDefined()
    // Guard — the WHERE clause must restrict valid predecessors.
    const guardCol = updates[0].where.find((w) => w.col === 'onboarding_state')
    expect(guardCol).toBeDefined()
    // Accept either 'in' with an array or separate 'or' predicates.
    if (guardCol!.op === 'in') {
      expect(guardCol!.val).toEqual(expect.arrayContaining(['cloning', 'skipped']))
    }
  })

  it('accepts clone_from_library as a valid choice', async () => {
    const { db, updates } = makeFakeDb()
    await markOnboardingCompleted(db, 'shop-88', 'clone_from_library')
    expect(updates[0].set.onboarding_choice).toBe('clone_from_library')
  })

  it('accepts dismissed as a valid choice', async () => {
    const { db, updates } = makeFakeDb()
    await markOnboardingCompleted(db, 'shop-99', 'dismissed')
    expect(updates[0].set.onboarding_choice).toBe('dismissed')
  })
})

describe('markOnboardingCloning — behaviour', () => {
  it('sets state=cloning and stamps onboarding_clone_job_id', async () => {
    const { db, updates } = makeFakeDb()
    await markOnboardingCloning(db, 'shop-1', 'job-abc')
    expect(updates[0].set.onboarding_state).toBe('cloning')
    expect(updates[0].set.onboarding_clone_job_id).toBe('job-abc')
    // Guard — only transitions from pending.
    const guardCol = updates[0].where.find((w) => w.col === 'onboarding_state')
    expect(guardCol?.val).toBe('pending')
  })
})

describe('rollbackOnboardingToPending — behaviour', () => {
  it('resets state=pending and clears clone_job_id', async () => {
    const { db, updates } = makeFakeDb()
    await rollbackOnboardingToPending(db, 'shop-1')
    expect(updates[0].set.onboarding_state).toBe('pending')
    expect(updates[0].set.onboarding_clone_job_id).toBeNull()
    // Guard — only from cloning (prevents accidentally pending-ing a completed shop).
    const guardCol = updates[0].where.find((w) => w.col === 'onboarding_state')
    expect(guardCol?.val).toBe('cloning')
  })
})

describe('getOnboardingCloneJobId — behaviour', () => {
  it('returns the clone_job_id when present', async () => {
    const { db } = makeFakeDb({ onboarding_clone_job_id: 'job-xyz' })
    const jobId = await getOnboardingCloneJobId(db, 'shop-1')
    expect(jobId).toBe('job-xyz')
  })

  it('returns null when no row found', async () => {
    const { db } = makeFakeDb(null)
    const jobId = await getOnboardingCloneJobId(db, 'missing')
    expect(jobId).toBeNull()
  })

  it('returns null when row exists but column is null', async () => {
    const { db } = makeFakeDb({ onboarding_clone_job_id: null })
    const jobId = await getOnboardingCloneJobId(db, 'shop-without-clone')
    expect(jobId).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 4. Phase E Task E3 — clone-pro runner hooks
//
//    The runner calls these AFTER writing terminal status onto the
//    clone job row. Each helper narrows the existing state-machine
//    helpers with an `onboarding_clone_job_id = ?` guard so the
//    runner can blindly invoke them: if the shop's wizard already
//    completed / rolled back / never cloning-for-this-job, the UPDATE
//    is a silent zero-row no-op. That keeps the runner's callback
//    path free of "is this a wizard-origin job?" branching.
// ---------------------------------------------------------------------------

describe('completeOnboardingFromCloneJob — behaviour', () => {
  it('sets state=completed + choice=clone_from_url + completed_at', async () => {
    const { db, updates } = makeFakeDb()
    await completeOnboardingFromCloneJob(db, 'shop-77', 'job-abc')
    expect(updates).toHaveLength(1)
    expect(updates[0].table).toBe('shops')
    expect(updates[0].set.onboarding_state).toBe('completed')
    expect(updates[0].set.onboarding_choice).toBe('clone_from_url')
    expect(updates[0].set.onboarding_completed_at).toBeDefined()
  })

  it('double-guards on state=cloning AND onboarding_clone_job_id=jobId', async () => {
    // Without the job-id guard, a runner callback for Job A could
    // accidentally complete a wizard that's now cloning Job B (edge
    // case after a replace=1 retry). The SQL WHERE must restrict
    // both columns so only the exact cloning-for-THIS-job shop flips.
    const { db, updates } = makeFakeDb()
    await completeOnboardingFromCloneJob(db, 'shop-77', 'job-abc')
    const idGuard = updates[0].where.find((w) => w.col === 'id')
    expect(idGuard).toEqual({ col: 'id', op: '=', val: 'shop-77' })
    const stateGuard = updates[0].where.find((w) => w.col === 'onboarding_state')
    expect(stateGuard?.val).toBe('cloning')
    const jobGuard = updates[0].where.find((w) => w.col === 'onboarding_clone_job_id')
    expect(jobGuard).toEqual({ col: 'onboarding_clone_job_id', op: '=', val: 'job-abc' })
  })
})

describe('rollbackCloningForJob — behaviour', () => {
  it('resets state=pending and clears clone_job_id', async () => {
    const { db, updates } = makeFakeDb()
    await rollbackCloningForJob(db, 'shop-1', 'job-lost')
    expect(updates[0].set.onboarding_state).toBe('pending')
    expect(updates[0].set.onboarding_clone_job_id).toBeNull()
  })

  it('double-guards on state=cloning AND onboarding_clone_job_id=jobId', async () => {
    // Same reasoning as complete-hook: a failed-Job-A callback
    // arriving late must NOT roll back a shop that's already
    // cloning-for-Job-B or has completed on its own.
    const { db, updates } = makeFakeDb()
    await rollbackCloningForJob(db, 'shop-1', 'job-lost')
    const stateGuard = updates[0].where.find((w) => w.col === 'onboarding_state')
    expect(stateGuard?.val).toBe('cloning')
    const jobGuard = updates[0].where.find((w) => w.col === 'onboarding_clone_job_id')
    expect(jobGuard).toEqual({ col: 'onboarding_clone_job_id', op: '=', val: 'job-lost' })
  })
})
