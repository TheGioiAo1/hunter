/**
 * Unit tests for the email preview helper (Phase 14 PR2 — commit 16).
 *
 * These cover:
 *
 *   - `interpolate()` matches `send.ts::interpolate` semantics (dot-
 *     paths, unknown → empty string, repeated substitutions).
 *   - `buildSamplePreviewVariables()` covers every declared variable
 *     either from NAMED_SAMPLES or a `[sample: …]` fallback (no blanks).
 *   - `renderPreviewDocument()` returns a standalone `<!DOCTYPE html>`,
 *     wraps the rendered body with a ribbon, and never injects raw
 *     template-key bytes into HTML (escape check).
 *   - A real catalog template (`order_confirmation`) renders without
 *     leaving any `{{…}}` in the output when all its variables are
 *     filled from samples.
 */

import { describe, it, expect } from 'vitest'
import {
  buildSamplePreviewVariables,
  interpolate,
  renderPreviewDocument,
} from './email-preview.js'
import {
  getTemplate,
  type TemplateSpec,
} from '@gbox/core/modules/email/registry.js'

// ---------------------------------------------------------------------------
// interpolate()
// ---------------------------------------------------------------------------

describe('interpolate', () => {
  it('substitutes a simple {{name}} placeholder', () => {
    expect(interpolate('hi {{who}}', { who: 'there' })).toBe('hi there')
  })

  it('supports dot-path {{a.b.c}} access', () => {
    expect(
      interpolate('order {{order.number}} for {{customer.name}}', {
        order: { number: '1001' },
        customer: { name: 'Pat' },
      }),
    ).toBe('order 1001 for Pat')
  })

  it('renders unknown keys as empty string (Shopify convention)', () => {
    expect(interpolate('hi {{missing}}!', {})).toBe('hi !')
  })

  it('substitutes the same placeholder many times', () => {
    expect(interpolate('{{x}}-{{x}}-{{x}}', { x: '1' })).toBe('1-1-1')
  })

  it('never throws when the value is null / undefined', () => {
    expect(interpolate('x={{a}} y={{b}}', { a: null, b: undefined })).toBe(
      'x= y=',
    )
  })
})

// ---------------------------------------------------------------------------
// buildSamplePreviewVariables()
// ---------------------------------------------------------------------------

describe('buildSamplePreviewVariables', () => {
  it('fills every declared variable with a non-empty sample', () => {
    const spec: Pick<TemplateSpec, 'variables'> = {
      variables: ['customer_name', 'order_number', 'shop_name'],
    }
    const vars = buildSamplePreviewVariables(spec)
    expect(String(vars.customer_name).length).toBeGreaterThan(0)
    expect(String(vars.order_number).length).toBeGreaterThan(0)
    expect(String(vars.shop_name).length).toBeGreaterThan(0)
  })

  it('uses [sample: key] fallback for unknown variable names', () => {
    const spec: Pick<TemplateSpec, 'variables'> = {
      variables: ['wholly_made_up_variable_xyz'],
    }
    const vars = buildSamplePreviewVariables(spec)
    expect(vars.wholly_made_up_variable_xyz).toBe(
      '[sample: wholly_made_up_variable_xyz]',
    )
  })

  it('returns a fresh object on every call (no shared mutation)', () => {
    const spec: Pick<TemplateSpec, 'variables'> = { variables: [] }
    const a = buildSamplePreviewVariables(spec)
    const b = buildSamplePreviewVariables(spec)
    expect(a).not.toBe(b)
    a.customer_name = 'MUTATED'
    expect(b.customer_name).not.toBe('MUTATED')
  })

  it('covers the scaffold defaults (heading / body_html / cta_*) so scaffolded templates render clean', () => {
    const spec: Pick<TemplateSpec, 'variables'> = {
      variables: ['heading', 'body_html', 'cta_label', 'cta_url'],
    }
    const vars = buildSamplePreviewVariables(spec)
    expect(String(vars.heading).length).toBeGreaterThan(0)
    expect(String(vars.body_html).length).toBeGreaterThan(0)
    expect(String(vars.cta_label).length).toBeGreaterThan(0)
    expect(String(vars.cta_url).length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// renderPreviewDocument()
// ---------------------------------------------------------------------------

describe('renderPreviewDocument', () => {
  it('returns a standalone <!DOCTYPE html> document', () => {
    const html = renderPreviewDocument({
      resolved: {
        key: 'sample',
        subject: 'Hello {{name}}',
        bodyHtml: '<p>Hi {{name}}</p>',
      },
      variables: { name: 'Pat' },
    })
    expect(html).toMatch(/^<!DOCTYPE html>/)
    expect(html).toContain('<html')
    expect(html).toContain('</html>')
  })

  it('uses the rendered subject as the document <title>', () => {
    const html = renderPreviewDocument({
      resolved: { key: 'k', subject: 'Order {{n}} confirmed', bodyHtml: '' },
      variables: { n: '1001' },
    })
    expect(html).toContain('<title>Order 1001 confirmed</title>')
  })

  it('inserts the interpolated body verbatim (template owns its CSS)', () => {
    const body = '<div style="color:red">Hi <strong>Pat</strong></div>'
    const html = renderPreviewDocument({
      resolved: { key: 'k', subject: 'x', bodyHtml: body },
      variables: {},
    })
    expect(html).toContain(body)
  })

  it('renders a PREVIEW ribbon with the template key, HTML-escaped', () => {
    const html = renderPreviewDocument({
      resolved: { key: 'order_confirmation', subject: 'x', bodyHtml: '' },
      variables: {},
    })
    expect(html).toContain('Preview · order_confirmation')
  })

  it('HTML-escapes the subject to prevent script injection via placeholder values', () => {
    const html = renderPreviewDocument({
      resolved: {
        key: 'k',
        subject: 'Hi {{name}}',
        bodyHtml: '',
      },
      variables: { name: '<script>alert(1)</script>' },
    })
    // The subject goes into <title> — and we escape BEFORE putting it
    // there. So raw <script> must not appear as literal markup.
    expect(html).not.toContain('<title>Hi <script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('escapes the template key in the ribbon (defense in depth)', () => {
    const html = renderPreviewDocument({
      resolved: { key: '<evil>', subject: 'x', bodyHtml: '' },
      variables: {},
    })
    expect(html).toContain('Preview · &lt;evil&gt;')
    expect(html).not.toContain('Preview · <evil>')
  })
})

// ---------------------------------------------------------------------------
// Real catalog smoke — pick a well-known template, fill from samples,
// assert the interpolated body contains no leftover `{{…}}`.
// ---------------------------------------------------------------------------

describe('real catalog templates render cleanly from samples', () => {
  it('order_confirmation has no unreplaced {{placeholders}} after sample fill', () => {
    const spec = getTemplate('order_confirmation')
    expect(spec).toBeDefined()
    const vars = buildSamplePreviewVariables(spec!)
    const html = renderPreviewDocument({
      resolved: {
        key: spec!.key,
        subject: spec!.subject,
        bodyHtml: spec!.bodyHtml,
      },
      variables: vars,
    })
    // Allow `{{` to appear inside the ribbon text? No — the ribbon only
    // prints the template key. Any `{{` left here would be an un-filled
    // placeholder in the rendered body OR subject. Catch both.
    expect(html).not.toMatch(/\{\{[^}]+\}\}/)
  })

  it('fulfillment_delivered renders without leftover placeholders (commit 15)', () => {
    const spec = getTemplate('fulfillment_delivered')
    expect(spec).toBeDefined()
    const vars = buildSamplePreviewVariables(spec!)
    const html = renderPreviewDocument({
      resolved: {
        key: spec!.key,
        subject: spec!.subject,
        bodyHtml: spec!.bodyHtml,
      },
      variables: vars,
    })
    expect(html).not.toMatch(/\{\{[^}]+\}\}/)
  })
})
