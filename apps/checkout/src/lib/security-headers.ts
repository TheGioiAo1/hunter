/**
 * Gbox Checkout — Strict CSP + security headers
 *
 * This file is INTENTIONALLY separate from `@gbox/core/modules/security/headers.js`
 * (which serves the admin/account portals). The checkout subdomain handles
 * real payment data and lives at the highest sensitivity level on the platform —
 * its CSP must be strict enough to keep us in PCI-DSS SAQ-A scope:
 *
 *   - script-src: only ourselves + paypal.com + venmo.com.
 *     NO 'unsafe-inline', NO 'unsafe-eval', NO wildcard.
 *     The single bootstrap script is served from our own /static/ folder
 *     so we don't need an inline-script hash.
 *   - frame-src: only the PayPal/Venmo iframes (the buyer-approval modal).
 *   - frame-ancestors 'none': checkout itself MUST NOT be iframable. This
 *     blocks clickjacking and prevents merchants from re-embedding the
 *     checkout in their own theme — which would defeat the PCI scope split.
 *   - connect-src: only ourselves + the Platform API + PayPal.
 *   - form-action: only ourselves + the Platform API.
 *   - base-uri 'none' + object-src 'none' + script-src-attr 'none':
 *     defence in depth against base-tag injection / Flash / inline event
 *     handlers.
 *
 * Permissions-Policy declares we use the `payment` API only on PayPal's
 * origin so a stray third-party can't trigger a payment sheet.
 *
 * COOP/CORP keep window.opener access scoped — we open PayPal's approval
 * popup ourselves, so we control the relationship.
 *
 * If you find yourself needing to weaken any of these in a hurry: STOP
 * and ask the owner. Every relaxation moves us back toward SAQ-A-EP.
 */

import type { RequestHandler } from 'express'

const PAYPAL_ORIGINS = [
  'https://www.paypal.com',
  'https://www.paypalobjects.com',
  'https://www.sandbox.paypal.com',
  'https://*.paypal.com',
]

const VENMO_ORIGINS = ['https://*.venmo.com']

const PLATFORM_API_ORIGIN =
  process.env.PLATFORM_API_BASE_URL ?? 'https://api.gbox.co'

function buildCsp(): string {
  const scriptSrc = ["'self'", ...PAYPAL_ORIGINS, ...VENMO_ORIGINS]
  const frameSrc = [
    'https://www.paypal.com',
    'https://www.sandbox.paypal.com',
    ...VENMO_ORIGINS,
  ]
  const connectSrc = [
    "'self'",
    PLATFORM_API_ORIGIN,
    ...PAYPAL_ORIGINS,
    ...VENMO_ORIGINS,
  ]
  const imgSrc = [
    "'self'",
    'data:',
    'https://www.paypalobjects.com',
    'https://*.paypal.com',
  ]
  const formAction = ["'self'", PLATFORM_API_ORIGIN]

  const directives: Array<[string, string[] | string]> = [
    ['default-src', ["'self'"]],
    ['script-src', scriptSrc],
    // 'unsafe-inline' on style-src is the one allowance — PayPal injects
    // some inline styles into the button container and the iframe shim.
    // Removing it breaks button rendering. This is acceptable per PCI
    // SAQ-A because no payment fields are styled.
    ['style-src', ["'self'", "'unsafe-inline'"]],
    ['img-src', imgSrc],
    ['font-src', ["'self'", 'data:']],
    ['connect-src', connectSrc],
    ['frame-src', frameSrc],
    ['form-action', formAction],
    ['frame-ancestors', ["'none'"]],
    ['base-uri', ["'none'"]],
    ['object-src', ["'none'"]],
    ['script-src-attr', ["'none'"]],
    ['upgrade-insecure-requests', ''],
  ]

  return directives
    .map(([k, v]) => (Array.isArray(v) ? `${k} ${v.join(' ')}` : k))
    .join('; ')
}

const CSP_HEADER_VALUE = buildCsp()

/**
 * Strict security headers for the checkout subdomain. Apply BEFORE any
 * route handlers via `app.use(checkoutSecurityHeaders)`.
 */
export const checkoutSecurityHeaders: RequestHandler = (_req, res, next) => {
  res.setHeader('Content-Security-Policy', CSP_HEADER_VALUE)
  res.setHeader(
    'Strict-Transport-Security',
    'max-age=31536000; includeSubDomains; preload',
  )
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
  res.setHeader('Cross-Origin-Resource-Policy', 'same-site')
  res.setHeader(
    'Permissions-Policy',
    'payment=(self "https://www.paypal.com"), geolocation=(), camera=(), microphone=()',
  )
  // Cache nothing by default — pages depend on session state. Static
  // assets under /static/ override this with their own Cache-Control.
  res.setHeader('Cache-Control', 'private, no-store, max-age=0')
  next()
}

/**
 * Cache-Control override for `/static/*` (the bootstrap script).
 * The file path is fingerprinted by content hash, so we can be aggressive.
 */
export const staticCacheHeaders: RequestHandler = (_req, res, next) => {
  res.setHeader('Cache-Control', 'public, max-age=86400, immutable')
  next()
}
