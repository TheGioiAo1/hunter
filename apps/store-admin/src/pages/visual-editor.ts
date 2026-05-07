/**
 * Store Admin — Visual Theme Editor (Page Builder / Customizer)
 *
 * Full-screen Shopify-style visual editor with live storefront preview.
 * Dark theme, sidebar with sections/settings, iframe preview, undo/redo.
 *
 * Routes:
 *   GET  /admin/store/:slug/online-store/editor/:themeId          — Visual editor UI
 *   GET  /admin/store/:slug/online-store/editor/:themeId/preview   — Preview wrapper (bridge)
 */

import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db'
import { esc } from '../layouts/seller-layout.js'
import { getTheme } from '@gbox/core/modules/themes/service.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function editorStyles(): string {
  return /* css */ `
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --editor-sidebar-width: 320px;
      --editor-topbar-height: 48px;
      --editor-bottombar-height: 40px;
      --editor-bg: #1e1e2e;
      --editor-sidebar-bg: #252536;
      --editor-text: #e0e0e0;
      --editor-text-muted: #888;
      --editor-text-dim: #666;
      --editor-accent: #3b82f6;
      --editor-accent-hover: #2563eb;
      --editor-accent-soft: rgba(59,130,246,.12);
      --editor-border: #333;
      --editor-input-bg: #1a1a2a;
      --editor-hover: #2a2a3e;
      --editor-surface: #2a2a3e;
      --editor-danger: #ef4444;
      --editor-success: #22c55e;
      --editor-warning: #f59e0b;
      --editor-radius: 6px;
      --editor-radius-lg: 10px;
      --editor-transition: 150ms ease;
    }

    html, body {
      height: 100%;
      overflow: hidden;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 13px;
      color: var(--editor-text);
      background: var(--editor-bg);
      -webkit-font-smoothing: antialiased;
    }

    button { cursor: pointer; font-family: inherit; font-size: inherit; }
    input, select, textarea { font-family: inherit; font-size: inherit; }

    /* ── Layout ─────────────────────────────────────────────────── */
    .ve-shell {
      display: grid;
      grid-template-rows: var(--editor-topbar-height) 1fr var(--editor-bottombar-height);
      grid-template-columns: var(--editor-sidebar-width) 1fr;
      height: 100vh;
      width: 100vw;
    }

    /* ── Top Bar ────────────────────────────────────────────────── */
    .ve-topbar {
      grid-column: 1 / -1;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 16px;
      background: var(--editor-sidebar-bg);
      border-bottom: 1px solid var(--editor-border);
      z-index: 10;
    }
    .ve-topbar-left {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .ve-topbar-left a {
      color: var(--editor-text-muted);
      text-decoration: none;
      font-size: 13px;
      display: flex;
      align-items: center;
      gap: 6px;
      transition: color var(--editor-transition);
    }
    .ve-topbar-left a:hover { color: var(--editor-text); }
    .ve-topbar-left .ve-divider {
      width: 1px;
      height: 20px;
      background: var(--editor-border);
    }
    .ve-theme-name {
      font-weight: 600;
      font-size: 14px;
      color: var(--editor-text);
    }
    .ve-topbar-right {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    /* Buttons */
    .ve-btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 14px;
      border-radius: var(--editor-radius);
      border: 1px solid var(--editor-border);
      background: transparent;
      color: var(--editor-text);
      font-size: 12px;
      font-weight: 500;
      transition: all var(--editor-transition);
      white-space: nowrap;
    }
    .ve-btn:hover { background: var(--editor-hover); }
    .ve-btn:disabled { opacity: .4; pointer-events: none; }
    .ve-btn-primary {
      background: var(--editor-accent);
      border-color: var(--editor-accent);
      color: #fff;
    }
    .ve-btn-primary:hover { background: var(--editor-accent-hover); border-color: var(--editor-accent-hover); }
    .ve-btn-success {
      background: var(--editor-success);
      border-color: var(--editor-success);
      color: #fff;
    }
    .ve-btn-success:hover { background: #16a34a; border-color: #16a34a; }

    /* ── Sidebar ────────────────────────────────────────────────── */
    .ve-sidebar {
      display: flex;
      flex-direction: column;
      background: var(--editor-sidebar-bg);
      border-right: 1px solid var(--editor-border);
      overflow: hidden;
    }

    .ve-sidebar-tabs {
      display: flex;
      border-bottom: 1px solid var(--editor-border);
      flex-shrink: 0;
    }
    .ve-sidebar-tab {
      flex: 1;
      padding: 10px 0;
      text-align: center;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: .5px;
      color: var(--editor-text-muted);
      background: none;
      border: none;
      border-bottom: 2px solid transparent;
      transition: all var(--editor-transition);
    }
    .ve-sidebar-tab:hover { color: var(--editor-text); }
    .ve-sidebar-tab.active {
      color: var(--editor-accent);
      border-bottom-color: var(--editor-accent);
    }

    .ve-sidebar-body {
      flex: 1;
      overflow-y: auto;
      scrollbar-width: thin;
      scrollbar-color: #444 transparent;
    }
    .ve-sidebar-body::-webkit-scrollbar { width: 6px; }
    .ve-sidebar-body::-webkit-scrollbar-thumb { background: #444; border-radius: 3px; }

    /* Section list */
    .ve-sections-list { padding: 8px; }
    .ve-section-item {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 12px;
      border-radius: var(--editor-radius);
      cursor: pointer;
      transition: background var(--editor-transition);
      border: 1px solid transparent;
      position: relative;
    }
    .ve-section-item:hover { background: var(--editor-hover); }
    .ve-section-item.selected {
      background: var(--editor-accent-soft);
      border-color: var(--editor-accent);
    }
    .ve-section-item .ve-drag-handle {
      color: var(--editor-text-dim);
      cursor: grab;
      flex-shrink: 0;
      font-size: 14px;
      line-height: 1;
      user-select: none;
    }
    .ve-section-item .ve-drag-handle:active { cursor: grabbing; }
    .ve-section-item .ve-section-name {
      flex: 1;
      font-size: 13px;
      font-weight: 500;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .ve-section-item .ve-section-type {
      font-size: 10px;
      color: var(--editor-text-muted);
      text-transform: uppercase;
      letter-spacing: .3px;
    }
    .ve-section-item .ve-section-actions {
      display: flex;
      gap: 2px;
      opacity: 0;
      transition: opacity var(--editor-transition);
    }
    .ve-section-item:hover .ve-section-actions { opacity: 1; }
    .ve-section-actions button {
      background: none;
      border: none;
      color: var(--editor-text-muted);
      padding: 4px;
      border-radius: 4px;
      font-size: 14px;
      line-height: 1;
    }
    .ve-section-actions button:hover { color: var(--editor-text); background: var(--editor-hover); }
    .ve-section-actions button.danger:hover { color: var(--editor-danger); }

    .ve-add-section-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      width: calc(100% - 16px);
      margin: 8px;
      padding: 10px;
      border: 1px dashed var(--editor-border);
      border-radius: var(--editor-radius);
      background: none;
      color: var(--editor-text-muted);
      font-size: 12px;
      font-weight: 500;
      transition: all var(--editor-transition);
    }
    .ve-add-section-btn:hover {
      border-color: var(--editor-accent);
      color: var(--editor-accent);
      background: var(--editor-accent-soft);
    }

    /* Settings panel */
    .ve-settings-panel { padding: 12px; }
    .ve-settings-empty {
      text-align: center;
      padding: 40px 16px;
      color: var(--editor-text-muted);
      font-size: 12px;
      line-height: 1.6;
    }
    .ve-settings-header {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 16px;
    }
    .ve-settings-back {
      background: none;
      border: none;
      color: var(--editor-text-muted);
      font-size: 16px;
      padding: 4px;
      border-radius: 4px;
    }
    .ve-settings-back:hover { color: var(--editor-text); background: var(--editor-hover); }
    .ve-settings-title {
      font-size: 14px;
      font-weight: 600;
    }

    .ve-field {
      margin-bottom: 16px;
    }
    .ve-field-label {
      display: block;
      font-size: 12px;
      font-weight: 600;
      color: var(--editor-text);
      margin-bottom: 6px;
    }
    .ve-field-info {
      font-size: 11px;
      color: var(--editor-text-muted);
      margin-top: 4px;
      line-height: 1.4;
    }
    .ve-field-header {
      font-size: 12px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: .5px;
      color: var(--editor-text-muted);
      padding: 12px 0 6px;
      border-top: 1px solid var(--editor-border);
      margin-top: 8px;
    }
    .ve-field-paragraph {
      font-size: 12px;
      color: var(--editor-text-muted);
      line-height: 1.5;
      padding: 4px 0;
    }

    .ve-input {
      width: 100%;
      padding: 8px 10px;
      border: 1px solid var(--editor-border);
      border-radius: var(--editor-radius);
      background: var(--editor-input-bg);
      color: var(--editor-text);
      outline: none;
      transition: border-color var(--editor-transition);
    }
    .ve-input:focus { border-color: var(--editor-accent); }
    .ve-input::placeholder { color: var(--editor-text-dim); }
    textarea.ve-input { min-height: 80px; resize: vertical; }
    select.ve-input { cursor: pointer; }

    .ve-color-field {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .ve-color-swatch {
      width: 32px;
      height: 32px;
      border-radius: var(--editor-radius);
      border: 2px solid var(--editor-border);
      cursor: pointer;
      overflow: hidden;
      flex-shrink: 0;
    }
    .ve-color-swatch input[type="color"] {
      width: 48px;
      height: 48px;
      margin: -8px;
      border: none;
      cursor: pointer;
    }

    .ve-range-field {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .ve-range-field input[type="range"] {
      flex: 1;
      accent-color: var(--editor-accent);
      height: 4px;
    }
    .ve-range-value {
      font-size: 12px;
      color: var(--editor-text-muted);
      min-width: 36px;
      text-align: right;
      font-variant-numeric: tabular-nums;
    }

    .ve-checkbox-field {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .ve-checkbox-field input[type="checkbox"] {
      width: 16px;
      height: 16px;
      accent-color: var(--editor-accent);
    }

    .ve-image-field {
      border: 1px dashed var(--editor-border);
      border-radius: var(--editor-radius);
      padding: 16px;
      text-align: center;
      cursor: pointer;
      transition: all var(--editor-transition);
    }
    .ve-image-field:hover {
      border-color: var(--editor-accent);
      background: var(--editor-accent-soft);
    }
    .ve-image-field img {
      max-width: 100%;
      max-height: 120px;
      border-radius: 4px;
      margin-bottom: 8px;
    }
    .ve-image-field .ve-image-placeholder {
      color: var(--editor-text-muted);
      font-size: 12px;
    }

    /* ── Preview area ───────────────────────────────────────────── */
    .ve-preview {
      position: relative;
      background: #111;
      display: flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;
    }
    .ve-preview-frame-wrap {
      transition: width .3s ease, height .3s ease;
      height: 100%;
      background: #fff;
      position: relative;
    }
    .ve-preview-frame-wrap.device-desktop { width: 100%; }
    .ve-preview-frame-wrap.device-tablet { width: 768px; border-radius: 8px; margin: 16px 0; height: calc(100% - 32px); }
    .ve-preview-frame-wrap.device-mobile { width: 375px; border-radius: 8px; margin: 16px 0; height: calc(100% - 32px); }
    .ve-preview-frame {
      width: 100%;
      height: 100%;
      border: none;
      background: #fff;
    }
    .ve-preview-loading {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      color: var(--editor-text-muted);
      font-size: 13px;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 12px;
    }
    .ve-spinner {
      width: 28px;
      height: 28px;
      border: 3px solid var(--editor-border);
      border-top-color: var(--editor-accent);
      border-radius: 50%;
      animation: spin .8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* ── Bottom bar ─────────────────────────────────────────────── */
    .ve-bottombar {
      grid-column: 1 / -1;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 16px;
      background: var(--editor-sidebar-bg);
      border-top: 1px solid var(--editor-border);
      font-size: 12px;
      z-index: 10;
    }
    .ve-bottombar-left, .ve-bottombar-center, .ve-bottombar-right {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .ve-bottombar-center { gap: 4px; }
    .ve-page-select {
      padding: 4px 8px;
      border: 1px solid var(--editor-border);
      border-radius: 4px;
      background: var(--editor-input-bg);
      color: var(--editor-text);
      font-size: 12px;
      cursor: pointer;
    }
    .ve-icon-btn {
      background: none;
      border: none;
      color: var(--editor-text-muted);
      padding: 4px 8px;
      border-radius: 4px;
      font-size: 14px;
      transition: all var(--editor-transition);
    }
    .ve-icon-btn:hover { color: var(--editor-text); background: var(--editor-hover); }
    .ve-icon-btn:disabled { opacity: .3; }
    .ve-icon-btn.active { color: var(--editor-accent); background: var(--editor-accent-soft); }
    .ve-device-btns { display: flex; gap: 2px; }
    .ve-status {
      color: var(--editor-text-muted);
      font-size: 11px;
    }
    .ve-status-dot {
      display: inline-block;
      width: 6px;
      height: 6px;
      border-radius: 50%;
      margin-right: 4px;
      vertical-align: middle;
    }
    .ve-status-dot.draft { background: var(--editor-warning); }
    .ve-status-dot.saved { background: var(--editor-success); }

    /* ── Add Section Modal ──────────────────────────────────────── */
    .ve-modal-overlay {
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,.6);
      z-index: 100;
      display: none;
      align-items: center;
      justify-content: center;
      backdrop-filter: blur(4px);
    }
    .ve-modal-overlay.open { display: flex; }
    .ve-modal {
      background: var(--editor-sidebar-bg);
      border: 1px solid var(--editor-border);
      border-radius: var(--editor-radius-lg);
      width: 560px;
      max-height: 80vh;
      display: flex;
      flex-direction: column;
      box-shadow: 0 24px 48px rgba(0,0,0,.4);
    }
    .ve-modal-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 16px 20px;
      border-bottom: 1px solid var(--editor-border);
    }
    .ve-modal-header h3 {
      font-size: 15px;
      font-weight: 700;
    }
    .ve-modal-close {
      background: none;
      border: none;
      color: var(--editor-text-muted);
      font-size: 20px;
      padding: 4px;
    }
    .ve-modal-close:hover { color: var(--editor-text); }
    .ve-modal-body {
      padding: 16px 20px;
      overflow-y: auto;
    }
    .ve-modal-search {
      width: 100%;
      padding: 8px 12px;
      border: 1px solid var(--editor-border);
      border-radius: var(--editor-radius);
      background: var(--editor-input-bg);
      color: var(--editor-text);
      margin-bottom: 16px;
    }
    .ve-modal-search:focus { outline: none; border-color: var(--editor-accent); }
    .ve-section-category {
      margin-bottom: 16px;
    }
    .ve-section-category-name {
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: .5px;
      color: var(--editor-text-muted);
      margin-bottom: 8px;
    }
    .ve-section-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
    }
    .ve-section-card {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 12px;
      border: 1px solid var(--editor-border);
      border-radius: var(--editor-radius);
      background: var(--editor-bg);
      cursor: pointer;
      transition: all var(--editor-transition);
    }
    .ve-section-card:hover {
      border-color: var(--editor-accent);
      background: var(--editor-accent-soft);
    }
    .ve-section-card-icon {
      width: 32px;
      height: 32px;
      border-radius: 6px;
      background: var(--editor-surface);
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--editor-accent);
      font-size: 15px;
      flex-shrink: 0;
    }
    .ve-section-card-info { flex: 1; min-width: 0; }
    .ve-section-card-name {
      font-size: 12px;
      font-weight: 600;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .ve-section-card-desc {
      font-size: 10px;
      color: var(--editor-text-muted);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      margin-top: 2px;
    }

    /* ── Toast / notifications ──────────────────────────────────── */
    .ve-toast-container {
      position: fixed;
      bottom: 60px;
      right: 16px;
      z-index: 200;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .ve-toast {
      padding: 10px 16px;
      border-radius: var(--editor-radius);
      font-size: 12px;
      font-weight: 500;
      box-shadow: 0 4px 12px rgba(0,0,0,.3);
      animation: toastIn .3s ease;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .ve-toast.info { background: var(--editor-surface); border: 1px solid var(--editor-border); }
    .ve-toast.success { background: #16503a; border: 1px solid #22c55e; color: #a7f3d0; }
    .ve-toast.error { background: #5c1a1a; border: 1px solid #ef4444; color: #fca5a5; }
    @keyframes toastIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
  `
}

// ---------------------------------------------------------------------------
// Section type icon mapping
// ---------------------------------------------------------------------------
const SECTION_ICONS: Record<string, string> = {
  'announcement-bar': '\u{1F4E2}',
  'header': '\u{1F3E0}',
  'hero-banner': '\u{1F5BC}',
  'featured-collection': '\u{1F6CD}',
  'rich-text': '\u{1F4DD}',
  'image-with-text': '\u{1F4F7}',
  'newsletter': '\u{1F4E7}',
  'video': '\u{1F3AC}',
  'slideshow': '\u{1F3A0}',
  'multi-column': '\u{1F4CA}',
  'collapsible-content': '\u{1F4CB}',
  'contact-form': '\u{1F4E9}',
  'map': '\u{1F5FA}',
  'logo-list': '\u{1F3F7}',
  'testimonials': '\u{1F4AC}',
  'footer': '\u{1F4CC}',
  'product-grid': '\u{1F4E6}',
  'collection-list': '\u{1F4C2}',
}

function getSectionIcon(type: string): string {
  return SECTION_ICONS[type] || '\u{1F4E6}'
}

// Category icons for modal
const CATEGORY_ICONS: Record<string, string> = {
  header: '\u{2B50}',
  content: '\u{1F4DD}',
  footer: '\u{1F4CC}',
  product: '\u{1F6CD}',
  marketing: '\u{1F4E3}',
  media: '\u{1F3AC}',
  text: '\u{1F4C4}',
}

// ---------------------------------------------------------------------------
// Main editor page HTML
// ---------------------------------------------------------------------------

function buildEditorHtml(opts: {
  storeSlug: string
  themeId: string
  themeName: string
  themeRole: string
  previewBaseUrl: string
  csrfToken: string
  apiBase: string
}): string {
  const { storeSlug, themeId, themeName, themeRole, previewBaseUrl, csrfToken, apiBase } = opts
  const backUrl = `/admin/store/${esc(storeSlug)}/online-store/themes`

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Customize: ${esc(themeName)} | GBox</title>
  <style>${editorStyles()}</style>
</head>
<body>
<div class="ve-shell">

  <!-- ═══ TOP BAR ═══ -->
  <div class="ve-topbar">
    <div class="ve-topbar-left">
      <a href="${esc(backUrl)}">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M10 3L5 8l5 5"/></svg>
        Back
      </a>
      <div class="ve-divider"></div>
      <span class="ve-theme-name">${esc(themeName)}</span>
      ${themeRole === 'main' ? '<span style="font-size:10px;color:var(--editor-success);font-weight:600;margin-left:4px">LIVE</span>' : ''}
    </div>
    <div class="ve-topbar-right">
      <span id="veSaveStatus" class="ve-status"></span>
      <button class="ve-btn" id="veSaveBtn" onclick="VE.save()" disabled>
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M13 5v8a1 1 0 01-1 1H4a1 1 0 01-1-1V3a1 1 0 011-1h6l3 3z"/><path d="M9 2v3h3M5 9h6M5 11.5h4"/></svg>
        Save
      </button>
      <button class="ve-btn ve-btn-success" id="vePublishBtn" onclick="VE.publish()">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 8l5 5L14 3"/></svg>
        Publish
      </button>
    </div>
  </div>

  <!-- ═══ SIDEBAR ═══ -->
  <div class="ve-sidebar">
    <div class="ve-sidebar-tabs">
      <button class="ve-sidebar-tab active" data-tab="sections" onclick="VE.switchTab('sections')">Sections</button>
      <button class="ve-sidebar-tab" data-tab="settings" onclick="VE.switchTab('settings')">Settings</button>
    </div>
    <div class="ve-sidebar-body" id="veSidebarBody">
      <!-- Sections tab (default) -->
      <div id="veTabSections">
        <div class="ve-sections-list" id="veSectionsList">
          <div class="ve-settings-empty">
            <div class="ve-spinner" style="margin:0 auto 8px"></div>
            Loading sections...
          </div>
        </div>
        <button class="ve-add-section-btn" onclick="VE.openAddModal()">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3v10M3 8h10"/></svg>
          Add section
        </button>
      </div>
      <!-- Settings tab (hidden initially) -->
      <div id="veTabSettings" style="display:none">
        <div class="ve-settings-panel" id="veSettingsPanel">
          <div class="ve-settings-empty">
            Select a section from the list to edit its settings.
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- ═══ PREVIEW ═══ -->
  <div class="ve-preview" id="vePreview">
    <div class="ve-preview-frame-wrap device-desktop" id="veFrameWrap">
      <div class="ve-preview-loading" id="vePreviewLoading">
        <div class="ve-spinner"></div>
        Loading preview...
      </div>
      <iframe
        id="vePreviewFrame"
        class="ve-preview-frame"
        src="about:blank"
        style="opacity:0;transition:opacity .3s"
        onload="VE.onFrameLoad()"
      ></iframe>
    </div>
  </div>

  <!-- ═══ BOTTOM BAR ═══ -->
  <div class="ve-bottombar">
    <div class="ve-bottombar-left">
      <label style="color:var(--editor-text-muted)">Page:</label>
      <select class="ve-page-select" id="vePageSelect" onchange="VE.changePage(this.value)">
        <option value="index">Homepage</option>
        <option value="product">Product</option>
        <option value="collection">Collection</option>
        <option value="page">Page</option>
        <option value="blog">Blog</option>
        <option value="cart">Cart</option>
        <option value="search">Search</option>
      </select>
    </div>
    <div class="ve-bottombar-center">
      <button class="ve-icon-btn" id="veUndoBtn" title="Undo (Ctrl+Z)" onclick="VE.undo()" disabled>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 6h6a3 3 0 010 6H7"/><path d="M6 4L4 6l2 2"/></svg>
      </button>
      <button class="ve-icon-btn" id="veRedoBtn" title="Redo (Ctrl+Shift+Z)" onclick="VE.redo()" disabled>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 6H6a3 3 0 000 6h3"/><path d="M10 4l2 2-2 2"/></svg>
      </button>
      <div class="ve-divider" style="height:16px;width:1px;background:var(--editor-border)"></div>
      <div class="ve-device-btns">
        <button class="ve-icon-btn active" data-device="desktop" onclick="VE.setDevice('desktop')" title="Desktop">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="1" y="2" width="14" height="10" rx="1"/><path d="M5 14h6M8 12v2"/></svg>
        </button>
        <button class="ve-icon-btn" data-device="tablet" onclick="VE.setDevice('tablet')" title="Tablet">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="1" width="10" height="14" rx="1.5"/><path d="M7 13h2"/></svg>
        </button>
        <button class="ve-icon-btn" data-device="mobile" onclick="VE.setDevice('mobile')" title="Mobile">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="4" y="1" width="8" height="14" rx="1.5"/><path d="M7 13h2"/></svg>
        </button>
      </div>
    </div>
    <div class="ve-bottombar-right">
      <span id="veStatusIndicator" class="ve-status">
        <span class="ve-status-dot draft"></span>
        Draft
      </span>
    </div>
  </div>

</div><!-- .ve-shell -->

<!-- ═══ ADD SECTION MODAL ═══ -->
<div class="ve-modal-overlay" id="veAddModal">
  <div class="ve-modal">
    <div class="ve-modal-header">
      <h3>Add section</h3>
      <button class="ve-modal-close" onclick="VE.closeAddModal()">&times;</button>
    </div>
    <div class="ve-modal-body">
      <input class="ve-modal-search" id="veAddSearch" placeholder="Search sections..." oninput="VE.filterAddModal(this.value)" />
      <div id="veAddGrid"></div>
    </div>
  </div>
</div>

<!-- ═══ TOAST CONTAINER ═══ -->
<div class="ve-toast-container" id="veToasts"></div>

<!-- ═══ CLIENT-SIDE JS ═══ -->
<script>
(function() {
  'use strict';

  // ── Config ──────────────────────────────────────────────────
  const CONFIG = {
    storeSlug: ${JSON.stringify(storeSlug)},
    themeId: ${JSON.stringify(themeId)},
    themeName: ${JSON.stringify(themeName)},
    csrf: ${JSON.stringify(csrfToken)},
    apiBase: ${JSON.stringify(apiBase)},
    previewBase: ${JSON.stringify(previewBaseUrl)},
  };

  // ── State ───────────────────────────────────────────────────
  let state = {
    sections: [],
    selectedSectionId: null,
    selectedSectionSchema: null,
    currentPage: 'index',
    device: 'desktop',
    undoStack: [],
    redoStack: [],
    dirty: false,
    saving: false,
    sectionTypes: [],  // from registry
  };

  // ── Debounce util ───────────────────────────────────────────
  function debounce(fn, ms) {
    let t;
    return function(...args) { clearTimeout(t); t = setTimeout(() => fn.apply(this, args), ms); };
  }

  // ── Toast notifications ─────────────────────────────────────
  function toast(msg, type) {
    type = type || 'info';
    const el = document.createElement('div');
    el.className = 've-toast ' + type;
    el.textContent = msg;
    document.getElementById('veToasts').appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 3000);
  }

  // ── API helpers ─────────────────────────────────────────────
  async function api(path, opts) {
    opts = opts || {};
    const url = CONFIG.apiBase + path;
    const headers = { 'Content-Type': 'application/json' };
    const resp = await fetch(url, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body ? JSON.stringify({ ...opts.body, _csrf: CONFIG.csrf }) : undefined,
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(text || 'API error ' + resp.status);
    }
    const ct = resp.headers.get('content-type') || '';
    return ct.includes('json') ? resp.json() : resp.text();
  }

  // ── Section list ────────────────────────────────────────────
  async function loadSections() {
    try {
      const data = await api('/themes/' + CONFIG.themeId + '/page-builder/sections?page_type=' + state.currentPage);
      state.sections = Array.isArray(data) ? data : (data.sections || []);
      renderSectionsList();
    } catch (e) {
      console.error('loadSections:', e);
      document.getElementById('veSectionsList').innerHTML =
        '<div class="ve-settings-empty">Failed to load sections.<br><button class="ve-btn" style="margin-top:8px" onclick="VE.loadSections()">Retry</button></div>';
    }
  }

  function renderSectionsList() {
    const list = document.getElementById('veSectionsList');
    if (!state.sections.length) {
      list.innerHTML = '<div class="ve-settings-empty">No sections on this page yet.<br>Click "Add section" below to get started.</div>';
      return;
    }
    list.innerHTML = state.sections.map(function(sec, idx) {
      const icon = ${JSON.stringify(SECTION_ICONS)}[sec.type] || '\\u{1F4E6}';
      const selected = sec.id === state.selectedSectionId ? ' selected' : '';
      return '<div class="ve-section-item' + selected + '" data-section-id="' + esc(sec.id) + '" data-idx="' + idx + '"'
        + ' draggable="true"'
        + ' onclick="VE.selectSection(\\'' + esc(sec.id) + '\\')"'
        + ' ondragstart="VE.onDragStart(event,' + idx + ')"'
        + ' ondragover="VE.onDragOver(event,' + idx + ')"'
        + ' ondrop="VE.onDrop(event,' + idx + ')"'
        + '>'
        + '<span class="ve-drag-handle" title="Drag to reorder">\\u2630</span>'
        + '<span style="font-size:16px;flex-shrink:0">' + icon + '</span>'
        + '<div style="flex:1;min-width:0">'
        + '  <div class="ve-section-name">' + esc(sec.name || sec.type) + '</div>'
        + '  <div class="ve-section-type">' + esc(sec.type) + '</div>'
        + '</div>'
        + '<div class="ve-section-actions">'
        + '  <button title="Toggle visibility" onclick="event.stopPropagation();VE.toggleSection(\\'' + esc(sec.id) + '\\')">'
        + (sec.disabled ? '\\u{1F441}' : '\\u{1F440}')
        + '  </button>'
        + '  <button class="danger" title="Remove" onclick="event.stopPropagation();VE.removeSection(\\'' + esc(sec.id) + '\\')">&times;</button>'
        + '</div>'
        + '</div>';
    }).join('');
  }

  // HTML-escape for dynamic content
  function esc(s) {
    if (!s) return '';
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }

  // Sanitize HTML: strip script tags and on* event attributes
  function sanitizeHtml(html) {
    if (!html) return '';
    return String(html)
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<script[\s>][^]*$/gi, '')
      .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]*)/gi, '');
  }

  // ── Select section & load settings ──────────────────────────
  async function selectSection(sectionId) {
    state.selectedSectionId = sectionId;
    renderSectionsList();

    // Switch to settings tab
    switchTab('settings');

    const panel = document.getElementById('veSettingsPanel');
    panel.innerHTML = '<div class="ve-settings-empty"><div class="ve-spinner" style="margin:0 auto 8px"></div>Loading settings...</div>';

    // Tell iframe to highlight
    postToPreview({ type: 'cmd:select', sectionId: sectionId });

    try {
      const sec = state.sections.find(function(s) { return s.id === sectionId; });
      if (!sec) { panel.innerHTML = '<div class="ve-settings-empty">Section not found.</div>'; return; }

      // Fetch schema for this section type
      let schema = null;
      try {
        const data = await api('/themes/' + CONFIG.themeId + '/page-builder/section-types/' + sec.type);
        schema = data;
      } catch (e) {
        // Try fallback: find in preloaded sectionTypes
        schema = state.sectionTypes.find(function(st) { return st.type === sec.type; });
      }

      state.selectedSectionSchema = schema;
      renderSettingsPanel(sec, schema);
    } catch (e) {
      console.error('selectSection:', e);
      panel.innerHTML = '<div class="ve-settings-empty">Failed to load settings.</div>';
    }
  }

  // ── Render settings form ────────────────────────────────────
  function renderSettingsPanel(section, schema) {
    const panel = document.getElementById('veSettingsPanel');
    const settings = (schema && schema.settings) || [];
    const values = section.settings || {};

    let html = '<div class="ve-settings-header">'
      + '<button class="ve-settings-back" onclick="VE.switchTab(\'sections\')" title="Back to sections">'
      + '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M10 3L5 8l5 5"/></svg>'
      + '</button>'
      + '<span class="ve-settings-title">' + esc(section.name || section.type) + '</span>'
      + '</div>';

    if (!settings.length) {
      html += '<div class="ve-settings-empty">This section has no configurable settings.</div>';
      panel.innerHTML = html;
      return;
    }

    settings.forEach(function(field) {
      if (field.type === 'header') {
        html += '<div class="ve-field-header">' + esc(field.label) + '</div>';
        return;
      }
      if (field.type === 'paragraph') {
        html += '<div class="ve-field-paragraph">' + esc(field.label) + '</div>';
        return;
      }

      const val = values[field.id] !== undefined ? values[field.id] : (field.default !== undefined ? field.default : '');
      html += '<div class="ve-field">';
      html += '<label class="ve-field-label">' + esc(field.label) + '</label>';

      switch (field.type) {
        case 'text':
          html += '<input class="ve-input" type="text" data-field="' + esc(field.id) + '" value="' + esc(String(val)) + '"'
            + (field.placeholder ? ' placeholder="' + esc(field.placeholder) + '"' : '')
            + ' oninput="VE.onSettingChange(\\'' + esc(field.id) + '\\', this.value)" />';
          break;

        case 'textarea':
          html += '<textarea class="ve-input" data-field="' + esc(field.id) + '"'
            + (field.placeholder ? ' placeholder="' + esc(field.placeholder) + '"' : '')
            + ' oninput="VE.onSettingChange(\\'' + esc(field.id) + '\\', this.value)">' + esc(String(val)) + '</textarea>';
          break;

        case 'richtext':
          html += '<div class="ve-input" contenteditable="true" data-field="' + esc(field.id) + '"'
            + ' style="min-height:80px;overflow-y:auto"'
            + ' oninput="VE.onSettingChange(\\'' + esc(field.id) + '\\', this.innerHTML)">' + sanitizeHtml(val || '') + '</div>';
          break;

        case 'number':
          html += '<input class="ve-input" type="number" data-field="' + esc(field.id) + '" value="' + esc(String(val)) + '"'
            + (field.min !== undefined ? ' min="' + field.min + '"' : '')
            + (field.max !== undefined ? ' max="' + field.max + '"' : '')
            + (field.step !== undefined ? ' step="' + field.step + '"' : '')
            + ' oninput="VE.onSettingChange(\\'' + esc(field.id) + '\\', Number(this.value))" />';
          break;

        case 'url':
          html += '<input class="ve-input" type="url" data-field="' + esc(field.id) + '" value="' + esc(String(val)) + '"'
            + ' placeholder="https://"'
            + ' oninput="VE.onSettingChange(\\'' + esc(field.id) + '\\', this.value)" />';
          break;

        case 'color':
          html += '<div class="ve-color-field">'
            + '<div class="ve-color-swatch">'
            + '<input type="color" data-field="' + esc(field.id) + '" value="' + esc(String(val || '#000000')) + '"'
            + ' oninput="VE.onSettingChange(\\'' + esc(field.id) + '\\', this.value);this.parentElement.nextElementSibling.value=this.value" />'
            + '</div>'
            + '<input class="ve-input" type="text" value="' + esc(String(val || '#000000')) + '" style="flex:1"'
            + ' oninput="VE.onSettingChange(\\'' + esc(field.id) + '\\', this.value);this.previousElementSibling.querySelector(\'input\').value=this.value" />'
            + '</div>';
          break;

        case 'range':
          var rangeMin = field.min || 0;
          var rangeMax = field.max || 100;
          var rangeStep = field.step || 1;
          var unit = field.unit || '';
          html += '<div class="ve-range-field">'
            + '<input type="range" data-field="' + esc(field.id) + '" value="' + val + '"'
            + ' min="' + rangeMin + '" max="' + rangeMax + '" step="' + rangeStep + '"'
            + ' oninput="VE.onSettingChange(\\'' + esc(field.id) + '\\', Number(this.value));this.nextElementSibling.textContent=this.value+\\'' + esc(unit) + '\\'" />'
            + '<span class="ve-range-value">' + val + esc(unit) + '</span>'
            + '</div>';
          break;

        case 'select':
          html += '<select class="ve-input" data-field="' + esc(field.id) + '"'
            + ' onchange="VE.onSettingChange(\\'' + esc(field.id) + '\\', this.value)">';
          (field.options || []).forEach(function(opt) {
            html += '<option value="' + esc(opt.value) + '"' + (String(val) === String(opt.value) ? ' selected' : '') + '>' + esc(opt.label) + '</option>';
          });
          html += '</select>';
          break;

        case 'checkbox':
          html += '<div class="ve-checkbox-field">'
            + '<input type="checkbox" data-field="' + esc(field.id) + '"' + (val ? ' checked' : '')
            + ' onchange="VE.onSettingChange(\\'' + esc(field.id) + '\\', this.checked)" />'
            + '<span style="font-size:12px">' + esc(field.label) + '</span>'
            + '</div>';
          break;

        case 'image':
          html += '<div class="ve-image-field" onclick="VE.pickImage(\\'' + esc(field.id) + '\\')">';
          if (val) {
            html += '<img src="' + esc(String(val)) + '" alt="" /><br>';
            html += '<span style="font-size:11px;color:var(--editor-accent)">Change image</span>';
          } else {
            html += '<div class="ve-image-placeholder">Click to select an image</div>';
          }
          html += '</div>'
            + '<input type="file" id="veImageInput_' + esc(field.id) + '" accept="image/*" style="display:none"'
            + ' onchange="VE.onImageSelected(\\'' + esc(field.id) + '\\', this)" />';
          break;

        default:
          html += '<input class="ve-input" type="text" data-field="' + esc(field.id) + '" value="' + esc(String(val)) + '"'
            + ' oninput="VE.onSettingChange(\\'' + esc(field.id) + '\\', this.value)" />';
      }

      if (field.info) {
        html += '<div class="ve-field-info">' + esc(field.info) + '</div>';
      }

      html += '</div>'; // .ve-field
    });

    panel.innerHTML = html;
  }

  // ── Setting change handler (debounced) ──────────────────────
  const debouncedUpdate = debounce(function(sectionId, fieldId, value) {
    updateSectionSetting(sectionId, fieldId, value);
  }, 300);

  function onSettingChange(fieldId, value) {
    if (!state.selectedSectionId) return;

    // Update local state
    const sec = state.sections.find(function(s) { return s.id === state.selectedSectionId; });
    if (sec) {
      const before = JSON.parse(JSON.stringify(sec.settings || {}));
      if (!sec.settings) sec.settings = {};
      sec.settings[fieldId] = value;

      // Push undo
      pushUndo({
        action: 'setting_change',
        sectionId: state.selectedSectionId,
        fieldId: fieldId,
        before: before[fieldId],
        after: value,
      });
    }

    state.dirty = true;
    updateSaveState();
    debouncedUpdate(state.selectedSectionId, fieldId, value);
  }

  async function updateSectionSetting(sectionId, fieldId, value) {
    try {
      await api('/themes/' + CONFIG.themeId + '/page-builder/sections/' + sectionId + '/settings', {
        method: 'PUT',
        body: { [fieldId]: value },
      });
      // Tell iframe to refresh
      postToPreview({ type: 'cmd:refresh' });
    } catch (e) {
      console.error('updateSectionSetting:', e);
      toast('Failed to update setting', 'error');
    }
  }

  // ── Image picker ────────────────────────────────────────────
  function pickImage(fieldId) {
    var input = document.getElementById('veImageInput_' + fieldId);
    if (input) input.click();
  }

  function onImageSelected(fieldId, input) {
    if (!input.files || !input.files[0]) return;
    var file = input.files[0];

    // Upload via FormData
    var fd = new FormData();
    fd.append('file', file);
    fd.append('_csrf', CONFIG.csrf);

    fetch(CONFIG.apiBase + '/files/upload', {
      method: 'POST',
      body: fd,
    })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      var url = data.url || data.file_url || '';
      if (url) {
        onSettingChange(fieldId, url);
        // Re-render to show preview
        var sec = state.sections.find(function(s) { return s.id === state.selectedSectionId; });
        if (sec && state.selectedSectionSchema) renderSettingsPanel(sec, state.selectedSectionSchema);
      }
    })
    .catch(function(e) {
      toast('Image upload failed', 'error');
    });
  }

  // ── Drag & Drop reorder ─────────────────────────────────────
  let dragIdx = null;

  function onDragStart(e, idx) {
    dragIdx = idx;
    e.dataTransfer.effectAllowed = 'move';
    e.target.style.opacity = '0.4';
  }
  function onDragOver(e, idx) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  }
  function onDrop(e, targetIdx) {
    e.preventDefault();
    if (dragIdx === null || dragIdx === targetIdx) return;

    const moved = state.sections.splice(dragIdx, 1)[0];
    state.sections.splice(targetIdx, 0, moved);
    renderSectionsList();
    dragIdx = null;

    // Reset opacity
    document.querySelectorAll('.ve-section-item').forEach(function(el) { el.style.opacity = '1'; });

    // Persist order
    reorderSections();
  }

  async function reorderSections() {
    try {
      const order = state.sections.map(function(s) { return s.id; });
      await api('/themes/' + CONFIG.themeId + '/page-builder/sections/reorder', {
        method: 'PUT',
        body: { order: order, page_type: state.currentPage },
      });
      postToPreview({ type: 'cmd:refresh' });
      state.dirty = true;
      updateSaveState();
    } catch (e) {
      toast('Failed to reorder', 'error');
    }
  }

  // ── Add section ─────────────────────────────────────────────
  async function loadSectionTypes() {
    try {
      const data = await api('/themes/' + CONFIG.themeId + '/page-builder/section-types');
      state.sectionTypes = Array.isArray(data) ? data : (data.types || data.section_types || []);
      renderAddGrid();
    } catch (e) {
      console.warn('loadSectionTypes:', e);
      state.sectionTypes = [];
    }
  }

  function renderAddGrid(filter) {
    const grid = document.getElementById('veAddGrid');
    filter = (filter || '').toLowerCase();

    // Group by category
    const groups = {};
    state.sectionTypes.forEach(function(st) {
      if (filter && st.name.toLowerCase().indexOf(filter) === -1 && (st.type || '').toLowerCase().indexOf(filter) === -1) return;
      var cat = st.category || 'content';
      if (!groups[cat]) groups[cat] = [];
      groups[cat].push(st);
    });

    const catOrder = ['header', 'content', 'product', 'marketing', 'media', 'text', 'footer'];
    let html = '';

    catOrder.forEach(function(cat) {
      if (!groups[cat] || !groups[cat].length) return;
      const catIcons = ${JSON.stringify(CATEGORY_ICONS)};
      html += '<div class="ve-section-category">';
      html += '<div class="ve-section-category-name">' + (catIcons[cat] || '') + ' ' + esc(cat) + '</div>';
      html += '<div class="ve-section-grid">';
      groups[cat].forEach(function(st) {
        const icon = ${JSON.stringify(SECTION_ICONS)}[st.type] || '\\u{1F4E6}';
        html += '<div class="ve-section-card" onclick="VE.addSection(\\'' + esc(st.type) + '\\')">'
          + '<div class="ve-section-card-icon">' + icon + '</div>'
          + '<div class="ve-section-card-info">'
          + '<div class="ve-section-card-name">' + esc(st.name) + '</div>'
          + (st.description ? '<div class="ve-section-card-desc">' + esc(st.description) + '</div>' : '')
          + '</div>'
          + '</div>';
      });
      html += '</div></div>';
    });

    if (!html) {
      html = '<div class="ve-settings-empty">No sections found.</div>';
    }

    grid.innerHTML = html;
  }

  async function addSection(type) {
    closeAddModal();
    try {
      await api('/themes/' + CONFIG.themeId + '/page-builder/sections', {
        method: 'POST',
        body: { type: type, page_type: state.currentPage },
      });
      toast('Section added', 'success');
      state.dirty = true;
      updateSaveState();
      loadSections();
      postToPreview({ type: 'cmd:refresh' });
    } catch (e) {
      toast('Failed to add section: ' + e.message, 'error');
    }
  }

  // ── Remove section ──────────────────────────────────────────
  async function removeSection(sectionId) {
    if (!confirm('Remove this section?')) return;
    try {
      await api('/themes/' + CONFIG.themeId + '/page-builder/sections/' + sectionId, {
        method: 'DELETE',
        body: {},
      });
      state.sections = state.sections.filter(function(s) { return s.id !== sectionId; });
      if (state.selectedSectionId === sectionId) {
        state.selectedSectionId = null;
        document.getElementById('veSettingsPanel').innerHTML =
          '<div class="ve-settings-empty">Select a section to edit its settings.</div>';
      }
      renderSectionsList();
      postToPreview({ type: 'cmd:refresh' });
      state.dirty = true;
      updateSaveState();
      toast('Section removed', 'success');
    } catch (e) {
      toast('Failed to remove section', 'error');
    }
  }

  // ── Toggle section visibility ───────────────────────────────
  async function toggleSection(sectionId) {
    const sec = state.sections.find(function(s) { return s.id === sectionId; });
    if (!sec) return;
    sec.disabled = !sec.disabled;
    renderSectionsList();
    try {
      await api('/themes/' + CONFIG.themeId + '/page-builder/sections/' + sectionId + '/toggle', {
        method: 'PUT',
        body: { disabled: sec.disabled },
      });
      postToPreview({ type: 'cmd:refresh' });
    } catch (e) {
      toast('Failed to toggle section', 'error');
    }
  }

  // ── Tab switching ───────────────────────────────────────────
  function switchTab(tab) {
    document.querySelectorAll('.ve-sidebar-tab').forEach(function(el) {
      el.classList.toggle('active', el.dataset.tab === tab);
    });
    document.getElementById('veTabSections').style.display = tab === 'sections' ? '' : 'none';
    document.getElementById('veTabSettings').style.display = tab === 'settings' ? '' : 'none';
  }

  // ── Device preview ──────────────────────────────────────────
  function setDevice(device) {
    state.device = device;
    var wrap = document.getElementById('veFrameWrap');
    wrap.className = 've-preview-frame-wrap device-' + device;
    document.querySelectorAll('.ve-device-btns .ve-icon-btn').forEach(function(el) {
      el.classList.toggle('active', el.dataset.device === device);
    });
  }

  // ── Page selector ───────────────────────────────────────────
  function changePage(pageType) {
    state.currentPage = pageType;
    state.selectedSectionId = null;
    loadSections();
    refreshPreview();
  }

  // ── Undo / Redo ─────────────────────────────────────────────
  function pushUndo(cmd) {
    state.undoStack.push(cmd);
    // Cap undo stack at 100 entries to prevent unbounded memory growth
    if (state.undoStack.length > 100) {
      state.undoStack.shift();
    }
    state.redoStack = [];
    updateUndoRedoState();
  }

  function undo() {
    if (!state.undoStack.length) return;
    const cmd = state.undoStack.pop();
    state.redoStack.push(cmd);

    // Apply reverse
    if (cmd.action === 'setting_change') {
      const sec = state.sections.find(function(s) { return s.id === cmd.sectionId; });
      if (sec && sec.settings) {
        sec.settings[cmd.fieldId] = cmd.before;
        updateSectionSetting(cmd.sectionId, cmd.fieldId, cmd.before);
        if (state.selectedSectionId === cmd.sectionId && state.selectedSectionSchema) {
          renderSettingsPanel(sec, state.selectedSectionSchema);
        }
      }
    }
    updateUndoRedoState();
  }

  function redo() {
    if (!state.redoStack.length) return;
    const cmd = state.redoStack.pop();
    state.undoStack.push(cmd);

    if (cmd.action === 'setting_change') {
      const sec = state.sections.find(function(s) { return s.id === cmd.sectionId; });
      if (sec && sec.settings) {
        sec.settings[cmd.fieldId] = cmd.after;
        updateSectionSetting(cmd.sectionId, cmd.fieldId, cmd.after);
        if (state.selectedSectionId === cmd.sectionId && state.selectedSectionSchema) {
          renderSettingsPanel(sec, state.selectedSectionSchema);
        }
      }
    }
    updateUndoRedoState();
  }

  function updateUndoRedoState() {
    document.getElementById('veUndoBtn').disabled = !state.undoStack.length;
    document.getElementById('veRedoBtn').disabled = !state.redoStack.length;
  }

  // ── Save / Publish ──────────────────────────────────────────
  function updateSaveState() {
    document.getElementById('veSaveBtn').disabled = !state.dirty;
    var status = document.getElementById('veStatusIndicator');
    if (state.dirty) {
      status.innerHTML = '<span class="ve-status-dot draft"></span>Unsaved changes';
    }
  }

  async function save() {
    if (state.saving) return;
    state.saving = true;
    var btn = document.getElementById('veSaveBtn');
    btn.disabled = true;
    btn.textContent = 'Saving...';
    document.getElementById('veSaveStatus').textContent = 'Saving...';

    try {
      await api('/themes/' + CONFIG.themeId + '/page-builder/save', {
        method: 'POST',
        body: { page_type: state.currentPage },
      });
      state.dirty = false;
      toast('Changes saved', 'success');
      document.getElementById('veStatusIndicator').innerHTML = '<span class="ve-status-dot saved"></span>Saved';
      document.getElementById('veSaveStatus').textContent = '';
    } catch (e) {
      toast('Save failed: ' + e.message, 'error');
      document.getElementById('veSaveStatus').textContent = '';
    } finally {
      state.saving = false;
      btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M13 5v8a1 1 0 01-1 1H4a1 1 0 01-1-1V3a1 1 0 011-1h6l3 3z"/><path d="M9 2v3h3M5 9h6M5 11.5h4"/></svg> Save';
      updateSaveState();
    }
  }

  async function publish() {
    if (!confirm('Publish this theme? It will become the live theme for your store.')) return;
    try {
      await api('/themes/' + CONFIG.themeId + '/page-builder/publish', {
        method: 'POST',
        body: {},
      });
      toast('Theme published!', 'success');
      document.getElementById('veStatusIndicator').innerHTML = '<span class="ve-status-dot saved"></span>Published';
    } catch (e) {
      toast('Publish failed: ' + e.message, 'error');
    }
  }

  // ── Preview iframe ──────────────────────────────────────────
  function refreshPreview() {
    var frame = document.getElementById('vePreviewFrame');
    var loading = document.getElementById('vePreviewLoading');
    loading.style.display = 'flex';
    frame.style.opacity = '0';

    var pageMap = {
      index: '/',
      product: '/products/preview',
      collection: '/collections/preview',
      page: '/pages/preview',
      blog: '/blogs/preview',
      cart: '/cart',
      search: '/search',
    };
    var path = pageMap[state.currentPage] || '/';
    frame.src = CONFIG.previewBase + path + '?design_mode=true&theme_id=' + CONFIG.themeId;
  }

  function onFrameLoad() {
    document.getElementById('vePreviewLoading').style.display = 'none';
    document.getElementById('vePreviewFrame').style.opacity = '1';
  }

  // ── PostMessage bridge ──────────────────────────────────────
  function postToPreview(msg) {
    var frame = document.getElementById('vePreviewFrame');
    if (frame && frame.contentWindow) {
      var previewOrigin = new URL(CONFIG.previewBase).origin;
      frame.contentWindow.postMessage(msg, previewOrigin);
    }
  }

  window.addEventListener('message', function(e) {
    // Validate origin: only accept messages from the preview iframe origin
    var previewOrigin = new URL(CONFIG.previewBase).origin;
    if (e.origin !== previewOrigin && e.origin !== window.location.origin) return;
    if (!e.data || !e.data.type) return;

    switch (e.data.type) {
      case 'section:click':
        if (e.data.sectionId) selectSection(e.data.sectionId);
        break;
      case 'section:hover':
        // Could add hover highlight in sidebar
        break;
      case 'bridge:ready':
        // Bridge script in iframe is ready
        break;
    }
  });

  // ── Add Modal ───────────────────────────────────────────────
  function openAddModal() {
    document.getElementById('veAddModal').classList.add('open');
    document.getElementById('veAddSearch').value = '';
    renderAddGrid();
    setTimeout(function() { document.getElementById('veAddSearch').focus(); }, 50);
  }
  function closeAddModal() {
    document.getElementById('veAddModal').classList.remove('open');
  }
  function filterAddModal(q) {
    renderAddGrid(q);
  }

  // ── Keyboard shortcuts ──────────────────────────────────────
  document.addEventListener('keydown', function(e) {
    // Ctrl+S / Cmd+S = save
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      save();
      return;
    }
    // Ctrl+Z = undo
    if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
      e.preventDefault();
      undo();
      return;
    }
    // Ctrl+Shift+Z or Ctrl+Y = redo
    if ((e.ctrlKey || e.metaKey) && (e.key === 'Z' || e.key === 'y') && (e.shiftKey || e.key === 'y')) {
      e.preventDefault();
      redo();
      return;
    }
    // Escape = close modal
    if (e.key === 'Escape') {
      closeAddModal();
    }
  });

  // ── Init ────────────────────────────────────────────────────
  function init() {
    loadSections();
    loadSectionTypes();
    refreshPreview();
  }

  // ── Public API (attached to window.VE) ──────────────────────
  window.VE = {
    selectSection: selectSection,
    switchTab: switchTab,
    setDevice: setDevice,
    changePage: changePage,
    save: save,
    publish: publish,
    undo: undo,
    redo: redo,
    openAddModal: openAddModal,
    closeAddModal: closeAddModal,
    filterAddModal: filterAddModal,
    addSection: addSection,
    removeSection: removeSection,
    toggleSection: toggleSection,
    onSettingChange: onSettingChange,
    pickImage: pickImage,
    onImageSelected: onImageSelected,
    onDragStart: onDragStart,
    onDragOver: onDragOver,
    onDrop: onDrop,
    loadSections: loadSections,
    onFrameLoad: onFrameLoad,
  };

  // Boot
  document.addEventListener('DOMContentLoaded', init);
  if (document.readyState !== 'loading') init();

})();
</script>
</body>
</html>`
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerVisualEditorRoutes(
  app: any,
  db: Kysely<Database>,
  requireStoreAccess?: any,
): void {
  const storeBase = '/admin/store/:slug/online-store/editor/:themeId'
  const mw = requireStoreAccess ? [requireStoreAccess] : []

  // ── GET  Visual editor page ───────────────────────────────
  app.get(storeBase, ...mw, async (req: Request, res: Response) => {
    const store = req.store!
    const themeId = req.params.themeId

    try {
      const themeRecord = await getTheme(db, themeId)
      if (!themeRecord) {
        res.redirect(`/admin/store/${store.slug}/online-store/themes`)
        return
      }

      // Resolve storefront preview URL
      // In dev: http://localhost:4323 or configured per store
      // The preview page wraps storefront with the editor bridge script
      const previewBaseUrl = (store as any).storefront_url
        || (store as any).domain
        || `http://localhost:4323`

      const csrfToken: string = (req as any).csrfToken || ''
      const apiBase = `/api/store/${store.slug}`

      const html = buildEditorHtml({
        storeSlug: store.slug,
        themeId,
        themeName: themeRecord.name || 'Untitled Theme',
        themeRole: themeRecord.role || 'unpublished',
        previewBaseUrl,
        csrfToken,
        apiBase,
      })

      res.type('html').send(html)
    } catch (err: any) {
      console.error('Visual editor error:', err)
      res.redirect(`/admin/store/${store.slug}/online-store/themes`)
    }
  })

  // ── GET  Preview wrapper (bridge injection) ───────────────
  app.get(`${storeBase}/preview`, ...mw, async (req: Request, res: Response) => {
    const store = req.store!
    const themeId = req.params.themeId

    // This route returns a small HTML wrapper that loads the storefront page
    // inside an iframe-like context with the editor bridge script injected.
    // Alternatively, the storefront itself can detect ?design_mode=true and
    // inject the bridge automatically.
    const storefrontUrl = (store as any).storefront_url
      || (store as any).domain
      || 'http://localhost:4323'

    const pageUrl = (req.query.page_url as string) || '/'
    const fullUrl = `${storefrontUrl}${pageUrl}?design_mode=true&theme_id=${esc(themeId)}`

    const html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><title>Preview</title>
<style>*{margin:0;padding:0}html,body{height:100%;overflow:hidden}iframe{width:100%;height:100%;border:none}</style>
</head>
<body>
<iframe id="storefrontFrame" src="${esc(fullUrl)}"></iframe>
<script>
// Editor bridge: relay messages between parent editor and storefront
const frame = document.getElementById('storefrontFrame');

// Forward commands from editor to storefront
window.addEventListener('message', function(e) {
  if (e.data && e.data.type && e.data.type.startsWith('cmd:')) {
    frame.contentWindow.postMessage(e.data, '*');
  }
});

// Forward events from storefront to editor
frame.addEventListener('load', function() {
  // Inject bridge script into storefront
  try {
    const doc = frame.contentDocument || frame.contentWindow.document;
    const script = doc.createElement('script');
    script.textContent = \`
      (function() {
        // Report ready
        window.parent.postMessage({ type: 'bridge:ready' }, '*');

        // Make sections clickable
        document.addEventListener('click', function(e) {
          var el = e.target.closest('[data-section-id]');
          if (el) {
            e.preventDefault();
            window.parent.postMessage({
              type: 'section:click',
              sectionId: el.dataset.sectionId,
            }, '*');
          }
        });

        // Hover highlighting
        document.addEventListener('mouseover', function(e) {
          var el = e.target.closest('[data-section-id]');
          document.querySelectorAll('[data-section-id]').forEach(function(s) {
            s.style.outline = '';
          });
          if (el) {
            el.style.outline = '2px solid #3b82f6';
            window.parent.postMessage({
              type: 'section:hover',
              sectionId: el.dataset.sectionId,
            }, '*');
          }
        });

        // Listen for editor commands
        window.addEventListener('message', function(e) {
          if (!e.data || !e.data.type) return;
          if (e.data.type === 'cmd:select') {
            var el = document.querySelector('[data-section-id="' + e.data.sectionId + '"]');
            if (el) {
              el.scrollIntoView({ behavior: 'smooth', block: 'center' });
              document.querySelectorAll('[data-section-id]').forEach(function(s) {
                s.style.outline = '';
              });
              el.style.outline = '2px solid #3b82f6';
            }
          }
          if (e.data.type === 'cmd:refresh') {
            window.location.reload();
          }
        });
      })();
    \`;
    doc.body.appendChild(script);
  } catch(e) {
    // Cross-origin: fallback to postMessage only
    console.warn('Cannot inject bridge (cross-origin). Using postMessage only.');
  }

  window.parent.postMessage({ type: 'bridge:ready' }, '*');
});
</script>
</body>
</html>`

    res.type('html').send(html)
  })
}
