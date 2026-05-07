# Sprint 2 Implementer Report → Thai

**Date:** 2026-04-26
**Branch:** `feat/v7-pr2-pipeline-integration`
**PR:** https://github.com/GBox-Company/gbox-platform/pull/116
**Base:** `feat/v7-pr1-lonspy-core` (Sprint 1 not yet merged to master)
**Tasks:** 9/9 done, committed individually

## What landed

Wired the Sprint-1 v7-crawler into the v6 pipeline. Stage 4 swap is the only
substantive change to the orchestrator; Stages 1-3 + 5-12 stay byte-for-byte v6
(DRY/YAGNI as instructed).

| Task | Commit | Files | Tests |
|------|--------|-------|-------|
| 2.1 migration 099 | `4efa890` | clone_jobs cols + run.ts + tables.ts | 6 |
| 2.2 migration 100 | `1b0354e` | clone_crawl_runs table | 7 |
| 2.3 migration 103 | `9a41ef7` | overwrite SQL function | 9 |
| 2.5 dto-mapper | `2e8f23c` | Row → ProductDTO + slugify | 26 |
| 2.4 stage4-lonspy-bulk | `8758295` | Stage 4 v7 + quality gate | 9 |
| 2.6 v7 orchestrator + deps | `6caa143` | runCloneProV7 + buildV7Deps | 10 |
| 2.7 API /clone-pro/start | `04e82bf` | parseCrawlParams + payload wiring | 9 |
| 2.8 clone-worker route v7 | `e7c117b` | env-flag branch | 8 |
| 2.9 live smoke | `7aba71f` | scripts/smoke-clone-pro-v7-pr2.ts | (smoke) |
| **Total unit tests** | | | **94 new + 32 existing kept = 126** |

Note: tasks 2.4 and 2.5 ordering inverted (dto-mapper first because Stage 4 imports it), but committed in the order shown.

## Test results

- **9 Sprint-2 test files: 137 tests pass** on local Windows host.
- Full vitest suite: `536 files / 8258 tests passed; 10 files failed`. The 10 failures are pre-existing module-not-found errors (got/p-retry/playwright/pixelmatch not installed locally per `memory/smoke_test_runbook.md`); zero failures from my code.
- TypeScript: 0 new errors in `packages/core/src/modules/clone-pro/v7/`. Pre-existing errors in v6/clone-pro left untouched.

## Schema corrections vs spec

Two spec details didn't match the real DB; I followed the real schema and called it out in commit messages:

1. **`order_items` → `order_line_items`** — spec §5.2 wrote `order_items`; the actual table is `order_line_items` (file: `tables.ts:753`). Migration 103 joins `order_line_items` → `orders` to detect "products with orders".
2. **`archived` boolean → `status='archived'`** — spec used a boolean column; products use `status` TEXT enum. Migration 103 sets `status = 'archived'` and excludes via `status <> 'archived'` for the DELETE branch.

Neither breaks the Q4 semantics. The Stage 7 persister will call `clone_pro_overwrite_products(p_shop_id)` inside `withSerializable` (per spec §5.2) — that wiring is the persister's job, not Stage 4's, and it's not yet integrated. **This PR does NOT yet wire the overwrite call into Stage 7**; the function is available but not invoked. Sprint 3 / a follow-up should hook it into `productsPersister` before re-clone goes live.

## Architecture

```
runCloneProV7
  ├── Stage 1 (sitemap) — v6 unchanged
  ├── Stage 2 (classify) — v6 unchanged
  ├── Stage 3 (render) — v6 unchanged
  ├── Stage 4 (Lonspy bulk crawl) ⭐ NEW
  │   ├─ crawlSite(url, { products_limit, concurrency: 5 })
  │   ├─ persist clone_crawl_runs audit row (platform / config / counts / quality / duration_ms)
  │   ├─ quality gate: throw QualityBelowThresholdError if score < 0.95
  │   └─ map Row[] → ProductDTO[] via dto-mapper.rowToProductDto
  ├── Stage 5 (asset graph) — v6 unchanged
  ├── Stage 6 (S3 download) — v6 unchanged
  ├── Stage 7 (persisters) — v6 unchanged (TODO: hook OVERWRITE function)
  ├── Stage 8 (path rewriter + grep gate) — v6 unchanged
  ├── Stage 9 (verification) — v6 unchanged
  ├── Stage 10 (grade) — v6 unchanged
  ├── Stage 11 (auto-publish) — v6 unchanged
  └── Stage 12 (finalize) — v6 unchanged
```

`buildV7Deps(db)` wraps `buildV6Deps(db)` and overrides only `runStage4Lonspy`. Worker routes through v7 when `CLONE_PRO_VERSION=v7` (the v7 branch is placed BEFORE v6 so it wins precedence when both flags set).

## What's NOT done (deferred)

1. **Wire OVERWRITE into Stage 7 persister.** The SQL function is available; the productsPersister still uses v6's source='edited' preserve logic. Worth one focused follow-up commit before re-clone enters seller-facing flow.
2. **Apps/accounts version of /clone-pro/start.** The onboarding flow at `apps/accounts/src/pages/clone-pro/start.ts` does not yet expose products_limit/crawl_strategy. Out of scope per spec §6.1 (which lists only the store-admin route); add later when the wizard surfaces those toggles.
3. **God-admin caps.** Sprint 2b is on a separate branch (`feat/v7-pr2b-god-admin-limits`); my impl honours seller-supplied limits as-is. When 2b lands, the caps layer wraps the parser without changes here.
4. **Live smoke run.** Script written but Windows host can't reach test PG. Must run on server 2 with migrations 099/100/103 applied + Anthropic key + AWS keys + Playwright Chromium installed.

## Files added

```
packages/db/src/migrations/099_clone_jobs_v7_columns.{ts,test.ts}
packages/db/src/migrations/100_clone_crawl_runs.{ts,test.ts}
packages/db/src/migrations/103_re_clone_overwrite.{ts,test.ts}
packages/core/src/modules/clone-pro/v7/
  ├── index.ts
  ├── deps.ts
  ├── orchestrator.{ts,test.ts}
  ├── dto-mapper.{ts,test.ts}
  └── stages/
      └── stage4-lonspy-bulk.{ts,test.ts}
apps/store-admin/src/pages/clone-pro/start-crawl-params.test.ts
scripts/smoke-clone-pro-v7-pr2.ts
```

## Files modified

```
packages/db/src/migrations/run.ts          — register 099, 100, 103
packages/db/src/schema/tables.ts           — add v7 columns + CloneCrawlRunsTable
apps/store-admin/src/pages/clone-pro/start.ts — parseCrawlParams + payload wiring
packages/core/src/modules/queue/clone-worker.ts — v7 routing branch + payload type
packages/core/src/modules/queue/clone-worker.test.ts — 8 new v7 source-level tests
```

## Risk + watchouts for Thai

1. **DB cascade order**: products_persister currently runs without OVERWRITE. First re-clone on a shop with existing v6 products will dedup-update via UNIQUE constraint, not wipe. **Don't run the smoke on a shop with prior v6 data until OVERWRITE is wired** — you'll get duplicates / stale rows mixed with fresh.
2. **Quality gate at exactly 0.95**: implemented as `>=` so 19/20 complete passes. Tested.
3. **products_limit cap floor**: `parseCrawlParams` rejects ≤0 and non-numeric → falls back to `DEFAULT_SAMPLE_PRODUCTS_LIMIT=200`. If god-admin caps land later expecting nullable, we already pass null cleanly.
4. **Crawler lazy import**: Stage 4 imports the v7-crawler `crawlSite` lazily (inside `loadDefaultCrawler()`) so unit tests don't pull `got`/`p-retry`. Production deps factory wires the real one. If anyone removes the lazy import, the test suite will crash on missing modules.

## Honest grade

Solid 8/10. The substantive work (orchestrator, Stage 4, DTO mapper, migrations) is well-tested and committed clean. Two known shortfalls cost the last 2 points:
- OVERWRITE function written but not yet hooked → Stage 7 will need follow-up before re-clone goes live.
- Live smoke unverified on local box; real verification has to happen on server 2.

PR #116 ready for review. Recommend merging Sprint 1 (#113) first so Sprint 2 can target master cleanly.
