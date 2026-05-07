/**
 * Clone Pro v4 — External Dependency Audit (Phase 3.4)
 *
 * After Phase 2 rewrites every known asset URL, the cloned templates
 * SHOULD only reference the shop's own origin or `/clone-assets/...`
 * paths. Any leftover absolute URL to a third-party host is a leak that
 * will either:
 *
 *   - Break when the source site goes down
 *   - Leak visitor data to the original tracker / CDN operator
 *   - Cause CORS / CSP errors in the cloned storefront
 *
 * The audit scans every persisted template for URLs, classifies each
 * hostname (allowed / must-self-host / tracking / unknown), and scores
 * based on how many remain.
 *
 * We do NOT try to auto-fix here — fixing URLs during verification would
 * couple phases that should be independent. Instead, each finding becomes
 * a recommendation the merchant can act on.
 */

import type { CheckResult, Finding } from './types.js'

// ---------------------------------------------------------------------------
// Host classification
// ---------------------------------------------------------------------------

/** Regex patterns for tracking/analytics — finding these is always critical. */
const TRACKING_HOST_PATTERNS: readonly RegExp[] = [
  /google-analytics\.com$/i,
  /googletagmanager\.com$/i,
  /facebook\.com$/i,
  /facebook\.net$/i,
  /doubleclick\.net$/i,
  /hotjar\.com$/i,
  /clarity\.ms$/i,
  /klaviyo\.com$/i,
  /segment\.(io|com)$/i,
  /mixpanel\.com$/i,
  /amplitude\.com$/i,
  /mouseflow\.com$/i,
  /fullstory\.com$/i,
]

/** Hosts that are normally safe to leave (CDN/fonts/payment). */
const ALLOWED_HOST_PATTERNS: readonly RegExp[] = [
  /^fonts\.googleapis\.com$/i,
  /^fonts\.gstatic\.com$/i,
  /^js\.stripe\.com$/i,
  /^checkout\.paypal\.com$/i,
  /^www\.paypalobjects\.com$/i,
  /^schema\.org$/i,
  /^ogp\.me$/i,
  /^www\.w3\.org$/i, // schema references in xmlns
]

/** Heuristic CDNs a merchant is best off self-hosting eventually. */
const SELF_HOST_RECOMMENDED_PATTERNS: readonly RegExp[] = [
  /cdn\.shopify\.com$/i,
  /cdnjs\.cloudflare\.com$/i,
  /unpkg\.com$/i,
  /jsdelivr\.net$/i,
  /bootstrapcdn\.com$/i,
]

type HostClass = 'tracking' | 'allowed' | 'self-host-recommended' | 'unknown'

function classifyHost(hostname: string): HostClass {
  for (const p of TRACKING_HOST_PATTERNS) if (p.test(hostname)) return 'tracking'
  for (const p of ALLOWED_HOST_PATTERNS) if (p.test(hostname)) return 'allowed'
  for (const p of SELF_HOST_RECOMMENDED_PATTERNS) if (p.test(hostname)) return 'self-host-recommended'
  return 'unknown'
}

// ---------------------------------------------------------------------------
// URL extractor — scans a Liquid/HTML template for absolute URLs
// ---------------------------------------------------------------------------

// Matches href="..." src="..." url(...) inside strings. Intentionally
// permissive — we want false-positives over false-negatives for audit.
const URL_ATTR_RE = /(?:href|src|srcset|poster|data-src|data-srcset|content)\s*=\s*"([^"]+)"/gi
const URL_STYLE_RE = /url\(\s*['"]?([^'")]+)['"]?\s*\)/gi
const URL_ABS_RE = /https?:\/\/[^\s"'<>()]+/gi

/** Extract every distinct absolute URL from a single template body. */
export function extractUrls(content: string): readonly string[] {
  const urls = new Set<string>()
  const add = (u: string): void => {
    // Strip srcset descriptors (e.g. " 2x") — we only want the URL.
    const cleaned = u.split(/[\s,]/)[0]
    if (cleaned.startsWith('http://') || cleaned.startsWith('https://')) {
      urls.add(cleaned)
    }
  }

  let m: RegExpExecArray | null
  URL_ATTR_RE.lastIndex = 0
  while ((m = URL_ATTR_RE.exec(content)) !== null) {
    // srcset can have multiple URLs — split on comma and push each.
    if (m[0].startsWith('srcset') || m[0].startsWith('data-srcset')) {
      for (const entry of m[1].split(',')) add(entry.trim())
    } else {
      add(m[1])
    }
  }
  URL_STYLE_RE.lastIndex = 0
  while ((m = URL_STYLE_RE.exec(content)) !== null) add(m[1])
  URL_ABS_RE.lastIndex = 0
  while ((m = URL_ABS_RE.exec(content)) !== null) add(m[0])

  return Array.from(urls)
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface DependencyCheckInput {
  /** Templates that were persisted — key → content. */
  readonly templates: Readonly<Record<string, string>>
  /** Source URL's origin — URLs pointing at this host are always acceptable. */
  readonly sourceOrigin?: string
}

export function runDependencyCheck(input: DependencyCheckInput): CheckResult {
  const started = Date.now()
  const findings: Finding[] = []

  const sourceHost = (() => {
    if (!input.sourceOrigin) return null
    try {
      return new URL(input.sourceOrigin).hostname.toLowerCase()
    } catch {
      return null
    }
  })()

  const byHost = new Map<string, { urls: Set<string>; templateKeys: Set<string> }>()

  let totalTemplates = 0
  let totalUrlsSeen = 0

  for (const [key, content] of Object.entries(input.templates)) {
    if (!content) continue
    totalTemplates++
    for (const url of extractUrls(content)) {
      totalUrlsSeen++
      const host = safeHostname(url)
      if (!host) continue
      // Skip the source host — those will be rewritten by pipeline or are
      // intentionally pointing at the merchant's own origin once live.
      if (sourceHost && host === sourceHost) continue
      let bucket = byHost.get(host)
      if (!bucket) {
        bucket = { urls: new Set(), templateKeys: new Set() }
        byHost.set(host, bucket)
      }
      bucket.urls.add(url)
      bucket.templateKeys.add(key)
    }
  }

  // ── Classify each host and emit findings ───────────────────────────
  let trackingHosts = 0
  let selfHostRecommended = 0
  let unknownHosts = 0

  for (const [host, bucket] of byHost) {
    const klass = classifyHost(host)
    if (klass === 'tracking') {
      trackingHosts++
      findings.push({
        category: 'dependency',
        severity: 'critical',
        message: `Tracking host still referenced: ${host} (${bucket.urls.size} URL(s)). This leaks visitor data.`,
        context: {
          host,
          class: klass,
          sampleUrls: Array.from(bucket.urls).slice(0, 3),
          inTemplates: Array.from(bucket.templateKeys).slice(0, 3),
        },
      })
    } else if (klass === 'self-host-recommended') {
      selfHostRecommended++
      findings.push({
        category: 'dependency',
        severity: 'warning',
        message: `External CDN host: ${host} (${bucket.urls.size} URL(s)) — consider self-hosting.`,
        context: {
          host,
          class: klass,
          sampleUrls: Array.from(bucket.urls).slice(0, 3),
        },
      })
    } else if (klass === 'unknown') {
      unknownHosts++
      findings.push({
        category: 'dependency',
        severity: 'warning',
        message: `Unclassified external host: ${host} (${bucket.urls.size} URL(s)). Review before launch.`,
        context: {
          host,
          class: klass,
          sampleUrls: Array.from(bucket.urls).slice(0, 3),
        },
      })
    } else {
      // allowed — info-level only
      findings.push({
        category: 'dependency',
        severity: 'info',
        message: `Allowed external host: ${host} (${bucket.urls.size} URL(s)).`,
        context: { host, class: klass },
      })
    }
  }

  if (totalTemplates === 0) {
    return {
      category: 'dependency',
      score: 100,
      passed: true,
      summary: 'No templates to audit.',
      findings: [{
        category: 'dependency',
        severity: 'info',
        message: 'No templates provided to dependency check.',
      }],
      durationMs: Date.now() - started,
    }
  }

  // ── Scoring ─────────────────────────────────────────────────────────
  // Tracking hosts are disqualifying: -25 each.
  // Self-host-recommended: -5 each (capped).
  // Unknown: -3 each (capped).
  // No external refs: 100.
  let score = 100
  score -= trackingHosts * 25
  score -= Math.min(20, selfHostRecommended * 5)
  score -= Math.min(15, unknownHosts * 3)
  score = Math.max(0, score)

  const passed = trackingHosts === 0 && score >= 70

  const summary = trackingHosts > 0
    ? `${trackingHosts} tracking host(s) still referenced — critical to remove.`
    : unknownHosts + selfHostRecommended > 0
      ? `${unknownHosts + selfHostRecommended} external host(s) to review.`
      : `Clean: no external hosts beyond allowed CDNs.`

  return {
    category: 'dependency',
    score,
    passed,
    summary,
    findings,
    durationMs: Date.now() - started,
  }
}

function safeHostname(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return null
  }
}

// Exposed for tests
export const __internal = {
  TRACKING_HOST_PATTERNS,
  ALLOWED_HOST_PATTERNS,
  SELF_HOST_RECOMMENDED_PATTERNS,
  classifyHost,
  extractUrls,
}
