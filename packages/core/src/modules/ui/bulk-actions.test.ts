/**
 * Tests for the shared bulk-actions module (Phase 2 Step 2.4).
 */

import { describe, it, expect } from 'vitest'
import {
  bulkCheckbox,
  bulkHeaderCheckbox,
  bulkActionBar,
  bulkRuntimeScriptBody,
  bulkActionsCss,
} from './bulk-actions.js'

describe('bulkCheckbox', () => {
  it('renders an <input type="checkbox"> with the gbox-bulk-row class', () => {
    const html = bulkCheckbox({ rowId: 'user-123' })
    expect(html).toContain('type="checkbox"')
    expect(html).toContain('gbox-bulk-row')
  })

  it('stores the row id in data-row-id', () => {
    const html = bulkCheckbox({ rowId: 'user-123' })
    expect(html).toContain('data-row-id="user-123"')
  })

  it('defaults the aria-label to "Select row"', () => {
    const html = bulkCheckbox({ rowId: 'x' })
    expect(html).toContain('aria-label="Select row"')
  })

  it('honors a custom aria-label', () => {
    const html = bulkCheckbox({ rowId: 'x', ariaLabel: 'Select Thai Bui' })
    expect(html).toContain('aria-label="Select Thai Bui"')
  })

  it('appends a custom className', () => {
    const html = bulkCheckbox({ rowId: 'x', className: 'extra-cls' })
    expect(html).toContain('extra-cls')
  })

  it('HTML-escapes the row id', () => {
    const html = bulkCheckbox({ rowId: '"><script>alert(1)</script>' })
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;')
  })
})

describe('bulkHeaderCheckbox', () => {
  it('renders an <input type="checkbox"> with the gbox-bulk-all class', () => {
    const html = bulkHeaderCheckbox()
    expect(html).toContain('type="checkbox"')
    expect(html).toContain('gbox-bulk-all')
  })

  it('defaults the aria-label to "Select all rows"', () => {
    const html = bulkHeaderCheckbox()
    expect(html).toContain('aria-label="Select all rows"')
  })

  it('honors a custom aria-label', () => {
    const html = bulkHeaderCheckbox('Toggle all users')
    expect(html).toContain('aria-label="Toggle all users"')
  })
})

describe('bulkActionBar', () => {
  const basicActions = [
    { id: 'activate', label: 'Activate', kind: 'primary' as const },
    { id: 'suspend', label: 'Suspend' },
    {
      id: 'delete',
      label: 'Delete',
      kind: 'danger' as const,
      confirmModalId: 'confirmDeleteModal',
    },
  ]

  it('renders a root <div> with gbox-bulk-bar class', () => {
    const html = bulkActionBar({ formId: 'myForm', actions: basicActions })
    expect(html).toContain('gbox-bulk-bar')
  })

  it('is hidden by default (gbox-bulk-bar-hidden class)', () => {
    const html = bulkActionBar({ formId: 'myForm', actions: basicActions })
    expect(html).toContain('gbox-bulk-bar-hidden')
  })

  it('is visible when showWhenEmpty is true', () => {
    const html = bulkActionBar({
      formId: 'myForm',
      actions: basicActions,
      showWhenEmpty: true,
    })
    expect(html).not.toContain('gbox-bulk-bar-hidden')
  })

  it('has role="toolbar" and aria-label for a11y', () => {
    const html = bulkActionBar({ formId: 'myForm', actions: basicActions })
    expect(html).toContain('role="toolbar"')
    expect(html).toContain('aria-label="Bulk actions"')
  })

  it('renders the count badge with 0 initial', () => {
    const html = bulkActionBar({ formId: 'myForm', actions: basicActions })
    expect(html).toContain('gbox-bulk-count-number')
    expect(html).toContain('>0<')
    expect(html).toContain('selected')
  })

  it('renders a Clear selection button', () => {
    const html = bulkActionBar({ formId: 'myForm', actions: basicActions })
    expect(html).toContain('Clear selection')
    expect(html).toContain('gboxBulkClear()')
  })

  it('renders one <button> per action', () => {
    const html = bulkActionBar({ formId: 'myForm', actions: basicActions })
    const buttons = html.match(/<button[^>]*type="submit"/g) ?? []
    expect(buttons.length).toBe(3)
  })

  it('each action button points at the correct form via form attribute', () => {
    const html = bulkActionBar({ formId: 'myForm', actions: basicActions })
    expect(html).toContain('form="myForm"')
  })

  it('each action button uses name="action" and the action id as value', () => {
    const html = bulkActionBar({ formId: 'myForm', actions: basicActions })
    expect(html).toContain('name="action"')
    expect(html).toContain('value="activate"')
    expect(html).toContain('value="suspend"')
    expect(html).toContain('value="delete"')
  })

  it('primary actions get gbox-bulk-btn-primary class', () => {
    const html = bulkActionBar({ formId: 'myForm', actions: basicActions })
    expect(html).toContain('gbox-bulk-btn-primary')
  })

  it('danger actions get gbox-bulk-btn-danger class', () => {
    const html = bulkActionBar({ formId: 'myForm', actions: basicActions })
    expect(html).toContain('gbox-bulk-btn-danger')
  })

  it('default kind falls back to gbox-bulk-btn-default', () => {
    const html = bulkActionBar({ formId: 'myForm', actions: basicActions })
    expect(html).toContain('gbox-bulk-btn-default')
  })

  it('honors the disabled flag', () => {
    const html = bulkActionBar({
      formId: 'myForm',
      actions: [{ id: 'x', label: 'X', disabled: true }],
    })
    expect(html).toContain('disabled')
  })

  it('wires data-confirm-modal for actions with confirmModalId', () => {
    const html = bulkActionBar({ formId: 'myForm', actions: basicActions })
    expect(html).toContain('data-confirm-modal="confirmDeleteModal"')
  })

  it('renders the optional icon before the label', () => {
    const html = bulkActionBar({
      formId: 'myForm',
      actions: [{ id: 'x', label: 'X', icon: '<svg></svg>' }],
    })
    expect(html).toContain('gbox-bulk-btn-icon')
    expect(html).toContain('<svg></svg>')
  })

  it('HTML-escapes labels to prevent XSS', () => {
    const html = bulkActionBar({
      formId: 'myForm',
      actions: [{ id: 'x', label: '<script>alert(1)</script>' }],
    })
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('appends a custom className to the root', () => {
    const html = bulkActionBar({
      formId: 'myForm',
      actions: basicActions,
      className: 'extra-wrap',
    })
    expect(html).toContain('extra-wrap')
  })
})

describe('bulkRuntimeScriptBody', () => {
  const script = bulkRuntimeScriptBody()

  it('defines window.gboxBulkClear', () => {
    expect(script).toContain('window.gboxBulkClear')
  })

  it('queries rows via .gbox-bulk-row', () => {
    expect(script).toContain('.gbox-bulk-row')
  })

  it('queries the header checkbox via .gbox-bulk-all', () => {
    expect(script).toContain('.gbox-bulk-all')
  })

  it('toggles the gbox-bulk-bar-hidden class based on count', () => {
    expect(script).toContain('gbox-bulk-bar-hidden')
  })

  it('handles the indeterminate state for the header checkbox', () => {
    expect(script).toContain('indeterminate')
  })

  it('serializes ids into a hidden input named "ids"', () => {
    expect(script).toContain('name = \'ids\'')
    expect(script).toContain('type = \'hidden\'')
  })

  it('reads row ids from data-row-id', () => {
    expect(script).toContain('data-row-id')
  })

  it('opens the confirm modal via window.gboxOpenModal when data-confirm-modal is set', () => {
    expect(script).toContain('data-confirm-modal')
    expect(script).toContain('gboxOpenModal')
  })

  it('injects the selected count into [data-bulk-count] nodes in the modal', () => {
    expect(script).toContain('data-bulk-count')
    expect(script).toContain('textContent')
  })

  it('wires a DOMContentLoaded listener to sync the bar on load', () => {
    expect(script).toContain('DOMContentLoaded')
  })

  it('is self-contained inside an IIFE', () => {
    expect(script).toContain('(function()')
  })
})

describe('bulkActionsCss', () => {
  const css = bulkActionsCss()

  it('defines .gbox-bulk-bar', () => {
    expect(css).toContain('.gbox-bulk-bar')
  })

  it('defines the hidden state class', () => {
    expect(css).toContain('.gbox-bulk-bar-hidden')
  })

  it('defines all three button kind classes', () => {
    expect(css).toContain('.gbox-bulk-btn-primary')
    expect(css).toContain('.gbox-bulk-btn-danger')
    expect(css).toContain('.gbox-bulk-btn ')
  })

  it('uses theme CSS vars for dark/light adaption', () => {
    expect(css).toContain('var(--god-accent')
    expect(css).toContain('var(--god-border')
    expect(css).toContain('var(--god-text')
  })

  it('has focus-visible outlines for a11y', () => {
    expect(css).toContain(':focus-visible')
  })

  it('uses sticky positioning so the bar floats at the bottom', () => {
    expect(css).toContain('position: sticky')
    expect(css).toContain('bottom: 0')
  })

  it('uses transform for the hide animation (GPU-composited)', () => {
    expect(css).toContain('transform')
    expect(css).toContain('translateY')
  })
})
