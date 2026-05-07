/**
 * Gbox Platform — AI Clone live web crawler
 * (Landing Page System Phase 2.1)
 *
 * Fetches an arbitrary URL the merchant pastes into the admin and
 * returns a normalized `CrawlResult` — the raw HTML plus every
 * stylesheet that HTML references (inline `<style>` blocks and
 * `<link rel="stylesheet">` hrefs). Everything downstream of the
 * crawler (the pure `themes/cloner.ts` extractors, the AI spec
 * enhancer, the bundle generator) runs on those two strings, so
 * the crawler's job is explicitly small: fetch, stitch, enforce
 * size limits, give up gracefully.
 *
 * Design principles:
 *
 *   1. **Injectable fetch.** The real CLI passes `globalThis.fetch`;
 *      tests pass a deterministic mock. The crawler NEVER imports
 *      node-fetch or the Anthropic SDK so it can ship to Workers
 *      unchanged.
 *
 *   2. **Per-host allowlist.** When the merchant pastes
 *      `https://nike.com`, we follow asset links rooted at
 *      `nike.com` (including www. and subdomains that share a
 *      registrable suffix) but REFUSE to fetch from random CDNs,
 *      trackers, or fonts.googleapis.com. Two reasons: (a) the
 *      cloner only cares about the merchant-controlled design
 *      surface, and (b) we don't want to be a DDoS proxy. Tests
 *      verify both sides of this gate.
 *
 *   3. **Hard size cap.** Each individual resource is capped at
 *      `maxResourceBytes` (default 2 MB) and the total crawl at
 *      `maxTotalBytes` (default 8 MB). If we hit the cap we stop
 *      adding resources and return what we have with a warning.
 *      The cloner is tolerant of truncated input so partial data
 *      is always better than a crash.
 *
 *   4. **No execution, no rendering.** We do NOT run JavaScript,
 *      we do NOT load a headless browser, we do NOT evaluate CSS.
 *      That means heavily-client-rendered pages (Next.js App
 *      Router SSR-less, SPAs) give the cloner less signal. That's
 *      an accepted limitation — the merchant should paste a URL
 *      that renders real HTML on first byte, which is the common
 *      case for public marketing sites.
 *
 *   5. **Timeout budget.** Each fetch is bound by an AbortController
 *      so one hanging stylesheet can't stall the whole admin
 *      request. Default 10s per resource, 30s total.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CrawlOptions {
  /** Injected fetch implementation. Required. */
  fetchImpl: typeof fetch
  /** Max bytes per individual resource. Default 2 MB. */
  maxResourceBytes?: number
  /** Max bytes across all resources combined. Default 8 MB. */
  maxTotalBytes?: number
  /** Max number of stylesheet links to follow. Default 20. */
  maxStylesheets?: number
  /** Per-resource fetch timeout in ms. Default 10_000. */
  resourceTimeoutMs?: number
  /** Total crawl timeout in ms (AbortController budget). Default 30_000. */
  totalTimeoutMs?: number
  /**
   * Optional user agent. Defaults to an identifying string so the
   * site owners can see us in their logs and block if they want.
   */
  userAgent?: string
}

export interface CrawlResource {
  /** Absolute URL the bytes came from. */
  url: string
  /** Canonical kind. `html` for the entry point, `css` for stylesheets. */
  kind: 'html' | 'css'
  /** UTF-8 decoded body. */
  body: string
  /** Raw byte length before decoding (not post-decode string length). */
  bytes: number
}

export type CrawlWarning =
  | { code: 'resource_too_large'; url: string; bytes: number }
  | { code: 'total_budget_exceeded'; url: string }
  | { code: 'too_many_stylesheets'; dropped: number }
  | { code: 'fetch_failed'; url: string; message: string }
  | { code: 'non_ok_status'; url: string; status: number }
  | { code: 'off_host'; url: string }
  | { code: 'timeout'; url: string }
  | { code: 'unsupported_scheme'; url: string }

export interface CrawlResult {
  /** The absolute URL the crawl started at, after normalization. */
  entryUrl: string
  /** Concatenated HTML body of the entry page. */
  html: string
  /**
   * Every stylesheet discovered, in document order. Inline `<style>`
   * blocks come first (with url=null), then linked stylesheets.
   * Downstream code joins these with `\n\n` for the cloner input.
   */
  stylesheets: Array<{ url: string | null; body: string }>
  /** Sum of stylesheet bodies joined with double newlines. */
  combinedCss: string
  /** Per-resource manifest for debugging / logging. */
  resources: CrawlResource[]
  /** Non-fatal issues surfaced to the caller. */
  warnings: CrawlWarning[]
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_MAX_RESOURCE_BYTES = 2 * 1024 * 1024 // 2 MB
const DEFAULT_MAX_TOTAL_BYTES = 8 * 1024 * 1024 // 8 MB
const DEFAULT_MAX_STYLESHEETS = 20
const DEFAULT_RESOURCE_TIMEOUT_MS = 10_000
const DEFAULT_TOTAL_TIMEOUT_MS = 30_000
const DEFAULT_USER_AGENT =
  'GboxCloner/1.0 (+https://gbox.co/about/theme-cloner; contact: thai@gbox.co)'

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run a live crawl for `entryUrl`. Always resolves (never throws) —
 * failures land in `warnings` so the caller can decide whether to
 * proceed with partial data or abort. The single case where we do
 * throw is a completely malformed `entryUrl` (no scheme, no host),
 * because at that point there's nothing for the crawler to do.
 */
export async function crawl(
  entryUrl: string,
  opts: CrawlOptions,
): Promise<CrawlResult> {
  const normalized = normalizeEntryUrl(entryUrl)

  const maxResourceBytes = opts.maxResourceBytes ?? DEFAULT_MAX_RESOURCE_BYTES
  const maxTotalBytes = opts.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES
  const maxStylesheets = opts.maxStylesheets ?? DEFAULT_MAX_STYLESHEETS
  const resourceTimeoutMs =
    opts.resourceTimeoutMs ?? DEFAULT_RESOURCE_TIMEOUT_MS
  const totalTimeoutMs = opts.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS
  const userAgent = opts.userAgent ?? DEFAULT_USER_AGENT

  const warnings: CrawlWarning[] = []
  const resources: CrawlResource[] = []
  const stylesheets: Array<{ url: string | null; body: string }> = []

  const totalBudget = new BudgetClock(totalTimeoutMs)

  // ----- 1. Fetch the HTML entry point -------------------------------------

  const entryFetch = await safeFetch(normalized, {
    fetchImpl: opts.fetchImpl,
    maxBytes: maxResourceBytes,
    timeoutMs: Math.min(resourceTimeoutMs, totalBudget.remaining()),
    userAgent,
  })

  if (entryFetch.ok === false) {
    // Entry page failed — there's nothing to do downstream.
    warnings.push(entryFetch.warning)
    return {
      entryUrl: normalized,
      html: '',
      stylesheets: [],
      combinedCss: '',
      resources: [],
      warnings,
    }
  }

  const html = entryFetch.body
  resources.push({ url: normalized, kind: 'html', body: html, bytes: entryFetch.bytes })
  let usedBytes = entryFetch.bytes

  // ----- 2. Collect inline <style> blocks ---------------------------------

  for (const inline of extractInlineStyles(html)) {
    stylesheets.push({ url: null, body: inline })
  }

  // ----- 3. Resolve and fetch linked stylesheets --------------------------

  const entryParsed = safeParseUrl(normalized)
  if (!entryParsed) {
    // Should be impossible — normalizeEntryUrl threw if it wasn't parseable.
    // Return what we have.
    return assembleResult({
      entryUrl: normalized,
      html,
      stylesheets,
      resources,
      warnings,
    })
  }
  const entryHost = entryParsed.host

  const linkedHrefs = extractLinkedStylesheets(html)
  let stylesheetsFollowed = 0
  const droppedHrefs: string[] = []

  for (const rawHref of linkedHrefs) {
    if (stylesheetsFollowed >= maxStylesheets) {
      droppedHrefs.push(rawHref)
      continue
    }
    if (totalBudget.exhausted()) {
      warnings.push({ code: 'total_budget_exceeded', url: rawHref })
      break
    }

    const resolved = resolveUrl(rawHref, normalized)
    if (!resolved) continue

    if (!isSupportedScheme(resolved)) {
      warnings.push({ code: 'unsupported_scheme', url: resolved })
      continue
    }

    const parsed = safeParseUrl(resolved)
    if (!parsed) continue

    if (!sameRegistrableHost(parsed.host, entryHost)) {
      warnings.push({ code: 'off_host', url: resolved })
      continue
    }

    if (usedBytes >= maxTotalBytes) {
      warnings.push({ code: 'total_budget_exceeded', url: resolved })
      break
    }

    const remainingBudget = maxTotalBytes - usedBytes
    const perResourceCap = Math.min(maxResourceBytes, remainingBudget)

    const cssFetch = await safeFetch(resolved, {
      fetchImpl: opts.fetchImpl,
      maxBytes: perResourceCap,
      timeoutMs: Math.min(resourceTimeoutMs, totalBudget.remaining()),
      userAgent,
    })

    if (cssFetch.ok === false) {
      warnings.push(cssFetch.warning)
      continue
    }

    stylesheets.push({ url: resolved, body: cssFetch.body })
    resources.push({
      url: resolved,
      kind: 'css',
      body: cssFetch.body,
      bytes: cssFetch.bytes,
    })
    usedBytes += cssFetch.bytes
    stylesheetsFollowed += 1
  }

  if (droppedHrefs.length > 0) {
    warnings.push({ code: 'too_many_stylesheets', dropped: droppedHrefs.length })
  }

  return assembleResult({
    entryUrl: normalized,
    html,
    stylesheets,
    resources,
    warnings,
  })
}

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

/**
 * Accepts a raw merchant-supplied URL, normalises to an absolute
 * https URL with no fragment. Throws on completely invalid input
 * (no scheme + no host at all).
 */
export function normalizeEntryUrl(raw: string): string {
  const trimmed = (raw ?? '').trim()
  if (!trimmed) throw new Error('Empty URL')

  // Reject non-http schemes BEFORE trying to add our own. Otherwise
  // `ftp://nike.com` would be silently coerced into
  // `https://ftp://nike.com` which the URL parser happily accepts.
  const explicitScheme = /^([a-z][a-z0-9+.-]*):/i.exec(trimmed)
  if (explicitScheme && !/^https?$/i.test(explicitScheme[1]!)) {
    throw new Error(`Unsupported scheme: ${explicitScheme[1]}`)
  }

  // If the merchant pasted `nike.com` without a scheme, prefix https://.
  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`

  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    throw new Error(`Invalid URL: ${raw}`)
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Unsupported scheme: ${parsed.protocol}`)
  }

  parsed.hash = ''
  return parsed.toString()
}

function safeParseUrl(raw: string): URL | null {
  try {
    return new URL(raw)
  } catch {
    return null
  }
}

function resolveUrl(href: string, base: string): string | null {
  try {
    return new URL(href, base).toString()
  } catch {
    return null
  }
}

function isSupportedScheme(url: string): boolean {
  return /^https?:\/\//i.test(url)
}

/**
 * "Close enough" host comparison for crawler gating. We strip
 * leading `www.` on both sides and compare the registrable suffix
 * by checking that one host ends with the other after a dot (to
 * allow `cdn.nike.com` when the entry was `nike.com`). This is
 * deliberately not a full public suffix list — we don't need to
 * be perfect, we need to be predictable.
 */
function sameRegistrableHost(a: string, b: string): boolean {
  const norm = (h: string) => h.toLowerCase().replace(/^www\./, '')
  const aa = norm(a)
  const bb = norm(b)
  if (aa === bb) return true
  if (aa.endsWith('.' + bb)) return true
  if (bb.endsWith('.' + aa)) return true
  return false
}

// ---------------------------------------------------------------------------
// HTML scrapers (regex — same tolerance rationale as cloner.ts)
// ---------------------------------------------------------------------------

/**
 * Pull the text content of every `<style>...</style>` block in
 * document order. Tolerant of unbalanced markup — we match lazily
 * up to the next `</style>` or end of input.
 */
export function extractInlineStyles(html: string): string[] {
  const out: string[] = []
  const re = /<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    const body = m[1]?.trim() ?? ''
    if (body.length > 0) out.push(body)
  }
  return out
}

/**
 * Pull every `<link rel="stylesheet" href="...">` in document
 * order. Also matches `rel="alternate stylesheet"` and attribute
 * orderings with the href before the rel. Does NOT filter by
 * `media` attribute — downstream code treats all matched
 * stylesheets equally.
 */
export function extractLinkedStylesheets(html: string): string[] {
  const out: string[] = []
  const linkRe = /<link\b([^>]*)>/gi
  let m: RegExpExecArray | null
  while ((m = linkRe.exec(html)) !== null) {
    const attrs = m[1] ?? ''
    if (!/rel\s*=\s*["']?[^"'>]*stylesheet/i.test(attrs)) continue
    const hrefMatch = /href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs)
    if (!hrefMatch) continue
    const href = hrefMatch[2] ?? hrefMatch[3] ?? hrefMatch[4] ?? ''
    if (href) out.push(href)
  }
  return out
}

// ---------------------------------------------------------------------------
// Fetch with size + timeout guard
// ---------------------------------------------------------------------------

interface SafeFetchOk {
  ok: true
  body: string
  bytes: number
}
interface SafeFetchFailure {
  ok: false
  warning: CrawlWarning
}
type SafeFetchResult = SafeFetchOk | SafeFetchFailure

interface SafeFetchOptions {
  fetchImpl: typeof fetch
  maxBytes: number
  timeoutMs: number
  userAgent: string
}

async function safeFetch(
  url: string,
  opts: SafeFetchOptions,
): Promise<SafeFetchResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(100, opts.timeoutMs))

  try {
    const response = await opts.fetchImpl(url, {
      method: 'GET',
      headers: {
        'User-Agent': opts.userAgent,
        Accept: 'text/html,text/css,*/*;q=0.5',
      },
      signal: controller.signal,
      redirect: 'follow',
    })

    if (!response.ok) {
      return {
        ok: false,
        warning: { code: 'non_ok_status', url, status: response.status },
      }
    }

    // Prefer `.text()` because downstream consumers only want strings;
    // we still measure size against `maxBytes` using the decoded length
    // as an approximation. For a stricter cap we'd stream the body, but
    // crawler inputs are small enough that this is fine.
    const body = await response.text()
    const bytes = byteLength(body)

    if (bytes > opts.maxBytes) {
      return {
        ok: false,
        warning: { code: 'resource_too_large', url, bytes },
      }
    }

    return { ok: true, body, bytes }
  } catch (err) {
    if (controller.signal.aborted) {
      return { ok: false, warning: { code: 'timeout', url } }
    }
    return {
      ok: false,
      warning: {
        code: 'fetch_failed',
        url,
        message: err instanceof Error ? err.message : String(err),
      },
    }
  } finally {
    clearTimeout(timer)
  }
}

function byteLength(s: string): number {
  // Works in Workers (no Buffer) and Node.
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(s).length
  }
  // Fallback — Node Buffer.
  return (globalThis as any).Buffer?.byteLength?.(s, 'utf8') ?? s.length
}

// ---------------------------------------------------------------------------
// Budget clock — one shared deadline for the whole crawl
// ---------------------------------------------------------------------------

class BudgetClock {
  private readonly deadline: number
  constructor(totalMs: number) {
    this.deadline = Date.now() + totalMs
  }
  remaining(): number {
    return Math.max(0, this.deadline - Date.now())
  }
  exhausted(): boolean {
    return this.remaining() <= 0
  }
}

// ---------------------------------------------------------------------------
// Result assembler
// ---------------------------------------------------------------------------

function assembleResult(input: {
  entryUrl: string
  html: string
  stylesheets: Array<{ url: string | null; body: string }>
  resources: CrawlResource[]
  warnings: CrawlWarning[]
}): CrawlResult {
  const combinedCss = input.stylesheets.map((s) => s.body).join('\n\n')
  return {
    entryUrl: input.entryUrl,
    html: input.html,
    stylesheets: input.stylesheets,
    combinedCss,
    resources: input.resources,
    warnings: input.warnings,
  }
}
