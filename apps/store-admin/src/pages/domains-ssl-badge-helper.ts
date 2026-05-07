/**
 * domains-ssl-badge-helper.ts — pure presentational helper for the
 * SSL status pill on the Domains list page. Extracted so the unit
 * test can import without booting Express. The page (`domains.ts`)
 * imports the same function so there's exactly one copy.
 *
 * Phase 3 of the custom-domain remediation roadmap. See
 * `domains-ssl-badge.test.ts` for the rendered-state contract.
 */

import { esc } from '../layouts/seller-layout.js'

interface SslStatusInput {
  ssl_status?: string | null
  ssl_expires_at?: string | Date | null
  ssl_last_error?: string | null
  cloudflare_proxied?: boolean | null
}

const PILL_BASE =
  'display:inline-block;padding:2px 10px;border-radius:9999px;font-size:11px;font-weight:600'

function pillStr(text: string, bg: string, fg: string, attrs: string = ''): string {
  return `<span ${attrs}style="${PILL_BASE};background:${bg};color:${fg}">${esc(text)}</span>`
}

export function sslStatusBadge(d: SslStatusInput): string {
  const status = (d.ssl_status as string | null) ?? null
  const cfProxied = d.cloudflare_proxied === true
  const expiresAt = d.ssl_expires_at
    ? typeof d.ssl_expires_at === 'string'
      ? new Date(d.ssl_expires_at)
      : (d.ssl_expires_at as Date)
    : null
  const daysToExpiry = expiresAt
    ? Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24)))
    : null

  // Active + Cloudflare-proxied → green CF pill (no day count).
  if (status === 'active' && cfProxied) {
    return pillStr('SSL · Cloudflare', 'rgba(34,197,94,.15)', '#22c55e')
  }

  // Active + origin cert > 14 days → green pill with day count.
  if (status === 'active' && daysToExpiry != null && daysToExpiry > 14) {
    return pillStr(`SSL · ${daysToExpiry} days`, 'rgba(34,197,94,.15)', '#22c55e')
  }

  // Active + origin cert ≤ 14 days → amber renewal warning.
  if (status === 'active' && daysToExpiry != null && daysToExpiry <= 14) {
    return pillStr(
      `SSL renews in ${daysToExpiry}d`,
      'rgba(234,179,8,.15)',
      '#eab308',
    )
  }

  // Active without any cert evidence — emit nothing (defensive: don't
  // mislead the seller with a fake "active" pill when the row has no
  // backing cert and Cloudflare isn't fronting either).
  if (status === 'active') return ''

  if (status === 'pending') {
    return pillStr('SSL issuing…', 'var(--s-input-bg)', 'var(--s-text-secondary)')
  }

  if (status === 'failed') {
    const safe = (d.ssl_last_error ?? '').slice(0, 80) || 'see logs'
    return pillStr('SSL failed', 'rgba(239,68,68,.15)', '#ef4444', `title="${esc(safe)}" `)
  }

  if (status === 'expired') {
    return pillStr('SSL expired', 'rgba(239,68,68,.15)', '#ef4444')
  }

  return ''
}
