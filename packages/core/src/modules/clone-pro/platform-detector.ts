/**
 * Clone Pro — Platform Detector
 *
 * Detects what e-commerce platform (or static site) a URL is running.
 * Uses HTTP headers, meta tags, DOM patterns, and known URL structures
 * to determine the platform with a confidence score.
 *
 * No browser required — works with a simple HTTP GET of the homepage.
 */

import type { PlatformDetectionResult, DetectedPlatform } from './types.js'
import { safeFetch } from '../clone-shopify/safe-fetch.js'

interface DetectionRule {
  platform: DetectedPlatform
  weight: number // How much confidence this rule adds (0-100)
  check: (ctx: DetectionContext) => boolean
  evidence: string
}

interface DetectionContext {
  html: string
  headers: Record<string, string>
  url: string
}

// ---------------------------------------------------------------------------
// Detection Rules (ordered by specificity)
// ---------------------------------------------------------------------------

const DETECTION_RULES: readonly DetectionRule[] = [
  // ── Shopify ──────────────────────────────────────────────────────
  {
    platform: 'shopify',
    weight: 40,
    check: (ctx) => ctx.headers['x-shopid'] !== undefined || ctx.headers['x-shopify-stage'] !== undefined,
    evidence: 'X-ShopId or X-Shopify-Stage header present',
  },
  {
    platform: 'shopify',
    weight: 30,
    check: (ctx) => /cdn\.shopify\.com/.test(ctx.html),
    evidence: 'cdn.shopify.com references found in HTML',
  },
  {
    platform: 'shopify',
    weight: 20,
    check: (ctx) => /Shopify\.theme|shopify-section|shopify-payment/.test(ctx.html),
    evidence: 'Shopify JavaScript/section markers found',
  },
  {
    platform: 'shopify',
    weight: 15,
    check: (ctx) => /\/products\.json|\/collections\.json/.test(ctx.html),
    evidence: 'Shopify API endpoint references found',
  },
  {
    platform: 'shopify',
    weight: 10,
    check: (ctx) => ctx.html.includes('myshopify.com'),
    evidence: 'myshopify.com reference found',
  },

  // ── WooCommerce ──────────────────────────────────────────────────
  {
    platform: 'woocommerce',
    weight: 40,
    check: (ctx) => /woocommerce|wc-block/.test(ctx.html),
    evidence: 'WooCommerce CSS/JS class names found',
  },
  {
    platform: 'woocommerce',
    weight: 30,
    check: (ctx) => /wp-content\/plugins\/woocommerce/.test(ctx.html),
    evidence: 'WooCommerce plugin path found',
  },
  {
    platform: 'woocommerce',
    weight: 15,
    check: (ctx) => /wp-json\/wc\//.test(ctx.html),
    evidence: 'WooCommerce REST API references found',
  },

  // ── WordPress (non-WooCommerce) ──────────────────────────────────
  {
    platform: 'wordpress',
    weight: 35,
    check: (ctx) => /wp-content|wp-includes|wp-json/.test(ctx.html),
    evidence: 'WordPress core paths found',
  },
  {
    platform: 'wordpress',
    weight: 20,
    check: (ctx) => ctx.html.includes('generator" content="WordPress'),
    evidence: 'WordPress generator meta tag found',
  },

  // ── Magento ──────────────────────────────────────────────────────
  {
    platform: 'magento',
    weight: 40,
    check: (ctx) => /Magento|mage\/|magento2/.test(ctx.html),
    evidence: 'Magento JavaScript/CSS references found',
  },
  {
    platform: 'magento',
    weight: 25,
    check: (ctx) => ctx.headers['x-magento-vary'] !== undefined,
    evidence: 'X-Magento-Vary header present',
  },

  // ── BigCommerce ──────────────────────────────────────────────────
  {
    platform: 'bigcommerce',
    weight: 40,
    check: (ctx) => /bigcommerce\.com|BigCommerce/.test(ctx.html),
    evidence: 'BigCommerce references found',
  },
  {
    platform: 'bigcommerce',
    weight: 20,
    check: (ctx) => ctx.headers['x-bc-pageidentifier'] !== undefined,
    evidence: 'BigCommerce header present',
  },

  // ── Squarespace ──────────────────────────────────────────────────
  {
    platform: 'squarespace',
    weight: 40,
    check: (ctx) => /squarespace\.com|static\.squarespace/.test(ctx.html),
    evidence: 'Squarespace references found',
  },
  {
    platform: 'squarespace',
    weight: 25,
    check: (ctx) => ctx.headers['server']?.toLowerCase().includes('squarespace') ?? false,
    evidence: 'Squarespace server header',
  },

  // ── Wix ──────────────────────────────────────────────────────────
  {
    platform: 'wix',
    weight: 40,
    check: (ctx) => /wixsite\.com|wix\.com|static\.parastorage/.test(ctx.html),
    evidence: 'Wix references found',
  },
  {
    platform: 'wix',
    weight: 20,
    check: (ctx) => ctx.headers['x-wix-request-id'] !== undefined,
    evidence: 'Wix request ID header present',
  },

  // ── Static site indicators ───────────────────────────────────────
  {
    platform: 'static',
    weight: 10,
    check: (ctx) => !/<form|<input|<button.*type="submit"/.test(ctx.html),
    evidence: 'No form/input elements found (likely static)',
  },
]

// ---------------------------------------------------------------------------
// Detector
// ---------------------------------------------------------------------------

/**
 * Detect what platform a website is running on.
 * Makes a single HTTP GET to the homepage and analyzes the response.
 */
export async function detectPlatform(url: string): Promise<PlatformDetectionResult> {
  const normalizedUrl = normalizeUrl(url)

  try {
    const response = await safeFetch(normalizedUrl, {
      maxBytes: 2 * 1024 * 1024, // 2MB cap for detection
      timeoutMs: 15_000,
    })

    const html = response.body.toString('utf-8')
    const headers: Record<string, string> = {}
    const rawHeaders = response.headers
    for (const [key, val] of Object.entries(rawHeaders)) {
      if (val) headers[key.toLowerCase()] = Array.isArray(val) ? val[0] : val
    }

    const ctx: DetectionContext = { html, headers, url: normalizedUrl }

    // Score each platform
    const scores = new Map<DetectedPlatform, { score: number; evidence: string[] }>()

    for (const rule of DETECTION_RULES) {
      if (rule.check(ctx)) {
        const current = scores.get(rule.platform) ?? { score: 0, evidence: [] }
        current.score += rule.weight
        current.evidence.push(rule.evidence)
        scores.set(rule.platform, current)
      }
    }

    // Find the winner
    let bestPlatform: DetectedPlatform = 'unknown'
    let bestScore = 0
    let bestEvidence: string[] = []

    for (const [platform, data] of scores) {
      if (data.score > bestScore) {
        bestPlatform = platform
        bestScore = data.score
        bestEvidence = data.evidence
      }
    }

    // Normalize confidence to 0-100
    const confidence = Math.min(100, bestScore)

    // Extract version hints
    const version = extractVersion(html, bestPlatform)

    return {
      platform: bestPlatform,
      confidence,
      version: version ?? undefined,
      evidence: bestEvidence,
    }
  } catch (err: any) {
    return {
      platform: 'unknown',
      confidence: 0,
      evidence: [`Detection failed: ${err.message}`],
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeUrl(url: string): string {
  let u = url.trim()
  if (!/^https?:\/\//i.test(u)) {
    u = 'https://' + u
  }
  // Ensure trailing slash for homepage
  const parsed = new URL(u)
  if (parsed.pathname === '') parsed.pathname = '/'
  return parsed.toString()
}

function extractVersion(html: string, platform: DetectedPlatform): string | null {
  switch (platform) {
    case 'shopify': {
      const m = html.match(/Shopify\.theme\s*=\s*\{[^}]*"theme_store_id"\s*:\s*(\d+)/)
      return m ? `theme_store_id:${m[1]}` : null
    }
    case 'wordpress':
    case 'woocommerce': {
      const m = html.match(/content="WordPress\s+([\d.]+)"/)
      return m ? m[1] : null
    }
    case 'magento': {
      const m = html.match(/Magento\/([\d.]+)/)
      return m ? m[1] : null
    }
    default:
      return null
  }
}
