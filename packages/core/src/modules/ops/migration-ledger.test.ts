/**
 * Gbox Platform — Migration Ledger Drift Detector tests (Phase 11 PR1)
 *
 * Covers the three drift branches we care about:
 *   - file on disk but not in migrations[] array      (silent-skip bug)
 *   - imported at top but not in migrations[] array   (forgot-the-row bug)
 *   - name in migrations[] but no file on disk         (stale-registration bug)
 */

import { describe, it, expect } from 'vitest'
import {
  analyseLedger,
  DEFAULT_ACCEPTED_COLLISIONS,
  detectUnacceptedCollisions,
  extractImportedNames,
  extractRegisteredNames,
  formatLedgerReport,
} from './migration-ledger.ts'

// A synthetic run.ts shell — deliberately tiny so the test reads as
// "here's the exact shape the parser needs to cope with" rather than a
// copy of the real file.
const RUN_TS_HAPPY = `
import { up as up001 } from "./001_initial.ts";
import { up as up072 } from "./072_phase10_perf_indexes.ts";

const migrations = [
  { name: "001_initial", fn: up001 },
  { name: "072_phase10_perf_indexes", fn: up072 },
];
`

describe('migration-ledger: extractRegisteredNames', () => {
  it('picks up basic double-quoted names', () => {
    expect(extractRegisteredNames(RUN_TS_HAPPY)).toEqual([
      '001_initial',
      '072_phase10_perf_indexes',
    ])
  })

  it('accepts single quotes and extra whitespace', () => {
    const src = `
      { name: '054_variant_deep_fields', fn: up054 },
      {  name:   "055_customer_segments",   fn: up055  },
    `
    expect(extractRegisteredNames(src)).toEqual([
      '054_variant_deep_fields',
      '055_customer_segments',
    ])
  })

  it('returns empty array when no matches', () => {
    expect(extractRegisteredNames('// no migrations here')).toEqual([])
  })

  it('ignores name: keys on unrelated objects (still matches since we only care about name:"NNN_...")', () => {
    // The regex is intentionally greedy on ANY `name: "..."` token, so
    // the caller (analyseLedger) is responsible for filtering by the
    // NNN_ stem pattern via diff vs filesOnDisk. Covered implicitly
    // in the happy-path analyse test below.
    const src = `{ name: "not_a_migration", fn: foo }`
    expect(extractRegisteredNames(src)).toEqual(['not_a_migration'])
  })
})

describe('migration-ledger: extractImportedNames', () => {
  it('extracts NNN_-prefixed imports', () => {
    expect(extractImportedNames(RUN_TS_HAPPY)).toEqual([
      '001_initial',
      '072_phase10_perf_indexes',
    ])
  })

  it('skips non-migration relative imports', () => {
    const src = `
      import { helpers } from "./helpers.ts";
      import { up as up001 } from "./001_initial.ts";
    `
    expect(extractImportedNames(src)).toEqual(['001_initial'])
  })

  it('accepts no-extension imports', () => {
    const src = `import { up as up005 } from "./005_performance_indexes";`
    expect(extractImportedNames(src)).toEqual(['005_performance_indexes'])
  })
})

describe('migration-ledger: analyseLedger', () => {
  it('clean state — every file is registered and every registration has a file', () => {
    const r = analyseLedger({
      filesOnDisk: ['001_initial', '072_phase10_perf_indexes'],
      runTsSource: RUN_TS_HAPPY,
    })
    expect(r.isClean).toBe(true)
    expect(r.missingRegistrations).toEqual([])
    expect(r.importedButNotInArray).toEqual([])
    expect(r.orphanedRegistrations).toEqual([])
  })

  it('detects missing registration (file on disk, no row in array)', () => {
    const r = analyseLedger({
      filesOnDisk: ['001_initial', '072_phase10_perf_indexes', '099_new_feature'],
      runTsSource: RUN_TS_HAPPY,
    })
    expect(r.isClean).toBe(false)
    expect(r.missingRegistrations).toEqual(['099_new_feature'])
  })

  it('detects import-without-row (imported but missing from migrations[])', () => {
    const src = `
      import { up as up001 } from "./001_initial.ts";
      import { up as up099 } from "./099_oops.ts";

      const migrations = [
        { name: "001_initial", fn: up001 },
      ];
    `
    const r = analyseLedger({
      filesOnDisk: ['001_initial', '099_oops'],
      runTsSource: src,
    })
    expect(r.isClean).toBe(false)
    expect(r.importedButNotInArray).toEqual(['099_oops'])
  })

  it('detects orphaned registration (name in array, no file on disk)', () => {
    const r = analyseLedger({
      filesOnDisk: ['001_initial'],
      runTsSource: RUN_TS_HAPPY,
    })
    expect(r.isClean).toBe(false)
    expect(r.orphanedRegistrations).toEqual(['072_phase10_perf_indexes'])
  })

  it('handles all three drift types simultaneously', () => {
    const src = `
      import { up as up001 } from "./001_initial.ts";
      import { up as up099 } from "./099_forgot_row.ts";

      const migrations = [
        { name: "001_initial", fn: up001 },
        { name: "888_ghost", fn: upGhost },
      ];
    `
    const r = analyseLedger({
      filesOnDisk: ['001_initial', '099_forgot_row', '777_unregistered'],
      runTsSource: src,
    })
    expect(r.isClean).toBe(false)
    expect(r.missingRegistrations).toEqual(['099_forgot_row', '777_unregistered'])
    expect(r.importedButNotInArray).toEqual(['099_forgot_row'])
    expect(r.orphanedRegistrations).toEqual(['888_ghost'])
  })

  it('output is sorted deterministically', () => {
    const r = analyseLedger({
      filesOnDisk: ['099_c', '001_a', '050_b'],
      runTsSource: '',
    })
    expect(r.filesOnDisk).toEqual(['001_a', '050_b', '099_c'])
    expect(r.missingRegistrations).toEqual(['001_a', '050_b', '099_c'])
  })
})

describe('migration-ledger: detectUnacceptedCollisions', () => {
  it('returns empty array on a collision-free list', () => {
    expect(
      detectUnacceptedCollisions(['001_initial', '072_phase10_perf_indexes'], new Set()),
    ).toEqual([])
  })

  it('flags both files in an unaccepted NNN collision', () => {
    const offenders = detectUnacceptedCollisions(
      ['100_feature_a', '100_feature_b', '101_unrelated'],
      new Set(),
    )
    expect(offenders).toEqual(['100_feature_a', '100_feature_b'])
  })

  it('does not flag files inside the accepted set', () => {
    const accepted = new Set(['100_feature_a', '100_feature_b'])
    expect(
      detectUnacceptedCollisions(['100_feature_a', '100_feature_b'], accepted),
    ).toEqual([])
  })

  it('flags only the unaccepted sibling in a partially-accepted cluster', () => {
    // Someone accepted 100_feature_a but a new 100_feature_c landed;
    // only the new one should fail.
    const accepted = new Set(['100_feature_a', '100_feature_b'])
    const offenders = detectUnacceptedCollisions(
      ['100_feature_a', '100_feature_b', '100_feature_c'],
      accepted,
    )
    expect(offenders).toEqual(['100_feature_c'])
  })

  it('ignores files that do not match the NNN_ prefix', () => {
    expect(
      detectUnacceptedCollisions(['not_a_migration', 'README', '001_initial'], new Set()),
    ).toEqual([])
  })

  it('covers the known-good 053-056 cluster via DEFAULT_ACCEPTED_COLLISIONS', () => {
    // Sanity: every file we put in the default allowlist must share
    // an NNN with at least one other file in the allowlist (else the
    // entry is pointless — no collision to accept).
    const byPrefix = new Map<string, number>()
    for (const f of DEFAULT_ACCEPTED_COLLISIONS) {
      const p = f.slice(0, 3)
      byPrefix.set(p, (byPrefix.get(p) ?? 0) + 1)
    }
    for (const [prefix, count] of byPrefix) {
      expect(count, `prefix ${prefix} should collide`).toBeGreaterThan(1)
    }
    // And the allowlist is NOT flagged when passed through the detector.
    expect(
      detectUnacceptedCollisions(
        [...DEFAULT_ACCEPTED_COLLISIONS],
        new Set(DEFAULT_ACCEPTED_COLLISIONS),
      ),
    ).toEqual([])
  })
})

describe('migration-ledger: analyseLedger — collision branch', () => {
  it('treats the accepted 053-056 cluster as clean (collision-wise)', () => {
    // Happy run.ts + files: imports + array rows for every cluster member.
    const clusterFiles = [...DEFAULT_ACCEPTED_COLLISIONS]
    const imports = clusterFiles
      .map((f, i) => `import { up as up${i} } from "./${f}.ts";`)
      .join('\n')
    const rows = clusterFiles
      .map((f, i) => `  { name: "${f}", fn: up${i} },`)
      .join('\n')
    const src = `${imports}\nconst migrations = [\n${rows}\n];`

    const r = analyseLedger({
      filesOnDisk: clusterFiles,
      runTsSource: src,
    })
    expect(r.unacceptedCollisions).toEqual([])
    expect(r.isClean).toBe(true)
  })

  it('fails the drift check on a NEW collision outside the allowlist', () => {
    // 999_feature_a + 999_feature_b — fully registered, but not in the
    // allowlist: still drift, because the policy is "pick a fresh NNN".
    const src = `
      import { up as upA } from "./999_feature_a.ts";
      import { up as upB } from "./999_feature_b.ts";
      const migrations = [
        { name: "999_feature_a", fn: upA },
        { name: "999_feature_b", fn: upB },
      ];
    `
    const r = analyseLedger({
      filesOnDisk: ['999_feature_a', '999_feature_b'],
      runTsSource: src,
    })
    expect(r.isClean).toBe(false)
    expect(r.unacceptedCollisions).toEqual(['999_feature_a', '999_feature_b'])
    // But not a "missing registration" or "orphaned" drift — those are
    // distinct branches.
    expect(r.missingRegistrations).toEqual([])
    expect(r.orphanedRegistrations).toEqual([])
  })

  it('respects a caller-supplied override of acceptedCollisions', () => {
    const r = analyseLedger({
      filesOnDisk: ['999_feature_a', '999_feature_b'],
      runTsSource: `
        import { up as upA } from "./999_feature_a.ts";
        import { up as upB } from "./999_feature_b.ts";
        const migrations = [
          { name: "999_feature_a", fn: upA },
          { name: "999_feature_b", fn: upB },
        ];
      `,
      acceptedCollisions: ['999_feature_a', '999_feature_b'],
    })
    expect(r.unacceptedCollisions).toEqual([])
    expect(r.isClean).toBe(true)
  })
})

describe('migration-ledger: formatLedgerReport', () => {
  it('renders [ok] line on clean ledger', () => {
    const out = formatLedgerReport(
      analyseLedger({
        filesOnDisk: ['001_initial', '072_phase10_perf_indexes'],
        runTsSource: RUN_TS_HAPPY,
      }),
    )
    expect(out).toContain('[ok] ledger clean')
    expect(out).not.toContain('[DRIFT]')
  })

  it('renders a collision drift block when an unaccepted NNN clash is present', () => {
    const out = formatLedgerReport(
      analyseLedger({
        filesOnDisk: ['999_feature_a', '999_feature_b'],
        runTsSource: `
          import { up as upA } from "./999_feature_a.ts";
          import { up as upB } from "./999_feature_b.ts";
          const migrations = [
            { name: "999_feature_a", fn: upA },
            { name: "999_feature_b", fn: upB },
          ];
        `,
      }),
    )
    expect(out).toContain('[DRIFT]')
    expect(out).toContain('collide on NNN prefix')
    expect(out).toContain('- 999_feature_a')
    expect(out).toContain('- 999_feature_b')
  })

  it('lists each drifted name on its own line', () => {
    const out = formatLedgerReport(
      analyseLedger({
        filesOnDisk: ['001_initial', '099_new'],
        runTsSource: RUN_TS_HAPPY,
      }),
    )
    expect(out).toContain('[DRIFT]')
    expect(out).toContain('- 099_new')
    expect(out).toContain('- 072_phase10_perf_indexes') // orphaned
  })

  it('never includes "god admin" (iron rule 5 belt + braces)', () => {
    const out = formatLedgerReport(
      analyseLedger({
        filesOnDisk: [],
        runTsSource: RUN_TS_HAPPY,
      }),
    )
    expect(out.toLowerCase()).not.toContain('god admin')
    expect(out.toLowerCase()).not.toContain('god-admin')
  })
})
