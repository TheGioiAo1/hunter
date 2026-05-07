/**
 * Store Admin — Theme Customizer (PR1: shell + read-only sidebar)
 *
 * Routes:
 *   GET /admin/store/:slug/themes/:themeId/customize
 *     → renders 3-pane SSR shell (top bar, sidebar, iframe, right panel)
 *
 *   GET /admin/store/:slug/themes/:themeId/customize/sections.json?template=index
 *     → returns { sections: SectionTreeNode[] } for sidebar to render
 *
 *   GET /admin/store/:slug/themes/:themeId/customize/preview-url?template=index
 *     → returns { url, template } — storefront preview URL with theme query
 *
 * Iron Rule 5: every error path → safeMessage(). Theme ownership scope
 * enforced before any DB read so cross-shop probes 404 cleanly.
 *
 * Subsequent PRs (2-8) extend this same module — PR2 adds settings JSON
 * endpoint, PR3 adds mutation routes (POST/PATCH/DELETE), etc.
 */

import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db'
import { safeMessage } from '@gbox/core/modules/support/safe-message.js'
import { getTheme, setActiveTheme } from '@gbox/core/modules/themes/service.js'
import { loadSectionsTree } from '@gbox/core/modules/themes/customizer/sections-tree.js'
import { loadSectionSettings } from '@gbox/core/modules/themes/customizer/section-settings.js'
import {
  updateSectionSettings,
  updateSectionBlocks,
  toggleSectionVisibility,
  addSection,
  removeSection,
  reorderSections,
} from '@gbox/core/modules/themes/customizer/section-mutations.js'
import {
  createSnapshot,
  listVersions,
  restoreVersion,
} from '@gbox/core/modules/themes/customizer/versions.js'
import { signPreviewToken } from '@gbox/core/modules/themes/preview-token.js'
import { renderShell } from './server-render.js'

const DEFAULT_TEMPLATE = 'index'

// ---------------------------------------------------------------------------
// GET /admin/store/:slug/themes/:themeId/customize
// ---------------------------------------------------------------------------

export async function getThemeCustomizer(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const themeId = String(req.params.themeId ?? '')
  const base = `/admin/store/${store.slug}`
  const currentTemplate = sanitizeTemplate(req.query.template as unknown)

  try {
    const theme = await getTheme(db, themeId)

    // Theme ownership scope — same pattern as theme-editor.ts. Without
    // this, any authenticated seller could probe /customize on another
    // shop's theme id. We redirect (not 404) to keep the UX consistent
    // with the existing theme list.
    if (!theme || (theme as any).shop_id !== store.id) {
      res.redirect(`${base}/online-store/themes`)
      return
    }

    const html = renderShell({
      store,
      user,
      theme,
      currentTemplate,
      base,
      csrfToken: (req as any).csrfToken ?? '',
      pageTheme: (req as any).theme || 'dark',
    })

    res.setHeader('Content-Type', 'text/html; charset=utf-8').send(html)
  } catch (err) {
    // Iron Rule 5: don't expose internals.
    res.status(500).send(safeMessage(err as Error).safe)
  }
}

// ---------------------------------------------------------------------------
// GET /admin/store/:slug/themes/:themeId/customize/sections.json?template=index
// ---------------------------------------------------------------------------

export async function getSectionsJson(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const themeId = String(req.params.themeId ?? '')
  const template = sanitizeTemplate(req.query.template as unknown)

  try {
    const theme = await getTheme(db, themeId)
    if (!theme || (theme as any).shop_id !== store.id) {
      res.status(404).json({ error: 'not_found' })
      return
    }

    const sections = await loadSectionsTree(db, themeId, template)
    res.json({ sections, template })
  } catch (err) {
    res.status(500).json({ error: safeMessage(err as Error).safe })
  }
}

// ---------------------------------------------------------------------------
// GET /admin/store/:slug/themes/:themeId/customize/preview-url?template=index
// ---------------------------------------------------------------------------

export async function getPreviewUrl(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const themeId = String(req.params.themeId ?? '')
  const template = sanitizeTemplate(req.query.template as unknown)

  try {
    const theme = await getTheme(db, themeId)
    if (!theme || (theme as any).shop_id !== store.id) {
      res.status(404).json({ error: 'not_found' })
      return
    }

    // Sprint 9: mint a real HMAC-signed preview token so the storefront
    // theme-preview middleware swaps the active theme for THIS request
    // only, stamps `X-Robots-Tag: noindex, nofollow`, and never leaks
    // the draft into the public theme. When THEME_PREVIEW_SECRET is
    // unset the storefront middleware is a no-op — the iframe will
    // render the published theme. We fall back to an unsigned link in
    // that case so dev environments without the secret still work
    // (the customizer will preview against the live theme; the seller
    // sees their structural changes only after publish).
    const path = template === 'index' ? '/' : `/${template}`
    const host = (store as any).domain || `${store.slug}.gbox.co`
    const secret = process.env.THEME_PREVIEW_SECRET || ''

    let url: string
    if (secret.length > 0) {
      const adminId =
        typeof (req.storeUser as any)?.id === 'string'
          ? String((req.storeUser as any).id)
          : 'admin'
      const token = signPreviewToken(secret, {
        shopId: store.id,
        themeId,
        adminId,
      })
      url =
        `https://${host}${path}` +
        `?preview_theme_id=${encodeURIComponent(themeId)}` +
        `&preview_token=${encodeURIComponent(token)}`
    } else {
      // Dev fallback — no secret configured. The customizer iframe
      // shows the live theme; settings changes still write to DB but
      // won't render until Sprint 10's publish flow.
      url = `https://${host}${path}?_gbox_preview_theme=${encodeURIComponent(themeId)}`
    }

    res.json({ url, template })
  } catch (err) {
    res.status(500).json({ error: safeMessage(err as Error).safe })
  }
}

// ---------------------------------------------------------------------------
// GET /admin/store/:slug/themes/:themeId/customize/sections/:sectionId/schema.json
// — return one section's settings + schema for the right-panel form.
// ---------------------------------------------------------------------------

export async function getSectionSchema(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const themeId = String(req.params.themeId ?? '')
  const sectionId = String(req.params.sectionId ?? '')

  try {
    const theme = await getTheme(db, themeId)
    if (!theme || (theme as any).shop_id !== store.id) {
      res.status(404).json({ error: 'not_found' })
      return
    }
    const payload = await loadSectionSettings(db, sectionId)
    if (!payload || payload.themeId !== themeId) {
      res.status(404).json({ error: 'not_found' })
      return
    }
    res.json(payload)
  } catch (err) {
    res.status(500).json({ error: safeMessage(err as Error).safe })
  }
}

// ---------------------------------------------------------------------------
// POST /admin/store/:slug/themes/:themeId/customize/sections/:sectionId/settings
// body: { patch: Record<string, unknown> }
// ---------------------------------------------------------------------------

export async function postSectionSettings(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const themeId = String(req.params.themeId ?? '')
  const sectionId = String(req.params.sectionId ?? '')
  const patch = (req.body && typeof req.body === 'object' && (req.body as any).patch) || {}

  try {
    const ok = await assertSectionOwnership(db, store.id, themeId, sectionId)
    if (!ok) {
      res.status(404).json({ error: 'not_found' })
      return
    }
    const merged = await updateSectionSettings(db, sectionId, patch)
    res.json({ ok: true, settings: merged })
  } catch (err) {
    res.status(400).json({ error: safeMessage(err as Error).safe })
  }
}

// ---------------------------------------------------------------------------
// POST /admin/store/:slug/themes/:themeId/customize/sections/:sectionId/blocks
// body: { blocks: unknown[] }
// ---------------------------------------------------------------------------

export async function postSectionBlocks(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const themeId = String(req.params.themeId ?? '')
  const sectionId = String(req.params.sectionId ?? '')
  const blocks = Array.isArray(req.body?.blocks) ? req.body.blocks : null

  try {
    const ok = await assertSectionOwnership(db, store.id, themeId, sectionId)
    if (!ok) {
      res.status(404).json({ error: 'not_found' })
      return
    }
    if (blocks === null) {
      res.status(400).json({ error: 'Blocks payload must be an array.' })
      return
    }
    await updateSectionBlocks(db, sectionId, blocks)
    res.json({ ok: true })
  } catch (err) {
    res.status(400).json({ error: safeMessage(err as Error).safe })
  }
}

// ---------------------------------------------------------------------------
// POST /admin/store/:slug/themes/:themeId/customize/sections/:sectionId/visibility
// body: { enabled: boolean }
// ---------------------------------------------------------------------------

export async function postSectionVisibility(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const themeId = String(req.params.themeId ?? '')
  const sectionId = String(req.params.sectionId ?? '')
  const enabled = req.body?.enabled === true

  try {
    const ok = await assertSectionOwnership(db, store.id, themeId, sectionId)
    if (!ok) {
      res.status(404).json({ error: 'not_found' })
      return
    }
    await toggleSectionVisibility(db, sectionId, enabled)
    res.json({ ok: true, enabled })
  } catch (err) {
    res.status(400).json({ error: safeMessage(err as Error).safe })
  }
}

// ---------------------------------------------------------------------------
// POST /admin/store/:slug/themes/:themeId/customize/sections/add
// body: { type: string, template?: string, presetIndex?: number, insertAfterId?: string }
// ---------------------------------------------------------------------------

export async function postAddSection(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const themeId = String(req.params.themeId ?? '')
  const body = (req.body || {}) as {
    type?: unknown
    template?: unknown
    presetIndex?: unknown
    insertAfterId?: unknown
  }
  const type = typeof body.type === 'string' ? body.type.trim() : ''
  const pageType = sanitizeTemplate(typeof body.template === 'string' ? body.template : 'index')
  const presetIndex = typeof body.presetIndex === 'number' ? body.presetIndex : undefined
  const insertAfterId = typeof body.insertAfterId === 'string' && body.insertAfterId.length > 0
    ? body.insertAfterId
    : null

  if (!type || !/^[a-z0-9][a-z0-9_-]{1,60}$/.test(type)) {
    res.status(400).json({ error: 'Invalid section type.' })
    return
  }

  try {
    const theme = await getTheme(db, themeId)
    if (!theme || (theme as any).shop_id !== store.id) {
      res.status(404).json({ error: 'not_found' })
      return
    }
    const out = await addSection(db, {
      themeId,
      pageType,
      type,
      presetIndex,
      insertAfterId,
    })
    res.json({ ok: true, ...out })
  } catch (err) {
    res.status(400).json({ error: safeMessage(err as Error).safe })
  }
}

// ---------------------------------------------------------------------------
// DELETE /admin/store/:slug/themes/:themeId/customize/sections/:sectionId
// ---------------------------------------------------------------------------

export async function deleteSectionRoute(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const themeId = String(req.params.themeId ?? '')
  const sectionId = String(req.params.sectionId ?? '')

  try {
    const ok = await assertSectionOwnership(db, store.id, themeId, sectionId)
    if (!ok) {
      res.status(404).json({ error: 'not_found' })
      return
    }
    await removeSection(db, sectionId)
    res.json({ ok: true })
  } catch (err) {
    res.status(400).json({ error: safeMessage(err as Error).safe })
  }
}

// ---------------------------------------------------------------------------
// POST /admin/store/:slug/themes/:themeId/customize/sections/reorder
// body: { template: string, orderedIds: string[] }
// ---------------------------------------------------------------------------

export async function postReorderSections(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const themeId = String(req.params.themeId ?? '')
  const body = (req.body || {}) as { template?: unknown; orderedIds?: unknown }
  const pageType = sanitizeTemplate(typeof body.template === 'string' ? body.template : 'index')
  const orderedIds = Array.isArray(body.orderedIds)
    ? body.orderedIds.filter((x): x is string => typeof x === 'string')
    : null

  try {
    const theme = await getTheme(db, themeId)
    if (!theme || (theme as any).shop_id !== store.id) {
      res.status(404).json({ error: 'not_found' })
      return
    }
    if (!orderedIds) {
      res.status(400).json({ error: 'orderedIds must be a string array.' })
      return
    }
    await reorderSections(db, themeId, pageType, orderedIds)
    res.json({ ok: true })
  } catch (err) {
    res.status(400).json({ error: safeMessage(err as Error).safe })
  }
}

// ---------------------------------------------------------------------------
// POST /admin/store/:slug/themes/:themeId/customize/publish
// — Snapshot the current state (status='published'), promote theme to
//   role='main', demote any prior main to role='unpublished'.
// ---------------------------------------------------------------------------

export async function postPublishTheme(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const themeId = String(req.params.themeId ?? '')
  const label = typeof req.body?.label === 'string' ? req.body.label.trim() : null
  const userId = typeof (req.storeUser as any)?.id === 'string' ? String((req.storeUser as any).id) : null

  try {
    const theme = await getTheme(db, themeId)
    if (!theme || (theme as any).shop_id !== store.id) {
      res.status(404).json({ error: 'not_found' })
      return
    }
    // Snapshot first — if anything fails between snapshot and promote
    // we still have a published-status row pointing at the captured
    // state, which the customizer's "Restore" button can use to roll back.
    const snapshot = await createSnapshot(db, themeId, {
      status: 'published',
      label: label || null,
      createdBy: userId,
    })
    // Promote inside a transaction (setActiveTheme already wraps both
    // updates in a tx — we don't double-wrap).
    await setActiveTheme(db, store.id, themeId)
    res.json({ ok: true, versionId: snapshot.id, version: snapshot.version })
  } catch (err) {
    res.status(500).json({ error: safeMessage(err as Error).safe })
  }
}

// ---------------------------------------------------------------------------
// POST /admin/store/:slug/themes/:themeId/customize/snapshot
// — manual draft snapshot ("Save snapshot" button).
// ---------------------------------------------------------------------------

export async function postCreateSnapshot(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const themeId = String(req.params.themeId ?? '')
  const label = typeof req.body?.label === 'string' ? req.body.label.trim() : null
  const userId = typeof (req.storeUser as any)?.id === 'string' ? String((req.storeUser as any).id) : null

  try {
    const theme = await getTheme(db, themeId)
    if (!theme || (theme as any).shop_id !== store.id) {
      res.status(404).json({ error: 'not_found' })
      return
    }
    const out = await createSnapshot(db, themeId, {
      status: 'draft',
      label: label || null,
      createdBy: userId,
    })
    res.json({ ok: true, versionId: out.id, version: out.version })
  } catch (err) {
    res.status(500).json({ error: safeMessage(err as Error).safe })
  }
}

// ---------------------------------------------------------------------------
// GET /admin/store/:slug/themes/:themeId/customize/versions.json
// — list past versions for the dropdown.
// ---------------------------------------------------------------------------

export async function getVersionsJson(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const themeId = String(req.params.themeId ?? '')
  try {
    const theme = await getTheme(db, themeId)
    if (!theme || (theme as any).shop_id !== store.id) {
      res.status(404).json({ error: 'not_found' })
      return
    }
    const versions = await listVersions(db, themeId, 30)
    res.json({ versions })
  } catch (err) {
    res.status(500).json({ error: safeMessage(err as Error).safe })
  }
}

// ---------------------------------------------------------------------------
// POST /admin/store/:slug/themes/:themeId/customize/versions/:versionId/restore
// ---------------------------------------------------------------------------

export async function postRestoreVersion(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const themeId = String(req.params.themeId ?? '')
  const versionId = String(req.params.versionId ?? '')
  const userId = typeof (req.storeUser as any)?.id === 'string' ? String((req.storeUser as any).id) : null
  try {
    const theme = await getTheme(db, themeId)
    if (!theme || (theme as any).shop_id !== store.id) {
      res.status(404).json({ error: 'not_found' })
      return
    }
    // Auto-snapshot current state so the seller can undo a bad restore.
    await createSnapshot(db, themeId, {
      status: 'draft',
      label: 'Auto-saved before restore',
      createdBy: userId,
    })
    const out = await restoreVersion(db, themeId, versionId)
    res.json({ ok: true, restored: out.restored })
  } catch (err) {
    res.status(400).json({ error: safeMessage(err as Error).safe })
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Cross-shop probe defence: a section is owned by `shopId` only when both
 * (a) its parent theme belongs to that shop AND (b) the section_type
 * lives in that theme's page_sections row. We verify both with one
 * extra query — the hot path (settings load + edit) tolerates the
 * round-trip just fine.
 */
async function assertSectionOwnership(
  db: Kysely<Database>,
  shopId: string,
  themeId: string,
  sectionId: string,
): Promise<boolean> {
  const theme = await getTheme(db, themeId)
  if (!theme || (theme as any).shop_id !== shopId) return false
  const row = (await (db as any)
    .selectFrom('theme_page_sections')
    .select(['theme_id'])
    .where('id', '=', sectionId)
    .executeTakeFirst()) as { theme_id: string } | undefined
  return row?.theme_id === themeId
}

/**
 * Whitelist allowed template names so a malicious `?template=../../etc`
 * never lands in DB queries or URL paths.
 */
function sanitizeTemplate(raw: unknown): string {
  if (typeof raw !== 'string' || !raw) return DEFAULT_TEMPLATE
  // Only kebab/lower alphanum + slash for nested templates (e.g. customers/login).
  if (!/^[a-z0-9][a-z0-9/_-]{0,60}$/.test(raw)) return DEFAULT_TEMPLATE
  return raw
}

// Internal helpers exported only for tests.
export const __test = { sanitizeTemplate }
