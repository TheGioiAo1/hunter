/**
 * Tests for the keyboard module (Phase 2 Step 2.6).
 *
 * These tests cover the server-side pieces of the command palette +
 * keyboard shortcut system: the fuzzy filter, HTML rendering, and
 * runtime script body generation. The DOM-mutation parts of the
 * runtime are smoke-tested via string-content checks only (we don't
 * spin up a DOM here — that's reserved for E2E).
 */

import { describe, it, expect } from 'vitest'
import {
  filterCommands,
  commandPaletteHtml,
  keyboardShortcutsHtml,
  keyboardRuntimeScriptBody,
  keyboardCss,
  type CommandItem,
  type KeyboardShortcut,
} from './keyboard.js'

// ---------------------------------------------------------------------------
// filterCommands — fuzzy matching
// ---------------------------------------------------------------------------

describe('filterCommands', () => {
  const items: CommandItem[] = [
    { id: 'a', label: 'All products', group: 'Catalog' },
    { id: 'b', label: 'Orders', group: 'Sales' },
    { id: 'c', label: 'Customers', group: 'Sales', keywords: ['buyers', 'contacts'] },
    { id: 'd', label: 'Discounts', description: 'Create promotional codes', group: 'Marketing' },
    { id: 'e', label: 'Analytics', group: 'Insights' },
  ]

  it('returns all items in original order for an empty query', () => {
    const result = filterCommands(items, '')
    expect(result).toHaveLength(items.length)
    expect(result.map((r) => r.id)).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('returns all items for a whitespace-only query', () => {
    expect(filterCommands(items, '   ')).toHaveLength(items.length)
  })

  it('matches by label prefix (case-insensitive)', () => {
    const result = filterCommands(items, 'ord')
    expect(result[0]?.id).toBe('b')
  })

  it('matches by subsequence (non-consecutive letters)', () => {
    // "cstmr" is a subsequence of "Customers".
    const result = filterCommands(items, 'cstmr')
    expect(result.map((r) => r.id)).toContain('c')
  })

  it('matches by keyword', () => {
    // "buyers" is a keyword on customers, not in the label.
    const result = filterCommands(items, 'buyer')
    expect(result[0]?.id).toBe('c')
  })

  it('matches by description', () => {
    // "promo" is in description, not label/keywords.
    const result = filterCommands(items, 'promo')
    expect(result[0]?.id).toBe('d')
  })

  it('returns empty array when nothing matches', () => {
    expect(filterCommands(items, 'xyz123zzz')).toEqual([])
  })

  it('ranks an exact label prefix above a subsequence match', () => {
    const haystack: CommandItem[] = [
      { id: 'sub', label: 'All products' },
      { id: 'exact', label: 'Products' },
    ]
    const result = filterCommands(haystack, 'products')
    expect(result[0]?.id).toBe('exact')
  })

  it('rewards consecutive matches over scattered ones', () => {
    const haystack: CommandItem[] = [
      { id: 'scatter', label: 'Orderly acceptance' },
      { id: 'consec', label: 'Orders list' },
    ]
    const result = filterCommands(haystack, 'orders')
    expect(result[0]?.id).toBe('consec')
  })

  it('does not mutate the input array', () => {
    const before = items.map((i) => i.id)
    filterCommands(items, 'ord')
    filterCommands(items, '')
    expect(items.map((i) => i.id)).toEqual(before)
  })

  it('handles items with missing optional fields gracefully', () => {
    const bare: CommandItem[] = [{ id: 'x', label: 'Settings' }]
    expect(filterCommands(bare, 'set')).toHaveLength(1)
    expect(filterCommands(bare, 'xyz')).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// commandPaletteHtml
// ---------------------------------------------------------------------------

describe('commandPaletteHtml', () => {
  it('renders the default palette overlay', () => {
    const html = commandPaletteHtml()
    expect(html).toContain('id="gboxPalette"')
    expect(html).toContain('role="dialog"')
    expect(html).toContain('aria-modal="true"')
    expect(html).toContain('gbox-cp-hidden')
    expect(html).toContain('gbox-cp-backdrop')
    expect(html).toContain('gbox-cp-input')
    expect(html).toContain('gbox-cp-list')
    expect(html).toContain('role="listbox"')
  })

  it('respects a custom id', () => {
    const html = commandPaletteHtml({ id: 'myCmd' })
    expect(html).toContain('id="myCmd"')
    expect(html).not.toContain('id="gboxPalette"')
  })

  it('respects a custom placeholder', () => {
    const html = commandPaletteHtml({ placeholder: 'Find an action' })
    expect(html).toContain('placeholder="Find an action"')
  })

  it('respects a custom empty label', () => {
    const html = commandPaletteHtml({ emptyLabel: 'Nothing matches' })
    expect(html).toContain('Nothing matches')
  })

  it('escapes user-supplied text', () => {
    const html = commandPaletteHtml({
      placeholder: '<script>alert(1)</script>',
      emptyLabel: '<img src=x>',
    })
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).not.toContain('<img src=x>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('&lt;img')
  })

  it('includes footer navigation hints', () => {
    const html = commandPaletteHtml()
    expect(html).toContain('to navigate')
    expect(html).toContain('to select')
    expect(html).toContain('to close')
    expect(html).toContain('<kbd>Esc</kbd>')
  })

  it('starts hidden by default (gbox-cp-hidden class)', () => {
    const html = commandPaletteHtml()
    expect(html).toMatch(/gbox-cp gbox-cp-hidden/)
  })
})

// ---------------------------------------------------------------------------
// keyboardShortcutsHtml
// ---------------------------------------------------------------------------

describe('keyboardShortcutsHtml', () => {
  const shortcuts: KeyboardShortcut[] = [
    { keys: '⌘K', description: 'Open command palette', group: 'General' },
    { keys: '?', description: 'Show keyboard shortcuts', group: 'General' },
    { keys: 'g p', description: 'Go to products', group: 'Navigation' },
    { keys: 'g o', description: 'Go to orders', group: 'Navigation' },
  ]

  it('wraps everything in a gbox-ks container', () => {
    const html = keyboardShortcutsHtml(shortcuts)
    expect(html).toMatch(/^<div class="gbox-ks">/)
  })

  it('groups shortcuts by section', () => {
    const html = keyboardShortcutsHtml(shortcuts)
    expect(html).toContain('General')
    expect(html).toContain('Navigation')
    // Two groups, two titles.
    expect(html.match(/gbox-ks-group-title/g)?.length).toBe(2)
  })

  it('renders every shortcut description', () => {
    const html = keyboardShortcutsHtml(shortcuts)
    for (const s of shortcuts) {
      expect(html).toContain(s.description)
    }
  })

  it('splits multi-key combos like "g p" into separate <kbd> pills', () => {
    const html = keyboardShortcutsHtml([
      { keys: 'g p', description: 'Go to products', group: 'Nav' },
    ])
    // "g" and "p" should each get their own kbd.
    const kbdCount = (html.match(/<kbd>/g) ?? []).length
    expect(kbdCount).toBe(2)
    expect(html).toContain('<kbd>g</kbd>')
    expect(html).toContain('<kbd>p</kbd>')
  })

  it('defaults to "General" when no group is provided', () => {
    const html = keyboardShortcutsHtml([
      { keys: '⌘S', description: 'Save' },
    ])
    expect(html).toContain('General')
  })

  it('escapes user-supplied text', () => {
    const html = keyboardShortcutsHtml([
      { keys: '<x>', description: '<script>alert(1)</script>', group: '<g>' },
    ])
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('&lt;x&gt;')
    expect(html).toContain('&lt;g&gt;')
  })

  it('handles an empty shortcut list', () => {
    const html = keyboardShortcutsHtml([])
    expect(html).toBe('<div class="gbox-ks"></div>')
  })
})

// ---------------------------------------------------------------------------
// keyboardRuntimeScriptBody
// ---------------------------------------------------------------------------

describe('keyboardRuntimeScriptBody', () => {
  const commands: CommandItem[] = [
    { id: 'home', label: 'Dashboard', href: '/god-admin' },
    { id: 'stores', label: 'Stores', href: '/god-admin/stores' },
  ]

  it('serializes the commands array into the script body', () => {
    const body = keyboardRuntimeScriptBody({ commands })
    expect(body).toContain('"Dashboard"')
    expect(body).toContain('"Stores"')
    expect(body).toContain('"/god-admin/stores"')
  })

  it('wraps itself in an IIFE', () => {
    const body = keyboardRuntimeScriptBody({ commands })
    expect(body).toMatch(/\(function\(\)\s*\{/)
    expect(body).toMatch(/\}\)\(\);\s*$/)
  })

  it('wires Cmd+K / Ctrl+K to toggle the palette', () => {
    const body = keyboardRuntimeScriptBody({ commands })
    expect(body).toContain('metaKey')
    expect(body).toContain('ctrlKey')
    // Keyboard event checks the lowercase key.
    expect(body).toMatch(/key === 'k'/)
  })

  it('wires Escape to close the palette', () => {
    const body = keyboardRuntimeScriptBody({ commands })
    expect(body).toContain("'Escape'")
    expect(body).toContain('closePalette')
  })

  it('wires ArrowUp and ArrowDown for selection', () => {
    const body = keyboardRuntimeScriptBody({ commands })
    expect(body).toContain("'ArrowDown'")
    expect(body).toContain("'ArrowUp'")
  })

  it('exposes window.gboxOpenPalette / gboxClosePalette', () => {
    const body = keyboardRuntimeScriptBody({ commands })
    expect(body).toContain('window.gboxOpenPalette')
    expect(body).toContain('window.gboxClosePalette')
  })

  it('uses the custom palette id when provided', () => {
    const body = keyboardRuntimeScriptBody({ commands, paletteId: 'myPal' })
    expect(body).toContain('"myPal"')
  })

  it('wires the ? shortcut only when shortcutsModalId is supplied', () => {
    const withModal = keyboardRuntimeScriptBody({
      commands,
      shortcutsModalId: 'gboxShortcuts',
    })
    expect(withModal).toContain('"gboxShortcuts"')
    expect(withModal).toContain("'?'")
    expect(withModal).toContain('gboxOpenModal')

    const without = keyboardRuntimeScriptBody({ commands })
    // Still contains the guard, but the value is an empty string.
    expect(without).toContain('SHORTCUTS_MODAL_ID = ""')
  })

  it('serializes goToBindings into the script body', () => {
    const body = keyboardRuntimeScriptBody({
      commands,
      goToBindings: { p: '/products', o: '/orders' },
    })
    expect(body).toContain('"/products"')
    expect(body).toContain('"/orders"')
    expect(body).toMatch(/BINDINGS = \{/)
  })

  it('defaults goToBindings to an empty object', () => {
    const body = keyboardRuntimeScriptBody({ commands })
    expect(body).toContain('BINDINGS = {}')
  })

  it('neutralizes closing </script> sequences in serialized data', () => {
    const hostile: CommandItem[] = [
      { id: 'x', label: '</script><script>alert(1)</script>' },
    ]
    const body = keyboardRuntimeScriptBody({ commands: hostile })
    // The raw closing tag must not appear literally — every '<'
    // should be escaped as \u003c inside the JSON literal.
    expect(body).not.toMatch(/<\/script>/)
    expect(body).toContain('\\u003c/script>')
  })

  it('does not interpolate the commands array as a raw HTML string', () => {
    const body = keyboardRuntimeScriptBody({ commands })
    // The commands array is embedded as a JS literal, not rendered to
    // HTML — so label text should be inside double quotes.
    expect(body).toContain('"Dashboard"')
  })

  it('handles an empty command list', () => {
    const body = keyboardRuntimeScriptBody({ commands: [] })
    expect(body).toContain('COMMANDS = []')
  })

  it('implements fuzzy matching client-side (mirrors server)', () => {
    const body = keyboardRuntimeScriptBody({ commands })
    expect(body).toContain('scoreFuzzy')
    expect(body).toContain('filterCmds')
  })

  it('fires a gbox:command CustomEvent for action-only commands', () => {
    const body = keyboardRuntimeScriptBody({ commands })
    expect(body).toContain("'gbox:command'")
    expect(body).toContain('CustomEvent')
  })

  // -------------------------------------------------------------------------
  // Phase G4 — scoped chords + single-key shortcuts
  // (g l, n, c p, c d for the clone-pro dashboard)
  // -------------------------------------------------------------------------

  it('accepts a goToBindings entry for clone-pro (g l)', () => {
    const body = keyboardRuntimeScriptBody({
      commands,
      goToBindings: { l: '/admin/store/acme/clone-pro' },
    })
    expect(body).toContain('"/admin/store/acme/clone-pro"')
  })

  it('serializes multi-key chord bindings into the runtime', () => {
    const body = keyboardRuntimeScriptBody({
      commands,
      chords: [
        { keys: 'c p', scope: 'clone-pro-detail', action: 'clone-pro:copy-config' },
        { keys: 'c d', scope: 'clone-pro-detail', href: '/admin/store/acme/clone-pro/job-123/report.txt' },
      ],
    })
    expect(body).toContain('CHORDS = ')
    // Both chords should make it through as objects; scope + action/href
    // survive the JSON round-trip.
    expect(body).toContain('"c p"')
    expect(body).toContain('"c d"')
    expect(body).toContain('"clone-pro-detail"')
    expect(body).toContain('"clone-pro:copy-config"')
    expect(body).toContain('"/admin/store/acme/clone-pro/job-123/report.txt"')
  })

  it('defaults the chord list to an empty array when not provided', () => {
    const body = keyboardRuntimeScriptBody({ commands })
    expect(body).toContain('CHORDS = []')
  })

  it('serializes single-key shortcut bindings into the runtime', () => {
    const body = keyboardRuntimeScriptBody({
      commands,
      singleKeys: [
        { key: 'n', scope: 'clone-pro-index', action: 'clone-pro:new' },
      ],
    })
    expect(body).toContain('SINGLE_KEYS = ')
    expect(body).toContain('"clone-pro-index"')
    expect(body).toContain('"clone-pro:new"')
  })

  it('defaults the single-key list to an empty array when not provided', () => {
    const body = keyboardRuntimeScriptBody({ commands })
    expect(body).toContain('SINGLE_KEYS = []')
  })

  it('reads scope from document.body[data-kbd-scope] so shortcuts are page-aware', () => {
    const body = keyboardRuntimeScriptBody({
      commands,
      chords: [{ keys: 'c p', scope: 'clone-pro-detail', action: 'clone-pro:copy-config' }],
    })
    // The runtime must consult body's data attribute to decide whether
    // a scoped chord applies — otherwise `c p` fires on every page.
    expect(body).toContain('data-kbd-scope')
  })

  it('exposes the scoped-action path via the gbox:command CustomEvent', () => {
    // When a chord has `action` instead of `href`, the runtime should
    // dispatch the same `gbox:command` event the command palette uses
    // so pages can listen without a second handler.
    const body = keyboardRuntimeScriptBody({
      commands,
      chords: [{ keys: 'c p', scope: 'clone-pro-detail', action: 'clone-pro:copy-config' }],
    })
    // The handler must fire gbox:command on action chords. The string
    // 'gbox:command' already appears for the palette path; we just want
    // to make sure the chord code reaches the same dispatcher.
    expect(body).toMatch(/gbox:command[\s\S]*action/)
  })
})

// ---------------------------------------------------------------------------
// keyboardCss
// ---------------------------------------------------------------------------

describe('keyboardCss', () => {
  it('defines the core command palette classes', () => {
    const css = keyboardCss()
    expect(css).toContain('.gbox-cp ')
    expect(css).toContain('.gbox-cp-hidden')
    expect(css).toContain('.gbox-cp-backdrop')
    expect(css).toContain('.gbox-cp-panel')
    expect(css).toContain('.gbox-cp-input')
    expect(css).toContain('.gbox-cp-list')
    expect(css).toContain('.gbox-cp-item')
    expect(css).toContain('.gbox-cp-item-active')
    expect(css).toContain('.gbox-cp-empty')
    expect(css).toContain('.gbox-cp-footer')
  })

  it('defines the cheatsheet classes', () => {
    const css = keyboardCss()
    expect(css).toContain('.gbox-ks ')
    expect(css).toContain('.gbox-ks-group')
    expect(css).toContain('.gbox-ks-group-title')
    expect(css).toContain('.gbox-ks-row')
    expect(css).toContain('.gbox-ks-desc')
    expect(css).toContain('.gbox-ks-keys')
  })

  it('uses theme CSS variables (no hard-coded colors only)', () => {
    const css = keyboardCss()
    expect(css).toContain('var(--god-surface')
    expect(css).toContain('var(--god-text')
    expect(css).toContain('var(--god-border')
  })

  it('hides the palette via display:none when .gbox-cp-hidden is set', () => {
    const css = keyboardCss()
    expect(css).toMatch(/\.gbox-cp-hidden\s*\{\s*display:\s*none;\s*\}/)
  })

  it('positions the palette as a fixed overlay', () => {
    const css = keyboardCss()
    expect(css).toMatch(/\.gbox-cp\s*\{[\s\S]*?position:\s*fixed/)
  })
})
