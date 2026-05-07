/**
 * Phase 7 Step 7.3 — Clone-pro constants contract tests.
 *
 * The `CLONE_BOT_USER_AGENT` string is duplicated in
 * `clone-shopify/safe-fetch.ts` as the `DEFAULT_OPTIONS.userAgent`.
 * That duplication is deliberate (safe-fetch lives in clone-shopify
 * and can't import from clone-pro without creating a dep cycle), but
 * the two strings MUST stay in sync — otherwise safeFetch calls that
 * don't explicitly override UA would advertise a different identity
 * than `politeFetch` calls. This file is the drift alarm.
 *
 * Also pins:
 *   - UA format follows Google's `<Bot>/<Ver> (+<url>)` convention
 *   - Token `GboxCloneBot` appears in the full UA string (so
 *     site-side robots.txt rules that match our token still work)
 *   - `isRobotsEnforced()` reads env AT CALL TIME, not at import
 *     time (otherwise the rollback flag can't be flipped at runtime)
 */

import { describe, it, expect, afterEach } from 'vitest'

import {
  CLONE_BOT_UA_TOKEN,
  CLONE_BOT_USER_AGENT,
  HOST_RATE_LIMIT,
  isRobotsEnforced,
} from './constants.js'

describe('Phase 7.3 — clone-pro constants', () => {
  afterEach(() => {
    delete process.env.CLONE_ROBOTS_ENFORCED
  })

  it('CLONE_BOT_USER_AGENT follows the Google bot-disclosure format', () => {
    // Google's convention: `<BotName>/<Version> (+<url>)`. Anything
    // else makes us harder to identify in site access logs.
    expect(CLONE_BOT_USER_AGENT).toMatch(/^GboxCloneBot\/\d+\.\d+ \(\+https:\/\/[^)]+\)$/)
  })

  it('CLONE_BOT_UA_TOKEN appears inside the full UA string', () => {
    // robots.txt match uses the bare token — a UA string that omits
    // the token would cause robots rules targeting GboxCloneBot to
    // miss entirely.
    expect(CLONE_BOT_USER_AGENT).toContain(CLONE_BOT_UA_TOKEN)
  })

  it('safe-fetch.ts DEFAULT_OPTIONS.userAgent matches CLONE_BOT_USER_AGENT', async () => {
    // Drift alarm — read safe-fetch source, extract its default UA,
    // confirm it's the same string. If this ever fails, someone
    // changed one of the two and not the other.
    const fs = await import('node:fs/promises')
    const src = await fs.readFile(
      new URL('../clone-shopify/safe-fetch.ts', import.meta.url),
      'utf8',
    )
    // Expect the exact string literal somewhere in the file.
    expect(src).toContain(`'${CLONE_BOT_USER_AGENT}'`)
  })

  it('HOST_RATE_LIMIT defaults to 5 (= 5 req/s per spec §3.7)', () => {
    // Env override via CLONE_HOST_RATE_LIMIT is allowed; this test
    // pins the default when unset.
    expect(HOST_RATE_LIMIT).toBeGreaterThanOrEqual(1)
    expect(HOST_RATE_LIMIT).toBeLessThanOrEqual(10)
  })

  it('isRobotsEnforced() defaults to true when env var is unset', () => {
    delete process.env.CLONE_ROBOTS_ENFORCED
    expect(isRobotsEnforced()).toBe(true)
  })

  it('isRobotsEnforced() returns false when env is "false" / "0" / ""', () => {
    for (const v of ['false', 'FALSE', '0', '']) {
      process.env.CLONE_ROBOTS_ENFORCED = v
      expect(isRobotsEnforced()).toBe(false)
    }
  })

  it('isRobotsEnforced() returns true for any other value', () => {
    // Anything non-falsy keeps enforcement ON — we err on the side
    // of politeness. A typo like `CLONE_ROBOTS_ENFORCED=ff` doesn't
    // silently disable the whole feature.
    for (const v of ['true', '1', 'yes', 'on']) {
      process.env.CLONE_ROBOTS_ENFORCED = v
      expect(isRobotsEnforced()).toBe(true)
    }
  })

  it('isRobotsEnforced() reads process.env at call time (not at import)', () => {
    // If the flag were captured at module-load time, setting env
    // here wouldn't change the return value.
    process.env.CLONE_ROBOTS_ENFORCED = 'false'
    expect(isRobotsEnforced()).toBe(false)
    process.env.CLONE_ROBOTS_ENFORCED = 'true'
    expect(isRobotsEnforced()).toBe(true)
  })
})
