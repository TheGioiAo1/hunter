/**
 * Clone Pro — JavaScript Cloner
 *
 * Extracts and downloads JavaScript from a source website for cloning.
 * Separates theme/functional JS (needed for visual/interactive fidelity)
 * from tracking/analytics JS (stripped to keep the clone clean).
 *
 * KEEP: Swiper, jQuery, lazy-load, theme JS, menu/accordion init scripts
 * STRIP: GTM, GA, Hotjar, Clarity, Klaviyo, FB Pixel, Shopify analytics, etc.
 */

import * as cheerio from 'cheerio'
import crypto from 'crypto'
import { safeFetch } from '../../clone-shopify/safe-fetch.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ClonedScript {
  type: 'external' | 'inline'
  /** For external: the original URL. For inline: undefined */
  originalUrl?: string
  /** The JS source code */
  source: string
  /** Local path for serving (external scripts only) */
  localPath?: string
  /** Buffer for external scripts */
  buffer?: Buffer
  /** Position in the original HTML (for ordering) */
  position: number
}

export interface JSCloneResult {
  /** Scripts to include in the cloned page */
  scripts: ClonedScript[]
  /** Scripts that were stripped (for logging) */
  stripped: string[]
  stats: {
    total: number
    kept: number
    stripped: number
    externalDownloaded: number
    inlineKept: number
    errors: string[]
  }
}

// ---------------------------------------------------------------------------
// Strip patterns — URL substrings for external scripts to STRIP
// ---------------------------------------------------------------------------

const STRIP_URL_PATTERNS: readonly string[] = [
  // Google Tag Manager / Analytics
  'googletagmanager.com',
  'google-analytics.com',
  'gtag/js',
  'gtm.js',
  'gtag.js',
  'ga.js',
  'analytics.js',

  // Hotjar
  'hotjar.com',
  'static.hotjar.com',

  // Microsoft Clarity
  'clarity.ms',

  // Klaviyo
  'klaviyo.com',
  'static.klaviyo.com',
  'static-tracking.klaviyo.com',

  // Facebook / Meta Pixel
  'connect.facebook.net',
  'facebook.com/tr',
  'fbevents.js',

  // hCaptcha
  'hcaptcha.com',
  'js.hcaptcha.com',

  // Shopify analytics & tracking
  'monorail-edge.shopifysvc.com',
  'cdn.shopify.com/shopifycloud/shopify-analytics',
  'cdn.shopify.com/shopifycloud/web-pixels',
  'cdn.shopify.com/shopifycloud/consent-tracking-api',
  'shopify-analytics',
  'monorail',

  // Shopify non-visual JS
  'shop-js',
  'portable-wallets',
  'shopify-payment',
  'shop-pay',
  'shopify.com/checkouts',

  // Third-party Shopify apps (tracking/popup/review)
  'bogos.io',
  'sellup',
  'judge.me/widget',
  'judge.me/sentry',
  'loox.io',
  'stamped.io/files',
  'yotpo.com',
  'privy.com',
  'omnisend.com',
  'mailchimp.com',
  'sumo.com',
  'optimonk.com',
  'pushowl.com',
  'onesignal.com',
  'tidio.co',
  'intercom.io',
  'drift.com',
  'tawk.to',
  'zendesk.com/web_widget',
  'livechatinc.com',
  'crisp.chat',

  // Generic tracking/ad
  'doubleclick.net',
  'googlesyndication.com',
  'googleadservices.com',
  'google.com/recaptcha',
  'gstatic.com/recaptcha',
  'ads-twitter.com',
  'snap.licdn.com',
  'bat.bing.com',
  'sc-static.net', // Snapchat pixel
  'pinterest.com/v3/pidgets',
  'pintrk',
  'tiktok.com/i18n',
  'analytics.tiktok.com',

  // Cookie consent banners (visual but not needed for clone)
  'cookiebot.com',
  'cookieconsent',
  'osano.com',
  'onetrust.com',
]

// ---------------------------------------------------------------------------
// Strip patterns — inline script content patterns to STRIP
// ---------------------------------------------------------------------------

const STRIP_INLINE_PATTERNS: readonly RegExp[] = [
  // Google Tag Manager
  /googletagmanager\.com/i,
  /gtag\s*\(\s*['"]config['"]/i,
  /gtag\s*\(\s*['"]event['"]/i,
  /\bga\s*\(\s*['"]create['"]/i,
  /\bga\s*\(\s*['"]send['"]/i,
  /\b__gaTracker\b/i,
  /google_tag_data/i,
  /GoogleAnalyticsObject/i,

  // Facebook Pixel
  /\bfbq\s*\(/i,
  /facebook\.com\/tr/i,
  /\b_fbq\b/i,

  // Hotjar
  /\bhotjar\b/i,
  /\b_hjSettings\b/i,
  /\bhj\s*\(\s*['"]/i,

  // Microsoft Clarity
  /clarity\.ms/i,
  /\bclarity\s*\(\s*['"]/i,

  // Klaviyo
  /klaviyo/i,
  /\b_learnq\b/i,

  // Shopify analytics / monorail
  /monorail/i,
  /ShopifyAnalytics/i,
  /trekkie/i,
  /shopify\.com\/shopifycloud\/shopify-analytics/i,
  /window\.ShopifyPaypalV4VisibilityTracking/i,

  // hCaptcha
  /hcaptcha\.com/i,

  // Cookie consent / GDPR banners
  /cookiebot/i,
  /CookieConsent/i,
  /OneTrust/i,
  /osano/i,

  // Generic tracking
  /doubleclick\.net/i,
  /googlesyndication/i,
  /googleadservices/i,
  /\b_gaq\b/i,
  /\bdataLayer\.push\b/i,
]

// ---------------------------------------------------------------------------
// Keep patterns — inline script content markers that indicate KEEP
// ---------------------------------------------------------------------------

const KEEP_INLINE_PATTERNS: readonly RegExp[] = [
  // Swiper / slider initialization
  /\bnew\s+Swiper\b/i,
  /\bSwiper\b/i,
  /\.swiper/i,
  /\bslick\s*\(/i,
  /\b\.slick\b/i,
  /\bflickity\b/i,
  /\bowlCarousel\b/i,
  /\bglide\b/i,
  /\bsplide\b/i,

  // Menu / navigation toggle
  /menu[-_]?toggle/i,
  /toggle[-_]?menu/i,
  /\.toggle\s*\(/i,
  /hamburger/i,
  /mobile[-_]?menu/i,
  /nav[-_]?toggle/i,
  /drawer[-_]?open/i,
  /sidebar[-_]?toggle/i,

  // Accordion / collapsible
  /accordion/i,
  /collapsible/i,
  /collapse/i,
  /expandable/i,

  // Tab switching
  /\btab[-_]?switch/i,
  /\btabs?\b.*\.active/i,
  /\btab[-_]?content/i,

  // Lazy loading
  /lazy[-_]?load/i,
  /\blozad\b/i,
  /\blazysizes\b/i,
  /IntersectionObserver/i,

  // Scroll / animation
  /\bAOS\b.*init/i,
  /\bscrollReveal\b/i,
  /\banimate\b/i,

  // Quantity selectors / product interactions
  /quantity[-_]?selector/i,
  /\baddToCart\b/i,
  /add[-_]?to[-_]?cart/i,
  /variant[-_]?select/i,

  // DOM ready wrappers (generic — these wrap theme JS)
  /DOMContentLoaded/i,
  /\$\s*\(\s*document\s*\)/i,
  /jQuery\s*\(\s*function/i,
  /\$\s*\(\s*function/i,
]

// ---------------------------------------------------------------------------
// Keep patterns — URL substrings for external scripts to KEEP
// ---------------------------------------------------------------------------

const KEEP_URL_PATTERNS: readonly string[] = [
  // Swiper
  'swiper',
  'swiper-bundle',

  // jQuery
  'jquery',
  'jquery.min.js',
  'jquery-migrate',

  // Lazy load libraries
  'lazysizes',
  'lozad',
  'lazyload',

  // Slick / Flickity / other sliders
  'slick',
  'flickity',
  'owl.carousel',
  'owlcarousel',
  'glide',
  'splide',
  'tiny-slider',

  // AOS (Animate On Scroll)
  'aos.js',
  'aos@',

  // Common UI libraries
  'bootstrap',
  'popper',
  'alpinejs',
  'alpine',
  'htmx',
  'gsap',
  'scrollreveal',
  'waypoints',
  'isotope',
  'masonry',
  'imagesloaded',
  'magnific-popup',
  'fancybox',
  'photoswipe',
  'lightbox',
  'simplebar',

  // Shopify theme JS
  'theme.js',
  'theme.min.js',
  'global.js',
  'vendor.js',
  'custom.js',
  'base.js',
  'component-',
  'section-',
  'facets.js',
  'product-form',
  'product-info',
  'cart-',
  'details-',
  'deferred-media',
  'localization-form',
  'predictive-search',
  'price-per-item',
  'quantity-popover',
  'quick-add',
  'quick-order',
  'media-gallery',
  'slider.js',
  'slideshow.js',
  'collapsible-content',
  'header-drawer',
  'menu-drawer',
  'pickup-availability',
]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve a possibly-relative URL against a base. */
function resolveUrl(raw: string, base: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return ''

  // Protocol-relative
  if (trimmed.startsWith('//')) return `https:${trimmed}`

  // Absolute
  if (/^https?:\/\//i.test(trimmed)) return trimmed

  // Relative
  try {
    return new URL(trimmed, base).href
  } catch {
    return `${base.replace(/\/$/, '')}/${trimmed.replace(/^\//, '')}`
  }
}

/** Generate a content-based hash for deduplication / local filenames. */
function contentHash(data: Buffer | string): string {
  return crypto
    .createHash('sha256')
    .update(data)
    .digest('hex')
    .slice(0, 16)
}

/** Check whether an external script URL matches any STRIP pattern. */
function isStrippedUrl(url: string): boolean {
  const lower = url.toLowerCase()
  return STRIP_URL_PATTERNS.some((p) => lower.includes(p.toLowerCase()))
}

/** Check whether an external script URL matches any KEEP pattern. */
function isExplicitlyKeptUrl(url: string): boolean {
  const lower = url.toLowerCase()
  return KEEP_URL_PATTERNS.some((p) => lower.includes(p.toLowerCase()))
}

/** Check whether inline script content matches STRIP patterns. */
function isStrippedInline(source: string): boolean {
  return STRIP_INLINE_PATTERNS.some((re) => re.test(source))
}

/** Check whether inline script content matches KEEP patterns. */
function isKeptInline(source: string): boolean {
  return KEEP_INLINE_PATTERNS.some((re) => re.test(source))
}

/**
 * Determine whether an external script URL is from the same domain
 * (or its CDN) as the source site, which means it's likely theme JS.
 */
function isSameDomainScript(scriptUrl: string, baseUrl: string): boolean {
  try {
    const scriptHost = new URL(scriptUrl).hostname
    const baseHost = new URL(baseUrl).hostname

    // Exact match
    if (scriptHost === baseHost) return true

    // Common CDN pattern: cdn.shopify.com for *.myshopify.com stores
    // We treat Shopify CDN scripts as same-domain for theme JS
    if (
      scriptHost === 'cdn.shopify.com' &&
      (baseHost.endsWith('.myshopify.com') || baseHost.endsWith('.shopify.com'))
    ) {
      return true
    }

    // Subdomain match (e.g., cdn.example.com for example.com)
    const baseParts = baseHost.split('.')
    const rootDomain = baseParts.slice(-2).join('.')
    if (scriptHost.endsWith(rootDomain)) return true

    return false
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

type ScriptVerdict = 'keep' | 'strip'

interface ClassifyResult {
  verdict: ScriptVerdict
  reason: string
}

/**
 * Classify an external script by its URL.
 *
 * Priority:
 * 1. Explicit STRIP patterns always win (tracking is never needed)
 * 2. Explicit KEEP patterns
 * 3. Same-domain scripts default to KEEP (likely theme JS)
 * 4. Unknown third-party scripts default to STRIP
 */
function classifyExternalScript(url: string, baseUrl: string): ClassifyResult {
  if (isStrippedUrl(url)) {
    return { verdict: 'strip', reason: `matches strip pattern` }
  }
  if (isExplicitlyKeptUrl(url)) {
    return { verdict: 'keep', reason: `matches keep pattern` }
  }
  if (isSameDomainScript(url, baseUrl)) {
    return { verdict: 'keep', reason: `same-domain / theme JS` }
  }
  // Unknown third-party — default strip to keep clone clean
  return { verdict: 'strip', reason: `unknown third-party` }
}

/**
 * Classify an inline script by its content.
 *
 * Priority:
 * 1. Explicit STRIP patterns (tracking inits)
 * 2. Explicit KEEP patterns (UI initialization)
 * 3. Short scripts (<50 chars) that are not kept → strip
 * 4. Otherwise keep (may contain theme logic)
 */
function classifyInlineScript(source: string): ClassifyResult {
  if (isStrippedInline(source)) {
    return { verdict: 'strip', reason: `matches inline strip pattern` }
  }
  if (isKeptInline(source)) {
    return { verdict: 'keep', reason: `matches inline keep pattern` }
  }
  // Very short scripts are usually tracking beacons
  if (source.trim().length < 50) {
    return { verdict: 'strip', reason: `too short, likely tracking beacon` }
  }
  // Default: keep (may be theme logic we don't recognize)
  return { verdict: 'keep', reason: `default keep (unrecognized theme JS)` }
}

// ---------------------------------------------------------------------------
// Main Export
// ---------------------------------------------------------------------------

/**
 * Extract and download JavaScript from a source page for cloning.
 *
 * Parses all `<script>` tags, classifies each as KEEP or STRIP,
 * downloads external KEPT scripts, and returns them in original order.
 *
 * @param html - Full HTML of the source page
 * @param baseUrl - Base URL of the source site (e.g., https://example.com)
 * @param shopId - Shop identifier for generating local asset paths
 */
export async function cloneJavaScript(
  html: string,
  baseUrl: string,
  shopId: string,
): Promise<JSCloneResult> {
  const $ = cheerio.load(html)
  const normalizedBase = baseUrl.replace(/\/$/, '')

  const scripts: ClonedScript[] = []
  const stripped: string[] = []
  const errors: string[] = []

  let total = 0
  let kept = 0
  let strippedCount = 0
  let externalDownloaded = 0
  let inlineKept = 0

  // ── Collect all <script> elements in document order ──────────────

  interface ScriptEntry {
    position: number
    src?: string
    content?: string
    scriptType?: string
    isModule: boolean
  }

  const entries: ScriptEntry[] = []

  $('script').each((i, el) => {
    const $el = $(el)
    const src = $el.attr('src')?.trim()
    const scriptType = $el.attr('type')?.trim().toLowerCase()
    const isModule = scriptType === 'module'
    const content = $el.html()?.trim() || ''

    entries.push({
      position: i,
      src: src || undefined,
      content: src ? undefined : content,
      scriptType,
      isModule,
    })
  })

  total = entries.length

  // ── Classify and process each script ────────────────────────────

  // We'll batch-download external scripts for efficiency
  interface PendingDownload {
    entry: ScriptEntry
    url: string
  }

  const pendingDownloads: PendingDownload[] = []

  for (const entry of entries) {
    // -- type="application/json" or type="application/ld+json" → data blocks, keep as-is --
    if (
      entry.scriptType === 'application/json' ||
      entry.scriptType === 'application/ld+json' ||
      entry.scriptType === 'text/template' ||
      entry.scriptType === 'text/x-template'
    ) {
      if (entry.content) {
        scripts.push({
          type: 'inline',
          source: entry.content,
          position: entry.position,
        })
        kept++
        inlineKept++
      }
      continue
    }

    // -- External script --
    if (entry.src) {
      const url = resolveUrl(entry.src, normalizedBase)
      if (!url) {
        errors.push(`Could not resolve URL: ${entry.src}`)
        continue
      }

      const classification = classifyExternalScript(url, normalizedBase)

      if (classification.verdict === 'strip') {
        stripped.push(`[external] ${url} — ${classification.reason}`)
        strippedCount++
        continue
      }

      // Queue for download
      pendingDownloads.push({ entry, url })
      kept++
      continue
    }

    // -- Inline script --
    if (entry.content) {
      // Skip empty inline scripts
      if (!entry.content.trim()) continue

      const classification = classifyInlineScript(entry.content)

      if (classification.verdict === 'strip') {
        const preview =
          entry.content.length > 80
            ? entry.content.slice(0, 80) + '...'
            : entry.content
        stripped.push(`[inline] ${preview} — ${classification.reason}`)
        strippedCount++
        continue
      }

      scripts.push({
        type: 'inline',
        source: entry.content,
        position: entry.position,
      })
      kept++
      inlineKept++
      continue
    }

    // Empty script tag with no src and no content — skip silently
  }

  // ── Download external scripts concurrently ──────────────────────

  const CONCURRENCY = 6
  const downloadResults = await downloadInBatches(
    pendingDownloads,
    shopId,
    CONCURRENCY,
    errors,
  )

  for (const result of downloadResults) {
    if (result) {
      scripts.push(result)
      externalDownloaded++
    }
  }

  // ── Sort scripts by original position ───────────────────────────
  scripts.sort((a, b) => a.position - b.position)

  return {
    scripts,
    stripped,
    stats: {
      total,
      kept,
      stripped: strippedCount,
      externalDownloaded,
      inlineKept,
      errors,
    },
  }
}

// ---------------------------------------------------------------------------
// Download helpers
// ---------------------------------------------------------------------------

async function downloadInBatches(
  pending: { entry: { position: number; isModule: boolean }; url: string }[],
  shopId: string,
  concurrency: number,
  errors: string[],
): Promise<(ClonedScript | null)[]> {
  const results: (ClonedScript | null)[] = new Array(pending.length).fill(null)

  for (let i = 0; i < pending.length; i += concurrency) {
    const batch = pending.slice(i, i + concurrency)
    const promises = batch.map(async (item, batchIdx) => {
      const idx = i + batchIdx
      try {
        const resp = await safeFetch(item.url, {
          maxBytes: 5 * 1024 * 1024, // 5 MiB per script
          timeoutMs: 15_000,
        })

        if (resp.statusCode !== 200) {
          errors.push(
            `HTTP ${resp.statusCode} fetching ${item.url}`,
          )
          return
        }

        const source = resp.body.toString('utf-8')
        const hash = contentHash(resp.body)
        const localPath = `/clone-assets/${shopId}/js/${hash}.js`

        results[idx] = {
          type: 'external',
          originalUrl: item.url,
          source,
          localPath,
          buffer: resp.body,
          position: item.entry.position,
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        errors.push(`Failed to download ${item.url}: ${msg}`)
      }
    })

    await Promise.all(promises)
  }

  return results.filter((r): r is ClonedScript => r !== null)
}
