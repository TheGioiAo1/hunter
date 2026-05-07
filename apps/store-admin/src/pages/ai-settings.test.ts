/**
 * Store-admin — AI Settings page (Phase 21 PR0 Task 6)
 *
 * Tests the pure `renderAiSettingsPage` renderer exported from ai-settings.ts.
 * This function is side-effect-free (no DB, no HTTP) so tests run fast
 * and in-process.
 *
 * Cases covered:
 *   - Renders provider selector with all three providers (Anthropic/OpenAI/Google)
 *   - Renders API key input as type="password"
 *   - Renders "Save & Verify" submit button
 *   - Shows verified status + formatted monthly cost when config has verified_at
 *   - Shows last error message when verification failed
 *   - Escapes HTML in user-controlled fields (XSS safety)
 *   - CSRF hidden field is included in the form
 */

import { describe, it, expect } from 'vitest'
import { renderAiSettingsPage } from './ai-settings.js'

describe('renderAiSettingsPage', () => {
  it('renders provider selector + API key input + Save & Verify button', () => {
    const html = renderAiSettingsPage({
      slug: 'best-store',
      currentConfig: null,
      csrfToken: 'csrf-1',
    })
    expect(html).toContain('Anthropic')
    expect(html).toContain('OpenAI')
    expect(html).toContain('Google')
    expect(html).toMatch(/<input[^>]*name="api_key"/)
    expect(html).toMatch(/Save &amp; Verify|Save and Verify/i)
  })

  it('includes a CSRF hidden field in the form', () => {
    const html = renderAiSettingsPage({
      slug: 'best-store',
      currentConfig: null,
      csrfToken: 'tok-xyz',
    })
    expect(html).toContain('tok-xyz')
    expect(html).toMatch(/<input[^>]*type="hidden"[^>]*/)
  })

  it('uses type="password" for the API key input', () => {
    const html = renderAiSettingsPage({
      slug: 'best-store',
      currentConfig: null,
      csrfToken: 'csrf-1',
    })
    expect(html).toMatch(/<input[^>]*type="password"[^>]*name="api_key"/)
  })

  it('shows verified status + last check time when verified_at is present', () => {
    const html = renderAiSettingsPage({
      slug: 'best-store',
      currentConfig: {
        provider: 'anthropic',
        anthropic_model: 'claude-haiku-4-5-20251001',
        verified_at: '2026-04-26T10:00:00Z',
        last_error: null,
        monthly_cost_usd_cents: 127,
      },
      csrfToken: 'csrf-1',
    })
    expect(html).toContain('Verified')
    expect(html).toContain('$1.27')
  })

  it('shows "Not yet verified" when no verified_at and no error', () => {
    const html = renderAiSettingsPage({
      slug: 'best-store',
      currentConfig: {
        provider: 'openai',
        openai_model: 'gpt-4o-mini',
        verified_at: null,
        last_error: null,
        monthly_cost_usd_cents: 0,
      },
      csrfToken: 'csrf-1',
    })
    expect(html).toContain('Not yet verified')
  })

  it('shows last error when verification failed', () => {
    const html = renderAiSettingsPage({
      slug: 'best-store',
      currentConfig: {
        provider: 'openai',
        openai_model: 'gpt-5',
        verified_at: null,
        last_error: '401 Unauthorized',
        monthly_cost_usd_cents: 0,
      },
      csrfToken: 'csrf-1',
    })
    expect(html).toContain('401')
    expect(html).toMatch(/please re-check|invalid/i)
  })

  it('escapes HTML in slug (XSS safety)', () => {
    const html = renderAiSettingsPage({
      slug: '<script>alert(1)</script>',
      currentConfig: null,
      csrfToken: 'csrf-1',
    })
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('escapes HTML in last_error (XSS safety)', () => {
    const html = renderAiSettingsPage({
      slug: 'safe-store',
      currentConfig: {
        provider: 'openai',
        openai_model: 'gpt-4o-mini',
        verified_at: null,
        last_error: '401 <img src=x onerror=alert(1)>',
        monthly_cost_usd_cents: 0,
      },
      csrfToken: 'csrf-1',
    })
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img')
  })

  it('shows $0.00 when monthly_cost_usd_cents is 0', () => {
    const html = renderAiSettingsPage({
      slug: 'best-store',
      currentConfig: {
        provider: 'anthropic',
        anthropic_model: 'claude-sonnet-4-20250514',
        verified_at: '2026-04-26T10:00:00Z',
        last_error: null,
        monthly_cost_usd_cents: 0,
      },
      csrfToken: 'csrf-1',
    })
    expect(html).toContain('$0.00')
  })

  it('pre-selects the configured provider in the dropdown', () => {
    const html = renderAiSettingsPage({
      slug: 'best-store',
      currentConfig: {
        provider: 'google',
        google_model: 'gemini-2.0-flash',
        verified_at: null,
        last_error: null,
        monthly_cost_usd_cents: 0,
      },
      csrfToken: 'csrf-1',
    })
    expect(html).toMatch(/value="google"[^>]*selected|selected[^>]*value="google"/)
  })
})
