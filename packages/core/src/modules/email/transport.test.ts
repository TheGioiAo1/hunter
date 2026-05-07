/**
 * Unit tests for the transport abstraction (Phase 14 PR1).
 *
 * We focus on the parts that don't require network:
 *   - env config parser
 *   - ConsoleTransport (pure stdout)
 *   - SesTransport scaffold (rejection)
 *   - resolveTransport() factory order
 *
 * The Gmail SMTP path (actual network send) is covered by the smoke
 * test against `admingbox@gmail.com` — it's too flaky / environment-
 * dependent to pin down in a unit test.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  ConsoleTransport,
  SesTransport,
  GmailSmtpTransport,
  resolveTransport,
  readEmailEnv,
  hasGmailSmtpCredentials,
  __resetTransportWarningForTests,
  type TransportEnvelope,
} from './transport.js'

// ---------------------------------------------------------------------------
// Env capture/restore helpers
// ---------------------------------------------------------------------------

const ENV_KEYS = [
  'EMAIL_TRANSPORT',
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_SECURE',
  'SMTP_USER',
  'SMTP_PASS',
  'EMAIL_FROM',
  'SMTP_FROM',
  'EMAIL_REPLY_TO',
  'EMAIL_UNSUBSCRIBE_BASE_URL',
  'ACCOUNTS_BASE_URL',
]

let saved: Record<string, string | undefined> = {}

function clearEmailEnv() {
  for (const k of ENV_KEYS) {
    delete process.env[k]
  }
}

beforeEach(() => {
  saved = {}
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k]
  }
  clearEmailEnv()
  __resetTransportWarningForTests()
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

// ---------------------------------------------------------------------------
// readEmailEnv
// ---------------------------------------------------------------------------

describe('readEmailEnv', () => {
  it('returns nulls / defaults when nothing is set', () => {
    const env = readEmailEnv()
    expect(env.host).toBeNull()
    expect(env.port).toBe(587)
    expect(env.secure).toBe(false)
    expect(env.user).toBe('')
    expect(env.pass).toBe('')
    expect(env.from).toBe('noreply@gbox.co')
    expect(env.replyTo).toBeNull()
  })

  it('picks up host / user / pass / from from env', () => {
    process.env.SMTP_HOST = 'smtp.gmail.com'
    process.env.SMTP_PORT = '465'
    process.env.SMTP_SECURE = 'true'
    process.env.SMTP_USER = 'admingbox@gmail.com'
    process.env.SMTP_PASS = 'abcd efgh ijkl mnop'
    process.env.EMAIL_FROM = 'Gbox <admingbox@gmail.com>'
    process.env.EMAIL_REPLY_TO = 'support@gbox.co'

    const env = readEmailEnv()
    expect(env.host).toBe('smtp.gmail.com')
    expect(env.port).toBe(465)
    expect(env.secure).toBe(true)
    expect(env.user).toBe('admingbox@gmail.com')
    expect(env.pass).toBe('abcd efgh ijkl mnop')
    expect(env.from).toBe('Gbox <admingbox@gmail.com>')
    expect(env.replyTo).toBe('support@gbox.co')
  })

  it('falls back to SMTP_FROM (legacy alias) when EMAIL_FROM is missing', () => {
    process.env.SMTP_FROM = 'legacy@example.com'
    expect(readEmailEnv().from).toBe('legacy@example.com')
  })

  it('parses SMTP_SECURE case-insensitively', () => {
    process.env.SMTP_SECURE = 'TRUE'
    expect(readEmailEnv().secure).toBe(true)
    process.env.SMTP_SECURE = 'False'
    expect(readEmailEnv().secure).toBe(false)
    process.env.SMTP_SECURE = '1'
    expect(readEmailEnv().secure).toBe(false)  // we require exact 'true'
  })

  it('trims whitespace from host / user', () => {
    process.env.SMTP_HOST = '  smtp.gmail.com  '
    process.env.SMTP_USER = '  thai@x.com  '
    const env = readEmailEnv()
    expect(env.host).toBe('smtp.gmail.com')
    expect(env.user).toBe('thai@x.com')
  })
})

// ---------------------------------------------------------------------------
// hasGmailSmtpCredentials
// ---------------------------------------------------------------------------

describe('hasGmailSmtpCredentials', () => {
  it('false when host is missing', () => {
    expect(hasGmailSmtpCredentials()).toBe(false)
  })

  it('false when user is missing', () => {
    process.env.SMTP_HOST = 'smtp.gmail.com'
    process.env.SMTP_PASS = 'xxx'
    expect(hasGmailSmtpCredentials()).toBe(false)
  })

  it('false when pass is missing', () => {
    process.env.SMTP_HOST = 'smtp.gmail.com'
    process.env.SMTP_USER = 'x@x.com'
    expect(hasGmailSmtpCredentials()).toBe(false)
  })

  it('true when all three are set', () => {
    process.env.SMTP_HOST = 'smtp.gmail.com'
    process.env.SMTP_USER = 'x@x.com'
    process.env.SMTP_PASS = 'xxx'
    expect(hasGmailSmtpCredentials()).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// ConsoleTransport
// ---------------------------------------------------------------------------

describe('ConsoleTransport', () => {
  it('reports name=console', () => {
    const t = new ConsoleTransport()
    expect(t.name).toBe('console')
  })

  it('returns a synthetic messageId with console- prefix', async () => {
    const t = new ConsoleTransport()
    const result = await t.send({
      to: 'user@example.com',
      subject: 'hi',
      html: '<p>hello</p>',
      text: 'hello',
    })
    expect(result.ok).toBe(true)
    expect(result.provider).toBe('console')
    expect(result.messageId).toMatch(/^console-\d+-\d+$/)
    expect(result.error).toBeNull()
  })

  it('invokes the capture callback with the full envelope', async () => {
    const captured: TransportEnvelope[] = []
    const t = new ConsoleTransport({ capture: (e) => captured.push(e) })
    await t.send({
      to: 'user@example.com',
      subject: 'hi',
      html: '<p>hello</p>',
      text: 'hello',
      replyTo: 'support@x.com',
    })
    expect(captured).toHaveLength(1)
    expect(captured[0].to).toBe('user@example.com')
    expect(captured[0].subject).toBe('hi')
    expect(captured[0].replyTo).toBe('support@x.com')
  })

  it('increments the counter across sends', async () => {
    const t = new ConsoleTransport()
    const r1 = await t.send({ to: 'a', subject: 's', html: 'h', text: 't' })
    const r2 = await t.send({ to: 'b', subject: 's', html: 'h', text: 't' })
    expect(r1.messageId).not.toBe(r2.messageId)
  })
})

// ---------------------------------------------------------------------------
// SesTransport (scaffold)
// ---------------------------------------------------------------------------

describe('SesTransport', () => {
  it('reports name=ses', () => {
    expect(new SesTransport().name).toBe('ses')
  })

  it('rejects with a clear not-implemented error', async () => {
    const t = new SesTransport()
    const result = await t.send({
      to: 'user@example.com',
      subject: 'hi',
      html: '<p>hello</p>',
      text: 'hello',
    })
    expect(result.ok).toBe(false)
    expect(result.messageId).toBeNull()
    expect(result.error).toMatch(/not yet implemented/i)
    expect(result.provider).toBe('ses')
  })
})

// ---------------------------------------------------------------------------
// GmailSmtpTransport — constructor guards (no network)
// ---------------------------------------------------------------------------

describe('GmailSmtpTransport construction', () => {
  it('throws when SMTP_HOST is missing', () => {
    // No env set — constructor should reject.
    expect(() => new GmailSmtpTransport()).toThrow(/SMTP_HOST/)
  })

  it('throws when SMTP_USER or SMTP_PASS is missing', () => {
    process.env.SMTP_HOST = 'smtp.gmail.com'
    expect(() => new GmailSmtpTransport()).toThrow(/SMTP_USER|SMTP_PASS/)
  })

  it('constructs ok with full env', () => {
    process.env.SMTP_HOST = 'smtp.gmail.com'
    process.env.SMTP_USER = 'x@x.com'
    process.env.SMTP_PASS = 'xxx'
    const t = new GmailSmtpTransport()
    expect(t.name).toBe('gmail_smtp')
  })
})

// ---------------------------------------------------------------------------
// resolveTransport()
// ---------------------------------------------------------------------------

describe('resolveTransport', () => {
  it('EMAIL_TRANSPORT=console forces ConsoleTransport even with Gmail creds', () => {
    process.env.EMAIL_TRANSPORT = 'console'
    process.env.SMTP_HOST = 'smtp.gmail.com'
    process.env.SMTP_USER = 'x@x.com'
    process.env.SMTP_PASS = 'xxx'
    const t = resolveTransport()
    expect(t.name).toBe('console')
  })

  it('EMAIL_TRANSPORT=ses forces SesTransport', () => {
    process.env.EMAIL_TRANSPORT = 'ses'
    const t = resolveTransport()
    expect(t.name).toBe('ses')
  })

  it('EMAIL_TRANSPORT=gmail requires credentials (throws if missing)', () => {
    process.env.EMAIL_TRANSPORT = 'gmail'
    expect(() => resolveTransport()).toThrow()
  })

  it('auto-picks GmailSmtpTransport when SMTP env is complete', () => {
    process.env.SMTP_HOST = 'smtp.gmail.com'
    process.env.SMTP_USER = 'x@x.com'
    process.env.SMTP_PASS = 'xxx'
    const t = resolveTransport()
    expect(t.name).toBe('gmail_smtp')
  })

  it('auto-falls-back to ConsoleTransport when nothing is set', () => {
    const t = resolveTransport()
    expect(t.name).toBe('console')
  })

  it('warn-once: the console fallback only warns on the first call', () => {
    // Capture stderr warnings.
    const originalWarn = console.warn
    const warns: string[] = []
    console.warn = (...args: unknown[]) => {
      warns.push(args.map(String).join(' '))
    }
    try {
      resolveTransport()
      resolveTransport()
      resolveTransport()
      const fallbackWarns = warns.filter((w) => w.includes('email:transport'))
      expect(fallbackWarns).toHaveLength(1)
    } finally {
      console.warn = originalWarn
    }
  })

  // -------------------------------------------------------------------------
  // Phase 14 PR8 — production env guard (Bug 6)
  // -------------------------------------------------------------------------
  describe('Bug 6 — production env guard', () => {
    const origNodeEnv = process.env.NODE_ENV

    afterEach(() => {
      if (origNodeEnv === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = origNodeEnv
    })

    it('refuses silent console fallback in production — throws EmailTransportMisconfiguredError', () => {
      process.env.NODE_ENV = 'production'
      // No SMTP creds set (already cleared in beforeEach). Expected:
      // fail loud at resolveTransport time instead of marking every
      // delivery_row `status=sent provider=console` while nothing
      // actually leaves the server.
      expect(() => resolveTransport()).toThrow(/console fallback.*production/i)
    })

    it('NODE_ENV=production + EMAIL_TRANSPORT=console is allowed (ops escape hatch)', () => {
      process.env.NODE_ENV = 'production'
      process.env.EMAIL_TRANSPORT = 'console'
      const t = resolveTransport()
      expect(t.name).toBe('console')
    })

    it('NODE_ENV=production + real SMTP creds → GmailSmtpTransport (no throw)', () => {
      process.env.NODE_ENV = 'production'
      process.env.SMTP_HOST = 'smtp.gmail.com'
      process.env.SMTP_USER = 'prod@gbox.co'
      process.env.SMTP_PASS = 'xxx'
      const t = resolveTransport()
      expect(t.name).toBe('gmail_smtp')
    })

    it('NODE_ENV=development keeps the silent console fallback (dev ergonomics)', () => {
      process.env.NODE_ENV = 'development'
      const t = resolveTransport()
      expect(t.name).toBe('console')
    })

    it('NODE_ENV=test keeps the silent console fallback', () => {
      process.env.NODE_ENV = 'test'
      const t = resolveTransport()
      expect(t.name).toBe('console')
    })
  })
})
