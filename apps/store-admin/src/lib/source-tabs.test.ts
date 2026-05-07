/**
 * Store-admin — source-tabs pure helpers.
 *
 * Unit coverage for the three mutation-free helpers in source-tabs.ts:
 *
 *   1. resolveSourceParam(raw, sources)  — parse ?source= query param
 *   2. applySourceFilter(qb, col, filter) — attach WHERE to a Kysely builder
 *   3. cloneSourceLabel(source)            — pick a display label
 *
 * Phase 5 (2026-04-17) simplified all three by removing the
 * `ORPHAN_SENTINEL` / `'orphan'` filter branch. Tests here lock in the
 * post-simplification shape so a future regression can't quietly re-add
 * the dead path.
 */

import { describe, it, expect } from 'vitest'
import {
  applySourceFilter,
  cloneSourceLabel,
  resolveSourceParam,
  type CloneSource,
  type SourceFilter,
} from './source-tabs.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const sourceA: CloneSource = {
  id: '11111111-1111-1111-1111-111111111111',
  source_url: 'https://www.bibliobloom.com/shop',
  label: 'Bibliobloom',
  canonical_domain: 'bibliobloom.com',
  item_count: 42,
}

const sourceB: CloneSource = {
  id: '22222222-2222-2222-2222-222222222222',
  source_url: 'https://example.co/catalog',
  label: null,
  canonical_domain: null,
  item_count: 3,
}

const allSources: CloneSource[] = [sourceA, sourceB]

// ---------------------------------------------------------------------------
// resolveSourceParam
// ---------------------------------------------------------------------------

describe('resolveSourceParam', () => {
  it('returns "all" for empty or missing input', () => {
    expect(resolveSourceParam('', allSources)).toBe('all')
    expect(resolveSourceParam('   ', allSources)).toBe('all')
  })

  it('maps "manual" (any casing) to the manual filter', () => {
    expect(resolveSourceParam('manual', allSources)).toBe('manual')
    expect(resolveSourceParam('Manual', allSources)).toBe('manual')
    expect(resolveSourceParam('  MANUAL  ', allSources)).toBe('manual')
  })

  it('returns a known source id verbatim', () => {
    expect(resolveSourceParam(sourceA.id, allSources)).toBe(sourceA.id)
  })

  it('falls back to "all" for an unknown id (stale bookmark safety)', () => {
    expect(resolveSourceParam('99999999-9999-9999-9999-999999999999', allSources)).toBe('all')
  })

  it('falls back to "all" when the sources list is empty', () => {
    expect(resolveSourceParam(sourceA.id, [])).toBe('all')
  })

  it('does NOT recognise the legacy "orphan" sentinel (removed in Phase 5)', () => {
    // Pre-Phase-5 the UI shipped an `__orphan__` sentinel for the
    // "Imported (unknown source)" tab. Migration 044 made that state
    // physically impossible, so the sentinel is now just an unknown
    // id — must fall back to 'all'.
    expect(resolveSourceParam('__orphan__', allSources)).toBe('all')
    expect(resolveSourceParam('orphan', allSources)).toBe('all')
  })
})

// ---------------------------------------------------------------------------
// applySourceFilter
// ---------------------------------------------------------------------------

/**
 * Tiny Kysely-shaped builder stand-in. We don't need a real DB — the
 * helper is generic over `{ where: (...args) => Q }`, so this fakes the
 * fluent interface and records the where() calls.
 */
interface FakeBuilder {
  calls: Array<[string, string, unknown]>
  where: (col: string, op: string, val: unknown) => FakeBuilder
}
function makeBuilder(): FakeBuilder {
  const calls: Array<[string, string, unknown]> = []
  const b: FakeBuilder = {
    calls,
    where(col, op, val) {
      calls.push([col, op, val])
      return b
    },
  }
  return b
}

describe('applySourceFilter', () => {
  it('is a no-op when filter === "all"', () => {
    const b = makeBuilder()
    const out = applySourceFilter(b, 'products.clone_job_id', 'all')
    expect(out).toBe(b)
    expect(b.calls).toHaveLength(0)
  })

  it('adds `col IS NULL` when filter === "manual"', () => {
    const b = makeBuilder()
    applySourceFilter(b, 'products.clone_job_id', 'manual')
    expect(b.calls).toEqual([['products.clone_job_id', 'is', null]])
  })

  it('adds `col = <uuid>` when filter is a concrete source id', () => {
    const b = makeBuilder()
    applySourceFilter(b, 'products.clone_job_id', sourceA.id as SourceFilter)
    expect(b.calls).toEqual([['products.clone_job_id', '=', sourceA.id]])
  })

  it('ignores the legacy knownSourceIds hint (Phase 5 kept it only for signature back-compat)', () => {
    const b = makeBuilder()
    applySourceFilter(b, 'products.clone_job_id', 'manual', [sourceA.id, sourceB.id])
    expect(b.calls).toEqual([['products.clone_job_id', 'is', null]])
  })
})

// ---------------------------------------------------------------------------
// cloneSourceLabel
// ---------------------------------------------------------------------------

describe('cloneSourceLabel', () => {
  it('prefers merchant-edited label when present', () => {
    expect(cloneSourceLabel(sourceA)).toBe('Bibliobloom')
  })

  it('trims whitespace around the label', () => {
    expect(cloneSourceLabel({ ...sourceA, label: '  Bibliobloom  ' })).toBe('Bibliobloom')
  })

  it('falls back to canonical_domain when label is blank', () => {
    const s: CloneSource = { ...sourceA, label: '   ' }
    expect(cloneSourceLabel(s)).toBe('bibliobloom.com')
  })

  it('falls back to hostname (stripped of www.) when label + canonical are missing', () => {
    expect(cloneSourceLabel(sourceB)).toBe('example.co')
  })

  it('strips leading "www." from the derived hostname', () => {
    const s: CloneSource = {
      ...sourceB,
      source_url: 'https://www.foo.example.com/path?q=1',
    }
    expect(cloneSourceLabel(s)).toBe('foo.example.com')
  })

  it('returns the raw source_url when URL parsing fails', () => {
    const s: CloneSource = {
      ...sourceB,
      source_url: 'not a url',
    }
    expect(cloneSourceLabel(s)).toBe('not a url')
  })

  it('returns "Clone source" when everything is missing', () => {
    const s: CloneSource = {
      id: 'x',
      source_url: '',
      label: null,
      canonical_domain: null,
      item_count: 0,
    }
    expect(cloneSourceLabel(s)).toBe('Clone source')
  })
})
