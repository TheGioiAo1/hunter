/**
 * Tests for admin locale negotiation (Phase 2 Step 2.10).
 */

import { describe, it, expect } from 'vitest'
import {
  ADMIN_LOCALE_COOKIE,
  buildLocaleCookie,
  readLocaleFromCookieHeader,
  parseAcceptLanguage,
  resolveLanguageTag,
  pickLocaleFromAcceptLanguage,
  negotiateAdminLocale,
  readLocaleFromRequest,
} from './negotiate.js'

// ---------------------------------------------------------------------------
// Cookie helpers
// ---------------------------------------------------------------------------

describe('readLocaleFromCookieHeader', () => {
  it('returns null when no header', () => {
    expect(readLocaleFromCookieHeader(undefined)).toBeNull()
    expect(readLocaleFromCookieHeader('')).toBeNull()
  })

  it('extracts a supported locale from the cookie', () => {
    expect(readLocaleFromCookieHeader('gbox_locale=de-DE')).toBe('de-DE')
  })

  it('handles multiple cookies in one header', () => {
    expect(
      readLocaleFromCookieHeader(
        'session=abc; gbox_locale=fr-FR; gbox_theme=dark',
      ),
    ).toBe('fr-FR')
  })

  it('returns null for unsupported locales', () => {
    expect(readLocaleFromCookieHeader('gbox_locale=vi-VN')).toBeNull()
    expect(readLocaleFromCookieHeader('gbox_locale=ja')).toBeNull()
  })

  it('returns null when the cookie is absent', () => {
    expect(readLocaleFromCookieHeader('session=xyz; other=1')).toBeNull()
  })
})

describe('buildLocaleCookie', () => {
  it('produces a well-formed Set-Cookie value', () => {
    const cookie = buildLocaleCookie('es-ES')
    expect(cookie).toContain(`${ADMIN_LOCALE_COOKIE}=es-ES`)
    expect(cookie).toContain('Path=/')
    expect(cookie).toContain('Max-Age=')
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Lax')
  })

  it('persists for a year', () => {
    const cookie = buildLocaleCookie('en-US')
    // 60*60*24*365 = 31536000
    expect(cookie).toContain('Max-Age=31536000')
  })
})

// ---------------------------------------------------------------------------
// parseAcceptLanguage
// ---------------------------------------------------------------------------

describe('parseAcceptLanguage', () => {
  it('parses a simple list', () => {
    const parsed = parseAcceptLanguage('en-US,en;q=0.9,de;q=0.8')
    expect(parsed).toHaveLength(3)
    expect(parsed[0].tag).toBe('en-US')
    expect(parsed[0].quality).toBe(1)
    expect(parsed[1].tag).toBe('en')
    expect(parsed[1].quality).toBe(0.9)
    expect(parsed[2].tag).toBe('de')
    expect(parsed[2].quality).toBe(0.8)
  })

  it('sorts by quality descending', () => {
    const parsed = parseAcceptLanguage('de;q=0.5,en;q=0.9,fr')
    expect(parsed[0].tag).toBe('fr')
    expect(parsed[1].tag).toBe('en')
    expect(parsed[2].tag).toBe('de')
  })

  it('clamps quality to [0, 1]', () => {
    const parsed = parseAcceptLanguage('en;q=1.5,de;q=-0.2')
    expect(parsed[0].quality).toBe(1)
    expect(parsed.find(p => p.tag === 'de')?.quality).toBe(0)
  })

  it('ignores whitespace', () => {
    const parsed = parseAcceptLanguage(' en-US , de ; q=0.8 ')
    expect(parsed).toHaveLength(2)
    expect(parsed[0].tag).toBe('en-US')
  })
})

// ---------------------------------------------------------------------------
// resolveLanguageTag
// ---------------------------------------------------------------------------

describe('resolveLanguageTag', () => {
  it('returns exact matches', () => {
    expect(resolveLanguageTag('en-US')).toBe('en-US')
    expect(resolveLanguageTag('de-DE')).toBe('de-DE')
    expect(resolveLanguageTag('fr-FR')).toBe('fr-FR')
  })

  it('is case-insensitive', () => {
    expect(resolveLanguageTag('de-de')).toBe('de-DE')
    expect(resolveLanguageTag('EN-us')).toBe('en-US')
  })

  it('maps bare language codes to a supported regional variant', () => {
    expect(resolveLanguageTag('de')).toBe('de-DE')
    expect(resolveLanguageTag('fr')).toBe('fr-FR')
    expect(resolveLanguageTag('es')).toBe('es-ES')
    // 'en' matches en-US first in declaration order.
    expect(resolveLanguageTag('en')).toBe('en-US')
  })

  it('returns null for unsupported tags', () => {
    expect(resolveLanguageTag('vi')).toBeNull()
    expect(resolveLanguageTag('ja-JP')).toBeNull()
    expect(resolveLanguageTag('zh-CN')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// pickLocaleFromAcceptLanguage
// ---------------------------------------------------------------------------

describe('pickLocaleFromAcceptLanguage', () => {
  it('returns null on missing/empty header', () => {
    expect(pickLocaleFromAcceptLanguage(undefined)).toBeNull()
    expect(pickLocaleFromAcceptLanguage('')).toBeNull()
  })

  it('honors the highest-priority supported tag', () => {
    expect(
      pickLocaleFromAcceptLanguage('vi,de-DE;q=0.9,en;q=0.8'),
    ).toBe('de-DE')
  })

  it('falls through to en-US for bare "en"', () => {
    expect(pickLocaleFromAcceptLanguage('en,de;q=0.5')).toBe('en-US')
  })

  it('returns null when nothing in the header is supported', () => {
    expect(pickLocaleFromAcceptLanguage('ja,zh,vi')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// negotiateAdminLocale (top-level)
// ---------------------------------------------------------------------------

describe('negotiateAdminLocale', () => {
  it('cookie wins over header', () => {
    expect(
      negotiateAdminLocale({
        cookieHeader: 'gbox_locale=es-ES',
        acceptLanguageHeader: 'de-DE',
      }),
    ).toBe('es-ES')
  })

  it('falls back to header when cookie is absent', () => {
    expect(
      negotiateAdminLocale({
        cookieHeader: undefined,
        acceptLanguageHeader: 'fr-FR',
      }),
    ).toBe('fr-FR')
  })

  it('falls back to en-US when neither resolves', () => {
    expect(
      negotiateAdminLocale({
        cookieHeader: undefined,
        acceptLanguageHeader: 'vi,ja',
      }),
    ).toBe('en-US')
  })

  it('ignores a cookie with an unsupported value and tries the header', () => {
    expect(
      negotiateAdminLocale({
        cookieHeader: 'gbox_locale=vi-VN',
        acceptLanguageHeader: 'de-DE',
      }),
    ).toBe('de-DE')
  })
})

// ---------------------------------------------------------------------------
// readLocaleFromRequest (Express shape)
// ---------------------------------------------------------------------------

describe('readLocaleFromRequest', () => {
  it('reads from Express req.headers', () => {
    const req = {
      headers: {
        cookie: 'gbox_locale=fr-FR',
        'accept-language': 'de-DE',
      },
    }
    expect(readLocaleFromRequest(req)).toBe('fr-FR')
  })

  it('handles array-valued headers', () => {
    const req = {
      headers: {
        cookie: ['session=x', 'gbox_locale=es-ES'],
        'accept-language': ['de-DE', 'en'],
      },
    }
    expect(readLocaleFromRequest(req)).toBe('es-ES')
  })

  it('returns en-US for a bare empty request', () => {
    expect(readLocaleFromRequest({ headers: {} })).toBe('en-US')
  })
})
