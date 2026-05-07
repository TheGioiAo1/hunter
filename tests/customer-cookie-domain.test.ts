/**
 * Unit test — buildCustomerCookieOptions domain behaviour (Step 2.3 of Decision #2).
 *
 * Locks in the cookie attribute matrix:
 *
 *   | explicit opts.domain | CUSTOMER_COOKIE_DOMAIN | result        |
 *   |----------------------|------------------------|----------------|
 *   | '.gbox.co'           | (any)                  | '.gbox.co'     |
 *   | undefined            | '.gbox.co'             | '.gbox.co'     |
 *   | undefined            | (unset)                | host-only      |
 *   | ''                   | '.gbox.co'             | '.gbox.co'     |
 *
 * No DB, no Redis. Just env var manipulation around the helper.
 *
 * Run:
 *   npx tsx tests/customer-cookie-domain.test.ts
 */

import { buildCustomerCookieOptions } from '../packages/core/src/modules/customer-auth/middleware.js'

function assert(cond: any, msg: string): asserts cond {
  if (!cond) throw new Error('ASSERTION FAILED: ' + msg)
}

function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  try {
    return fn()
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

function main() {
  const expires = new Date(Date.now() + 30 * 86400 * 1000)

  // ============ Case 1 — explicit domain wins ============
  withEnv({ CUSTOMER_COOKIE_DOMAIN: undefined }, () => {
    const opts = buildCustomerCookieOptions(expires, { domain: '.gbox.co' })
    assert(
      (opts as any).domain === '.gbox.co',
      `explicit domain should be .gbox.co, got ${(opts as any).domain}`,
    )
  })
  console.log('PASS 1/5 — explicit opts.domain wins')

  // ============ Case 2 — env fallback ============
  withEnv({ CUSTOMER_COOKIE_DOMAIN: '.gbox.co' }, () => {
    const opts = buildCustomerCookieOptions(expires)
    assert(
      (opts as any).domain === '.gbox.co',
      `env fallback should set .gbox.co, got ${(opts as any).domain}`,
    )
  })
  console.log('PASS 2/5 — CUSTOMER_COOKIE_DOMAIN env var picked up')

  // ============ Case 3 — host-only when neither is set ============
  withEnv({ CUSTOMER_COOKIE_DOMAIN: undefined }, () => {
    const opts = buildCustomerCookieOptions(expires)
    assert(
      !('domain' in opts),
      `host-only mode should not set domain, got ${(opts as any).domain}`,
    )
  })
  console.log('PASS 3/5 — host-only when no override + no env')

  // ============ Case 4 — explicit override beats env ============
  withEnv({ CUSTOMER_COOKIE_DOMAIN: '.gbox.co' }, () => {
    const opts = buildCustomerCookieOptions(expires, { domain: '.acme.com' })
    assert(
      (opts as any).domain === '.acme.com',
      `explicit override .acme.com should beat env .gbox.co, got ${(opts as any).domain}`,
    )
  })
  console.log('PASS 4/5 — explicit opts.domain beats env var')

  // ============ Case 5 — base attributes always present ============
  withEnv({ CUSTOMER_COOKIE_DOMAIN: undefined, NODE_ENV: 'production' }, () => {
    const opts = buildCustomerCookieOptions(expires, { domain: '.gbox.co' })
    assert(opts.httpOnly === true, 'httpOnly always true')
    assert(opts.secure === true, 'secure true in production')
    assert(opts.sameSite === 'lax', 'sameSite=lax')
    assert(opts.path === '/', 'path=/')
    assert(opts.expires === expires, 'expires propagated')
  })
  console.log('PASS 5/5 — base attributes intact (httpOnly, secure, sameSite, path, expires)')

  console.log('\nALL PASSED — buildCustomerCookieOptions domain behaviour locked')
}

try {
  main()
} catch (err: any) {
  console.error('FAIL:', err.message)
  process.exit(1)
}
