/**
 * Gbox Platform — Shopify-compatible Image + Asset Filters
 *
 * Decision #1 Step 1.8 — The production filter set that replaces the
 * passthrough stubs from Step 1.4 (`assetUrlStub` / `imgUrlStub` in
 * filters/url.ts). Every filter delegates to an injected
 * `AssetUrlBuilder`, so the URL scheme is configurable per
 * environment (dev relative, preview workers, prod R2/CDN) without
 * touching the filter code.
 *
 * Filters registered:
 *
 *   asset_url               — theme asset ('theme.css' → /assets/theme.css)
 *   global_asset_url        — platform global asset
 *   shopify_asset_url       — Shopify compat alias for global_asset_url
 *   file_url                — merchant-uploaded file
 *
 *   img_url                 — image with optional size token
 *   image_url               — alias (newer Shopify docs prefer this name)
 *   product_img_url         — alias; Shopify distinguishes for legacy
 *   collection_img_url      — alias
 *   article_img_url         — alias
 *   asset_img_url           — theme-bundled image with size
 *   file_img_url            — merchant file with size
 *
 *   img_tag                 — wraps img URL in <img src="..." alt="...">
 *   image_tag               — alias
 *   stylesheet_tag          — wraps URL in <link rel="stylesheet">
 *   script_tag              — wraps URL in <script src="...">
 *
 * Why so many aliases? Shopify themes in the wild were written over
 * many years and mix the old (`img_url`, `product_img_url`) and the
 * new (`image_url`) naming. Themes ported to Gbox will use one or
 * the other or both — registering every name keeps porting painless.
 *
 * IMPORTANT: This file does NOT register `url_*`, `link_to*`,
 * `within`. Those stay in `url.ts` because they don't need the
 * asset builder and they ship with Step 1.4's filter set.
 */

import type { Liquid } from 'liquidjs'
import {
  parseSizeToken,
  type AssetUrlBuilder,
  type ImageInput,
  type ImageSize,
} from '../assets/asset-url-builder.js'

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

function toStr(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  return String(v)
}

function htmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Coerce the `size` argument from a filter call into something the
 * builder understands. Filter args can be numbers, strings, or
 * objects depending on how the theme writes them. We accept:
 *
 *   - undefined / null / ''     → original size
 *   - string (token or WxH)     → passed through to parseSizeToken
 *   - number                    → treated as `{width: N}`
 *   - object                    → structural ImageSize
 */
function coerceSizeArg(
  arg: unknown,
): string | ImageSize | undefined {
  if (arg === undefined || arg === null || arg === '') return undefined
  if (typeof arg === 'string') return arg
  if (typeof arg === 'number' && arg > 0) return { width: arg }
  if (typeof arg === 'object') {
    // Allow `{ width, height, crop }`, mirroring the builder's ImageSize.
    const obj = arg as Record<string, unknown>
    const out: ImageSize = {}
    if (typeof obj.width === 'number') out.width = obj.width
    if (typeof obj.height === 'number') out.height = obj.height
    const c = obj.crop
    if (
      c === 'center' ||
      c === 'top' ||
      c === 'bottom' ||
      c === 'left' ||
      c === 'right'
    ) {
      out.crop = c
    }
    return out
  }
  return undefined
}

/**
 * Pick an `alt` text from an image drop, falling back through the
 * Shopify field name chain (`alt` → `alt_text` → `title`).
 */
function altTextOf(image: ImageInput): string {
  if (!image || typeof image !== 'object') return ''
  const obj = image as Record<string, unknown>
  if (typeof obj.alt === 'string') return obj.alt
  if (typeof obj.alt_text === 'string') return obj.alt_text
  if (typeof obj.title === 'string') return obj.title
  return ''
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register every image/asset URL + tag filter on a Liquid instance.
 * Called once per engine from `createLiquidEngine()` with the
 * environment's configured `AssetUrlBuilder`.
 *
 * Why we take the builder as a closure argument instead of reading
 * it off the Liquid instance: LiquidJS doesn't expose a "plugin
 * state" slot on `Liquid`, and stashing it on `liquid.options` would
 * pollute a surface that Liquid itself uses. A closure is cheap and
 * keeps the dependency explicit.
 */
export function registerImageFilters(
  liquid: Liquid,
  builder: AssetUrlBuilder,
): void {
  // ---- URL-only filters --------------------------------------------------

  liquid.registerFilter('asset_url', (file: unknown) =>
    builder.assetUrl(toStr(file)),
  )
  liquid.registerFilter('global_asset_url', (file: unknown) =>
    builder.globalAssetUrl(toStr(file)),
  )
  // `shopify_asset_url` in the Shopify docs points at Shopify-hosted
  // CDN resources (e.g. `option_selection.js`). For us those live in
  // the same global-asset origin, so we alias it.
  liquid.registerFilter('shopify_asset_url', (file: unknown) =>
    builder.globalAssetUrl(toStr(file)),
  )
  liquid.registerFilter('file_url', (file: unknown) =>
    builder.fileUrl(toStr(file)),
  )

  // ---- Image URL filters -------------------------------------------------

  const imgUrlFn = (image: unknown, size?: unknown): string =>
    builder.imgUrl(image as ImageInput, coerceSizeArg(size))

  liquid.registerFilter('img_url', imgUrlFn)
  // Newer Shopify doc name + common alias list:
  liquid.registerFilter('image_url', imgUrlFn)
  liquid.registerFilter('product_img_url', imgUrlFn)
  liquid.registerFilter('collection_img_url', imgUrlFn)
  liquid.registerFilter('article_img_url', imgUrlFn)

  liquid.registerFilter('asset_img_url', (file: unknown, size?: unknown) =>
    builder.assetImgUrl(toStr(file), coerceSizeArg(size)),
  )
  liquid.registerFilter('file_img_url', (file: unknown, size?: unknown) =>
    builder.fileImgUrl(toStr(file), coerceSizeArg(size)),
  )

  // ---- HTML tag wrappers -------------------------------------------------

  /**
   * `{{ image | img_tag }}` — render `<img>` with src + alt + optional
   * size + optional class.
   *
   * Shopify signature: `img_tag(image, alt?, classes?, size?)`. We
   * accept the same positional args. Size, when provided, is applied
   * to the URL AND emitted as explicit width/height attributes so the
   * browser can reserve space before the image loads (prevents CLS).
   */
  const imgTagFn = (
    image: unknown,
    alt?: unknown,
    classes?: unknown,
    size?: unknown,
  ): string => {
    const input = image as ImageInput
    const coerced = coerceSizeArg(size)
    const src = builder.imgUrl(input, coerced)
    if (!src) return ''

    // Alt text: explicit arg wins, else pull from the drop.
    const altText = alt !== undefined ? toStr(alt) : altTextOf(input)
    const classAttr = classes ? ` class="${htmlEscape(toStr(classes))}"` : ''

    // Resolve dimensions for width/height attrs: prefer explicit size,
    // fall back to the drop's `.width`/`.height` fields if present.
    //
    // When `size` is a string token (`"300x400"`, `"medium"`), we parse
    // it to get numeric w/h — the builder also parses it internally to
    // build the URL, but the tag renderer needs the numbers too so it
    // can emit `width="..."`/`height="..."` attrs (prevents CLS).
    let w: number | undefined
    let h: number | undefined
    if (coerced && typeof coerced === 'object') {
      w = coerced.width
      h = coerced.height
    } else if (typeof coerced === 'string') {
      const parsed = parseSizeToken(coerced)
      if (parsed) {
        w = parsed.width
        h = parsed.height
      }
    }
    if (w === undefined && h === undefined && typeof input === 'object' && input !== null) {
      const obj = input as Record<string, unknown>
      if (typeof obj.width === 'number') w = obj.width
      if (typeof obj.height === 'number') h = obj.height
    }
    const wAttr = w ? ` width="${w}"` : ''
    const hAttr = h ? ` height="${h}"` : ''

    return (
      `<img src="${htmlEscape(src)}"` +
      ` alt="${htmlEscape(altText)}"` +
      classAttr +
      wAttr +
      hAttr +
      ` />`
    )
  }

  liquid.registerFilter('img_tag', imgTagFn)
  liquid.registerFilter('image_tag', imgTagFn)

  /**
   * `{{ 'theme.css' | asset_url | stylesheet_tag }}` → `<link>` tag.
   * Shopify's second arg is `media`, defaulting to `all`.
   */
  liquid.registerFilter(
    'stylesheet_tag',
    (url: unknown, media: unknown = 'all') => {
      const href = toStr(url)
      if (!href) return ''
      const m = toStr(media) || 'all'
      return `<link href="${htmlEscape(href)}" rel="stylesheet" type="text/css" media="${htmlEscape(m)}" />`
    },
  )

  /**
   * `{{ 'theme.js' | asset_url | script_tag }}` → `<script>` tag.
   * Shopify emits `type="text/javascript"` which is redundant in
   * HTML5 but required for backwards compatibility with old themes.
   */
  liquid.registerFilter('script_tag', (url: unknown) => {
    const src = toStr(url)
    if (!src) return ''
    return `<script src="${htmlEscape(src)}" type="text/javascript"></script>`
  })
}
