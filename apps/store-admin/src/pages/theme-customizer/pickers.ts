/**
 * Theme Customizer — Picker route handlers (Sprint 8 PR-D)
 *
 * Five thin GET handlers that expose @gbox/core's picker-search service
 * to the customizer's right-panel form. Each returns a uniform
 * { items: PickerItem[] } payload.
 *
 * Routes:
 *   GET /admin/store/:slug/online-store/picker/products?q=&limit=
 *   GET /admin/store/:slug/online-store/picker/collections?q=&limit=
 *   GET /admin/store/:slug/online-store/picker/pages?q=&limit=
 *   GET /admin/store/:slug/online-store/picker/blogs?q=&limit=
 *   GET /admin/store/:slug/online-store/picker/articles?q=&limit=
 *
 * Iron Rule 5: errors → safeMessage. Cross-shop probes are impossible
 * because every picker scopes by req.store!.id directly.
 */

import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db'
import { safeMessage } from '@gbox/core/modules/support/safe-message.js'
import {
  searchProducts,
  searchCollections,
  searchPages,
  searchBlogs,
  searchArticles,
} from '@gbox/core/modules/themes/customizer/picker-search.js'

type Searcher = typeof searchProducts

function makePicker(searcher: Searcher) {
  return async (req: Request, res: Response, db: Kysely<Database>): Promise<void> => {
    const store = req.store!
    const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : ''
    const rawLimit = req.query.limit
    const limit = typeof rawLimit === 'string' ? Number(rawLimit) : 20
    try {
      const result = await searcher(db, store.id, q, limit)
      res.json(result)
    } catch (err) {
      res.status(500).json({ error: safeMessage(err as Error).safe })
    }
  }
}

export const getProductPicker = makePicker(searchProducts)
export const getCollectionPicker = makePicker(searchCollections)
export const getPagePicker = makePicker(searchPages)
export const getBlogPicker = makePicker(searchBlogs)
export const getArticlePicker = makePicker(searchArticles)
