# Phase Smoke Matrix (Phase 11 PR2)

Every merged PR that ships a per-phase smoke adds a file named
`scripts/smoke-phaseN-prM.ts` to the repo. As of Phase 11 there are 32+
of them. Running each one by hand is not practical and the manual list
silently rots.

This file is the runbook for `scripts/ops/smoke-matrix.ts` — the
orchestrator that discovers every per-phase smoke, runs them
sequentially against a live DB, diffs the pass/fail outcomes against a
committed baseline, and fails the gate on regressions.

Designed to be the **second gate** the release runbook runs, right
after `release-check.ts` (see `docs/ops/release-checklist.md`). It is
also the nightly CI regression catcher — one red cell anywhere across
the matrix should page on-call.

## Golden path

```bash
# From a clean master checkout on server 2 (192.168.1.30):
git checkout master && git pull origin master

# 1. Discover-only (no DB needed) — sanity check the file list.
npx tsx scripts/ops/smoke-matrix.ts --dry-run

# 2. Full matrix run. Live DB AND Redis required — some Phase 5
#    (discounts / checkout) smokes call through the Redis-backed
#    distributed-lock helper; without REDIS_URL they fail with
#    "Checkout not found" at a point unrelated to their own logic.
DATABASE_URL=postgresql://gbox:GboxPlatform2026@192.168.1.13:5432/gbox_platform \
REDIS_URL=redis://:GboxRedis2026@192.168.1.13:6379/0 \
  npx tsx scripts/ops/smoke-matrix.ts

# 3. If you need to run one phase's worth of smokes in isolation:
DATABASE_URL=... REDIS_URL=... npx tsx scripts/ops/smoke-matrix.ts --only phase9
```

> **Env prerequisites — don't skip.** `DATABASE_URL` is required for
> every smoke. `REDIS_URL` is required for Phase 5 PR1–PR5 (discount /
> checkout smokes) and Phase 7 storefront smokes. Leaving it unset
> masquerades as a smoke-logic failure — see **Troubleshooting** below
> for the `Checkout not found` / `ECONNREFUSED 6379` fingerprints.
> Do not pipe the output through `| head`/`| tail` — piped exit codes
> under bash lose the inner command's status and make the matrix
> report green even when regressions fail the gate. Use `--only` +
> the report file instead.

Exit codes:

| Exit | Meaning |
|-----:|---------|
| 0 | No regressions — every smoke the baseline marks `expectedPass=true` went green. |
| 1 | At least one expected-pass smoke ran red. See the `[REGRESSION]` block in the report. |
| 2 | Bad CLI args (e.g. `--only garbage`). |

Unexpected-pass smokes (baseline says expected-fail, run went green) and
missing-from-baseline smokes (new file not yet in the JSON) are treated
as **INFO** — they print, they do not fail the gate.

## CLI flags

| Flag | Effect |
|------|--------|
| `--dry-run` | Discover + list only. No smokes executed. Exits 0 on discovery success. |
| `--update-baseline` | After the run (or, with `--dry-run`, after discovery), rewrite `scripts/ops/smoke-baseline.json` from the current discovery. Preserves any hand-annotated `expectedPass=false` + `note` rows. Drops entries whose file has been deleted. |
| `--only phaseN` | Filter to a single phase. Accepts `phase9` or just `9`. |
| `--timeout-ms <n>` | Per-smoke timeout. Defaults to `120000` (2 min). |

## Baseline file

`scripts/ops/smoke-baseline.json` is the committed source of truth for
which smokes are expected to pass. Shape:

```json
{
  "updatedAt": "2026-04-21T12:52:36.562Z",
  "entries": [
    { "name": "smoke-phase11-pr1", "expectedPass": true },
    { "name": "smoke-phase9-pr4",  "expectedPass": false,
      "note": "skipped — DATABASE_URL unset on CI" }
  ]
}
```

Rules:

- **Every on-disk `smoke-phaseN-prM.ts` must have a row.** The PR2
  smoke (`smoke-phase11-pr2.ts`) asserts this — you cannot land a new
  per-phase smoke without refreshing the baseline.
- **Default is `expectedPass: true`.** The contract is that every
  landed smoke is green. Marking one expected-fail requires an explicit
  human decision.
- **Hand-annotated `expectedPass=false` + `note` entries are
  preserved** across `--update-baseline` runs. Only the `updatedAt`
  field and the set of rows (add new / drop deleted) churn
  automatically.

### Refreshing the baseline

After adding a new `scripts/smoke-phaseN-prM.ts` file:

```bash
# Fast path: no DB needed, just sync the row set from disk.
npx tsx scripts/ops/smoke-matrix.ts --dry-run --update-baseline

# Full path: run the matrix first, then refresh.
DATABASE_URL=... npx tsx scripts/ops/smoke-matrix.ts --update-baseline
```

Then commit the diff in `scripts/ops/smoke-baseline.json` together with
the new smoke file.

### Marking a smoke as known-red

Sometimes a smoke requires infra the CI box doesn't have (e.g. a cron
worker, a specific feature flag, a second Postgres). Rather than
deleting the smoke or letting it fail the gate forever, hand-edit the
baseline:

```json
{ "name": "smoke-phaseX-prY", "expectedPass": false,
  "note": "requires Redis cluster — run manually on server 2" }
```

The matrix report will now list that smoke as `[INFO] unexpected pass`
if it flips green, which is the signal to remove the override.

## Integration with the release pipeline

```
                  release-check.ts         (Phase 11 PR1 — preflight)
                        │
                        ▼
                  smoke-all.ts             (Phase 6.5 — live health)
                        │
                        ▼
                  smoke-matrix.ts          (Phase 11 PR2 — per-phase regression)
                        │
                        ▼
                  deploy-production.sh     (Phase 6.5 — blue-green)
```

All three `ops` scripts are read-only and idempotent — safe to re-run
any number of times.

## What is **not** covered

- **End-to-end happy path** (login → add product → checkout → order).
  The per-phase smokes each cover a slice, but the chain is not stitched
  together into one flow yet. Ship when the slice count justifies it.
- **Load / perf / soak tests.** Out of scope for the regression matrix
  — those belong in a dedicated `scripts/ops/perf-*.ts` family when
  traffic ramps.
- **Staging environment.** MEMORY `staging_tf_blocker.md` — `envs/staging`
  never applied because the shared Cloudflare zone with prod blocks
  apply until a dedicated staging zone exists. For now the
  "staging ≈ live" proxy is `gbox_platform` on server 2 (port 4321).

## Troubleshooting

**`[REGRESSION] N smoke(s) failed that the baseline expected to pass`**
A previously-green smoke went red. Treat this as a release blocker —
the regression report names the exact file. Reproduce locally with:
`DATABASE_URL=... npx tsx scripts/smoke-phaseN-prM.ts`

**`[INFO] N smoke(s) ran but aren't in baseline`**
You added a new smoke but didn't refresh the baseline. Run
`npx tsx scripts/ops/smoke-matrix.ts --dry-run --update-baseline` and
commit the JSON diff.

**`[INFO] N baseline entr(y/ies) had no matching run`**
Either you ran with `--only phaseN` (expected — the other phases are
filtered out) or the file was deleted without removing its baseline
row. If the latter, refresh the baseline.

**`signal SIGTERM` in a row's note**
The smoke ran past `--timeout-ms`. Either raise the timeout or
investigate the slowdown. Most Phase 4..11 smokes finish in under 10
seconds; a timeout usually means the DB is saturated or locked.

**`Error: Checkout not found` / `ECONNREFUSED 127.0.0.1:6379` in a
Phase 5 smoke row**
Redis was unreachable. Phase 5 checkout smokes go through
`@gbox/core/modules/discounts` which holds a short-lived Redis lock
during `applyDiscount`. Without Redis the lock helper short-circuits
and the checkout row never persists, so the next assertion explodes
with a generic "not found". Export `REDIS_URL=redis://:GboxRedis2026@192.168.1.13:6379/0`
before rerunning.

**Template-key mismatch in Phase 14 PR2/PR4 (`got 0 rows` / `missing key`)**
The DB registry is out of sync with the in-code catalog. Re-run the
idempotent seeder from a machine that has `DATABASE_URL`:
`DATABASE_URL=... npx tsx scripts/seed-email-registry.ts`. It is
UPSERT-safe; repeated runs are fine.

**`parseSmokeName` returns null for a file you just added**
The matrix ignores stems that don't match `smoke-phaseN[-M]-prP[-Q|X]`
where the optional numeric suffix (`pr1-5`) or alpha suffix (`pr4b`)
encode mid-PR follow-ups. If you need a different shape, extend the
regex in `packages/core/src/modules/ops/smoke-matrix.ts` instead of
fighting it — the sort-key math above depends on the two suffix forms.

## Iron rule 5 compliance

`formatMatrixReport` in `packages/core/src/modules/ops/smoke-matrix.ts`
is the single output surface for the matrix CLI. It is intended for
platform engineers (Thai + on-call) and is never surfaced to sellers.
The literal phrase `god admin` never appears anywhere in the
formatter output or in this doc — enforced by the regex guards in both
`smoke-matrix.test.ts` and `smoke-phase11-pr2.ts`.
