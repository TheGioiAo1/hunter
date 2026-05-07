/**
 * PayPal Partner API client — Node.js port of WordPress plugin.
 * Partner Referral onboarding để merchant connect PayPal qua OAuth.
 *
 * 2026-05: Config được fetch từ BE Gbox-Payment-Service
 * (PaypalPartnerController/public) thay vì env vars — quản trị tập trung,
 * env vars chỉ dùng làm fallback (backward compat).
 *
 * Flow:
 *  1. createPartnerReferralLink({ trackingId, returnUrl }) → action_url
 *  2. callback receives ?merchantIdInPayPal=... → save to shop settings
 *  3. getMerchantIntegrationInfo(merchantId) → check payments_receivable
 */

import { getSessionTokenFromCookies } from '@gbox/core/modules/auth/session.js'
import type { Request } from 'express'

const PAYPAL_TYPE = process.env.PAYPAL_TYPE || 'sandbox'
const PAYMENT_SERVICE_BASE = (
  process.env.API_PAYMENT_BASE_URL || 'https://api-payment.gbox.co'
).replace(/\/+$/, '')
const CACHE_TTL_MS = 5 * 60 * 1000

export interface PartnerConfig {
  client_id: string
  secret: string
  partner_id: string
  bn_code: string
  api_base: string
  type?: string
  active?: boolean
}

let cachedConfig: { value: PartnerConfig; expiresAt: number } | null = null

/**
 * Fetch + cache PayPal partner config từ BE Payment Service.
 * Endpoint: GET /api/paypal-partner (admin) — yêu cầu JWT, trả FULL bao gồm secret.
 * Endpoint /public KHÔNG dùng được vì BE strip secret qua _publicProjection.
 *
 * Lọc client-side: type khớp + active=true → ưu tiên, fallback first match type.
 */
export async function getPartnerConfig(req?: Request): Promise<PartnerConfig> {
  const now = Date.now()
  if (cachedConfig && cachedConfig.expiresAt > now) return cachedConfig.value

  // Backward-compat: env vars override BE fetch nếu set đầy đủ.
  const envCid = process.env.PAYPAL_PARTNER_CLIENT_ID
  const envSec = process.env.PAYPAL_PARTNER_SECRET
  if (envCid && envSec) {
    const cfg: PartnerConfig = {
      client_id: envCid,
      secret: envSec,
      partner_id: process.env.PAYPAL_PARTNER_ID || '',
      bn_code: process.env.PAYPAL_BN_CODE || '',
      api_base: (process.env.PAYPAL_API_BASE || 'https://api-m.sandbox.paypal.com').replace(/\/+$/, ''),
      type: PAYPAL_TYPE,
      active: true,
    }
    cachedConfig = { value: cfg, expiresAt: now + CACHE_TTL_MS }
    return cfg
  }

  if (!req) {
    throw new PayPalPartnerError('config_no_req', 'PayPal config requires authenticated request (no env fallback set)')
  }
  const token = getSessionTokenFromCookies(req.headers.cookie ?? '')
  if (!token) {
    throw new PayPalPartnerError('config_no_token', 'PayPal config: no session token in cookies')
  }

  const url = `${PAYMENT_SERVICE_BASE}/api/paypal-partner`
  let resp: Response
  try {
    resp = await fetch(url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(8000),
    })
  } catch (err: any) {
    throw new PayPalPartnerError('config_fetch', `PayPal config fetch failed: ${err?.message || err}`)
  }
  if (!resp.ok) {
    throw new PayPalPartnerError('config_fetch', `PayPal config HTTP ${resp.status}`, await resp.text().catch(() => ''))
  }
  const json: any = await resp.json().catch(() => null)
  const list: any[] = Array.isArray(json) ? json
    : Array.isArray(json?.data) ? json.data
    : json && typeof json === 'object' ? [json]
    : []
  // Lọc theo type, ưu tiên active=true, fallback any match.
  const sameType = list.filter(x => x?.type === PAYPAL_TYPE)
  const record = sameType.find(x => x?.active === true) || sameType[0] || list[0]
  if (!record || !record.client_id || !record.secret) {
    throw new PayPalPartnerError(
      'config_empty',
      `No usable PayPal partner config (type=${PAYPAL_TYPE}). BE returned ${list.length} record(s) ${
        list.length > 0 ? '— first record fields: ' + Object.keys(list[0] ?? {}).join(',') : ''
      }`,
      json,
    )
  }
  const cfg: PartnerConfig = {
    client_id: String(record.client_id),
    secret: String(record.secret),
    partner_id: String(record.partner_id || ''),
    bn_code: String(record.bn_code || ''),
    api_base: String(record.api_base || 'https://api-m.sandbox.paypal.com').replace(/\/+$/, ''),
    type: record.type,
    active: !!record.active,
  }
  cachedConfig = { value: cfg, expiresAt: now + CACHE_TTL_MS }
  console.log('[paypal-partner] config loaded from BE:', { type: cfg.type, partner_id: cfg.partner_id, has_secret: !!cfg.secret })
  return cfg
}

/** Reset cache — useful when admin updates partner config in BE. */
export function clearPartnerConfigCache(): void {
  cachedConfig = null
}

export class PayPalPartnerError extends Error {
  constructor(public code: string, message: string, public detail?: any) {
    super(message)
    this.name = 'PayPalPartnerError'
  }
}

/** Async — fetches config to verify reachable + has credentials. */
export async function isConfigured(): Promise<boolean> {
  try {
    await getPartnerConfig()
    return true
  } catch {
    return false
  }
}

/** Sync legacy guard — assume reachable; real validation happens at first use. */
export function isConfiguredSync(): boolean {
  return true
}

export function missingConfig(): string[] {
  // Kept for API compat — BE fetched on demand, return empty.
  return []
}

// ─── OAuth ───
export async function getAccessToken(req?: Request): Promise<string> {
  const cfg = await getPartnerConfig(req)
  const basic = Buffer.from(`${cfg.client_id}:${cfg.secret}`).toString('base64')
  const r = await fetch(`${cfg.api_base}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${basic}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(10000),
  })
  if (!r.ok) throw new PayPalPartnerError('oauth', `Token HTTP ${r.status}`, await r.text().catch(() => ''))
  const json = await r.json() as any
  if (!json.access_token) throw new PayPalPartnerError('oauth', 'No access_token in response', json)
  return json.access_token
}

// ─── Partner Referral ───
export interface ReferralOpts {
  trackingId: string         // unique merchant identifier (we use shop_id)
  returnUrl: string          // absolute URL PayPal redirects to after onboarding
  renewalUrl?: string        // homepage to renew action (defaults to returnUrl)
}

export async function createPartnerReferralLink(opts: ReferralOpts, req?: Request): Promise<string> {
  const cfg = await getPartnerConfig(req)
  const token = await getAccessToken(req)
  const body = {
    tracking_id: opts.trackingId,
    partner_config_override: {
      return_url: opts.returnUrl,
      action_renewal_url: opts.renewalUrl || opts.returnUrl,
    },
    operations: [{
      operation: 'API_INTEGRATION',
      api_integration_preference: {
        rest_api_integration: {
          integration_method: 'PAYPAL',
          integration_type: 'THIRD_PARTY',
          third_party_details: {
            features: ['PAYMENT', 'REFUND', 'ACCESS_MERCHANT_INFORMATION'],
          },
        },
      },
    }],
    products: ['PPCP', 'PAYMENT_METHODS'],
    capabilities: ['APPLE_PAY', 'GOOGLE_PAY'],
    legal_consent: [{ type: 'SHARE_DATA_CONSENT', granted: true }],
  }
  const r = await fetch(`${cfg.api_base}/v2/customer/partner-referrals`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'PayPal-Partner-Attribution-Id': cfg.bn_code,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  })
  if (!r.ok) throw new PayPalPartnerError('referral', `Referral HTTP ${r.status}`, await r.text().catch(() => ''))
  const json = await r.json() as any
  const link = (json.links || []).find((l: any) => l.rel === 'action_url')?.href
  if (!link) throw new PayPalPartnerError('referral', 'No action_url in response', json)
  return link
}

// ─── Merchant integration status ───
export interface MerchantInfo {
  merchant_id?: string
  primary_email?: string
  primary_email_confirmed?: boolean
  payments_receivable?: boolean
  products?: Array<{ name: string } | string>
  oauth_integrations?: any[]
  raw?: any
}

export async function getMerchantIntegrationInfo(merchantId: string, req?: Request): Promise<MerchantInfo> {
  const cfg = await getPartnerConfig(req)
  if (!cfg.partner_id) throw new PayPalPartnerError('config', 'partner_id not set in BE config')
  const token = await getAccessToken(req)
  const r = await fetch(
    `${cfg.api_base}/v1/customer/partners/${encodeURIComponent(cfg.partner_id)}/merchant-integrations/${encodeURIComponent(merchantId)}`,
    {
      method: 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      signal: AbortSignal.timeout(10000),
    },
  )
  if (!r.ok) throw new PayPalPartnerError('merchant', `Merchant HTTP ${r.status}`, await r.text().catch(() => ''))
  const json = await r.json() as any
  return { ...json, raw: json }
}

// ─── PayPal-Auth-Assertion (used when calling APIs on merchant's behalf) ───
export async function generateAuthAssertion(merchantId: string, req?: Request): Promise<string> {
  // Unsigned JWT — PayPal accepts header.payload. format for partner calls
  const cfg = await getPartnerConfig(req)
  const header = { alg: 'none' }
  const payload = { iss: cfg.client_id, payer_id: merchantId }
  const b64 = (o: any) => Buffer.from(JSON.stringify(o))
    .toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `${b64(header)}.${b64(payload)}.`
}
