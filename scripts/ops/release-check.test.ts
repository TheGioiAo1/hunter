/**
 * Gbox Platform — Release Preflight Check tests (Phase 11 PR1)
 *
 * Unit tests for the pure pieces of `release-check.ts` — the node
 * version parser and the report formatter. The three actual checks
 * (`checkMigrationLedger`, `checkGitClean`, `checkNodeVersion`) run
 * I/O and are covered by the live smoke (scripts/smoke-phase11-pr1.ts).
 */

import { describe, it, expect } from 'vitest'
import { formatReleaseReport, parseNodeMajor, MIN_NODE_MAJOR } from './release-check.ts'

describe('release-check: parseNodeMajor', () => {
  it('extracts major from a valid version string', () => {
    expect(parseNodeMajor('v20.11.1')).toBe(20)
    expect(parseNodeMajor('v24.14.1')).toBe(24)
  })

  it('trims whitespace', () => {
    expect(parseNodeMajor('  v22.3.0\n')).toBe(22)
  })

  it('returns null for unparseable input', () => {
    expect(parseNodeMajor('not-a-version')).toBeNull()
    expect(parseNodeMajor('20.11.1')).toBeNull() // no leading v
    expect(parseNodeMajor('')).toBeNull()
  })

  it('minimum is documented as v20', () => {
    // Guard against accidental downgrade of the floor.
    expect(MIN_NODE_MAJOR).toBeGreaterThanOrEqual(20)
  })
})

describe('release-check: formatReleaseReport', () => {
  it('renders green banner when every check passes', () => {
    const out = formatReleaseReport([
      { name: 'migrations', ok: true, summary: 'clean' },
      { name: 'git', ok: true, summary: 'clean' },
      { name: 'node', ok: true, summary: 'v20.11.1 ≥ v20' },
    ])
    expect(out).toContain('[ok]')
    expect(out).not.toContain('[FAIL]')
    expect(out).toContain('3/3 checks passed')
    expect(out).toContain('RESULT: green')
  })

  it('renders red banner with DO NOT deploy on any failure', () => {
    const out = formatReleaseReport([
      { name: 'migrations', ok: false, summary: 'drift: 1 unregistered', detail: '  - 099_foo' },
      { name: 'git', ok: true, summary: 'clean' },
    ])
    expect(out).toContain('[FAIL]')
    expect(out).toContain('1/2 checks passed')
    expect(out).toContain('RESULT: red')
    expect(out).toContain('DO NOT deploy')
  })

  it('emits per-failure detail block under the summary table', () => {
    const out = formatReleaseReport([
      { name: 'migrations', ok: false, summary: 'drift', detail: '  - 099_foo\n  - 100_bar' },
    ])
    expect(out).toContain('Failure detail:')
    expect(out).toContain('- 099_foo')
    expect(out).toContain('- 100_bar')
  })

  it('pads check names so the table is aligned', () => {
    const out = formatReleaseReport([
      { name: 'a', ok: true, summary: 'short' },
      { name: 'loooong', ok: true, summary: 'long' },
    ])
    // The short name should get padded to the column width implied by
    // the longer name; verify by counting the distance between the
    // marker and the summary, which should be the same on both lines.
    const lines = out.split('\n').filter((l) => l.includes('[ok]'))
    expect(lines.length).toBe(2)
    // Both lines should have the same "[ok]   <name>   <summary>" structure.
    // A simple proxy: the index of the summary text is the same column.
    const idxA = lines[0].indexOf('short')
    const idxB = lines[1].indexOf('long')
    expect(idxA).toBe(idxB)
  })

  it('never includes "god admin" (iron rule 5 belt + braces)', () => {
    const out = formatReleaseReport([
      { name: 'migrations', ok: false, summary: 'drift', detail: 'leak test' },
    ])
    expect(out.toLowerCase()).not.toContain('god admin')
    expect(out.toLowerCase()).not.toContain('god-admin')
  })
})
