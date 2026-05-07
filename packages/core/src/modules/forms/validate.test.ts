/**
 * Tests for the form validator library (Phase 2 Step 2.9).
 */

import { describe, it, expect } from 'vitest'
import {
  validate,
  required,
  email,
  minLength,
  maxLength,
  pattern,
  numeric,
  min,
  max,
  integer,
  url,
  slug,
  oneOf,
  matchesField,
  custom,
} from './validate.js'

// ---------------------------------------------------------------------------
// required
// ---------------------------------------------------------------------------

describe('required', () => {
  it('flags missing values', () => {
    expect(required()(undefined, 'name')).toBe('Name is required')
    expect(required()(null, 'name')).toBe('Name is required')
    expect(required()('', 'name')).toBe('Name is required')
    expect(required()('   ', 'name')).toBe('Name is required')
    expect(required()([], 'name')).toBe('Name is required')
  })

  it('passes non-empty values', () => {
    expect(required()('alice', 'name')).toBeNull()
    expect(required()(0, 'age')).toBeNull()
    expect(required()(false, 'accept')).toBeNull()
  })

  it('converts snake_case field names to title case', () => {
    expect(required()(null, 'user_email')).toBe('User email is required')
  })

  it('converts camelCase field names to title case', () => {
    expect(required()(null, 'firstName')).toBe('First Name is required')
  })

  it('honors custom messages', () => {
    expect(required('Gotta have it')(null, 'x')).toBe('Gotta have it')
  })
})

// ---------------------------------------------------------------------------
// email
// ---------------------------------------------------------------------------

describe('email', () => {
  it('accepts valid emails', () => {
    expect(email()('alice@example.com', 'e')).toBeNull()
    expect(email()('a.b+tag@sub.example.co.uk', 'e')).toBeNull()
  })

  it('rejects obviously invalid emails', () => {
    expect(email()('not an email', 'e')).toBe('Enter a valid email address')
    expect(email()('missing@tld', 'e')).toBe('Enter a valid email address')
    expect(email()('@no-local.com', 'e')).toBe('Enter a valid email address')
  })

  it('passes empty values (use required() to enforce presence)', () => {
    expect(email()('', 'e')).toBeNull()
    expect(email()(null, 'e')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// minLength / maxLength
// ---------------------------------------------------------------------------

describe('minLength', () => {
  it('flags strings shorter than min', () => {
    expect(minLength(8)('short', 'password')).toBe(
      'Password must be at least 8 characters',
    )
  })

  it('passes strings at or above min', () => {
    expect(minLength(4)('abcd', 'x')).toBeNull()
  })

  it('trims before measuring', () => {
    expect(minLength(4)('  ab  ', 'x')).toBe('X must be at least 4 characters')
  })

  it('uses singular for n=1', () => {
    expect(minLength(1)('', 'x')).toBeNull() // empty => skipped
  })
})

describe('maxLength', () => {
  it('flags strings longer than max', () => {
    expect(maxLength(3)('abcd', 'x')).toBe('X must be at most 3 characters')
  })

  it('passes strings at or below max', () => {
    expect(maxLength(5)('abc', 'x')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// pattern
// ---------------------------------------------------------------------------

describe('pattern', () => {
  it('uses provided regex', () => {
    expect(pattern(/^\d{3}$/)('abc', 'code')).toBe('Invalid format')
    expect(pattern(/^\d{3}$/)('123', 'code')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// numeric / min / max / integer
// ---------------------------------------------------------------------------

describe('numeric', () => {
  it('accepts numeric strings', () => {
    expect(numeric()('42', 'n')).toBeNull()
    expect(numeric()('-3.14', 'n')).toBeNull()
  })

  it('rejects non-numeric strings', () => {
    expect(numeric()('abc', 'n')).toBe('Must be a number')
    expect(numeric()('12px', 'n')).toBe('Must be a number')
  })

  it('accepts raw numbers', () => {
    expect(numeric()(42, 'n')).toBeNull()
  })
})

describe('min / max', () => {
  it('enforces bounds', () => {
    expect(min(18)('17', 'age')).toBe('Age must be at least 18')
    expect(min(18)('18', 'age')).toBeNull()
    expect(max(100)('101', 'pct')).toBe('Pct must be at most 100')
    expect(max(100)('100', 'pct')).toBeNull()
  })
})

describe('integer', () => {
  it('rejects decimals', () => {
    expect(integer()('3.14', 'n')).toBe('Must be a whole number')
  })

  it('accepts integers', () => {
    expect(integer()('42', 'n')).toBeNull()
    expect(integer()('-7', 'n')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// url / slug / oneOf
// ---------------------------------------------------------------------------

describe('url', () => {
  it('accepts well-formed URLs', () => {
    expect(url()('https://example.com', 'u')).toBeNull()
    expect(url()('http://localhost:3000/path?q=1', 'u')).toBeNull()
  })

  it('rejects invalid URLs', () => {
    expect(url()('not a url', 'u')).toBe('Enter a valid URL')
    // Bare domain is NOT a URL per the URL constructor.
    expect(url()('example.com', 'u')).toBe('Enter a valid URL')
  })
})

describe('slug', () => {
  it('accepts lowercase-hyphen-number slugs', () => {
    expect(slug()('hello-world-42', 's')).toBeNull()
    expect(slug()('single', 's')).toBeNull()
  })

  it('rejects uppercase or special chars', () => {
    expect(slug()('Hello', 's')).toBe(
      'Only lowercase letters, numbers, and hyphens',
    )
    expect(slug()('under_score', 's')).toContain('lowercase')
    expect(slug()('-leading', 's')).toContain('lowercase')
  })
})

describe('oneOf', () => {
  it('accepts allowed options', () => {
    expect(oneOf(['a', 'b', 'c'])('a', 'x')).toBeNull()
  })

  it('rejects others', () => {
    expect(oneOf(['a', 'b'])('c', 'x')).toBe('X must be one of: a, b')
  })
})

// ---------------------------------------------------------------------------
// matchesField
// ---------------------------------------------------------------------------

describe('matchesField', () => {
  it('passes when values match', () => {
    const data = { password: 'hunter2', confirm: 'hunter2' }
    expect(matchesField('password', data)('hunter2', 'confirm')).toBeNull()
  })

  it('flags when they differ', () => {
    const data = { password: 'hunter2', confirm: 'hunter3' }
    expect(matchesField('password', data)('hunter3', 'confirm')).toContain(
      'must match',
    )
  })
})

// ---------------------------------------------------------------------------
// custom
// ---------------------------------------------------------------------------

describe('custom', () => {
  it('wraps a predicate', () => {
    const even = custom(v => Number(v) % 2 === 0, 'Must be even')
    expect(even(3, 'n')).toBe('Must be even')
    expect(even(4, 'n')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// validate (schema runner)
// ---------------------------------------------------------------------------

describe('validate', () => {
  it('returns ok + data when all validators pass', () => {
    const result = validate(
      { email: 'a@b.com', age: '42' },
      {
        email: [required(), email()],
        age: [required(), numeric(), min(1)],
      },
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.email).toBe('a@b.com')
    }
  })

  it('collects per-field errors', () => {
    const result = validate(
      { email: 'bad', age: '-5' },
      {
        email: [required(), email()],
        age: [numeric(), min(0)],
      },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors.email).toBe('Enter a valid email address')
      expect(result.errors.age).toContain('at least')
    }
  })

  it('stops at first error per field (first-failure-wins)', () => {
    // required() fires first, email() is never reached.
    const result = validate(
      { email: '' },
      { email: [required('REQ'), email('EMAIL')] },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.email).toBe('REQ')
  })

  it('omits passing fields from the error map', () => {
    const result = validate(
      { email: 'a@b.com', age: '' },
      {
        email: [required(), email()],
        age: [required()],
      },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors.email).toBeUndefined()
      expect(result.errors.age).toBeDefined()
    }
  })

  it('handles cross-field matching via matchesField', () => {
    const data = { password: 'hunter2', confirm: 'hunter3' }
    const result = validate(data, {
      password: [required(), minLength(6)],
      confirm: [required(), matchesField('password', data)],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors.confirm).toContain('match')
    }
  })

  it('is safe against missing fields entirely', () => {
    const result = validate(
      {},
      { email: [required(), email()] },
    )
    expect(result.ok).toBe(false)
  })
})
