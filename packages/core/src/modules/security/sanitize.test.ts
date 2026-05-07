/**
 * Gbox Platform — Response Sanitizer Tests (Phase 7.1)
 *
 * Iron Rule #1: ALL API responses strip sensitive fields. This file
 * locks down what "sensitive" means and how the recursive scrubber
 * handles every shape we return: plain objects, arrays of objects,
 * deeply nested order/customer trees, etc.
 */

import { describe, it, expect } from 'vitest'
import {
  sanitizeForResponse,
  DEFAULT_SENSITIVE_KEYS,
} from './sanitize.js'

// ---------------------------------------------------------------------------
// Default key set
// ---------------------------------------------------------------------------

describe('DEFAULT_SENSITIVE_KEYS', () => {
  it('includes the obvious credential fields', () => {
    expect(DEFAULT_SENSITIVE_KEYS).toContain('password')
    expect(DEFAULT_SENSITIVE_KEYS).toContain('password_hash')
    expect(DEFAULT_SENSITIVE_KEYS).toContain('passwordHash')
    expect(DEFAULT_SENSITIVE_KEYS).toContain('session_token')
    expect(DEFAULT_SENSITIVE_KEYS).toContain('sessionToken')
    expect(DEFAULT_SENSITIVE_KEYS).toContain('csrf_secret')
  })

  it('includes API + OAuth secret fields', () => {
    expect(DEFAULT_SENSITIVE_KEYS).toContain('api_key')
    expect(DEFAULT_SENSITIVE_KEYS).toContain('apiKey')
    expect(DEFAULT_SENSITIVE_KEYS).toContain('access_token')
    expect(DEFAULT_SENSITIVE_KEYS).toContain('refresh_token')
    expect(DEFAULT_SENSITIVE_KEYS).toContain('client_secret')
  })

  it('includes payment card + bank fields', () => {
    expect(DEFAULT_SENSITIVE_KEYS).toContain('card_number')
    expect(DEFAULT_SENSITIVE_KEYS).toContain('cvv')
    expect(DEFAULT_SENSITIVE_KEYS).toContain('iban')
  })
})

// ---------------------------------------------------------------------------
// Top-level scrubbing
// ---------------------------------------------------------------------------

describe('sanitizeForResponse', () => {
  it('returns primitives unchanged', () => {
    expect(sanitizeForResponse(42)).toBe(42)
    expect(sanitizeForResponse('hello')).toBe('hello')
    expect(sanitizeForResponse(true)).toBe(true)
    expect(sanitizeForResponse(null)).toBeNull()
    expect(sanitizeForResponse(undefined)).toBeUndefined()
  })

  it('strips top-level sensitive fields from a flat object', () => {
    const input = {
      id: 'usr_123',
      email: 'a@b.co',
      password_hash: '$2a$12$....',
      session_token: 'abc',
      first_name: 'Thai',
    }
    const result = sanitizeForResponse(input) as Record<string, unknown>
    expect(result.id).toBe('usr_123')
    expect(result.email).toBe('a@b.co')
    expect(result.first_name).toBe('Thai')
    expect(result).not.toHaveProperty('password_hash')
    expect(result).not.toHaveProperty('session_token')
  })

  it('recurses into nested objects', () => {
    const input = {
      order: {
        id: 'ord_1',
        customer: {
          id: 'cust_1',
          email: 'a@b.co',
          password_hash: 'bcrypt$...',
        },
      },
    }
    const result = sanitizeForResponse(input) as any
    expect(result.order.customer.email).toBe('a@b.co')
    expect(result.order.customer).not.toHaveProperty('password_hash')
  })

  it('recurses into arrays of objects', () => {
    const input = [
      { id: '1', email: 'a@b.co', password: 'plaintext' },
      { id: '2', email: 'c@d.co', password_hash: 'hash' },
    ]
    const result = sanitizeForResponse(input) as any[]
    expect(result).toHaveLength(2)
    expect(result[0]).not.toHaveProperty('password')
    expect(result[1]).not.toHaveProperty('password_hash')
    expect(result[0].email).toBe('a@b.co')
  })

  it('handles a mixed nested structure', () => {
    const input = {
      orders: [
        {
          id: 'ord_1',
          line_items: [{ id: 'li_1', sku: 'SKU-A' }],
          customer: { email: 'a@b.co', password_hash: 'x' },
        },
      ],
    }
    const result = sanitizeForResponse(input) as any
    expect(result.orders[0].line_items[0].sku).toBe('SKU-A')
    expect(result.orders[0].customer).not.toHaveProperty('password_hash')
    expect(result.orders[0].customer.email).toBe('a@b.co')
  })

  it('does not mutate the input object', () => {
    const input = { id: '1', password_hash: 'x' }
    const result = sanitizeForResponse(input) as any
    expect(input).toHaveProperty('password_hash')
    expect(result).not.toHaveProperty('password_hash')
  })

  it('does not mutate input arrays', () => {
    const input = [{ id: '1', password_hash: 'x' }]
    sanitizeForResponse(input)
    expect(input[0]).toHaveProperty('password_hash')
  })

  it('matches keys case-insensitively', () => {
    const input = {
      Password_Hash: 'x',
      SESSION_TOKEN: 'y',
      ApiKey: 'z',
    }
    const result = sanitizeForResponse(input) as any
    expect(result).not.toHaveProperty('Password_Hash')
    expect(result).not.toHaveProperty('SESSION_TOKEN')
    expect(result).not.toHaveProperty('ApiKey')
  })

  it('honours a caller-supplied extra key set', () => {
    const input = { id: '1', internal_note: 'secret', email: 'a@b.co' }
    const result = sanitizeForResponse(input, {
      extraKeys: ['internal_note'],
    }) as any
    expect(result).not.toHaveProperty('internal_note')
    expect(result.email).toBe('a@b.co')
  })

  it('replaces with a redaction sentinel when redactInsteadOfStrip is true', () => {
    const input = { id: '1', password_hash: 'real-hash' }
    const result = sanitizeForResponse(input, {
      redactInsteadOfStrip: true,
    }) as any
    expect(result.password_hash).toBe('[REDACTED]')
    expect(result.id).toBe('1')
  })

  it('preserves Date instances rather than recursing into them', () => {
    const now = new Date('2026-04-09T00:00:00Z')
    const input = { id: '1', created_at: now }
    const result = sanitizeForResponse(input) as any
    expect(result.created_at).toBeInstanceOf(Date)
    expect(result.created_at.getTime()).toBe(now.getTime())
  })

  it('handles cycles without throwing', () => {
    const a: any = { id: '1', password_hash: 'x' }
    a.self = a
    expect(() => sanitizeForResponse(a)).not.toThrow()
    const result = sanitizeForResponse(a) as any
    expect(result).not.toHaveProperty('password_hash')
    // Cycle is broken — result.self points to the sanitized version,
    // not back into the original.
    expect(result.self).not.toHaveProperty('password_hash')
  })
})
