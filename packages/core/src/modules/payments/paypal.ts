/**
 * Gbox Platform — PayPal Payment Integration (LEGACY — see paypal-partner/)
 *
 * Uses the PayPal REST API v2 via native fetch (no SDK dependency).
 * Supports order creation, capture, and refunds.
 *
 * ⚠️ LEGACY: this module is the pre-Partner PayPal wrapper. It does
 * NOT use Partner onboarding (money flows to the Gbox-owned PayPal
 * account, not the merchant's). The strategic path is the partner-
 * oriented module at `./paypal-partner/`, which routes funds
 * directly to each store owner.
 *
 * This legacy module is retained ONLY to keep the `/api/store/:slug/
 * payments/paypal/*` routes in server.ts working for any existing
 * storefront that hasn't been migrated yet. Every call here STILL
 * carries `PayPal-Partner-Attribution-Id: Gbox_Ecom` (Gbox's BN code)
 * — Gbox is an official PayPal partner and every PayPal API call
 * MUST be attributed, including legacy ones, otherwise the
 * transaction falls off the partner ledger and Gbox loses both credit
 * and TOS compliance.
 */

/**
 * Partner BN code for attribution on ALL PayPal API calls.
 * Gbox is an official PayPal partner — override via
 * PAYPAL_PARTNER_BN_CODE env var if rebranding.
 */
const PARTNER_BN_CODE = process.env.PAYPAL_PARTNER_BN_CODE || 'Gbox_Ecom'

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

interface PayPalConfig {
  clientId: string
  clientSecret: string
  baseUrl: string // 'https://api-m.sandbox.paypal.com' or 'https://api-m.paypal.com'
}

function getPayPalConfig(): PayPalConfig {
  const clientId = process.env.PAYPAL_CLIENT_ID
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET
  const sandbox = process.env.PAYPAL_SANDBOX !== 'false'

  if (!clientId) throw new Error('PAYPAL_CLIENT_ID is not set')
  if (!clientSecret) throw new Error('PAYPAL_CLIENT_SECRET is not set')

  return {
    clientId,
    clientSecret,
    baseUrl: sandbox
      ? 'https://api-m.sandbox.paypal.com'
      : 'https://api-m.paypal.com',
  }
}

// ---------------------------------------------------------------------------
// Auth — OAuth 2.0 client credentials
// ---------------------------------------------------------------------------

interface AccessToken {
  token: string
  expiresAt: number
}

let cachedToken: AccessToken | null = null

async function getAccessToken(): Promise<string> {
  // Return cached token if still valid (with 60 s buffer)
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.token
  }

  const config = getPayPalConfig()
  const credentials = Buffer.from(
    `${config.clientId}:${config.clientSecret}`,
  ).toString('base64')

  const response = await fetch(`${config.baseUrl}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'PayPal-Partner-Attribution-Id': PARTNER_BN_CODE,
    },
    body: 'grant_type=client_credentials',
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`PayPal auth failed (${response.status}): ${text}`)
  }

  const data = (await response.json()) as {
    access_token: string
    expires_in: number
  }

  cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  }

  return cachedToken.token
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

async function paypalFetch<T>(
  path: string,
  options: {
    method: string
    body?: unknown
    headers?: Record<string, string>
  },
): Promise<T> {
  const config = getPayPalConfig()
  const token = await getAccessToken()

  const response = await fetch(`${config.baseUrl}${path}`, {
    method: options.method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      // Partner attribution — Gbox is an official PayPal partner and
      // EVERY call (including legacy) must carry the BN code, otherwise
      // the transaction falls off the partner ledger.
      'PayPal-Partner-Attribution-Id': PARTNER_BN_CODE,
      ...options.headers,
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  })

  if (!response.ok) {
    const errorBody = await response.text()
    throw new Error(
      `PayPal API error ${response.status} ${options.method} ${path}: ${errorBody}`,
    )
  }

  // 204 No Content
  if (response.status === 204) {
    return {} as T
  }

  return (await response.json()) as T
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PayPalOrderResult {
  id: string
  status: string
  approve_url: string | null
  links: Array<{ href: string; rel: string; method: string }>
}

export interface PayPalCaptureResult {
  id: string
  status: string
  capture_id: string | null
  amount: {
    currency_code: string
    value: string
  } | null
}

export interface PayPalRefundResult {
  id: string
  status: string
  amount: {
    currency_code: string
    value: string
  } | null
}

// ---------------------------------------------------------------------------
// PayPal API response shapes (internal)
// ---------------------------------------------------------------------------

interface PayPalOrderResponse {
  id: string
  status: string
  links: Array<{ href: string; rel: string; method: string }>
}

interface PayPalCaptureResponse {
  id: string
  status: string
  purchase_units: Array<{
    payments: {
      captures: Array<{
        id: string
        status: string
        amount: { currency_code: string; value: string }
      }>
    }
  }>
}

interface PayPalRefundResponse {
  id: string
  status: string
  amount?: { currency_code: string; value: string }
}

// ---------------------------------------------------------------------------
// Service functions
// ---------------------------------------------------------------------------

/**
 * Create a PayPal order (equivalent to a checkout session).
 * The customer must be redirected to the approve_url to complete payment.
 */
export async function createPayPalOrder(
  amount: string,
  currency: string,
  returnUrl: string,
  cancelUrl: string,
  metadata?: {
    description?: string
    custom_id?: string
    invoice_id?: string
    items?: Array<{
      name: string
      quantity: string
      unit_amount: { currency_code: string; value: string }
    }>
  },
): Promise<PayPalOrderResult> {
  const purchaseUnit: Record<string, unknown> = {
    amount: {
      currency_code: currency.toUpperCase(),
      value: amount,
    },
  }

  if (metadata?.description) {
    purchaseUnit.description = metadata.description
  }
  if (metadata?.custom_id) {
    purchaseUnit.custom_id = metadata.custom_id
  }
  if (metadata?.invoice_id) {
    purchaseUnit.invoice_id = metadata.invoice_id
  }
  if (metadata?.items && metadata.items.length > 0) {
    purchaseUnit.items = metadata.items
    // When items are provided, breakdown is required
    const itemTotal = metadata.items.reduce(
      (sum, item) =>
        sum + parseFloat(item.unit_amount.value) * parseInt(item.quantity, 10),
      0,
    )
    ;(purchaseUnit.amount as Record<string, unknown>).breakdown = {
      item_total: {
        currency_code: currency.toUpperCase(),
        value: itemTotal.toFixed(2),
      },
    }
  }

  const body = {
    intent: 'CAPTURE',
    purchase_units: [purchaseUnit],
    application_context: {
      return_url: returnUrl,
      cancel_url: cancelUrl,
      brand_name: 'Gbox Platform',
      landing_page: 'NO_PREFERENCE',
      user_action: 'PAY_NOW',
      shipping_preference: 'NO_SHIPPING',
    },
  }

  const order = await paypalFetch<PayPalOrderResponse>(
    '/v2/checkout/orders',
    { method: 'POST', body },
  )

  const approveLink = order.links.find((l) => l.rel === 'approve')

  return {
    id: order.id,
    status: order.status,
    approve_url: approveLink?.href ?? null,
    links: order.links,
  }
}

/**
 * Capture a PayPal order after the buyer has approved the payment.
 * Call this when the buyer is redirected back to your returnUrl.
 */
export async function capturePayPalOrder(
  orderId: string,
): Promise<PayPalCaptureResult> {
  const result = await paypalFetch<PayPalCaptureResponse>(
    `/v2/checkout/orders/${orderId}/capture`,
    { method: 'POST', body: {} },
  )

  const capture = result.purchase_units?.[0]?.payments?.captures?.[0] ?? null

  return {
    id: result.id,
    status: result.status,
    capture_id: capture?.id ?? null,
    amount: capture?.amount ?? null,
  }
}

/**
 * Get the details of a PayPal order.
 */
export async function getPayPalOrder(
  orderId: string,
): Promise<PayPalOrderResult> {
  const order = await paypalFetch<PayPalOrderResponse>(
    `/v2/checkout/orders/${orderId}`,
    { method: 'GET' },
  )

  const approveLink = order.links.find((l) => l.rel === 'approve')

  return {
    id: order.id,
    status: order.status,
    approve_url: approveLink?.href ?? null,
    links: order.links,
  }
}

/**
 * Refund a captured PayPal payment.
 * If amount is omitted, the full capture amount is refunded.
 */
export async function createPayPalRefund(
  captureId: string,
  amount?: { currency_code: string; value: string },
  note?: string,
): Promise<PayPalRefundResult> {
  const body: Record<string, unknown> = {}
  if (amount) {
    body.amount = amount
  }
  if (note) {
    body.note_to_payer = note
  }

  const refund = await paypalFetch<PayPalRefundResponse>(
    `/v2/payments/captures/${captureId}/refund`,
    { method: 'POST', body: Object.keys(body).length > 0 ? body : {} },
  )

  return {
    id: refund.id,
    status: refund.status,
    amount: refund.amount ?? null,
  }
}

/**
 * Verify a PayPal webhook notification.
 * Uses PayPal's verify-webhook-signature API endpoint.
 */
export async function verifyWebhook(
  webhookId: string,
  headers: Record<string, string>,
  body: string,
): Promise<boolean> {
  const verificationBody = {
    auth_algo: headers['paypal-auth-algo'],
    cert_url: headers['paypal-cert-url'],
    transmission_id: headers['paypal-transmission-id'],
    transmission_sig: headers['paypal-transmission-sig'],
    transmission_time: headers['paypal-transmission-time'],
    webhook_id: webhookId,
    webhook_event: JSON.parse(body),
  }

  const result = await paypalFetch<{ verification_status: string }>(
    '/v1/notifications/verify-webhook-signature',
    { method: 'POST', body: verificationBody },
  )

  return result.verification_status === 'SUCCESS'
}
