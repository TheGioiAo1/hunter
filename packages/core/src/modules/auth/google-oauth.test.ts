/**
 * Unit tests for the Google OAuth (OIDC) module.
 *
 * We don't hit Google's endpoints for real — `fetch` is stubbed per
 * test so we can exercise every error path (network down, 400 token,
 * audience mismatch, nonce replay, unverified email, etc.) without
 * flake and without needing a test client_id.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  getGoogleOAuthConfig,
  isGoogleOAuthConfigured,
  buildAuthorizeUrl,
  generateOAuthState,
  generateOAuthNonce,
  exchangeCode,
  verifyIdToken,
  GoogleOAuthError,
  type GoogleOAuthConfig,
} from './google-oauth.js'

const STUB_CFG: GoogleOAuthConfig = {
  clientId: 'cid.apps.googleusercontent.com',
  clientSecret: 'GOCSPX-testsecret',
  redirectUri: 'https://accounts.gbox.co/accounts/auth/google/callback',
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

describe('getGoogleOAuthConfig', () => {
  const prev = { id: process.env.GOOGLE_CLIENT_ID, sec: process.env.GOOGLE_CLIENT_SECRET }
  beforeEach(() => {
    delete process.env.GOOGLE_CLIENT_ID
    delete process.env.GOOGLE_CLIENT_SECRET
  })
  afterEach(() => {
    process.env.GOOGLE_CLIENT_ID = prev.id
    process.env.GOOGLE_CLIENT_SECRET = prev.sec
  })

  it('returns null when both env vars unset', () => {
    expect(getGoogleOAuthConfig('https://accounts.gbox.co')).toBeNull()
  })

  it('returns null when only client id is set', () => {
    process.env.GOOGLE_CLIENT_ID = 'cid'
    expect(getGoogleOAuthConfig('https://accounts.gbox.co')).toBeNull()
  })

  it('returns null on empty-string env vars', () => {
    process.env.GOOGLE_CLIENT_ID = ''
    process.env.GOOGLE_CLIENT_SECRET = ''
    expect(getGoogleOAuthConfig('https://accounts.gbox.co')).toBeNull()
  })

  it('returns null on whitespace-only env vars', () => {
    process.env.GOOGLE_CLIENT_ID = '   '
    process.env.GOOGLE_CLIENT_SECRET = '   '
    expect(getGoogleOAuthConfig('https://accounts.gbox.co')).toBeNull()
  })

  it('returns config with derived redirect_uri when both env vars set', () => {
    process.env.GOOGLE_CLIENT_ID = 'cid.apps.googleusercontent.com'
    process.env.GOOGLE_CLIENT_SECRET = 'GOCSPX-secret'
    const cfg = getGoogleOAuthConfig('https://accounts.gbox.co')
    expect(cfg).not.toBeNull()
    expect(cfg!.clientId).toBe('cid.apps.googleusercontent.com')
    expect(cfg!.clientSecret).toBe('GOCSPX-secret')
    expect(cfg!.redirectUri).toBe(
      'https://accounts.gbox.co/accounts/auth/google/callback',
    )
  })

  it('strips trailing slash from baseUrl before appending redirect path', () => {
    process.env.GOOGLE_CLIENT_ID = 'cid'
    process.env.GOOGLE_CLIENT_SECRET = 'sec'
    const cfg = getGoogleOAuthConfig('https://accounts.gbox.co////')
    expect(cfg!.redirectUri).toBe(
      'https://accounts.gbox.co/accounts/auth/google/callback',
    )
  })
})

describe('isGoogleOAuthConfigured', () => {
  const prev = { id: process.env.GOOGLE_CLIENT_ID, sec: process.env.GOOGLE_CLIENT_SECRET }
  beforeEach(() => {
    delete process.env.GOOGLE_CLIENT_ID
    delete process.env.GOOGLE_CLIENT_SECRET
  })
  afterEach(() => {
    process.env.GOOGLE_CLIENT_ID = prev.id
    process.env.GOOGLE_CLIENT_SECRET = prev.sec
  })

  it('returns false when neither var set', () => {
    expect(isGoogleOAuthConfigured()).toBe(false)
  })
  it('returns true when both vars set', () => {
    process.env.GOOGLE_CLIENT_ID = 'x'
    process.env.GOOGLE_CLIENT_SECRET = 'y'
    expect(isGoogleOAuthConfigured()).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Authorize URL
// ---------------------------------------------------------------------------

describe('buildAuthorizeUrl', () => {
  it('produces a well-formed Google consent URL', () => {
    const url = buildAuthorizeUrl(STUB_CFG, 'st-42', 'no-42')
    const parsed = new URL(url)
    expect(parsed.origin).toBe('https://accounts.google.com')
    expect(parsed.pathname).toBe('/o/oauth2/v2/auth')
    expect(parsed.searchParams.get('client_id')).toBe(STUB_CFG.clientId)
    expect(parsed.searchParams.get('redirect_uri')).toBe(STUB_CFG.redirectUri)
    expect(parsed.searchParams.get('response_type')).toBe('code')
    expect(parsed.searchParams.get('scope')).toBe('openid email profile')
    expect(parsed.searchParams.get('state')).toBe('st-42')
    expect(parsed.searchParams.get('nonce')).toBe('no-42')
    expect(parsed.searchParams.get('prompt')).toBe('select_account')
    expect(parsed.searchParams.get('access_type')).toBe('online')
  })

  it('URL-encodes state + nonce to block injection', () => {
    const url = buildAuthorizeUrl(STUB_CFG, 'a b&c=d', 'x&y')
    const parsed = new URL(url)
    // searchParams decodes automatically — we just check that the raw
    // string has the encoded form, not unescaped ampersands.
    expect(url).toContain('state=a+b%26c%3Dd')
    expect(url).toContain('nonce=x%26y')
    expect(parsed.searchParams.get('state')).toBe('a b&c=d')
  })
})

describe('generateOAuthState / generateOAuthNonce', () => {
  it('each generator returns a 64-char hex string (32 random bytes)', () => {
    const s = generateOAuthState()
    const n = generateOAuthNonce()
    expect(s).toMatch(/^[0-9a-f]{64}$/)
    expect(n).toMatch(/^[0-9a-f]{64}$/)
  })
  it('successive calls return different values (collision-resistant)', () => {
    const a = new Set(Array.from({ length: 100 }, () => generateOAuthState()))
    expect(a.size).toBe(100)
  })
})

// ---------------------------------------------------------------------------
// Token exchange
// ---------------------------------------------------------------------------

describe('exchangeCode', () => {
  it('POSTs form-encoded body to the token endpoint and returns parsed tokens', async () => {
    const fetchSpy = vi.fn(async (url: any, init: any) => {
      expect(url).toBe('https://oauth2.googleapis.com/token')
      expect(init.method).toBe('POST')
      expect(init.headers['Content-Type']).toBe(
        'application/x-www-form-urlencoded',
      )
      const body = new URLSearchParams(init.body as string)
      expect(body.get('code')).toBe('auth-code-xyz')
      expect(body.get('client_id')).toBe(STUB_CFG.clientId)
      expect(body.get('client_secret')).toBe(STUB_CFG.clientSecret)
      expect(body.get('redirect_uri')).toBe(STUB_CFG.redirectUri)
      expect(body.get('grant_type')).toBe('authorization_code')
      return new Response(
        JSON.stringify({
          access_token: 'ya29.AT',
          id_token: 'eyJ...',
          token_type: 'Bearer',
          expires_in: 3599,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }) as unknown as typeof fetch

    const tokens = await exchangeCode(STUB_CFG, 'auth-code-xyz', fetchSpy)
    expect(tokens.access_token).toBe('ya29.AT')
    expect(tokens.id_token).toBe('eyJ...')
    expect(tokens.expires_in).toBe(3599)
  })

  it('throws GoogleOAuthError(network) when fetch rejects', async () => {
    const fetchSpy = vi.fn(async () => {
      throw new TypeError('ECONNREFUSED')
    }) as unknown as typeof fetch
    await expect(exchangeCode(STUB_CFG, 'c', fetchSpy)).rejects.toMatchObject({
      name: 'GoogleOAuthError',
      code: 'network',
    })
  })

  it('throws GoogleOAuthError(token_exchange_failed) on non-2xx', async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response('{"error":"invalid_grant"}', {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }),
    ) as unknown as typeof fetch
    await expect(exchangeCode(STUB_CFG, 'c', fetchSpy)).rejects.toMatchObject({
      name: 'GoogleOAuthError',
      code: 'token_exchange_failed',
      status: 400,
    })
  })

  it('throws GoogleOAuthError(no_id_token) when response missing id_token', async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ access_token: 'a', expires_in: 3599 }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    ) as unknown as typeof fetch
    await expect(exchangeCode(STUB_CFG, 'c', fetchSpy)).rejects.toMatchObject({
      name: 'GoogleOAuthError',
      code: 'no_id_token',
    })
  })
})

// ---------------------------------------------------------------------------
// verifyIdToken
// ---------------------------------------------------------------------------

function stubTokeninfo(body: Record<string, unknown>, status = 200): typeof fetch {
  return vi.fn(
    async (url: any) => {
      expect(String(url)).toContain('https://oauth2.googleapis.com/tokeninfo')
      expect(String(url)).toContain('id_token=')
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      })
    },
  ) as unknown as typeof fetch
}

describe('verifyIdToken', () => {
  const BASE_CLAIMS = {
    iss: 'https://accounts.google.com',
    aud: STUB_CFG.clientId,
    sub: '1234567890',
    email: 'alice@example.com',
    email_verified: true,
    name: 'Alice Example',
    nonce: 'the-nonce',
    exp: Math.floor(Date.now() / 1000) + 600,
    iat: Math.floor(Date.now() / 1000),
  }

  it('accepts valid claims and returns them', async () => {
    const claims = await verifyIdToken(
      'fake.id.token',
      { audience: STUB_CFG.clientId, nonce: 'the-nonce' },
      stubTokeninfo(BASE_CLAIMS),
    )
    expect(claims.email).toBe('alice@example.com')
    expect(claims.sub).toBe('1234567890')
  })

  it('accepts email_verified="true" string form', async () => {
    const claims = await verifyIdToken(
      'fake.id.token',
      { audience: STUB_CFG.clientId, nonce: 'the-nonce' },
      stubTokeninfo({ ...BASE_CLAIMS, email_verified: 'true' }),
    )
    expect(claims.email).toBe('alice@example.com')
  })

  it('rejects when email_verified=false', async () => {
    await expect(
      verifyIdToken(
        't',
        { audience: STUB_CFG.clientId, nonce: 'the-nonce' },
        stubTokeninfo({ ...BASE_CLAIMS, email_verified: false }),
      ),
    ).rejects.toMatchObject({ code: 'email_unverified' })
  })

  it('rejects on audience mismatch', async () => {
    await expect(
      verifyIdToken(
        't',
        { audience: STUB_CFG.clientId, nonce: 'the-nonce' },
        stubTokeninfo({ ...BASE_CLAIMS, aud: 'other-client-id' }),
      ),
    ).rejects.toMatchObject({ code: 'aud_mismatch' })
  })

  it('rejects on issuer mismatch', async () => {
    await expect(
      verifyIdToken(
        't',
        { audience: STUB_CFG.clientId, nonce: 'the-nonce' },
        stubTokeninfo({ ...BASE_CLAIMS, iss: 'https://evil.example.com' }),
      ),
    ).rejects.toMatchObject({ code: 'iss_mismatch' })
  })

  it('accepts the bare-host "accounts.google.com" iss variant', async () => {
    const claims = await verifyIdToken(
      't',
      { audience: STUB_CFG.clientId, nonce: 'the-nonce' },
      stubTokeninfo({ ...BASE_CLAIMS, iss: 'accounts.google.com' }),
    )
    expect(claims.iss).toBe('accounts.google.com')
  })

  it('rejects expired id_token', async () => {
    await expect(
      verifyIdToken(
        't',
        { audience: STUB_CFG.clientId, nonce: 'the-nonce' },
        stubTokeninfo({
          ...BASE_CLAIMS,
          exp: Math.floor(Date.now() / 1000) - 10,
        }),
      ),
    ).rejects.toMatchObject({ code: 'expired' })
  })

  it('rejects on nonce mismatch (replay protection)', async () => {
    await expect(
      verifyIdToken(
        't',
        { audience: STUB_CFG.clientId, nonce: 'expected-nonce' },
        stubTokeninfo({ ...BASE_CLAIMS, nonce: 'attacker-nonce' }),
      ),
    ).rejects.toMatchObject({ code: 'nonce_mismatch' })
  })

  it('rejects missing email/sub claims', async () => {
    await expect(
      verifyIdToken(
        't',
        { audience: STUB_CFG.clientId, nonce: 'the-nonce' },
        stubTokeninfo({ ...BASE_CLAIMS, email: '' }),
      ),
    ).rejects.toMatchObject({ code: 'missing_claims' })
  })

  it('wraps network errors as GoogleOAuthError(network)', async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error('socket closed')
    }) as unknown as typeof fetch
    await expect(
      verifyIdToken(
        't',
        { audience: STUB_CFG.clientId, nonce: 'the-nonce' },
        fetchSpy,
      ),
    ).rejects.toMatchObject({ code: 'network' })
  })

  it('wraps non-2xx responses as id_token_invalid', async () => {
    await expect(
      verifyIdToken(
        't',
        { audience: STUB_CFG.clientId, nonce: 'the-nonce' },
        stubTokeninfo({}, 400),
      ),
    ).rejects.toMatchObject({ code: 'id_token_invalid', status: 400 })
  })
})
