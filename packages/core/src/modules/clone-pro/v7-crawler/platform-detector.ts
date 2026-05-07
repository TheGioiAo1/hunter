/**
 * Platform detector — sniff the underlying e-commerce engine from a single
 * HTML page. Lightweight signature match, no DOM parse required.
 *
 * Order matters: Shopify Hydrogen 2.0 also serves `cdn.shopify.com` assets,
 * so the Hydrogen check must run BEFORE the classic-Shopify check.
 *
 * Iron Rule 5: pure function — never composes a seller-facing message.
 */
import type { Platform } from './types.js'

export type { Platform } from './types.js'

/** Detect the platform engine from an HTML body + URL. */
export function detectPlatform(html: string, _url: string): Platform {
  const lower = html.toLowerCase()

  // 1) Hydrogen first — Hydrogen 2.0 also references cdn.shopify.com.
  if (
    /__remixcontext|@shopify\/hydrogen|<meta[^>]+content="hydrogen/.test(lower)
  ) {
    return 'shopify-hydrogen'
  }

  // 2) Classic Shopify
  if (
    /cdn\.shopify\.com|shopify\.theme|<meta[^>]+content="shopify/.test(lower)
  ) {
    return 'shopify-classic'
  }

  // 3) WooCommerce / WordPress
  if (/wp-content|wp-includes|woocommerce/.test(lower)) {
    return 'woocommerce'
  }

  // 4) BigCommerce
  if (/bigcommerce\.com|stencil-utils/.test(lower)) {
    return 'bigcommerce'
  }

  // 5) ShopBase
  if (/shopbase\.com|sbase-cdn/.test(lower)) {
    return 'shopbase'
  }

  return 'unknown'
}
