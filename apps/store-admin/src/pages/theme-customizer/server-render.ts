/**
 * Theme Customizer — Server-side rendered shell
 *
 * PR1 scope: returns a single HTML document that bootstraps the
 * customizer SPA. The 3-pane CSS grid + inline client JS module
 * lives in this file (vanilla TS, no bundler — matches the existing
 * theme-editor.ts pattern with its CodeMirror inline scripts).
 *
 * Subsequent PRs append more behaviour to CLIENT_JS (PR2 right-panel
 * forms, PR3 mutations + drag-drop via Sortable.js, PR4 inspector
 * postMessage, etc.). When CLIENT_JS exceeds ~600 lines we'll split
 * into per-feature modules and load them via <script type="module">.
 *
 * Iron Rule 5: every dynamic value passes through `esc()` before
 * landing in the HTML response. Theme + store names + slug never reach
 * the page raw.
 */

import { sellerLayout, esc } from '../../layouts/seller-layout.js'
import type { Request } from 'express'

interface RenderShellInput {
  store: NonNullable<Request['store']>
  user: NonNullable<Request['storeUser']>
  theme: any // returned by getTheme()
  currentTemplate: string
  base: string
  csrfToken: string
  pageTheme: 'light' | 'dark' | string
}

export function renderShell(input: RenderShellInput): string {
  const { store, user, theme, currentTemplate, base, csrfToken, pageTheme } = input

  const themeName = (theme.name as string | undefined) ?? 'Untitled theme'
  const themeRole = (theme.role as string | undefined) ?? 'unpublished'
  const themeId = theme.id as string

  const bootstrapJson = JSON.stringify({
    themeId,
    storeSlug: store.slug,
    currentTemplate,
    csrfToken,
  })

  // Templates the seller can switch between in the top bar. PR1 hard-codes
  // the canonical Shopify template list; PR8 will read from
  // `theme_page_sections.page_type DISTINCT` so themes that ship custom
  // templates (e.g. landing pages) appear automatically.
  const TEMPLATE_OPTIONS = [
    { value: 'index', label: 'Home page' },
    { value: 'product', label: 'Product page' },
    { value: 'collection', label: 'Collection page' },
    { value: 'cart', label: 'Cart' },
    { value: 'page', label: 'Static page' },
  ]

  const body = `
<div class="tc-app" data-theme-id="${esc(themeId)}" data-store-slug="${esc(store.slug)}">

  <header class="tc-topbar">
    <div class="tc-topbar-left">
      <a class="tc-back" href="${esc(base)}/online-store/themes" title="Back to themes">←</a>
      <div class="tc-theme-info">
        <span class="tc-theme-name">${esc(themeName)}</span>
        <span class="tc-theme-role tc-role-${esc(themeRole)}">${esc(themeRole)}</span>
      </div>
    </div>

    <div class="tc-topbar-center">
      <label class="tc-template-picker">
        <span class="tc-label">Template</span>
        <select id="tc-template-select" aria-label="Choose template">
          ${TEMPLATE_OPTIONS.map((t) => `
            <option value="${esc(t.value)}"${t.value === currentTemplate ? ' selected' : ''}>
              ${esc(t.label)}
            </option>
          `).join('')}
        </select>
      </label>
    </div>

    <div class="tc-topbar-right">
      <span class="tc-viewport-toggle" role="group" aria-label="Preview viewport">
        <button type="button" data-viewport="375" title="Mobile (375px)">📱</button>
        <button type="button" data-viewport="768" title="Tablet (768px)">📱</button>
        <button type="button" data-viewport="1280" class="active" title="Desktop (1280px)">💻</button>
      </span>
      <button class="tc-btn tc-btn-secondary" id="tc-undo" disabled title="Undo">↶</button>
      <button class="tc-btn tc-btn-secondary" id="tc-redo" disabled title="Redo">↷</button>
      <button class="tc-btn tc-btn-secondary" id="tc-save" disabled title="Save changes">Save</button>
      <button class="tc-btn tc-btn-primary" id="tc-publish" disabled title="Publish coming in Sprint 10">Publish</button>
    </div>
  </header>

  <main class="tc-grid">

    <aside class="tc-sidebar" aria-label="Sections list">
      <div class="tc-sidebar-header">
        <span>Sections</span>
        <button class="tc-icon-btn" id="tc-add-section" title="Add section">+</button>
      </div>
      <nav class="tc-section-tree" id="tc-section-tree">
        <div class="tc-empty-state">Loading sections…</div>
      </nav>
      <div class="tc-sidebar-footer">
        <small class="tc-hint">Click a section to inspect (settings panel arrives in PR2).</small>
      </div>
    </aside>

    <div class="tc-preview" data-viewport="1280">
      <div class="tc-preview-frame">
        <iframe
          id="tc-preview-iframe"
          title="Storefront preview"
          loading="lazy"
          src="about:blank"
          referrerpolicy="no-referrer-when-downgrade"
        ></iframe>
      </div>
    </div>

    <aside class="tc-rightpanel" aria-label="Section settings" id="tc-rightpanel">
      <div class="tc-rightpanel-empty">
        <div class="tc-empty-icon">⚙️</div>
        <div class="tc-empty-title">Select a section</div>
        <div class="tc-empty-hint">
          Click any section in the left panel to edit its settings.
        </div>
      </div>
    </aside>

  </main>
</div>

${THEME_CUSTOMIZER_STYLES}

<script type="module">
${THEME_CUSTOMIZER_CLIENT_JS}

// Bootstrap with the server-issued config blob.
window.__bootstrapThemeCustomizer(${bootstrapJson});
</script>
`

  return sellerLayout({
    title: `Customize · ${themeName}`,
    storeName: store.name,
    storeSlug: store.slug,
    userName: user.name,
    userEmail: user.email,
    userRole: user.role,
    storeRole: user.storeRole,
    activePage: 'online-store',
    content: body,
    theme: pageTheme as any,
  })
}

// ---------------------------------------------------------------------------
// Inline CSS — kept in this file so the shell ships as a single SSR doc.
// Grid layout: top bar (auto) + main row (1fr). Main row = sidebar (300px) +
// preview (1fr) + right panel (340px). Mobile collapses sidebar/right panel
// into drawers (PR8).
// ---------------------------------------------------------------------------

const THEME_CUSTOMIZER_STYLES = `
<style>
  /* Theme Customizer — uses canonical --s-* tokens from seller-layout.
     Both light + dark modes inherit automatically; do NOT hard-code hex
     here unless the value is mode-agnostic (e.g. white-on-accent badge). */
  .tc-app {
    display: flex;
    flex-direction: column;
    height: calc(100vh - 56px); /* leaves room for the global admin top bar */
    background: var(--s-bg);
    color: var(--s-text);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  }

  .tc-topbar {
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    align-items: center;
    gap: 16px;
    padding: 8px 16px;
    background: var(--s-card);
    border-bottom: 1px solid var(--s-border);
    flex-shrink: 0;
  }
  .tc-topbar-left { display: flex; align-items: center; gap: 12px; }
  .tc-topbar-center { justify-self: center; }
  .tc-topbar-right { display: flex; align-items: center; gap: 8px; justify-self: end; }

  .tc-back {
    display: inline-flex; align-items: center; justify-content: center;
    width: 32px; height: 32px; border-radius: 6px;
    background: var(--s-card-hover); color: var(--s-text); text-decoration: none;
    font-size: 16px;
  }
  .tc-back:hover { background: var(--s-border-light); }

  .tc-theme-info { display: flex; flex-direction: column; line-height: 1.2; }
  .tc-theme-name { font-weight: 600; font-size: 14px; color: var(--s-text); }
  .tc-theme-role {
    align-self: flex-start;
    font-size: 11px; padding: 2px 6px; border-radius: 4px;
    background: rgba(245,158,11,.18); color: var(--s-warning);
    text-transform: uppercase; letter-spacing: 0.5px;
  }
  .tc-role-main { background: rgba(34,197,94,.18); color: var(--s-success); }
  .tc-role-archived { background: var(--s-card-hover); color: var(--s-text-muted); }

  .tc-template-picker { display: inline-flex; align-items: center; gap: 8px; }
  .tc-template-picker .tc-label { font-size: 12px; color: var(--s-text-muted); }
  .tc-template-picker select {
    padding: 6px 10px; border: 1px solid var(--s-input-border, var(--s-border)); border-radius: 6px;
    background: var(--s-input-bg, var(--s-card)); color: var(--s-text);
    font-size: 13px; min-width: 160px;
  }

  .tc-viewport-toggle {
    display: inline-flex; gap: 4px; padding: 4px;
    background: var(--s-card-hover); border-radius: 6px;
  }
  .tc-viewport-toggle button {
    background: transparent; border: none; padding: 4px 8px; border-radius: 4px;
    cursor: pointer; font-size: 14px; color: var(--s-text);
  }
  .tc-viewport-toggle button.active {
    background: var(--s-card); box-shadow: 0 1px 2px rgba(0,0,0,.1);
  }

  .tc-btn {
    padding: 6px 14px; border-radius: 6px; border: 1px solid transparent;
    font-size: 13px; font-weight: 500; cursor: pointer; transition: all .1s ease;
  }
  .tc-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .tc-btn-secondary {
    background: var(--s-card); border-color: var(--s-border-light, var(--s-border));
    color: var(--s-text);
  }
  .tc-btn-secondary:not(:disabled):hover { background: var(--s-card-hover); }
  .tc-btn-primary { background: var(--s-accent); color: #fff; }
  .tc-btn-primary:not(:disabled):hover { background: var(--s-accent-hover); }

  .tc-icon-btn {
    width: 24px; height: 24px; border-radius: 4px; border: none;
    background: transparent; cursor: pointer; font-size: 16px; line-height: 1;
    color: var(--s-text);
  }
  .tc-icon-btn:not(:disabled):hover { background: var(--s-card-hover); }

  .tc-grid {
    display: grid;
    grid-template-columns: 300px 1fr 340px;
    gap: 0;
    flex: 1;
    overflow: hidden;
  }

  .tc-sidebar, .tc-rightpanel {
    background: var(--s-card);
    overflow-y: auto;
    display: flex; flex-direction: column;
  }
  .tc-sidebar { border-right: 1px solid var(--s-border); }
  .tc-rightpanel { border-left: 1px solid var(--s-border); }

  .tc-sidebar-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 12px 16px; border-bottom: 1px solid var(--s-border);
    font-weight: 600; font-size: 13px; text-transform: uppercase; letter-spacing: 0.5px;
    color: var(--s-text-muted);
  }
  .tc-sidebar-footer {
    padding: 12px 16px; border-top: 1px solid var(--s-border);
    margin-top: auto;
  }
  .tc-hint { color: var(--s-text-dim); font-size: 11px; line-height: 1.4; }

  .tc-section-tree { padding: 8px; flex: 1; }
  .tc-section-item {
    display: flex; align-items: center; gap: 8px;
    padding: 8px 12px; border-radius: 6px; cursor: pointer;
    user-select: none; font-size: 13px;
    color: var(--s-text);
    transition: background .1s;
  }
  .tc-section-item:hover { background: var(--s-card-hover); }
  .tc-section-item.selected {
    background: rgba(99,102,241,.18); color: var(--s-accent); font-weight: 500;
  }
  .tc-section-item.hidden-section { opacity: 0.55; }
  .tc-section-item .tc-icon { font-size: 14px; opacity: 0.7; }
  .tc-section-item .tc-name { flex: 1; }
  .tc-section-item .tc-block-count {
    font-size: 11px; padding: 1px 6px; border-radius: 10px;
    background: var(--s-card-hover); color: var(--s-text-muted);
  }
  .tc-section-item .tc-hidden {
    font-size: 10px; padding: 1px 5px; border-radius: 3px;
    background: rgba(239,68,68,.18); color: var(--s-danger);
  }

  .tc-empty-state {
    padding: 16px; text-align: center; color: var(--s-text-dim); font-size: 12px;
  }

  .tc-preview {
    /* Page-bg colour around the iframe matches the global page surface so
       the iframe sits visually on the same plane as the rest of the admin. */
    background: var(--s-bg);
    display: flex; align-items: stretch; justify-content: center;
    padding: 16px;
    overflow: auto;
  }
  .tc-preview-frame {
    width: 100%; max-width: 100%;
    /* Storefront previews itself sets its own bg — we keep this neutral
       so the iframe content sits on a card-coloured plate while loading. */
    background: var(--s-card);
    box-shadow: 0 1px 3px rgba(0,0,0,.18);
    transition: max-width .2s ease;
  }
  .tc-preview[data-viewport="375"] .tc-preview-frame { max-width: 375px; }
  .tc-preview[data-viewport="768"] .tc-preview-frame { max-width: 768px; }
  .tc-preview[data-viewport="1280"] .tc-preview-frame { max-width: 1280px; }
  .tc-preview iframe {
    width: 100%; height: 100%; border: none; display: block;
    min-height: 600px;
  }

  .tc-rightpanel-empty {
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    height: 100%; padding: 24px; text-align: center; color: var(--s-text-muted);
  }
  .tc-empty-icon { font-size: 32px; margin-bottom: 12px; }
  .tc-empty-title { font-weight: 600; margin-bottom: 6px; color: var(--s-text); }
  .tc-empty-hint { font-size: 12px; line-height: 1.5; max-width: 240px; }

  /* Right-panel settings form (Sprint 8 PR-C). 2026-04-27 — switched
     from hardcoded light hex (#fff / #f3f4f6 / #111827 …) to the same
     --s-* design tokens the rest of the seller dashboard uses. Without
     this, dark-mode users saw white form fields + white modals on a
     dark page (the bug Thai surfaced). Now both modes inherit
     automatically from the cascade defined at the top of this stylesheet. */
  .tc-form { padding: 16px; display: flex; flex-direction: column; gap: 12px; }
  .tc-form-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 12px 16px; border-bottom: 1px solid var(--s-border);
  }
  .tc-form-title { font-weight: 600; font-size: 14px; color: var(--s-text); }
  .tc-form-close {
    background: transparent; border: none; cursor: pointer; font-size: 18px;
    color: var(--s-text-muted);
    width: 24px; height: 24px; border-radius: 4px;
  }
  .tc-form-close:hover { background: var(--s-card-hover); color: var(--s-text); }
  .tc-form-row { display: flex; flex-direction: column; gap: 4px; }
  .tc-form-row label { font-size: 12px; font-weight: 500; color: var(--s-text); }
  .tc-form-row input[type=text],
  .tc-form-row input[type=number],
  .tc-form-row input[type=url],
  .tc-form-row textarea,
  .tc-form-row select {
    padding: 6px 10px;
    border: 1px solid var(--s-input-border, var(--s-border));
    border-radius: 6px;
    background: var(--s-input-bg, var(--s-card));
    color: var(--s-text);
    font-size: 13px; font-family: inherit;
    width: 100%; box-sizing: border-box;
  }
  .tc-form-row textarea { min-height: 64px; resize: vertical; }
  .tc-form-row input[type=color] {
    width: 48px; height: 28px; padding: 0;
    border: 1px solid var(--s-input-border, var(--s-border));
    border-radius: 4px; cursor: pointer; background: transparent;
  }
  .tc-form-row .tc-color-row { display: flex; align-items: center; gap: 8px; }
  .tc-form-row .tc-color-row input[type=text] { flex: 1; }
  .tc-form-row .tc-info {
    font-size: 11px; color: var(--s-text-muted); line-height: 1.4;
  }
  .tc-form-row .tc-checkbox-row { display: flex; align-items: center; gap: 8px; }
  .tc-form-row .tc-checkbox-row input[type=checkbox] { margin: 0; }
  .tc-form-row.tc-form-header-block {
    padding-top: 8px; border-top: 1px solid var(--s-border); margin-top: 8px;
  }
  .tc-form-row.tc-form-header-block .tc-form-section-name {
    font-weight: 600; font-size: 13px; color: var(--s-text);
  }
  .tc-form-row.tc-form-header-block .tc-form-section-info {
    font-size: 11px; color: var(--s-text-muted);
  }
  .tc-form-actions {
    display: flex; gap: 8px; padding: 12px 16px;
    border-top: 1px solid var(--s-border); margin-top: auto;
  }
  .tc-form-actions .tc-form-remove {
    margin-left: auto;
    background: var(--s-card); color: var(--s-danger);
    border: 1px solid var(--s-danger);
    padding: 6px 12px; border-radius: 6px; cursor: pointer; font-size: 12px;
  }
  .tc-form-actions .tc-form-remove:hover {
    background: rgba(239,68,68,.10); /* mode-agnostic: tinted danger overlay */
  }
  .tc-saving-indicator {
    font-size: 11px; color: var(--s-text-muted); padding: 4px 8px;
  }

  /* Add section dialog */
  .tc-modal-backdrop {
    position: fixed; inset: 0; background: rgba(0,0,0,.5); z-index: 1000;
    display: none; align-items: center; justify-content: center;
  }
  .tc-modal-backdrop.open { display: flex; }
  .tc-modal {
    background: var(--s-card); color: var(--s-text);
    border: 1px solid var(--s-border);
    border-radius: 10px; box-shadow: 0 8px 24px rgba(0,0,0,.35);
    width: 480px; max-width: calc(100vw - 32px); max-height: 70vh; overflow: auto;
  }
  .tc-modal-header {
    padding: 16px; border-bottom: 1px solid var(--s-border); font-weight: 600;
    color: var(--s-text);
  }
  .tc-modal-body { padding: 8px; }
  .tc-modal-list { display: flex; flex-direction: column; }
  .tc-modal-item {
    display: flex; align-items: center; gap: 10px; padding: 10px 12px;
    border-radius: 6px; cursor: pointer; font-size: 13px;
    color: var(--s-text);
  }
  .tc-modal-item:hover { background: var(--s-card-hover); }
  .tc-modal-icon { font-size: 16px; opacity: 0.7; width: 20px; }
  .tc-modal-footer {
    padding: 12px 16px; text-align: right;
    border-top: 1px solid var(--s-border);
  }
  .tc-modal-cancel {
    padding: 6px 14px; border-radius: 6px;
    border: 1px solid var(--s-input-border, var(--s-border));
    background: var(--s-card); color: var(--s-text);
    font-size: 13px; cursor: pointer;
  }
  .tc-modal-cancel:hover { background: var(--s-card-hover); }

  /* Drag handle */
  .tc-section-item .tc-drag-handle { cursor: grab; opacity: 0.4; font-size: 12px; }
  .tc-section-item.tc-dragging { opacity: 0.4; }
  .tc-section-item.tc-drag-over-top { box-shadow: inset 0 2px 0 #6366f1; }
  .tc-section-item.tc-drag-over-bottom { box-shadow: inset 0 -2px 0 #6366f1; }

  /* Mobile collapses panels into off-canvas drawers */
  @media (max-width: 1024px) {
    .tc-grid { grid-template-columns: 1fr; }
    .tc-sidebar, .tc-rightpanel { display: none; }
  }
</style>
`

// ---------------------------------------------------------------------------
// Inline client JS — vanilla TS compiled to JS at request time. Module
// scope keeps globals out of the seller-layout namespace.
// ---------------------------------------------------------------------------

const THEME_CUSTOMIZER_CLIENT_JS = `
(function() {
  'use strict'

  /**
   * Sprint 8 PR-C scope:
   *   • read-only sections tree + iframe preview (PR1)
   *   • right-panel form rendering driven by section schema
   *   • per-input mutation POST to /sections/:id/settings (debounced)
   *   • Save button gating + Save All bulk endpoint (defer to per-input
   *     for v1; Save button just toggles dirty -> clean once everything
   *     has flushed)
   *   • Add section modal + POST /sections/add
   *   • Remove section button + DELETE /sections/:id
   *   • HTML5 drag-drop reorder + POST /sections/reorder
   *   • Local undo/redo stack (in-memory, max 30)
   *
   * Save semantics: each input change debounces a settings POST. Dirty
   * flag stays true until the last debounced flush resolves. Save button
   * becomes enabled when dirty, force-flushes, then disables.
   */

  const DEBOUNCE_MS = 350
  const MAX_HISTORY = 30

  class ThemeCustomizer {
    constructor(config) {
      this.themeId = config.themeId
      this.storeSlug = config.storeSlug
      this.currentTemplate = config.currentTemplate || 'index'
      this.csrfToken = config.csrfToken || ''
      this.sections = []
      this.selectedSectionId = null
      this.activeSettings = null // SectionSettingsPayload from /schema.json
      this.pendingFlush = null   // Promise for in-flight settings POST
      this.pendingPatch = null   // accumulated patch waiting to flush
      this.flushTimer = null
      this.dirty = false
      this.history = []          // { type, before, after } stack
      this.historyIdx = -1       // points at last applied entry
    }

    async init() {
      await Promise.all([this.loadSections(), this.loadPreview()])
      this.renderSidebar()
      this.bindTopbar()
      this.bindViewport()
      this.bindSidebarActions()
    }

    apiBase() {
      return '/admin/store/' + this.storeSlug + '/themes/' + this.themeId + '/customize'
    }

    async fetchJson(path, opts) {
      const res = await fetch(this.apiBase() + path, Object.assign({
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': this.csrfToken },
      }, opts || {}))
      if (!res.ok) {
        let msg = 'request failed (' + res.status + ')'
        try { const j = await res.json(); if (j && j.error) msg = String(j.error) } catch (e) {}
        throw new Error(msg)
      }
      return res.json()
    }

    async loadSections() {
      try {
        const data = await this.fetchJson('/sections.json?template=' + encodeURIComponent(this.currentTemplate))
        this.sections = Array.isArray(data.sections) ? data.sections : []
      } catch (err) {
        console.error('[customizer] loadSections', err)
        this.sections = []
      }
    }

    async loadPreview() {
      try {
        const data = await this.fetchJson('/preview-url?template=' + encodeURIComponent(this.currentTemplate))
        const iframe = document.getElementById('tc-preview-iframe')
        if (iframe && data.url) iframe.src = data.url
      } catch (err) {
        console.error('[customizer] loadPreview', err)
      }
    }

    // ─── Sidebar ──────────────────────────────────────────────────────

    renderSidebar() {
      const tree = document.getElementById('tc-section-tree')
      if (!tree) return
      if (this.sections.length === 0) {
        tree.innerHTML = '<div class="tc-empty-state">No sections in this template yet. Click + to add one.</div>'
        return
      }
      tree.innerHTML = this.sections.map((s) => this.renderSidebarItem(s)).join('')
      tree.querySelectorAll('.tc-section-item').forEach((el) => {
        const id = el.getAttribute('data-section-id')
        if (!id) return
        el.addEventListener('click', () => this.selectSection(id))
        this.bindDragHandlers(el)
      })
    }

    renderSidebarItem(s) {
      const hiddenClass = s.enabled ? '' : ' hidden-section'
      const selectedClass = (this.selectedSectionId === s.id) ? ' selected' : ''
      return [
        '<div class="tc-section-item' + hiddenClass + selectedClass + '"',
        '     draggable="true"',
        '     data-section-id="' + escAttr(s.id) + '"',
        '     data-section-type="' + escAttr(s.type) + '">',
        '  <span class="tc-drag-handle" title="Drag to reorder">⋮⋮</span>',
        '  <span class="tc-icon">▦</span>',
        '  <span class="tc-name">' + escText(s.name) + '</span>',
        s.hasBlocks ? ('  <span class="tc-block-count">' + s.blockCount + '</span>') : '',
        !s.enabled ? '  <span class="tc-hidden">hidden</span>' : '',
        '</div>',
      ].filter(Boolean).join('')
    }

    async selectSection(id) {
      // Flush any pending settings update before switching context.
      await this.flushPending()
      this.selectedSectionId = id
      document.querySelectorAll('.tc-section-item').forEach((el) => {
        el.classList.toggle('selected', el.getAttribute('data-section-id') === id)
      })
      try {
        const payload = await this.fetchJson('/sections/' + encodeURIComponent(id) + '/schema.json')
        this.activeSettings = payload
        this.renderRightPanel(payload)
      } catch (err) {
        console.error('[customizer] selectSection', err)
        this.renderRightPanelError(err.message || 'Could not load section.')
      }
    }

    // ─── Right-panel form ─────────────────────────────────────────────

    renderRightPanel(payload) {
      const panel = document.getElementById('tc-rightpanel')
      if (!panel) return
      const schema = payload.schema
      const settings = payload.settings || {}
      const settingsRows = (schema && schema.settings) ? schema.settings : []

      const body = [
        '<div class="tc-form-header">',
        '  <span class="tc-form-title">' + escText((schema && schema.name) || payload.type) + '</span>',
        '  <button type="button" class="tc-form-close" id="tc-form-close" title="Close panel">×</button>',
        '</div>',
        '<form class="tc-form" id="tc-section-form" data-section-id="' + escAttr(payload.id) + '">',
        settingsRows.length === 0
          ? '<div class="tc-empty-state">No settings registered for this section.</div>'
          : settingsRows.map((row) => this.renderFormRow(row, settings)).join(''),
        '</form>',
        '<div class="tc-form-actions">',
        '  <span class="tc-saving-indicator" id="tc-saving-indicator"></span>',
        '  <button type="button" class="tc-form-remove" id="tc-remove-section">Remove section</button>',
        '</div>',
      ].join('')
      panel.innerHTML = body

      // Wire input change handlers (debounced patch).
      const form = panel.querySelector('#tc-section-form')
      if (form) {
        form.addEventListener('input', (e) => this.onFormInput(e))
        form.addEventListener('change', (e) => this.onFormInput(e))
      }
      const close = panel.querySelector('#tc-form-close')
      if (close) close.addEventListener('click', () => this.closeRightPanel())
      const remove = panel.querySelector('#tc-remove-section')
      if (remove) remove.addEventListener('click', () => this.confirmRemoveSection(payload.id))
    }

    renderRightPanelError(message) {
      const panel = document.getElementById('tc-rightpanel')
      if (!panel) return
      panel.innerHTML = ''
        + '<div class="tc-rightpanel-empty">'
        + '  <div class="tc-empty-icon">⚠️</div>'
        + '  <div class="tc-empty-title">Could not load section</div>'
        + '  <div class="tc-empty-hint">' + escText(message) + '</div>'
        + '</div>'
    }

    closeRightPanel() {
      this.selectedSectionId = null
      document.querySelectorAll('.tc-section-item').forEach((el) => el.classList.remove('selected'))
      const panel = document.getElementById('tc-rightpanel')
      if (!panel) return
      panel.innerHTML = ''
        + '<div class="tc-rightpanel-empty">'
        + '  <div class="tc-empty-icon">⚙️</div>'
        + '  <div class="tc-empty-title">Select a section</div>'
        + '  <div class="tc-empty-hint">Click any section in the left panel to edit its settings.</div>'
        + '</div>'
    }

    renderFormRow(row, settings) {
      const id = row.id || ''
      const value = (id in settings) ? settings[id] : (row.default !== undefined ? row.default : '')
      const label = escText(row.label || id || row.type)

      switch (row.type) {
        case 'header':
          return ''
            + '<div class="tc-form-row tc-form-header-block">'
            + '  <span class="tc-form-section-name">' + escText(row.content || row.label || '') + '</span>'
            + '</div>'
        case 'paragraph':
          return ''
            + '<div class="tc-form-row tc-form-header-block">'
            + '  <span class="tc-form-section-info">' + escText(row.content || '') + '</span>'
            + '</div>'
        case 'textarea':
        case 'richtext':
          return ''
            + '<div class="tc-form-row">'
            + '  <label for="tc-input-' + escAttr(id) + '">' + label + '</label>'
            + '  <textarea id="tc-input-' + escAttr(id) + '" name="' + escAttr(id) + '" data-setting-type="' + escAttr(row.type) + '">' + escText(value) + '</textarea>'
            + (row.info ? '  <span class="tc-info">' + escText(row.info) + '</span>' : '')
            + '</div>'
        case 'number':
        case 'range':
          return ''
            + '<div class="tc-form-row">'
            + '  <label for="tc-input-' + escAttr(id) + '">' + label + '</label>'
            + '  <input type="number" id="tc-input-' + escAttr(id) + '" name="' + escAttr(id) + '"'
            + (row.min !== undefined ? ' min="' + Number(row.min) + '"' : '')
            + (row.max !== undefined ? ' max="' + Number(row.max) + '"' : '')
            + (row.step !== undefined ? ' step="' + Number(row.step) + '"' : '')
            + ' value="' + escAttr(value) + '"'
            + ' data-setting-type="number" />'
            + (row.info ? '  <span class="tc-info">' + escText(row.info) + '</span>' : '')
            + '</div>'
        case 'checkbox':
          return ''
            + '<div class="tc-form-row">'
            + '  <div class="tc-checkbox-row">'
            + '    <input type="checkbox" id="tc-input-' + escAttr(id) + '" name="' + escAttr(id) + '"'
            + (value ? ' checked' : '')
            + ' data-setting-type="checkbox" />'
            + '    <label for="tc-input-' + escAttr(id) + '">' + label + '</label>'
            + '  </div>'
            + (row.info ? '  <span class="tc-info">' + escText(row.info) + '</span>' : '')
            + '</div>'
        case 'select':
        case 'radio': {
          const options = Array.isArray(row.options) ? row.options : []
          return ''
            + '<div class="tc-form-row">'
            + '  <label for="tc-input-' + escAttr(id) + '">' + label + '</label>'
            + '  <select id="tc-input-' + escAttr(id) + '" name="' + escAttr(id) + '" data-setting-type="select">'
            + options.map((o) => ''
                + '<option value="' + escAttr(o.value) + '"' + (String(o.value) === String(value) ? ' selected' : '') + '>'
                + escText(o.label) + '</option>'
              ).join('')
            + '  </select>'
            + (row.info ? '  <span class="tc-info">' + escText(row.info) + '</span>' : '')
            + '</div>'
        }
        case 'color':
          return ''
            + '<div class="tc-form-row">'
            + '  <label>' + label + '</label>'
            + '  <div class="tc-color-row">'
            + '    <input type="color" id="tc-input-' + escAttr(id) + '" name="' + escAttr(id) + '"'
            + ' value="' + escAttr(coerceColor(value, '#000000')) + '" data-setting-type="color" />'
            + '    <input type="text" id="tc-input-' + escAttr(id) + '-text" name="' + escAttr(id) + '__text"'
            + ' value="' + escAttr(value) + '" data-setting-type="color" data-mirror-of="' + escAttr(id) + '" />'
            + '  </div>'
            + (row.info ? '  <span class="tc-info">' + escText(row.info) + '</span>' : '')
            + '</div>'
        case 'url':
          return ''
            + '<div class="tc-form-row">'
            + '  <label for="tc-input-' + escAttr(id) + '">' + label + '</label>'
            + '  <input type="url" id="tc-input-' + escAttr(id) + '" name="' + escAttr(id) + '" value="' + escAttr(value) + '" data-setting-type="url"'
            + (row.placeholder ? ' placeholder="' + escAttr(row.placeholder) + '"' : '')
            + ' />'
            + (row.info ? '  <span class="tc-info">' + escText(row.info) + '</span>' : '')
            + '</div>'
        case 'product':
        case 'collection':
        case 'page':
        case 'blog':
        case 'article':
        case 'image_picker':
        case 'video_url':
          // Picker types fall back to a free-text input for now; Sprint 8 PR-D
          // wires the search endpoints + dropdown UI on top of this same name.
          return ''
            + '<div class="tc-form-row">'
            + '  <label for="tc-input-' + escAttr(id) + '">' + label + '</label>'
            + '  <input type="text" id="tc-input-' + escAttr(id) + '" name="' + escAttr(id) + '" value="' + escAttr(value) + '" data-setting-type="' + escAttr(row.type) + '"'
            + ' placeholder="' + escAttr(row.placeholder || pickerPlaceholder(row.type)) + '" />'
            + (row.info ? '  <span class="tc-info">' + escText(row.info) + '</span>' : '')
            + '</div>'
        default:
          return ''
            + '<div class="tc-form-row">'
            + '  <label for="tc-input-' + escAttr(id) + '">' + label + '</label>'
            + '  <input type="text" id="tc-input-' + escAttr(id) + '" name="' + escAttr(id) + '" value="' + escAttr(value) + '" data-setting-type="text"'
            + (row.placeholder ? ' placeholder="' + escAttr(row.placeholder) + '"' : '')
            + ' />'
            + (row.info ? '  <span class="tc-info">' + escText(row.info) + '</span>' : '')
            + '</div>'
      }
    }

    onFormInput(e) {
      const target = e.target
      if (!target || !target.name) return
      // Mirror text fields shadowing color pickers — when text changes, sync
      // the color swatch and write to the canonical name (no trailing __text).
      let key = target.name
      let value
      if (target.dataset.mirrorOf) {
        key = target.dataset.mirrorOf
        value = target.value
        const color = document.getElementById('tc-input-' + key)
        if (color) color.value = coerceColor(value, color.value)
      } else if (target.type === 'checkbox') {
        value = target.checked
      } else if (target.dataset.settingType === 'number' || target.dataset.settingType === 'range') {
        value = target.value === '' ? null : Number(target.value)
      } else {
        value = target.value
        if (target.dataset.settingType === 'color') {
          const mirror = document.getElementById('tc-input-' + key + '-text')
          if (mirror) mirror.value = value
        }
      }
      this.queuePatch(key, value)
    }

    queuePatch(key, value) {
      if (!this.activeSettings) return
      this.pendingPatch = Object.assign({}, this.pendingPatch || {}, { [key]: value })
      this.markDirty(true)
      this.scheduleFlush()
    }

    scheduleFlush() {
      if (this.flushTimer) clearTimeout(this.flushTimer)
      this.flushTimer = setTimeout(() => this.flushPending(), DEBOUNCE_MS)
    }

    async flushPending() {
      if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null }
      if (!this.pendingPatch || !this.activeSettings) return
      const sectionId = this.activeSettings.id
      const patch = this.pendingPatch
      this.pendingPatch = null
      const indicator = document.getElementById('tc-saving-indicator')
      if (indicator) indicator.textContent = 'Saving…'
      try {
        const before = Object.assign({}, this.activeSettings.settings || {})
        const r = await this.fetchJson('/sections/' + encodeURIComponent(sectionId) + '/settings', {
          method: 'POST',
          body: JSON.stringify({ patch }),
        })
        // Merge server-returned settings (authoritative).
        this.activeSettings.settings = r.settings || this.activeSettings.settings
        this.pushHistory({ type: 'settings', sectionId, before, after: this.activeSettings.settings })
        if (indicator) indicator.textContent = 'Saved'
        this.markDirty(false)
        this.refreshPreview()
        setTimeout(() => { if (indicator) indicator.textContent = '' }, 1500)
      } catch (err) {
        console.error('[customizer] save failed', err)
        if (indicator) indicator.textContent = 'Save failed: ' + (err.message || 'unknown')
      }
    }

    // ─── Add / remove section ─────────────────────────────────────────

    bindSidebarActions() {
      const addBtn = document.getElementById('tc-add-section')
      if (addBtn) addBtn.addEventListener('click', () => this.openAddSectionModal())
      const save = document.getElementById('tc-save')
      if (save) save.addEventListener('click', () => this.flushPending())
      const undo = document.getElementById('tc-undo')
      if (undo) undo.addEventListener('click', () => this.undo())
      const redo = document.getElementById('tc-redo')
      if (redo) redo.addEventListener('click', () => this.redo())
      // Keyboard shortcut: Cmd/Ctrl + Z = undo, Cmd/Ctrl + Shift + Z = redo
      document.addEventListener('keydown', (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
          e.preventDefault()
          if (e.shiftKey) this.redo(); else this.undo()
        }
      })
    }

    openAddSectionModal() {
      // Static catalog for now — Sprint 8 PR-D will fetch from an
      // /admin/sections-catalog endpoint that lists every registered
      // section_type for the active theme.
      const catalog = window.__themeCustomizerCatalog || DEFAULT_SECTION_CATALOG
      const backdrop = document.createElement('div')
      backdrop.className = 'tc-modal-backdrop open'
      backdrop.innerHTML = ''
        + '<div class="tc-modal" role="dialog" aria-modal="true" aria-labelledby="tc-modal-title">'
        + '  <div class="tc-modal-header" id="tc-modal-title">Add section</div>'
        + '  <div class="tc-modal-body"><div class="tc-modal-list">'
        + catalog.map((c) => ''
            + '<div class="tc-modal-item" data-section-type="' + escAttr(c.type) + '">'
            + '  <span class="tc-modal-icon">' + escText(c.icon || '▦') + '</span>'
            + '  <span class="tc-modal-name">' + escText(c.name) + '</span>'
            + '</div>'
          ).join('')
        + '  </div></div>'
        + '  <div class="tc-modal-footer"><button type="button" class="tc-modal-cancel">Cancel</button></div>'
        + '</div>'
      document.body.appendChild(backdrop)
      backdrop.addEventListener('click', (e) => {
        const cancel = e.target.closest('.tc-modal-cancel')
        const item = e.target.closest('.tc-modal-item')
        if (cancel || e.target === backdrop) {
          backdrop.remove(); return
        }
        if (item) {
          const type = item.getAttribute('data-section-type')
          backdrop.remove()
          this.addSection(type).catch((err) => alert('Could not add section: ' + (err.message || err)))
        }
      })
    }

    async addSection(type) {
      if (!type) return
      const r = await this.fetchJson('/sections/add', {
        method: 'POST',
        body: JSON.stringify({ type, template: this.currentTemplate }),
      })
      this.pushHistory({ type: 'add', sectionId: r.id, sectionType: type, position: r.position })
      await this.loadSections()
      this.renderSidebar()
      this.refreshPreview()
      this.selectSection(r.id)
    }

    async confirmRemoveSection(id) {
      if (!confirm('Remove this section? This cannot be undone in this preview.')) return
      try {
        const before = this.sections.find((s) => s.id === id) || null
        await this.fetchJson('/sections/' + encodeURIComponent(id), { method: 'DELETE' })
        this.pushHistory({ type: 'remove', sectionId: id, before })
        await this.loadSections()
        this.renderSidebar()
        this.refreshPreview()
        this.closeRightPanel()
      } catch (err) {
        alert('Could not remove section: ' + (err.message || err))
      }
    }

    // ─── Drag-drop reorder ────────────────────────────────────────────

    bindDragHandlers(el) {
      el.addEventListener('dragstart', (e) => {
        el.classList.add('tc-dragging')
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData('text/plain', el.getAttribute('data-section-id') || '')
      })
      el.addEventListener('dragend', () => {
        el.classList.remove('tc-dragging')
        document.querySelectorAll('.tc-section-item').forEach((n) => {
          n.classList.remove('tc-drag-over-top'); n.classList.remove('tc-drag-over-bottom')
        })
      })
      el.addEventListener('dragover', (e) => {
        e.preventDefault()
        const rect = el.getBoundingClientRect()
        const mid = rect.top + rect.height / 2
        const isTop = e.clientY < mid
        document.querySelectorAll('.tc-section-item').forEach((n) => {
          n.classList.remove('tc-drag-over-top'); n.classList.remove('tc-drag-over-bottom')
        })
        el.classList.toggle('tc-drag-over-top', isTop)
        el.classList.toggle('tc-drag-over-bottom', !isTop)
      })
      el.addEventListener('drop', (e) => {
        e.preventDefault()
        const draggedId = e.dataTransfer.getData('text/plain')
        const targetId = el.getAttribute('data-section-id')
        if (!draggedId || !targetId || draggedId === targetId) return
        const rect = el.getBoundingClientRect()
        const mid = rect.top + rect.height / 2
        const dropAbove = e.clientY < mid
        const ids = this.sections.map((s) => s.id)
        const from = ids.indexOf(draggedId)
        if (from < 0) return
        ids.splice(from, 1)
        let to = ids.indexOf(targetId)
        if (to < 0) return
        if (!dropAbove) to += 1
        ids.splice(to, 0, draggedId)
        this.applyReorder(ids).catch((err) => console.error('[customizer] reorder', err))
      })
    }

    async applyReorder(orderedIds) {
      const before = this.sections.map((s) => s.id)
      // Optimistic UI: rewrite local order, re-render sidebar.
      const map = new Map(this.sections.map((s) => [s.id, s]))
      this.sections = orderedIds.map((id) => map.get(id)).filter(Boolean)
      this.renderSidebar()
      try {
        await this.fetchJson('/sections/reorder', {
          method: 'POST',
          body: JSON.stringify({ template: this.currentTemplate, orderedIds }),
        })
        this.pushHistory({ type: 'reorder', before, after: orderedIds })
        this.refreshPreview()
      } catch (err) {
        console.error('[customizer] reorder failed', err)
        // rollback
        await this.loadSections(); this.renderSidebar()
      }
    }

    // ─── Undo / redo ──────────────────────────────────────────────────

    pushHistory(entry) {
      // Drop forward history when a new edit lands.
      if (this.historyIdx < this.history.length - 1) {
        this.history = this.history.slice(0, this.historyIdx + 1)
      }
      this.history.push(entry)
      if (this.history.length > MAX_HISTORY) this.history.shift()
      this.historyIdx = this.history.length - 1
      this.updateUndoRedoButtons()
    }

    updateUndoRedoButtons() {
      const undo = document.getElementById('tc-undo')
      const redo = document.getElementById('tc-redo')
      if (undo) undo.disabled = this.historyIdx < 0
      if (redo) redo.disabled = this.historyIdx >= this.history.length - 1
    }

    async undo() {
      if (this.historyIdx < 0) return
      const entry = this.history[this.historyIdx]
      this.historyIdx -= 1
      try {
        if (entry.type === 'settings') {
          await this.fetchJson('/sections/' + encodeURIComponent(entry.sectionId) + '/settings', {
            method: 'POST',
            body: JSON.stringify({ patch: entry.before }),
          })
          if (this.selectedSectionId === entry.sectionId) await this.selectSection(entry.sectionId)
        } else if (entry.type === 'reorder') {
          await this.fetchJson('/sections/reorder', {
            method: 'POST',
            body: JSON.stringify({ template: this.currentTemplate, orderedIds: entry.before }),
          })
          await this.loadSections(); this.renderSidebar()
        } else {
          // 'add' / 'remove' undo would need richer state — defer to a future PR.
        }
        this.refreshPreview()
      } finally {
        this.updateUndoRedoButtons()
      }
    }

    async redo() {
      if (this.historyIdx >= this.history.length - 1) return
      this.historyIdx += 1
      const entry = this.history[this.historyIdx]
      try {
        if (entry.type === 'settings') {
          await this.fetchJson('/sections/' + encodeURIComponent(entry.sectionId) + '/settings', {
            method: 'POST',
            body: JSON.stringify({ patch: entry.after }),
          })
          if (this.selectedSectionId === entry.sectionId) await this.selectSection(entry.sectionId)
        } else if (entry.type === 'reorder') {
          await this.fetchJson('/sections/reorder', {
            method: 'POST',
            body: JSON.stringify({ template: this.currentTemplate, orderedIds: entry.after }),
          })
          await this.loadSections(); this.renderSidebar()
        }
        this.refreshPreview()
      } finally {
        this.updateUndoRedoButtons()
      }
    }

    // ─── Misc ─────────────────────────────────────────────────────────

    bindTopbar() {
      const sel = document.getElementById('tc-template-select')
      if (sel) {
        sel.addEventListener('change', async (e) => {
          await this.flushPending()
          const v = e.target.value
          if (!v) return
          const url = new URL(window.location.href)
          url.searchParams.set('template', v)
          window.location.href = url.toString()
        })
      }
    }

    bindViewport() {
      const buttons = document.querySelectorAll('.tc-viewport-toggle button')
      const preview = document.querySelector('.tc-preview')
      if (!preview) return
      buttons.forEach((btn) => {
        btn.addEventListener('click', () => {
          const w = btn.getAttribute('data-viewport')
          if (!w) return
          buttons.forEach((b) => b.classList.toggle('active', b === btn))
          preview.setAttribute('data-viewport', w)
        })
      })
    }

    refreshPreview() {
      // Cheap: bump iframe.src with a cache-bust to re-render.
      const iframe = document.getElementById('tc-preview-iframe')
      if (!iframe || !iframe.src) return
      try {
        const u = new URL(iframe.src)
        u.searchParams.set('_gbox_t', String(Date.now()))
        iframe.src = u.toString()
      } catch (e) { /* non-URL iframes ignored */ }
    }

    markDirty(d) {
      this.dirty = d
      const save = document.getElementById('tc-save')
      if (save) save.disabled = !d
    }
  }

  // ─── Helpers ────────────────────────────────────────────────────────

  function escText(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  }
  function escAttr(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  }
  function pickerPlaceholder(type) {
    if (type === 'product') return 'product handle'
    if (type === 'collection') return 'collection handle'
    if (type === 'page') return 'page handle'
    if (type === 'blog') return 'blog handle'
    if (type === 'article') return 'article handle'
    if (type === 'image_picker') return 'asset path or URL'
    if (type === 'video_url') return 'https://…'
    return ''
  }
  function coerceColor(v, fallback) {
    const s = String(v == null ? '' : v).trim()
    if (/^#[0-9a-f]{6}$/i.test(s)) return s
    if (/^#[0-9a-f]{3}$/i.test(s)) {
      return '#' + s.slice(1).split('').map((c) => c + c).join('')
    }
    return fallback
  }

  const DEFAULT_SECTION_CATALOG = [
    { type: 'hero',                 name: 'Hero banner',           icon: '🎯' },
    { type: 'image-with-text',      name: 'Image with text',       icon: '🖼️' },
    { type: 'rich-text',            name: 'Rich text',             icon: '📝' },
    { type: 'featured-product',     name: 'Featured product',      icon: '⭐' },
    { type: 'featured-collection',  name: 'Featured collection',   icon: '📦' },
    { type: 'collection-list',      name: 'Collection list',       icon: '📁' },
    { type: 'product-recommendations', name: 'Product recommendations', icon: '🔁' },
    { type: 'blog-posts',           name: 'Blog posts',            icon: '📰' },
    { type: 'newsletter',           name: 'Newsletter',            icon: '✉️' },
    { type: 'announcement-bar',     name: 'Announcement bar',      icon: '📣' },
    { type: 'testimonials',         name: 'Testimonials',          icon: '💬' },
    { type: 'faq',                  name: 'FAQ',                   icon: '❓' },
    { type: 'page-content',         name: 'Page content',          icon: '📄' },
    { type: 'search',               name: 'Search',                icon: '🔍' },
    { type: 'contact-form',         name: 'Contact form',          icon: '📨' },
    { type: 'breadcrumbs',          name: 'Breadcrumbs',           icon: '🧭' },
  ]

  window.__bootstrapThemeCustomizer = function(config) {
    const tc = new ThemeCustomizer(config)
    window.__themeCustomizer = tc
    tc.init().catch((err) => console.error('[customizer] init failed', err))
  }
})()
`
