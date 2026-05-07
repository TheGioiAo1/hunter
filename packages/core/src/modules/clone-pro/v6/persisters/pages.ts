/**
 * Clone Pro v6 — pages persister (L17 provenance-aware)
 *
 * Persists PageDTO[] into the `pages` table. Respects L17: rows with
 * source='edited' or source='manual' are NEVER overwritten by a re-clone.
 *
 * Schema deviations from the task plan (schema wins):
 *   - pages.slug  (NOT `handle`) — sourceHandle maps to slug.
 *   - pages.body_html  (NOT `body`) — confirmed from PageTable in tables.ts.
 *   - pages has NO `is_policy` column — PageTable has no such field.
 *     The isPolicy flag from the DTO is stored in clone_snapshot for
 *     reference only (Phase 22 Theme Editor can surface it if needed).
 *   - pages.published is a boolean (default false) — cloned pages land
 *     as unpublished drafts for seller review.
 */

import type { BucketPersister, PersistInput, PersistResult } from './types.js'
import type { PageDTO } from '../scrapers/types.js'
import { withSerializable } from '../../../db/transaction.js'
import { shouldOverwriteOnReclone } from './snapshot.js'

export const pagesPersister: BucketPersister<PageDTO> = {
  bucketName: 'pages',

  async persist(input: PersistInput<PageDTO>): Promise<PersistResult> {
    const out: PersistResult = { inserted: 0, updated: 0, skippedEdited: 0, errors: [] }

    await withSerializable(input.db, async (trx) => {
      for (const dto of input.dtos) {
        try {
          const existing = await (trx as any)
            .selectFrom('pages')
            .where('shop_id', '=', input.shopId)
            .where('slug', '=', dto.sourceHandle)
            .select(['id', 'source'])
            .executeTakeFirst() as { id: string; source: string } | undefined

          if (existing) {
            if (!shouldOverwriteOnReclone(existing)) {
              out.skippedEdited++
              continue
            }
            await (trx as any).updateTable('pages')
              .set({
                title: dto.title,
                body_html: dto.bodyHtml,
                source: 'clone',
              })
              .where('id', '=', existing.id)
              .execute()
            out.updated++
          } else {
            const snapshotJson = JSON.stringify({
              title: dto.title,
              body_html: dto.bodyHtml,
              is_policy: dto.isPolicy,   // preserved in snapshot even though table has no column
            })
            await (trx as any).insertInto('pages')
              .values({
                shop_id: input.shopId,
                slug: dto.sourceHandle,
                title: dto.title,
                body_html: dto.bodyHtml,
                published: false,
                clone_job_id: input.jobId,
                source: 'clone',
                clone_snapshot: snapshotJson,
              })
              .execute()
            out.inserted++
          }
        } catch (err) {
          out.errors.push({ sourceHandle: dto.sourceHandle, reason: (err as Error).message })
        }
      }
    })

    return out
  },
}
