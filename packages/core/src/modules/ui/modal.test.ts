/**
 * Tests for the shared modal module (Phase 2 Step 2.3).
 */

import { describe, it, expect } from 'vitest'
import {
  modal,
  confirmModal,
  dangerousConfirmModal,
  modalRuntimeScriptBody,
  modalCss,
} from './modal.js'

describe('modal — base template', () => {
  it('renders a <dialog> with the expected id', () => {
    const html = modal({ id: 'demo', title: 'Hello' })
    expect(html).toContain('<dialog')
    expect(html).toContain('id="demo"')
  })

  it('wires aria-labelledby to the title id', () => {
    const html = modal({ id: 'demo', title: 'Hello' })
    expect(html).toContain('aria-labelledby="demo-title"')
    expect(html).toContain('id="demo-title"')
    expect(html).toContain('aria-modal="true"')
  })

  it('renders the title HTML-escaped', () => {
    const html = modal({
      id: 'demo',
      title: '<script>alert(1)</script>',
    })
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('renders the description HTML-escaped when provided', () => {
    const html = modal({
      id: 'demo',
      title: 'Hi',
      description: '<img src=x onerror=alert(1)>',
    })
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('&lt;img')
  })

  it('omits the description block entirely when not provided', () => {
    const html = modal({ id: 'demo', title: 'Hi' })
    expect(html).not.toContain('gbox-modal-description')
  })

  it('renders body HTML as-is (caller responsibility to escape)', () => {
    const html = modal({
      id: 'demo',
      title: 'Hi',
      body: '<p>trusted <strong>html</strong></p>',
    })
    expect(html).toContain('<strong>html</strong>')
  })

  it('supports sm/md/lg size variants', () => {
    expect(modal({ id: 'a', title: 't', size: 'sm' })).toContain(
      'gbox-modal-sm',
    )
    expect(modal({ id: 'a', title: 't', size: 'md' })).toContain(
      'gbox-modal-md',
    )
    expect(modal({ id: 'a', title: 't', size: 'lg' })).toContain(
      'gbox-modal-lg',
    )
  })

  it('has a close button wired to gboxCloseModal', () => {
    const html = modal({ id: 'demo', title: 'Hi' })
    expect(html).toContain("gboxCloseModal('demo')")
    expect(html).toContain('aria-label="Close"')
  })

  it('omits the actions row when no actions are passed', () => {
    const html = modal({ id: 'demo', title: 'Hi' })
    expect(html).not.toContain('gbox-modal-actions')
  })
})

describe('modal — actions', () => {
  it('renders an href button as <a>', () => {
    const html = modal({
      id: 'demo',
      title: 'Hi',
      actions: [{ label: 'Docs', href: '/docs' }],
    })
    expect(html).toContain('<a href="/docs"')
    expect(html).toContain('Docs</a>')
  })

  it('renders a close button that calls gboxCloseModal', () => {
    const html = modal({
      id: 'demo',
      title: 'Hi',
      actions: [{ label: 'Cancel', close: true }],
    })
    expect(html).toContain("gboxCloseModal('demo')")
  })

  it('renders a submit button with form attribute', () => {
    const html = modal({
      id: 'demo',
      title: 'Hi',
      actions: [{ label: 'Save', type: 'submit', form: 'myForm', kind: 'primary' }],
    })
    expect(html).toContain('type="submit"')
    expect(html).toContain('form="myForm"')
    expect(html).toContain('gbox-modal-btn-primary')
  })

  it('renders a danger button with the danger class', () => {
    const html = modal({
      id: 'demo',
      title: 'Hi',
      actions: [{ label: 'Delete', kind: 'danger', close: true }],
    })
    expect(html).toContain('gbox-modal-btn-danger')
  })

  it('honors the disabled flag', () => {
    const html = modal({
      id: 'demo',
      title: 'Hi',
      actions: [
        { label: 'Go', kind: 'primary', onclick: 'foo()', disabled: true },
      ],
    })
    expect(html).toContain('disabled')
  })

  it('HTML-escapes the action label', () => {
    const html = modal({
      id: 'demo',
      title: 'Hi',
      actions: [{ label: '<b>Click</b>', close: true }],
    })
    expect(html).not.toContain('<b>Click</b>')
    expect(html).toContain('&lt;b&gt;')
  })
})

describe('confirmModal', () => {
  it('renders with Cancel + Confirm by default', () => {
    const html = confirmModal({ id: 'demo', title: 'Are you sure?' })
    expect(html).toContain('Cancel')
    expect(html).toContain('Confirm')
  })

  it('allows custom cancel/confirm labels', () => {
    const html = confirmModal({
      id: 'demo',
      title: 'Proceed?',
      cancelLabel: 'Go back',
      confirmLabel: 'Yes, proceed',
    })
    expect(html).toContain('Go back')
    expect(html).toContain('Yes, proceed')
  })

  it('destructive=true renders the confirm button as danger', () => {
    const html = confirmModal({
      id: 'demo',
      title: 'Delete?',
      destructive: true,
      confirmLabel: 'Delete',
    })
    expect(html).toContain('gbox-modal-btn-danger')
  })

  it('non-destructive confirm is primary', () => {
    const html = confirmModal({ id: 'demo', title: 'Save?' })
    expect(html).toContain('gbox-modal-btn-primary')
  })

  it('wires confirm to a form when form id is provided', () => {
    const html = confirmModal({
      id: 'demo',
      title: 'Save?',
      form: 'saveForm',
    })
    expect(html).toContain('type="submit"')
    expect(html).toContain('form="saveForm"')
  })

  it('wires confirm to onConfirm JS when provided', () => {
    const html = confirmModal({
      id: 'demo',
      title: 'Do it?',
      onConfirm: 'doThing()',
    })
    expect(html).toContain('doThing()')
  })
})

describe('dangerousConfirmModal', () => {
  it('renders an input labeled with the type-to-confirm prompt', () => {
    const html = dangerousConfirmModal({
      id: 'demo',
      title: 'Delete store',
      requireType: 'acme-store',
      form: 'deleteForm',
    })
    expect(html).toContain('Type acme-store to confirm')
    expect(html).toContain('gbox-modal-input')
  })

  it('renders the confirm button disabled by default', () => {
    const html = dangerousConfirmModal({
      id: 'demo',
      title: 'Delete',
      requireType: 'DELETE',
      form: 'f',
    })
    expect(html).toContain('disabled')
  })

  it('submits via the required form id', () => {
    const html = dangerousConfirmModal({
      id: 'demo',
      title: 'Delete',
      requireType: 'DELETE',
      form: 'deleteForm',
    })
    expect(html).toContain('form="deleteForm"')
    expect(html).toContain('type="submit"')
  })

  it('uses a danger-styled confirm button', () => {
    const html = dangerousConfirmModal({
      id: 'demo',
      title: 'Delete',
      requireType: 'DELETE',
      form: 'f',
    })
    expect(html).toContain('gbox-modal-btn-danger')
  })

  it('defaults confirm label to "Delete"', () => {
    const html = dangerousConfirmModal({
      id: 'demo',
      title: 'Delete',
      requireType: 'DELETE',
      form: 'f',
    })
    expect(html).toContain('>Delete</button>')
  })

  it('wires oninput to compare the value against requireType (JSON-encoded)', () => {
    const html = dangerousConfirmModal({
      id: 'demo',
      title: 'Delete',
      requireType: 'acme-store',
      form: 'f',
    })
    expect(html).toContain('oninput=')
    // The JSON-encoded string should appear in the oninput handler
    expect(html).toContain('"acme-store"')
  })

  it('handles requireType values with quotes without breaking the attribute', () => {
    // JSON-encoding the compare string handles quotes safely — the
    // outer `oninput="..."` attribute's quotes are then escaped by
    // the esc() helper applied to the entire handler. Verify by
    // parse-checking that the HTML still has a matching close quote.
    const html = dangerousConfirmModal({
      id: 'demo',
      title: 'Delete',
      requireType: `weird"value'here`,
      form: 'f',
    })
    // The original dangerous chars should not appear raw in the HTML
    expect(html).not.toContain('weird"value')
    // The escaped quote should appear (because esc() escapes the full oninput attribute)
    expect(html).toContain('&quot;')
  })

  it('input has autocomplete disabled', () => {
    const html = dangerousConfirmModal({
      id: 'demo',
      title: 'Delete',
      requireType: 'X',
      form: 'f',
    })
    expect(html).toContain('autocomplete="off"')
    expect(html).toContain('spellcheck="false"')
  })
})

describe('modalRuntimeScriptBody', () => {
  it('defines window.gboxOpenModal', () => {
    expect(modalRuntimeScriptBody()).toContain('window.gboxOpenModal')
  })

  it('defines window.gboxCloseModal', () => {
    expect(modalRuntimeScriptBody()).toContain('window.gboxCloseModal')
  })

  it('uses the native <dialog> showModal when available', () => {
    expect(modalRuntimeScriptBody()).toContain('showModal')
  })

  it('has a fallback for browsers without <dialog>', () => {
    expect(modalRuntimeScriptBody()).toContain('gbox-modal-fallback-open')
  })

  it('wires backdrop-click to close', () => {
    const js = modalRuntimeScriptBody()
    expect(js).toContain('DIALOG')
    expect(js).toContain('getBoundingClientRect')
  })

  it('focuses the type-to-confirm input when present', () => {
    expect(modalRuntimeScriptBody()).toContain('.gbox-modal-input')
  })
})

describe('modalCss', () => {
  it('defines the root .gbox-modal class', () => {
    expect(modalCss()).toContain('.gbox-modal ')
  })

  it('defines all three size variants', () => {
    const css = modalCss()
    expect(css).toContain('.gbox-modal-sm')
    expect(css).toContain('.gbox-modal-md')
    expect(css).toContain('.gbox-modal-lg')
  })

  it('styles the ::backdrop', () => {
    expect(modalCss()).toContain('::backdrop')
  })

  it('defines primary/secondary/danger button variants', () => {
    const css = modalCss()
    expect(css).toContain('.gbox-modal-btn-primary')
    expect(css).toContain('.gbox-modal-btn-secondary')
    expect(css).toContain('.gbox-modal-btn-danger')
  })

  it('uses theme CSS vars so it adapts to dark/light', () => {
    const css = modalCss()
    expect(css).toContain('var(--god-surface')
    expect(css).toContain('var(--god-text')
  })

  it('has :focus-visible outlines for keyboard users', () => {
    expect(modalCss()).toContain(':focus-visible')
  })

  it('class names stay in sync with modal() output', () => {
    const html = modal({
      id: 'demo',
      title: 'Hi',
      description: 'desc',
      body: '<p>b</p>',
      actions: [{ label: 'Go', kind: 'primary', close: true }],
    })
    const css = modalCss()
    for (const cls of [
      'gbox-modal',
      'gbox-modal-title',
      'gbox-modal-close',
      'gbox-modal-body',
      'gbox-modal-description',
      'gbox-modal-actions',
      'gbox-modal-btn',
      'gbox-modal-btn-primary',
    ]) {
      expect(html).toContain(cls)
      expect(css).toContain(cls)
    }
  })
})
