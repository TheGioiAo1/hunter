/**
 * Gbox Platform — Phase Smoke Matrix tests (Phase 11 PR2)
 */

import { describe, it, expect } from 'vitest'
import {
  buildBaseline,
  compareToBaseline,
  discoverSmokes,
  formatMatrixReport,
  mergeBaseline,
  parseSmokeName,
  type SmokeBaseline,
  type SmokeRunResult,
} from './smoke-matrix.ts'

describe('smoke-matrix: parseSmokeName', () => {
  it('parses canonical smoke-phaseN-prM names', () => {
    expect(parseSmokeName('smoke-phase11-pr1')).toEqual({ phase: 11, pr: 1 })
    expect(parseSmokeName('smoke-phase4-pr5')).toEqual({ phase: 4, pr: 5 })
    expect(parseSmokeName('smoke-phase10-pr4')).toEqual({ phase: 10, pr: 4 })
  })

  it('parses decimal-phase smoke-phaseN-M-prP names as phase N.M', () => {
    expect(parseSmokeName('smoke-phase12-5-pr1')).toEqual({ phase: 12.5, pr: 1 })
    expect(parseSmokeName('smoke-phase12-5-pr2')).toEqual({ phase: 12.5, pr: 2 })
    expect(parseSmokeName('smoke-phase7-3-pr4')).toEqual({ phase: 7.3, pr: 4 })
  })

  it('parses pr1-5 style mid-PR fraction as pr 1.5', () => {
    expect(parseSmokeName('smoke-phase14-pr1-5')).toEqual({ phase: 14, pr: 1.5 })
    expect(parseSmokeName('smoke-phase14-pr3-2')).toEqual({ phase: 14, pr: 3.2 })
  })

  it('parses pr4b style alpha suffix with letters as hundredths (a=.01, b=.02)', () => {
    expect(parseSmokeName('smoke-phase14-pr4a')).toEqual({ phase: 14, pr: 4.01 })
    expect(parseSmokeName('smoke-phase14-pr4b')).toEqual({ phase: 14, pr: 4.02 })
    expect(parseSmokeName('smoke-phase14-pr4c')).toEqual({ phase: 14, pr: 4.03 })
  })

  it('returns null for legacy step-based names', () => {
    expect(parseSmokeName('smoke-http-step-1-20')).toBeNull()
    expect(parseSmokeName('smoke-liquid-step-1-5')).toBeNull()
    expect(parseSmokeName('smoke-i18n-step-1-2b')).toBeNull()
  })

  it('returns null for malformed inputs', () => {
    expect(parseSmokeName('')).toBeNull()
    expect(parseSmokeName('smoke-phaseX-pr1')).toBeNull()
    expect(parseSmokeName('smoke-phase11-prA')).toBeNull()
    expect(parseSmokeName('smoke-phase11')).toBeNull()
  })
})

describe('smoke-matrix: discoverSmokes', () => {
  it('filters + sorts by (phase, pr)', () => {
    const files = [
      'smoke-phase11-pr1.ts',
      'smoke-phase4-pr2.ts',
      'smoke-phase10-pr4.ts',
      'smoke-http-step-1-20.ts',
      'smoke-phase4-pr1.ts',
      'smoke-phase12-5-pr2.ts',
      'smoke-phase12-5-pr1.ts',
    ]
    expect(discoverSmokes(files)).toEqual([
      { name: 'smoke-phase4-pr1', phase: 4, pr: 1 },
      { name: 'smoke-phase4-pr2', phase: 4, pr: 2 },
      { name: 'smoke-phase10-pr4', phase: 10, pr: 4 },
      { name: 'smoke-phase11-pr1', phase: 11, pr: 1 },
      { name: 'smoke-phase12-5-pr1', phase: 12.5, pr: 1 },
      { name: 'smoke-phase12-5-pr2', phase: 12.5, pr: 2 },
    ])
  })

  it('accepts filenames with or without .ts', () => {
    expect(discoverSmokes(['smoke-phase1-pr1', 'smoke-phase2-pr2.ts'])).toEqual([
      { name: 'smoke-phase1-pr1', phase: 1, pr: 1 },
      { name: 'smoke-phase2-pr2', phase: 2, pr: 2 },
    ])
  })

  it('returns empty array on empty input', () => {
    expect(discoverSmokes([])).toEqual([])
  })
})

describe('smoke-matrix: buildBaseline / mergeBaseline', () => {
  it('buildBaseline defaults every entry to expectedPass=true', () => {
    const b = buildBaseline(
      [
        { name: 'smoke-phase11-pr1', phase: 11, pr: 1 },
        { name: 'smoke-phase4-pr2', phase: 4, pr: 2 },
      ],
      '2026-04-21T12:00:00.000Z',
    )
    expect(b.updatedAt).toBe('2026-04-21T12:00:00.000Z')
    expect(b.entries).toEqual([
      { name: 'smoke-phase11-pr1', expectedPass: true },
      { name: 'smoke-phase4-pr2', expectedPass: true },
    ])
  })

  it('mergeBaseline preserves existing expectedPass + note on match', () => {
    const prev: SmokeBaseline = {
      updatedAt: '2026-04-20T00:00:00.000Z',
      entries: [
        { name: 'smoke-phase1-pr1', expectedPass: false, note: 'known flake — see #123' },
        { name: 'smoke-phase2-pr1', expectedPass: true },
      ],
    }
    const next = mergeBaseline(
      prev,
      [
        { name: 'smoke-phase1-pr1', phase: 1, pr: 1 },
        { name: 'smoke-phase2-pr1', phase: 2, pr: 1 },
        { name: 'smoke-phase3-pr1', phase: 3, pr: 1 }, // new
      ],
      '2026-04-21T12:00:00.000Z',
    )
    expect(next.updatedAt).toBe('2026-04-21T12:00:00.000Z')
    expect(next.entries.find((e) => e.name === 'smoke-phase1-pr1')).toEqual({
      name: 'smoke-phase1-pr1',
      expectedPass: false,
      note: 'known flake — see #123',
    })
    expect(next.entries.find((e) => e.name === 'smoke-phase3-pr1')).toEqual({
      name: 'smoke-phase3-pr1',
      expectedPass: true,
    })
  })

  it('mergeBaseline drops smokes that no longer exist on disk', () => {
    const prev: SmokeBaseline = {
      updatedAt: '2026-04-20T00:00:00.000Z',
      entries: [
        { name: 'smoke-phase1-pr1', expectedPass: true },
        { name: 'smoke-phase99-deleted', expectedPass: true, note: 'file deleted' },
      ],
    }
    const next = mergeBaseline(
      prev,
      [{ name: 'smoke-phase1-pr1', phase: 1, pr: 1 }],
      '2026-04-21T00:00:00.000Z',
    )
    expect(next.entries).toEqual([{ name: 'smoke-phase1-pr1', expectedPass: true }])
  })
})

describe('smoke-matrix: compareToBaseline', () => {
  const baseline: SmokeBaseline = {
    updatedAt: '2026-04-21T00:00:00.000Z',
    entries: [
      { name: 'smoke-phase1-pr1', expectedPass: true },
      { name: 'smoke-phase2-pr1', expectedPass: true },
      { name: 'smoke-phase3-pr1', expectedPass: false, note: 'flake' },
    ],
  }

  function result(name: string, ok: boolean, phase = 1, pr = 1): SmokeRunResult {
    return {
      name,
      phase,
      pr,
      ok,
      exitCode: ok ? 0 : 1,
      durationMs: 100,
    }
  }

  it('clean when every expected-pass smoke passes', () => {
    const diff = compareToBaseline(baseline, [
      result('smoke-phase1-pr1', true),
      result('smoke-phase2-pr1', true),
      result('smoke-phase3-pr1', false), // matches expectedPass=false
    ])
    expect(diff.isClean).toBe(true)
    expect(diff.regressions).toEqual([])
  })

  it('flags regressions when an expected-pass smoke fails', () => {
    const diff = compareToBaseline(baseline, [
      result('smoke-phase1-pr1', false),
      result('smoke-phase2-pr1', true),
      result('smoke-phase3-pr1', false),
    ])
    expect(diff.isClean).toBe(false)
    expect(diff.regressions.map((r) => r.name)).toEqual(['smoke-phase1-pr1'])
  })

  it('flags unexpected passes as info (not failure)', () => {
    const diff = compareToBaseline(baseline, [
      result('smoke-phase1-pr1', true),
      result('smoke-phase2-pr1', true),
      result('smoke-phase3-pr1', true), // flake flipped green
    ])
    expect(diff.isClean).toBe(true) // still clean
    expect(diff.unexpectedPasses.map((r) => r.name)).toEqual(['smoke-phase3-pr1'])
  })

  it('tracks smokes present in runs but absent from baseline', () => {
    const diff = compareToBaseline(baseline, [
      result('smoke-phase1-pr1', true),
      result('smoke-phase2-pr1', true),
      result('smoke-phase3-pr1', false),
      result('smoke-phase11-pr1', true), // new
    ])
    expect(diff.missingFromBaseline.map((r) => r.name)).toEqual(['smoke-phase11-pr1'])
  })

  it('tracks baseline entries that didn\'t run', () => {
    const diff = compareToBaseline(baseline, [result('smoke-phase1-pr1', true)])
    expect(diff.missingFromResults.map((b) => b.name)).toEqual([
      'smoke-phase2-pr1',
      'smoke-phase3-pr1',
    ])
  })
})

describe('smoke-matrix: formatMatrixReport', () => {
  function result(name: string, ok: boolean, phase: number, pr: number): SmokeRunResult {
    return { name, phase, pr, ok, exitCode: ok ? 0 : 1, durationMs: 150 }
  }

  it('renders per-phase grid with OK/FAIL cells', () => {
    const results = [
      result('smoke-phase1-pr1', true, 1, 1),
      result('smoke-phase1-pr2', false, 1, 2),
      result('smoke-phase11-pr1', true, 11, 1),
    ]
    const baseline: SmokeBaseline = {
      updatedAt: '2026-04-21T00:00:00.000Z',
      entries: [
        { name: 'smoke-phase1-pr1', expectedPass: true },
        { name: 'smoke-phase1-pr2', expectedPass: true },
        { name: 'smoke-phase11-pr1', expectedPass: true },
      ],
    }
    const out = formatMatrixReport(results, compareToBaseline(baseline, results))
    expect(out).toContain('Phase  1')
    expect(out).toContain('Phase 11')
    expect(out).toContain('PR1:OK(150ms)')
    expect(out).toContain('PR2:FAIL(150ms)')
    expect(out).toContain('2/3 smokes passed')
    expect(out).toContain('RESULT: red')
    expect(out).toContain('[REGRESSION]')
  })

  it('handles empty results gracefully', () => {
    const out = formatMatrixReport([], {
      regressions: [],
      unexpectedPasses: [],
      missingFromBaseline: [],
      missingFromResults: [],
      isClean: true,
    })
    expect(out).toContain('0/0 smokes passed')
  })

  it('never includes "god admin" (iron rule 5)', () => {
    const out = formatMatrixReport([result('smoke-phase1-pr1', false, 1, 1)], {
      regressions: [result('smoke-phase1-pr1', false, 1, 1)],
      unexpectedPasses: [],
      missingFromBaseline: [],
      missingFromResults: [],
      isClean: false,
    })
    expect(out.toLowerCase()).not.toContain('god admin')
    expect(out.toLowerCase()).not.toContain('god-admin')
  })
})
