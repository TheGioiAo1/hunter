# PLAN: Website Cloner Pro — Clone Any Website Into a Gbox Store

**Date:** 2026-04-13
**Owner:** Thai Bui (buithai3107@gmail.com)
**Status:** APPROVED FOR IMPLEMENTATION

---

## Executive Summary

Build a **full-website cloning tool** inside the Gbox Store Admin that lets a merchant paste any e-commerce website URL and clone it into a fully operational Gbox store — including visual design, products, pages, blog posts, navigation menus, images, SEO metadata, and theme.

**Key Insight:** ~70% of the infrastructure already exists in the codebase:
- `clone-shopify/` — Product crawler, sitemap walker, SSRF-safe fetcher
- `clone-pro/` — Universal crawler, platform detector, design extractor, AI bridge (types + stubs)
- `storefront-clone/` — Job orchestrator, product persistence, media ingestion, brand kit extraction
- BullMQ queue, notifications, SSE streaming — all ready

**What's missing:** Page/blog/menu/collection crawlers, theme generator, full CSS cloner, and wiring everything together into the Clone Pro pipeline.

---

## Phase 0: Foundation Already Built (No Work Needed)

These components are **already implemented and tested**:

| Component | Location | Status |
|-----------|----------|--------|
| SSRF-safe HTTP fetcher | `packages/core/src/modules/clone-shopify/safe-fetch.ts` | Ready |
| Shopify /products.json crawler | `clone-shopify/crawler-products.ts` | Ready |
| Sitemap XML walker | `clone-shopify/crawler-sitemap.ts` | Ready |
| Clone job DB table + CRUD | `storefront-clone/job-store.ts` | Ready |
| Job orchestrator (stage tracking) | `storefront-clone/run.ts` | Ready |
| Product upsert (dedup by source_external_id) | `storefront-clone/persist-products.ts` | Ready |
| Media download + S3/R2 upload | `storefront-clone/media-ingest.ts` | Ready |
| Brand kit CSS extraction | `storefront-clone/brand-kit-extractor.ts` | Ready |
| Platform detector (10 platforms) | `clone-pro/platform-detector.ts` | Ready |
| Clone Pro types + pipeline skeleton | `clone-pro/types.ts`, `pipeline.ts` | Types ready, pipeline stubbed |
| SSE real-time progress stream | `store-admin/pages/storefront-clone.ts` | Ready |
| Notification system | `core/modules/notifications/service.ts` | Ready |
| BullMQ queue infrastructure | `core/modules/queue/` | Ready |
| Page/Blog/Menu CRUD services | `core/modules/content/service.ts` | Ready |
| Theme + ThemeAsset services | `core/modules/themes/service.ts` | Ready |
| R2 object storage | `core/modules/storage/r2-store.ts` | Ready |

---

## Phase 1: HTML Scraper Engine + Cheerio Integration
**Effort:** 1-2 sessions | **Risk:** Low

### Why
Current crawlers use regex-based HTML parsing. For full website cloning (pages, menus, meta tags, structured content), we need a proper DOM parser. `cheerio` is the standard Node.js HTML parser — fast, no browser needed, SSR-friendly.

### Tasks

#### 1.1 Install cheerio
```bash
npm install cheerio
```
- Add to root `package.json` dependencies
- No puppeteer/playwright needed (too heavy, and SSRF risk with full browser)

#### 1.2 Create Universal Page Scraper
**New file:** `packages/core/src/modules/clone-pro/scrapers/page-scraper.ts`

```typescript
interface ScrapedPage {
  url: string
  title: string
  slug: string              // derived from URL path
  body_html: string         // main content area (cleaned)
  meta_title: string | null
  meta_description: string | null
  og_image: string | null
  author: string | null
  published_at: string | null
  page_type: 'about' | 'contact' | 'policy' | 'faq' | 'custom'
}

export async function scrapePage(url: string): Promise<ScrapedPage>
```

**Logic:**
1. `safeFetch(url)` to get HTML
2. Load into cheerio: `cheerio.load(html)`
3. Extract `<title>`, `<meta name="description">`, `<meta property="og:image">`
4. Find main content area: `article`, `main`, `.page-content`, `#content`, `[role="main"]`
5. Clean HTML: remove `<script>`, `<style>`, `<nav>`, `<header>`, `<footer>`, ads, tracking pixels
6. Detect page type from URL path (`/about`, `/privacy-policy`, `/faq`, `/contact`, etc.)
7. Return `ScrapedPage`

#### 1.3 Create Navigation Menu Scraper
**New file:** `packages/core/src/modules/clone-pro/scrapers/menu-scraper.ts`

```typescript
interface ScrapedMenuItem {
  title: string
  url: string
  children: ScrapedMenuItem[]
}

interface ScrapedMenus {
  main_menu: ScrapedMenuItem[]
  footer_menu: ScrapedMenuItem[]
}

export async function scrapeMenus(html: string, baseUrl: string): Promise<ScrapedMenus>
```

**Logic:**
1. Find `<nav>` elements or `<header>` navigation
2. Extract `<a>` links with text and href
3. Detect nested `<ul>/<li>` structure for submenus
4. Separate main nav (header) vs footer nav
5. Resolve relative URLs to absolute

#### 1.4 Create Collection/Category Scraper
**New file:** `packages/core/src/modules/clone-pro/scrapers/collection-scraper.ts`

```typescript
interface ScrapedCollection {
  title: string
  slug: string
  description: string | null
  image_url: string | null
  product_urls: string[]    // URLs of products in this collection
}

export async function scrapeCollections(
  sitemapNodes: CloneSitemapNode[],
  baseUrl: string
): Promise<ScrapedCollection[]>
```

**Logic:**
1. Filter sitemap nodes where `kind === 'collection'`
2. Fetch each collection page
3. Extract title (`<h1>`), description, hero image
4. Extract product links from the collection grid
5. Return list of collections with associated product URLs

#### 1.5 Create Blog Post Scraper
**New file:** `packages/core/src/modules/clone-pro/scrapers/blog-scraper.ts`

```typescript
interface ScrapedBlogPost {
  title: string
  slug: string
  body_html: string
  excerpt: string | null
  author: string | null
  image_url: string | null
  tags: string[]
  published_at: string | null
}

export async function scrapeBlogPosts(
  sitemapNodes: CloneSitemapNode[],
  baseUrl: string
): Promise<ScrapedBlogPost[]>
```

### Verification
- [ ] `cheerio` installed, no build errors
- [ ] Unit tests for each scraper with sample HTML fixtures
- [ ] SSRF protection maintained (all fetches go through `safeFetch`)
- [ ] Scraper handles missing elements gracefully (no crashes on malformed HTML)

### Anti-patterns
- Do NOT use puppeteer/playwright (too heavy, SSRF risk with full browser)
- Do NOT store raw scraped HTML with scripts/tracking code
- Do NOT follow external links (only same-domain URLs)

---

## Phase 2: Full Design & CSS Cloner
**Effort:** 2-3 sessions | **Risk:** Medium

### Why
Current brand-kit extractor only gets colors + fonts. For a true "pro clone", we need to capture the full visual identity: CSS custom properties, layout patterns, hero sections, button styles, spacing system.

### Tasks

#### 2.1 Enhanced CSS Extractor
**New file:** `packages/core/src/modules/clone-pro/scrapers/css-extractor.ts`

```typescript
interface ExtractedCSS {
  // Colors
  palette: ColorPalette          // reuse existing type
  // Typography
  fonts: FontConfig              // reuse existing type
  google_fonts_urls: string[]    // @import URLs to preserve
  // Layout
  max_width: string              // e.g. '1200px'
  grid_columns: number           // detected grid system
  spacing_unit: string           // e.g. '8px', '1rem'
  border_radius: string          // dominant border-radius
  // Components
  button_styles: ButtonStyle     // primary, secondary button CSS
  card_styles: CardStyle         // product card CSS
  // Custom properties
  css_variables: Record<string, string>  // all --var: value pairs
  // Raw
  critical_css: string           // above-the-fold CSS (minified)
}

export async function extractFullCSS(html: string, baseUrl: string): Promise<ExtractedCSS>
```

**Logic:**
1. Find all `<link rel="stylesheet">` and inline `<style>` tags
2. Fetch external CSS files (max 10, via `safeFetch`)
3. Parse CSS custom properties (`--variable: value`)
4. Extract Google Fonts `@import` URLs
5. Detect layout system (max-width, grid columns, flexbox patterns)
6. Extract button styles (`.btn`, `button`, `[type="submit"]`)
7. Extract card/product-card styles
8. Generate critical CSS for above-the-fold rendering
9. Reuse existing `extractColorPalette()` and `extractFontConfig()` from `themes/cloner.ts`

#### 2.2 Hero/Banner Image Scraper
**New file:** `packages/core/src/modules/clone-pro/scrapers/hero-scraper.ts`

```typescript
interface ScrapedHero {
  image_url: string
  alt: string
  heading: string | null
  subheading: string | null
  cta_text: string | null
  cta_url: string | null
  position: number        // order on page
}

export async function scrapeHeroes(html: string, baseUrl: string): Promise<ScrapedHero[]>
```

**Logic:**
1. Find hero sections: `.hero`, `.banner`, `.slider`, `.carousel`, `section:first-of-type img`
2. Extract large images (width > 600px or full-width containers)
3. Extract heading text (`<h1>`, `<h2>` inside hero)
4. Extract CTA buttons and their links
5. Return ordered list of hero/banner sections

#### 2.3 Favicon & Logo Scraper
**New file:** `packages/core/src/modules/clone-pro/scrapers/brand-scraper.ts`

```typescript
interface ScrapedBrand {
  logo_url: string | null       // header logo image
  logo_alt: string | null
  favicon_url: string | null
  apple_touch_icon: string | null
  site_name: string | null      // from og:site_name
}

export async function scrapeBrand(html: string, baseUrl: string): Promise<ScrapedBrand>
```

### Verification
- [ ] CSS extractor produces valid ExtractedCSS for 5+ real websites
- [ ] Google Fonts URLs correctly extracted and preserved
- [ ] Hero images detected on Shopify, WooCommerce, and custom sites
- [ ] Logo/favicon detection works across common placements

### Anti-patterns
- Do NOT download entire CSS frameworks (Bootstrap, Tailwind CDN)
- Do NOT inline base64-encoded images in CSS (download separately)
- Do NOT follow @import chains deeper than 3 levels

---

## Phase 3: Universal Product Crawler (Multi-Platform)
**Effort:** 2 sessions | **Risk:** Medium

### Why
Current crawler only supports Shopify `/products.json`. Clone Pro needs to handle WooCommerce, generic HTML, and any e-commerce site.

### Tasks

#### 3.1 WooCommerce Crawler
**New file:** `packages/core/src/modules/clone-pro/crawlers/woo-crawler.ts`

```typescript
export async function crawlWooProducts(
  baseUrl: string,
  options?: SafeFetchOptions
): Promise<CloneProductDTO[]>
```

**Logic:**
1. Try `/wp-json/wc/v3/products?per_page=100` (public REST API, no auth)
2. Fallback: Try `/wp-json/wc/store/v1/products` (WooCommerce Store API — always public)
3. Last resort: HTML scrape product pages from sitemap

#### 3.2 Generic HTML Product Scraper
**New file:** `packages/core/src/modules/clone-pro/crawlers/html-crawler.ts`

```typescript
export async function crawlHTMLProducts(
  productUrls: string[],
  baseUrl: string
): Promise<CloneProductDTO[]>
```

**Logic:**
1. For each product URL (from sitemap or collection pages):
2. Fetch page HTML
3. Detect product data via:
   - JSON-LD `<script type="application/ld+json">` (Schema.org Product)
   - Open Graph meta tags (`og:title`, `og:image`, `product:price:amount`)
   - Microdata (`itemtype="http://schema.org/Product"`)
   - Fallback: DOM heuristics (`<h1>` = title, `.price` = price, `.description` = body)
4. Extract images from product gallery (`.product-images`, `.gallery`, `[data-zoom]`)
5. Extract variants if visible (size/color selectors)
6. Normalize to `CloneProductDTO`

#### 3.3 Unified Crawl Orchestrator
**Update file:** `packages/core/src/modules/clone-pro/universal-crawler.ts`

Wire the platform detector → correct crawler:
```
detect platform → 
  shopify?     → crawlShopifyProducts (existing)
  woocommerce? → crawlWooProducts (new)
  other?       → walkSitemap → crawlHTMLProducts (new)
```

### Verification
- [ ] WooCommerce crawler works on 3+ live WooCommerce sites
- [ ] HTML crawler extracts products from JSON-LD on any site
- [ ] Fallback chain works: API → JSON-LD → OG tags → DOM heuristics
- [ ] All crawlers return valid `CloneProductDTO[]`

### Anti-patterns
- Do NOT use authenticated APIs (no API keys, no login credentials)
- Do NOT crawl more than 5000 products (hard limit like Shopify crawler)
- Do NOT ignore robots.txt (check and respect crawl-delay)

---

## Phase 4: Content Persistence Layer
**Effort:** 1-2 sessions | **Risk:** Low

### Why
Product persistence exists (`persist-products.ts`). Need equivalent for pages, blog posts, menus, collections.

### Tasks

#### 4.1 Page Persistence
**New file:** `packages/core/src/modules/clone-pro/persist/persist-pages.ts`

```typescript
export async function persistClonePages(
  db: Kysely<Database>,
  shopId: string,
  cloneJobId: string,
  pages: ScrapedPage[]
): Promise<{ inserted: number; updated: number }>
```

**Logic:**
1. For each scraped page, upsert by `(shop_id, slug)`
2. Set `published = true` for standard pages (about, contact, policies)
3. Set `published = false` for custom/unknown pages
4. Use existing `createPage()` from `content/service.ts` (Line 113)

#### 4.2 Blog Post Persistence
**New file:** `packages/core/src/modules/clone-pro/persist/persist-blog.ts`

```typescript
export async function persistCloneBlogPosts(
  db: Kysely<Database>,
  shopId: string,
  cloneJobId: string,
  posts: ScrapedBlogPost[]
): Promise<{ inserted: number }>
```

Use existing `createBlogPost()` from `content/service.ts` (Line 227).

#### 4.3 Menu Persistence
**New file:** `packages/core/src/modules/clone-pro/persist/persist-menus.ts`

```typescript
export async function persistCloneMenus(
  db: Kysely<Database>,
  shopId: string,
  menus: ScrapedMenus
): Promise<{ menusCreated: number; itemsCreated: number }>
```

Use existing `createMenu()` and `addMenuItem()` from `content/service.ts` (Lines 360, 431).

#### 4.4 Collection Persistence
**New file:** `packages/core/src/modules/clone-pro/persist/persist-collections.ts`

```typescript
export async function persistCloneCollections(
  db: Kysely<Database>,
  shopId: string,
  collections: ScrapedCollection[],
  productSlugMap: Map<string, string>  // source URL → product ID
): Promise<{ inserted: number; productsLinked: number }>
```

Create collections + link products via `collection_products` junction table.

#### 4.5 SEO Metadata Persistence
**New file:** `packages/core/src/modules/clone-pro/persist/persist-seo.ts`

```typescript
export async function persistCloneSEO(
  db: Kysely<Database>,
  shopId: string,
  seoData: {
    meta_title: string
    meta_description: string
    og_image: string | null
    favicon_url: string | null
    social_links: Record<string, string>
  }
): Promise<void>
```

Save to `shop_settings` keys: `seo_settings`, `social_links`.

### Verification
- [ ] Pages created with correct slugs and body_html
- [ ] Blog posts created with tags and published_at dates
- [ ] Menus created with correct nesting (parent_id hierarchy)
- [ ] Collections created and linked to correct products
- [ ] SEO metadata saved to shop_settings

### Anti-patterns
- Do NOT create duplicate pages on re-clone (upsert by slug)
- Do NOT lose HTML formatting in body_html (preserve headings, lists, images)
- Do NOT link to external images in body_html (rewrite to local URLs in Phase 5)

---

## Phase 5: Theme Generator
**Effort:** 3-4 sessions | **Risk:** High (most complex phase)

### Why
The cloned store needs to LOOK like the source website. This phase generates a LiquidJS theme from the extracted design data.

### Tasks

#### 5.1 Theme Template Generator
**New file:** `packages/core/src/modules/clone-pro/theme-gen/template-generator.ts`

```typescript
export async function generateThemeFromDesign(
  design: ExtractedCSS,
  heroes: ScrapedHero[],
  brand: ScrapedBrand,
  menus: ScrapedMenus,
  options?: { aiProvider?: AIProviderConfig }
): Promise<ThemeTemplateSet>

interface ThemeTemplateSet {
  layout: string          // layout/theme.liquid
  index: string           // templates/index.liquid
  product: string         // templates/product.liquid
  collection: string      // templates/collection.liquid
  page: string            // templates/page.liquid
  blog: string            // templates/blog.liquid
  cart: string             // templates/cart.liquid
  '404': string           // templates/404.liquid
  header: string          // snippets/header.liquid
  footer: string          // snippets/footer.liquid
  product_card: string    // snippets/product-card.liquid
  'style.css': string     // assets/style.css
  'script.js': string     // assets/script.js
}
```

**Logic:**
1. Start from a base template set (clean, semantic HTML5 Liquid templates)
2. Inject extracted CSS variables into `style.css`
3. Apply color palette to CSS custom properties
4. Apply typography (Google Fonts imports, font-family, sizes)
5. Apply layout settings (max-width, grid, spacing)
6. Apply button/card styles
7. Inject hero sections into `index.liquid`
8. Inject logo/favicon into `layout/theme.liquid`
9. Build header from main_menu data
10. Build footer from footer_menu data
11. **Optional AI enhancement:** If AI provider configured, use AI bridge to refine templates

#### 5.2 Theme Persistence
**New file:** `packages/core/src/modules/clone-pro/theme-gen/persist-theme.ts`

```typescript
export async function persistCloneTheme(
  db: Kysely<Database>,
  shopId: string,
  templates: ThemeTemplateSet,
  themeName: string
): Promise<string>  // returns theme ID
```

**Logic:**
1. Create new theme with `role: 'unpublished'` (don't auto-activate)
2. Use existing `createTheme()` from `themes/service.ts` (Line 96)
3. Insert each template as a `theme_asset` via `updateThemeAsset()`
4. Merchant can preview and manually activate

#### 5.3 Base Template Library
**New directory:** `packages/core/src/modules/clone-pro/theme-gen/base-templates/`

Create a set of clean, well-structured Liquid base templates:
- `layout.liquid` — HTML5 skeleton with `{{ content_for_layout }}`
- `index.liquid` — Hero + featured collections + featured products
- `product.liquid` — Product detail page with gallery, variants, add-to-cart
- `collection.liquid` — Product grid with filters
- `page.liquid` — Generic content page
- `blog.liquid` — Blog listing
- `article.liquid` — Single blog post
- `cart.liquid` — Shopping cart
- `header.liquid` — Navigation with logo
- `footer.liquid` — Footer with menu + social links
- `product-card.liquid` — Reusable product card snippet

These are Liquid templates using the Gbox theme data model (same as Shopify Liquid).

### Verification
- [ ] Generated theme renders correctly in storefront
- [ ] CSS variables match source site colors/fonts
- [ ] Google Fonts load correctly
- [ ] Hero images display in correct order
- [ ] Navigation menus render with correct links
- [ ] Product cards show correct layout

### Anti-patterns
- Do NOT auto-activate the cloned theme (let merchant review first)
- Do NOT copy JavaScript from source site (security risk)
- Do NOT use inline styles — always CSS custom properties
- Do NOT hardcode URLs in templates — always use Liquid variables

---

## Phase 6: Clone Pro Pipeline Orchestrator
**Effort:** 2 sessions | **Risk:** Medium

### Why
Wire all the pieces together into a single, tracked pipeline that runs from URL input to finished store.

### Tasks

#### 6.1 Full Pipeline Implementation
**Update file:** `packages/core/src/modules/clone-pro/pipeline.ts`

Complete the existing stubbed pipeline with real stage implementations:

```
Stage 1: detect        (5%)   — detectPlatform()
Stage 2: crawl         (25%)  — crawlWebsite() [products + sitemap]
Stage 3: scrape_pages  (35%)  — scrapePage() for each page URL
Stage 4: scrape_blog   (40%)  — scrapeBlogPosts() 
Stage 5: scrape_menus  (42%)  — scrapeMenus()
Stage 6: extract_css   (50%)  — extractFullCSS()
Stage 7: scrape_heroes (55%)  — scrapeHeroes()
Stage 8: persist_data  (70%)  — persistClone[Products|Pages|Blog|Menus|Collections|SEO]
Stage 9: ingest_media  (85%)  — ingestProductImages() + download page/hero images
Stage 10: gen_theme    (95%)  — generateThemeFromDesign()
Stage 11: finalize     (100%) — notification + result summary
```

#### 6.2 Clone Pro Job Store Extension
**Update file:** `packages/core/src/modules/storefront-clone/job-store.ts`

Add new stage types to `CloneJobStageEntry`:
```typescript
stage: 'detect' | 'crawl' | 'scrape_pages' | 'scrape_blog' | 'scrape_menus' 
     | 'extract_css' | 'scrape_heroes' | 'persist_data' | 'ingest_media' 
     | 'gen_theme' | 'finalize'
     | /* existing */ 'theme' | 'products' | 'sitemap' | 'media' | 'seo' | 'brand_kit'
```

#### 6.3 Clone Config UI
**Update file:** `apps/store-admin/src/pages/storefront-clone.ts`

Enhance the existing clone page with:
- **Scope selector:** Checkboxes for what to clone:
  - [x] Products (default on)
  - [x] Collections
  - [x] Pages (About, Policies, etc.)
  - [x] Blog posts
  - [x] Navigation menus
  - [x] Visual design (CSS, colors, fonts)
  - [x] Hero images & banners
  - [x] SEO metadata
  - [ ] AI enhancement (optional, BYOK)
- **AI Provider config** (expandable section):
  - Provider: OpenAI / Anthropic / Google / None
  - API Key: [input field]
  - Used for: better alt text, content rewriting, layout analysis
- **Preview button:** After clone, link to storefront preview with cloned theme

#### 6.4 Progress UI Enhancement
Update the SSE stream handler to show granular stage progress:
- Each stage shows: name, status icon (spinner/check/cross), count, duration
- Overall progress bar with percentage
- "View cloned products" / "View cloned pages" / "Preview theme" links when done

### Verification
- [ ] Full pipeline runs end-to-end on a Shopify site
- [ ] Full pipeline runs on a WooCommerce site
- [ ] Full pipeline runs on a generic HTML e-commerce site
- [ ] All stages tracked in `stages_json` with correct progress percentages
- [ ] SSE stream shows real-time progress
- [ ] Notification sent on completion
- [ ] Cloned store renders in storefront with cloned theme

### Anti-patterns
- Do NOT run the pipeline synchronously in the request handler
- Do NOT ignore stage failures — log and continue with partial results
- Do NOT clone the same URL twice without warning the user

---

## Phase 7: BullMQ Worker + Production Hardening
**Effort:** 1-2 sessions | **Risk:** Low

### Why
Move clone jobs from fire-and-forget async functions to proper BullMQ workers for reliability, retry, and concurrency control.

### Tasks

#### 7.1 Clone Worker
**New file:** `packages/core/src/modules/queue/clone-worker.ts`

```typescript
export function startCloneWorker(db: Kysely<Database>): Worker
```

- Register `website-clone` queue in `queues.ts`
- Worker concurrency: 2 (to limit server load)
- Retry: 2 attempts with exponential backoff
- Timeout: 15 minutes per job
- On failure: update job status to `failed` with error

#### 7.2 Rate Limiting & Politeness
- Max 2 concurrent clone jobs per shop
- Max 5 requests/second to source website (crawl-delay)
- Respect robots.txt (check `Disallow` rules)
- Total timeout: 15 minutes per clone job

#### 7.3 Error Recovery
- Each stage wrapped in try-catch
- Failed stage → skip and continue with next
- Partial results saved (e.g., products cloned but theme failed)
- User notified of partial success with details

#### 7.4 Security Hardening
- Verify all image URLs before download (no `file://`, `data:` URIs)
- Strip all `<script>` tags from cloned HTML
- Strip `onclick`, `onload`, and other event handlers
- Strip `<iframe>` tags
- Sanitize CSS (`@import` only from known CDNs like Google Fonts)
- Log all clone jobs in `audit_logs` table

### Verification
- [ ] Clone job runs as BullMQ worker
- [ ] Retry works on transient failure
- [ ] Concurrent job limit enforced
- [ ] robots.txt respected
- [ ] No XSS vectors in cloned content
- [ ] Audit log created for each clone job

---

## Phase 8: God Admin Clone Dashboard
**Effort:** 1 session | **Risk:** Low

### Why
God Admin needs visibility into all clone jobs across all stores for monitoring and abuse prevention.

### Tasks

#### 8.1 Clone Jobs Overview Page
**New file:** `apps/god-admin/src/pages/clone-jobs.ts`

```
GET /god-admin/clone-jobs — List all clone jobs across stores
```

- Table: Job ID, Store, Source URL, Status, Progress, Duration, Created
- Filters: status (all/running/succeeded/failed), date range
- Action: Cancel running jobs
- Stats cards: Total cloned, Running now, Success rate, Avg duration

#### 8.2 Clone Job Detail
```
GET /god-admin/clone-jobs/:id — Single job detail with full stage log
```

- Show all stages with timing
- Show cloned product/page/collection counts
- Show errors if any
- Link to store admin

#### 8.3 Add to God Admin Sidebar
**Update file:** `apps/god-admin/src/layouts/god-layout.ts`

Add "Clone Jobs" under Tools section in sidebar.

### Verification
- [ ] God Admin can see all clone jobs
- [ ] Can filter by status
- [ ] Can cancel running jobs
- [ ] Stats cards show correct counts

---

## Execution Order & Dependencies

```
Phase 1 ──→ Phase 2 ──→ Phase 3 ──→ Phase 4 ──→ Phase 5 ──→ Phase 6 ──→ Phase 7
  │              │            │            │            │            │          │
  │              │            │            │            │            │          │
cheerio     CSS extract   crawlers    persistence   theme gen   pipeline    queue
scrapers    hero/brand    woo/html    pages/blog    templates   wiring     bullmq
                                      menus/coll                            │
                                                                            ↓
                                                                       Phase 8
                                                                       god-admin
```

**Phases 1-4** can be partially parallelized (scrapers + crawlers + persistence are independent modules).

**Phase 5** depends on Phase 2 (CSS data) and Phase 1 (page data).

**Phase 6** depends on everything (wires it all together).

**Phase 7-8** can run in parallel after Phase 6.

---

## File Tree (New Files)

```
packages/core/src/modules/clone-pro/
├── scrapers/
│   ├── page-scraper.ts          # Phase 1.2
│   ├── menu-scraper.ts          # Phase 1.3
│   ├── collection-scraper.ts    # Phase 1.4
│   ├── blog-scraper.ts          # Phase 1.5
│   ├── css-extractor.ts         # Phase 2.1
│   ├── hero-scraper.ts          # Phase 2.2
│   └── brand-scraper.ts         # Phase 2.3
├── crawlers/
│   ├── woo-crawler.ts           # Phase 3.1
│   └── html-crawler.ts          # Phase 3.2
├── persist/
│   ├── persist-pages.ts         # Phase 4.1
│   ├── persist-blog.ts          # Phase 4.2
│   ├── persist-menus.ts         # Phase 4.3
│   ├── persist-collections.ts   # Phase 4.4
│   └── persist-seo.ts           # Phase 4.5
├── theme-gen/
│   ├── template-generator.ts    # Phase 5.1
│   ├── persist-theme.ts         # Phase 5.2
│   └── base-templates/          # Phase 5.3
│       ├── layout.liquid
│       ├── index.liquid
│       ├── product.liquid
│       ├── collection.liquid
│       ├── page.liquid
│       ├── blog.liquid
│       ├── cart.liquid
│       ├── header.liquid
│       ├── footer.liquid
│       └── product-card.liquid
├── pipeline.ts                  # Phase 6.1 (update existing)
├── universal-crawler.ts         # Phase 3.3 (update existing)
├── platform-detector.ts         # existing, no change
├── design-extractor.ts          # existing, enhance in Phase 2
├── ai-bridge.ts                 # existing, no change
└── types.ts                     # update with new interfaces

packages/core/src/modules/queue/
└── clone-worker.ts              # Phase 7.1

apps/god-admin/src/pages/
└── clone-jobs.ts                # Phase 8.1
```

---

## Tech Stack Summary

| Component | Technology | Why |
|-----------|-----------|-----|
| HTML parsing | `cheerio` (new dep) | Fast, no browser, SSR-safe |
| HTTP fetching | `safeFetch` (existing) | SSRF-safe, tested |
| Product crawling | Existing Shopify + new WooCommerce + HTML | Multi-platform |
| Image storage | R2/S3 (existing `r2-store.ts`) | CDN-ready |
| Job queue | BullMQ (existing) | Retry, concurrency |
| Template engine | LiquidJS (existing) | Shopify-compatible |
| Real-time progress | SSE (existing) | No WebSocket needed |
| AI enhancement | BYOK via `ai-bridge.ts` (existing) | Optional, user's API key |

---

## Success Criteria

1. Merchant pastes a Shopify URL → gets full store clone in <5 minutes
2. Merchant pastes a WooCommerce URL → gets products + pages + theme
3. Merchant pastes any e-commerce URL → gets products (JSON-LD) + pages + basic theme
4. Cloned store renders in storefront with matching colors/fonts/layout
5. All cloned content is editable in store admin
6. God Admin can monitor and manage all clone jobs
7. No security vulnerabilities (XSS, SSRF, credential leaks)

---

## Estimated Timeline

| Phase | Sessions | Calendar Days |
|-------|----------|---------------|
| Phase 1: Scrapers | 1-2 | 1-2 days |
| Phase 2: CSS/Design | 2-3 | 2-3 days |
| Phase 3: Crawlers | 2 | 1-2 days |
| Phase 4: Persistence | 1-2 | 1 day |
| Phase 5: Theme Gen | 3-4 | 3-4 days |
| Phase 6: Pipeline | 2 | 1-2 days |
| Phase 7: Production | 1-2 | 1 day |
| Phase 8: God Admin | 1 | 1 day |
| **Total** | **13-18** | **~2 weeks** |
