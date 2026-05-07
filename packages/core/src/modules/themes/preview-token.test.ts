/**
 * Gbox Platform — Theme preview-token tests (Stage 3F.1)
 *
 * Preview tokens are short-lived HMACs that let a merchant open a
 * draft theme on the live storefront without search engines
 * indexing it. These tests pin the wire format and the failure
 * modes — every future change has to keep them green so admin
 * preview links issued today still work tomorrow.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  signPreviewToken,
  verifyPreviewToken,
  PREVIEW_TOKEN_TTL_MINUTES,
} from './preview-token.js'

const SECRET = 'test-secret-hmac-key-1234567890'

// ---------------------------------------------------------------------------
// Time control
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-04-09T10:00:00Z'))
})
afterEach(() => {
  vi.useRealTimers()
})

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('signPreviewToken / verifyPreviewToken — happy path', () => {
  it('round-trips a token for (shopId, themeId, adminId)', () => {
    const token = signPreviewToken(SECRET, {
      shopId: 'shop_1',
      themeId: 'theme_draft_1',
      adminId: 'admin_alice',
    })
    expect(typeof token).toBe('string')
    const verified = verifyPreviewToken(SECRET, token)
    expect(verified.ok).toBe(true)
    if (!verified.ok) return
    expect(verified.payload.shopId).toBe('shop_1')
    expect(verified.payload.themeId).toBe('theme_draft_1')
    expect(verified.payload.adminId).toBe('admin_alice')
  })

  it('includes iat and exp in the payload', () => {
    const token = signPreviewToken(SECRET, {
      shopId: 'shop_1',
      themeId: 'theme_draft_1',
      adminId: 'admin_alice',
    })
    const verified = verifyPreviewToken(SECRET, token)
    if (!verified.ok) throw new Error('expected ok')
    expect(verified.payload.iat).toBeGreaterThan(0)
    expect(verified.payload.exp).toBe(
      verified.payload.iat + PREVIEW_TOKEN_TTL_MINUTES * 60,
    )
  })

  it('produces a URL-safe token (no +/=)', () => {
    const token = signPreviewToken(SECRET, {
      shopId: 'shop_1',
      themeId: 'theme_draft_1',
      adminId: 'admin_alice',
    })
    expect(token).not.toMatch(/[+/=]/)
  })
})

// ---------------------------------------------------------------------------
// Failure modes
// ---------------------------------------------------------------------------

describe('verifyPreviewToken — failure modes', () => {
  it('rejects a token signed with a different secret', () => {
    const token = signPreviewToken('other-secret-0000000000', {
      shopId: 'shop_1',
      themeId: 'theme_draft_1',
      adminId: 'admin_alice',
    })
    const verified = verifyPreviewToken(SECRET, token)
    expect(verified.ok).toBe(false)
    if (verified.ok) return
    expect(verified.reason).toBe('signature')
  })

  it('rejects a token whose body has been tampered with', () => {
    const token = signPreviewToken(SECRET, {
      shopId: 'shop_1',
      themeId: 'theme_draft_1',
      adminId: 'admin_alice',
    })
    // Flip a character in the payload half.
    const [body, sig] = token.split('.')
    expect(body).toBeDefined()
    expect(sig).toBeDefined()
    const tampered = body!.slice(0, -1) + 'x.' + sig
    const verified = verifyPreviewToken(SECRET, tampered)
    expect(verified.ok).toBe(false)
  })

  it('rejects a token with no "." separator', () => {
    const verified = verifyPreviewToken(SECRET, 'not-a-real-token')
    expect(verified.ok).toBe(false)
    if (verified.ok) return
    expect(verified.reason).toBe('format')
  })

  it('rejects the empty string', () => {
    const verified = verifyPreviewToken(SECRET, '')
    expect(verified.ok).toBe(false)
  })

  it('rejects a token after it expires', () => {
    const token = signPreviewToken(SECRET, {
      shopId: 'shop_1',
      themeId: 'theme_draft_1',
      adminId: 'admin_alice',
    })
    // Fast-forward past the TTL.
    vi.setSystemTime(
      new Date('2026-04-09T10:00:00Z').getTime() +
        (PREVIEW_TOKEN_TTL_MINUTES + 1) * 60_000,
    )
    const verified = verifyPreviewToken(SECRET, token)
    expect(verified.ok).toBe(false)
    if (verified.ok) return
    expect(verified.reason).toBe('expired')
  })

  it('rejects a token that is future-dated (iat > now + skew)', () => {
    const token = signPreviewToken(SECRET, {
      shopId: 'shop_1',
      themeId: 'theme_draft_1',
      adminId: 'admin_alice',
    })
    // Rewind the clock so the token appears future-issued.
    vi.setSystemTime(new Date('2026-04-09T09:00:00Z'))
    const verified = verifyPreviewToken(SECRET, token)
    expect(verified.ok).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Shop scoping
// ---------------------------------------------------------------------------

describe('preview token shop scoping', () => {
  it('payload.shopId lets the caller reject cross-shop tokens', () => {
    const token = signPreviewToken(SECRET, {
      shopId: 'shop_a',
      themeId: 'theme_1',
      adminId: 'admin_1',
    })
    const verified = verifyPreviewToken(SECRET, token)
    expect(verified.ok).toBe(true)
    if (!verified.ok) return
    // Caller checks `payload.shopId === resolvedShopId` before
    // trusting the themeId. The verifier itself doesn't know
    // which shop the request belongs to.
    expect(verified.payload.shopId).toBe('shop_a')
  })
})
