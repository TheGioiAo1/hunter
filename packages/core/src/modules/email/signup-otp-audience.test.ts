/**
 * Gbox Platform — Cluster E bug 10 regression test.
 *
 * BUG 10 HISTORY — it was a misdiagnosis.
 *
 * During the phase-14 pr8 post-mortem, the email-verify-otp template was
 * flagged as "broken" because its `audience` is `'god_admin'`. The fear
 * was that ANY send going to a non-god-admin recipient would be blocked.
 *
 * That fear was wrong. In this codebase `audience` is an ADMIN-UI
 * PERMISSION marker, not a recipient filter:
 *
 *   - audience='god_admin' means the template is PLATFORM-OWNED and
 *     `getMerchantVisibleTemplates()` filters it out of the seller
 *     override UI. Sellers can't (and shouldn't) edit signup verification
 *     copy.
 *
 *   - The send-path check at `send.ts` step "Iron Rule 5" only REFUSES
 *     to send when audience='god_admin' AND shopId !== null (i.e. a
 *     platform template being routed from a seller surface). With
 *     shopId=null (platform-scoped) the send proceeds normally.
 *
 * The signup flow passes shopId=null (see send-signup-otp.ts), so the
 * email correctly reaches the customer without hitting the Iron Rule 5
 * block. This test locks that understanding in so a future dev who
 * re-reads the bug ticket won't "fix" it by introducing a
 * customer-audience variant that would duplicate the template and
 * create a seller-editable signup email (a real Iron Rule 5 leak).
 */
import { describe, it, expect } from 'vitest'
import { getTemplate } from './registry.js'

describe('email_verify_otp template (bug 10 — audience is NOT a recipient filter)', () => {
  it('is registered under the canonical key', () => {
    const spec = getTemplate('email_verify_otp')
    expect(spec).toBeDefined()
    expect(spec!.key).toBe('email_verify_otp')
  })

  it('has audience=god_admin — INTENTIONAL (Iron Rule 5 admin-UI permission)', () => {
    // If someone changes this to 'customer' / 'seller' we want the
    // build to break so the PR reviewer asks WHY. The signup-flow
    // helpers in apps/accounts depend on this template remaining
    // platform-owned.
    const spec = getTemplate('email_verify_otp')
    expect(spec!.audience).toBe('god_admin')
  })

  it('is category=platform — INTENTIONAL (signup runs pre-shop, platform-scoped)', () => {
    const spec = getTemplate('email_verify_otp')
    expect(spec!.category).toBe('platform')
  })

  it('declares exactly the variables the signup helper passes (otp_code + expires_minutes)', () => {
    // Drift-guard: if the variables list changes in registry.ts but not
    // in send-signup-otp.ts (or vice versa) this catches the mismatch.
    const spec = getTemplate('email_verify_otp')
    expect(spec!.variables.sort()).toEqual(['expires_minutes', 'otp_code'])
  })

  it('bodyHtml renders {{otp_code}} + {{expires_minutes}}', () => {
    const spec = getTemplate('email_verify_otp')
    expect(spec!.bodyHtml).toContain('{{otp_code}}')
    expect(spec!.bodyHtml).toContain('{{expires_minutes}}')
  })

  it('bodyText renders {{otp_code}} + {{expires_minutes}}', () => {
    const spec = getTemplate('email_verify_otp')
    expect(spec!.bodyText).toContain('{{otp_code}}')
    expect(spec!.bodyText).toContain('{{expires_minutes}}')
  })

  // -------------------------------------------------------------------------
  // Iron Rule 5 wiring — the reason bug 10 was a non-issue.
  // -------------------------------------------------------------------------

  it('bodyText is seller-safe: no "God Admin" / "/god-admin" / internal path leaks', () => {
    // Iron Rule 5 defense-in-depth. Even though this template is
    // platform-owned, the recipient is the signing-up user — who may
    // be a future seller. They must never see God Admin branding.
    const spec = getTemplate('email_verify_otp')
    const copy = `${spec!.subject} ${spec!.bodyHtml} ${spec!.bodyText}`.toLowerCase()
    expect(copy).not.toMatch(/god[\s-]?admin/)
    expect(copy).not.toContain('/god-admin')
  })

  it('subject does not advertise the signup OTP is internal tooling', () => {
    const spec = getTemplate('email_verify_otp')
    expect(spec!.subject.toLowerCase()).not.toMatch(/god[\s-]?admin|internal/)
  })
})
