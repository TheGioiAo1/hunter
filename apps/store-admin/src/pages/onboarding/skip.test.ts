/**
 * Store-admin — onboarding skip handler tests (Phase C / Task C3).
 *
 * POST /admin/store/:slug/onboarding/skip
 *
 * Fires when the seller clicks "I'll do this later" on the welcome page.
 * Transitions the shop from `pending` → `skipped`, which:
 *
 *   1. Makes the wizard stop auto-redirecting (gate middleware sees
 *      `skipped` and only flags the Resume banner, doesn't block).
 *   2. Records the `onboarding_choice='skipped'` for Phase-F analytics
 *      (breakdown of seller intent: clone vs library vs bail).
 *
 * No-op for any state that isn't `pending` so the seller can't
 * accidentally re-set `choice='skipped'` by hitting the URL twice
 * (e.g. after a dismiss-banner the state is `completed` and the skip
 * form shouldn't drag it backward).
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { postOnboardingSkip } from './skip.js'

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

function makeReq(opts: {
  slug?: string
  shopId?: string
} = {}) {
  return {
    store: {
      id: opts.shopId ?? 'shop-abc-123',
      slug: opts.slug ?? 'lifeasy',
      name: 'Lifeasy',
    },
    storeUser: { id: 'user-1', name: 'Thai', email: 't@example.com', role: 'owner' },
    headers: {},
  } as any
}

function makeRes() {
  const res: any = { _redirectUrl: null, _redirectStatus: 0 }
  res.redirect = vi.fn((arg1: any, arg2?: any) => {
    res._redirectStatus = typeof arg1 === 'number' ? arg1 : 302
    res._redirectUrl = typeof arg1 === 'number' ? arg2 : arg1
    return res
  })
  return res
}

// Fake DB that captures the UPDATE payload `markOnboardingSkipped` issues.
// We intercept at the Kysely chain boundary so the helper's real SQL-shape
// is what we're testing end-to-end.
function makeFakeDb(opts: { currentState?: string } = {}) {
  const captured: any[] = []
  const chain: any = {}
  chain.set = (patch: any) => {
    captured.push({ op: 'set', patch })
    return chain
  }
  chain.where = (col: any, op: any, val: any) => {
    captured.push({ op: 'where', col, opArg: op, val })
    return chain
  }
  chain.executeTakeFirst = async () => ({ numUpdatedRows: BigInt(1) })
  chain.execute = async () => []
  return {
    _captured: captured,
    updateTable: (_name: string) => chain,
    selectFrom: () => chain,
  } as any
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// Skip handler
// ---------------------------------------------------------------------------

describe('postOnboardingSkip', () => {
  it('redirects to the dashboard after marking skipped', async () => {
    const req = makeReq({ slug: 'lifeasy' })
    const res = makeRes()
    const db = makeFakeDb()
    await postOnboardingSkip(req, res, db)
    expect(res.redirect).toHaveBeenCalledTimes(1)
    expect(res._redirectStatus).toBe(302)
    expect(res._redirectUrl).toBe('/admin/store/lifeasy')
  })

  it('calls markOnboardingSkipped with the shop id', async () => {
    const req = makeReq({ shopId: 'shop-xyz-999' })
    const res = makeRes()
    const db = makeFakeDb()
    await postOnboardingSkip(req, res, db)
    // The helper updates shops SET onboarding_state='skipped', onboarding_choice='skipped'
    // gated on current state being 'pending'. Verify the update ran with a
    // where-clause on the shop id.
    const whereCalls = db._captured.filter((c: any) => c.op === 'where')
    const idWhere = whereCalls.find((c: any) => c.col === 'id' && c.val === 'shop-xyz-999')
    expect(idWhere).toBeDefined()
  })

  it('is a no-op on non-pending states (helper gates on state=pending)', async () => {
    // The helper itself enforces `state='pending'` via a WHERE clause.
    // The handler's job is just to delegate and redirect — no extra branch.
    // We verify by checking the generated WHERE clause includes the state gate.
    const req = makeReq()
    const res = makeRes()
    const db = makeFakeDb()
    await postOnboardingSkip(req, res, db)
    const stateWhere = db._captured.find(
      (c: any) => c.op === 'where' && c.col === 'onboarding_state' && c.val === 'pending',
    )
    expect(stateWhere).toBeDefined()
  })
})
