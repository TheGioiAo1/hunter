# Phase 01 — PR1: Customizer Shell + Sidebar (READ-ONLY)

**Date:** 2026-04-26 → 2026-05-06 (10 days)
**Priority:** CRITICAL — foundation for PR2-8
**Branch:** `feat/theme-builder-pr1-customizer-shell`
**Base:** master (post-Phase 22)

## Goal

Sellers open `/admin/store/<slug>/themes/<id>/customize` and see the 3-pane Theme Customizer shell. Sidebar lists current theme's sections (read from `theme_page_sections`). Center iframe loads storefront preview. Right panel shows placeholder until section selected. **No mutations** — read-only browse.

## Non-goals (defer to later PRs)

- Mutations (PR3)
- Schema-driven setting forms (PR2)
- Inspector overlay (PR4)
- Preview re-render protocol (PR3)
- Add-section modal (PR8)

## Files

```
apps/store-admin/src/pages/theme-customizer/
├── index.ts                  # NEW: route handlers (GET shell + JSON list)
├── server-render.ts          # NEW: SSR HTML shell with embedded JS module
├── client.ts                 # NEW: vanilla TS module embedded in shell
└── theme-customizer.test.ts  # NEW: server-side tests

apps/store-admin/src/server.ts  # MODIFY: register routes

packages/core/src/modules/themes/customizer/
└── sections-tree.ts          # NEW: read theme_page_sections, group by template
```

## Tasks

- [ ] **1.1** Add 3 routes to `apps/store-admin/src/server.ts`:
  - `GET /admin/store/:slug/themes/:themeId/customize` → render shell
  - `GET /admin/store/:slug/themes/:themeId/customize/sections.json?template=index` → JSON section list
  - `GET /admin/store/:slug/themes/:themeId/customize/preview-url?template=index` → returns signed iframe URL

- [ ] **1.2** Implement `sections-tree.ts`:
  - Function `loadSectionsTree(db, themeId, templateName)` returns `Section[]`
  - Joins `theme_page_sections` with `theme_section_schemas` for display name + icon
  - Returns ordered list: `{ id, key, type, name, icon, position, enabled, hasBlocks, blockCount }`
  - Unit tests: 5 cases (empty, ordered, includes hidden, blocks count, schema missing fallback)

- [ ] **1.3** Implement `theme-customizer/index.ts`:
  - GET shell: validates theme ownership, calls `renderShell(theme, store)`, returns HTML
  - GET sections.json: calls `loadSectionsTree`, returns JSON array
  - GET preview-url: builds preview URL with signed token (Q9 — defer to PR3, hardcode for now)
  - Iron Rule 5: errors via `safeMessage()`

- [ ] **1.4** Implement `server-render.ts`:
  - Returns HTML string using `sellerLayout()`
  - Injects 3-pane CSS (grid layout)
  - Injects `client.ts` module as inline `<script type="module">`
  - Loads Sortable.js from CDN (used in PR3, register now)
  - Skeleton structure: top bar, sidebar shell, iframe placeholder, right panel placeholder

- [ ] **1.5** Implement `client.ts` vanilla TS module (PR1 scope: just bootstrap + sidebar):
  - `class ThemeCustomizer` with constructor accepting `{ themeId, storeSlug, currentTemplate }`
  - `init()` method: fetch sections.json, render sidebar tree
  - Sidebar items: clickable (just highlights selection in PR1, no panel update)
  - Custom event: `theme-customizer:section-selected` (other PRs subscribe)
  - Module exports `bootstrap(config)` for inline `<script>` to call

- [ ] **1.6** Tests:
  - `theme-customizer.test.ts`: route auth check, JSON shape, ownership scope
  - `sections-tree.test.ts`: 5 cases (already in 1.2)
  - Manual smoke: navigate to URL, see shell with sections from existing theme

- [ ] **1.7** Build + restart store-admin + verify

## Detailed implementation per task

### Task 1.1 — Server routes

```typescript
// apps/store-admin/src/server.ts (MODIFY)
import { getThemeCustomizer, getSectionsJson, getPreviewUrl } from './pages/theme-customizer/index.js'

// In route registration block:
app.get(
  '/admin/store/:slug/themes/:themeId/customize',
  storeAuth,
  pageLimiter,
  (req, res) => getThemeCustomizer(req, res, db),
)
app.get(
  '/admin/store/:slug/themes/:themeId/customize/sections.json',
  storeAuth,
  apiReadLimiter,
  (req, res) => getSectionsJson(req, res, db),
)
app.get(
  '/admin/store/:slug/themes/:themeId/customize/preview-url',
  storeAuth,
  apiReadLimiter,
  (req, res) => getPreviewUrl(req, res, db),
)
```

### Task 1.2 — sections-tree.ts

```typescript
// packages/core/src/modules/themes/customizer/sections-tree.ts
import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db'

export interface SectionTreeNode {
  id: string
  key: string
  type: string
  name: string         // display name from schema or fallback to type
  icon: string         // icon name from schema or default
  position: number
  enabled: boolean
  hasBlocks: boolean
  blockCount: number
}

export async function loadSectionsTree(
  db: Kysely<Database>,
  themeId: string,
  templateName: string = 'index',
): Promise<SectionTreeNode[]> {
  const rows = await (db as any)
    .selectFrom('theme_page_sections as tps')
    .leftJoin('theme_section_schemas as tss', 'tss.type', 'tps.section_type')
    .select([
      'tps.id',
      'tps.section_key as key',
      'tps.section_type as type',
      'tps.position',
      'tps.enabled',
      'tps.blocks_json',
      'tss.name as schemaName',
      'tss.icon as schemaIcon',
    ])
    .where('tps.theme_id', '=', themeId)
    .where('tps.page_type', '=', templateName)
    .orderBy('tps.position', 'asc')
    .execute()

  return rows.map((r: any) => ({
    id: r.id as string,
    key: r.key as string,
    type: r.type as string,
    name: r.schemaName ?? humanizeType(r.type),
    icon: r.schemaIcon || 'box',
    position: r.position as number,
    enabled: r.enabled as boolean,
    hasBlocks: Array.isArray(r.blocks_json) && r.blocks_json.length > 0,
    blockCount: Array.isArray(r.blocks_json) ? r.blocks_json.length : 0,
  }))
}

function humanizeType(t: string): string {
  return t.split(/[-_]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
}
```

### Task 1.3 — index.ts (route handlers)

```typescript
// apps/store-admin/src/pages/theme-customizer/index.ts
import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db'
import { safeMessage } from '@gbox/core/modules/support/safe-message.js'
import { getTheme } from '@gbox/core/modules/themes/service.js'
import { loadSectionsTree } from '@gbox/core/modules/themes/customizer/sections-tree.js'
import { renderShell } from './server-render.js'

export async function getThemeCustomizer(req: Request, res: Response, db: Kysely<Database>): Promise<void> {
  const store = req.store!
  const themeId = req.params.themeId
  const base = `/admin/store/${store.slug}`

  try {
    const theme = await getTheme(db, themeId)
    if (!theme || (theme as any).shop_id !== store.id) {
      res.redirect(`${base}/online-store/themes`)
      return
    }
    const html = renderShell({
      store, theme, currentTemplate: (req.query.template as string) ?? 'index',
      base, csrfToken: req.csrfToken ?? '',
    })
    res.setHeader('Content-Type', 'text/html; charset=utf-8').send(html)
  } catch (err) {
    res.status(500).send(safeMessage(err as Error).safe)
  }
}

export async function getSectionsJson(req: Request, res: Response, db: Kysely<Database>): Promise<void> {
  const store = req.store!
  const themeId = req.params.themeId
  const template = (req.query.template as string) ?? 'index'

  try {
    const theme = await getTheme(db, themeId)
    if (!theme || (theme as any).shop_id !== store.id) {
      res.status(404).json({ error: 'not_found' })
      return
    }
    const sections = await loadSectionsTree(db, themeId, template)
    res.json({ sections })
  } catch (err) {
    res.status(500).json({ error: safeMessage(err as Error).safe })
  }
}

export async function getPreviewUrl(req: Request, res: Response, db: Kysely<Database>): Promise<void> {
  const store = req.store!
  const themeId = req.params.themeId
  const template = (req.query.template as string) ?? 'index'

  // PR1: return storefront URL with theme_id query (no signed token yet — Q9 in PR3)
  // The storefront's existing handler will respect ?_gbox_preview_theme=<id> in PR3.
  // For PR1, just return the live storefront so seller sees something.
  const path = template === 'index' ? '/' : `/${template}`
  const previewUrl = store.domain
    ? `https://${store.domain}${path}?_gbox_preview_theme=${themeId}`
    : `https://${store.slug}.gbox.co${path}?_gbox_preview_theme=${themeId}`
  res.json({ url: previewUrl, template })
}
```

### Task 1.4 — server-render.ts (SSR shell)

Renders 3-pane HTML with embedded JS module. Uses CSS Grid for layout. Injects `client.ts` via TypeScript-compiled inline script (since store-admin uses `tsx` runtime, scripts are emitted as JS at request time).

Strategy: write the client JS as an inline string in `server-render.ts` (export const CLIENT_JS = `...`) for PR1 simplicity. Later PRs can extract to `client.ts` if size grows.

Output structure (skeleton):

```html
<div class="tc-app" data-theme-id="..." data-store-slug="...">
  <header class="tc-topbar"> ... </header>
  <main class="tc-grid">
    <aside class="tc-sidebar"> <!-- sections tree --> </aside>
    <div class="tc-preview"> <iframe ...></iframe> </div>
    <aside class="tc-rightpanel"> <!-- empty in PR1 --> </aside>
  </main>
  <script type="module"> /* inline CLIENT_JS */ </script>
</div>
```

Full code in implementation step.

### Task 1.5 — client.ts (vanilla TS bootstrap)

PR1 minimal: fetch sections.json, render sidebar items, click highlights.

```typescript
class ThemeCustomizer {
  themeId: string
  storeSlug: string
  currentTemplate: string
  sections: SectionTreeNode[] = []
  selectedSectionId: string | null = null

  constructor(config: { themeId: string; storeSlug: string; currentTemplate: string }) {
    this.themeId = config.themeId
    this.storeSlug = config.storeSlug
    this.currentTemplate = config.currentTemplate
  }

  async init() {
    await this.loadSections()
    this.renderSidebar()
    this.loadPreview()
  }

  async loadSections() {
    const res = await fetch(`/admin/store/${this.storeSlug}/themes/${this.themeId}/customize/sections.json?template=${this.currentTemplate}`)
    const data = await res.json()
    this.sections = data.sections
  }

  async loadPreview() {
    const res = await fetch(`/admin/store/${this.storeSlug}/themes/${this.themeId}/customize/preview-url?template=${this.currentTemplate}`)
    const { url } = await res.json()
    const iframe = document.querySelector<HTMLIFrameElement>('.tc-preview iframe')!
    iframe.src = url
  }

  renderSidebar() {
    const tree = document.querySelector('.tc-sidebar')!
    tree.innerHTML = this.sections.map((s) => `
      <div class="tc-section-item" data-section-id="${s.id}" data-section-type="${s.type}">
        <span class="tc-icon">${s.icon}</span>
        <span class="tc-name">${esc(s.name)}</span>
        ${s.hasBlocks ? `<span class="tc-block-count">${s.blockCount}</span>` : ''}
        ${!s.enabled ? `<span class="tc-hidden">hidden</span>` : ''}
      </div>
    `).join('')
    tree.querySelectorAll('.tc-section-item').forEach((el) => {
      el.addEventListener('click', () => this.selectSection((el as HTMLElement).dataset.sectionId!))
    })
  }

  selectSection(id: string) {
    this.selectedSectionId = id
    document.querySelectorAll('.tc-section-item').forEach((el) =>
      el.classList.toggle('selected', (el as HTMLElement).dataset.sectionId === id)
    )
    document.dispatchEvent(new CustomEvent('theme-customizer:section-selected', { detail: { id } }))
  }
}

function esc(s: string): string {
  return String(s ?? '').replace(/[<>"'&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '&': '&amp;' })[c]!)
}

;(window as any).bootstrapThemeCustomizer = (config: any) => {
  new ThemeCustomizer(config).init()
}
```

### Task 1.6 — Tests

```typescript
// theme-customizer.test.ts (server)
import { describe, it, expect } from 'vitest'
// Mock req/res/db, assert:
// - getThemeCustomizer redirects when theme.shop_id mismatches
// - getSectionsJson returns 404 when theme not in store
// - getPreviewUrl returns URL with theme_id query
// - safeMessage wraps DB errors

// sections-tree.test.ts
// - empty theme returns []
// - 3 sections returned in position order
// - schema name picked when available, fallback to humanized type
// - blockCount calculated from blocks_json
// - hidden sections still returned (filtered by client)
```

### Task 1.7 — Smoke test

```bash
# 1. ssh server 1
# 2. git pull, npm install
# 3. pm2 reload all --update-env
# 4. browser: https://admin.gbox.co/admin/store/best-store/themes/<theme-id>/customize
#    Expected: 3-pane layout renders
#    Expected: sidebar lists existing sections (or "No sections" empty state)
#    Expected: iframe loads storefront preview
#    Expected: right panel shows "Select a section to edit" placeholder
```

## Acceptance criteria

- [ ] 3 endpoints registered + auth-gated via storeAuth
- [ ] Theme ownership scope check enforced (cross-shop request → 404)
- [ ] sections-tree.test.ts: 5/5 pass
- [ ] theme-customizer.test.ts: 4/4 pass
- [ ] No TypeScript errors (`tsc --noEmit`)
- [ ] Manual smoke: shell renders + sidebar lists ≥1 section + iframe loads
- [ ] PR opened to master with description + screenshot

## Risks

| Risk | Mitigation |
|------|-----------|
| `theme_section_schemas` empty for existing shops → sidebar shows raw types | Fallback to `humanizeType()` in tree |
| Iframe blocked by CSP/X-Frame-Options on storefront | Add `frame-ancestors 'self' admin.gbox.co` to storefront response |
| Inline `<script>` blocked by store-admin CSP | Use existing nonce pattern from theme-editor.ts (CodeMirror does same) |

## Next: PR2 — Right Panel + 8 most-common renderers
