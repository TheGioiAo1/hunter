/**
 * Unit tests for Phase 14 PR1.5 — preference-center + quiet-hours helpers.
 *
 *   - `isInsideQuietHours()` — pure fn, covers DST-safe IANA zone lookup,
 *     window that wraps midnight, invalid zones (fall back UTC),
 *     degenerate zero-length windows.
 *   - `getPreferenceCenterView()` — token → (email, shop, all-rows) view.
 *   - `updateFrequencyCap()` — partial-update semantics + explicit null.
 *   - `bulkUpdateSubscriptionsByToken()` — token → write multiple categories.
 *
 * Full `canSend()` frequency-cap + quiet-hours paths are covered by the
 * live-DB smoke test (scripts/smoke-phase14-pr1-5.ts) — the join+count
 * shape is too entangled with Kysely's fn builder to fake here without
 * the stub becoming a Kysely clone.
 */

import { describe, it, expect } from 'vitest'
import {
  isInsideQuietHours,
  getPreferenceCenterView,
  updateFrequencyCap,
  bulkUpdateSubscriptionsByToken,
  hashUnsubscribeToken,
} from './preferences.js'
import type { EmailPreferenceCategory } from '@gbox/db/schema/tables.js'

// ---------------------------------------------------------------------------
// isInsideQuietHours — pure function
// ---------------------------------------------------------------------------

describe('isInsideQuietHours', () => {
  // Fixed reference: 2026-01-15T12:00:00Z (Thursday). UTC-12:00 noon.
  const noonUtc = new Date('2026-01-15T12:00:00Z')
  // 2026-01-15T01:00:00Z (UTC-01:00 AM Thursday; local 20:00 NY on Wed).
  const oneAmUtc = new Date('2026-01-15T01:00:00Z')
  // 2026-01-15T15:00:00Z (UTC-15:00 PM Thursday; local 22:00 Bangkok).
  const threePmUtc = new Date('2026-01-15T15:00:00Z')

  it('returns false when current time is outside a same-day window', () => {
    // 22:00 → 08:00 is the classic "no emails at night" window.
    // At noon UTC we're clearly awake anywhere.
    expect(isInsideQuietHours(noonUtc, '22:00:00', '08:00:00', 'UTC')).toBe(false)
  })

  it('returns true when current time is inside a same-day window (UTC)', () => {
    // 10:00 → 18:00 window, current time noon UTC → inside.
    expect(isInsideQuietHours(noonUtc, '10:00:00', '18:00:00', 'UTC')).toBe(true)
  })

  it('returns false when current time is outside a same-day window (UTC)', () => {
    // 14:00 → 18:00 window, current time noon UTC → outside.
    expect(isInsideQuietHours(noonUtc, '14:00:00', '18:00:00', 'UTC')).toBe(false)
  })

  it('handles a window that wraps midnight (22:00 → 08:00)', () => {
    // 01:00 UTC is inside the 22:00→08:00 wrap window.
    expect(isInsideQuietHours(oneAmUtc, '22:00:00', '08:00:00', 'UTC')).toBe(true)
    // 12:00 UTC is outside.
    expect(isInsideQuietHours(noonUtc, '22:00:00', '08:00:00', 'UTC')).toBe(false)
    // 23:30 UTC is inside.
    const lateNight = new Date('2026-01-15T23:30:00Z')
    expect(isInsideQuietHours(lateNight, '22:00:00', '08:00:00', 'UTC')).toBe(true)
  })

  it('handles a degenerate zero-length window (start === end) as always-false', () => {
    // Customer UI should refuse to persist this, but if it slips through
    // we don't want to silently block every send.
    expect(isInsideQuietHours(noonUtc, '12:00:00', '12:00:00', 'UTC')).toBe(false)
    expect(isInsideQuietHours(noonUtc, '00:00:00', '00:00:00', 'UTC')).toBe(false)
  })

  it('respects a non-UTC IANA timezone (America/New_York, EST)', () => {
    // 2026-01-15T12:00:00Z → 07:00 New_York (EST is UTC-5, no DST in January).
    // Window 06:00 → 09:00 in local time → inside.
    expect(isInsideQuietHours(noonUtc, '06:00:00', '09:00:00', 'America/New_York')).toBe(true)
    // Window 10:00 → 18:00 in local → outside (local is 07:00).
    expect(isInsideQuietHours(noonUtc, '10:00:00', '18:00:00', 'America/New_York')).toBe(false)
  })

  it('respects Asia/Bangkok (UTC+7, no DST)', () => {
    // 2026-01-15T15:00:00Z → 22:00 Bangkok → inside 21:00→23:00 window.
    expect(isInsideQuietHours(threePmUtc, '21:00:00', '23:00:00', 'Asia/Bangkok')).toBe(true)
    // Same UTC instant, 10:00→12:00 Bangkok window → outside.
    expect(isInsideQuietHours(threePmUtc, '10:00:00', '12:00:00', 'Asia/Bangkok')).toBe(false)
  })

  it('falls back to UTC when the TZ name is garbage', () => {
    // 'Atlantis/Lost_City' is not a valid IANA name. The helper should
    // swallow the Intl error + fall back to UTC.
    // 12:00 UTC is inside 10:00→14:00 UTC → assert true.
    expect(isInsideQuietHours(noonUtc, '10:00:00', '14:00:00', 'Atlantis/Lost_City')).toBe(true)
    // 12:00 UTC is outside 14:00→16:00 UTC → assert false.
    expect(isInsideQuietHours(noonUtc, '14:00:00', '16:00:00', 'Atlantis/Lost_City')).toBe(false)
  })

  it('returns false on unparseable time strings (defensive)', () => {
    // 'not:a:time' doesn't match the parser → helper returns false so we
    // don't block sends because of a bad row.
    expect(isInsideQuietHours(noonUtc, 'not:a:time', '08:00:00', 'UTC')).toBe(false)
    expect(isInsideQuietHours(noonUtc, '22:00:00', 'also_bad', 'UTC')).toBe(false)
  })

  it('accepts HH:MM without seconds (postgres TIME coerces sub-minute precision away)', () => {
    // Some PG drivers strip :SS. Our parser treats missing seconds as 0.
    expect(isInsideQuietHours(noonUtc, '10:00', '18:00', 'UTC')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// In-memory Kysely stub for preference-center helpers
// ---------------------------------------------------------------------------
//
// Supports select-from + update-table + insert-into shapes against a
// single `email_preferences` table. Filter ops supported: '=', 'is'
// (for is null on shop_id), and the fn('lower', ['email']) expression.
// Good enough for the 3 helpers under test.

interface PrefRow {
  id: string
  shop_id: string | null
  customer_id: string | null
  email: string
  category: EmailPreferenceCategory
  subscribed: boolean
  unsubscribe_token_hash: string
  source: string
  unsubscribed_at: string | null
  subscribed_at: string | null
  last_email_sent_at: string | null
  max_per_day: number | null
  max_per_week: number | null
  quiet_hours_start: string | null
  quiet_hours_end: string | null
  quiet_hours_timezone: string | null
  created_at: string
  updated_at: string
}

type PrefFilter =
  | { kind: 'eq'; col: string; val: unknown }
  | { kind: 'is-null'; col: string }
  | { kind: 'lower-eq'; col: string; val: string }

function matches(row: PrefRow, filters: PrefFilter[]): boolean {
  return filters.every((f) => {
    if (f.kind === 'eq') return (row as unknown as Record<string, unknown>)[f.col] === f.val
    if (f.kind === 'is-null') return (row as unknown as Record<string, unknown>)[f.col] == null
    // lower-eq
    const v = (row as unknown as Record<string, unknown>)[f.col]
    return typeof v === 'string' && v.trim().toLowerCase() === f.val
  })
}

function makeEbStub() {
  // This stubs the Kysely expression builder just enough for our helpers.
  // Our helpers call `eb.fn<string>('lower', ['col'])` then compare with
  // `.where(ebFn, '=', literal)`. We capture that into a lower-eq filter.
  return {
    fn<T>(_name: string, args: unknown[]) {
      return { __kind: 'fn-lower', col: (args[0] as string) }
    },
  }
}

function makeStubDb() {
  const rows: PrefRow[] = []
  let idCounter = 0

  function mkRow(partial: Partial<PrefRow> & Pick<PrefRow, 'email' | 'category' | 'unsubscribe_token_hash'>): PrefRow {
    idCounter++
    return {
      id: `pref-${idCounter}`,
      shop_id: null,
      customer_id: null,
      subscribed: true,
      source: 'seed',
      unsubscribed_at: null,
      subscribed_at: new Date().toISOString(),
      last_email_sent_at: null,
      max_per_day: null,
      max_per_week: null,
      quiet_hours_start: null,
      quiet_hours_end: null,
      quiet_hours_timezone: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      ...partial,
    }
  }

  function collectFilters(thing: unknown, op: string | unknown, val?: unknown): PrefFilter {
    // where('col', '=', val) or where('col', 'is', null) or where((eb) => eb.fn(...), '=', val)
    if (typeof thing === 'function') {
      // Caller passed a lambda — invoke with our eb stub.
      const result = (thing as (eb: ReturnType<typeof makeEbStub>) => unknown)(makeEbStub())
      if (result && typeof result === 'object' && (result as { __kind?: string }).__kind === 'fn-lower') {
        return { kind: 'lower-eq', col: (result as { col: string }).col, val: String(val).trim().toLowerCase() }
      }
      // Fallback: treat as always-true (we don't use eb.or here).
      return { kind: 'eq', col: '__noop__', val: true }
    }
    if (op === 'is') return { kind: 'is-null', col: thing as string }
    return { kind: 'eq', col: thing as string, val }
  }

  function selectFromBuilder() {
    const filters: PrefFilter[] = []
    let cols: readonly string[] = []
    const api = {
      select(_cols: readonly string[]) {
        cols = _cols
        return api
      },
      where(thing: unknown, op?: unknown, val?: unknown) {
        filters.push(collectFilters(thing, op, val))
        return api
      },
      execute: async () => {
        return rows.filter((r) => matches(r, filters)).map((r) => projectRow(r, cols))
      },
      executeTakeFirst: async () => {
        const hit = rows.find((r) => matches(r, filters))
        if (!hit) return undefined
        return projectRow(hit, cols)
      },
    }
    return api
  }

  function updateTableBuilder() {
    const filters: PrefFilter[] = []
    let setObj: Record<string, unknown> = {}
    const api = {
      set(obj: Record<string, unknown>) {
        setObj = obj
        return api
      },
      where(thing: unknown, op?: unknown, val?: unknown) {
        filters.push(collectFilters(thing, op, val))
        return api
      },
      execute: async () => {
        let n = 0n
        for (const r of rows) {
          if (matches(r, filters)) {
            Object.assign(r, setObj)
            n++
          }
        }
        return { numUpdatedRows: n }
      },
      executeTakeFirst: async () => {
        return api.execute()
      },
    }
    return api
  }

  function projectRow(r: PrefRow, cols: readonly string[]): Record<string, unknown> {
    if (cols.length === 0) return { ...r }
    const out: Record<string, unknown> = {}
    for (const c of cols) out[c] = (r as unknown as Record<string, unknown>)[c]
    return out
  }

  return {
    selectFrom() {
      return selectFromBuilder()
    },
    updateTable() {
      return updateTableBuilder()
    },
    _seed(row: Partial<PrefRow> & Pick<PrefRow, 'email' | 'category' | 'unsubscribe_token_hash'>): PrefRow {
      const r = mkRow(row)
      rows.push(r)
      return r
    },
    _rows() {
      return rows
    },
  }
}

// ---------------------------------------------------------------------------
// getPreferenceCenterView
// ---------------------------------------------------------------------------

describe('getPreferenceCenterView', () => {
  const rawToken = 'tok-abc-123'
  const hash = hashUnsubscribeToken(rawToken)

  it('returns found=false for a token that does not match any row', async () => {
    const db = makeStubDb()
    // Wrong token, no rows.
    const out = await getPreferenceCenterView(db as never, 'nope-token')
    expect(out.found).toBe(false)
    expect(out.email).toBeNull()
    expect(out.preferences).toEqual([])
  })

  it('returns all sibling rows for the (shop, email) pair, not just the anchor', async () => {
    const db = makeStubDb()
    // Anchor row — this one matches the raw token hash.
    db._seed({
      email: 'jane@example.com',
      shop_id: 'shop-a',
      category: 'marketing',
      unsubscribe_token_hash: hash,
    })
    // Sibling categories for the same (shop, email) — these should all show
    // up in the view so Jane can toggle them in one page load.
    db._seed({
      email: 'jane@example.com',
      shop_id: 'shop-a',
      category: 'lifecycle',
      unsubscribe_token_hash: 'other-hash-1',
      subscribed: true,
    })
    db._seed({
      email: 'jane@example.com',
      shop_id: 'shop-a',
      category: 'newsletter',
      unsubscribe_token_hash: 'other-hash-2',
      subscribed: false,
    })
    // Unrelated row — different email, same shop — MUST NOT show up.
    db._seed({
      email: 'someoneelse@example.com',
      shop_id: 'shop-a',
      category: 'marketing',
      unsubscribe_token_hash: 'other-hash-3',
    })
    // Unrelated row — same email, different shop — MUST NOT show up.
    db._seed({
      email: 'jane@example.com',
      shop_id: 'shop-b',
      category: 'marketing',
      unsubscribe_token_hash: 'other-hash-4',
    })

    const out = await getPreferenceCenterView(db as never, rawToken)
    expect(out.found).toBe(true)
    expect(out.email).toBe('jane@example.com')
    expect(out.shopId).toBe('shop-a')
    expect(out.focusedCategory).toBe('marketing')
    expect(out.preferences).toHaveLength(3)
    const cats = out.preferences.map((p) => p.category).sort()
    expect(cats).toEqual(['lifecycle', 'marketing', 'newsletter'])
  })

  it('is case-insensitive on email when fanning out to siblings', async () => {
    const db = makeStubDb()
    // Anchor stored as 'JANE@example.com'.
    db._seed({
      email: 'JANE@example.com',
      shop_id: 'shop-a',
      category: 'marketing',
      unsubscribe_token_hash: hash,
    })
    // Sibling stored with different casing — must still be picked up by
    // the lower(email) match.
    db._seed({
      email: 'jane@EXAMPLE.com',
      shop_id: 'shop-a',
      category: 'lifecycle',
      unsubscribe_token_hash: 'other-hash',
    })
    const out = await getPreferenceCenterView(db as never, rawToken)
    expect(out.found).toBe(true)
    expect(out.preferences).toHaveLength(2)
  })

  it('handles platform-scope anchor (shop_id=null) correctly', async () => {
    const db = makeStubDb()
    db._seed({
      email: 'jane@example.com',
      shop_id: null,
      category: 'marketing',
      unsubscribe_token_hash: hash,
    })
    // Same email but a shop row — should NOT leak into the platform view.
    db._seed({
      email: 'jane@example.com',
      shop_id: 'shop-a',
      category: 'marketing',
      unsubscribe_token_hash: 'other-hash',
    })
    const out = await getPreferenceCenterView(db as never, rawToken)
    expect(out.found).toBe(true)
    expect(out.shopId).toBeNull()
    expect(out.preferences).toHaveLength(1)
  })

  it('surfaces frequency-cap + quiet-hours values in the view', async () => {
    const db = makeStubDb()
    db._seed({
      email: 'jane@example.com',
      shop_id: 'shop-a',
      category: 'marketing',
      unsubscribe_token_hash: hash,
      max_per_day: 2,
      max_per_week: 10,
      quiet_hours_start: '22:00:00',
      quiet_hours_end: '08:00:00',
      quiet_hours_timezone: 'America/New_York',
    })
    const out = await getPreferenceCenterView(db as never, rawToken)
    expect(out.preferences[0].max_per_day).toBe(2)
    expect(out.preferences[0].max_per_week).toBe(10)
    expect(out.preferences[0].quiet_hours_start).toBe('22:00:00')
    expect(out.preferences[0].quiet_hours_end).toBe('08:00:00')
    expect(out.preferences[0].quiet_hours_timezone).toBe('America/New_York')
  })
})

// ---------------------------------------------------------------------------
// updateFrequencyCap
// ---------------------------------------------------------------------------

describe('updateFrequencyCap', () => {
  it('is a no-op when no fields are passed (updated=false)', async () => {
    const db = makeStubDb()
    db._seed({
      email: 'j@e.com',
      category: 'marketing',
      unsubscribe_token_hash: 'h',
    })
    const out = await updateFrequencyCap(db as never, { preferenceId: 'pref-1' })
    expect(out.updated).toBe(false)
  })

  it('updates only the fields that are passed (partial update)', async () => {
    const db = makeStubDb()
    const row = db._seed({
      email: 'j@e.com',
      category: 'marketing',
      unsubscribe_token_hash: 'h',
      max_per_day: 5,
      max_per_week: 30,
      quiet_hours_start: '22:00:00',
      quiet_hours_end: '08:00:00',
      quiet_hours_timezone: 'UTC',
    })
    const out = await updateFrequencyCap(db as never, {
      preferenceId: row.id,
      maxPerDay: 1,
    })
    expect(out.updated).toBe(true)
    expect(row.max_per_day).toBe(1)
    // Untouched:
    expect(row.max_per_week).toBe(30)
    expect(row.quiet_hours_start).toBe('22:00:00')
    expect(row.quiet_hours_timezone).toBe('UTC')
  })

  it('explicit null clears a cap / quiet-hours value', async () => {
    const db = makeStubDb()
    const row = db._seed({
      email: 'j@e.com',
      category: 'marketing',
      unsubscribe_token_hash: 'h',
      max_per_day: 5,
      quiet_hours_start: '22:00:00',
    })
    const out = await updateFrequencyCap(db as never, {
      preferenceId: row.id,
      maxPerDay: null,
      quietHoursStart: null,
    })
    expect(out.updated).toBe(true)
    expect(row.max_per_day).toBeNull()
    expect(row.quiet_hours_start).toBeNull()
  })

  it('updates all five fields in one call', async () => {
    const db = makeStubDb()
    const row = db._seed({
      email: 'j@e.com',
      category: 'marketing',
      unsubscribe_token_hash: 'h',
    })
    await updateFrequencyCap(db as never, {
      preferenceId: row.id,
      maxPerDay: 3,
      maxPerWeek: 15,
      quietHoursStart: '21:00:00',
      quietHoursEnd: '07:00:00',
      quietHoursTimezone: 'Asia/Bangkok',
    })
    expect(row.max_per_day).toBe(3)
    expect(row.max_per_week).toBe(15)
    expect(row.quiet_hours_start).toBe('21:00:00')
    expect(row.quiet_hours_end).toBe('07:00:00')
    expect(row.quiet_hours_timezone).toBe('Asia/Bangkok')
  })
})

// ---------------------------------------------------------------------------
// bulkUpdateSubscriptionsByToken
// ---------------------------------------------------------------------------

describe('bulkUpdateSubscriptionsByToken', () => {
  const rawToken = 'bulk-tok-456'
  const hash = hashUnsubscribeToken(rawToken)

  it('returns found=false for unknown token with zero changes', async () => {
    const db = makeStubDb()
    const out = await bulkUpdateSubscriptionsByToken(db as never, 'unknown', [
      { category: 'marketing', subscribed: false },
    ])
    expect(out.found).toBe(false)
    expect(out.changed).toBe(0)
  })

  it('flips subscribed across multiple categories for the (shop, email) pair', async () => {
    const db = makeStubDb()
    const anchor = db._seed({
      email: 'jane@example.com',
      shop_id: 'shop-a',
      category: 'marketing',
      unsubscribe_token_hash: hash,
      subscribed: true,
    })
    const sib = db._seed({
      email: 'jane@example.com',
      shop_id: 'shop-a',
      category: 'lifecycle',
      unsubscribe_token_hash: 'unused',
      subscribed: true,
    })
    const out = await bulkUpdateSubscriptionsByToken(db as never, rawToken, [
      { category: 'marketing', subscribed: false },
      { category: 'lifecycle', subscribed: false },
    ])
    expect(out.found).toBe(true)
    expect(out.changed).toBe(2)
    expect(anchor.subscribed).toBe(false)
    expect(anchor.unsubscribed_at).not.toBeNull()
    expect(sib.subscribed).toBe(false)
    expect(sib.unsubscribed_at).not.toBeNull()
  })

  it('does not touch rows for other (shop, email) pairs', async () => {
    const db = makeStubDb()
    db._seed({
      email: 'jane@example.com',
      shop_id: 'shop-a',
      category: 'marketing',
      unsubscribe_token_hash: hash,
      subscribed: true,
    })
    // Different email → must stay subscribed.
    const otherUser = db._seed({
      email: 'bob@example.com',
      shop_id: 'shop-a',
      category: 'marketing',
      unsubscribe_token_hash: 'other-hash',
      subscribed: true,
    })
    // Different shop → must stay subscribed.
    const otherShop = db._seed({
      email: 'jane@example.com',
      shop_id: 'shop-b',
      category: 'marketing',
      unsubscribe_token_hash: 'other-hash-2',
      subscribed: true,
    })
    await bulkUpdateSubscriptionsByToken(db as never, rawToken, [
      { category: 'marketing', subscribed: false },
    ])
    expect(otherUser.subscribed).toBe(true)
    expect(otherShop.subscribed).toBe(true)
  })

  it('can resubscribe (set true) — clears unsubscribed_at', async () => {
    const db = makeStubDb()
    const row = db._seed({
      email: 'jane@example.com',
      shop_id: 'shop-a',
      category: 'marketing',
      unsubscribe_token_hash: hash,
      subscribed: false,
      unsubscribed_at: '2026-01-01T00:00:00Z',
    })
    const out = await bulkUpdateSubscriptionsByToken(db as never, rawToken, [
      { category: 'marketing', subscribed: true },
    ])
    expect(out.changed).toBe(1)
    expect(row.subscribed).toBe(true)
    expect(row.unsubscribed_at).toBeNull()
  })
})
