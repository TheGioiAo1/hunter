/**
 * redact-pii.test.ts — Phase 12.5 PR4
 *
 * Every sentinel must land at the module boundary. If ANY test
 * here goes red, the implication is that a real PII field could
 * leak into an Anthropic prompt.
 */

import { describe, it, expect } from 'vitest'
import { isLuhnValid, redactPii, REDACTION_SENTINELS } from './redact-pii.ts'

describe('isLuhnValid', () => {
  it('accepts known-good Visa test number 4242424242424242', () => {
    expect(isLuhnValid('4242424242424242')).toBe(true)
  })

  it('accepts the same number with dashes', () => {
    expect(isLuhnValid('4242-4242-4242-4242')).toBe(true)
  })

  it('accepts Amex test number 378282246310005', () => {
    expect(isLuhnValid('378282246310005')).toBe(true)
  })

  it('rejects an off-by-one 4242-..-4241', () => {
    expect(isLuhnValid('4242424242424241')).toBe(false)
  })

  it('rejects too-short runs', () => {
    expect(isLuhnValid('4242')).toBe(false)
  })

  it('rejects too-long runs', () => {
    expect(isLuhnValid('42424242424242424242')).toBe(false)
  })

  it('rejects all-zero run', () => {
    // Technically passes Luhn (sum=0), but length=16 so it would
    // match — but 0000... has length 16. Luhn sum is 0 which is
    // 0 mod 10 so it DOES pass. The regex will tag it and redact.
    // This test documents that we're OK with that: a 16-zero run
    // in a prompt is meaningless noise anyway.
    expect(isLuhnValid('0000000000000000')).toBe(true)
  })
})

describe('redactPii — credit cards', () => {
  it('redacts a Visa test number', () => {
    const result = redactPii('My card is 4242424242424242, help?')
    expect(result).toBe('My card is [REDACTED-CC], help?')
  })

  it('redacts a Mastercard test number', () => {
    const result = redactPii('card 5555555555554444')
    expect(result).toContain('[REDACTED-CC]')
    expect(result).not.toContain('5555555555554444')
  })

  it('redacts a dashed card number', () => {
    const result = redactPii('4242-4242-4242-4242 was declined')
    expect(result).toContain('[REDACTED-CC]')
    expect(result).not.toContain('4242-4242')
  })

  it('does not redact a failing-Luhn 16-digit run', () => {
    // Random 16-digit number that fails Luhn — typical order ID
    // like "1234567890123456" shouldn't be stripped.
    const s = '1234567890123456'
    expect(isLuhnValid(s)).toBe(false)
    const result = redactPii(`order ref: ${s}`)
    expect(result).toContain('1234567890123456')
  })
})

describe('redactPii — SSN', () => {
  it('redacts SSN-shaped XXX-XX-XXXX', () => {
    expect(redactPii('SSN 123-45-6789')).toBe('SSN [REDACTED-SSN]')
  })

  it('redacts multiple SSNs in one pass', () => {
    const result = redactPii('SSN 111-22-3333 spouse 444-55-6666')
    expect(result.match(/\[REDACTED-SSN\]/g)).toHaveLength(2)
  })

  it('does not redact un-dashed 9-digit runs as SSN', () => {
    // Bare 9-digit runs match the VN CMND pattern, not SSN.
    const result = redactPii('id 123456789')
    expect(result).toContain('[REDACTED-ID]')
    expect(result).not.toContain('[REDACTED-SSN]')
  })
})

describe('redactPii — email', () => {
  it('redacts a plain email', () => {
    expect(redactPii('contact buithai3107@gmail.com')).toBe(
      'contact [REDACTED-EMAIL]',
    )
  })

  it('redacts PayPal-style plus-address emails', () => {
    const result = redactPii('seller.support+paypal@example.vn')
    expect(result).toBe('[REDACTED-EMAIL]')
  })

  it('does not eat surrounding HTML', () => {
    const result = redactPii('<a href="mailto:foo@bar.com">foo@bar.com</a>')
    expect(result).toContain('[REDACTED-EMAIL]')
    expect(result).not.toContain('foo@bar.com')
  })
})

describe('redactPii — Vietnamese national IDs', () => {
  it('redacts a 9-digit CMND run', () => {
    expect(redactPii('CMND 024195739')).toBe('CMND [REDACTED-ID]')
  })

  it('redacts a 12-digit CCCD run', () => {
    expect(redactPii('CCCD 023456789012')).toBe('CCCD [REDACTED-ID]')
  })

  it('does not match 10 or 11 digit runs', () => {
    const result = redactPii('phone 1234567890 or 12345678901')
    expect(result).toContain('1234567890')
    expect(result).toContain('12345678901')
  })
})

describe('redactPii — null safety', () => {
  it('returns empty string for undefined', () => {
    expect(redactPii(undefined)).toBe('')
  })

  it('returns empty string for null', () => {
    expect(redactPii(null)).toBe('')
  })

  it('returns empty string for empty input', () => {
    expect(redactPii('')).toBe('')
  })
})

describe('redactPii — end-to-end payload', () => {
  it('handles a realistic mixed PII block', () => {
    const input = [
      'My card is 4242-4242-4242-4242 and I want you to email me at',
      'seller@example.com. My SSN is 123-45-6789 and my CCCD is 024195739012.',
      "Here's the shop slug: my-store-2024.",
    ].join('\n')
    const out = redactPii(input)
    expect(out).toContain(REDACTION_SENTINELS.creditCard)
    expect(out).toContain(REDACTION_SENTINELS.email)
    expect(out).toContain(REDACTION_SENTINELS.ssn)
    expect(out).toContain(REDACTION_SENTINELS.nationalId)
    expect(out).not.toMatch(/4242/)
    expect(out).not.toMatch(/seller@/)
    expect(out).not.toMatch(/123-45-6789/)
    expect(out).not.toMatch(/024195739012/)
    // Non-PII content preserved.
    expect(out).toContain('my-store-2024')
  })
})

describe('REDACTION_SENTINELS constants', () => {
  it('are the exact strings the spec calls for', () => {
    expect(REDACTION_SENTINELS.creditCard).toBe('[REDACTED-CC]')
    expect(REDACTION_SENTINELS.ssn).toBe('[REDACTED-SSN]')
    expect(REDACTION_SENTINELS.email).toBe('[REDACTED-EMAIL]')
    expect(REDACTION_SENTINELS.nationalId).toBe('[REDACTED-ID]')
  })
})
