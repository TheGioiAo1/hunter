# Phase 02b — Sprint 2b: God Admin Caps (Q6)

**Date:** 2026-04-26 → 2026-04-27 (1 day)
**Priority:** MEDIUM (parallel với Sprint 1+3, không block)
**Branch:** `feat/v7-pr2b-god-admin-limits`
**Depends on:** None (standalone)

## Goal (Q6 — Thai locked 2026-04-26)

God Admin có quyền set 3 caps platform-wide qua existing platform-settings page:
1. `clone_pro_max_products_per_job` (default 5000) — hạn chế products mỗi clone job
2. `clone_pro_max_products_per_shop` (default 50000) — cumulative cap qua nhiều lần re-clone
3. `clone_pro_max_concurrent_jobs` (default 3) — hạn chế concurrent clone jobs platform-wide

API `POST /clone-pro/start` enforce caps:
- Seller request `products_limit > max_per_job` → tự động cap về max + log warning + trả `cap_applied` field
- Shop existing products + new > max_per_shop → 429 `limit_exceeded` (Iron Rule 5: safeMessage seller-facing)
- Active clone jobs ≥ max_concurrent → 429 `limit_exceeded`

## Existing Infrastructure

✅ **`platform_settings` table** đã có (migration 010)
✅ **`PLATFORM_SETTING_DEFS` array** ở `packages/core/src/modules/platform-config/definitions.ts`
   — comment: "Adding a 12th is a one-line append here — the admin UI, the service layer,
   and the tests all pick it up automatically"
✅ **God-admin platform settings UI** đã có (apps/god-admin/)
✅ **`PlatformConfigService`** đã có (`packages/core/src/modules/platform-config/`)

→ Chỉ cần APPEND 3 setting + thêm enforcement helper + wire vào API route.

## Files

```
packages/core/src/modules/platform-config/
└── definitions.ts                   # MODIFY: append 3 clone_pro_* settings

packages/core/src/modules/clone-pro/v7/limits/
├── god-admin-limits.ts              # NEW: helper enforce caps
└── god-admin-limits.test.ts         # NEW: 12+ unit tests

packages/api-platform/src/routes/clone-pro/
└── start.ts                         # MODIFY: call enforceGodAdminCaps() trước khi insert job

packages/core/src/modules/platform-config/
└── definitions.test.ts              # MODIFY: assert 15 settings (12+3) thay 12

scripts/
└── smoke-clone-pro-v7-pr2b.ts       # Live smoke test cap enforcement
```

## Tasks

- [ ] **2b.1** Append 3 clone_pro_* setting definitions

```typescript
// definitions.ts — append to PLATFORM_SETTING_DEFS array
{
  key: 'clone_pro_max_products_per_job',
  category: 'Clone Pro',  // new category
  kind: 'number',
  label: 'Max products per clone job',
  help: 'Hard cap on how many products a single clone job can crawl. Sellers requesting more will be silently capped to this value. Default: 5000.',
  default: 5000,
  validate: (v: number) => {
    if (!Number.isInteger(v) || v < 1) return 'Must be positive integer.'
    if (v > 100000) return 'Cap above 100,000 may exhaust S3 storage budget.'
    return null
  },
} satisfies PlatformSettingDef<number>,
{
  key: 'clone_pro_max_products_per_shop',
  category: 'Clone Pro',
  kind: 'number',
  label: 'Max products per shop (cumulative)',
  help: 'Total products a shop can hold across all clone jobs. Re-cloning above this limit is rejected. Default: 50000.',
  default: 50000,
  validate: (v: number) => {
    if (!Number.isInteger(v) || v < 1) return 'Must be positive integer.'
    if (v > 1000000) return 'Cap above 1M will hit DB row-count limits.'
    return null
  },
} satisfies PlatformSettingDef<number>,
{
  key: 'clone_pro_max_concurrent_jobs',
  category: 'Clone Pro',
  kind: 'number',
  label: 'Max concurrent clone jobs (platform-wide)',
  help: 'How many clone jobs can run simultaneously across all sellers. Higher = faster throughput but more AI/S3 cost burst. Default: 3.',
  default: 3,
  validate: (v: number) => {
    if (!Number.isInteger(v) || v < 1) return 'Must be positive integer.'
    if (v > 20) return 'Above 20 concurrent will exceed Anthropic rate limits.'
    return null
  },
} satisfies PlatformSettingDef<number>,
```

Update `definitions.test.ts`:
```typescript
expect(PLATFORM_SETTING_DEFS.length).toBe(15)  // was 12, now 15
```

Commit: `feat(v7-pr2b): add 3 clone_pro_* god-admin platform settings`

- [ ] **2b.2** Create `god-admin-limits.ts` helper

```typescript
import type { Kysely } from 'kysely'
import { PlatformConfigService } from '../../platform-config/service.js'
import { safeMessage } from '../../support/safe-message.js'

export interface CapResult {
  effective_limit: number
  cap_applied: { requested: number | null; capped_to: number; reason: string } | null
}

export class CloneProLimitExceededError extends Error {
  constructor(public reason: string) {
    super(safeMessage(new Error(reason)).safe)
  }
}

export async function enforceGodAdminCaps(opts: {
  db: Kysely<any>
  shopId: string
  requestedLimit: number | null
  configService: PlatformConfigService
}): Promise<CapResult> {
  const settings = await opts.configService.getAll()
  const maxPerJob = settings.clone_pro_max_products_per_job ?? 5000
  const maxPerShop = settings.clone_pro_max_products_per_shop ?? 50000
  const maxConcurrent = settings.clone_pro_max_concurrent_jobs ?? 3

  // Check concurrent jobs platform-wide
  const activeJobs = await opts.db
    .selectFrom('storefront_clone_jobs')
    .select(opts.db.fn.count<number>('id').as('cnt'))
    .where('status', 'in', ['queued', 'running'])
    .executeTakeFirstOrThrow()
  if (Number(activeJobs.cnt) >= maxConcurrent) {
    throw new CloneProLimitExceededError('max_concurrent_jobs_reached')
  }

  // Check shop cumulative product count
  const shopProducts = await opts.db
    .selectFrom('products')
    .select(opts.db.fn.count<number>('id').as('cnt'))
    .where('shop_id', '=', opts.shopId)
    .where('archived', '=', false)
    .executeTakeFirstOrThrow()
  const projected = Number(shopProducts.cnt) + (opts.requestedLimit ?? maxPerJob)
  if (projected > maxPerShop) {
    throw new CloneProLimitExceededError('max_per_shop_would_exceed')
  }

  // Cap requestedLimit to maxPerJob
  if (opts.requestedLimit === null || opts.requestedLimit > maxPerJob) {
    return {
      effective_limit: maxPerJob,
      cap_applied: {
        requested: opts.requestedLimit,
        capped_to: maxPerJob,
        reason: 'god_admin_max_per_job',
      },
    }
  }
  return { effective_limit: opts.requestedLimit, cap_applied: null }
}
```

Test: 12+ unit cases (mock DB):
- requested null → cap to maxPerJob
- requested > maxPerJob → cap
- requested <= maxPerJob → pass through
- shop existing + new > maxPerShop → throw
- active jobs >= maxConcurrent → throw
- defaults applied when settings missing
- god admin set custom values
- safeMessage Iron Rule 5

Commit: `feat(v7-pr2b): god-admin-limits helper + 12 unit tests`

- [ ] **2b.3** Wire vào API `POST /clone-pro/start`

```typescript
// packages/api-platform/src/routes/clone-pro/start.ts
import { enforceGodAdminCaps, CloneProLimitExceededError } from '@gbox/core/modules/clone-pro/v7/limits/god-admin-limits.js'

// Inside handler, after existing AI check, before job insert:
let capResult
try {
  capResult = await enforceGodAdminCaps({
    db, shopId, requestedLimit: body.products_limit, configService,
  })
} catch (e) {
  if (e instanceof CloneProLimitExceededError) {
    return reply.code(429).send({ error: 'limit_exceeded', message: safeMessage(e).safe })
  }
  throw e
}

// Insert job with effective_limit
await db.insertInto('storefront_clone_jobs').values({
  ...,
  products_limit: capResult.effective_limit,
}).execute()

return reply.code(200).send({
  ok: true,
  job_id,
  estimated: { ... },
  ...(capResult.cap_applied && { cap_applied: capResult.cap_applied }),
})
```

Test: 5+ integration cases
Commit: `feat(v7-pr2b): /clone-pro/start enforces god-admin caps + 429 on exceed`

- [ ] **2b.4** Live smoke test

```typescript
// scripts/smoke-clone-pro-v7-pr2b.ts
// Setup: seed god_admin user, set clone_pro_max_products_per_job = 100 (low for test)
// Test 1: seller request limit = 50 → ok, no cap
// Test 2: seller request limit = 500 → ok, capped to 100, cap_applied returned
// Test 3: seller request limit = null → ok, capped to 100
// Test 4: pre-fill 90 products in shop, max_per_shop = 100, request limit = 50 → 429
// Test 5: spawn 4 concurrent jobs (max_concurrent = 3) → 4th returns 429
// Cleanup
```

Commit: `test(v7-pr2b): smoke god-admin caps live DB pass`

## Acceptance Criteria

- [ ] 15 settings (12 existing + 3 new) trong god-admin UI dropdown
- [ ] 12+ unit tests pass
- [ ] 5+ integration smoke tests pass
- [ ] God Admin có thể edit 3 caps qua existing settings page (no UI work needed)
- [ ] PR `feat/v7-pr2b-god-admin-limits` merged vào base branch

## Iron Rule 5

- 429 response message = `safeMessage(error).safe` = "Please contact Gbox support."
- KHÔNG leak chi tiết max value, KHÔNG leak path `/god-admin/...`
- Internal log (server-side pino) có thể detail (max=5000, requested=10000)

## Risk

- Race condition: 2 concurrent /start cùng lúc đều under max_concurrent → both pass check.
  Mitigation: SERIALIZABLE tx wrap check + insert job (đã có `withSerializable` từ Phase 15)
- Thay default cap > prod traffic spike. Mitigation: defaults conservative (5000/50000/3),
  Thai có thể nâng nếu cần qua UI

## Next: Sprint 2b standalone, không block Sprint 2/4/5
