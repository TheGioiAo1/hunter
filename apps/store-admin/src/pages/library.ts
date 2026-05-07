/**
 * Online Store — Library (unified, 2026-04-26).
 *
 * Mounted at `/online-store/library`. Originally merged the previous
 * Clone Library (`/clone-library`) and Design Library (`/design-library`)
 * into a single tabbed page. As of the 2026-04-26 Clone Pro retirement
 * the Cloned-themes tab is gone (clone-pro is god-admin-only concierge
 * tooling now), so the page renders the Design Library directly.
 *
 * The `?tab=` query param is preserved to keep old bookmarks working —
 * any value (clones, designs, missing) routes through to Design Library.
 */

import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db'
import { getDesignLibraryPage } from './design-library.js'

export type LibraryTab = 'designs'

export async function getLibraryPage(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  // The downstream handler reads this off res.locals to know whether
  // it's being called as part of the unified Library page vs. its own
  // legacy URL. Tab is fixed at 'designs' after the clone-pro retirement.
  ;(res.locals as any).libraryTab = 'designs'
  ;(res.locals as any).libraryEmbedded = true
  return getDesignLibraryPage(req, res, db)
}

/**
 * Pure helper kept for backwards-compat with downstream handlers that
 * previously called it to render a tab nav above their content. After
 * the Clone Pro retirement there is only one tab, so the banner just
 * shows a header — no tablist roles, no aria-selected.
 */
export function renderLibraryTabs(_base: string, _currentTab: LibraryTab = 'designs'): string {
  return `
    <div class="lib-tabs" style="border-bottom:1px solid var(--s-border);margin-bottom:24px;padding:12px 4px">
      <span class="active" style="font-size:13px;font-weight:600;color:var(--s-text)">Design references</span>
    </div>
  `
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseTab(_raw: unknown): LibraryTab {
  // Always 'designs' after 2026-04-26 — kept as a function so tests that
  // exercise the helper still compile.
  return 'designs'
}

function tabLink(opts: { base: string; tab: LibraryTab; label: string; currentTab: LibraryTab }): string {
  return `<a href="${opts.base}/online-store/library" class="active" aria-current="page">${opts.label}</a>`
}

// Internal helpers exported only for tests.
export const __test = { parseTab, tabLink }
