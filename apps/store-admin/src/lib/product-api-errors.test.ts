/**
 * Unit tests cho toProductApiError mapping.
 */

import { describe, it, expect } from 'vitest'
import { ProductApiError, toProductApiError } from './product-api-errors.js'

describe('toProductApiError', () => {
  it('passes through ProductApiError unchanged', () => {
    const original = new ProductApiError('http', 'test', 500)
    expect(toProductApiError(original)).toBe(original)
  })

  it('maps TimeoutError → kind=timeout', () => {
    const err = Object.assign(new Error('timed out'), { name: 'TimeoutError' })
    const mapped = toProductApiError(err)
    expect(mapped.kind).toBe('timeout')
  })

  it('maps AbortError → kind=timeout', () => {
    const err = Object.assign(new Error('aborted'), { name: 'AbortError' })
    expect(toProductApiError(err).kind).toBe('timeout')
  })

  it('maps 401 → kind=auth', () => {
    const err = { status: 401, statusText: 'Unauthorized', body: { reason: 'expired' } }
    const mapped = toProductApiError(err)
    expect(mapped.kind).toBe('auth')
    expect(mapped.status).toBe(401)
    expect(mapped.body).toEqual({ reason: 'expired' })
  })

  it('maps 403 → kind=auth', () => {
    expect(toProductApiError({ status: 403 }).kind).toBe('auth')
  })

  it('maps 500 → kind=http', () => {
    const err = { status: 500, statusText: 'Internal Server Error' }
    const mapped = toProductApiError(err)
    expect(mapped.kind).toBe('http')
    expect(mapped.status).toBe(500)
  })

  it('maps 404 → kind=http', () => {
    expect(toProductApiError({ status: 404 }).kind).toBe('http')
  })

  it('maps no-status error → kind=network', () => {
    const err = new TypeError('fetch failed')
    const mapped = toProductApiError(err)
    expect(mapped.kind).toBe('network')
    expect(mapped.message).toContain('fetch failed')
  })

  it('maps string throw → kind=network', () => {
    const mapped = toProductApiError('something broke')
    expect(mapped.kind).toBe('network')
    expect(mapped.message).toBe('something broke')
  })

  it('preserves status and body fields', () => {
    const err = { status: 422, statusText: 'Unprocessable', body: { field: 'name' } }
    const mapped = toProductApiError(err)
    expect(mapped.status).toBe(422)
    expect(mapped.body).toEqual({ field: 'name' })
  })
})

describe('ProductApiError', () => {
  it('has correct name property', () => {
    const err = new ProductApiError('timeout', 'x')
    expect(err.name).toBe('ProductApiError')
    expect(err instanceof Error).toBe(true)
  })

  it('stores all fields', () => {
    const err = new ProductApiError('http', 'msg', 500, { hint: 'retry' })
    expect(err.kind).toBe('http')
    expect(err.message).toBe('msg')
    expect(err.status).toBe(500)
    expect(err.body).toEqual({ hint: 'retry' })
  })
})
