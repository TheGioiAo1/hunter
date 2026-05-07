# Legacy smoke archive

This directory holds **20 legacy smoke scripts** that were moved out of
`scripts/` on 2026-04-21 as part of the Phase 11 post-audit cleanup.

## Why they were archived

These files predate the `smoke-phaseN-prM.ts` naming convention and the
`scripts/ops/smoke-matrix.ts` orchestrator. They were written during the
early template-rendering + i18n + storage spikes and cover behaviour that
has since been:

- Absorbed into the template / rendering packages' own unit test suites
  (`packages/storefront-*`, `packages/i18n`, `packages/storage`), or
- Covered by the newer phase-style smokes (`smoke-phase7-pr*.ts`), or
- Orphaned — the "step" numbers referred to a throw-away plan document
  that no longer matches the current architecture.

Because the matrix discovers tests via `fs.readdirSync('scripts/')`
(non-recursive, `startsWith('smoke-') && endsWith('.ts')`), moving them
here removes them from the matrix without touching the baseline. The
baseline (`scripts/ops/smoke-baseline.json`) never listed any of these
files, so nothing regressed — they were already outside the gate.

## What's in here

```
smoke-http-step-1-20.ts        (1 file)
smoke-i18n-step-1-2b.ts        (1 file)
smoke-liquid-step-1-{4..17}.ts (14 files)
smoke-liquidjs-step-1-2.ts     (1 file)
smoke-loader-step-1-3.ts       (1 file)
smoke-storage-step-1-2a.ts     (1 file)
smoke-thankyou.ts              (1 file — Phase-7 "Step 2.6" orphan)
                                -----
                               20 files
```

## How to resurrect one

If you ever need the behaviour one of these scripts covered:

1. **Prefer** writing a new test in the relevant package's `*.test.ts`
   suite — these are run on every `npm test` and picked up by CI.
2. **If** you genuinely need it as a phase smoke (runs out-of-process,
   needs a live DB, cross-module integration), copy the file back to
   `scripts/` and **rename** it to `smoke-phaseN-prM.ts` to match the
   matrix's discovery convention. Then add an entry to
   `scripts/ops/smoke-baseline.json` and run:

   ```bash
   npx tsx scripts/ops/smoke-matrix.ts --dry-run
   npx tsx scripts/ops/smoke-matrix.ts --update-baseline
   ```

3. **Do not** resurrect by just moving the file back under its old
   `*-step-*` name — it will be picked up by the matrix as an
   "unexpected pass / missing from baseline" row and leave the gate
   in an ambiguous state.

## History

- 2026-04-21 — Phase 11 post-audit cleanup moved these here via
  `git mv` so history is preserved. See commit message and the
  post-audit PR for context.
