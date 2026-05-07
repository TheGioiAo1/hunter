# Theme Builder Implementation Plan — Overview

> **Spec:** [`docs/superpowers/specs/2026-04-26-theme-builder-prd.md`](../../specs/2026-04-26-theme-builder-prd.md)
>
> **Status:** Q1-Q13 LOCKED by Thai 2026-04-26. Coding starts.
>
> **Branch root:** `feat/theme-builder-pr1-customizer-shell` cut from `master` (post-Phase-22).

## Goal

Ship Shopify-class visual theme editor for Gbox Platform sellers in 8 PRs / ~12-16 weeks.

## Stack (LOCKED — corrected from PRD draft after audit)

- **Server**: Express (existing apps/store-admin pattern)
- **Templates**: Server-rendered HTML strings (template literals via `sellerLayout()`)
- **Client JS**: Vanilla TypeScript modules + inline `<script>` blocks (no React, no bundler)
- **Reactivity**: Plain JS classes + custom event dispatch (no Alpine, no htmx — keep deps minimal)
- **CDN libs**:
  - `Sortable.js` (drag-drop) — 30KB
  - `Tiptap` (richtext renderer in PR2/5) — 100KB
  - `Monaco Editor` (existing, already loaded for code editor)
- **State**: per-tab `Map<sectionId, settings>` in editor module + persistence via PATCH endpoints
- **Iframe protocol**: native `postMessage` (no library)

## 8 PR Roadmap

| # | PR | Days | Branch | Status |
|---|----|------|--------|--------|
| 1 | Customizer Shell + Sidebar (read-only) | 10 | `feat/theme-builder-pr1-customizer-shell` | in progress |
| 2 | Right Panel + 8 most-common renderers | 10 | `feat/theme-builder-pr2-renderers-basic` | pending |
| 3 | Mutations (CRUD + reorder) + autosave | 10 | `feat/theme-builder-pr3-mutations` | pending |
| 4 | Inspector overlay (in-iframe JS) | 7 | `feat/theme-builder-pr4-inspector` | pending |
| 5 | Remaining 17+ setting renderers | 10 | `feat/theme-builder-pr5-renderers-full` | pending |
| 6 | Publish flow + undo/redo + restore | 7 | `feat/theme-builder-pr6-publish` | pending |
| 7 | CSS hot inject + viewport + visible_if | 10 | `feat/theme-builder-pr7-perf` | pending |
| 8 | Add-section modal + theme settings + polish | 7 | `feat/theme-builder-pr8-polish` | pending |

Engine extensions (5) + migrations (3 new + 1 ALTER) ship as backend tasks within respective PRs.

## Phase files (detailed task breakdown)

- [phase-01-shell.md](./phase-01-shell.md) — Sprint 1, in progress
- (phase-02 to phase-08 written before each sprint starts, not all upfront)

## Iron principles for every PR

1. **DEV-FIRST**: Test on isolated dev shop before any production touch
2. **No production code merge until smoke green**: each PR has live smoke test gate
3. **Build pipeline check first**: verify `tsx` resolution + no `.js` cache shadowing before each PR
4. **Iron Rule 5**: every error → `safeMessage()`, no god-admin path leak
5. **Ship small + iterate**: PR1 scope = read-only shell. No mutations. Don't try to do PR2 in PR1.

## Lessons learned from Clone Pro v7 (carry forward)

- ❌ Don't ship code untested in production — verify E2E first
- ❌ Don't merge "PR ready" before live smoke — paper tests aren't enough
- ❌ Don't restart pm2 single service — `pm2 reload all --update-env` always
- ❌ Don't add code that depends on `globalThis` factory without confirming caller invokes it
- ✅ Run smoke from server 2 (matches prod env), not local Windows
- ✅ Audit existing infrastructure exhaustively before designing new modules
- ✅ Use isolated test shop (`v7-dev-test` pattern), never touch production data during dev

## Definition of Done — MVP

After PR8 merges:
- [ ] Seller logs in → `/admin/store/<slug>/themes/customize` opens 3-pane editor
- [ ] Sees current sections in sidebar tree
- [ ] Clicks section → right panel shows settings
- [ ] Drags sections to reorder → autosaves to draft
- [ ] Edits color → preview updates in <300ms
- [ ] Hits Publish → live storefront updates within 2s
- [ ] All 25+ setting types render correctly
- [ ] Lighthouse score ≥ 80 on default Dawn-fork theme
- [ ] 5 sellers tested complete "change hero image + publish" in <5 min, 0 code edits
