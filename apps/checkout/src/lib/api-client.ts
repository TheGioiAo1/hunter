/**
 * Gbox Checkout — Platform API client
 *
 * Server-side fetch wrapper around the Platform API. The checkout app
 * runs on its own subdomain (`checkout.gbox.co`) and proxies REST calls
 * to `api.gbox.co` (a.k.a. server 2 :4321) on behalf of the buyer.
 *
 * Why server-side and not browser-side?
 *   - The buyer's `gbox_customer_session` cookie is HttpOnly, so the
 *     browser can't read it. We forward the cookie header from the
 *     incoming request to the outgoing fetch so the API recognises the
 *     buyer as the same customer.
 *   - Keeping calls server-side gives us a single ingress point for
 *     audit logging and PCI scope.
 *   - We can fall back gracefully on API outages (render an error page
 *     instead of a broken JS-only SPA).
 *
 * Base URL is read from `PLATFORM_API_BASE_URL` (defaults to
 * `https://api.gbox.co` in prod, `http://127.0.0.1:4321` in dev).
 */

import type { Request } from 'express'

const PLATFORM_API_BASE_URL =
  process.env.PLATFORM_API_BASE_URL ??
  (process.env.NODE_ENV === 'production'
    ? 'https://api.gbox.co'
    : 'http://127.0.0.1:4321')

export interface ApiCallOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  body?: unknown
  /** Forward the buyer's cookie/auth from the inbound express request. */
  forwardFrom?: Request
  /** Extra headers (e.g. Idempotency-Key). */
  headers?: Record<string, string>
  /** Hard timeout in ms (default 8s). */
  timeoutMs?: number
}

export class PlatformApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public data?: unknown,
  ) {
    super(message)
    this.name = 'PlatformApiError'
  }
}

/**
 * Call a Platform API endpoint. Path must be the absolute API path
 * starting with `/api/...`. Returns the parsed JSON body on 2xx,
 * throws `PlatformApiError` otherwise.
 */
export async function platformApi<T = unknown>(
  path: string,
  opts: ApiCallOptions = {},
): Promise<T> {
  if (!path.startsWith('/api/')) {
    throw new Error(
      `[checkout-api] path must start with /api/, got: ${path}`,
    )
  }

  const url = `${PLATFORM_API_BASE_URL}${path}`
  const method = opts.method ?? 'GET'
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(opts.headers ?? {}),
  }

  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json'
  }

  // Forward the inbound cookies (so the customer session reaches the API).
  if (opts.forwardFrom) {
    const cookieHeader = opts.forwardFrom.headers.cookie
    if (cookieHeader) headers.Cookie = cookieHeader

    const xff = opts.forwardFrom.headers['x-forwarded-for']
    if (xff) {
      headers['X-Forwarded-For'] = Array.isArray(xff) ? xff.join(', ') : xff
    } else if (opts.forwardFrom.ip) {
      headers['X-Forwarded-For'] = opts.forwardFrom.ip
    }

    const ua = opts.forwardFrom.headers['user-agent']
    if (ua) headers['User-Agent'] = String(ua)
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 8000)

  let res: Response
  try {
    res = await fetch(url, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal,
    })
  } catch (err) {
    clearTimeout(timer)
    throw new PlatformApiError(
      0,
      'network_error',
      `Platform API unreachable: ${(err as Error).message}`,
    )
  } finally {
    clearTimeout(timer)
  }

  let data: any = null
  try {
    data = await res.json()
  } catch {
    // Some endpoints return empty bodies on 204 — that's fine.
  }

  if (!res.ok) {
    throw new PlatformApiError(
      res.status,
      (data && (data.error || data.code)) || `http_${res.status}`,
      (data && (data.message || data.error)) || `HTTP ${res.status}`,
      data,
    )
  }

  return data as T
}
