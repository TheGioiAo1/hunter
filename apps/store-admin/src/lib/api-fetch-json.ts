/**
 * Shared FTPS-safe JSON fetch helper for store-admin → BE microservices
 * (Customer / Review / future). Replaces near-identical copies trong
 * customer-api-client + review-api-client.
 *
 * Caller passes `label` ("Customer" / "Review") để timeout error message
 * có context. Status code attached vào ProductApiError cho 404 detection.
 */

import { ProductApiError } from './product-api-errors.js'

const DEFAULT_TIMEOUT_MS = 8000

export interface FetchJsonInit extends Omit<RequestInit, 'signal'> {
  token?: string
  /** Override default 8s timeout if needed. */
  timeoutMs?: number
}

export async function fetchJson<T>(
  url: string,
  init: FetchJsonInit,
  label: string,
): Promise<T> {
  const { token, headers, timeoutMs, ...rest } = init
  const timeout = timeoutMs ?? DEFAULT_TIMEOUT_MS
  let r: Response
  try {
    r = await fetch(url, {
      ...rest,
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(headers ?? {}),
      },
      signal: AbortSignal.timeout(timeout),
    })
  } catch (err: any) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      throw new ProductApiError('timeout', `${label} API timeout ${timeout}ms`)
    }
    throw new ProductApiError('network', err?.message || 'fetch failed')
  }
  if (!r.ok) {
    const text = await r.text().catch(() => '')
    let parsedBody: unknown
    try { parsedBody = JSON.parse(text) } catch {}
    throw new ProductApiError(
      'http',
      `${r.status} ${r.statusText}${text ? ' — ' + text.slice(0, 200) : ''}`,
      r.status,
      parsedBody,
    )
  }
  // BE handlers like Approve/Delete trả 200 không body — return {}.
  const ctype = r.headers.get('content-type') ?? ''
  if (!ctype.includes('json')) return {} as T
  return (await r.json()) as T
}
