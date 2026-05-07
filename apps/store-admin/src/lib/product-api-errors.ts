/**
 * Typed errors cho product-api-client wrapper.
 * Map mọi lỗi (timeout, http, network, auth) về 1 class duy nhất
 * để handler render fallback page consistently.
 */

export type ApiErrorKind = 'timeout' | 'http' | 'network' | 'auth' | 'parse'

export class ProductApiError extends Error {
  readonly kind: ApiErrorKind
  readonly status?: number
  readonly body?: unknown

  constructor(kind: ApiErrorKind, message: string, status?: number, body?: unknown) {
    super(message)
    this.name = 'ProductApiError'
    this.kind = kind
    this.status = status
    this.body = body
  }
}

/**
 * Friendly user-facing message từ bất kỳ throw. Repeat ở mọi handler
 * khi catch BE error → 1 helper.
 */
export function formatProductApiError(err: unknown): string {
  if (err instanceof ProductApiError) return `${err.kind}: ${err.message}`
  return (err as any)?.message ?? String(err) ?? 'unknown'
}

/** Phân loại lỗi từ AbortError / ApiError / TypeError → ProductApiError. */
export function toProductApiError(err: unknown): ProductApiError {
  if (err instanceof ProductApiError) return err

  // AbortSignal.timeout() throws TimeoutError (Node 18+) hoặc DOMException
  const name = (err as any)?.name
  if (name === 'TimeoutError' || name === 'AbortError') {
    return new ProductApiError('timeout', 'Upstream API timed out')
  }

  // ApiError từ generated client có shape: { status, statusText, body, url }
  const status = (err as any)?.status
    if (typeof status === 'number') {
      if (status === 401 || status === 403) {
        // In API mode, we don't want to redirect to login on 401/403 because it might just be 
        // a mismatch between local and remote JWT secrets, which causes infinite redirect loops.
        // We just return it as an 'http' error so the UI can display it as a failure.
        return new ProductApiError('http', `Auth rejected (${status})`, status, (err as any).body)
      }
      return new ProductApiError(
      'http',
      `Upstream API ${status} ${(err as any).statusText ?? ''}`.trim(),
      status,
      (err as any).body,
    )
  }

  // Network / fetch error (no status)
  const message = (err as any)?.message ?? String(err)
  return new ProductApiError('network', message)
}
