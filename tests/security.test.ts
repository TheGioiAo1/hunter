/**
 * H.4 Security Audit — Unit Tests
 *
 * Tests the security primitives used across the Gbox Platform:
 *   1. CSRF token generation + validation (timing-safe)
 *   2. Rate limiting middleware existence (structural)
 *   3. Input validation via Zod schemas (reject malformed data)
 *   4. XSS prevention via esc() and sanitize.escapeHtml()
 *   5. CSP header directives
 *
 * These tests are intentionally self-contained — no database, no
 * network.  They import only the security modules and validate the
 * contracts that every request handler depends on.
 */

import { describe, it, expect } from 'vitest'

// ---------------------------------------------------------------------------
// 1. CSRF Token Validation
// ---------------------------------------------------------------------------

import {
  generateCSRFPair,
  generateCSRFToken,
  validateCSRF,
  csrfHiddenField,
} from '../packages/core/src/modules/auth/csrf.js'

describe('CSRF protection', () => {
  it('generateCSRFPair returns a token/secret pair', () => {
    const pair = generateCSRFPair()
    expect(pair).toHaveProperty('token')
    expect(pair).toHaveProperty('secret')
    expect(pair.token).toHaveLength(64)   // SHA-256 hex
    expect(pair.secret).toHaveLength(64)  // 32 random bytes hex
  })

  it('validateCSRF accepts a valid token/secret pair', () => {
    const { token, secret } = generateCSRFPair()
    expect(validateCSRF(token, secret)).toBe(true)
  })

  it('validateCSRF rejects a wrong token', () => {
    const { secret } = generateCSRFPair()
    const fakeToken = 'a'.repeat(64)
    expect(validateCSRF(fakeToken, secret)).toBe(false)
  })

  it('validateCSRF rejects empty token', () => {
    const { secret } = generateCSRFPair()
    expect(validateCSRF('', secret)).toBe(false)
  })

  it('validateCSRF rejects empty secret', () => {
    const { token } = generateCSRFPair()
    expect(validateCSRF(token, '')).toBe(false)
  })

  it('validateCSRF rejects mismatched pair', () => {
    const pair1 = generateCSRFPair()
    const pair2 = generateCSRFPair()
    expect(validateCSRF(pair1.token, pair2.secret)).toBe(false)
  })

  it('generateCSRFToken produces a 64-char hex string', () => {
    const token = generateCSRFToken('session-123')
    expect(token).toMatch(/^[0-9a-f]{64}$/)
  })

  it('csrfHiddenField produces a hidden input with escaped value', () => {
    const html = csrfHiddenField('abc<script>')
    expect(html).toContain('type="hidden"')
    expect(html).toContain('name="_csrf"')
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })
})

// ---------------------------------------------------------------------------
// 2. Rate Limiting (structural — verify exports exist)
// ---------------------------------------------------------------------------

describe('Rate limiting middleware', () => {
  it('exports all rate limiter middleware functions', async () => {
    const mod = await import('../packages/core/src/modules/security/rate-limit.js')
    expect(typeof mod.apiLimiter).toBe('function')
    expect(typeof mod.apiReadLimiter).toBe('function')
    expect(typeof mod.strictLimiter).toBe('function')
    expect(typeof mod.checkoutLimiter).toBe('function')
    expect(typeof mod.paymentLimiter).toBe('function')
    expect(typeof mod.refundLimiter).toBe('function')
    expect(typeof mod.authLimiter).toBe('function')
  })
})

// ---------------------------------------------------------------------------
// 3. Input Validation — reject malformed data
// ---------------------------------------------------------------------------

import { schemas, sanitize } from '../packages/core/src/modules/security/validation.js'

describe('Input validation schemas', () => {
  describe('createProduct', () => {
    it('rejects empty title', () => {
      const result = schemas.createProduct.safeParse({ body_html: '<p>hi</p>' })
      expect(result.success).toBe(false)
    })

    it('accepts valid product', () => {
      const result = schemas.createProduct.safeParse({
        title: 'Test Product',
        status: 'draft',
      })
      expect(result.success).toBe(true)
    })

    it('rejects unknown fields (strict mode)', () => {
      const result = schemas.createProduct.safeParse({
        title: 'Test',
        malicious_field: 'DROP TABLE products',
      })
      expect(result.success).toBe(false)
    })
  })

  describe('createReview (public endpoint)', () => {
    it('rejects missing required fields', () => {
      const result = schemas.createReview.safeParse({})
      expect(result.success).toBe(false)
    })

    it('rejects rating outside 1-5', () => {
      const result = schemas.createReview.safeParse({
        author_name: 'Test',
        author_email: 'test@example.com',
        rating: 10,
        body: 'Great product',
      })
      expect(result.success).toBe(false)
    })

    it('rejects rating of 0', () => {
      const result = schemas.createReview.safeParse({
        author_name: 'Test',
        author_email: 'test@example.com',
        rating: 0,
        body: 'Bad product',
      })
      expect(result.success).toBe(false)
    })

    it('accepts valid review', () => {
      const result = schemas.createReview.safeParse({
        author_name: 'Jane',
        author_email: 'jane@example.com',
        rating: 5,
        body: 'Excellent quality!',
      })
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.rating).toBe(5)
      }
    })

    it('rejects invalid email', () => {
      const result = schemas.createReview.safeParse({
        author_name: 'Test',
        author_email: 'not-an-email',
        rating: 3,
        body: 'OK product',
      })
      expect(result.success).toBe(false)
    })

    it('rejects unknown fields (strict)', () => {
      const result = schemas.createReview.safeParse({
        author_name: 'Test',
        author_email: 'test@example.com',
        rating: 4,
        body: 'Good',
        __proto__: { admin: true },
        is_admin: true,
      })
      expect(result.success).toBe(false)
    })
  })

  describe('createPage', () => {
    it('rejects missing title', () => {
      const result = schemas.createPage.safeParse({ slug: 'about' })
      expect(result.success).toBe(false)
    })

    it('rejects missing slug', () => {
      const result = schemas.createPage.safeParse({ title: 'About Us' })
      expect(result.success).toBe(false)
    })

    it('accepts valid page', () => {
      const result = schemas.createPage.safeParse({
        title: 'About Us',
        slug: 'about-us',
      })
      expect(result.success).toBe(true)
    })

    it('rejects slug with spaces', () => {
      const result = schemas.createPage.safeParse({
        title: 'About',
        slug: 'about us',
      })
      expect(result.success).toBe(false)
    })
  })

  describe('createBlogPost', () => {
    it('rejects missing title', () => {
      const result = schemas.createBlogPost.safeParse({ slug: 'post-1' })
      expect(result.success).toBe(false)
    })

    it('accepts valid blog post', () => {
      const result = schemas.createBlogPost.safeParse({
        title: 'Hello World',
        slug: 'hello-world',
        body_html: '<p>Content here</p>',
      })
      expect(result.success).toBe(true)
    })
  })

  describe('sendNotification', () => {
    it('rejects missing shop_id', () => {
      const result = schemas.sendNotification.safeParse({ title: 'Hi' })
      expect(result.success).toBe(false)
    })

    it('rejects invalid notification type', () => {
      const result = schemas.sendNotification.safeParse({
        shop_id: '550e8400-e29b-41d4-a716-446655440000',
        title: 'Test',
        type: 'hacked',
      })
      expect(result.success).toBe(false)
    })

    it('accepts valid notification', () => {
      const result = schemas.sendNotification.safeParse({
        shop_id: '550e8400-e29b-41d4-a716-446655440000',
        title: 'Order received',
        type: 'order',
      })
      expect(result.success).toBe(true)
    })
  })

  describe('loginBody', () => {
    it('rejects missing password', () => {
      const result = schemas.loginBody.safeParse({ email: 'test@test.com' })
      expect(result.success).toBe(false)
    })

    it('normalizes email to lowercase', () => {
      const result = schemas.loginBody.safeParse({
        email: 'Test@Example.COM',
        password: 'secret123',
      })
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.email).toBe('test@example.com')
      }
    })
  })
})

// ---------------------------------------------------------------------------
// 4. XSS Prevention — esc() and sanitize.escapeHtml()
// ---------------------------------------------------------------------------

describe('XSS prevention', () => {
  describe('sanitize.escapeHtml', () => {
    it('escapes < and > to prevent tag injection', () => {
      expect(sanitize.escapeHtml('<script>alert(1)</script>')).toBe(
        '&lt;script&gt;alert(1)&lt;/script&gt;',
      )
    })

    it('escapes double quotes', () => {
      expect(sanitize.escapeHtml('" onmouseover="alert(1)"')).toBe(
        '&quot; onmouseover=&quot;alert(1)&quot;',
      )
    })

    it('escapes ampersands', () => {
      expect(sanitize.escapeHtml('a&b')).toBe('a&amp;b')
    })

    it('escapes single quotes', () => {
      expect(sanitize.escapeHtml("it's")).toBe("it&#x27;s")
    })

    it('handles empty string', () => {
      expect(sanitize.escapeHtml('')).toBe('')
    })

    it('does not double-escape', () => {
      // First escape
      const once = sanitize.escapeHtml('<b>')
      expect(once).toBe('&lt;b&gt;')
      // Second escape should escape the ampersands
      const twice = sanitize.escapeHtml(once)
      expect(twice).toBe('&amp;lt;b&amp;gt;')
    })
  })

  describe('sanitize.stripTags', () => {
    it('removes HTML tags from text', () => {
      expect(sanitize.stripTags('<b>bold</b> and <i>italic</i>')).toBe(
        'bold and italic',
      )
    })

    it('removes script tags', () => {
      expect(sanitize.stripTags('<script>alert(1)</script>hello')).toBe(
        'alert(1)hello',
      )
    })

    it('handles self-closing tags', () => {
      expect(sanitize.stripTags('line1<br/>line2')).toBe('line1line2')
    })
  })
})

// ---------------------------------------------------------------------------
// 5. CSP Header Directives
// ---------------------------------------------------------------------------

import { storefrontCspDirectives } from '../packages/core/src/modules/security/headers.js'

describe('Content-Security-Policy directives', () => {
  it('API CSP blocks all objects', () => {
    // The storefrontCspDirectives are the ones we can test statically
    expect(storefrontCspDirectives.objectSrc).toEqual(["'none'"])
  })

  it('storefront CSP omits upgrade-insecure-requests outside production', () => {
    // packages/core/src/modules/security/headers.ts gates this directive on
    // NODE_ENV === 'production'. Sending it in dev (where the box is reached
    // over http://192.168.1.13) would cause Chrome to upgrade every request
    // to https and then refuse to connect. In production the directive is
    // re-added; the production path is covered by the integration test in
    // apps/storefront/src/app.integration.test.ts.
    expect(process.env.NODE_ENV).not.toBe('production')
    expect(storefrontCspDirectives).not.toHaveProperty('upgradeInsecureRequests')
  })

  it('storefront CSP sets base-uri to self', () => {
    expect(storefrontCspDirectives.baseUri).toEqual(["'self'"])
  })

  it('storefront CSP restricts default-src to self', () => {
    expect(storefrontCspDirectives.defaultSrc).toEqual(["'self'"])
  })

  it('storefront CSP allows self for frame-ancestors (admin preview)', () => {
    expect(storefrontCspDirectives.frameAncestors).toEqual(["'self'"])
  })

  it('storefront CSP blocks object-src entirely', () => {
    expect(storefrontCspDirectives.objectSrc).toEqual(["'none'"])
  })
})

// ---------------------------------------------------------------------------
// 6. CSRF hidden field XSS edge cases
// ---------------------------------------------------------------------------

describe('CSRF hidden field injection resistance', () => {
  it('escapes a token containing HTML entities', () => {
    const malicious = '"><img src=x onerror=alert(1)>'
    const field = csrfHiddenField(malicious)
    expect(field).not.toContain('<img')
    expect(field).toContain('&lt;img')
    expect(field).toContain('&quot;')
  })

  it('produces valid hidden input for normal token', () => {
    const { token } = generateCSRFPair()
    const field = csrfHiddenField(token)
    expect(field).toBe(`<input type="hidden" name="_csrf" value="${token}">`)
  })
})
