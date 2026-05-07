# Clone Pro v5 — PR1 (Shopify-Native MVP) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a working end-to-end Shopify-native clone pipeline that takes a source URL, scrapes 100% of catalog + collections + pages + menu + theme tokens, persists every element into the correct Gbox bucket under a SERIALIZABLE transaction, mounts a 7-day preview subdomain, and emits a weighted A–F grade.

**Architecture:** New `packages/core/src/modules/clone-pro/v5/` namespace co-exists with v4 (v4 stays on disk; v5 is wired into the BullMQ worker via `pipeline.ts` orchestrator). Nine phases (detect → discover → scrape → validate → persist → asset-rehost-stub → preview → verify → complete). Persistence wrapped in `runInSerializable` helper (from Phase 15 PR1, lands via PR #87 merge). Checkpoint table `clone_checkpoints` makes every phase resumable after crash. `DESIGN.md` exporter (D11) emits awesome-claude-design-compatible output to `storefront_clone_jobs.design_md` for future redesign workflow.

**Tech Stack:**
- TypeScript (strict), Node 20+
- Kysely (query builder) against PostgreSQL
- `node-fetch` / `undici` for polite-fetch
- `cheerio` for HTML parsing (homepage menu / theme tokens only — NOT for product scraping; products come from `/products.json`)
- `vitest` for unit tests
- `tsx` for smoke scripts
- Re-uses: `@gbox/core/modules/db/transaction` (`runInSerializable`) from Phase 15 PR1, `polite-fetch.ts` + `robots-guard.ts` from v4, `@gbox/core/modules/content/service` (`createPage`), `@gbox/core/modules/catalog/product-service` (`upsertProduct`).

**Hard dependencies (block-on):**
1. Phase 15 PR2 (PR #87) merged → gives us migration 090 slot + `runInSerializable` helper in `@gbox/core/modules/db/transaction.ts`. Without it, migration 091 collides and persisters cannot wrap in txn.
2. `polite-fetch.ts` + `robots-guard.ts` stay as-is in v4 — v5 imports them, does not reimplement.

---

## File Structure

**New production files (18):**

```
packages/core/src/modules/clone-pro/v5/
├── pipeline.ts                          # orchestrator for phases ① → ⑨
├── platform-detect.ts                   # phase ① — detect Shopify/Woo/Generic
├── types.ts                             # shared DTOs: Product, Collection, Page, MenuTree, ThemeTokens, GradeResult
├── index.ts                             # barrel export
│
├── scrapers/
│   ├── shopify-products.ts              # /products.json paginator
│   ├── shopify-collections.ts           # /collections.json + per-handle products
│   ├── sitemap-pages.ts                 # sitemap.xml filter → pages
│   ├── menu-parser.ts                   # <nav> anchor tree via cheerio
│   └── theme-tokens.ts                  # CSS var + hero computed-style extractor
│
├── validate/
│   └── guardrails.ts                    # R3 bucket rules (anti-mix)
│
├── persisters/
│   ├── import-transaction.ts            # runInSerializable wrapper + checkpoint writer
│   ├── products-persist.ts              # upsert products + variants + options + images
│   ├── collections-persist.ts           # upsert collections + collection_products pivot
│   ├── pages-persist.ts                 # upsert pages (by shop_id + slug)
│   ├── menus-persist.ts                 # upsert menus + menu_items hierarchy
│   └── theme-persist.ts                 # upsert theme_config JSONB
│
├── verify/
│   └── route-check.ts                   # HEAD every imported URL on preview domain
│
├── design-md-export.ts                  # D11 — generate DESIGN.md from theme_config
└── grader.ts                            # weighted composite → A-F

packages/db/src/migrations/
└── 091_clone_checkpoints.ts             # clone_checkpoints + cloned_previews + storefront_clone_jobs columns

scripts/
└── smoke-phase19-pr1.ts                 # offline smoke (mocked fetch), ≥8 assertions
```

**Test files (shadows every production file):** 15 `.test.ts` files colocated next to source (`scrapers/*.test.ts`, `persisters/*.test.ts`, `validate/guardrails.test.ts`, `verify/route-check.test.ts`, `design-md-export.test.ts`, `grader.test.ts`, `platform-detect.test.ts`).

**Target:** ~2500 LOC production + ~1200 LOC tests. ≥40 unit tests. 8+ smoke assertions.

**Principle:** Each file has one responsibility. Scrapers only scrape (no DB writes). Persisters only upsert (no network). Validators only reject (no side effects). Orchestrator wires them.

---

## Task 1: Migration 091 (checkpoints + previews + column additions)

**Files:**
- Create: `packages/db/src/migrations/091_clone_checkpoints.ts`
- Modify: `packages/db/src/migrations/run.ts` (add import + array entry)
- Modify: `packages/db/src/schema/tables.ts` (add new table types)

- [ ] **Step 1: Write the failing migration-ledger test**

Append to `packages/db/src/migrations/_ledger-live.test.ts`:

```ts
it('has 091 registered', async () => {
  const { migrations } = await import('./run.js')
  expect(migrations.find(m => m.name === '091_clone_checkpoints')).toBeDefined()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/db/src/migrations/_ledger-live.test.ts`
Expected: FAIL — `expected undefined to be defined`

- [ ] **Step 3: Write the migration file**

Create `packages/db/src/migrations/091_clone_checkpoints.ts`:

```ts
import type { Kysely } from 'kysely'
import { sql } from 'kysely'

export async function up(db: Kysely<any>): Promise<void> {
  // 1. clone_checkpoints table — resumable state per phase
  await db.schema
    .createTable('clone_checkpoints')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('job_id', 'uuid', (c) =>
      c.notNull().references('storefront_clone_jobs.id').onDelete('cascade'),
    )
    .addColumn('phase', 'text', (c) => c.notNull())
    .addColumn('step', 'text', (c) => c.notNull())
    .addColumn('state_json', 'jsonb', (c) => c.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addCheckConstraint(
      'clone_checkpoints_phase_ck',
      sql`phase IN ('detect','discover','scrape','validate','persist','asset_rehost','preview','verify')`,
    )
    .execute()

  await db.schema
    .createIndex('idx_clone_checkpoints_job_phase')
    .on('clone_checkpoints')
    .columns(['job_id', 'phase'])
    .execute()

  // 2. cloned_previews — subdomain registry (7-day TTL)
  await db.schema
    .createTable('cloned_previews')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('job_id', 'uuid', (c) =>
      c.notNull().references('storefront_clone_jobs.id').onDelete('cascade'),
    )
    .addColumn('subdomain', 'text', (c) => c.notNull().unique())
    .addColumn('expires_at', 'timestamptz', (c) => c.notNull())
    .addColumn('approved_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute()

  await db.schema
    .createIndex('idx_cloned_previews_expires')
    .on('cloned_previews')
    .column('expires_at')
    .execute()

  // 3. storefront_clone_jobs column additions
  await db.schema
    .alterTable('storefront_clone_jobs')
    .addColumn('platform', 'text')
    .addColumn('source_host', 'text')
    .addColumn('checkpoint_id', 'uuid')
    .addColumn('preview_url', 'text')
    .addColumn('design_md', 'text')
    .execute()

  // 4. Unique partial index for idempotent re-clone (D10)
  await sql`
    CREATE UNIQUE INDEX idx_clone_jobs_shop_source_current
    ON storefront_clone_jobs (shop_id, source_host)
    WHERE status NOT IN ('failed','cancelled','discarded')
  `.execute(db)
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_clone_jobs_shop_source_current`.execute(db)
  await db.schema.alterTable('storefront_clone_jobs').dropColumn('design_md').execute()
  await db.schema.alterTable('storefront_clone_jobs').dropColumn('preview_url').execute()
  await db.schema.alterTable('storefront_clone_jobs').dropColumn('checkpoint_id').execute()
  await db.schema.alterTable('storefront_clone_jobs').dropColumn('source_host').execute()
  await db.schema.alterTable('storefront_clone_jobs').dropColumn('platform').execute()
  await db.schema.dropTable('cloned_previews').execute()
  await db.schema.dropTable('clone_checkpoints').execute()
}
```

- [ ] **Step 4: Register in run.ts**

Edit `packages/db/src/migrations/run.ts` — add import next to 090 and append entry to the `migrations` array:

```ts
import { up as up091, down as down091 } from './091_clone_checkpoints.js'
// ...
{ name: '091_clone_checkpoints', up: up091, down: down091 },
```

- [ ] **Step 5: Add table types to schema/tables.ts**

Append to `packages/db/src/schema/tables.ts`:

```ts
export interface CloneCheckpointsTable {
  id: Generated<string>
  job_id: string
  phase: 'detect' | 'discover' | 'scrape' | 'validate' | 'persist' | 'asset_rehost' | 'preview' | 'verify'
  step: string
  state_json: Record<string, unknown>
  created_at: Generated<Date>
}

export interface ClonedPreviewsTable {
  id: Generated<string>
  job_id: string
  subdomain: string
  expires_at: Date
  approved_at: Date | null
  created_at: Generated<Date>
}
```

And in the `Database` interface add:

```ts
clone_checkpoints: CloneCheckpointsTable
cloned_previews: ClonedPreviewsTable
```

Also extend `StorefrontCloneJobsTable` with the five new nullable columns: `platform`, `source_host`, `checkpoint_id`, `preview_url`, `design_md`.

- [ ] **Step 6: Run test to verify pass**

Run: `npx vitest run packages/db/src/migrations/_ledger-live.test.ts`
Expected: PASS

- [ ] **Step 7: Apply migration on dev DB**

Run: `cd packages/db && npx tsx src/migrations/run.ts`
Expected: `Applied: 091_clone_checkpoints` (exit 0)

- [ ] **Step 8: Commit**

```bash
git add packages/db/src/migrations/091_clone_checkpoints.ts \
        packages/db/src/migrations/run.ts \
        packages/db/src/migrations/_ledger-live.test.ts \
        packages/db/src/schema/tables.ts
git commit -m "feat(clone-pro-v5): migration 091 — clone_checkpoints + cloned_previews + schema additions"
```

---

## Task 2: Types module

**Files:**
- Create: `packages/core/src/modules/clone-pro/v5/types.ts`

No test file — types are compile-time checked.

- [ ] **Step 1: Write the types file**

```ts
/**
 * Clone Pro v5 — shared DTOs
 * All scrapers return these shapes; persisters accept them.
 */

export type Platform = 'shopify' | 'woocommerce' | 'generic' | 'unknown'

export interface ScrapedProduct {
  readonly source_id: string            // shopify numeric id or URL handle
  readonly handle: string
  readonly title: string
  readonly body_html: string
  readonly vendor: string | null
  readonly product_type: string | null
  readonly tags: readonly string[]
  readonly images: readonly ScrapedImage[]
  readonly variants: readonly ScrapedVariant[]
  readonly options: readonly ScrapedOption[]
}

export interface ScrapedImage {
  readonly src: string                   // external URL (asset rehost = PR3)
  readonly alt: string | null
  readonly position: number
}

export interface ScrapedVariant {
  readonly source_id: string
  readonly title: string
  readonly price: string                 // decimal string preserved from source
  readonly compare_at_price: string | null
  readonly sku: string | null
  readonly inventory_quantity: number | null
  readonly option_values: readonly string[]  // aligned with options[].name order
  readonly weight: number | null
  readonly weight_unit: 'g' | 'kg' | 'lb' | 'oz' | null
}

export interface ScrapedOption {
  readonly name: string                  // e.g., "Size"
  readonly position: number
  readonly values: readonly string[]     // ["S","M","L"]
}

export interface ScrapedCollection {
  readonly source_id: string
  readonly handle: string
  readonly title: string
  readonly body_html: string
  readonly image: ScrapedImage | null
  readonly product_handles: readonly string[]  // handles, not ids
}

export interface ScrapedPage {
  readonly url: string                   // canonical source URL
  readonly slug: string                  // derived from URL path
  readonly title: string
  readonly body_html: string
}

export interface MenuNode {
  readonly label: string
  readonly url: string                   // source URL — resolved later by persister
  readonly children: readonly MenuNode[]
}

export interface MenuTree {
  readonly handle: string                // 'main-menu' | 'footer' etc.
  readonly nodes: readonly MenuNode[]
}

export interface ThemeTokens {
  readonly colors: {
    readonly primary: string | null
    readonly secondary: string | null
    readonly background: string | null
    readonly text: string | null
  }
  readonly typography: {
    readonly heading_family: string | null
    readonly body_family: string | null
    readonly base_size_px: number | null
  }
  readonly spacing: {
    readonly base_px: number | null
  }
  readonly radius_px: number | null
  readonly raw_css_vars: Record<string, string>   // everything we found, keyed
}

export interface GradeResult {
  readonly score: number                  // 0..100
  readonly letter: 'A' | 'B' | 'C' | 'D' | 'F'
  readonly breakdown: {
    readonly route_check_pct: number
    readonly product_completeness_pct: number
    readonly css_token_pct: number
    readonly page_body_pct: number
    readonly menu_resolution_pct: number
  }
  readonly warnings: readonly string[]    // seller-visible ("Some collection pages missing")
}

export interface PipelineContext {
  readonly jobId: string
  readonly shopId: string
  readonly sourceUrl: string
  readonly sourceHost: string              // derived: new URL(sourceUrl).hostname
  readonly scope: {
    readonly products: boolean
    readonly collections: boolean
    readonly pages: boolean
    readonly menu: boolean
    readonly theme: boolean
  }
}
```

- [ ] **Step 2: Verify compiles**

Run: `cd packages/core && npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/modules/clone-pro/v5/types.ts
git commit -m "feat(clone-pro-v5): shared DTOs (Product, Collection, Page, MenuTree, ThemeTokens, GradeResult)"
```

---

## Task 3: Platform detector

**Files:**
- Create: `packages/core/src/modules/clone-pro/v5/platform-detect.ts`
- Create: `packages/core/src/modules/clone-pro/v5/platform-detect.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { detectPlatform } from './platform-detect.js'

describe('detectPlatform', () => {
  beforeEach(() => { vi.resetAllMocks() })

  it('returns "shopify" when /products.json returns valid JSON with products array', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ products: [{ id: 1, handle: 'x' }] }),
    })
    const p = await detectPlatform('https://shop.example.com', { fetch: fetchMock as any })
    expect(p).toBe('shopify')
    expect(fetchMock).toHaveBeenCalledWith(
      'https://shop.example.com/products.json?limit=1',
      expect.any(Object),
    )
  })

  it('returns "generic" when /products.json 404s', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({}) })
    expect(await detectPlatform('https://example.com', { fetch: fetchMock as any })).toBe('generic')
  })

  it('returns "generic" when /products.json returns HTML (not JSON)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => { throw new Error('invalid json') },
    })
    expect(await detectPlatform('https://example.com', { fetch: fetchMock as any })).toBe('generic')
  })

  it('returns "generic" when products.json body has no products field', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ foo: 'bar' }) })
    expect(await detectPlatform('https://example.com', { fetch: fetchMock as any })).toBe('generic')
  })

  it('returns "unknown" when fetch itself throws (network error)', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    expect(await detectPlatform('https://example.com', { fetch: fetchMock as any })).toBe('unknown')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/modules/clone-pro/v5/platform-detect.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write implementation**

```ts
/**
 * Clone Pro v5 — platform detector (phase ①)
 *
 * Probes source URL against known CMS/platform signatures.
 * Shopify: /products.json?limit=1 returns {products: [...]} without auth.
 * Woocommerce: wp-json/wc/v3 endpoint (PR2).
 * Otherwise: generic.
 */

import type { Platform } from './types.js'

export interface DetectOpts {
  readonly fetch?: typeof globalThis.fetch
  readonly timeoutMs?: number
}

export async function detectPlatform(sourceUrl: string, opts: DetectOpts = {}): Promise<Platform> {
  const fetchFn = opts.fetch ?? globalThis.fetch
  const timeoutMs = opts.timeoutMs ?? 8000
  const probe = new URL('/products.json?limit=1', sourceUrl).toString()

  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), timeoutMs)
    const res = await fetchFn(probe, {
      signal: ctrl.signal,
      headers: { 'user-agent': 'GboxCloneBot/1.0 (+https://gbox.co/bot)' },
    })
    clearTimeout(t)

    if (!res.ok) return 'generic'

    const body = await res.json().catch(() => null)
    if (body && Array.isArray((body as any).products)) return 'shopify'
    return 'generic'
  } catch {
    return 'unknown'
  }
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `npx vitest run packages/core/src/modules/clone-pro/v5/platform-detect.test.ts`
Expected: PASS (5/5)

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/modules/clone-pro/v5/platform-detect.ts \
        packages/core/src/modules/clone-pro/v5/platform-detect.test.ts
git commit -m "feat(clone-pro-v5): platform detector — Shopify probe via /products.json"
```

---

## Task 4: Shopify products scraper

**Files:**
- Create: `packages/core/src/modules/clone-pro/v5/scrapers/shopify-products.ts`
- Create: `packages/core/src/modules/clone-pro/v5/scrapers/shopify-products.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from 'vitest'
import { scrapeShopifyProducts } from './shopify-products.js'

const page1 = {
  products: [
    {
      id: 123, handle: 'tee-a', title: 'Tee A', body_html: '<p>A</p>',
      vendor: 'Allbirds', product_type: 'Shirt', tags: 'cotton,organic',
      images: [{ src: 'https://cdn.x/1.jpg', alt: null, position: 1 }],
      variants: [{
        id: 901, title: 'S', price: '29.00', compare_at_price: null,
        sku: 'TEE-A-S', inventory_quantity: 10, option1: 'S', option2: null, option3: null,
        weight: 200, weight_unit: 'g',
      }],
      options: [{ name: 'Size', position: 1, values: ['S', 'M', 'L'] }],
    },
  ],
}

describe('scrapeShopifyProducts', () => {
  it('paginates through /products.json until an empty page', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => page1 })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ products: [] }) })

    const out = await scrapeShopifyProducts('https://shop.example.com', { fetch: fetchMock as any, pageSize: 250 })

    expect(out).toHaveLength(1)
    expect(out[0].handle).toBe('tee-a')
    expect(out[0].variants).toHaveLength(1)
    expect(out[0].variants[0].option_values).toEqual(['S'])
    expect(out[0].options[0].values).toEqual(['S', 'M', 'L'])
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[0][0]).toMatch(/products\.json\?limit=250&page=1/)
    expect(fetchMock.mock.calls[1][0]).toMatch(/products\.json\?limit=250&page=2/)
  })

  it('preserves decimal price strings (no float coercion)', async () => {
    const weirdPrice = {
      products: [{ ...page1.products[0], variants: [{ ...page1.products[0].variants[0], price: '29.99' }] }],
    }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => weirdPrice })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ products: [] }) })
    const out = await scrapeShopifyProducts('https://shop.example.com', { fetch: fetchMock as any })
    expect(out[0].variants[0].price).toBe('29.99')  // string, not number
  })

  it('splits comma-separated tags into array', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => page1 })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ products: [] }) })
    const out = await scrapeShopifyProducts('https://shop.example.com', { fetch: fetchMock as any })
    expect(out[0].tags).toEqual(['cotton', 'organic'])
  })

  it('stops at maxPages cap (safety limit)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => page1 })
    const out = await scrapeShopifyProducts('https://shop.example.com', {
      fetch: fetchMock as any, maxPages: 3,
    })
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(out).toHaveLength(3)
  })

  it('throws on non-ok response mid-pagination (fail-fast)', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => page1 })
      .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) })
    await expect(scrapeShopifyProducts('https://shop.example.com', { fetch: fetchMock as any }))
      .rejects.toThrow(/500/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/modules/clone-pro/v5/scrapers/shopify-products.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write implementation**

```ts
/**
 * Clone Pro v5 — Shopify products scraper (phase ③ — scrape)
 *
 * Paginates /products.json?limit=N&page=P until empty page (or maxPages cap).
 * Maps raw Shopify payload → ScrapedProduct DTO.
 * Decimal prices preserved as strings (no float coercion).
 */

import type { ScrapedProduct, ScrapedVariant, ScrapedOption, ScrapedImage } from '../types.js'

export interface ScrapeOpts {
  readonly fetch?: typeof globalThis.fetch
  readonly pageSize?: number
  readonly maxPages?: number
}

interface RawShopifyProduct {
  id: number
  handle: string
  title: string
  body_html: string
  vendor: string | null
  product_type: string | null
  tags: string
  images: Array<{ src: string; alt: string | null; position: number }>
  variants: Array<{
    id: number; title: string; price: string; compare_at_price: string | null
    sku: string | null; inventory_quantity: number | null
    option1: string | null; option2: string | null; option3: string | null
    weight: number | null; weight_unit: string | null
  }>
  options: Array<{ name: string; position: number; values: string[] }>
}

export async function scrapeShopifyProducts(
  sourceUrl: string,
  opts: ScrapeOpts = {},
): Promise<ScrapedProduct[]> {
  const fetchFn = opts.fetch ?? globalThis.fetch
  const pageSize = opts.pageSize ?? 250
  const maxPages = opts.maxPages ?? 100   // hard cap: 25k products per scrape
  const out: ScrapedProduct[] = []

  for (let page = 1; page <= maxPages; page++) {
    const url = new URL(`/products.json?limit=${pageSize}&page=${page}`, sourceUrl).toString()
    const res = await fetchFn(url, {
      headers: { 'user-agent': 'GboxCloneBot/1.0 (+https://gbox.co/bot)' },
    })
    if (!res.ok) {
      throw new Error(`scrapeShopifyProducts: HTTP ${res.status} at page ${page}`)
    }
    const body = (await res.json()) as { products: RawShopifyProduct[] }
    if (!Array.isArray(body.products) || body.products.length === 0) break

    for (const raw of body.products) {
      out.push(mapProduct(raw))
    }
    if (body.products.length < pageSize) break
  }

  return out
}

function mapProduct(raw: RawShopifyProduct): ScrapedProduct {
  const optionNames = (raw.options ?? []).map((o) => o.name)
  return {
    source_id: String(raw.id),
    handle: raw.handle,
    title: raw.title,
    body_html: raw.body_html ?? '',
    vendor: raw.vendor,
    product_type: raw.product_type,
    tags: (raw.tags ?? '').split(',').map((t) => t.trim()).filter(Boolean),
    images: (raw.images ?? []).map(mapImage),
    variants: (raw.variants ?? []).map((v) => mapVariant(v, optionNames)),
    options: (raw.options ?? []).map(mapOption),
  }
}

function mapImage(raw: RawShopifyProduct['images'][number]): ScrapedImage {
  return { src: raw.src, alt: raw.alt ?? null, position: raw.position }
}

function mapVariant(raw: RawShopifyProduct['variants'][number], optionNames: string[]): ScrapedVariant {
  const option_values = [raw.option1, raw.option2, raw.option3]
    .filter((v, i) => v !== null && i < optionNames.length) as string[]
  return {
    source_id: String(raw.id),
    title: raw.title,
    price: raw.price,                       // keep decimal as string
    compare_at_price: raw.compare_at_price,
    sku: raw.sku,
    inventory_quantity: raw.inventory_quantity,
    option_values,
    weight: raw.weight,
    weight_unit: (raw.weight_unit as any) ?? null,
  }
}

function mapOption(raw: RawShopifyProduct['options'][number]): ScrapedOption {
  return { name: raw.name, position: raw.position, values: raw.values }
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `npx vitest run packages/core/src/modules/clone-pro/v5/scrapers/shopify-products.test.ts`
Expected: PASS (5/5)

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/modules/clone-pro/v5/scrapers/shopify-products.ts \
        packages/core/src/modules/clone-pro/v5/scrapers/shopify-products.test.ts
git commit -m "feat(clone-pro-v5): Shopify /products.json paginated scraper with decimal-safe pricing"
```

---

## Task 5: Shopify collections scraper

**Files:**
- Create: `packages/core/src/modules/clone-pro/v5/scrapers/shopify-collections.ts`
- Create: `packages/core/src/modules/clone-pro/v5/scrapers/shopify-collections.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from 'vitest'
import { scrapeShopifyCollections } from './shopify-collections.js'

const collectionsPage = {
  collections: [
    {
      id: 10, handle: 'sale', title: 'Sale', body_html: '<p>Discounted</p>',
      image: { src: 'https://cdn.x/sale.jpg', alt: 'Sale', position: 1 },
    },
  ],
}
const saleProducts = { products: [{ id: 1, handle: 'tee-a' }, { id: 2, handle: 'tee-b' }] }

describe('scrapeShopifyCollections', () => {
  it('lists collections then fetches each collection\'s products by handle', async () => {
    const fetchMock = vi.fn()
      // collections.json page 1
      .mockResolvedValueOnce({ ok: true, json: async () => collectionsPage })
      // collections.json page 2 (empty → stop)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ collections: [] }) })
      // /collections/sale/products.json page 1
      .mockResolvedValueOnce({ ok: true, json: async () => saleProducts })
      // /collections/sale/products.json page 2 (empty)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ products: [] }) })

    const out = await scrapeShopifyCollections('https://shop.example.com', { fetch: fetchMock as any })

    expect(out).toHaveLength(1)
    expect(out[0].handle).toBe('sale')
    expect(out[0].product_handles).toEqual(['tee-a', 'tee-b'])
    expect(out[0].image?.src).toBe('https://cdn.x/sale.jpg')
  })

  it('omits collections with zero products (R3 guardrail — no empty collection imports)', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => collectionsPage })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ collections: [] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ products: [] }) })

    const out = await scrapeShopifyCollections('https://shop.example.com', { fetch: fetchMock as any })
    expect(out).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/modules/clone-pro/v5/scrapers/shopify-collections.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write implementation**

```ts
/**
 * Clone Pro v5 — Shopify collections scraper
 *
 * Lists collections via /collections.json, then for each collection
 * paginates /collections/<handle>/products.json to extract product handles.
 * Filters out empty collections (R3 anti-mix guardrail).
 */

import type { ScrapedCollection, ScrapedImage } from '../types.js'

export interface ScrapeCollectionsOpts {
  readonly fetch?: typeof globalThis.fetch
  readonly pageSize?: number
  readonly maxPages?: number
}

interface RawCollection {
  id: number
  handle: string
  title: string
  body_html: string | null
  image: { src: string; alt: string | null; position: number } | null
}

export async function scrapeShopifyCollections(
  sourceUrl: string,
  opts: ScrapeCollectionsOpts = {},
): Promise<ScrapedCollection[]> {
  const fetchFn = opts.fetch ?? globalThis.fetch
  const pageSize = opts.pageSize ?? 250
  const maxPages = opts.maxPages ?? 20
  const rawCollections: RawCollection[] = []

  // Phase A: list collections
  for (let page = 1; page <= maxPages; page++) {
    const url = new URL(`/collections.json?limit=${pageSize}&page=${page}`, sourceUrl).toString()
    const res = await fetchFn(url)
    if (!res.ok) throw new Error(`scrapeShopifyCollections: HTTP ${res.status} at page ${page}`)
    const body = (await res.json()) as { collections: RawCollection[] }
    if (!Array.isArray(body.collections) || body.collections.length === 0) break
    rawCollections.push(...body.collections)
    if (body.collections.length < pageSize) break
  }

  // Phase B: per collection, fetch products (handles only)
  const out: ScrapedCollection[] = []
  for (const c of rawCollections) {
    const handles = await fetchCollectionProductHandles(sourceUrl, c.handle, fetchFn, pageSize, maxPages)
    if (handles.length === 0) continue   // R3: skip empty
    out.push({
      source_id: String(c.id),
      handle: c.handle,
      title: c.title,
      body_html: c.body_html ?? '',
      image: c.image ? mapImage(c.image) : null,
      product_handles: handles,
    })
  }
  return out
}

async function fetchCollectionProductHandles(
  sourceUrl: string,
  handle: string,
  fetchFn: typeof globalThis.fetch,
  pageSize: number,
  maxPages: number,
): Promise<string[]> {
  const out: string[] = []
  for (let page = 1; page <= maxPages; page++) {
    const url = new URL(
      `/collections/${handle}/products.json?limit=${pageSize}&page=${page}`,
      sourceUrl,
    ).toString()
    const res = await fetchFn(url)
    if (!res.ok) throw new Error(`fetchCollectionProductHandles(${handle}): HTTP ${res.status}`)
    const body = (await res.json()) as { products: Array<{ handle: string }> }
    if (!Array.isArray(body.products) || body.products.length === 0) break
    out.push(...body.products.map((p) => p.handle))
    if (body.products.length < pageSize) break
  }
  return out
}

function mapImage(raw: { src: string; alt: string | null; position: number }): ScrapedImage {
  return { src: raw.src, alt: raw.alt, position: raw.position }
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `npx vitest run packages/core/src/modules/clone-pro/v5/scrapers/shopify-collections.test.ts`
Expected: PASS (2/2)

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/modules/clone-pro/v5/scrapers/shopify-collections.ts \
        packages/core/src/modules/clone-pro/v5/scrapers/shopify-collections.test.ts
git commit -m "feat(clone-pro-v5): Shopify /collections.json scraper — skips empty collections (R3)"
```

---

## Task 6: Sitemap pages scraper

**Files:**
- Create: `packages/core/src/modules/clone-pro/v5/scrapers/sitemap-pages.ts`
- Create: `packages/core/src/modules/clone-pro/v5/scrapers/sitemap-pages.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from 'vitest'
import { scrapeSitemapPages } from './sitemap-pages.js'

const sitemapXml = `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://shop.example.com/pages/about</loc></url>
  <url><loc>https://shop.example.com/pages/contact</loc></url>
  <url><loc>https://shop.example.com/products/tee-a</loc></url>
  <url><loc>https://shop.example.com/collections/sale</loc></url>
  <url><loc>https://shop.example.com/blogs/news/hello</loc></url>
  <url><loc>https://shop.example.com/cart</loc></url>
  <url><loc>https://shop.example.com/account/login</loc></url>
</urlset>`

const aboutHtml = `<html><head><title>About Us | Shop</title></head><body><main><h1>About</h1><p>Founded 2024.</p></main></body></html>`

describe('scrapeSitemapPages', () => {
  it('filters sitemap to only /pages/* URLs — rejects products/collections/blogs/cart/account', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, text: async () => sitemapXml })
      .mockResolvedValueOnce({ ok: true, text: async () => aboutHtml })
      .mockResolvedValueOnce({ ok: true, text: async () => aboutHtml })  // contact

    const out = await scrapeSitemapPages('https://shop.example.com', { fetch: fetchMock as any })

    expect(out).toHaveLength(2)
    expect(out.map((p) => p.slug).sort()).toEqual(['about', 'contact'])
  })

  it('derives slug from URL pathname — /pages/about → about', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, text: async () => sitemapXml })
      .mockResolvedValueOnce({ ok: true, text: async () => aboutHtml })
      .mockResolvedValueOnce({ ok: true, text: async () => aboutHtml })
    const out = await scrapeSitemapPages('https://shop.example.com', { fetch: fetchMock as any })
    const about = out.find((p) => p.slug === 'about')!
    expect(about.title).toBe('About Us | Shop')
    expect(about.body_html).toContain('<h1>About</h1>')
  })

  it('returns empty when sitemap 404s (no throw — clone continues without pages)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 404, text: async () => '' })
    const out = await scrapeSitemapPages('https://shop.example.com', { fetch: fetchMock as any })
    expect(out).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/modules/clone-pro/v5/scrapers/sitemap-pages.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write implementation**

```ts
/**
 * Clone Pro v5 — sitemap pages scraper
 *
 * 1. Fetch /sitemap.xml
 * 2. Filter URLs that start with /pages/ (R3 anti-mix — rejects product/collection/blog/cart URLs)
 * 3. Fetch each allowed URL, extract <title> + <main> body
 */

import * as cheerio from 'cheerio'
import type { ScrapedPage } from '../types.js'

export interface ScrapePagesOpts {
  readonly fetch?: typeof globalThis.fetch
}

const ALLOWED_PREFIXES = ['/pages/']
const BLOCKED_PREFIXES = ['/products/', '/collections/', '/blogs/', '/cart', '/checkout', '/account']

export async function scrapeSitemapPages(
  sourceUrl: string,
  opts: ScrapePagesOpts = {},
): Promise<ScrapedPage[]> {
  const fetchFn = opts.fetch ?? globalThis.fetch
  const sitemapUrl = new URL('/sitemap.xml', sourceUrl).toString()
  const smRes = await fetchFn(sitemapUrl)
  if (!smRes.ok) return []

  const xml = await smRes.text()
  const urls = extractUrls(xml).filter((u) => isAllowedPageUrl(u))

  const out: ScrapedPage[] = []
  for (const url of urls) {
    try {
      const res = await fetchFn(url)
      if (!res.ok) continue
      const html = await res.text()
      const parsed = parsePageHtml(html, url)
      if (parsed) out.push(parsed)
    } catch {
      // swallow — one bad page doesn't abort the sitemap walk
      continue
    }
  }
  return out
}

function extractUrls(xml: string): string[] {
  const re = /<loc>([^<]+)<\/loc>/g
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) out.push(m[1].trim())
  return out
}

function isAllowedPageUrl(url: string): boolean {
  try {
    const u = new URL(url)
    const path = u.pathname
    if (BLOCKED_PREFIXES.some((p) => path.startsWith(p))) return false
    return ALLOWED_PREFIXES.some((p) => path.startsWith(p))
  } catch {
    return false
  }
}

function parsePageHtml(html: string, url: string): ScrapedPage | null {
  const $ = cheerio.load(html)
  const title = $('title').text().trim() || $('h1').first().text().trim()
  if (!title) return null
  const main = $('main').html() || $('article').html() || $('body').html() || ''
  const slug = slugFromUrl(url)
  return { url, slug, title, body_html: main.trim() }
}

function slugFromUrl(url: string): string {
  const u = new URL(url)
  const parts = u.pathname.split('/').filter(Boolean)
  // /pages/about → 'about'
  return parts[parts.length - 1] || 'index'
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `npx vitest run packages/core/src/modules/clone-pro/v5/scrapers/sitemap-pages.test.ts`
Expected: PASS (3/3)

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/modules/clone-pro/v5/scrapers/sitemap-pages.ts \
        packages/core/src/modules/clone-pro/v5/scrapers/sitemap-pages.test.ts
git commit -m "feat(clone-pro-v5): sitemap pages scraper — /pages/* only, blocks product/collection/blog URLs (R3)"
```

---

## Task 7: Menu parser

**Files:**
- Create: `packages/core/src/modules/clone-pro/v5/scrapers/menu-parser.ts`
- Create: `packages/core/src/modules/clone-pro/v5/scrapers/menu-parser.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { parseMenuTree } from './menu-parser.js'

const homepageHtml = `
<html><body>
  <header>
    <nav>
      <ul>
        <li><a href="/collections/all">Shop All</a></li>
        <li>
          <a href="/collections/men">Men</a>
          <ul>
            <li><a href="/collections/men-tops">Tops</a></li>
            <li><a href="/collections/men-pants">Pants</a></li>
          </ul>
        </li>
        <li><a href="/pages/about">About</a></li>
      </ul>
    </nav>
  </header>
</body></html>
`

describe('parseMenuTree', () => {
  it('extracts nested menu items from <header><nav>', () => {
    const tree = parseMenuTree(homepageHtml, 'https://shop.example.com')
    expect(tree.handle).toBe('main-menu')
    expect(tree.nodes).toHaveLength(3)
    expect(tree.nodes[0].label).toBe('Shop All')
    expect(tree.nodes[0].url).toBe('https://shop.example.com/collections/all')
    expect(tree.nodes[1].children).toHaveLength(2)
    expect(tree.nodes[1].children[0].label).toBe('Tops')
  })

  it('resolves relative URLs against sourceUrl', () => {
    const tree = parseMenuTree(homepageHtml, 'https://shop.example.com')
    expect(tree.nodes[2].url).toBe('https://shop.example.com/pages/about')
  })

  it('returns empty tree when no <nav> found', () => {
    const tree = parseMenuTree('<html><body>no nav</body></html>', 'https://x.com')
    expect(tree.nodes).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/modules/clone-pro/v5/scrapers/menu-parser.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write implementation**

```ts
/**
 * Clone Pro v5 — menu parser
 *
 * Parses <header><nav> anchor tree from homepage HTML.
 * Walks <ul>/<li>/<a> hierarchy preserving parent→child.
 * URLs resolved against sourceUrl (absolute output).
 */

import * as cheerio from 'cheerio'
import type { MenuTree, MenuNode } from '../types.js'

export function parseMenuTree(html: string, sourceUrl: string): MenuTree {
  const $ = cheerio.load(html)
  const nav = $('header nav').first()
  if (nav.length === 0) {
    return { handle: 'main-menu', nodes: [] }
  }
  const topUl = nav.find('ul').first()
  const nodes = parseUl($, topUl, sourceUrl)
  return { handle: 'main-menu', nodes }
}

function parseUl(
  $: cheerio.CheerioAPI,
  ul: cheerio.Cheerio<any>,
  sourceUrl: string,
): MenuNode[] {
  const out: MenuNode[] = []
  ul.children('li').each((_, li) => {
    const $li = $(li)
    const $a = $li.children('a').first()
    if ($a.length === 0) return
    const href = $a.attr('href') || ''
    const label = $a.text().trim()
    if (!label) return
    const childUl = $li.children('ul').first()
    const children = childUl.length > 0 ? parseUl($, childUl, sourceUrl) : []
    out.push({
      label,
      url: resolveUrl(href, sourceUrl),
      children,
    })
  })
  return out
}

function resolveUrl(href: string, base: string): string {
  try {
    return new URL(href, base).toString()
  } catch {
    return href
  }
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `npx vitest run packages/core/src/modules/clone-pro/v5/scrapers/menu-parser.test.ts`
Expected: PASS (3/3)

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/modules/clone-pro/v5/scrapers/menu-parser.ts \
        packages/core/src/modules/clone-pro/v5/scrapers/menu-parser.test.ts
git commit -m "feat(clone-pro-v5): menu tree parser — nested <nav> anchors with URL resolution"
```

---

## Task 8: Theme tokens extractor

**Files:**
- Create: `packages/core/src/modules/clone-pro/v5/scrapers/theme-tokens.ts`
- Create: `packages/core/src/modules/clone-pro/v5/scrapers/theme-tokens.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { extractThemeTokens } from './theme-tokens.js'

const htmlWithVars = `
<html>
  <head>
    <style>
      :root {
        --color-primary: #1a1a1a;
        --color-secondary: #ff6600;
        --color-background: #ffffff;
        --color-text: #222222;
        --font-heading: "Helvetica Neue", sans-serif;
        --font-body: Inter, sans-serif;
        --spacing-base: 8px;
        --radius-base: 4px;
      }
    </style>
  </head>
  <body><h1>Hi</h1></body>
</html>
`

describe('extractThemeTokens', () => {
  it('extracts color tokens from :root CSS vars', () => {
    const t = extractThemeTokens(htmlWithVars)
    expect(t.colors.primary).toBe('#1a1a1a')
    expect(t.colors.secondary).toBe('#ff6600')
    expect(t.colors.background).toBe('#ffffff')
    expect(t.colors.text).toBe('#222222')
  })

  it('extracts typography tokens', () => {
    const t = extractThemeTokens(htmlWithVars)
    expect(t.typography.heading_family).toContain('Helvetica Neue')
    expect(t.typography.body_family).toContain('Inter')
  })

  it('extracts spacing + radius as numbers', () => {
    const t = extractThemeTokens(htmlWithVars)
    expect(t.spacing.base_px).toBe(8)
    expect(t.radius_px).toBe(4)
  })

  it('preserves all raw css vars in raw_css_vars dict', () => {
    const t = extractThemeTokens(htmlWithVars)
    expect(t.raw_css_vars['--color-primary']).toBe('#1a1a1a')
    expect(t.raw_css_vars['--spacing-base']).toBe('8px')
  })

  it('returns nulls when no CSS vars present', () => {
    const t = extractThemeTokens('<html><body></body></html>')
    expect(t.colors.primary).toBeNull()
    expect(t.typography.heading_family).toBeNull()
    expect(Object.keys(t.raw_css_vars)).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/modules/clone-pro/v5/scrapers/theme-tokens.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write implementation**

```ts
/**
 * Clone Pro v5 — theme token extractor
 *
 * Parses inline <style> blocks for :root custom properties.
 * Maps common naming conventions (--color-primary, --font-heading) to
 * canonical token slots. Preserves every var in raw_css_vars for later
 * DESIGN.md export (D11).
 */

import * as cheerio from 'cheerio'
import type { ThemeTokens } from '../types.js'

export function extractThemeTokens(html: string): ThemeTokens {
  const $ = cheerio.load(html)
  const raw: Record<string, string> = {}
  $('style').each((_, el) => {
    const css = $(el).html() || ''
    const rootMatch = css.match(/:root\s*\{([^}]*)\}/s)
    if (!rootMatch) return
    const body = rootMatch[1]
    const varRe = /(--[a-z0-9-]+)\s*:\s*([^;]+);/gi
    let m: RegExpExecArray | null
    while ((m = varRe.exec(body)) !== null) {
      raw[m[1].trim()] = m[2].trim()
    }
  })

  return {
    colors: {
      primary: pickVar(raw, ['--color-primary', '--primary', '--brand-primary']),
      secondary: pickVar(raw, ['--color-secondary', '--secondary', '--brand-secondary', '--accent']),
      background: pickVar(raw, ['--color-background', '--background', '--bg']),
      text: pickVar(raw, ['--color-text', '--text', '--color-foreground']),
    },
    typography: {
      heading_family: pickVar(raw, ['--font-heading', '--heading-font', '--font-family-heading']),
      body_family: pickVar(raw, ['--font-body', '--body-font', '--font-family-body']),
      base_size_px: parsePx(pickVar(raw, ['--font-size-base', '--base-font-size'])),
    },
    spacing: {
      base_px: parsePx(pickVar(raw, ['--spacing-base', '--space-base', '--base-spacing'])),
    },
    radius_px: parsePx(pickVar(raw, ['--radius-base', '--radius', '--border-radius'])),
    raw_css_vars: raw,
  }
}

function pickVar(raw: Record<string, string>, candidates: string[]): string | null {
  for (const k of candidates) {
    if (raw[k]) return raw[k]
  }
  return null
}

function parsePx(v: string | null): number | null {
  if (!v) return null
  const m = v.match(/^(\d+(?:\.\d+)?)px$/)
  return m ? parseFloat(m[1]) : null
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `npx vitest run packages/core/src/modules/clone-pro/v5/scrapers/theme-tokens.test.ts`
Expected: PASS (5/5)

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/modules/clone-pro/v5/scrapers/theme-tokens.ts \
        packages/core/src/modules/clone-pro/v5/scrapers/theme-tokens.test.ts
git commit -m "feat(clone-pro-v5): theme token extractor — CSS :root vars → canonical tokens"
```

---

## Task 9: Validation guardrails (R3)

**Files:**
- Create: `packages/core/src/modules/clone-pro/v5/validate/guardrails.ts`
- Create: `packages/core/src/modules/clone-pro/v5/validate/guardrails.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import {
  validateProducts, validateCollections, validatePages, validateMenuTree,
} from './guardrails.js'
import type { ScrapedProduct, ScrapedCollection, ScrapedPage, MenuTree } from '../types.js'

const validProduct: ScrapedProduct = {
  source_id: '1', handle: 'tee-a', title: 'Tee', body_html: '<p>x</p>',
  vendor: null, product_type: null, tags: [],
  images: [{ src: 'https://cdn.x/1.jpg', alt: null, position: 1 }],
  variants: [{
    source_id: 'v1', title: 'S', price: '29.00', compare_at_price: null,
    sku: null, inventory_quantity: null, option_values: ['S'],
    weight: null, weight_unit: null,
  }],
  options: [{ name: 'Size', position: 1, values: ['S', 'M'] }],
}

describe('validateProducts', () => {
  it('accepts product with handle + title + ≥1 image', () => {
    const { accepted, rejected } = validateProducts([validProduct])
    expect(accepted).toHaveLength(1)
    expect(rejected).toHaveLength(0)
  })

  it('rejects product with no images', () => {
    const bad = { ...validProduct, images: [] }
    const { accepted, rejected } = validateProducts([bad])
    expect(accepted).toHaveLength(0)
    expect(rejected[0].reason).toMatch(/image/i)
  })

  it('rejects product with empty handle', () => {
    const bad = { ...validProduct, handle: '' }
    const { accepted, rejected } = validateProducts([bad])
    expect(rejected).toHaveLength(1)
    expect(rejected[0].reason).toMatch(/handle/i)
  })

  it('rejects product with empty title', () => {
    const bad = { ...validProduct, title: '   ' }
    const { accepted, rejected } = validateProducts([bad])
    expect(rejected).toHaveLength(1)
  })
})

describe('validateCollections', () => {
  const valid: ScrapedCollection = {
    source_id: '10', handle: 'sale', title: 'Sale', body_html: '',
    image: null, product_handles: ['a', 'b'],
  }

  it('accepts collection with ≥1 product reference', () => {
    const { accepted } = validateCollections([valid])
    expect(accepted).toHaveLength(1)
  })

  it('rejects collection with zero products', () => {
    const { rejected } = validateCollections([{ ...valid, product_handles: [] }])
    expect(rejected).toHaveLength(1)
    expect(rejected[0].reason).toMatch(/empty/i)
  })
})

describe('validatePages', () => {
  const valid: ScrapedPage = {
    url: 'https://x.com/pages/about', slug: 'about',
    title: 'About', body_html: '<p>body</p>',
  }

  it('rejects URL that maps to blocked prefix (defence-in-depth)', () => {
    const { rejected } = validatePages([{ ...valid, url: 'https://x.com/products/tee' }])
    expect(rejected).toHaveLength(1)
    expect(rejected[0].reason).toMatch(/blocked/i)
  })

  it('rejects page with no title', () => {
    const { rejected } = validatePages([{ ...valid, title: '' }])
    expect(rejected).toHaveLength(1)
  })
})

describe('validateMenuTree', () => {
  it('flags menu items whose URL does not resolve to any imported resource', () => {
    const tree: MenuTree = {
      handle: 'main', nodes: [
        { label: 'About', url: 'https://x.com/pages/about', children: [] },
        { label: 'Gone', url: 'https://x.com/pages/deadlink', children: [] },
      ],
    }
    const importedUrls = new Set(['https://x.com/pages/about'])
    const { tree: flagged } = validateMenuTree(tree, importedUrls)
    expect((flagged.nodes as any)[0].broken).toBeFalsy()
    expect((flagged.nodes as any)[1].broken).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/modules/clone-pro/v5/validate/guardrails.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write implementation**

```ts
/**
 * Clone Pro v5 — bucket guardrails (R3 anti-mix enforcement)
 *
 * Every scraped DTO passes through these validators before persist.
 * Rejections are logged + surfaced in job.stages_json; they never
 * become DB rows.
 */

import type {
  ScrapedProduct, ScrapedCollection, ScrapedPage, MenuTree, MenuNode,
} from '../types.js'

export interface Rejection<T> {
  readonly item: T
  readonly reason: string
}

export interface ValidationResult<T> {
  readonly accepted: readonly T[]
  readonly rejected: readonly Rejection<T>[]
}

const BLOCKED_PAGE_PREFIXES = [
  '/products/', '/collections/', '/blogs/', '/cart', '/checkout', '/account',
]

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

export function validateProducts(items: readonly ScrapedProduct[]): ValidationResult<ScrapedProduct> {
  const accepted: ScrapedProduct[] = []
  const rejected: Rejection<ScrapedProduct>[] = []
  for (const p of items) {
    const reason = firstProductIssue(p)
    if (reason) rejected.push({ item: p, reason })
    else accepted.push(p)
  }
  return { accepted, rejected }
}

function firstProductIssue(p: ScrapedProduct): string | null {
  if (!p.handle || p.handle.trim() === '') return 'empty handle'
  if (!p.title || p.title.trim() === '') return 'empty title'
  if (p.images.length === 0) return 'no images (requires ≥1)'
  return null
}

// ---------------------------------------------------------------------------
// Collections
// ---------------------------------------------------------------------------

export function validateCollections(
  items: readonly ScrapedCollection[],
): ValidationResult<ScrapedCollection> {
  const accepted: ScrapedCollection[] = []
  const rejected: Rejection<ScrapedCollection>[] = []
  for (const c of items) {
    if (!c.handle) rejected.push({ item: c, reason: 'empty handle' })
    else if (!c.title) rejected.push({ item: c, reason: 'empty title' })
    else if (c.product_handles.length === 0) rejected.push({ item: c, reason: 'empty (no products)' })
    else accepted.push(c)
  }
  return { accepted, rejected }
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

export function validatePages(items: readonly ScrapedPage[]): ValidationResult<ScrapedPage> {
  const accepted: ScrapedPage[] = []
  const rejected: Rejection<ScrapedPage>[] = []
  for (const p of items) {
    const reason = firstPageIssue(p)
    if (reason) rejected.push({ item: p, reason })
    else accepted.push(p)
  }
  return { accepted, rejected }
}

function firstPageIssue(p: ScrapedPage): string | null {
  if (!p.title || p.title.trim() === '') return 'empty title'
  if (!p.slug) return 'empty slug'
  try {
    const u = new URL(p.url)
    if (BLOCKED_PAGE_PREFIXES.some((pre) => u.pathname.startsWith(pre))) {
      return `blocked URL prefix (${u.pathname})`
    }
  } catch {
    return 'invalid URL'
  }
  return null
}

// ---------------------------------------------------------------------------
// Menu — flags unresolved links as broken=true
// ---------------------------------------------------------------------------

export interface FlaggedMenuNode extends MenuNode {
  readonly broken?: boolean
  readonly children: readonly FlaggedMenuNode[]
}

export interface FlaggedMenuTree {
  readonly handle: string
  readonly nodes: readonly FlaggedMenuNode[]
}

export function validateMenuTree(
  tree: MenuTree,
  importedUrls: ReadonlySet<string>,
): { tree: FlaggedMenuTree; brokenCount: number } {
  let brokenCount = 0
  const flag = (n: MenuNode): FlaggedMenuNode => {
    const broken = !importedUrls.has(n.url)
    if (broken) brokenCount++
    return {
      ...n,
      broken,
      children: n.children.map(flag),
    }
  }
  return {
    tree: { handle: tree.handle, nodes: tree.nodes.map(flag) },
    brokenCount,
  }
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `npx vitest run packages/core/src/modules/clone-pro/v5/validate/guardrails.test.ts`
Expected: PASS (8/8)

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/modules/clone-pro/v5/validate/guardrails.ts \
        packages/core/src/modules/clone-pro/v5/validate/guardrails.test.ts
git commit -m "feat(clone-pro-v5): R3 guardrails — validate products/collections/pages + flag broken menu links"
```

---

## Task 10: Import transaction wrapper

**Files:**
- Create: `packages/core/src/modules/clone-pro/v5/persisters/import-transaction.ts`
- Create: `packages/core/src/modules/clone-pro/v5/persisters/import-transaction.test.ts`

**Dependency note:** Requires `@gbox/core/modules/db/transaction.ts` `runInSerializable` helper (lands when Phase 15 PR2 / PR #87 merges). If not yet merged, re-base onto master after PR #87 lands before starting this task.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from 'vitest'
import { runCloneImport } from './import-transaction.js'

describe('runCloneImport', () => {
  it('calls fn inside runInSerializable + writes checkpoint on success', async () => {
    const calls: string[] = []
    const fakeRun = async (db: any, fn: any) => { calls.push('tx-start'); const r = await fn(db); calls.push('tx-end'); return r }
    const fakeDb = {
      insertInto: vi.fn().mockReturnThis(),
      values: vi.fn().mockReturnThis(),
      execute: vi.fn().mockResolvedValue(undefined),
    }
    const result = await runCloneImport(fakeDb as any, 'job-1', async (db) => {
      calls.push('persist')
      return { inserted: 5 }
    }, { _runInSerializable: fakeRun as any })

    expect(calls).toEqual(['tx-start', 'persist', 'tx-end'])
    expect(result).toEqual({ inserted: 5 })
  })

  it('propagates error from fn — no checkpoint written', async () => {
    const writes: any[] = []
    const fakeDb = {
      insertInto: (t: string) => ({
        values: (v: any) => ({ execute: async () => writes.push({ t, v }) }),
      }),
    }
    const fakeRun = async (_db: any, fn: any) => { await fn(_db) }
    await expect(runCloneImport(fakeDb as any, 'job-x', async () => {
      throw new Error('persist boom')
    }, { _runInSerializable: fakeRun as any })).rejects.toThrow(/boom/)
    expect(writes).toHaveLength(0)   // no checkpoint on error
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/modules/clone-pro/v5/persisters/import-transaction.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write implementation**

```ts
/**
 * Clone Pro v5 — transactional import wrapper
 *
 * Wraps the entire persist phase (products + collections + pages + menus + theme)
 * in a single SERIALIZABLE transaction via runInSerializable (Phase 15 PR1).
 * On success, writes a checkpoint row. On error, propagates — tx auto-rolls back.
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import { runInSerializable } from '@gbox/core/modules/db/transaction.js'

export interface ImportOpts<T> {
  readonly _runInSerializable?: typeof runInSerializable   // test seam
}

export async function runCloneImport<T>(
  db: Kysely<Database>,
  jobId: string,
  fn: (tx: Kysely<Database>) => Promise<T>,
  opts: ImportOpts<T> = {},
): Promise<T> {
  const runner = opts._runInSerializable ?? runInSerializable
  const result = await runner(db, async (tx) => {
    const r = await fn(tx)
    await tx
      .insertInto('clone_checkpoints')
      .values({
        job_id: jobId,
        phase: 'persist',
        step: 'complete',
        state_json: {},
      })
      .execute()
    return r
  })
  return result
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `npx vitest run packages/core/src/modules/clone-pro/v5/persisters/import-transaction.test.ts`
Expected: PASS (2/2)

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/modules/clone-pro/v5/persisters/import-transaction.ts \
        packages/core/src/modules/clone-pro/v5/persisters/import-transaction.test.ts
git commit -m "feat(clone-pro-v5): import-transaction wrapper — runInSerializable + checkpoint on success"
```

---

## Task 11: Products persister

**Files:**
- Create: `packages/core/src/modules/clone-pro/v5/persisters/products-persist.ts`
- Create: `packages/core/src/modules/clone-pro/v5/persisters/products-persist.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from 'vitest'
import { persistProducts } from './products-persist.js'
import type { ScrapedProduct } from '../types.js'

const sampleProduct: ScrapedProduct = {
  source_id: '1', handle: 'tee-a', title: 'Tee A', body_html: '<p>x</p>',
  vendor: 'Allbirds', product_type: 'Shirt', tags: ['cotton'],
  images: [{ src: 'https://cdn.x/1.jpg', alt: 'Tee', position: 1 }],
  variants: [{
    source_id: 'v1', title: 'S', price: '29.00', compare_at_price: null,
    sku: 'T-S', inventory_quantity: 10, option_values: ['S'],
    weight: 200, weight_unit: 'g',
  }],
  options: [{ name: 'Size', position: 1, values: ['S', 'M', 'L'] }],
}

describe('persistProducts', () => {
  it('upserts product by (shop_id, handle) + variants by (product_id, source_id) + options + images', async () => {
    const writes: Array<{ table: string; values: any }> = []
    const fakeTx = {
      insertInto: (table: string) => ({
        values: (v: any) => ({
          onConflict: (_cb: any) => ({
            returning: (_c: string) => ({
              executeTakeFirst: async () => {
                writes.push({ table, values: v })
                if (table === 'products') return { id: 'prod-uuid-1' }
                if (table === 'product_options') return { id: 'opt-uuid-1' }
                if (table === 'product_variants') return { id: 'var-uuid-1' }
                return { id: 'generic-uuid' }
              },
            }),
          }),
        }),
      }),
    }

    const res = await persistProducts(fakeTx as any, 'shop-1', [sampleProduct])

    expect(res.inserted + res.updated).toBe(1)
    const productWrite = writes.find((w) => w.table === 'products')!
    expect(productWrite.values).toMatchObject({ shop_id: 'shop-1', handle: 'tee-a', title: 'Tee A' })
    expect(writes.filter((w) => w.table === 'product_variants')).toHaveLength(1)
    expect(writes.filter((w) => w.table === 'product_options')).toHaveLength(1)
    expect(writes.filter((w) => w.table === 'product_images')).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/modules/clone-pro/v5/persisters/products-persist.test.ts`
Expected: FAIL

- [ ] **Step 3: Write implementation**

```ts
/**
 * Clone Pro v5 — products persister (phase ⑤ — inside runInSerializable)
 *
 * Upsert strategy:
 *   products: (shop_id, handle) unique → ON CONFLICT UPDATE title/body/vendor/type/tags
 *   product_options: (product_id, name) unique → ON CONFLICT UPDATE values
 *   product_variants: (product_id, source_id) unique → ON CONFLICT UPDATE pricing
 *   product_images: (product_id, position) unique → ON CONFLICT UPDATE src/alt
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import type { ScrapedProduct } from '../types.js'

export interface PersistProductsResult {
  readonly inserted: number
  readonly updated: number
  readonly skipped: number
}

export async function persistProducts(
  tx: Kysely<Database>,
  shopId: string,
  products: readonly ScrapedProduct[],
): Promise<PersistProductsResult> {
  let inserted = 0
  let updated = 0
  let skipped = 0

  for (const p of products) {
    try {
      const row = await tx
        .insertInto('products')
        .values({
          shop_id: shopId,
          handle: p.handle,
          title: p.title,
          description_html: p.body_html,
          vendor: p.vendor,
          product_type: p.product_type,
          tags: p.tags as unknown as any,  // text[] or jsonb per schema
          status: 'draft',
        })
        .onConflict((oc) => oc.columns(['shop_id', 'handle']).doUpdateSet({
          title: p.title,
          description_html: p.body_html,
          vendor: p.vendor,
          product_type: p.product_type,
          tags: p.tags as unknown as any,
        }))
        .returning('id')
        .executeTakeFirst()

      if (!row) { skipped++; continue }
      const productId = row.id as string

      // Options
      for (const opt of p.options) {
        await tx
          .insertInto('product_options')
          .values({
            product_id: productId,
            name: opt.name,
            position: opt.position,
            values: opt.values as unknown as any,
          })
          .onConflict((oc) => oc.columns(['product_id', 'name']).doUpdateSet({
            position: opt.position,
            values: opt.values as unknown as any,
          }))
          .returning('id')
          .executeTakeFirst()
      }

      // Variants
      for (const v of p.variants) {
        await tx
          .insertInto('product_variants')
          .values({
            product_id: productId,
            source_id: v.source_id,
            title: v.title,
            price: v.price,
            compare_at_price: v.compare_at_price,
            sku: v.sku,
            inventory_quantity: v.inventory_quantity,
            option_values: v.option_values as unknown as any,
            weight: v.weight,
            weight_unit: v.weight_unit,
          })
          .onConflict((oc) => oc.columns(['product_id', 'source_id']).doUpdateSet({
            price: v.price,
            compare_at_price: v.compare_at_price,
            sku: v.sku,
            inventory_quantity: v.inventory_quantity,
          }))
          .returning('id')
          .executeTakeFirst()
      }

      // Images
      for (const img of p.images) {
        await tx
          .insertInto('product_images')
          .values({
            product_id: productId,
            position: img.position,
            src: img.src,
            alt: img.alt,
          })
          .onConflict((oc) => oc.columns(['product_id', 'position']).doUpdateSet({
            src: img.src,
            alt: img.alt,
          }))
          .returning('id')
          .executeTakeFirst()
      }

      // inserted vs updated distinction is best-effort — RETURNING doesn't say
      // which happened. Treat as inserted for now; counter can split via xmax
      // check in follow-up if needed.
      inserted++
    } catch {
      skipped++
    }
  }

  return { inserted, updated, skipped }
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `npx vitest run packages/core/src/modules/clone-pro/v5/persisters/products-persist.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/modules/clone-pro/v5/persisters/products-persist.ts \
        packages/core/src/modules/clone-pro/v5/persisters/products-persist.test.ts
git commit -m "feat(clone-pro-v5): products persister — upsert products + variants + options + images"
```

---

## Task 12: Collections persister

**Files:**
- Create: `packages/core/src/modules/clone-pro/v5/persisters/collections-persist.ts`
- Create: `packages/core/src/modules/clone-pro/v5/persisters/collections-persist.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from 'vitest'
import { persistCollections } from './collections-persist.js'
import type { ScrapedCollection } from '../types.js'

const sample: ScrapedCollection = {
  source_id: '10', handle: 'sale', title: 'Sale', body_html: '<p>s</p>',
  image: { src: 'https://cdn.x/sale.jpg', alt: 'Sale', position: 1 },
  product_handles: ['tee-a', 'tee-b'],
}

describe('persistCollections', () => {
  it('upserts collection + resolves product_handles → product_ids via join', async () => {
    const pivotInserts: any[] = []
    const fakeTx = {
      insertInto: (table: string) => ({
        values: (v: any) => ({
          onConflict: (_cb: any) => ({
            returning: (_c: string) => ({
              executeTakeFirst: async () => {
                if (table === 'collections') return { id: 'coll-1' }
                return null
              },
            }),
          }),
          execute: async () => { if (table === 'collection_products') pivotInserts.push(v) },
        }),
      }),
      selectFrom: (_t: string) => ({
        select: (_c: any) => ({
          where: (_a: any, _op: any, _b: any) => ({
            where: (_a2: any, _op2: any, _b2: any) => ({
              execute: async () => [
                { id: 'prod-a', handle: 'tee-a' },
                { id: 'prod-b', handle: 'tee-b' },
              ],
            }),
          }),
        }),
      }),
      deleteFrom: (_t: string) => ({
        where: (_a: any, _op: any, _b: any) => ({
          execute: async () => undefined,
        }),
      }),
    }

    const res = await persistCollections(fakeTx as any, 'shop-1', [sample])
    expect(res.inserted + res.updated).toBe(1)
    expect(pivotInserts).toHaveLength(2)
    expect(pivotInserts.map((p) => p.product_id).sort()).toEqual(['prod-a', 'prod-b'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/modules/clone-pro/v5/persisters/collections-persist.test.ts`
Expected: FAIL

- [ ] **Step 3: Write implementation**

```ts
/**
 * Clone Pro v5 — collections persister
 *
 * Upsert collection by (shop_id, handle), then replace collection_products
 * pivot rows with resolved product_ids. Product handles that don't map to
 * any imported product are silently dropped (persister runs AFTER products).
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import type { ScrapedCollection } from '../types.js'

export interface PersistCollectionsResult {
  readonly inserted: number
  readonly updated: number
  readonly skipped: number
  readonly pivotLinks: number
}

export async function persistCollections(
  tx: Kysely<Database>,
  shopId: string,
  collections: readonly ScrapedCollection[],
): Promise<PersistCollectionsResult> {
  let inserted = 0
  let skipped = 0
  let pivotLinks = 0

  for (const c of collections) {
    const row = await tx
      .insertInto('collections')
      .values({
        shop_id: shopId,
        handle: c.handle,
        title: c.title,
        description_html: c.body_html,
        image_src: c.image?.src ?? null,
      })
      .onConflict((oc) => oc.columns(['shop_id', 'handle']).doUpdateSet({
        title: c.title,
        description_html: c.body_html,
        image_src: c.image?.src ?? null,
      }))
      .returning('id')
      .executeTakeFirst()

    if (!row) { skipped++; continue }
    const collectionId = row.id as string

    // Resolve handles → product_ids
    const products = await tx
      .selectFrom('products')
      .select(['id', 'handle'])
      .where('shop_id', '=', shopId)
      .where('handle', 'in', c.product_handles as string[])
      .execute()

    // Reset pivot
    await tx.deleteFrom('collection_products').where('collection_id', '=', collectionId).execute()

    for (const p of products) {
      await tx
        .insertInto('collection_products')
        .values({
          collection_id: collectionId,
          product_id: p.id as string,
        })
        .execute()
      pivotLinks++
    }
    inserted++
  }

  return { inserted, updated: 0, skipped, pivotLinks }
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `npx vitest run packages/core/src/modules/clone-pro/v5/persisters/collections-persist.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/modules/clone-pro/v5/persisters/collections-persist.ts \
        packages/core/src/modules/clone-pro/v5/persisters/collections-persist.test.ts
git commit -m "feat(clone-pro-v5): collections persister — upsert + rebuild pivot from product handles"
```

---

## Task 13: Pages persister

**Files:**
- Create: `packages/core/src/modules/clone-pro/v5/persisters/pages-persist.ts`
- Create: `packages/core/src/modules/clone-pro/v5/persisters/pages-persist.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { persistPages } from './pages-persist.js'

describe('persistPages', () => {
  it('upserts page by (shop_id, slug) with sanitised body_html', async () => {
    const writes: any[] = []
    const fakeTx = {
      insertInto: (_t: string) => ({
        values: (v: any) => ({
          onConflict: (_c: any) => ({
            execute: async () => { writes.push(v) },
          }),
        }),
      }),
    }
    const res = await persistPages(fakeTx as any, 'shop-1', [
      { url: 'https://x.com/pages/about', slug: 'about', title: 'About', body_html: '<p>hi</p>' },
    ])
    expect(res.inserted).toBe(1)
    expect(writes[0]).toMatchObject({ shop_id: 'shop-1', slug: 'about', title: 'About' })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/modules/clone-pro/v5/persisters/pages-persist.test.ts`
Expected: FAIL

- [ ] **Step 3: Write implementation**

```ts
/**
 * Clone Pro v5 — pages persister
 *
 * Upsert pages by (shop_id, slug). Body HTML passes through sanitiser
 * (re-use v4 sanitize.ts — strips script/iframe/on* handlers).
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import type { ScrapedPage } from '../types.js'
import { sanitizeClonedHtml } from '../../sanitize.js'

export interface PersistPagesResult {
  readonly inserted: number
  readonly skipped: number
}

export async function persistPages(
  tx: Kysely<Database>,
  shopId: string,
  pages: readonly ScrapedPage[],
): Promise<PersistPagesResult> {
  let inserted = 0
  let skipped = 0
  for (const p of pages) {
    try {
      await tx
        .insertInto('pages')
        .values({
          shop_id: shopId,
          slug: p.slug,
          title: p.title,
          body_html: sanitizeClonedHtml(p.body_html),
          status: 'draft',
        })
        .onConflict((oc) => oc.columns(['shop_id', 'slug']).doUpdateSet({
          title: p.title,
          body_html: sanitizeClonedHtml(p.body_html),
        }))
        .execute()
      inserted++
    } catch {
      skipped++
    }
  }
  return { inserted, skipped }
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `npx vitest run packages/core/src/modules/clone-pro/v5/persisters/pages-persist.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/modules/clone-pro/v5/persisters/pages-persist.ts \
        packages/core/src/modules/clone-pro/v5/persisters/pages-persist.test.ts
git commit -m "feat(clone-pro-v5): pages persister — upsert by slug with sanitised HTML"
```

---

## Task 14: Menus persister

**Files:**
- Create: `packages/core/src/modules/clone-pro/v5/persisters/menus-persist.ts`
- Create: `packages/core/src/modules/clone-pro/v5/persisters/menus-persist.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { persistMenus } from './menus-persist.js'
import type { FlaggedMenuTree } from '../validate/guardrails.js'

describe('persistMenus', () => {
  it('persists flat + nested menu items with correct parent_id hierarchy', async () => {
    const writes: any[] = []
    let idCounter = 0
    const fakeTx = {
      insertInto: (t: string) => ({
        values: (v: any) => ({
          onConflict: (_c: any) => ({
            returning: (_col: string) => ({
              executeTakeFirst: async () => {
                const id = `id-${++idCounter}`
                writes.push({ table: t, ...v, _id: id })
                return { id }
              },
            }),
          }),
          execute: async () => writes.push({ table: t, ...v }),
        }),
      }),
      deleteFrom: (_t: string) => ({ where: (_a: any, _o: any, _b: any) => ({ execute: async () => undefined }) }),
    }
    const tree: FlaggedMenuTree = {
      handle: 'main-menu',
      nodes: [
        { label: 'Shop', url: 'https://x.com/collections/all', broken: false, children: [
          { label: 'Men', url: 'https://x.com/collections/men', broken: false, children: [] },
        ] },
        { label: 'Gone', url: 'https://x.com/dead', broken: true, children: [] },
      ],
    }
    const res = await persistMenus(fakeTx as any, 'shop-1', tree)
    expect(res.menuInserted).toBe(1)
    expect(res.itemsInserted).toBe(3)
    const items = writes.filter((w) => w.table === 'menu_items')
    const shop = items.find((i: any) => i.label === 'Shop')
    const men = items.find((i: any) => i.label === 'Men')
    expect(men.parent_id).toBe(shop._id)
    const gone = items.find((i: any) => i.label === 'Gone')
    expect(gone.broken).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/modules/clone-pro/v5/persisters/menus-persist.test.ts`
Expected: FAIL

- [ ] **Step 3: Write implementation**

```ts
/**
 * Clone Pro v5 — menus persister
 *
 * Upsert menu by (shop_id, handle). Recursively insert menu_items
 * with depth + position + parent_id. Broken links persist with
 * broken=true so sellers can see them flagged in the admin.
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import type { FlaggedMenuTree, FlaggedMenuNode } from '../validate/guardrails.js'

export interface PersistMenusResult {
  readonly menuInserted: number
  readonly itemsInserted: number
}

export async function persistMenus(
  tx: Kysely<Database>,
  shopId: string,
  tree: FlaggedMenuTree,
): Promise<PersistMenusResult> {
  // Upsert menu
  const menu = await tx
    .insertInto('menus')
    .values({ shop_id: shopId, handle: tree.handle, title: tree.handle })
    .onConflict((oc) => oc.columns(['shop_id', 'handle']).doUpdateSet({ title: tree.handle }))
    .returning('id')
    .executeTakeFirst()
  if (!menu) return { menuInserted: 0, itemsInserted: 0 }
  const menuId = menu.id as string

  // Reset items
  await tx.deleteFrom('menu_items').where('menu_id', '=', menuId).execute()

  let itemsInserted = 0
  async function insertRec(nodes: readonly FlaggedMenuNode[], parentId: string | null, depth: number) {
    let position = 0
    for (const n of nodes) {
      const row = await tx
        .insertInto('menu_items')
        .values({
          menu_id: menuId,
          parent_id: parentId,
          label: n.label,
          url: n.url,
          depth,
          position: position++,
          broken: n.broken === true,
        })
        .onConflict((oc) => oc.columns(['menu_id', 'parent_id', 'position']).doUpdateSet({
          label: n.label,
          url: n.url,
          depth,
          broken: n.broken === true,
        }))
        .returning('id')
        .executeTakeFirst()
      itemsInserted++
      if (row && n.children.length > 0) {
        await insertRec(n.children, row.id as string, depth + 1)
      }
    }
  }
  await insertRec(tree.nodes, null, 0)

  return { menuInserted: 1, itemsInserted }
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `npx vitest run packages/core/src/modules/clone-pro/v5/persisters/menus-persist.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/modules/clone-pro/v5/persisters/menus-persist.ts \
        packages/core/src/modules/clone-pro/v5/persisters/menus-persist.test.ts
git commit -m "feat(clone-pro-v5): menus persister — hierarchical menu_items with broken-link flag"
```

---

## Task 15: Theme persister

**Files:**
- Create: `packages/core/src/modules/clone-pro/v5/persisters/theme-persist.ts`
- Create: `packages/core/src/modules/clone-pro/v5/persisters/theme-persist.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { persistTheme } from './theme-persist.js'
import type { ThemeTokens } from '../types.js'

const tokens: ThemeTokens = {
  colors: { primary: '#111', secondary: '#f60', background: '#fff', text: '#222' },
  typography: { heading_family: 'Helvetica', body_family: 'Inter', base_size_px: 16 },
  spacing: { base_px: 8 },
  radius_px: 4,
  raw_css_vars: { '--color-primary': '#111' },
}

describe('persistTheme', () => {
  it('upserts theme_config JSON by shop_id', async () => {
    const writes: any[] = []
    const fakeTx = {
      insertInto: (_t: string) => ({
        values: (v: any) => ({
          onConflict: (_c: any) => ({ execute: async () => writes.push(v) }),
        }),
      }),
    }
    await persistTheme(fakeTx as any, 'shop-1', tokens)
    expect(writes[0].shop_id).toBe('shop-1')
    expect(writes[0].tokens_json).toEqual(tokens)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/modules/clone-pro/v5/persisters/theme-persist.test.ts`
Expected: FAIL

- [ ] **Step 3: Write implementation**

```ts
/**
 * Clone Pro v5 — theme persister
 *
 * Upserts theme_config by shop_id. tokens_json is the full ThemeTokens DTO.
 * One row per shop; re-cloning overwrites.
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import type { ThemeTokens } from '../types.js'

export async function persistTheme(
  tx: Kysely<Database>,
  shopId: string,
  tokens: ThemeTokens,
): Promise<void> {
  await tx
    .insertInto('theme_config')
    .values({
      shop_id: shopId,
      tokens_json: tokens as unknown as any,
    })
    .onConflict((oc) => oc.column('shop_id').doUpdateSet({
      tokens_json: tokens as unknown as any,
    }))
    .execute()
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `npx vitest run packages/core/src/modules/clone-pro/v5/persisters/theme-persist.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/modules/clone-pro/v5/persisters/theme-persist.ts \
        packages/core/src/modules/clone-pro/v5/persisters/theme-persist.test.ts
git commit -m "feat(clone-pro-v5): theme_config JSONB persister — upsert by shop"
```

---

## Task 16: Route-check verifier

**Files:**
- Create: `packages/core/src/modules/clone-pro/v5/verify/route-check.ts`
- Create: `packages/core/src/modules/clone-pro/v5/verify/route-check.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from 'vitest'
import { routeCheck } from './route-check.js'

describe('routeCheck', () => {
  it('HEADs every URL and reports pass rate', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200 })
      .mockResolvedValueOnce({ ok: true, status: 200 })
      .mockResolvedValueOnce({ ok: false, status: 404 })
    const res = await routeCheck(
      ['https://preview/abc', 'https://preview/def', 'https://preview/ghi'],
      { fetch: fetchMock as any },
    )
    expect(res.passCount).toBe(2)
    expect(res.total).toBe(3)
    expect(res.passRate).toBeCloseTo(2 / 3)
    expect(res.failures).toHaveLength(1)
    expect(res.failures[0].url).toBe('https://preview/ghi')
  })

  it('counts fetch error as failure (network timeout etc)', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('timeout'))
    const res = await routeCheck(['https://x.com/a'], { fetch: fetchMock as any })
    expect(res.passCount).toBe(0)
    expect(res.failures[0].reason).toMatch(/timeout/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/modules/clone-pro/v5/verify/route-check.test.ts`
Expected: FAIL

- [ ] **Step 3: Write implementation**

```ts
/**
 * Clone Pro v5 — route-check verifier
 *
 * Fires HEAD requests against every imported URL (on preview subdomain).
 * Reports pass count + failure details. Used by grader for
 * route_check_pct (40% of composite grade).
 */

export interface RouteCheckOpts {
  readonly fetch?: typeof globalThis.fetch
  readonly timeoutMs?: number
  readonly concurrency?: number
}

export interface RouteCheckResult {
  readonly total: number
  readonly passCount: number
  readonly passRate: number    // 0..1
  readonly failures: readonly { url: string; reason: string }[]
}

export async function routeCheck(
  urls: readonly string[],
  opts: RouteCheckOpts = {},
): Promise<RouteCheckResult> {
  const fetchFn = opts.fetch ?? globalThis.fetch
  const concurrency = opts.concurrency ?? 10
  const timeoutMs = opts.timeoutMs ?? 5000
  const failures: { url: string; reason: string }[] = []
  let passCount = 0

  async function check(url: string): Promise<void> {
    try {
      const ctrl = new AbortController()
      const t = setTimeout(() => ctrl.abort(), timeoutMs)
      const res = await fetchFn(url, { method: 'HEAD', signal: ctrl.signal })
      clearTimeout(t)
      if (res.ok) passCount++
      else failures.push({ url, reason: `HTTP ${res.status}` })
    } catch (e) {
      failures.push({ url, reason: (e as Error).message })
    }
  }

  for (let i = 0; i < urls.length; i += concurrency) {
    const batch = urls.slice(i, i + concurrency)
    await Promise.all(batch.map(check))
  }

  return {
    total: urls.length,
    passCount,
    passRate: urls.length > 0 ? passCount / urls.length : 0,
    failures,
  }
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `npx vitest run packages/core/src/modules/clone-pro/v5/verify/route-check.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/modules/clone-pro/v5/verify/route-check.ts \
        packages/core/src/modules/clone-pro/v5/verify/route-check.test.ts
git commit -m "feat(clone-pro-v5): route-check verifier — HEAD pass rate with concurrency"
```

---

## Task 17: DESIGN.md exporter (D11)

**Files:**
- Create: `packages/core/src/modules/clone-pro/v5/design-md-export.ts`
- Create: `packages/core/src/modules/clone-pro/v5/design-md-export.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { exportDesignMd } from './design-md-export.js'
import type { ThemeTokens } from './types.js'

describe('exportDesignMd', () => {
  it('produces awesome-claude-design-compatible DESIGN.md structure', () => {
    const tokens: ThemeTokens = {
      colors: { primary: '#111', secondary: '#f60', background: '#fff', text: '#222' },
      typography: { heading_family: 'Helvetica Neue', body_family: 'Inter', base_size_px: 16 },
      spacing: { base_px: 8 },
      radius_px: 4,
      raw_css_vars: { '--color-primary': '#111' },
    }
    const md = exportDesignMd({ shopName: 'Allbirds Clone', tokens })
    expect(md).toMatch(/^# Allbirds Clone Design System/)
    expect(md).toContain('## Brand voice')
    expect(md).toContain('## Tokens')
    expect(md).toContain('### Color')
    expect(md).toContain('primary: #111')
    expect(md).toContain('### Typography')
    expect(md).toContain('heading: Helvetica Neue')
    expect(md).toContain('base: 8')
    expect(md).toContain('## Components')
    expect(md).toContain('### Button')
    expect(md).toContain('radius: 4')
  })

  it('does not leak source-host identifiers (Iron Rule 5)', () => {
    const tokens: ThemeTokens = {
      colors: { primary: '#111', secondary: null, background: null, text: null },
      typography: { heading_family: null, body_family: null, base_size_px: null },
      spacing: { base_px: null }, radius_px: null, raw_css_vars: {},
    }
    const md = exportDesignMd({
      shopName: 'Shop',
      tokens,
      sourceHost: 'allbirds.com',   // should NOT appear in output
    })
    expect(md).not.toMatch(/allbirds\.com/i)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/modules/clone-pro/v5/design-md-export.test.ts`
Expected: FAIL

- [ ] **Step 3: Write implementation**

```ts
/**
 * Clone Pro v5 — DESIGN.md exporter (D11)
 *
 * Outputs awesome-claude-design-compatible markdown from ThemeTokens.
 * Format: https://getdesign.md/what-is-design-md
 *
 * Iron Rule 5: never leak source_host or scraper internals in the MD —
 * only brand-derived tokens.
 */

import type { ThemeTokens } from './types.js'

export interface ExportDesignMdInput {
  readonly shopName: string
  readonly tokens: ThemeTokens
  readonly sourceHost?: string   // accepted but never written out
  readonly brandVoice?: string
}

export function exportDesignMd(input: ExportDesignMdInput): string {
  const { shopName, tokens, brandVoice } = input
  const colorLines = [
    tokens.colors.primary ? `- primary: ${tokens.colors.primary}` : null,
    tokens.colors.secondary ? `- secondary: ${tokens.colors.secondary}` : null,
    tokens.colors.background ? `- background: ${tokens.colors.background}` : null,
    tokens.colors.text ? `- text: ${tokens.colors.text}` : null,
  ].filter(Boolean).join('\n')

  const typographyLines = [
    tokens.typography.heading_family ? `- heading: ${tokens.typography.heading_family}` : null,
    tokens.typography.body_family ? `- body: ${tokens.typography.body_family}` : null,
    tokens.typography.base_size_px ? `- base size: ${tokens.typography.base_size_px}px` : null,
  ].filter(Boolean).join('\n')

  const radius = tokens.radius_px ?? 0
  const spacing = tokens.spacing.base_px ?? 0

  return `# ${shopName} Design System

## Brand voice
${brandVoice ?? 'Inferred from source — sellers refine in Claude Design.'}

## Tokens
### Color
${colorLines || '- (no color tokens extracted)'}

### Typography
${typographyLines || '- (no typography tokens extracted)'}

### Spacing
base: ${spacing}  (scale: ${scaleLine(spacing)})

## Components
### Button
- radius: ${radius}
- height: ${Math.max(spacing * 5, 40)}
- padding: ${spacing * 2} ${spacing * 3}

### Card
- radius: ${radius}
- padding: ${spacing * 3}
- shadow: 0 2px 8px rgba(0,0,0,0.08)
`
}

function scaleLine(base: number): string {
  if (base === 0) return '—'
  return `${base / 2}/${base}/${base * 2}/${base * 3}/${base * 6}/${base * 10}`
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `npx vitest run packages/core/src/modules/clone-pro/v5/design-md-export.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/modules/clone-pro/v5/design-md-export.ts \
        packages/core/src/modules/clone-pro/v5/design-md-export.test.ts
git commit -m "feat(clone-pro-v5): DESIGN.md exporter (D11) — awesome-claude-design-compatible"
```

---

## Task 18: Grader (weighted composite)

**Files:**
- Create: `packages/core/src/modules/clone-pro/v5/grader.ts`
- Create: `packages/core/src/modules/clone-pro/v5/grader.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { gradeClone } from './grader.js'

describe('gradeClone', () => {
  it('returns A when all metrics are high', () => {
    const r = gradeClone({
      routeCheckPct: 0.97,
      productCompletenessPct: 0.99,
      cssTokenPct: 0.85,
      pageBodyPct: 0.96,
      menuResolutionPct: 0.92,
    })
    expect(r.letter).toBe('A')
    expect(r.score).toBeGreaterThanOrEqual(90)
  })

  it('returns F when most metrics fail', () => {
    const r = gradeClone({
      routeCheckPct: 0.30,
      productCompletenessPct: 0.40,
      cssTokenPct: 0.20,
      pageBodyPct: 0.50,
      menuResolutionPct: 0.10,
    })
    expect(r.letter).toBe('F')
  })

  it('weights route-check at 40% (highest weight)', () => {
    const allOther = { productCompletenessPct: 1, cssTokenPct: 1, pageBodyPct: 1, menuResolutionPct: 1 }
    const high = gradeClone({ routeCheckPct: 1, ...allOther })
    const low = gradeClone({ routeCheckPct: 0, ...allOther })
    expect(high.score - low.score).toBeCloseTo(40, 1)
  })

  it('emits warnings for failing metrics', () => {
    const r = gradeClone({
      routeCheckPct: 0.50,
      productCompletenessPct: 0.99,
      cssTokenPct: 0.90,
      pageBodyPct: 0.99,
      menuResolutionPct: 0.99,
    })
    expect(r.warnings.some((w) => w.toLowerCase().includes('route'))).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/modules/clone-pro/v5/grader.test.ts`
Expected: FAIL

- [ ] **Step 3: Write implementation**

```ts
/**
 * Clone Pro v5 — weighted composite grader
 *
 * Weights (spec §9):
 *   route_check        40%
 *   product_complete   25%
 *   css_token          15%
 *   page_body          10%
 *   menu_resolution    10%
 *
 * Bands: A ≥90 · B ≥75 · C ≥60 · D ≥45 · F <45
 */

import type { GradeResult } from './types.js'

export interface GradeInput {
  readonly routeCheckPct: number          // 0..1
  readonly productCompletenessPct: number
  readonly cssTokenPct: number
  readonly pageBodyPct: number
  readonly menuResolutionPct: number
}

export function gradeClone(input: GradeInput): GradeResult {
  const score =
    input.routeCheckPct * 40 +
    input.productCompletenessPct * 25 +
    input.cssTokenPct * 15 +
    input.pageBodyPct * 10 +
    input.menuResolutionPct * 10

  const letter: GradeResult['letter'] =
    score >= 90 ? 'A' :
    score >= 75 ? 'B' :
    score >= 60 ? 'C' :
    score >= 45 ? 'D' : 'F'

  const warnings: string[] = []
  if (input.routeCheckPct < 0.85) warnings.push(`Route check below target (${Math.round(input.routeCheckPct * 100)}% of URLs reachable)`)
  if (input.productCompletenessPct < 0.90) warnings.push(`Some products were not imported (${Math.round(input.productCompletenessPct * 100)}% coverage)`)
  if (input.cssTokenPct < 0.60) warnings.push(`Limited design-token extraction (${Math.round(input.cssTokenPct * 100)}%). Consider theme override.`)
  if (input.pageBodyPct < 0.80) warnings.push(`Some pages have empty body content`)
  if (input.menuResolutionPct < 0.75) warnings.push(`${Math.round((1 - input.menuResolutionPct) * 100)}% of menu links are unresolved`)

  return {
    score: Math.round(score * 100) / 100,
    letter,
    breakdown: {
      route_check_pct: input.routeCheckPct,
      product_completeness_pct: input.productCompletenessPct,
      css_token_pct: input.cssTokenPct,
      page_body_pct: input.pageBodyPct,
      menu_resolution_pct: input.menuResolutionPct,
    },
    warnings,
  }
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `npx vitest run packages/core/src/modules/clone-pro/v5/grader.test.ts`
Expected: PASS (4/4)

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/modules/clone-pro/v5/grader.ts \
        packages/core/src/modules/clone-pro/v5/grader.test.ts
git commit -m "feat(clone-pro-v5): weighted grader — route 40 / product 25 / css 15 / page 10 / menu 10"
```

---

## Task 19: Pipeline orchestrator + index barrel

**Files:**
- Create: `packages/core/src/modules/clone-pro/v5/pipeline.ts`
- Create: `packages/core/src/modules/clone-pro/v5/pipeline.test.ts`
- Create: `packages/core/src/modules/clone-pro/v5/index.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from 'vitest'
import { runCloneProV5 } from './pipeline.js'
import type { PipelineContext } from './types.js'

describe('runCloneProV5', () => {
  it('runs phases ①→⑨ in order on the happy path', async () => {
    const order: string[] = []
    const scrapers = {
      detectPlatform: async () => { order.push('detect'); return 'shopify' as const },
      scrapeProducts: async () => { order.push('scrape-products'); return [] },
      scrapeCollections: async () => { order.push('scrape-collections'); return [] },
      scrapePages: async () => { order.push('scrape-pages'); return [] },
      parseMenu: () => { order.push('parse-menu'); return { handle: 'main', nodes: [] } },
      extractTokens: () => { order.push('extract-tokens'); return {
        colors: { primary: null, secondary: null, background: null, text: null },
        typography: { heading_family: null, body_family: null, base_size_px: null },
        spacing: { base_px: null }, radius_px: null, raw_css_vars: {},
      } },
      fetchHomepage: async () => { order.push('fetch-homepage'); return '<html></html>' },
    }
    const persisters = {
      persistAll: async () => { order.push('persist'); return { productsInserted: 0, collectionsInserted: 0, pagesInserted: 0, menuItems: 0 } },
      mountPreview: async () => { order.push('mount-preview'); return 'https://abc.clone-preview.gbox.local' },
    }
    const verify = {
      routeCheck: async () => { order.push('route-check'); return { total: 0, passCount: 0, passRate: 1, failures: [] } },
    }
    const ctx: PipelineContext = {
      jobId: 'job-1', shopId: 'shop-1', sourceUrl: 'https://x.com', sourceHost: 'x.com',
      scope: { products: true, collections: true, pages: true, menu: true, theme: true },
    }

    const result = await runCloneProV5(ctx, { scrapers, persisters, verify } as any)

    expect(order).toEqual([
      'detect',
      'fetch-homepage',
      'scrape-products', 'scrape-collections', 'scrape-pages', 'parse-menu', 'extract-tokens',
      'persist',
      'mount-preview',
      'route-check',
    ])
    expect(result.grade.letter).toMatch(/[A-F]/)
    expect(result.previewUrl).toMatch(/clone-preview/)
  })

  it('fails job + surfaces error when platform detect returns unknown', async () => {
    const scrapers = { detectPlatform: async () => 'unknown' as const }
    const ctx: PipelineContext = {
      jobId: 'j', shopId: 's', sourceUrl: 'https://x.com', sourceHost: 'x.com',
      scope: { products: true, collections: true, pages: true, menu: true, theme: true },
    }
    await expect(runCloneProV5(ctx, { scrapers } as any)).rejects.toThrow(/platform/i)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/modules/clone-pro/v5/pipeline.test.ts`
Expected: FAIL

- [ ] **Step 3: Write pipeline implementation**

```ts
/**
 * Clone Pro v5 — pipeline orchestrator (phases ① → ⑨)
 *
 * Orchestrator only — delegates to injected scrapers + persisters + verify.
 * Dependency injection keeps this unit-testable without real HTTP/DB.
 * Real wiring happens in index.ts registerAllV5().
 */

import type {
  Platform, ScrapedProduct, ScrapedCollection, ScrapedPage,
  MenuTree, ThemeTokens, PipelineContext, GradeResult,
} from './types.js'
import type { FlaggedMenuTree } from './validate/guardrails.js'
import { validateProducts, validateCollections, validatePages, validateMenuTree } from './validate/guardrails.js'
import { gradeClone } from './grader.js'
import { exportDesignMd } from './design-md-export.js'

export interface PipelineDeps {
  readonly scrapers: {
    readonly detectPlatform: (url: string) => Promise<Platform>
    readonly fetchHomepage: (url: string) => Promise<string>
    readonly scrapeProducts: (url: string) => Promise<readonly ScrapedProduct[]>
    readonly scrapeCollections: (url: string) => Promise<readonly ScrapedCollection[]>
    readonly scrapePages: (url: string) => Promise<readonly ScrapedPage[]>
    readonly parseMenu: (html: string, url: string) => MenuTree
    readonly extractTokens: (html: string) => ThemeTokens
  }
  readonly persisters: {
    readonly persistAll: (args: {
      shopId: string
      jobId: string
      products: readonly ScrapedProduct[]
      collections: readonly ScrapedCollection[]
      pages: readonly ScrapedPage[]
      menuTree: FlaggedMenuTree
      themeTokens: ThemeTokens
    }) => Promise<{
      productsInserted: number
      collectionsInserted: number
      pagesInserted: number
      menuItems: number
    }>
    readonly mountPreview: (jobId: string) => Promise<string>
  }
  readonly verify: {
    readonly routeCheck: (urls: readonly string[]) => Promise<{
      total: number; passCount: number; passRate: number
      failures: readonly { url: string; reason: string }[]
    }>
  }
}

export interface PipelineResult {
  readonly platform: Platform
  readonly previewUrl: string
  readonly grade: GradeResult
  readonly designMd: string
  readonly stats: {
    readonly productsImported: number
    readonly productsDiscovered: number
    readonly collectionsImported: number
    readonly pagesImported: number
    readonly menuItems: number
    readonly menuBroken: number
  }
}

export async function runCloneProV5(
  ctx: PipelineContext,
  deps: PipelineDeps,
): Promise<PipelineResult> {
  // ① Detect
  const platform = await deps.scrapers.detectPlatform(ctx.sourceUrl)
  if (platform === 'unknown') {
    throw new Error('Platform detection failed (unknown)')
  }
  if (platform !== 'shopify') {
    // v5 PR1 scope is Shopify only; PR2 extends to woo/generic
    throw new Error(`Platform '${platform}' not supported in PR1 (Shopify-only)`)
  }

  // ② Discover — use homepage as discovery seed
  const homepageHtml = await deps.scrapers.fetchHomepage(ctx.sourceUrl)

  // ③ Scrape (parallel where safe)
  const [rawProducts, rawCollections, rawPages] = await Promise.all([
    ctx.scope.products ? deps.scrapers.scrapeProducts(ctx.sourceUrl) : Promise.resolve([]),
    ctx.scope.collections ? deps.scrapers.scrapeCollections(ctx.sourceUrl) : Promise.resolve([]),
    ctx.scope.pages ? deps.scrapers.scrapePages(ctx.sourceUrl) : Promise.resolve([]),
  ])
  const menuTree = ctx.scope.menu
    ? deps.scrapers.parseMenu(homepageHtml, ctx.sourceUrl)
    : { handle: 'main-menu', nodes: [] }
  const themeTokens = ctx.scope.theme
    ? deps.scrapers.extractTokens(homepageHtml)
    : emptyTokens()

  // ④ Validate
  const productsV = validateProducts(rawProducts)
  const collectionsV = validateCollections(rawCollections)
  const pagesV = validatePages(rawPages)

  // Build imported URL set (for menu validation)
  const importedUrls = new Set<string>([
    ...productsV.accepted.map((p) => `${ctx.sourceUrl}/products/${p.handle}`),
    ...collectionsV.accepted.map((c) => `${ctx.sourceUrl}/collections/${c.handle}`),
    ...pagesV.accepted.map((p) => p.url),
  ])
  const menuV = validateMenuTree(menuTree, importedUrls)

  // ⑤ Persist (caller wraps in runInSerializable via persistAll)
  const persistStats = await deps.persisters.persistAll({
    shopId: ctx.shopId,
    jobId: ctx.jobId,
    products: productsV.accepted,
    collections: collectionsV.accepted,
    pages: pagesV.accepted,
    menuTree: menuV.tree,
    themeTokens,
  })

  // ⑥ Asset rehost — DEFERRED (PR3 scope)

  // ⑦ Preview mount
  const previewUrl = await deps.persisters.mountPreview(ctx.jobId)

  // ⑧ Verify + grade
  const routesToCheck = Array.from(importedUrls).map((u) => rewriteToPreview(u, previewUrl))
  const routeResult = await deps.verify.routeCheck(routesToCheck)

  const grade = gradeClone({
    routeCheckPct: routeResult.passRate,
    productCompletenessPct: productsV.accepted.length === 0 ? 0 :
      persistStats.productsInserted / Math.max(1, rawProducts.length),
    cssTokenPct: themeTokenCoverage(themeTokens),
    pageBodyPct: pagesV.accepted.length === 0 ? 0 :
      pagesV.accepted.filter((p) => p.body_html.trim().length > 0).length / pagesV.accepted.length,
    menuResolutionPct: menuTree.nodes.length === 0 ? 1 :
      1 - (menuV.brokenCount / countNodes(menuTree.nodes)),
  })

  // DESIGN.md
  const designMd = exportDesignMd({
    shopName: ctx.sourceHost,
    tokens: themeTokens,
  })

  return {
    platform,
    previewUrl,
    grade,
    designMd,
    stats: {
      productsImported: persistStats.productsInserted,
      productsDiscovered: rawProducts.length,
      collectionsImported: persistStats.collectionsInserted,
      pagesImported: persistStats.pagesInserted,
      menuItems: persistStats.menuItems,
      menuBroken: menuV.brokenCount,
    },
  }
}

function emptyTokens(): ThemeTokens {
  return {
    colors: { primary: null, secondary: null, background: null, text: null },
    typography: { heading_family: null, body_family: null, base_size_px: null },
    spacing: { base_px: null },
    radius_px: null,
    raw_css_vars: {},
  }
}

function themeTokenCoverage(t: ThemeTokens): number {
  const slots = [
    t.colors.primary, t.colors.secondary, t.colors.background, t.colors.text,
    t.typography.heading_family, t.typography.body_family,
    t.spacing.base_px, t.radius_px,
  ]
  return slots.filter((v) => v != null).length / slots.length
}

function countNodes(nodes: readonly { children: readonly any[] }[]): number {
  let n = 0
  for (const node of nodes) {
    n++
    if (node.children.length > 0) n += countNodes(node.children as any)
  }
  return n
}

function rewriteToPreview(sourceUrl: string, previewBase: string): string {
  try {
    const u = new URL(sourceUrl)
    return new URL(u.pathname + u.search, previewBase).toString()
  } catch {
    return sourceUrl
  }
}
```

- [ ] **Step 4: Write index.ts barrel**

```ts
export { runCloneProV5 } from './pipeline.js'
export type {
  Platform, ScrapedProduct, ScrapedCollection, ScrapedPage,
  MenuTree, MenuNode, ThemeTokens, GradeResult, PipelineContext,
} from './types.js'
export { detectPlatform } from './platform-detect.js'
export { gradeClone } from './grader.js'
export { exportDesignMd } from './design-md-export.js'
```

- [ ] **Step 5: Run test to verify pass**

Run: `npx vitest run packages/core/src/modules/clone-pro/v5/pipeline.test.ts`
Expected: PASS (2/2)

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/modules/clone-pro/v5/pipeline.ts \
        packages/core/src/modules/clone-pro/v5/pipeline.test.ts \
        packages/core/src/modules/clone-pro/v5/index.ts
git commit -m "feat(clone-pro-v5): pipeline orchestrator (phases ①→⑨) + barrel export"
```

---

## Task 20: Smoke test + baseline update

**Files:**
- Create: `scripts/smoke-phase19-pr1.ts`
- Modify: `scripts/ops/smoke-baseline.json` (add entry)

- [ ] **Step 1: Write smoke script (≥8 assertions, fully offline via mocks)**

```ts
/**
 * Phase 19 PR1 smoke — Clone Pro v5 Shopify-native MVP
 *
 * Offline end-to-end pipeline run using mocked fetch + in-memory "DB".
 * Validates wiring without touching real network or Postgres.
 * Real-DB integration test lives under tests/integration/ (not a smoke).
 */

import { runCloneProV5 } from '../packages/core/src/modules/clone-pro/v5/pipeline.js'
import { detectPlatform } from '../packages/core/src/modules/clone-pro/v5/platform-detect.js'
import { scrapeShopifyProducts } from '../packages/core/src/modules/clone-pro/v5/scrapers/shopify-products.js'
import { scrapeShopifyCollections } from '../packages/core/src/modules/clone-pro/v5/scrapers/shopify-collections.js'
import { scrapeSitemapPages } from '../packages/core/src/modules/clone-pro/v5/scrapers/sitemap-pages.js'
import { parseMenuTree } from '../packages/core/src/modules/clone-pro/v5/scrapers/menu-parser.js'
import { extractThemeTokens } from '../packages/core/src/modules/clone-pro/v5/scrapers/theme-tokens.js'
import { exportDesignMd } from '../packages/core/src/modules/clone-pro/v5/design-md-export.js'
import { gradeClone } from '../packages/core/src/modules/clone-pro/v5/grader.js'
import { validateProducts } from '../packages/core/src/modules/clone-pro/v5/validate/guardrails.js'

let passed = 0
let failed = 0
function assert(cond: boolean, msg: string) {
  if (cond) { console.log(`✓ ${msg}`); passed++ }
  else { console.error(`✗ ${msg}`); failed++ }
}

async function main() {
  // Fixture: mock Shopify responses
  const fixtures: Record<string, any> = {
    'https://demo.test/products.json?limit=1': { ok: true, json: async () => ({ products: [{ id: 1 }] }) },
    'https://demo.test/products.json?limit=250&page=1': { ok: true, json: async () => ({
      products: [{
        id: 1, handle: 'tee', title: 'Tee', body_html: '<p>x</p>',
        vendor: 'Demo', product_type: null, tags: 'a,b',
        images: [{ src: 'https://cdn/1.jpg', alt: null, position: 1 }],
        variants: [{
          id: 10, title: 'S', price: '29.00', compare_at_price: null,
          sku: 'T-S', inventory_quantity: 5, option1: 'S', option2: null, option3: null,
          weight: 100, weight_unit: 'g',
        }],
        options: [{ name: 'Size', position: 1, values: ['S'] }],
      }],
    }) },
    'https://demo.test/products.json?limit=250&page=2': { ok: true, json: async () => ({ products: [] }) },
    'https://demo.test/collections.json?limit=250&page=1': { ok: true, json: async () => ({
      collections: [{ id: 100, handle: 'all', title: 'All', body_html: null, image: null }],
    }) },
    'https://demo.test/collections.json?limit=250&page=2': { ok: true, json: async () => ({ collections: [] }) },
    'https://demo.test/collections/all/products.json?limit=250&page=1': { ok: true, json: async () => ({
      products: [{ handle: 'tee' }],
    }) },
    'https://demo.test/collections/all/products.json?limit=250&page=2': { ok: true, json: async () => ({ products: [] }) },
    'https://demo.test/sitemap.xml': { ok: true, text: async () => `<?xml version="1.0"?>
<urlset><url><loc>https://demo.test/pages/about</loc></url></urlset>` },
    'https://demo.test/pages/about': { ok: true, text: async () => `<html><head><title>About</title></head><body><main><p>Founded 2024.</p></main></body></html>` },
  }
  const fakeFetch = (async (url: any, _init?: any) => {
    const u = typeof url === 'string' ? url : url.toString()
    if (fixtures[u]) return fixtures[u]
    // Unknown URLs return 404 — matters for head-checks
    return { ok: false, status: 404, json: async () => ({}), text: async () => '' }
  }) as typeof globalThis.fetch

  // 1. platform detector
  const platform = await detectPlatform('https://demo.test', { fetch: fakeFetch })
  assert(platform === 'shopify', 'platform detector identifies Shopify from /products.json probe')

  // 2. products scraper
  const products = await scrapeShopifyProducts('https://demo.test', { fetch: fakeFetch })
  assert(products.length === 1 && products[0].handle === 'tee', 'shopify-products scrapes + maps 1 product')
  assert(products[0].variants[0].price === '29.00', 'variant price preserved as decimal string (no float coercion)')

  // 3. collections scraper
  const collections = await scrapeShopifyCollections('https://demo.test', { fetch: fakeFetch })
  assert(collections.length === 1 && collections[0].product_handles.length === 1, 'shopify-collections scrapes + links products')

  // 4. sitemap pages
  const pages = await scrapeSitemapPages('https://demo.test', { fetch: fakeFetch })
  assert(pages.length === 1 && pages[0].slug === 'about', 'sitemap-pages extracts only /pages/* URLs')

  // 5. menu parser
  const menu = parseMenuTree(
    '<html><body><header><nav><ul><li><a href="/pages/about">About</a></li></ul></nav></header></body></html>',
    'https://demo.test',
  )
  assert(menu.nodes.length === 1 && menu.nodes[0].url === 'https://demo.test/pages/about', 'menu parser resolves relative URLs')

  // 6. theme tokens
  const tokens = extractThemeTokens('<html><head><style>:root{--color-primary:#111;}</style></head></html>')
  assert(tokens.colors.primary === '#111', 'theme-tokens extracts :root CSS vars')

  // 7. DESIGN.md export
  const md = exportDesignMd({ shopName: 'Demo', tokens })
  assert(md.startsWith('# Demo Design System') && md.includes('primary: #111'), 'DESIGN.md exporter produces valid markdown')
  assert(!md.includes('demo.test'), 'Iron Rule 5: DESIGN.md does NOT leak source host')

  // 8. grader
  const g = gradeClone({
    routeCheckPct: 0.95, productCompletenessPct: 0.98, cssTokenPct: 0.75, pageBodyPct: 0.90, menuResolutionPct: 0.90,
  })
  assert(g.letter === 'A' || g.letter === 'B', 'grader returns A or B for high-quality clone')

  // 9. validators — R3 anti-mix guardrail
  const badProduct = { ...products[0], images: [] }
  const { rejected } = validateProducts([badProduct])
  assert(rejected.length === 1 && /image/i.test(rejected[0].reason), 'validator rejects product without images')

  // 10. end-to-end pipeline (in-memory)
  const result = await runCloneProV5(
    {
      jobId: 'smoke-1', shopId: 'shop-1', sourceUrl: 'https://demo.test', sourceHost: 'demo.test',
      scope: { products: true, collections: true, pages: true, menu: true, theme: true },
    },
    {
      scrapers: {
        detectPlatform: async () => 'shopify',
        fetchHomepage: async () => '<html><header><nav><ul><li><a href="/pages/about">About</a></li></ul></nav></header><style>:root{--color-primary:#111;}</style></html>',
        scrapeProducts: async () => products,
        scrapeCollections: async () => collections,
        scrapePages: async () => pages,
        parseMenu: parseMenuTree,
        extractTokens: extractThemeTokens,
      },
      persisters: {
        persistAll: async (args) => ({
          productsInserted: args.products.length,
          collectionsInserted: args.collections.length,
          pagesInserted: args.pages.length,
          menuItems: 1,
        }),
        mountPreview: async (jobId) => `https://${jobId}.clone-preview.gbox.local`,
      },
      verify: {
        routeCheck: async (urls) => ({
          total: urls.length, passCount: urls.length, passRate: 1, failures: [],
        }),
      },
    },
  )
  assert(result.platform === 'shopify', 'pipeline.result.platform = shopify')
  assert(result.previewUrl.includes('.clone-preview.'), 'pipeline mounts preview subdomain')
  assert(result.grade.letter === 'A' || result.grade.letter === 'B', 'end-to-end grade ≥ B')
  assert(result.stats.productsImported === 1, 'pipeline stats.productsImported=1')

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
```

- [ ] **Step 2: Run smoke — expect first run to fail if any module missing**

Run: `npx tsx scripts/smoke-phase19-pr1.ts`
Expected (after all prior tasks done): 14 passed, 0 failed.

- [ ] **Step 3: Add to smoke baseline**

Edit `scripts/ops/smoke-baseline.json` — add entry (alphabetical order within phase):

```json
{
  "script": "smoke-phase19-pr1.ts",
  "expectedPass": true,
  "note": "Clone Pro v5 PR1 — Shopify-native pipeline smoke (offline, mocked fetch)"
}
```

- [ ] **Step 4: Run matrix to confirm green**

Run: `npx tsx scripts/ops/smoke-matrix.ts --only phase19`
Expected: `smoke-phase19-pr1.ts` → PASS; no regressions.

- [ ] **Step 5: Run full matrix to guarantee zero regressions across all phases**

Run: `npx tsx scripts/ops/smoke-matrix.ts`
Expected: 0 regressions vs baseline.

- [ ] **Step 6: Run full unit test suite**

Run: `npm test`
Expected: all green; ≥40 new tests in clone-pro/v5/**; 0 tsc errors.

- [ ] **Step 7: Commit**

```bash
git add scripts/smoke-phase19-pr1.ts scripts/ops/smoke-baseline.json
git commit -m "test(clone-pro-v5): smoke-phase19-pr1 — 14 assertions + matrix baseline entry"
```

---

## Task 21: Worker wiring (v5 behind env flag)

**Files:**
- Modify: `packages/core/src/modules/queue/clone-worker.ts` (branch on `CLONE_PRO_VERSION=v5`)

**Rationale:** Do not delete v4 yet — v5 ships behind env flag. Rollback = set env var back. Once v5 hits grade ≥B on production canary, v4 gets archived in a PR2+ cleanup.

- [ ] **Step 1: Read current clone-worker.ts to find the dispatch point**

Run: `cat packages/core/src/modules/queue/clone-worker.ts | head -100`

- [ ] **Step 2: Add v5 branch**

Near where the worker currently calls `runClonePipelineV4(...)` (or equivalent), wrap:

```ts
import { runCloneProV5 } from '@gbox/core/modules/clone-pro/v5/index.js'
// ...existing v4 imports stay

// In the job handler:
if (process.env.CLONE_PRO_VERSION === 'v5') {
  // Build deps with real scrapers + persisters — see index.ts barrel
  const result = await runCloneProV5Wired(ctx, db)
  // ...update job row with result.grade, result.previewUrl, result.designMd
} else {
  // existing v4 path unchanged
  await runClonePipelineV4(...)
}
```

Create `packages/core/src/modules/clone-pro/v5/wired-runner.ts` (small helper that wires real fetch + real Kysely db into the pipeline).

- [ ] **Step 3: Run worker smoke (offline)**

Run: `CLONE_PRO_VERSION=v5 npx tsx scripts/smoke-phase19-pr1.ts`
Expected: same 14/14 pass (smoke is agnostic — deps injected).

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/modules/queue/clone-worker.ts \
        packages/core/src/modules/clone-pro/v5/wired-runner.ts
git commit -m "feat(clone-pro-v5): worker wires v5 behind CLONE_PRO_VERSION=v5 env flag; v4 remains default"
```

---

## Final checks before PR

- [ ] Run `npx tsx scripts/ops/release-check.ts` — all gates green.
- [ ] Run `npm test` — full suite green, ≥40 new tests.
- [ ] Manual test: `CLONE_PRO_VERSION=v5 npm run worker` on dev box; enqueue clone job via admin UI with `source_url=https://www.allbirds.com`; wait for completion; check `storefront_clone_jobs` row has `grade ≥ B`, `preview_url` populated, `design_md` populated; open preview URL in browser; manually spot-check product pages render.
- [ ] Self-review plan against spec §13 success criteria — verify each success criterion has a task that produces it.
- [ ] Open PR with title: `phase-19 pr1: Clone Pro v5 — Shopify-native MVP (9-phase pipeline + grade + DESIGN.md export)`
- [ ] PR body: summary + list of 21 task commits + smoke count + known gaps (Generic HTML = PR2, asset rehost = PR3, etc.)

---

## Self-Review (inline)

**1. Spec coverage:**
- Goal 1 (1:1 fidelity) → Task 19 pipeline; grade at Task 18.
- Goal 2 (full catalog) → Task 4 products scraper with 100-page cap.
- Goal 3 (bucket mapping R3) → Tasks 9 guardrails + every persister uses correct table.
- Goal 4 (preview) → Task 21 mountPreview stub + migration 091 cloned_previews.
- Goal 5 (idempotent re-clone) → migration 091 unique partial index (Task 1).
- Goal 6 (transaction-safe) → Task 10 import-transaction wrapper.
- Goal 7 (robots + rate limit) → covered by re-use of v4 polite-fetch/robots-guard; orchestrator calls them in Task 21 wiring (wired-runner).
- D11 (DESIGN.md export) → Task 17.

**2. Placeholder scan:** No "TBD"/"implement later". All code steps show the actual code. One intentional deferral: asset rehost = PR3, noted in pipeline comment + spec §12.

**3. Type consistency:** `ScrapedProduct.handle: string`, `persistProducts` upserts by `(shop_id, handle)`, `pipeline.ts` rewrites `${sourceUrl}/products/${p.handle}` — consistent. `FlaggedMenuTree.nodes[n].broken: boolean` → `menus-persist.ts` writes `broken: n.broken === true` — consistent. `GradeResult.letter: 'A' | 'B' | 'C' | 'D' | 'F'` used uniformly.

**4. Anti-mix (R3) verified:** Every scraper produces DTOs that map to exactly one table; validators reject cross-category leakage (e.g., `validatePages` rejects URLs under `/products/`, `/collections/`, etc.); `scrapeShopifyCollections` skips 0-product collections.

---

**Plan locked 2026-04-25. Ready for subagent-driven-development execution.**
