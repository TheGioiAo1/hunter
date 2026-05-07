import { describe, it, expect } from 'vitest'
import {
  renderCloneForm,
  cloneFormCss,
  cloneFormRuntimeScriptBody,
} from './clone-form.js'

const baseProps = {
  action: '/admin/store/s1/clone-pro/start',
  csrfToken: 'tok-abc',
}

describe('CloneForm', () => {
  it('renders a <form method=post> pointing at the action prop', () => {
    const html = renderCloneForm({ ...baseProps, variant: 'landing' })
    expect(html).toContain('method="post"')
    expect(html).toContain('action="/admin/store/s1/clone-pro/start"')
  })
  it('includes CSRF hidden input with escaped token', () => {
    const html = renderCloneForm({
      ...baseProps,
      variant: 'landing',
      csrfToken: '"><img>',
    })
    expect(html).toContain('name="_csrf"')
    expect(html).not.toContain('"><img>')
  })
  it('renders URL input with required + type=url', () => {
    const html = renderCloneForm({ ...baseProps, variant: 'landing' })
    expect(html).toContain('name="source_url"')
    expect(html).toContain('type="url"')
    expect(html).toContain('required')
  })
  it('defaults Alt-text and SEO toggles to on (checked)', () => {
    const html = renderCloneForm({ ...baseProps, variant: 'landing' })
    expect(html).toMatch(/name="alt_text"[^>]*checked/)
    expect(html).toMatch(/name="seo"[^>]*checked/)
  })
  it('honors defaults.altText=false / defaults.seo=false', () => {
    const html = renderCloneForm({
      ...baseProps,
      variant: 'landing',
      defaults: { altText: false, seo: false },
    })
    expect(html).not.toMatch(/name="alt_text"[^>]*checked/)
    expect(html).not.toMatch(/name="seo"[^>]*checked/)
  })
  it('renders cost estimate (live) — defaults show $0.65', () => {
    expect(renderCloneForm({ ...baseProps, variant: 'landing' })).toContain(
      '$0.65',
    )
  })
  it('renders cost estimate Free when both toggles defaulted off', () => {
    expect(
      renderCloneForm({
        ...baseProps,
        variant: 'landing',
        defaults: { altText: false, seo: false },
      }),
    ).toContain('Free')
  })
  it('exposes More options <details> with advanced inputs', () => {
    const html = renderCloneForm({ ...baseProps, variant: 'landing' })
    expect(html).toContain('<details')
    expect(html).toContain('name="slug"')
    expect(html).toContain('name="max_pages"')
    expect(html).toContain('name="depth"')
    expect(html).toContain('name="concurrency"')
    expect(html).toContain('name="publish_mode"')
  })
  it('landing variant uses .gbx-clone-form-landing class', () => {
    expect(renderCloneForm({ ...baseProps, variant: 'landing' })).toContain(
      'gbx-clone-form-landing',
    )
  })
  it('modal variant uses .gbx-clone-form-modal class', () => {
    expect(renderCloneForm({ ...baseProps, variant: 'modal' })).toContain(
      'gbx-clone-form-modal',
    )
  })
  it('runtime script body recomputes cost on toggle change', () => {
    const js = cloneFormRuntimeScriptBody()
    expect(js).toContain('alt_text')
    expect(js).toContain('seo')
    expect(js).toContain('data-cost-cents')
  })
  it('exports cloneFormCss referencing tokens', () => {
    expect(cloneFormCss).toMatch(/gbx-clone-form/)
    expect(cloneFormCss).toMatch(/var\(--/)
  })

  // --- Phase 6 — duplicate_domain modal ------------------------------

  describe('Phase 6 duplicate-domain modal', () => {
    it('emits the hidden modal scaffold alongside the form', () => {
      const html = renderCloneForm({ ...baseProps, variant: 'landing' })
      expect(html).toContain('data-dupe-modal')
      expect(html).toContain('hidden')
      expect(html).toContain('role="dialog"')
      expect(html).toContain('aria-modal="true"')
    })

    it('exposes the data-* hooks the runtime script binds to', () => {
      const html = renderCloneForm({ ...baseProps, variant: 'landing' })
      for (const hook of [
        'data-dupe-list',
        'data-dupe-sub',
        'data-dupe-view',
        'data-dupe-replace',
        'data-dupe-cancel',
      ]) {
        expect(html).toContain(hook)
      }
    })

    it('stamps data-base-action onto the form so the runtime can restore it after Replace', () => {
      const html = renderCloneForm({ ...baseProps, variant: 'landing' })
      expect(html).toContain(
        'data-base-action="/admin/store/s1/clone-pro/start"',
      )
    })

    it('renders the modal for both landing + modal variants', () => {
      const landing = renderCloneForm({ ...baseProps, variant: 'landing' })
      const modal = renderCloneForm({ ...baseProps, variant: 'modal' })
      expect(landing).toContain('data-dupe-modal')
      expect(modal).toContain('data-dupe-modal')
    })

    it('runtime script intercepts submit + branches on 409 duplicate_domain', () => {
      const js = cloneFormRuntimeScriptBody()
      // It must POST via fetch (not native submit) so we can read the
      // JSON body on conflict.
      expect(js).toContain("fetch(baseAction")
      expect(js).toContain("method: 'POST'")
      // 409 branch → parse body + check error === 'duplicate_domain'.
      expect(js).toContain('r.status === 409')
      expect(js).toContain("'duplicate_domain'")
      // Happy-path redirect must follow the server's 302.
      expect(js).toContain('r.redirected')
      expect(js).toContain('window.location.href')
    })

    it('runtime script wires Replace button to pendingReplaceUrl + native submit', () => {
      const js = cloneFormRuntimeScriptBody()
      // Replace click must copy the server-provided replace_url onto
      // the form action then call form.submit() — native so CSRF + the
      // user-entered values both round-trip.
      expect(js).toContain('pendingReplaceUrl')
      expect(js).toContain("form.setAttribute('action', pendingReplaceUrl)")
      expect(js).toContain('form.submit()')
    })

    it('runtime script falls back to native submit on network / unknown-shape errors', () => {
      const js = cloneFormRuntimeScriptBody()
      // Both the .catch() branch AND the "non-409, non-OK" branch must
      // call form.submit() so the server can render its validation UI.
      expect(js).toMatch(/\.catch\(function\(\)\s*\{[\s\S]*form\.submit\(\)/)
    })

    it('runtime script closes modal on Escape + Cancel', () => {
      const js = cloneFormRuntimeScriptBody()
      expect(js).toContain("e.key === 'Escape'")
      expect(js).toContain('modalCancel')
      expect(js).toContain('closeModal')
    })

    it('cloneFormCss ships the Phase 6 modal styles', () => {
      for (const cls of [
        '.gbx-dupe-modal',
        '.gbx-dupe-card',
        '.gbx-dupe-row',
        '.gbx-dupe-row-status',
        '.gbx-dupe-actions',
        '.gbx-btn-outline',
        '.gbx-btn-secondary',
        '.gbx-btn-danger',
        'body.gbx-dupe-lock',
      ]) {
        expect(cloneFormCss).toContain(cls)
      }
    })
  })
})
