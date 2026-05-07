# Decision #1 — LiquidJS Theme Engine (Shopify-Compatible)

**Status:** in progress — Steps 1.1–1.15 shipped (engine surface 100%); Steps 1.16–1.23 are the resumed integration phase.
**Owner:** Thai Bui
**Date:** 2026-04-08 (original plan), revised 2026-04-09 (post-Step-1.15 reality alignment)
**Depends on:** Decision #2 (checkout subdomain split) ✅
**Blocks:** Decision #6 (Cloudflare Pages storefront — only for the build-time prerender path of `gbox.co`)

> **2026-04-09 revision note.** Engine implementation diverged from the original step numbering: steps 1.6–1.15 ended up shipping more engine surface area (schema parser, JSON templates, paginate, section API, theme settings + locale files) than the original plan called for, while *deferring* the integration items (R2 large-asset branch, Gbox Dawn seed theme, `createShop` hook, `storefront-server.ts` wiring, E2E smoke). §4 has been rewritten to (a) document each shipped commit truthfully and (b) add Steps 1.16–1.23 as the resumed integration phase. The principle "clone giống hệt nguyên mẫu Shopify" stays absolute — every new step lines up with a real Shopify behavior.

---

## 0. Owner-locked answers (Q1–Q4 from chat, session 1)

| Q | Choice | What it means here |
|---|---|---|
| Q1 | **(c)** | CF Pages = only `gbox.co` static. All `*.gbox.co` storefronts keep hitting origin Node — **Decision #1 is the engine that runs on origin Node**. |
| Q2 | **(b)** | Engine MUST be isomorphic — runnable on Node *and* Cloudflare Workers runtime. **No `fs`, no `path`, no `process` outside of injected adapters.** Future-proofs us for flipping Q1 to (a)/(b) later. |
| Q3 | **(a)** | 100% Shopify Liquid compatible. Filters, tags, object model, section schema, settings — all matching Shopify's contract so a Dawn theme imports nearly verbatim. |
| Q4 | **(a)** | Decision #1 ships first (engine + Dawn-clone running on server 3 Node). Decision #6 only starts after this is green. |

## 0.5. Owner-locked answers (§8 open questions, session 2)

| # | Question | Thai's answer | Impact on this spec |
|---|---|---|---|
| 1 | Theme name | **"Gbox Dawn"** | Locked. Seed directory = `seed/gbox-dawn/`. DB theme row `name='Gbox Dawn'`. |
| 2 | Backfill existing shops? | **No — new shops only** | Step 1.13 migration changes: instead of a backfill loop, it installs a shop-creation **hook** that auto-provisions Gbox Dawn for every shop created after the migration. Existing shops keep rendering via the legacy hardcoded HTML in `storefront-server.ts` until owner manually clicks "Install Gbox Dawn" in the admin (separate decision). The storefront router at Step 1.14 **branches** on `hasActiveTheme(shopId)`. |
| 3 | Large theme assets | **Push to S3/R2** (not PG TEXT) | New module `packages/core/src/modules/storage/` with an `ObjectStore` interface + `R2Store` implementation (R2 is S3-compatible, uses `@aws-sdk/client-s3` over `fetch` → Worker-runtime safe). `theme_assets.value` stays TEXT; assets ≤ **256 KB** stay inline; assets > 256 KB upload to R2 and `value` stores `r2://bucket/key` (or `{"kind":"r2","bucket":"...","key":"..."}`). The DbLoader detects the prefix and fetches from R2 on cache miss. |
| 4 | `t` filter | **Wire to real i18n module** | New module `packages/core/src/modules/i18n/` with `translations(shop_id, theme_id, locale, namespace, key, value)` table (migration in this decision), DB CRUD service, Redis-cached lookup. Gbox Dawn seed ships English translations as part of the theme seed bundle. `t` filter reads `request.locale` (falls back to shop default → `'en'`). |

These four answers add **~700 LOC** to the original estimate (storage module + i18n module + new migration sub-steps). Updated total: **~4,200 LOC**, **new files ≈ 38**.

---

## 1. Why LiquidJS (not Nunjucks, not handlebars)

1. **Shopify-compatible syntax out of the box.** LiquidJS is the closest npm engine to Ruby's `liquid` gem that powers Shopify themes. `{% if %}`, `{% for %}`, `{% capture %}`, `{% include %}`, `{% render %}`, `{% schema %}`, `{{ x | filter }}` — all the syntax Shopify themes use lives natively in LiquidJS.
2. **Strict mode + sandboxing.** LiquidJS has `strictFilters`, `strictVariables`, and a `noPrototypeAccess` mode — important when we eventually let merchants edit templates in the visual editor without giving them access to `__proto__`.
3. **Async-first.** Unlike Nunjucks's awkward async filters, LiquidJS has first-class `await` in filters and tags. This matters when a `{% paginate products %}` tag has to fetch from DB.
4. **Worker-runtime safe.** LiquidJS ships ESM, has zero Node-builtin deps, and runs on Cloudflare Workers if you give it an in-memory loader (no `fs.readFileSync`). Nunjucks pulls in `chokidar` and friends. Handlebars doesn't have schema tags.
5. **MIT license.** Same as our existing stack.

**Rejected:**
- ~~Nunjucks~~ (current placeholder) — not Shopify-syntax-compatible, can't import a Dawn theme without rewriting every template.
- ~~Handlebars~~ — no `{% %}` tag syntax, can't express `{% schema %}` JSON blocks at all.
- ~~Liquidish~~ (Shopify CLI's bundled JS port) — abandoned, last release 2018.
- ~~Hydrogen-style React SSR~~ — ditches the entire merchant-edits-templates UX.

---

## 2. What already exists in the monorepo

| Capability | Status | File |
| --- | --- | --- |
| `themes` + `theme_assets` tables | ✅ | migration `004_storefront.ts` |
| Theme CRUD service (list/get/create/delete/setActive/duplicate) | ✅ | `packages/core/src/modules/themes/service.ts` |
| Theme asset CRUD (`getThemeAsset` / `updateThemeAsset` / `deleteThemeAsset` / `listThemeAssets`) | ✅ | same file |
| Shopify object-model TypeScript shapes (`ShopData`, `ProductData`, `VariantData`, `CartData`, `CustomerData`, `ProductImageData`, `ProductOptionData`, `CollectionData`) | ✅ | `packages/core/src/modules/themes/engine.ts` lines 21–120 |
| Hardcoded HTML storefront server | ✅ | `storefront-server.ts` (root) |
| Astro parallel theme | ✅ but unused | `packages/storefront/src/themes/default/*.astro` |
| `theme.css` baseline + ProductCard component | ✅ | `packages/storefront/public/theme.css`, `.../components/ProductCard.astro` |
| Storefront API client (REST → /api/storefront/*) | ✅ | `packages/storefront/src/engine/api-client.ts` |

**Gap analysis:**
1. `engine.ts` is built around `nunjucks` — entire `render()` path needs to swap to LiquidJS.
2. No template loader abstraction — currently the engine couples DB lookup to template path resolution; we need a `TemplateLoader` interface so the engine can be driven by a DB loader (Node) or a KV/static-bundle loader (Workers).
3. No filters implemented — Shopify themes use ~50 filters (`money`, `money_with_currency`, `img_url`, `asset_url`, `link_to`, `default`, `truncate`, `truncatewords`, `strip_html`, `escape`, `date`, `weight_with_unit`, `t` for translations, etc.). None exist.
4. No `{% schema %}` tag — Dawn sections embed a `{% schema %}` JSON block declaring settings; without this, themes don't load.
5. No `{% section %}` / `{% sections %}` tag — Shopify's section system needs custom tags to look up the section file + render it with its settings.
6. No `{% paginate %}`, `{% form %}`, `{% style %}`, `{% javascript %}` tags.
7. No section settings resolver — `{{ section.settings.heading }}` needs to read from `settings_data.json` in the same theme.
8. No global `request` / `routes` / `shop` / `template` objects — Shopify exposes these as ambient globals.
9. `storefront-server.ts` doesn't call the engine at all — every page is hand-written HTML.
10. No Dawn-clone theme files — we have one `default` Astro theme but nothing in Liquid.
11. No tests for the engine.

---

## 3. Architecture

### 3.1 Module layout

```
packages/core/src/modules/
│
├── storage/                         ← NEW in Decision #1 (for §0.5 Q3)
│   ├── index.ts                     ← public API: getObjectStore()
│   ├── interface.ts                 ← ObjectStore { put, get, delete, url, has }
│   ├── r2-store.ts                  ← Cloudflare R2 via @aws-sdk/client-s3 (Worker-safe fetch)
│   ├── memory-store.ts              ← in-memory Map<key, Buffer>, for unit tests
│   └── tests/
│       ├── memory-store.test.ts
│       └── r2-store.test.ts         ← gated on R2_* env vars; skipped in CI
│
├── i18n/                            ← NEW in Decision #1 (for §0.5 Q4)
│   ├── index.ts                     ← public API: getTranslation(), listTranslations()
│   ├── service.ts                   ← DB CRUD against `translations` table
│   ├── cache.ts                     ← Redis layer (key: `i18n:{shop}:{theme}:{locale}`)
│   ├── resolver.ts                  ← resolveLocale(req, shop) with fallback chain
│   └── tests/
│       ├── resolver.test.ts
│       └── service.test.ts          ← gated on DB
│
└── themes/
    ├── service.ts                   (already exists — theme + asset CRUD; extended for R2 in Step 1.11b)
    ├── engine/
    │   ├── index.ts                 ← public API: createThemeEngine()
    │   ├── liquid-instance.ts       ← LiquidJS instance config (filters/tags registered)
    │   ├── loader.ts                ← TemplateLoader interface + DbLoader + StaticLoader
    │   ├── context.ts               ← buildRenderContext(req, shop, page) → Liquid context
    │   ├── filters/
    │   │   ├── money.ts             ← money, money_with_currency, money_without_trailing_zeros
    │   │   ├── url.ts               ← link_to, asset_url, img_url, file_url
    │   │   ├── string.ts            ← truncate, truncatewords, strip_html, escape, handleize
    │   │   ├── date.ts              ← date, time_tag
    │   │   ├── i18n.ts              ← t filter — calls into packages/core/.../i18n/
    │   │   ├── product.ts           ← weight_with_unit, format_address, payment_type_img_url
    │   │   └── index.ts             ← registerAllFilters(liquid)
    │   ├── tags/
    │   │   ├── schema.ts            ← {% schema %}...{% endschema %} — parses + ignores at render time
    │   │   ├── section.ts           ← {% section 'hero' %}
    │   │   ├── sections.ts          ← {% sections 'index' %} (renders a section group)
    │   │   ├── render.ts            ← {% render 'snippet', var: 1 %}
    │   │   ├── paginate.ts          ← {% paginate collection.products by 12 %}
    │   │   ├── form.ts              ← {% form 'cart' %}
    │   │   ├── style.ts             ← {% style %}...{% endstyle %}
    │   │   ├── javascript.ts        ← {% javascript %}...{% endjavascript %}
    │   │   └── index.ts             ← registerAllTags(liquid)
    │   ├── shopify-globals.ts       ← buildAmbientGlobals(shop, req) → { shop, request, routes, ... }
    │   └── settings.ts              ← parseSettingsSchema(json), parseSettingsData(json)
    ├── shopify-types.ts             ← moved out of engine.ts
    ├── seed/
    │   └── gbox-dawn/               ← the starter theme — checked into the repo
    │       ├── layout/theme.liquid
    │       ├── templates/*.liquid + *.json
    │       ├── sections/*.liquid
    │       ├── snippets/*.liquid
    │       ├── assets/theme.css
    │       ├── config/settings_schema.json
    │       ├── config/settings_data.json
    │       └── locales/en.default.json  ← seeds i18n.translations on install
    └── tests/
        ├── filters.test.ts
        ├── tags.test.ts
        ├── schema-tag.test.ts
        ├── section-rendering.test.ts
        ├── full-render.test.ts
        └── isomorphic.test.ts        ← runs the loader against a static bundle (no DB, no fs)
```

**Why storage + i18n live *outside* `themes/`:**
They are independent horizontal capabilities the whole platform will reuse — product images, merchant uploads, admin copy, marketing emails. Hiding them inside `themes/` would lock them to one caller.

### 3.2 The `TemplateLoader` interface (the isomorphism boundary)

The single most important design decision in Decision #1 is keeping LiquidJS away from `fs`. Everything goes through:

```typescript
// engine/loader.ts
export interface TemplateLoader {
  /** Returns the raw template source for a given key, or null if missing. */
  load(key: string): Promise<string | null>
  /** Returns the parsed JSON for settings_data.json (or null). */
  loadSettings(): Promise<Record<string, unknown> | null>
  /** Returns the asset binary URL — for {{ "x.css" | asset_url }}. */
  assetUrl(key: string): string
}
```

Two implementations ship in this PR:

1. **`DbLoader`** — wraps `getThemeAsset(db, themeId, key)` + Redis cache. Used by origin Node. This is the production path for Q1=(c).
2. **`StaticLoader`** — backed by an `in-memory Map<string, string>` that the build step inlines from a directory of liquid files. Used by:
   - The unit tests (no DB, no Redis).
   - The future Worker runtime (Q1 → a/b).
   - The CF Pages build of `gbox.co` if any marketing page reuses theme components.

Engine never imports `fs`. Period.

### 3.3 Render API

```typescript
// engine/index.ts
export function createThemeEngine(opts: {
  loader: TemplateLoader
  cache?: { get(k: string): Promise<string | null>, set(k: string, v: string, ttl: number): Promise<void> }
}): ThemeEngine

export interface ThemeEngine {
  render(templateKey: string, ctx: RenderContext): Promise<string>
  /** Pre-parses + caches a section so {% section 'hero' %} is hot. */
  warmupSections(keys: string[]): Promise<void>
}
```

`storefront-server.ts` will end up looking like:

```typescript
const engine = createThemeEngine({
  loader: new DbLoader(db, getActiveThemeId(shopId)),
  cache: redisCache,
})
const html = await engine.render('templates/product.liquid', {
  shop, product, request, routes, template: 'product',
})
res.set('Content-Type', 'text/html').send(html)
```

### 3.4 Cache strategy

| What | Where | TTL | Invalidation |
|---|---|---|---|
| Parsed LiquidJS template AST | Per-engine in-memory `Map<key, ParsedTemplate>` | unbounded | bumped when `theme_assets.updated_at` changes (DbLoader checks ETag) |
| Raw template source | Redis `theme:{themeId}:{key}` | 600s | invalidated by `updateThemeAsset` |
| Settings data | Redis `theme:{themeId}:settings` | 600s | invalidated by `updateThemeAsset('config/settings_data.json')` |
| Rendered HTML page | **Not** in this decision — rendered HTML caching is Phase 4.3 | — | — |

### 3.5 Sections & section groups

Shopify's section system has two layers:

1. A **section file** (`sections/hero.liquid`) which contains template + a `{% schema %}` JSON block declaring settings.
2. A **section group / template** (`templates/index.json`) which lists which sections appear on a page in what order, and provides the settings values.

Implementation plan:
- `templates/*.liquid` are rendered directly (legacy + simple pages).
- `templates/*.json` are parsed by `sections.ts` tag, which iterates the listed sections and renders each via the `section.ts` tag.
- A section's `{% schema %}` JSON block is parsed once at theme-load time and the contents are made available as `section.settings.*` inside that section's template scope.

### 3.6 Shopify ambient globals

Available in every render context (matching Shopify Liquid drops):

| Global | Source | Notes |
|---|---|---|
| `shop` | `ShopData` (already typed) | name, currency, domain, etc. |
| `request` | `{ host, path, design_mode, page_type, ... }` | derived from Express req |
| `routes` | static map | `routes.cart_url = '/cart'`, etc. |
| `template` | string | `'product'`, `'collection'`, `'page'` |
| `settings` | from `settings_data.json` `current` block | global theme settings |
| `linklists` | `MenuData[]` | from `menus` table |
| `customer` | `CustomerData \| null` | logged-in customer |
| `cart` | `CartData` | always rendered, even on PDP (so header counter works) |

Page-specific globals (`product`, `collection`, `article`, `blog`, `page`, `search`) are added by the route handler before calling `render()`.

---

## 4. Step-by-step execution plan

> Each step is a single git commit + push to both remotes + green tests before moving to the next. Standing rule: từng bước một.
>
> §4a documents the steps **as actually shipped** (commits 1.1–1.15 on `master` as of 2026-04-09). §4b is the **resumed integration phase** (Steps 1.16–1.23) that brings the engine from "code-complete in isolation" to "actually serving HTML to real shops" + cleanup + release tag.

### 4a. Steps 1.1 – 1.15 (shipped)

> Each row lists the commit hash on `master`, what shipped, and any deviation from the original plan. The deviations are not regressions — every line of code is still on the "clone giống hệt Shopify" critical path. They simply traded plan-ordering for build-ordering: more engine surface up front, deferred wiring/seed/integration to §4b.

| Step | Commit | What shipped | Notes / deviation from original numbering |
|---|---|---|---|
| **1.1** | `c8b3677` | Extract `ShopData/ProductData/VariantData/CartData/CustomerData/ProductImageData/ProductOptionData/CollectionData` into `packages/core/src/modules/themes/shopify-types.ts`; old `engine.ts` re-exports. | Pure refactor. Matches original 1.1. |
| **1.2** | `d5b4f78` | Add `liquidjs@^10` to root + `packages/core/package.json`. ESM verified under tsx. | Matches original 1.2. |
| **1.2a** | `1453c9b` | New `packages/core/src/modules/storage/` module: `ObjectStore` interface + `R2Store` (via `@aws-sdk/client-s3`) + `MemoryStore` + `getObjectStore()` factory. 6 memory-store tests, 3 R2 tests gated on `R2_*` env. | Matches original 1.2a. **Owner action:** R2 bucket `gbox-theme-assets` provisioned; `cdn.gbox.co` DNS still pending — deferred to Step 1.16 owner action below. |
| **1.2b** | `6e0b2aa` | New `packages/core/src/modules/i18n/` module + migration `008_translations.ts`: `translations(shop_id, theme_id, locale, namespace, key, value)` table + `I18nService` (DB + memory impls) + `resolver.resolveLocale()` three-tier chain. 13 tests. | Matches original 1.2b. |
| **1.3** | `47b6e72` | `engine/loader.ts` `TemplateLoader` interface (`load`, `loadWithMeta`, `exists`, `list`) + `StaticLoader` Map-backed impl. 3 unit tests. | Matches original 1.3. The interface grew `loadWithMeta` and `list` to support hot-reload metadata + section-group enumeration — both Shopify-compatible additions. |
| **1.4** | `5a5e279` | `createLiquidEngine()` factory + filter set 1 (`truncate`, `truncatewords`, `strip_html`, `escape`, `handleize`, `link_to`, `asset_url`, `img_url`, `file_url`, `default`, …). | Matches original 1.4. |
| **1.5** | `910113d` | Filter set 2: `money`, `money_with_currency`, `money_without_currency`, `money_without_trailing_zeros`, `weight_with_unit`, numeric (`plus`, `minus`, `times`, `divided_by`, `modulo`, `at_most`, `at_least`, `abs`, `ceil`, `floor`, `round`). | Matches original 1.5. `date` filter shipped under 1.7 with the rest of the layout/section tag set to keep this commit focused on numeric filters. |
| **1.6** | `b078dd9` | `DbLoader` — Postgres-backed `TemplateLoader` over `theme_assets` table with Redis cache layer (`theme:{themeId}:asset:{key}`, 600s TTL). Detects `r2://...` prefix + reads body from `ObjectStore`. | **Deviation:** original 1.6 was `{% schema %}` tag — that ended up shipping inside Step 1.11. DbLoader (originally 1.11) shipped here because Step 1.7's tag set needed a real loader to test against. |
| **1.7** | `16938ce` | Shopify tag set 1: `{% section %}`, `{% schema %}` (raw JSON capture), `{% style %}`, `{% javascript %}`, `{% stylesheet %}`, `{% layout %}` chain. Plus `date` filter. | **Deviation:** condenses original 1.6 (`{% schema %}`) + 1.7 (`{% section %}` + `{% render %}`) + 1.9's style/javascript tags into one commit. `{% render %}` ships via LiquidJS native include alias. |
| **1.8** | `470f56d` | `assets/asset-url-builder.ts` + image-specific filters (`image_url`, `image_tag`, `img_tag`, `img_url`, `image_picture_tag`). R2/CDN public URL shape: `https://cdn.gbox.co/themes/{themeId}/{key}`. | **Deviation:** original 1.8 was `{% sections %}` group tag — that shipped under Step 1.12 as the JSON-template renderer. This commit covers the asset URL builder needed by every Dawn template. |
| **1.9** | `1652eb1` | `{% form %}` tag (action URLs for `cart`/`customer_login`/`customer_register`/`recover_customer_password`/`customer_address`/`product`/`contact` + CSRF token slot) + payment filters (`payment_type_img_url`, `payment_button`, etc.). | Matches original 1.9 minus paginate (which moved to 1.12 alongside the JSON-template renderer because both share the section-group plumbing). |
| **1.10** | `e7b44af` | `pipeline.ts` `renderPage()` orchestrator: layout chain resolution, `{% layout %}` override support, content-for-header / content-for-layout placeholders, meta-tag hoist (`<title>`, `<meta>`, `<link>`), section instance registry. | **Deviation:** original 1.10 was `RenderContext` builder (which ended up living inside `pipeline.ts` as `topScope` + `env` + `extraGlobals` plumbing). This commit is the actual page-render orchestrator. |
| **1.11** | `26e3c79` | `schema/parser.ts` + `schema/types.ts` + `schema/resolver.ts`: parses `{% schema %}` JSON blocks, validates against Shopify's section schema spec (settings, blocks, presets, max_blocks, default), resolves `section.settings.*` against per-instance overrides. | **Deviation:** original 1.11 was the public `createThemeEngine()` API + `DbLoader`. Public API + DbLoader already shipped (1.4 + 1.6); this commit is the schema parser the original 1.6 promised, plus the section-settings resolver the original 1.7 needed. |
| **1.12** | `173b4f9` | `json-template/parser.ts` + `json-template/renderer.ts`: parses `templates/*.json` Shopify section-group format (`{order: [...], sections: {...}}`), renders each section in order with its instance overrides. Plus `{% paginate %}` tag (`paginate.next`, `.previous`, `.pages`, `.parts`). | **Deviation:** original 1.12 was the **Gbox Dawn theme seed** itself — that's now Step 1.17 in §4b. This commit is the original 1.8 (`{% sections %}`) reimagined as the modern JSON-template path Shopify themes actually use, plus the paginate tag deferred from 1.9. |
| **1.13** | `d9e88f2` | `section-api.ts` Section Rendering API: public `renderSection(engine, sectionId, options)` + `renderSections(engine, [...])` for multi-section AJAX endpoints. Mirrors Shopify's `?sections=name1,name2` Section Rendering API. | **Deviation:** original 1.13 was migration 009 + `installGboxDawnTheme` hook — that's now Step 1.18 in §4b. This commit is a brand-new piece of Shopify parity surface area not in the original plan: the Section Rendering API endpoints used by AJAX-cart and theme-editor live preview. |
| **1.14** | `5e3cf63` | `storefront/router.ts` 16-route Shopify storefront router (`/`, `/products`, `/products/:handle`, `/products/:handle.json`, `/collections`, `/collections/:handle`, `/collections/:handle/products/:handle`, `/cart`, `/pages/:handle`, `/blogs/:handle`, `/blogs/:handle/:article`, `/search`, `/policies/:handle`, `/account*`, `/404`, `/500`). Locale prefix support (`/vi/...`). Rate-limited error logger. `MemoryDataSource` + `DataSource` interface. | **Deviation:** original 1.14 was wiring `storefront-server.ts` itself. This commit ships the **router module** end-to-end (handler, datasource interface, locale resolver, error logger) as a self-contained Express-shaped function. The actual `storefront-server.ts` cutover is now Step 1.19. The router was built first because it has 30+ unit tests that would have been impossible to write inside the legacy server file. |
| **1.15** | `71f1d6f` | `theme-config/settings.ts` + `settings-loader.ts` + `theme-locale.ts`: parses `config/settings_schema.json` + `config/settings_data.json` (3 Shopify formats: preset name, inline current, presets-only), `theme_info` filter, render-time `t:` reference resolver for section schema labels, `<locale>[.default][.schema].json` file naming. New `prepareThemeConfig({loader, i18n, shopId})` host helper. Pipeline + section-api + router all wired to read `themeSettings` (= the `settings.*` Liquid drop) and per-locale `schemaLocaleDict`. | **Deviation:** original 1.15 was the E2E HTTP smoke test on server 3 — that's now Step 1.20 in §4b. This commit ships theme settings + locale files end-to-end, which the original plan tucked into "1.10 ambient globals" as a one-line footnote. Shopify-parity-critical: every Dawn section uses `{{ section.settings.* }}` and every label uses `t:section.heading_label`, so this had to ship before the seed. |

**Cumulative test count after Step 1.15:** 843 passed, 3 skipped, 0 failed across the full repo (~748 in the engine alone). Original plan estimated 80; reality shipped **~9× that** because each tag/filter/parser got dedicated table-driven coverage.

---

### 4b. Steps 1.16 – 1.23 (resumed integration phase)

> These are the steps the original plan had as 1.11b, 1.12, 1.13, 1.14, 1.15, 1.16, 1.17, 1.18 — renumbered to 1.16+ so they don't collide with shipped commits. They are the difference between "the engine compiles" and "real shops render real Liquid". Order matters: each builds on the previous.

### Step 1.16 — `updateThemeAsset` large-asset R2 branch  *(was original 1.11b)*
**Touches:** `packages/core/src/modules/themes/service.ts` + tests.

- Modify `service.ts::updateThemeAsset(themeId, key, value, contentType?)`:
  - If `Buffer.byteLength(value, 'utf8') > 256 * 1024` → upload the body via `getObjectStore().put('themes/{themeId}/{key}', value, {contentType})` and store `"r2://themes/{themeId}/{key}"` in `theme_assets.value`.
  - Else → behavior unchanged (inline TEXT).
- Modify `deleteThemeAsset`: if current `value` starts with `r2://`, also call `objectStore.delete()`.
- Modify `duplicateTheme`: for each source asset whose value is `r2://*`, `get()` the body and `put()` it under the new theme's key — never copy R2 keys directly because the key includes the source themeId.
- Add helper `isR2Reference(value: string): boolean` for use by `DbLoader`.
- **Tests:** new `service.test.ts` cases or `service-r2.test.ts` if file is large:
  - small asset stays inline TEXT (no R2 call)
  - large asset uploads to R2 + DB row is `r2://themes/.../...`
  - `deleteThemeAsset` on r2-backed asset deletes both the row and the R2 object
  - `duplicateTheme` copies R2 blob under the new theme's key
- **Owner action carried over from Step 1.2a:** Cloudflare DNS `cdn.gbox.co → gbox-theme-assets.r2.cloudflarestorage.com` is **still pending**. Tests use `MemoryStore`; production env vars (`R2_*`) ship with the bucket already provisioned.

### Step 1.17 — Gbox Dawn theme seed (the actual `.liquid` files)  *(was original 1.12)*
**Touches:** new dir `packages/core/src/modules/themes/seed/gbox-dawn/` + new `seed/gbox-dawn-bundle.ts` (build-time inlined `Map<path, string>`).

The shipped engine can render any Shopify-compatible theme — but no theme exists yet. This step ships the first-party "Gbox Dawn" starter that maps 1:1 to Shopify Dawn's information architecture so a merchant migrating from Shopify sees a familiar layout.

**Files (mirror Shopify Dawn structure):**
- `layout/`
  - `theme.liquid` — `<!doctype html>` shell, `{{ content_for_header }}` + `{% section 'header' %}` + `{{ content_for_layout }}` + `{% section 'footer' %}`
  - `password.liquid` — coming-soon shell for shops in password mode
- `templates/`
  - `index.json` (homepage as section group: hero / featured-collection / image-with-text / newsletter)
  - `product.json` (gallery / info / related)
  - `collection.json` (filter sidebar / product grid)
  - `cart.liquid`
  - `page.liquid`
  - `blog.liquid`
  - `article.liquid`
  - `search.liquid`
  - `404.liquid`
  - `password.liquid`
- `sections/`
  - `header.liquid` (logo, menu, cart icon, search, locale picker)
  - `footer.liquid` (linklists, payment icons, copyright)
  - `hero.liquid` (image bg + heading + cta)
  - `featured-collection.liquid` (product grid pulled from a chosen collection)
  - `image-with-text.liquid`
  - `newsletter.liquid`
  - `main-product.liquid` (gallery + info column + add-to-cart form)
  - `main-collection.liquid` (paginated product grid)
  - `main-cart.liquid` (line items + totals + checkout button)
  - `main-page.liquid` / `main-blog.liquid` / `main-article.liquid` / `main-search.liquid`
- `snippets/`
  - `product-card.liquid`, `price.liquid`, `pagination.liquid`, `breadcrumb.liquid`, `meta-tags.liquid`, `icon-cart.liquid`, `icon-search.liquid`, `quantity-input.liquid`
- `assets/`
  - `theme.css` (port from `packages/storefront/public/theme.css`)
  - `theme.js` (cart drawer + variant picker minimal JS)
- `config/`
  - `settings_schema.json` (theme_info + Colors + Typography + Layout sections)
  - `settings_data.json` (`current` preset = "Default")
- `locales/`
  - `en.default.json` (storefront strings)
  - `en.default.schema.json` (section + settings labels)
  - `vi.json` + `vi.schema.json` (Vietnamese — Thai is Vietnamese, this is table stakes)

**Bundle wiring:** `seed/gbox-dawn-bundle.ts` exports `GBOX_DAWN_FILES: Record<string, string>` — built at compile time by importing each `.liquid` / `.json` / `.css` / `.js` file as a raw string via the existing TS string-import pattern (no `fs` at runtime, Worker-safe).

**Helper:** `seed/install.ts` exports `installGboxDawnTheme(db, shopId, deps): Promise<{themeId: string, alreadyInstalled: boolean}>` — idempotent (no-op if a theme named `'Gbox Dawn'` already exists for `shopId`). Called by Step 1.18. Also imports `locales/en.default.json` + `vi.json` into the `translations` table via `i18n/service.importFromJson`.

**Tests:**
- `seed/install.test.ts` — installs into a `MemoryDataSource` + asserts every expected file landed in `theme_assets`, theme row exists with `name='Gbox Dawn'` and `is_active=true`, idempotent on second call.
- Smoke check: `prepareThemeConfig` against `GBOX_DAWN_FILES` returns a non-empty `themeConfig.settings` and at least `en` + `vi` in `schemaLocales`.
- Render check: feed the bundle through `createLiquidEngine` + `handleStorefrontRequest` for the homepage and assert the response is HTTP 200 with non-empty body containing `<h1>` and the hero CTA.

### Step 1.18 — `installGboxDawnTheme()` hook + migration `009_gbox_dawn_hook.ts`  *(was original 1.13)*
**Touches:** new migration `packages/db/src/migrations/009_gbox_dawn_hook.ts`, `packages/core/src/modules/shops/service.ts` (or wherever `createShop` lives — to be located in this step).

- **Decision (locked in original §0.5 Q2):** App-level hook inside `createShop()`, **not** a Postgres trigger. Reason: trigger can't import translations via the i18n service.
- Migration `009_gbox_dawn_hook.ts` is mostly a marker / forward-compat placeholder — it does **not** backfill existing shops. Body: a SQL comment plus an idempotency-marker row in a `migrations` table if one exists. Down migration is a no-op.
- In `createShop(input)`:
  ```ts
  const shop = await db.transaction().execute(async (tx) => {
    const created = await tx.insertInto('shops').values(...).returningAll().executeTakeFirstOrThrow()
    await installGboxDawnTheme(tx, created.id, { i18n: getI18nService(), objectStore: getObjectStore() })
    return created
  })
  ```
- Idempotent: `installGboxDawnTheme` checks for an existing theme named `'Gbox Dawn'` first.
- **Tests:** integration test (gated on DB) that calls `createShop` and asserts the new shop has an active Gbox Dawn theme + at least one row in `translations`.

### Step 1.19 — Wire `storefront-server.ts` to the engine (legacy fallback branch)  *(was original 1.14)*
**Touches:** `storefront-server.ts` (root, currently 165 lines of hardcoded HTML).

- Refactor the file: keep every existing route, but inside each handler check `getActiveTheme(db, shop.id)`. If a theme exists → delegate to `handleStorefrontRequest` (the Step-1.14 router). If not → fall back to the legacy hardcoded HTML, isolated behind named functions (`legacyHomePage(shop, products)`, `legacyProductPage(shop, product)`, etc.) so a future cleanup can grep-delete them.
- Resolve active theme via the existing `shop-resolver.ts` + a new tiny `getActiveTheme(db, shopId)` helper in `themes/service.ts` (returns `Theme | null`).
- Build a single `handlerOptions: StorefrontHandlerOptions` per request (or memoize per `shopId`):
  ```ts
  const themeConfigResult = await prepareThemeConfig({ loader, i18n, shopId: shop.id })
  const opts: StorefrontHandlerOptions = {
    engine,
    datasource: new DbDataSource(db, shop.id),  // new — see below
    locales: { supported: ['en', 'vi'], default: 'en' },
    themeConfig: themeConfigResult.themeConfig,
  }
  ```
- **New datasource:** `engine/storefront/db-datasource.ts` — implements the existing `DataSource` interface against Postgres (product/collection/page/cart/customer lookups). Mirrors `MemoryDataSource` shape; takes `db: Kysely<DB>` + `shopId: string`. ~200 LOC.
- **Verification:**
  - Local: render homepage in-process via the test infra.
  - Server-2 curl smoke: `curl -H 'Host: <new-shop>.gbox.co' http://192.168.1.2:4321/` → Gbox Dawn HTML; `curl -H 'Host: <legacy-shop>.gbox.co' http://192.168.1.2:4321/` → legacy HTML.
- Note: storefront-server.ts is at the **repo root** (not under `apps/`). Step 1.19 keeps it there to minimize blast radius; relocating into `apps/storefront/` is a separate decision.

### Step 1.20 — E2E smoke test on real HTTP (9 page types)  *(was original 1.15)*
**Touches:** new `scripts/smoke-storefront-render-e2e.ts` (separate from the existing in-process `smoke-liquid-step-1-15.ts`).

- Boots `storefront-server.ts` on a free port (or assumes it's already running on server 2 port 4321) and `fetch()`s 9 page types:
  1. `/` (homepage)
  2. `/products` (product index)
  3. `/products/<seeded-handle>` (PDP)
  4. `/collections/<seeded-handle>` (collection page)
  5. `/cart` (empty cart)
  6. `/pages/<seeded-handle>` (static page)
  7. `/blogs/<seeded-handle>` (blog index — may be empty body)
  8. `/search?q=test` (search)
  9. `/404` (404 page — must NOT be a 200; assert `status === 404` + body contains hero text)
- Each page asserts: HTTP 200 (or 404 for the last), response body contains a Gbox-Dawn-specific marker (e.g. shop name, hero h1, cart count), and a `t:` resolved string proves locale dict ran.
- Also fetches `/vi/` and asserts `Content-Language: vi` + Vietnamese hero text.
- Run target: server 2 (`192.168.1.2`) — local Windows box can't reach the production PG.
- Acceptance gate: all 10 fetches green before Step 1.21 starts.

### Step 1.21 — Worker isomorphic test  *(was original 1.16)*
**Touches:** new `packages/core/src/modules/themes/engine/tests/isomorphic.test.ts`.

- Instantiates the engine with `StaticLoader` only — no DB, no Redis, no `fs`.
- Renders the Gbox Dawn bundle from Step 1.17 end-to-end (homepage + product + cart) and asserts the HTML contains the expected hero text + add-to-cart form action.
- Adds a static guard: walks `engine/**/*.ts` build output (or imports the index module and throws on first symbol whose source has `from 'fs'` / `from 'path'` / `process.cwd`). LiquidJS's own bundle is already known-clean; this test is a tripwire for any future regression.
- This is what unblocks Decision #6's potential future flip to Workers SSR for the storefront.

### Step 1.22 — Delete the `nunjucks` dependency  *(was original 1.17)*
**Touches:** root `package.json`, lockfile, any straggling import in the repo.

- Grep for `nunjucks` across the repo (excluding `node_modules`, `docs/`, this spec).
- Currently the only references are in root `package.json` (`"nunjucks": "^3.2.4"` + `"@types/nunjucks": "^3.2.6"`) — confirmed via grep.
- After Step 1.19, no source file imports `nunjucks`. Remove both deps. Run `pnpm install`. Verify `pnpm test` still green.
- The old `engine.ts` file at `packages/core/src/modules/themes/engine.ts` was already deleted earlier in the rewrite (now lives as `engine/index.ts`); no body-replace needed.

### Step 1.23 — Documentation + final commit + tag `decision-1-complete`  *(was original 1.18)*
**Touches:** `CLAUDE-EXTENDED.md`, this spec (status: **shipped**), git tag.

- Update `CLAUDE-EXTENDED.md` with:
  - Module map for `themes/engine/` (tags, filters, schema, json-template, theme-config, storefront, assets, section-api, pipeline)
  - Public API surface (`createLiquidEngine`, `handleStorefrontRequest`, `prepareThemeConfig`, `installGboxDawnTheme`, `renderSection(s)`)
  - Cache strategy summary
  - Known caveats (DNS for `cdn.gbox.co` still pending; isomorphic test guard is allow-list, not deny-list)
- Mark this spec `Status: shipped 2026-04-XX`.
- `git tag decision-1-complete` + push to both remotes.

---

## 5. Test plan summary

### 5a. Shipped (Steps 1.1 – 1.15)

Original plan estimated 80 tests cumulatively. Reality shipped vastly more because every tag, filter, parser, and resolver got dedicated table-driven coverage.

| Source | Test files | Approx. cases |
|---|---|---|
| `storage/` (memory + r2-gated) | 2 | 9 |
| `i18n/` (resolver + memory + service-gated) | 3 | 13 |
| `themes/engine/filters/` (string/url/money/numeric/image/form/i18n/date) | 8 | ~120 |
| `themes/engine/tags/` (section/schema/style/javascript/layout/paginate/form) | 5 | ~80 |
| `themes/engine/schema/` (parser + resolver) | 2 | ~40 |
| `themes/engine/json-template/` (parser + renderer) | 2 | ~30 |
| `themes/engine/theme-config/` (settings + locale + loader) | 3 | ~50 |
| `themes/engine/storefront/` (router + datasource + locale + error-logger + theme-config-loader + adapter) | 6 | ~110 |
| `themes/engine/assets/` (asset-url-builder) | 1 | ~10 |
| `themes/engine/` core (loader / static-loader / db-loader / liquid / pipeline / section-api) | ~6 | ~120 |
| **Total engine coverage** | **~31 files** | **~748 cases** |
| Repo-wide (engine + storage + i18n + checkout + accounts + ...) | — | **843 passed / 3 skipped / 0 failed** |

### 5b. Resumed integration phase (Steps 1.16 – 1.23)

| Step | New tests | Notes |
|---|---|---|
| 1.16 | `service-r2.test.ts` — 4 cases (small inline, large→R2, delete cleans R2, duplicate copies blob) | Uses `MemoryStore` instead of real R2; production env vars wire the real bucket. |
| 1.17 | `seed/install.test.ts` — bundle-completeness + idempotency + render-smoke (~6 cases) | Bundle file count match; render homepage end-to-end with `MemoryDataSource`. |
| 1.18 | `createShop` integration test — 1 case (gated on DB) | Asserts new shop has active Gbox Dawn theme + non-empty `translations` rows. |
| 1.19 | No new unit tests — Step 1.20 covers this end-to-end | `DbDataSource` reuses the `DataSource` interface contract from existing memory-datasource tests. |
| 1.20 | `scripts/smoke-storefront-render-e2e.ts` — 10 page fetches | Run on server 2 against live PG. |
| 1.21 | `tests/isomorphic.test.ts` — 1 master test, ~12 inner asserts | Static-loader-only render of full Dawn bundle. |
| 1.22 | None | Just removes a dep. Smoke + unit suite re-runs as the gate. |
| 1.23 | None | Doc + tag. |

**Acceptance gate before tagging `decision-1-complete`:** 5a + 5b all green; Step 1.20 E2E smoke green from server 2 against live PG + Redis (R2 still gated on DNS); Step 1.21 isomorphic test green.

---

## 6. Non-goals (explicitly deferred)

- **Visual theme editor.** Decision #1 only ships the engine + Dawn-clone. The drag-and-drop editor in masterplan §2.4 is a separate decision.
- **Theme marketplace.** Built-in 5 themes from masterplan §2.5 — only Gbox Dawn ships in Decision #1.
- **Theme upload from .zip.** Merchant theme upload is deferred.
- **Liquid filter parity at 100%.** We ship the ~30 filters Dawn actually uses. Long tail (e.g. `payment_button`, `customer_login_link`, `pluralize`) is added on demand.
- **Multi-currency rendering.** `money` filter uses shop currency only — presentment_money is Decision (Phase 4.1.1) and will be wired into the filter later.
- **Translation editor / i18n strings UI.** `t` filter falls back to English; merchants can't edit translations yet.
- **Section design schema editor.** Sections ship with hand-written `{% schema %}` JSON; no UI for editing them.

---

## 7. Risks & mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| LiquidJS parser doesn't accept Shopify's `{% schema %}` raw JSON block | Medium | Implement `{% schema %}` as a custom Tag that consumes everything until `{% endschema %}` as raw text — bypasses LiquidJS's expression parser entirely. |
| Dawn theme uses filters we haven't implemented | High | Run a grep against the seed files and triage. Implement missing filters in Step 1.4/1.5 before Step 1.12. |
| `theme_assets.value` is currently TEXT — large theme files may need TOAST tuning | Low | Postgres TOAST handles up to 1GB transparently. Monitor row sizes after seed. |
| Engine accidentally imports `fs` via a transitive dep of LiquidJS | Medium | Step 1.16 isomorphic test will catch it. If LiquidJS's "Node mode" pulls fs, configure it to "Browser mode" (`new Liquid({ fs: customFs })`). |
| Existing storefront server breaks during 1.14 cutover | Medium | Keep the old code paths in a `/legacy/*` route group during the transition. Smoke test 1.15 must pass before deleting. |

---

## 8. Open questions — ALL ANSWERED (see §0.5)

| # | Question | Thai's answer |
|---|---|---|
| 1 | Theme name | **Gbox Dawn** |
| 2 | Backfill existing shops? | **No — new shops only** (hook inside `createShop`) |
| 3 | Large theme assets (>256KB) | **R2** via new `storage/` module |
| 4 | `t` filter | **Real i18n module**, not a stub |

## 8b. §8b answers (session 3) — all locked

| # | Question | Thai's answer | Implementation |
|---|---|---|---|
| 1 | R2 bucket name | **`gbox-theme-assets`** | Default in `R2Store` ctor, overridable via `R2_BUCKET` env. |
| 2 | R2 public CDN URL pattern | **Custom domain `https://cdn.gbox.co/themes/{themeId}/{key}`** | `R2Store.url()` emits `https://cdn.gbox.co/themes/...`. `R2_PUBLIC_BASE_URL=https://cdn.gbox.co` env var. **Owner action at Step 1.2a:** bind `cdn.gbox.co` to the R2 bucket in the CF dashboard + add DNS `CNAME cdn → gbox-theme-assets.r2.cloudflarestorage.com` (proxied). |
| 3 | i18n locale fallback | **`request.locale → shop.default_locale → 'en'`** (three-tier) | `resolveLocale(req, shop)` implements the chain. Middle tier reads `shop.default_locale` via a helper function `getShopDefaultLocale(shop)`. |
| 4 | `shop.default_locale` column | **Hard-code to `'en'` for now — column added in a later decision** | `getShopDefaultLocale(shop)` returns `'en'` unconditionally in Decision #1. The three-tier API from Q3 stays intact, so when the column is added later, the only change is inside the helper — no caller refactor. This keeps Decision #1 DB surface minimal per Thai's "hard-code, mình còn review fix nhiều". |

---

## 9. Touch surface (revised 2026-04-09)

### 9a. Shipped (Steps 1.1 – 1.15)

| Module | New files | LOC (approx., src + test) |
|---|---|---|
| `themes/shopify-types.ts` | 1 | 250 |
| `storage/` | 6 | 455 |
| `i18n/` | 8 | 543 |
| `themes/engine/` (filters, tags, schema, json-template, theme-config, storefront, assets, pipeline, section-api, loaders, factory) | ~69 (38 src + 31 test) | ~12,000 |
| Migrations | `008_translations.ts` | ~80 |
| Smoke scripts | 13 (`smoke-liquid-step-1-*.ts`, `smoke-i18n-step-1-2b.ts`, `smoke-loader-step-1-3.ts`, `smoke-storage-step-1-2a.ts`, `smoke-liquidjs-step-1-2.ts`) | ~3,000 |
| **Subtotal** | **~97 new files** | **~16,300 LOC (incl. tests)** |

Vs. original estimate of ~4,200 LOC / ~38 new files: shipped reality is ~4× larger because the engine grew dedicated modules for `theme-config/`, `json-template/`, `section-api`, `assets/`, `error-logger`, `storefront/locale.ts`, plus exhaustive table-driven tests.

### 9b. Resumed integration phase (Steps 1.16 – 1.23)

| Step | New / modified files | LOC (approx.) |
|---|---|---|
| 1.16 | `themes/service.ts` (modified) + `themes/service-r2.test.ts` | +200 |
| 1.17 | `themes/seed/gbox-dawn/**` (~30 `.liquid` + `.json` + `.css` + `.js` files) + `seed/gbox-dawn-bundle.ts` + `seed/install.ts` + `seed/install.test.ts` | +2,200 |
| 1.18 | `db/migrations/009_gbox_dawn_hook.ts` + `shops/service.ts` (modified) + integration test | +150 |
| 1.19 | `storefront-server.ts` (modified) + `engine/storefront/db-datasource.ts` + `themes/service.ts` (`getActiveTheme` helper) | +400 |
| 1.20 | `scripts/smoke-storefront-render-e2e.ts` | +250 |
| 1.21 | `engine/tests/isomorphic.test.ts` | +200 |
| 1.22 | `package.json` (delete `nunjucks` + `@types/nunjucks`) | −2 |
| 1.23 | `CLAUDE-EXTENDED.md` + this spec + git tag | +200 |
| **Subtotal** | | **~3,600 LOC added** |

### 9c. Total Decision #1 footprint at completion

- **~20,000 LOC added** (engine + storage + i18n + seed + integration + tests + smokes + docs)
- **~5 LOC deleted** (`nunjucks` deps + zero source files — the old `engine.ts` was already deleted in 1.7)
- **~110 new files**

Almost entirely additive. The only "deletion" is the npm dep cleanup in Step 1.22.
