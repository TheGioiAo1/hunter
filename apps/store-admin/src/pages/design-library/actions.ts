/**
 * Design Library — Action handlers (Phase D4)
 *
 * The only mutation today is DELETE of a clone entry:
 *
 *   POST /admin/store/:slug/design-library/clone/:slug/delete
 *       → removes ONE row from `design_library_entries`
 *       Scoped to the current shop (req.store.id). Seed entries are
 *       NEVER deletable via this path — they're a public curated list.
 *
 * Access control:
 *
 *   - Middleware already verified the caller has access to this shop
 *     (req.storeUser is set).
 *   - We additionally require storeRole === 'owner' (Level 2). Per
 *     CLAUDE.md Rule 2, admins/staff can browse the library but not
 *     remove rows — deletion is a permanent-ish action on data the
 *     merchant might want to keep for audit.
 *   - CSRF is enforced by server-level middleware, not here.
 *
 * What deletion does NOT touch:
 *
 *   - The theme produced by the original clone job (it may still be
 *     in use as a 'main' theme on this or another shop).
 *   - The clone job row itself (`storefront_clone_jobs`).
 *   - Any S3-hosted preview assets — D3 owns their lifecycle.
 *
 * We intentionally don't soft-delete. The Design Library row is a
 * presentation layer over the clone job + preview files — losing the
 * row doesn't lose any real data. A merchant who wants to resurface
 * the design can re-run the clone (deterministic slug = same row
 * would come back, plus the D2 hook is idempotent via the partial
 * unique index).
 */

import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db'
import { deleteCloneEntry } from '@gbox/core/modules/design-library/index.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function libraryUrl(slug: string, toast?: string): string {
  const base = `/admin/store/${slug}/design-library?tab=my-clones`
  return toast ? `${base}&toast=${encodeURIComponent(toast)}` : base
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

/**
 * POST /admin/store/:slug/design-library/clone/:entrySlug/delete
 *
 * 400 if entrySlug missing.
 * 403 if the caller isn't the store owner.
 * 404 if the row doesn't exist (or belongs to another shop).
 * 302 → /design-library?tab=my-clones on success.
 */
export async function postDeleteDesignLibraryEntry(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const entrySlug = String((req.params as any)?.entrySlug ?? '').trim()
  if (!entrySlug) {
    res.status(400).json({ error: 'entry_slug_required' })
    return
  }

  // Owner gate. The middleware populates `storeRole` from
  // shop_memberships.role — owner is Level 2 in the hierarchy.
  // Admin (Level 3) / Staff (Level 4) get a 403 with a clear message
  // so the UI can surface it if we ever re-expose the button to them.
  if (user.storeRole !== 'owner') {
    res.status(403).json({
      error: 'owner_required',
      message: 'Only the store owner can remove Design Library entries.',
    })
    return
  }

  try {
    const deleted = await deleteCloneEntry(db, {
      shopId: store.id,
      slug: entrySlug,
    })
    if (!deleted) {
      // The row didn't exist OR belonged to another shop. We 404 rather
      // than 200 because the caller's form pointed at a stale card — a
      // page reload will clear it and they'll see today's list.
      res.status(404).send('Not found')
      return
    }

    res.redirect(302, libraryUrl(store.slug, 'deleted'))
  } catch (err) {
    console.error('[design-library/delete]', err)
    res.status(500).send('Internal error')
  }
}
