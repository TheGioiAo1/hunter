# Release Checklist (Phase 11 PR1)

Phase 11 is the deploy-gate phase. This file is the **canonical
pre-flight checklist** the release bot walks before calling any of the
scripts in `scripts/deploy/` (which actually touch production — nginx
swap, cert renewal, blue-green drain).

The golden path is:

```bash
# From a clean master checkout:
git checkout master && git pull origin master

# 1. Run the release-check orchestrator. Exits 0 iff every gate is green.
npx tsx scripts/ops/release-check.ts

# 2. Run the unified smoke (health endpoints + pg + redis).
#    Pass SMOKE_HOST to target server 1, or leave unset for localhost.
SMOKE_HOST=192.168.1.13 npx tsx scripts/ops/smoke-all.ts

# 3. Only if both went 0 → run the deploy.
bash scripts/deploy/deploy-production.sh
```

If any step exits non-zero, **do not proceed**. The release-check and
smoke-all scripts are designed to be safe to re-run any number of times
— they are read-only.

## What `release-check.ts` covers

| Check | What it verifies | Why |
|------|------------------|------|
| `migrations` | Every file in `packages/db/src/migrations/NNN_*.ts` is both imported at the top of `run.ts` AND registered in the `migrations[]` array. No orphans either direction. | The `run.ts` list is hand-maintained — drift has silently bitten us multiple times (see Phase 9 PR1 + PR2 drain logs: "0 applied, 69 skipped" with no mention of the new file). |
| `git` | `git status --porcelain --untracked-files=no` is empty. | Releasing from a dirty working tree means the commit being deployed is not the commit in `HEAD`. Untracked files are tolerated because the repo carries a pile of them. |
| `node` | `process.version` major ≥ `MIN_NODE_MAJOR` (20 as of Phase 11). | Matches the CI pin and the minimum the monorepo's tsx loader supports. |

## What `smoke-all.ts` covers (already shipped in Phase 6.5)

| Probe | Endpoint | Expected |
|-------|----------|---------:|
| api | `http://<host>:4321/_health` | 200 + `status:ok` |
| admin | `http://<host>:4325/_health` | 200 + `status:ok` |
| accounts | `http://<host>:4323/_health` | 200 + `status:ok` |
| storefront | `http://<host>:4326/_health` | 200 + `status:ok` |
| checkout | `http://<host>:4327/_health` | 200 + `status:ok` |
| supporter | `http://<host>:4328/healthz` | 200 + `ok` (Phase 12.5) — set `SMOKE_SKIP_SUPPORTER=1` on legacy boxes. |
| pg | `SELECT 1 FROM shops LIMIT 1` | no error |
| redis | `PING` | `PONG` |

## What is **not** covered here

These are out of scope for the preflight — ship them as dedicated
smokes when the surface grows enough to justify it:

- Per-phase feature smokes (`scripts/smoke-phaseN-prM.ts`). There are
  30+ of these. Phase 11 PR2 will wrap them in a single orchestrator
  (`scripts/ops/smoke-matrix.ts`) that runs them all and emits a
  baseline JSON.
- End-to-end happy-path (login → add product → checkout → order). The
  existing `tests/*.test.ts` live-smoke files cover pieces of this but
  the chain isn't stitched together yet.
- Staging deploy gate. MEMORY `staging_tf_blocker.md` — `envs/staging`
  never applied because the shared Cloudflare zone with prod blocks
  apply until a dedicated staging zone exists. Rerun `release-check`
  on server 1 against `gbox_platform` as the "staging ≈ live" proxy
  for now.

## Troubleshooting

**`[FAIL] migrations — drift: N unregistered`**
A new migration file was added to `packages/db/src/migrations/` but the
`migrations[]` array in `run.ts` was not updated. Fix: add both the
`import { up as upNNN } from "./NNN_name.ts"` line AND the
`{ name: "NNN_name", fn: upNNN }` row in the array. The failure detail
block in the release-check output lists the specific names.

**`[FAIL] git — N uncommitted change(s)`**
The working tree has modifications to tracked files. Either commit them
(if they belong in the release) or `git stash` them (if they're
scratch).

**`[FAIL] node — vXX < v20`**
The running node is too old. Use `nvm use 22` or the equivalent on your
box. This is a soft floor — the code may work on older versions but CI
does not test them.

## Iron rule 5 compliance

All output of `release-check.ts` + `smoke-all.ts` is intended to be
read by platform engineers (Thai + on-call). None of it is surfaced to
sellers. The formatters never emit the literal phrase `god admin` or
the path `/god-admin/*`. This is covered by the regex guards in both
`migration-ledger.test.ts` and `release-check.test.ts`.
