/**
 * Store Admin — Themes list page (`/admin/store/:slug/online-store/themes`).
 *
 * Renders the seller's own themes (from the `themes` table scoped by
 * `shop_id`) with role badges (main / unpublished / demo) and asset
 * counts. The header CTA points sellers at the Theme Library where
 * they install or import a theme.
 *
 * History: this file used to also export `getCloneWizard` +
 * `postCloneWizard` for the legacy `/online-store/themes/clone` URL.
 * Both were retired on 2026-04-26 when Clone Pro was re-scoped to
 * god-admin-only concierge tooling. The themes list survives as the
 * primary surface; cloning is no longer a self-serve feature.
 *
 * The page itself renders NO merchant-supplied HTML raw — every
 * user-controlled value passes through `esc()`.
 */

import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db'
import { sellerLayout, esc } from '../layouts/seller-layout.js'
import { listThemes } from '@gbox/core/modules/themes/service.js'

// ---------------------------------------------------------------------------
// Visual helpers
// ---------------------------------------------------------------------------

function roleBadge(role: string): string {
  // Backgrounds use rgba tints (mode-agnostic — the alpha channel keeps
  // them visible on both dark and light surfaces). Foregrounds map to
  // the canonical --s-* semantic tokens so the colour follows the active
  // theme palette rather than drifting from it.
  if (role === 'main') {
    return '<span style="display:inline-block;padding:2px 10px;border-radius:9999px;font-size:11px;font-weight:600;background:rgba(34,197,94,.15);color:var(--s-success)">Main</span>'
  }
  if (role === 'demo') {
    return '<span style="display:inline-block;padding:2px 10px;border-radius:9999px;font-size:11px;font-weight:600;background:rgba(167,139,250,.15);color:var(--s-accent)">Demo</span>'
  }
  return '<span style="display:inline-block;padding:2px 10px;border-radius:9999px;font-size:11px;font-weight:600;background:rgba(107,114,128,.15);color:var(--s-text-muted)">Unpublished</span>'
}

function formatDate(d: Date | string | null | undefined): string {
  if (!d) return '—'
  const dt = typeof d === 'string' ? new Date(d) : d
  if (Number.isNaN(dt.getTime())) return '—'
  return dt.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

// ---------------------------------------------------------------------------
// GET /online-store/themes — Themes list
// ---------------------------------------------------------------------------

export async function getThemesList(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  try {
    const store = req.store!
    const user = req.storeUser!
    const theme = (req as any).theme || 'dark'
    const base = `/admin/store/${store.slug}`

    // API mode (no local DB): the themes table is Postgres-only.
    // BE has no themes endpoint yet → render empty state with Theme Library link.
    const hasDb = !!db && typeof (db as any).selectFrom === 'function'
    let themes: Awaited<ReturnType<typeof listThemes>> = []
    if (hasDb) {
      try {
        themes = await listThemes(db, store.id)
      } catch (e: any) {
        console.warn('[themes-list] DB read failed:', e?.message)
      }
    }

    const successMsg =
      typeof req.query.success === 'string' ? req.query.success : null
    const errorMsg =
      typeof req.query.error === 'string' ? req.query.error : null

    const alertHtml = successMsg
      ? `<div style="margin-bottom:16px;padding:12px 16px;border-radius:8px;background:rgba(34,197,94,.1);border:1px solid rgba(34,197,94,.25);color:var(--s-success);font-size:13px">${esc(successMsg)}</div>`
      : errorMsg
        ? `<div style="margin-bottom:16px;padding:12px 16px;border-radius:8px;background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.25);color:var(--s-danger);font-size:13px">${esc(errorMsg)}</div>`
        : ''

    // Each row links to the visual customizer (Phase 23 PR1+). 'Edit code'
    // hovers in as a secondary action so power users still reach the
    // Monaco editor without an extra click. Pre-cleanup the row was a
    // plain <tr> with no anchor — sellers couldn't open a theme.
    const rows =
      themes.length === 0
        ? `<tr><td colspan="4" style="text-align:center;padding:32px;color:var(--s-text-secondary);font-size:13px">No themes yet. Open the Theme Library to install one.</td></tr>`
        : themes
            .map(
              (t) => `
        <tr class="tc-theme-row" data-href="${base}/themes/${esc(String(t.id))}/customize" style="cursor:pointer">
          <td>
            <a href="${base}/themes/${esc(String(t.id))}/customize" style="color:inherit;text-decoration:none;display:block">
              <div style="font-weight:600;font-size:13px">${esc(t.name)}</div>
              <div style="font-size:11px;color:var(--s-text-secondary);margin-top:2px">ID: ${esc(String(t.id))}</div>
            </a>
          </td>
          <td>${roleBadge(String(t.role))}</td>
          <td style="font-size:12px;color:var(--s-text-secondary)">${formatDate(t.created_at as any)}</td>
          <td style="font-size:12px;color:var(--s-text-secondary)">
            ${formatDate(t.updated_at as any)}
            <span class="tc-theme-row-actions" style="float:right">
              <a href="${base}/online-store/themes/${esc(String(t.id))}/editor" style="font-size:11px;color:var(--s-text-secondary);text-decoration:none;padding:2px 6px;border:1px solid var(--s-border);border-radius:4px" onclick="event.stopPropagation()">Edit code</a>
            </span>
          </td>
        </tr>
      `,
            )
            .join('')

    const content = `
      <div class="page-header" style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:24px">
        <div>
          <a href="${base}/online-store" style="color:var(--s-text-secondary);text-decoration:none;font-size:12px;display:flex;align-items:center;gap:4px;margin-bottom:4px">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M10 12L6 8l4-4"/></svg>
            Online Store
          </a>
          <h2 class="page-title" style="margin:0">Themes</h2>
          <p class="page-subtitle">Manage your storefront themes. Install from the Theme Library or upload your own .zip.</p>
        </div>
        <a href="${base}/online-store/library" class="btn btn-primary" style="text-decoration:none;display:inline-flex;align-items:center;gap:6px">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3v10M3 8h10"/></svg>
          Open Theme Library
        </a>
      </div>

      ${alertHtml}

      <!-- 2026-04-26 cleanup — removed redundant 'Start cloning' hero
           card. The single 'Clone a website' button (top-right) is
           the canonical CTA; the banner duplicated its destination
           and ate vertical space above the themes table. -->

      <!-- Themes table -->
      <div class="card">
        <div class="card-header" style="display:flex;justify-content:space-between;align-items:center">
          <h3 style="margin:0;font-size:14px;font-weight:600">Your themes</h3>
          <span style="font-size:12px;color:var(--s-text-secondary)">${themes.length} theme${themes.length === 1 ? '' : 's'}</span>
        </div>
        <div class="card-body" style="padding:0">
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th style="width:50%">Name</th>
                  <th style="width:120px">Role</th>
                  <th style="width:140px">Created</th>
                  <th style="width:140px">Updated</th>
                </tr>
              </thead>
              <tbody>
                ${rows}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    `

    res.send(
      sellerLayout({
        title: 'Themes',
        storeName: store.name,
        storeSlug: store.slug,
        userName: user.name,
        userEmail: user.email,
        userRole: user.role,
        storeRole: user.storeRole,
        activePage: 'online-store',
        theme,
        content,
      }),
    )
  } catch (err) {
    console.error('[theme-clone] getThemesList error:', err)
    res.status(500).send('Internal server error')
  }
}
