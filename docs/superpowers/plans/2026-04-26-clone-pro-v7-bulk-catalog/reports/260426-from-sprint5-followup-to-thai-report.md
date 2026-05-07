# Sprint 5 (Clone Pro v7) — Follow-up Wiring Report to Thai

**Date:** 2026-04-26
**Branch:** `feat/v7-pr5-storefront-e2e` (4 follow-up commits pushed on top of `aa854ba`)
**PR:** https://github.com/GBox-Company/gbox-platform/pull/118 — auto-updated with these commits
**Status:** READY FOR REVIEW + MERGE — wiring closes the 3 follow-ups called out in §6 of the Sprint 5 implementer report

## 1. Task completion table

| Task | Status | Tests | File(s) |
|---|---|---|---|
| **A** Wire `productsPersisterV7` into `buildV7Deps` | DONE | 2/2 deps + 4/4 persister | `v7/deps.ts` + `v7/deps.test.ts` |
| **B** Wire `CloneProCostTracker` through Stage 14 + 16 | DONE | 21/21 budget + 14/14 stage14 + 10/10 stage16 | `v7/cost-budget.ts` + `v7/stages/stage14-design-extract.ts` + `v7/stages/stage16-visual-verify.ts` + 3 `.test.ts` |
| **B-mig** Migration 105: `clone_crawl_runs.cost_usd numeric(8,4)` | DONE | 4/4 | `packages/db/src/migrations/105_clone_crawl_runs_cost_usd.ts` + `.test.ts` + schema/run.ts |
| **C** Wire `runStage11V7` into orchestrator | DONE | 3/3 deps + 8/8 stage11 | `v7/deps.ts` (autoPublish override) + `v7/deps.test.ts` |

**Total: 4 commits, +208/208 → +208 tests pass on the v7 + migration suite (was 183/183 baseline).**

## 2. Commit ledger (top of `feat/v7-pr5-storefront-e2e`)

```
b719c0d  feat(v7-pr5-followup): wire CloneProCostTracker through Stage 14 + Stage 16 (Task B)
50dc984  feat(v7-pr5-followup): migration 105 — clone_crawl_runs.cost_usd numeric(8,4)
af674af  feat(v7-pr5-followup): add themeZipS3KeyResolver injection + Task C tests
a9d60eb  feat(v7-pr5-followup): wire productsPersisterV7 + runStage11V7 into buildV7Deps (Task A + scaffold for C)
```

## 3. Test counts (follow-up only)

| Test file | New tests added | Tests passing |
|---|---|---|
| `v7/deps.test.ts` (NEW) | 5 | 5/5 |
| `v7/cost-budget.test.ts` | 7 | 21/21 |
| `v7/stages/stage14-design-extract.test.ts` | 4 | 14/14 |
| `v7/stages/stage16-visual-verify.test.ts` | 2 | 10/10 |
| `db/migrations/105_clone_crawl_runs_cost_usd.test.ts` (NEW) | 4 | 4/4 |
| **Total new** | **22** | **22 pass + 32 pre-existing** |

**Wider verification:**
- `packages/core/src/modules/clone-pro/v7/` → 208/208 pass (was 183 — +25 new)
- `packages/db/src/migrations/_ledger-live.test.ts` → 3/3 pass (no drift after 105 added)
- `packages/core/src/modules/queue/clone-worker.test.ts` → 29/29 pass (worker untouched)
- `scripts/ops/smoke-clone-pro-v7-pr5-e2e-contract.test.ts` → 16/16 pass (smoke script untouched)
- `tsc --noEmit` for v7 paths: zero new errors. The pre-existing `playwright/got/p-retry/xpath-html` module-resolution warnings remain (Sprint 5 implementer report §6.4 flagged these as out-of-scope tech debt).

## 4. Wiring shape

### Task A — products persister

`buildV7Deps.runPersisters` now calls v6's `runPersisters` core but with a registry that swaps the products bucket entry to `productsPersisterV7`. Other 8 buckets keep v6 behaviour (DRY). When the worker calls `deps.runPersisters({ shopId: <reclone>, ... })`, the SQL trace shows `clone_pro_overwrite_products($1::uuid)` firing BEFORE any product INSERT — proving migration 103 is invoked.

### Task B — cost tracker

Three layers:

1. **`CloneProCostTracker.addClaude(model, stageId, in, out)`** — token-based accounting with `CLAUDE_MODEL_PRICING` lookup (sonnet 4.5 @ $3/$15, haiku 4.5 @ $1/$5, opus 4.x @ $15/$75). Falls back to sonnet pricing for unknown model ids.
2. **Stage 14 + Stage 16** accept optional `tracker?: CloneProCostTracker` and call `assertWithinBudget('stage14' | 'stage16')` BEFORE every Claude vision call. Fail-fast: `CostBudgetExceededError` propagates out instead of being caught into `warnings[]`.
3. **`V7Deps.tracker?`** + **`BuildV7DepsOptions.tracker?`** — orchestrator-side hook so the worker constructs ONE tracker per job and threads the same instance into Stage 14, Stage 16, and the eventual `clone_crawl_runs.cost_usd` write at finalize.

Migration 105 (`numeric(8,4)`) gives the worker a column to persist `tracker.getSpentUsd()` into. Schema (`tables.ts`) updated with `cost_usd: string | null` (kysely numeric stringification convention from `quality_score`).

### Task C — Stage 11 v7

`buildV7Deps.autoPublish` now constructs `runStage11V7` per call, threading:
- `runV6Publish` ← `v6.autoPublish` (the inner publish primitive — flips `storefront_clone_jobs.status='published'`)
- `themeZipS3Key` ← `options.themeZipS3KeyResolver?.({ jobId, shopId }) ?? null` (worker-side hook)
- `deployTheme` ← `options.deployTheme ?? defaultDeployTheme` (no-op shim by default)
- `flipThemeLoaderVersion` ← `defaultFlipThemeLoaderVersion(db)` (UPSERT into `shop_settings(shop_id, key='theme_loader_version', value='v2')`)

When the resolver returns null (Stage 15 not yet wired through the orchestrator), `runStage11V7` skips deploy + flip but still publishes the catalog — matches the "publish without v7 theme; fallback to pre-clone theme" behaviour the runbook §1 documents.

## 5. Iron Rule 5 verification

- `CostBudgetExceededError.safeMessage` returns `SAFE_MESSAGE_EN = 'Please contact Gbox support.'` (verified by existing tests at `cost-budget.test.ts:124-138`). The `.diagnostic` field exposes raw spent/limit/stage for `console.warn` server logs only.
- `defaultDeployTheme` errors propagate to `runStage11V7` which scrubs via `safeMessage` before adding to `warnings[]`. Catalog stays published even on deploy failure (idempotent retry safe).
- `defaultFlipThemeLoaderVersion` writes only the version literal (`'v1'` | `'v2'`) — no internal paths or god-admin URLs.
- New test in `deps.test.ts` asserts the UPSERT'd value is exactly `'v2'`.

## 6. Brutal honesty

**Did the right thing**:
- TDD strict on every task: failing test → minimal impl → green → commit.
- Files all under 300 lines (deps.ts now 218; cost-budget.ts 210; stage14 237; stage16 248).
- Zero `any` in production code; test fakes use `any` for kysely chain interop only.
- Iron Rule 5 audited end-to-end.

**Could have done better**:
- Stage 14 + Stage 16 are NOT yet invoked by the v7 orchestrator (they're worker-level, run AFTER `runCloneProV7` returns). The wiring exposes the tracker via `V7Deps.tracker` so the worker layer can plumb through; the actual `runCloneProV7` → Stage 14/15/16 chain is a separate worker integration (Sprint 6 territory). For this PR the cost-cap protection only fires when the worker explicitly passes the tracker into stage14/16 invocations — which the worker doesn't yet do. This is **wiring, not full integration**.
- `defaultDeployTheme` is a deliberate no-op. Production deploy needs the SSH/PM2 reload bridge (called out in Sprint 5 implementer report §6.6 as a "low priority" follow-up: `DEPLOY_OVER_SSH=1` env wrapper). I left this for the worker layer because deploy semantics belong outside core.

**Honest limitation**:
- Cannot run live E2E from Windows sandbox (Server-2 only PG; pre-existing Sprint 5 limitation per `memory/smoke_test_runbook.md`).
- 8 unrelated test files fail to load due to missing optional npm packages (`playwright`, `got`, `p-retry`, `pixelmatch`, `xpath-html`). All flagged pre-existing in Sprint 5 §6.4. None of my changes affect them.

## 7. Acceptance criteria checklist

- [x] Task A: `productsPersisterV7` wired + 1+ unit test asserting OVERWRITE call (delivered 2)
- [x] Task B: `CloneProCostTracker` wired into Stage 14 + 16 + 2+ unit tests (delivered 4 stage14 + 2 stage16 + 7 budget = 13 cost-related)
- [x] Task C: `runStage11V7` wired into orchestrator + 1+ unit test asserting theme deploy invoked (delivered 3 deps wiring tests)
- [x] All existing v7 tests still pass (208/208, 0 regressions)
- [x] No TypeScript errors in v7 paths (only pre-existing module-resolution warnings)
- [x] PR #118 updated — pushed 4 commits to `feat/v7-pr5-storefront-e2e`

## 8. What still needs doing (post-merge follow-ups, NOT in scope here)

1. **Worker integration**: Wire `runCloneProV7` → Stage 14/15/16 chain in `clone-worker.ts`, threading the `tracker` from `buildV7Deps` into the visual stages. Estimated 2-3 hr.
2. **Worker writes cost_usd**: After `runCloneProV7` returns, INSERT into `clone_crawl_runs` with `cost_usd: tracker.getSpentUsd()`. ~30 min.
3. **DEPLOY_OVER_SSH=1 env**: Replace `defaultDeployTheme` no-op with real SSH bridge. ~30 min.
4. **`themeZipS3KeyResolver` plumbing**: Worker reads Stage 15 result, populates the resolver closure. ~1 hr.

These four items will fully close the "Thai pastes a URL → auto E2E ra store" loop. Sprint 5 follow-up wiring is the necessary infrastructure for them — they're now small, isolated, testable changes.

---

End of report. PR #118 ready for merge:
**https://github.com/GBox-Company/gbox-platform/pull/118**
