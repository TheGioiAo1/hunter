/**
 * Gbox Platform — LiquidJS Engine Factory
 *
 * Decision #1 Step 1.4 — Construct the `Liquid` instance the theme
 * engine will use for every render. This file is where LiquidJS and
 * our loader/i18n layers meet.
 *
 * Design decisions (all from Decision #1 spec §0 Q1-Q4):
 *
 *   - `strictFilters: true`  — A typo in a filter name (`{{ x | upcas }}`)
 *                              should THROW, not silently pass x through.
 *                              This catches bugs at template-author time
 *                              instead of at production traffic time.
 *   - `strictVariables: false` — Missing variables render as empty
 *                              string. Shopify themes rely on this for
 *                              optional drops like `{{ cart.note }}` or
 *                              `{{ customer.first_name }}` on logged-out
 *                              pages. Enabling strictVariables would
 *                              require every theme to wrap every drop
 *                              in `{% if %}`.
 *   - `cache: true`          — Parse-tree cache per process. A typical
 *                              theme has ~50 templates and re-parsing
 *                              them on every request would cost ~1ms/req.
 *                              Cache is invalidated by swapping the
 *                              engine instance on theme upgrade.
 *   - `outputEscape: undefined` — NOT auto-escaping. Matches Shopify
 *                              Liquid (Ruby) exactly: `{{ value }}`
 *                              emits raw text, merchants must call
 *                              `| escape` explicitly. Auto-escape
 *                              would break every theme ported from
 *                              the Shopify theme store.
 *   - `extname: '.liquid'`   — Matches Shopify; lets `{% render 'x' %}`
 *                              resolve to `snippets/x.liquid`.
 *   - `relativeReference: false` — Disables `./foo` style resolution.
 *                              Shopify has a flat namespace per directory;
 *                              `{% render 'header' %}` always means
 *                              `snippets/header.liquid` regardless of
 *                              which file did the `render`.
 *
 * The factory returns both the raw `Liquid` instance and a bundle of
 * helper references so downstream code (the render pipeline in
 * Step 1.10) can pull out the i18n service without re-reading the
 * options bag.
 */

import { Liquid, type FS, type LiquidOptions } from 'liquidjs'
import type { I18nService } from '../../i18n/index.js'
import type { TemplateLoader } from './loader.js'
import { registerStringFilters } from './filters/string.js'
import { registerUrlFilters } from './filters/url.js'
import { registerI18nFilters } from './filters/i18n.js'
import { registerMoneyFilters } from './filters/money.js'
import { registerNumericFilters } from './filters/numeric.js'
import { registerImageFilters } from './filters/image.js'
import { registerFormFilters } from './filters/form.js'
import { registerSectionTag } from './tags/section.js'
import { registerMetaBlockTags } from './tags/meta-blocks.js'
import { registerLayoutTag } from './tags/layout.js'
import { registerFormTag } from './tags/form.js'
import { registerPaginateTag } from './tags/paginate.js'
import {
  DefaultAssetUrlBuilder,
  type AssetUrlBuilder,
} from './assets/asset-url-builder.js'

// ---------------------------------------------------------------------------
// Loader adapter — TemplateLoader → LiquidJS FS
// ---------------------------------------------------------------------------

/**
 * LiquidJS is happy with one root + sync OR async file methods. Our
 * loader layer is async-only (because DbLoader and any future R2 loader
 * can't be sync), so the sync methods throw a clear error if ever
 * reached. The engine is configured to use `parseAndRender` / `renderFile`
 * (the async path) everywhere, so the sync methods should never fire
 * in practice — the throw is an assertion, not a code path.
 */
export function loaderToLiquidFS(loader: TemplateLoader): FS {
  const SYNC_UNSUPPORTED = new Error(
    `[gbox-engine] Sync file access is not supported. This loader ` +
      `(${loader.name}) is async-only. Use engine.parseAndRender() ` +
      `or engine.renderFile() — never engine.renderFileSync().`,
  )

  const fs: FS = {
    // Async methods — the real path.
    async exists(filepath: string): Promise<boolean> {
      return loader.exists(filepath)
    },
    async readFile(filepath: string): Promise<string> {
      const src = await loader.load(filepath)
      if (src === null) {
        // Liquid expects readFile to throw on missing — but only after
        // exists() has confirmed presence. When Liquid calls readFile
        // blindly during recursive resolution, we fall through to the
        // standard ENOENT-like error.
        throw new Error(`[gbox-engine] template not found: ${filepath}`)
      }
      return src
    },

    // Sync methods — never used, but the FS type requires them.
    existsSync: () => {
      throw SYNC_UNSUPPORTED
    },
    readFileSync: () => {
      throw SYNC_UNSUPPORTED
    },

    // Path math. Because we use logical paths (not filesystem paths),
    // the resolve/dirname logic is intentionally minimal.
    resolve(dir: string, file: string, ext: string): string {
      // `dir` is one of the lookup roots LiquidJS is probing. Under
      // our config that's `''` (root), `'snippets'` (for `{% render %}`),
      // or `'layout'` (for `{% layout %}`). `file` is the child reference
      // from the tag, e.g. `'card'` from `{% render 'card' %}`.
      //
      // We join dir + file with a forward slash (our loader is POSIX-
      // only, normalizeLogicalPath rejects backslashes), then append the
      // extension if missing. This gives LiquidJS a logical path like
      // `snippets/card.liquid` which our StaticLoader can serve directly.
      //
      // Edge cases:
      //   - `dir === ''` → no prefix, leaves `file` as-is (root lookup).
      //   - `file` already ends in `.liquid` → don't double-append.
      //   - `file` starts with `/` → strip so we always produce a
      //     relative logical path.
      const clean = file.startsWith('/') ? file.slice(1) : file
      const withExt = clean.endsWith(ext) ? clean : clean + ext
      if (!dir) return withExt
      // Trim a trailing slash on dir just in case.
      const base = dir.endsWith('/') ? dir.slice(0, -1) : dir
      return base + '/' + withExt
    },

    sep: '/',

    dirname(file: string): string {
      const idx = file.lastIndexOf('/')
      return idx >= 0 ? file.substring(0, idx) : ''
    },
    // Don't implement `contains` — we've already done path confinement
    // in the loader normalizer. LiquidJS falls back to "always contained"
    // which is fine because we never let untrusted paths reach here.
  }
  return fs
}

// ---------------------------------------------------------------------------
// Engine factory
// ---------------------------------------------------------------------------

export interface CreateLiquidEngineOptions {
  /** Where templates come from (filesystem for seed, DB for production). */
  loader: TemplateLoader

  /** Translation service for the `t` filter. */
  i18n: I18nService

  /**
   * URL builder for `asset_url`, `img_url`, `stylesheet_tag`, etc.
   * Defaults to a `DefaultAssetUrlBuilder` with relative paths
   * (`/assets`, `/cdn/files`, `/global`) which is fine for dev and
   * tests. Production should inject a CDN-aware builder with the
   * theme's cache-bust token.
   */
  assetUrlBuilder?: AssetUrlBuilder

  /**
   * LiquidJS options override. Only use this in tests — production code
   * should rely on the defaults so every shop gets identical behaviour.
   */
  liquidOptions?: Partial<LiquidOptions>
}

/**
 * Bundle returned from `createLiquidEngine()`. Exposes the `Liquid`
 * instance plus the services it was built with, so the render pipeline
 * can reach them without re-reading the caller's args.
 */
export interface LiquidEngine {
  readonly liquid: Liquid
  readonly loader: TemplateLoader
  readonly i18n: I18nService
  readonly assetUrlBuilder: AssetUrlBuilder
}

/**
 * Build a ready-to-use LiquidJS engine with Gbox defaults wired in.
 *
 * Usage:
 *
 *   const engine = createLiquidEngine({
 *     loader: new StaticLoader('path/to/theme'),
 *     i18n: new MemoryI18nService({ shop_1: { en: { ... } } }),
 *   })
 *
 *   const html = await engine.liquid.parseAndRender(
 *     'Hello {{ name | upcase }}',
 *     { name: 'thai' },
 *   )
 */
export function createLiquidEngine(opts: CreateLiquidEngineOptions): LiquidEngine {
  const fs = loaderToLiquidFS(opts.loader)
  const assetUrlBuilder = opts.assetUrlBuilder ?? new DefaultAssetUrlBuilder()

  const liquid = new Liquid({
    extname: '.liquid',
    strictFilters: true,
    strictVariables: false,
    cache: true,
    relativeReference: false,
    // outputEscape intentionally omitted — Shopify Liquid does NOT
    // auto-escape. Themes call `| escape` explicitly when needed.
    fs,
    root: '', // logical paths are root-relative by convention
    // `partials` is the directory LiquidJS's default `{% render %}` and
    // `{% include %}` tags look in. Shopify themes keep reusable snippets
    // under `snippets/`, so we tell LiquidJS the same. This means
    // `{% render 'card' %}` resolves to `snippets/card.liquid` via our
    // StaticLoader without any tag rewriting.
    //
    // `layouts` is the directory LiquidJS's `{% layout %}` tag (the
    // LiquidJS-specific extension, not Shopify's `{% layout 'theme' %}`
    // from theme.liquid) looks in. Shopify convention is `layout/`.
    //
    // Both are arrays because LiquidJS supports multi-root lookup — we
    // pass a single-element array per Shopify's flat namespace.
    partials: ['snippets'],
    layouts: ['layout'],
    jsTruthy: false, // Shopify-compatible truthiness (empty array/object is truthy)
    ...opts.liquidOptions,
  })

  // Register every filter shipped so far. Each set lives in its own
  // module so additional sets (image filters Step 1.8, form filters
  // Step 1.9, etc.) can register into the same instance without
  // touching this file.
  registerStringFilters(liquid)
  registerUrlFilters(liquid)
  registerNumericFilters(liquid)
  registerMoneyFilters(liquid)
  registerImageFilters(liquid, assetUrlBuilder)
  registerFormFilters(liquid, assetUrlBuilder)
  registerI18nFilters(liquid, opts.i18n)

  // Shopify-flavored tags. Registration order is important for the
  // `layout` tag: we must replace LiquidJS's built-in LayoutTag, so
  // register AFTER the Liquid constructor has populated `tags` with
  // the defaults (which happens synchronously in `new Liquid(...)`
  // above — so by this point we're safely after defaults).
  registerSectionTag(liquid, opts.loader)
  registerMetaBlockTags(liquid)
  registerLayoutTag(liquid)
  registerFormTag(liquid)
  registerPaginateTag(liquid)

  return { liquid, loader: opts.loader, i18n: opts.i18n, assetUrlBuilder }
}
