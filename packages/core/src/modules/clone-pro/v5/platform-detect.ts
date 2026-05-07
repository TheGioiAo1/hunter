/**
 * Clone Pro v5 — platform detector (phase ①)
 *
 * Probes source URL against known CMS/platform signatures.
 * Shopify: /products.json?limit=1 returns {products: [...]} without auth.
 * Woocommerce: wp-json/wc/v3 endpoint (PR2).
 * Otherwise: generic.
 */

import type { Platform } from './types.js'

export interface DetectOpts {
  readonly fetch?: typeof globalThis.fetch
  readonly timeoutMs?: number
}

export async function detectPlatform(sourceUrl: string, opts: DetectOpts = {}): Promise<Platform> {
  const fetchFn = opts.fetch ?? globalThis.fetch
  const timeoutMs = opts.timeoutMs ?? 8000
  const probe = new URL('/products.json?limit=1', sourceUrl).toString()

  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), timeoutMs)
    const res = await fetchFn(probe, {
      signal: ctrl.signal,
      headers: { 'user-agent': 'GboxCloneBot/1.0 (+https://gbox.co/bot)' },
    })
    clearTimeout(t)

    if (!res.ok) return 'generic'

    const body = await res.json().catch(() => null)
    if (body && Array.isArray((body as any).products)) return 'shopify'
    return 'generic'
  } catch {
    return 'unknown'
  }
}
