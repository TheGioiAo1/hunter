# Phase 01 — Sprint 1: Port Lonspy Core to TypeScript

**Date:** 2026-04-26 → 2026-05-01 (5 days)
**Priority:** CRITICAL — blocking Sprint 2-5
**Branch:** `feat/v7-pr1-lonspy-core`
**Base:** `master` (post-Phase 21)

## Context

- **Spec**: `docs/superpowers/specs/2026-04-26-clone-pro-v7-bulk-catalog-spec.md`
- **Source code Lonspy**: `_course-material/lonspy-extracted/Lonspy-V3.0-master/Lonspy V3.0/`
  - `Helpers/CrawlHelper.cs` (321 lines) — HTTP request + Playwright emulator + XPath extract
  - `Models/Lonspy/Row.cs` (147 lines) — Data shape
  - `Services/LonspyService.cs` (96 lines) — DataTable → Row converter
  - `ConfigSite/*.json` (24 platform configs)

## Key Insights

- Lonspy core logic là HtmlAgilityPack `SelectSingleNode(xpath)` + `attr` + `replaces[]` rules
- TypeScript equivalent: cheerio + `xpath-html` package (hoặc `htmlparser2` + custom XPath eval)
- Playwright đã có sẵn ở `packages/core/src/modules/clone-pro/v6/stages/stage3-render.ts`
- 24 ConfigSite configs đã test với production sites (lencam, etycloset, brylanehome,
  shopify-new, wp, etc.) → KHÔNG sửa logic, chỉ port

## Requirements

R1. Port toàn bộ logic CrawlHelper.cs → TypeScript, giữ semantic identical
R2. Convert 24 ConfigSite/*.json → format TypeScript-friendly (giữ XPath nguyên)
R3. Tạo riêng `shopify-hydrogen.json` cho Hydrogen 2.0 (bibliobloom dùng Hydrogen)
R4. Bulk crawler: listing → detail, 5 concurrent + 2000ms delay + 3 retry
R5. Output JSON shape match `Row` interface (compatible với Stage 7 persisters v6)
R6. CLI standalone: `npx tsx scripts/clone-pro-crawl.ts --url=X --config=Y --limit=N`

## Architecture

```
packages/core/src/modules/clone-pro/v7-crawler/
├── types.ts                      # Config, Element, Replace, Row interfaces
├── xpath-engine.ts               # Port HtmlAgilityPack SelectNodes/Single + replaces
├── http-fetch.ts                 # got HTTP request với UA pool + retry
├── playwright-emulator.ts        # Reuse v6 stage3 render với XPath wait
├── platform-detector.ts          # Detect Shopify/Hydrogen/WP/BC/SB từ HTML signature
├── config-loader.ts              # Load configs/lonspy/<platform>.json
├── listing-crawler.ts            # Bulk crawl collection pages → product URLs
├── detail-crawler.ts             # Bulk crawl product pages → full Row data
├── orchestrator.ts               # Main entry: crawlSite(url, opts) → CrawlResult
├── configs/                      # Ported configs
│   ├── shopify-classic.json
│   ├── shopify-hydrogen.json     # NEW
│   ├── woocommerce.json
│   ├── bigcommerce.json
│   ├── shopbase.json
│   └── ...
└── __tests__/                    # Vitest unit tests
    ├── xpath-engine.test.ts      # 15+ test
    ├── platform-detector.test.ts # 10+ test
    ├── config-loader.test.ts     # 5+ test
    ├── listing-crawler.test.ts   # 8+ test
    └── detail-crawler.test.ts    # 12+ test
```

## Related code files

- `packages/core/src/modules/clone-pro/v6/stages/stage3-render.ts` — playwright reuse
- `packages/core/src/modules/clone-pro/v6/stages/stage1-sitemap.ts` — UA pool + retry pattern
- `packages/core/src/modules/clone-pro/v6/dto.ts` — Row → ProductScrapedDto mapper

---

## Implementation Steps

### Task 1.1: Setup module structure + types (~2h)

**Files:**
- Create: `packages/core/src/modules/clone-pro/v7-crawler/types.ts`
- Create: `packages/core/src/modules/clone-pro/v7-crawler/index.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// __tests__/types.test.ts
import { describe, it, expect } from 'vitest'
import type { Config, Element, Replace, Row, CrawlResult } from '../types.js'

describe('v7-crawler types', () => {
  it('Config has delay + item.xpath + item.elements', () => {
    const cfg: Config = {
      delay: 2000,
      item: { xpath: '//article', elements: [{ name: 'Title', xpath: './/h1', attr: null, replaces: null }] },
    }
    expect(cfg.delay).toBe(2000)
    expect(cfg.item.elements[0].name).toBe('Title')
  })
  it('Row has Title + ImageUrls + Description + Price + variants', () => {
    const row: Row = {
      Title: 'X', ImageUrls: ['a.jpg'], Description: 'D', Price: 9.99, OldPrice: 12,
      tags: ['t1'], short_description: 's', seo_description: 'q',
      Spin: ['v1'], Link: 'http://x', ImageUrlType: 'ONLINE',
    }
    expect(row.Title).toBe('X')
  })
})
```

- [ ] **Step 2: Run test → FAIL "Cannot find module ../types"**

```bash
npx vitest run packages/core/src/modules/clone-pro/v7-crawler/__tests__/types.test.ts
```

- [ ] **Step 3: Write minimal types.ts**

```typescript
export interface Replace { from: string; to: string }
export interface Element { name: string; xpath: string; attr: string | null; replaces: Replace[] | null }
export interface Item { xpath: string; elements: Element[]; images_in_detail?: Element }
export interface Config { delay: number; item: Item; platform?: string }
export interface Row {
  Num?: number
  Title: string | null
  TitleNew?: string | null
  ImageUrls: string[]
  Description: string | null
  short_description?: string | null
  seo_description?: string | null
  tags?: string[] | null
  Price: number | null
  OldPrice?: number | null
  Spin?: string[] | null
  Link: string | null
  ImageUrlType?: 'ONLINE' | 'OFFLINE'
}
export interface CrawlResult {
  source_url: string
  platform: string
  config_used: string
  products: Row[]
  collections: { handle: string; title: string; product_handles: string[] }[]
  pages: { handle: string; title: string; body_html: string }[]
  warnings: string[]
}
```

- [ ] **Step 4: Run test → PASS**

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/modules/clone-pro/v7-crawler/types.ts \
        packages/core/src/modules/clone-pro/v7-crawler/__tests__/types.test.ts
git commit -m "feat(v7-pr1): types — Config/Element/Row/CrawlResult interfaces"
```

---

### Task 1.2: Port xpath-engine (~4h, biggest task)

**Files:**
- Create: `packages/core/src/modules/clone-pro/v7-crawler/xpath-engine.ts`
- Create: `__tests__/xpath-engine.test.ts`

**What to port:** `Helpers/CrawlHelper.cs::GetValueSingleNode` + `GetValueNodes`

- [ ] **Step 1: Install deps**

```bash
cd packages/core && pnpm add cheerio xpath-html htmlparser2
pnpm add -D @types/cheerio
```

- [ ] **Step 2: Write failing tests** (15 cases covering XPath + replaces)

```typescript
import { describe, it, expect } from 'vitest'
import { extractValue, extractValues, applyReplaces } from '../xpath-engine.js'

describe('xpath-engine', () => {
  const html = `<html><body>
    <article class="item collection-product">
      <div class="image-container">
        <a href="/products/widget" title="Widget">
          <img data-src="//cdn.shopify.com/x_480x.jpg">
        </a>
      </div>
      <span class="sell-price">$29.99</span>
    </article>
  </body></html>`

  it('extractValue returns text by xpath', () => {
    const v = extractValue(html, '//span[@class="sell-price"]', null)
    expect(v).toBe('$29.99')
  })
  it('extractValue returns attr', () => {
    const v = extractValue(html, '//div[@class="image-container"]/a', 'title')
    expect(v).toBe('Widget')
  })
  it('extractValues returns array', () => {
    const v = extractValues(html, '//article')
    expect(v.length).toBe(1)
  })
  it('applyReplaces removes Shopify _480x suffix', () => {
    const out = applyReplaces('//cdn.shopify.com/x_480x.jpg', [{ from: '_480x', to: '' }])
    expect(out).toBe('//cdn.shopify.com/x.jpg')
  })
  it('applyReplaces multiple rules in order', () => {
    const out = applyReplaces('$29.99 USD', [{ from: '$', to: '' }, { from: ' USD', to: '' }])
    expect(out).toBe('29.99')
  })
  it('extractValue returns empty string khi xpath không match', () => {
    const v = extractValue(html, '//nope', null)
    expect(v).toBe('')
  })
  it('extractValues returns empty array khi xpath không match', () => {
    const v = extractValues(html, '//nope')
    expect(v).toEqual([])
  })
  // ... 8 cases more cho HTML decode, contains(), //article//span, etc.
})
```

- [ ] **Step 3: Implement xpath-engine.ts**

```typescript
import * as cheerio from 'cheerio'
import { fromPageSource } from 'xpath-html'  // Pure XPath 1.0
import he from 'he'
import type { Replace } from './types.js'

export function extractValue(html: string, xpath: string, attr: string | null): string {
  try {
    const node = fromPageSource(html).findElement(xpath)
    if (!node) return ''
    if (attr) return he.decode(node.getAttribute(attr) ?? '')
    return he.decode(node.getText() ?? '')
  } catch {
    return ''
  }
}

export function extractValues(html: string, xpath: string, attr: string | null = null): string[] {
  try {
    const nodes = fromPageSource(html).findElements(xpath)
    return nodes.map(n => {
      const v = attr ? n.getAttribute(attr) : n.getText()
      return he.decode(v ?? '')
    }).filter(Boolean)
  } catch {
    return []
  }
}

export function applyReplaces(value: string, replaces: Replace[] | null): string {
  if (!replaces) return value
  let out = value
  for (const r of replaces) out = out.split(r.from).join(r.to)
  return out
}
```

- [ ] **Step 4: Run tests → 15/15 PASS**

```bash
npx vitest run packages/core/src/modules/clone-pro/v7-crawler/__tests__/xpath-engine.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/modules/clone-pro/v7-crawler/xpath-engine.ts \
        packages/core/src/modules/clone-pro/v7-crawler/__tests__/xpath-engine.test.ts \
        packages/core/package.json packages/core/pnpm-lock.yaml
git commit -m "feat(v7-pr1): xpath-engine — port HtmlAgilityPack SelectSingleNode + replaces"
```

---

### Task 1.3: HTTP fetch + UA pool + retry (~2h)

**Files:**
- Create: `packages/core/src/modules/clone-pro/v7-crawler/http-fetch.ts`

- [ ] **Step 1: Failing test**

```typescript
// Use msw to mock fetch
import { describe, it, expect } from 'vitest'
import { httpFetchHtml } from '../http-fetch.js'

describe('http-fetch', () => {
  it('returns html on 200', async () => {
    const html = await httpFetchHtml('https://httpbin.org/html')
    expect(html).toContain('<html')
  })
  it('rotates UA on retry after 429', async () => {
    // Setup msw mock returning 429 on first call, 200 on second
    // ... assert UA differ between calls
  })
  it('throws after 3 retries', async () => {
    await expect(httpFetchHtml('https://httpbin.org/status/500')).rejects.toThrow(/HTTP 500/)
  })
})
```

- [ ] **Step 2-4: Implement httpFetchHtml với pRetry, UA pool từ Lonspy uaDesktop.txt + uaMobile.txt**

```typescript
import got from 'got'
import pRetry from 'p-retry'

const UA_POOL = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ... Chrome/120.0.0.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ...',
  // 8+ UAs ported from Lonspy uaDesktop.txt
]

export async function httpFetchHtml(url: string, opts: { timeout?: number } = {}): Promise<string> {
  return pRetry(async () => {
    const ua = UA_POOL[Math.floor(Math.random() * UA_POOL.length)]
    const res = await got(url, {
      headers: { 'user-agent': ua, accept: 'text/html', 'accept-language': 'en-US,en;q=0.9' },
      timeout: { request: opts.timeout ?? 30_000 },
      retry: { limit: 0 },  // pRetry handles retry
    })
    return res.body
  }, {
    retries: 3,
    minTimeout: 2000,
    factor: 2,  // exponential: 2s, 4s, 8s
    onFailedAttempt: (e) => {
      if (e.response?.statusCode === 404) throw e  // don't retry 404
    },
  })
}
```

- [ ] **Step 5: Commit** `feat(v7-pr1): http-fetch — got + UA pool + 3 retry exponential backoff`

---

### Task 1.4: Platform detector (~2h)

Detect Shopify/Hydrogen/WP/BigCommerce/Shopbase từ HTML meta tags.

**Files:**
- Create: `packages/core/src/modules/clone-pro/v7-crawler/platform-detector.ts`

- [ ] **Test cases (10 case)**:
  - `<meta name="generator" content="Shopify">` → 'shopify-classic'
  - `<script src="https://cdn.shopify.com/s/files/...">` → 'shopify-classic'
  - `Shopify.theme` JS object detected → 'shopify-classic'
  - `<meta name="generator" content="Hydrogen">` → 'shopify-hydrogen'
  - `__remixContext` script tag → 'shopify-hydrogen' (Hydrogen 2.0 uses Remix)
  - `wp-content/themes/...` → 'woocommerce'
  - `bigcommerce.com` resources → 'bigcommerce'
  - `shopbase.com` analytics → 'shopbase'
  - Generic ecommerce no signature → 'unknown' (use AI fallback)

- [ ] **Implementation:**

```typescript
export type Platform = 'shopify-classic' | 'shopify-hydrogen' | 'woocommerce' | 'bigcommerce' | 'shopbase' | 'unknown'

export function detectPlatform(html: string, url: string): Platform {
  const lower = html.toLowerCase()
  // Hydrogen first (since Hydrogen also uses cdn.shopify.com)
  if (/__remixcontext|hydrogen|@shopify\/hydrogen/.test(lower)) return 'shopify-hydrogen'
  if (/<meta name="generator" content="hydrogen/.test(lower)) return 'shopify-hydrogen'
  // Then classic Shopify
  if (/cdn\.shopify\.com|shopify\.theme|<meta name="generator" content="shopify/.test(lower)) return 'shopify-classic'
  if (/wp-content|wp-includes|woocommerce/.test(lower)) return 'woocommerce'
  if (/bigcommerce\.com|stencil-utils/.test(lower)) return 'bigcommerce'
  if (/shopbase\.com|sbase-cdn/.test(lower)) return 'shopbase'
  return 'unknown'
}
```

- [ ] **Commit** `feat(v7-pr1): platform-detector — Shopify/Hydrogen/WP/BC/SB auto-detect`

---

### Task 1.5: Config loader + 24 configs port (~3h)

**Files:**
- Create: `packages/core/src/modules/clone-pro/v7-crawler/config-loader.ts`
- Create: `packages/core/src/modules/clone-pro/v7-crawler/configs/*.json` (24 files)

- [ ] **Port script** copy 24 ConfigSite/*.json sang configs/, validate schema

```bash
node scripts/v7/port-lonspy-configs.js \
  --src='_course-material/lonspy-extracted/Lonspy-V3.0-master/Lonspy V3.0/ConfigSite' \
  --dst='packages/core/src/modules/clone-pro/v7-crawler/configs'
```

- [ ] **Tạo `shopify-hydrogen.json`** mới (Hydrogen 2.0 uses different selectors):

```json
{
  "platform": "shopify-hydrogen",
  "delay": 2000,
  "item": {
    "xpath": "//div[@data-testid='product-card' or contains(@class, 'product-card')]",
    "elements": [
      { "name": "Title", "xpath": ".//h3 | .//h2 | .//*[contains(@class, 'product-title')]", "attr": null, "replaces": null },
      { "name": "Image", "xpath": ".//img[@src or @data-src]", "attr": "src", "replaces": [{ "from": "?width=", "to": "?w=" }] },
      { "name": "Link", "xpath": ".//a[contains(@href, '/products/')]", "attr": "href", "replaces": null },
      { "name": "Price", "xpath": ".//*[contains(@class, 'price') or @data-testid='price']", "attr": null, "replaces": [{ "from": "$", "to": "" }, { "from": "USD", "to": "" }] }
    ],
    "images_in_detail": {
      "name": "GalleryImages",
      "xpath": "//div[contains(@class, 'product-gallery') or contains(@class, 'product-images')]//img",
      "attr": "src",
      "replaces": null
    }
  }
}
```

- [ ] **config-loader.ts**:

```typescript
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Config, Platform } from './types.js'

const CONFIG_DIR = join(__dirname, 'configs')

export function loadConfig(platform: Platform): Config {
  if (platform === 'unknown') throw new Error('No config for unknown platform')
  const file = `${platform}.json`
  const raw = readFileSync(join(CONFIG_DIR, file), 'utf8')
  const cfg: Config = JSON.parse(raw)
  cfg.platform = platform
  return cfg
}
```

- [ ] **Commit** `feat(v7-pr1): config-loader + 24 platform configs ported (incl shopify-hydrogen)`

---

### Task 1.6: Listing crawler (~3h)

Bulk crawl collection pages → harvest ALL product URLs (paginate).

**Files:**
- Create: `packages/core/src/modules/clone-pro/v7-crawler/listing-crawler.ts`

- [ ] **Test cases (8)**: pagination detection, dedup URLs, respect products_limit, etc.
- [ ] **Implementation outline:**

```typescript
import pLimit from 'p-limit'
import { httpFetchHtml } from './http-fetch.js'
import { extractValues, applyReplaces, extractValue } from './xpath-engine.js'
import type { Config } from './types.js'

export interface ListingResult {
  product_urls: string[]
  collection_handle: string | null
  total_pages_crawled: number
}

export async function crawlListing(
  collectionUrl: string,
  config: Config,
  opts: { limit?: number | null; concurrency?: number } = {},
): Promise<ListingResult> {
  const limit = pLimit(opts.concurrency ?? 5)
  const seen = new Set<string>()
  const productUrls: string[] = []
  let page = 1
  const maxPages = 100

  while (productUrls.length < (opts.limit ?? Infinity) && page <= maxPages) {
    const pageUrl = page === 1 ? collectionUrl : `${collectionUrl}?page=${page}`
    const html = await httpFetchHtml(pageUrl)
    const items = extractValues(html, config.item.xpath)
    if (items.length === 0) break
    for (const itemHtml of items) {
      const linkEl = config.item.elements.find(e => e.name === 'Link')
      if (!linkEl) continue
      let url = extractValue(itemHtml, linkEl.xpath, linkEl.attr)
      url = applyReplaces(url, linkEl.replaces)
      if (!url || seen.has(url)) continue
      seen.add(url)
      productUrls.push(url.startsWith('http') ? url : new URL(url, collectionUrl).toString())
      if (opts.limit && productUrls.length >= opts.limit) break
    }
    page++
    await new Promise(r => setTimeout(r, config.delay))
  }
  return { product_urls: productUrls, collection_handle: null, total_pages_crawled: page - 1 }
}
```

- [ ] **Commit** `feat(v7-pr1): listing-crawler — paginate + harvest URLs với products_limit`

---

### Task 1.7: Detail crawler (~4h, biggest implementation task)

Crawl từng product detail page → full Row data.

**Files:**
- Create: `packages/core/src/modules/clone-pro/v7-crawler/detail-crawler.ts`

- [ ] **Test cases (12)**: full row, gallery images, variants, decimal prices, missing fields, retry, etc.
- [ ] **Implementation:**

```typescript
import pLimit from 'p-limit'
import { httpFetchHtml } from './http-fetch.js'
import { extractValue, extractValues, applyReplaces } from './xpath-engine.js'
import type { Config, Row } from './types.js'

export async function crawlDetails(
  productUrls: string[],
  config: Config,
  opts: { concurrency?: number } = {},
): Promise<{ rows: Row[]; failed_urls: string[] }> {
  const limit = pLimit(opts.concurrency ?? 5)
  const failed: string[] = []
  const rows = await Promise.all(
    productUrls.map(url =>
      limit(async () => {
        try {
          await new Promise(r => setTimeout(r, config.delay))
          const html = await httpFetchHtml(url)
          return extractRowFromDetail(html, url, config)
        } catch (e) {
          failed.push(url)
          return null
        }
      }),
    ),
  )
  return { rows: rows.filter(Boolean) as Row[], failed_urls: failed }
}

function extractRowFromDetail(html: string, url: string, cfg: Config): Row {
  const detailEls = cfg.item.elements
  const titleEl = detailEls.find(e => e.name === 'Title')
  const priceEl = detailEls.find(e => e.name === 'Price')
  const oldPriceEl = detailEls.find(e => e.name === 'OldPrice')
  const descEl = detailEls.find(e => e.name === 'Description')
  const variantsEl = detailEls.find(e => e.name === 'Variants')
  const galleryEl = cfg.item.images_in_detail

  const title = applyReplaces(extractValue(html, titleEl?.xpath ?? '', titleEl?.attr ?? null), titleEl?.replaces ?? null)
  const priceStr = applyReplaces(extractValue(html, priceEl?.xpath ?? '', null), priceEl?.replaces ?? null)
  const price = parseFloat(priceStr) || null
  const oldPriceStr = applyReplaces(extractValue(html, oldPriceEl?.xpath ?? '', null), oldPriceEl?.replaces ?? null)
  const oldPrice = parseFloat(oldPriceStr) || null
  const description = extractValue(html, descEl?.xpath ?? '', null)
  const galleryImages = galleryEl ? extractValues(html, galleryEl.xpath, galleryEl.attr).map(u => applyReplaces(u, galleryEl.replaces ?? null)) : []
  const variants = variantsEl ? extractValues(html, variantsEl.xpath, variantsEl.attr) : []

  return {
    Title: title || null,
    ImageUrls: galleryImages,
    Description: description || null,
    Price: price,
    OldPrice: oldPrice,
    Spin: variants.length > 0 ? variants : null,
    Link: url,
    ImageUrlType: 'ONLINE',
    tags: null,
    short_description: null,
    seo_description: null,
  }
}
```

- [ ] **Commit** `feat(v7-pr1): detail-crawler — full Row extract với gallery + variants`

---

### Task 1.8: Orchestrator + CLI smoke test (~2h)

**Files:**
- Create: `packages/core/src/modules/clone-pro/v7-crawler/orchestrator.ts`
- Create: `scripts/clone-pro-crawl.ts` (CLI smoke)

- [ ] **orchestrator.ts:**

```typescript
import { httpFetchHtml } from './http-fetch.js'
import { detectPlatform } from './platform-detector.js'
import { loadConfig } from './config-loader.js'
import { crawlListing } from './listing-crawler.js'
import { crawlDetails } from './detail-crawler.js'
import type { CrawlResult } from './types.js'

export async function crawlSite(
  url: string,
  opts: { products_limit?: number | null; concurrency?: number } = {},
): Promise<CrawlResult> {
  const homeHtml = await httpFetchHtml(url)
  const platform = detectPlatform(homeHtml, url)
  if (platform === 'unknown') throw new Error('Unknown platform — AI fallback needed')

  const config = loadConfig(platform)
  // For now: assume url is collection (Sprint 2 sẽ add sitemap discovery)
  const listing = await crawlListing(url, config, { limit: opts.products_limit, concurrency: opts.concurrency })
  const detail = await crawlDetails(listing.product_urls, config, { concurrency: opts.concurrency })

  return {
    source_url: url,
    platform,
    config_used: `${platform}.json`,
    products: detail.rows,
    collections: [],  // Sprint 2 sẽ add
    pages: [],        // Sprint 2 sẽ add
    warnings: detail.failed_urls.length > 0
      ? [`${detail.failed_urls.length} products failed to crawl`]
      : [],
  }
}
```

- [ ] **CLI: scripts/clone-pro-crawl.ts**

```typescript
#!/usr/bin/env -S npx tsx
import { writeFileSync } from 'node:fs'
import { crawlSite } from '@gbox/core/modules/clone-pro/v7-crawler/orchestrator.js'

const argv = process.argv.slice(2)
const url = argv.find(a => a.startsWith('--url='))?.split('=')[1]
const limitArg = argv.find(a => a.startsWith('--limit='))?.split('=')[1]
const out = argv.find(a => a.startsWith('--out='))?.split('=')[1] ?? './crawl-result.json'
if (!url) { console.error('--url required'); process.exit(1) }

const limit = limitArg ? parseInt(limitArg, 10) : null
const result = await crawlSite(url, { products_limit: limit, concurrency: 5 })
writeFileSync(out, JSON.stringify(result, null, 2))
console.log(`✓ Crawled ${result.products.length} products from ${result.platform}`)
console.log(`  → ${out}`)
```

- [ ] **Live smoke test (acceptance gate Sprint 1):**

```bash
npx tsx scripts/clone-pro-crawl.ts \
  --url=https://www.bibliobloom.com/collections/all \
  --limit=10 \
  --out=./tmp/bibliobloom-10.json

# Assert:
# - 10 products in result.products
# - mỗi product có Title, Description (≥200 chars), ImageUrls (≥3 items)
# - platform = 'shopify-hydrogen'
node -e "const r=require('./tmp/bibliobloom-10.json'); console.assert(r.products.length===10); console.assert(r.products.every(p=>p.ImageUrls.length>=3))"
```

- [ ] **Commit** `feat(v7-pr1): orchestrator + CLI smoke — bibliobloom.com 10 products full data`

---

## Todo list (Sprint 1)

- [ ] Task 1.1 Setup module + types (2h)
- [ ] Task 1.2 Port xpath-engine + 15 unit tests (4h)
- [ ] Task 1.3 HTTP fetch + UA pool + retry (2h)
- [ ] Task 1.4 Platform detector + 10 unit tests (2h)
- [ ] Task 1.5 Config loader + 24 configs port + shopify-hydrogen.json (3h)
- [ ] Task 1.6 Listing crawler + 8 unit tests (3h)
- [ ] Task 1.7 Detail crawler + 12 unit tests (4h)
- [ ] Task 1.8 Orchestrator + CLI smoke + live bibliobloom test (2h)

**Total: ~22h work / 5 days (4-5h/day work).**

## Success Criteria

- [ ] 50+ unit tests pass (vitest)
- [ ] CLI smoke `--url=bibliobloom.com --limit=10` ra 10 products full data
- [ ] mỗi product có ≥3 images, description ≥200 chars
- [ ] platform detection đúng cho 5+ test sites (shopify-classic, hydrogen, wp, bc, sb)
- [ ] PR `feat/v7-pr1-lonspy-core` mở + smoke pass + Thai review

## Risk Assessment

| Risk | Mitigation |
|------|-----------|
| `xpath-html` package không support full XPath 1.0 | Fallback: dùng `cheerio` + custom recursive walker cho complex xpath |
| Hydrogen 2.0 SSR shell only — products load qua JS | Sprint 1.4 detect Hydrogen → Sprint 1.7 detail-crawler dùng Playwright thay HTTP fetch |
| Cloudflare ban IP local khi smoke test | Q2 đã set safe mode 5 concurrent + 2000ms; nếu ban → smoke từ server 1 |
| 24 configs port có lỗi schema | Task 1.5 validation script catch sớm |

## Security Considerations

- HTTP fetch không follow redirect tới untrusted domains (got default OK)
- XPath injection: configs là static JSON, không user input → không cần sanitize
- UA rotation hợp pháp (mọi request có UA chính danh, không spoof)

## Next steps

Sprint 1 done → mở PR `feat/v7-pr1-lonspy-core` → Thai review + merge → Sprint 2 start.
