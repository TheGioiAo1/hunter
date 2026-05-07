# Clone Pro v4 Specification — Full Site Cloner

**Date:** 2026-04-13
**Status:** Confirmed by Owner (Thai Bui)
**Replaces:** Clone Pro v3 (homepage-only + generic templates)

---

## Problem Statement

Clone Pro v3 only clones the homepage's HTML/CSS and uses **generic Liquid templates** for all inner pages (product, collection, cart, blog, etc.). Because the generic templates use different CSS classes than the source site, the downloaded CSS doesn't apply correctly — resulting in inner pages that look nothing like the original.

## Solution: Scrape-Every-Page-Type Architecture

Instead of generating templates from design tokens, **scrape a sample page for each page type** from the source site, extract its HTML structure, and convert it to a Liquid template that **preserves the original CSS classes**. Since ALL original CSS is already downloaded, templates that use the same CSS classes will render identically.

---

## Three-Phase Architecture

### Phase 1: Discovery (Recon)
> Goal: Build a complete picture of the source site before touching anything.

| Step | Name | Description |
|------|------|-------------|
| 1.1 | **Platform Detection** | Detect CMS/platform (Shopify, WooCommerce, Magento, custom, static) |
| 1.2 | **Deep Crawl** | Crawl entire site following all internal links. Respect robots.txt. Collect every URL. |
| 1.3 | **Site Map Generation** | Build hierarchical tree: Homepage → Collections → Products → Pages → Blog → Policies → Account. Show parent-child relationships. |
| 1.4 | **Template Type Detection** | Group URLs by page type. For each type, identify the template being used (e.g., Shopify: product.liquid, collection.liquid). Detect variants. |
| 1.5 | **Asset Inventory** | Scan all pages for external assets: CSS files, JS files, fonts, images, SVGs, favicons, manifest files. Deduplicate. Estimate total download size. |
| 1.6 | **User Report** | Present discovery results to user: site map tree, page type counts, asset inventory summary, estimated clone time. Wait for user confirmation (clone all / select pages / abort). |

### Phase 2: Execution (Clone)
> Goal: Download everything and build the cloned storefront.

| Step | Name | Description |
|------|------|-------------|
| 2.1 | **Global Asset Download** | Download ALL CSS, JS, fonts, favicons, manifest, config files. Store locally. Rewrite all internal URLs to local paths. |
| 2.2 | **Shared Component Extraction** | Scrape header, footer, announcement bar, product card from source. Convert to Liquid snippets (snippets/header.liquid, snippets/footer.liquid, etc.) preserving original CSS classes. |
| 2.3 | **Layout Template** | Build layout/theme.liquid: include all CSS/JS refs, {{ content_for_header }}, shared components, {{ content_for_layout }}. |
| 2.4 | **Per-Page-Type Cloning** | For EACH detected page type: |
|      | 2.4.1 Scrape Sample | Pick one representative page, download its full HTML |
|      | 2.4.2 Extract Body | Remove header/footer (already in layout), isolate the main content area |
|      | 2.4.3 Templatize | Replace dynamic content with Liquid variables ({{ product.title }}, {{ collection.products }}, etc.) while keeping ALL CSS classes intact |
|      | 2.4.4 Store Template | Save as templates/product.liquid, templates/collection.liquid, etc. |
| 2.5 | **Data Import** | Import all products, collections, pages, blog posts, menus, SEO metadata to database. |
| 2.6 | **Media Download** | Download ALL images (product images, collection images, hero banners, logos, icons). Update DB records with local paths. |
| 2.7 | **URL Rewriting & Cleanup** | Scan all templates + CSS for remaining external URLs. Rewrite to local. Remove tracking scripts. Remove third-party analytics. |

### Phase 3: Verification (QA)
> Goal: Ensure the clone is complete and independent.

| Step | Name | Description |
|------|------|-------------|
| 3.1 | **Route Coverage Check** | For every URL in the site map, verify the cloned site returns 200 (not 404). |
| 3.2 | **Asset Integrity Check** | Verify every CSS/JS/font/image file exists locally and is served correctly. |
| 3.3 | **Content Completeness** | Compare product/collection/page counts: source vs clone. Flag any missing. |
| 3.4 | **External Dependency Audit** | Scan all served HTML/CSS/JS for remaining external URLs. Goal: 0 calls to source domain. |
| 3.5 | **CSS Class Match Score** | Compare CSS classes used in clone templates vs classes defined in downloaded CSS. Report coverage %. |
| 3.6 | **Visual Comparison** (future) | Screenshot source and clone side-by-side. Pixel diff score. |
| 3.7 | **Final Report** | Summary: pages cloned, assets downloaded, external deps remaining, class coverage %, overall clone fidelity score. |

---

## Page Type → Template Mapping

| Source Route Pattern | Template Name | Liquid Variables |
|---------------------|---------------|-----------------|
| `/` | `index` | `collections`, `products`, `pages` |
| `/collections` | `list-collections` | `collections` |
| `/collections/:handle` | `collection` | `collection`, `collection.products` |
| `/products/:handle` | `product` | `product`, `product.images`, `product.variants` |
| `/pages/:handle` | `page` | `page.title`, `page.body_html` |
| `/blogs/:blog/:article` | `article` | `article`, `blog` |
| `/blogs/:blog` | `blog` | `blog`, `blog.articles` |
| `/cart` | `cart` | `cart`, `cart.items` |
| `/search` | `search` | `search.results`, `search.terms` |
| `/account` | `customers/account` | `customer` |
| `/account/login` | `customers/login` | — |
| `/account/register` | `customers/register` | — |
| `/policies/:handle` | `page.policy` | `page.title`, `page.body_html` |
| `/404` | `404` | — |
| `/password` | `password` | — |

---

## Key Architecture Decisions

### 1. Scrape → Templatize (not Generate from Tokens)
The v3 approach of extracting design tokens (colors, fonts, spacing) and generating templates from scratch was fundamentally wrong. Templates MUST use the same CSS classes as the source site because we download the source's CSS verbatim. Generating new HTML with different classes means the CSS doesn't apply.

### 2. Sample-Based Cloning
We don't need to scrape EVERY product page — they all use the same template. Scrape ONE representative page per type, templatize it, and the template handles all pages of that type.

### 3. Header/Footer as Shared Snippets
Header and footer appear on every page. Extract once → store as snippets → include from layout. This avoids duplication and ensures consistency.

### 4. Progressive Enhancement
Phase 1 (Discovery) can run independently — even if the user decides not to clone, the site map and analysis are valuable. Each phase builds on the previous.

### 5. Clone Independence
The final clone must have ZERO external dependencies on the source site. Every asset served locally. No CDN links to source. No tracking scripts leaking back to source.

---

## File Structure

```
packages/core/src/modules/clone-pro/
├── pipeline-v4.ts           # New 3-phase orchestrator
├── types.ts                 # Extended types for v4
├── discovery/
│   ├── deep-crawler.ts      # Phase 1.2: Follow all links
│   ├── site-mapper.ts       # Phase 1.3: Build tree
│   ├── template-detector.ts # Phase 1.4: Classify pages
│   ├── asset-scanner.ts     # Phase 1.5: Find all assets
│   └── discovery-report.ts  # Phase 1.6: User report
├── execution/
│   ├── asset-downloader.ts  # Phase 2.1: Download CSS/JS/fonts
│   ├── component-extractor.ts # Phase 2.2: Header/footer/cards
│   ├── layout-builder.ts    # Phase 2.3: theme.liquid
│   ├── page-templatizer.ts  # Phase 2.4: Scrape → Templatize
│   ├── data-importer.ts     # Phase 2.5: Products/pages to DB
│   ├── media-downloader.ts  # Phase 2.6: Images
│   └── url-rewriter.ts      # Phase 2.7: Cleanup
├── verification/
│   ├── route-checker.ts     # Phase 3.1
│   ├── asset-checker.ts     # Phase 3.2
│   ├── content-checker.ts   # Phase 3.3
│   ├── dependency-auditor.ts # Phase 3.4
│   ├── css-matcher.ts       # Phase 3.5
│   └── verification-report.ts # Phase 3.7
└── pipeline.ts              # Legacy v3 (kept for reference)
```

---

## Implementation Order

1. Save this spec ✅
2. Implement Phase 1 (Discovery) — build site map, detect templates, scan assets
3. Implement Phase 2 (Execution) — Scrape → Templatize for each page type
4. Implement Phase 3 (Verification) — route check, asset check, reports
5. Wire into admin dashboard UI
6. Test with bibliobloom.com → tw3.store
7. Test with 2-3 other Shopify stores for generalization
