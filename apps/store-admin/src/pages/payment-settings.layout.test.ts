/**
 * payment-settings — centered + width-constrained layout tests
 * (April 2026 fix: Thai flagged the page was stretching too wide on
 * desktop — "em để trải ngang ra nhìn nó hơi dài").
 *
 * The rest of the page content (PayPal onboarding flow, Stripe inputs,
 * COD instructions, general settings) is unchanged. What we pin here is
 * just the visual frame that Thai actually asked for:
 *
 *   1. A `.pay-settings-wrap` wrapper exists in the rendered markup.
 *   2. It has a `max-width` in CSS so the column doesn't stretch across
 *      a 1440px+ monitor.
 *   3. It's horizontally centered via `margin: 0 auto`.
 *
 * We don't assert the exact max-width value (820 today, might flex to
 * 780 / 860 later for design reasons) — pinning the numeric width would
 * make any design tweak red without catching a real regression. We just
 * confirm the centering/constraint pattern is present so a future rewrite
 * can't silently delete it and ship an uncentered full-bleed form again.
 *
 * Rendering is exercised through the real handler (not a snapshot of the
 * content template), so this also smoke-tests that the handler still
 * boots cleanly with a missing db (the try/catch at loadSettings kicks
 * in and we fall through to the onboarding state).
 */

import { describe, it, expect, vi } from 'vitest'
import { getPaymentSettings } from './payment-settings.js'

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

function makeReq() {
  return {
    store: {
      id: 'shop-001',
      slug: 'acme',
      name: 'Acme',
      currency: 'VND',
    },
    storeUser: {
      id: 'user-1',
      name: 'Thai',
      email: 'thai@example.com',
      role: 'owner',
      storeRole: 'owner',
    },
    query: {},
    protocol: 'https',
    get: vi.fn(() => 'admin.gbox.test'),
  } as any
}

function makeRes() {
  const res: any = { _sent: '' }
  res.send = vi.fn((body: any) => {
    res._sent = String(body ?? '')
    return res
  })
  res.cookie = vi.fn(() => res)
  res.setHeader = vi.fn(() => res)
  res.appendHeader = vi.fn(() => res) // CSRF middleware calls this on issue()
  return res
}

/**
 * Fake Kysely that throws on any call — the handler's try/catch around
 * loadSettings swallows this, so we render the "not connected" state.
 * That's exactly what we want: maximum content rendered (both tab panels,
 * both input grids, bottom save button) inside the wrapper so the
 * centering assertion isn't trivially satisfied by an empty body.
 */
function makeFakeDb() {
  return {
    selectFrom: () => { throw new Error('db unavailable') },
  } as any
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('payment-settings — centered + width-constrained layout', () => {
  it('renders a .pay-settings-wrap wrapper around the page content', async () => {
    const req = makeReq()
    const res = makeRes()
    await getPaymentSettings(req, res, makeFakeDb())
    expect(res._sent).toContain('pay-settings-wrap')
  })

  it('declares max-width on .pay-settings-wrap so the column does not stretch end-to-end', async () => {
    const req = makeReq()
    const res = makeRes()
    await getPaymentSettings(req, res, makeFakeDb())
    // Pin the rule itself, not the exact px value. Accept optional
    // whitespace around the colon / selector (formatter drift).
    expect(res._sent).toMatch(/\.pay-settings-wrap\s*\{[^}]*max-width\s*:\s*\d+/)
  })

  it('centers .pay-settings-wrap horizontally via margin:0 auto', async () => {
    const req = makeReq()
    const res = makeRes()
    await getPaymentSettings(req, res, makeFakeDb())
    // `margin: 0 auto` vs `margin:0 auto` — allow either.
    expect(res._sent).toMatch(/\.pay-settings-wrap\s*\{[^}]*margin\s*:\s*0\s+auto/)
  })

  it('keeps the Save settings button (header + bottom) inside the wrapper', async () => {
    const req = makeReq()
    const res = makeRes()
    await getPaymentSettings(req, res, makeFakeDb())
    // The wrapper opens once and closes once; both "Save settings"
    // buttons should fall between those two markers. We check that the
    // wrapper-open comes before the first Save button and the
    // wrapper-close (its comment marker) comes after the last one.
    const html = res._sent
    const openIdx = html.indexOf('pay-settings-wrap"')
    const closeIdx = html.indexOf('/.pay-settings-wrap')
    const firstSave = html.indexOf('Save settings')
    const lastSave = html.lastIndexOf('Save settings')
    expect(openIdx).toBeGreaterThanOrEqual(0)
    expect(closeIdx).toBeGreaterThan(openIdx)
    expect(firstSave).toBeGreaterThan(openIdx)
    expect(lastSave).toBeLessThan(closeIdx)
  })
})
