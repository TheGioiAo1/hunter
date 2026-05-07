/**
 * Clone Pro v5 — pages persister (phase ⑤, runs inside `withSerializable`)
 *
 * Upserts each `ScrapedPage` into `pages` by (shop_id, slug). Body HTML
 * passes through the v4 sanitizer (`sanitizeClonedHtml`) before persist —
 * strips `<script>` / `<iframe>` / on-* handlers / legacy IE expressions.
 *
 * Schema deviation from the plan: `pages.published` is a boolean (default
 * false), not a `status` string. Cloned pages land as unpublished drafts so
 * the seller reviews before they go live.
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import type { ScrapedPage } from '../types.js'
import { sanitizeClonedHtml } from '../../sanitize.js'

export interface PersistPagesResult {
  readonly inserted: number
  readonly skipped: number
}

export async function persistPages(
  tx: Kysely<Database>,
  shopId: string,
  pages: readonly ScrapedPage[],
): Promise<PersistPagesResult> {
  let inserted = 0
  const skipped = 0

  for (const p of pages) {
    // No per-page try/catch — see products-persist.ts header. Swallowing
    // errors inside a pg transaction yields `25P02 aborted` for every
    // subsequent query. Let errors propagate to withSerializable.
    const safeHtml = sanitizeClonedHtml(p.body_html)
    await tx
      .insertInto('pages')
      .values({
        shop_id: shopId,
        slug: p.slug,
        title: p.title,
        body_html: safeHtml,
        published: false,
      })
      .onConflict((oc) =>
        oc.columns(['shop_id', 'slug']).doUpdateSet({
          title: p.title,
          body_html: safeHtml,
        }),
      )
      .execute()
    inserted++
  }

  return { inserted, skipped }
}
