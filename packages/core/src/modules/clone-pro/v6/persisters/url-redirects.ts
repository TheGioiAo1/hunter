/**
 * Clone Pro v6 — url-redirects persister (L17 provenance-aware)
 *
 * Persists UrlRedirectDTO[] into the `url_redirects` table.
 * Rows represent HTTP redirects scraped from the source site.
 * Each row is keyed by (shop_id, source_path).
 *
 * Respects L17: rows with source='edited' or source='manual' are NEVER
 * overwritten by a re-clone.
 *
 * Schema (migration 097 / `url_redirects` table):
 *   - shop_id, source_path, target_path, status_code
 *   - source: 'clone' | 'edited' | 'manual'
 *   - clone_snapshot: serialised DTO JSON
 */

import type { BucketPersister, PersistInput, PersistResult } from './types.js'
import { withSerializable } from '../../../db/transaction.js'
import { shouldOverwriteOnReclone } from './snapshot.js'

export interface UrlRedirectDTO {
  sourcePath: string
  targetPath: string
  statusCode?: number
}

export const urlRedirectsPersister: BucketPersister<UrlRedirectDTO> = {
  bucketName: 'url_redirects',

  async persist(input: PersistInput<UrlRedirectDTO>): Promise<PersistResult> {
    const out: PersistResult = { inserted: 0, updated: 0, skippedEdited: 0, errors: [] }

    await withSerializable(input.db, async (trx) => {
      for (const dto of input.dtos) {
        try {
          const existing = await (trx as any)
            .selectFrom('url_redirects')
            .where('shop_id', '=', input.shopId)
            .where('source_path', '=', dto.sourcePath)
            .select(['id', 'source'])
            .executeTakeFirst() as { id: string; source: string } | undefined

          if (existing) {
            if (!shouldOverwriteOnReclone(existing)) {
              out.skippedEdited++
              continue
            }
            await (trx as any).updateTable('url_redirects')
              .set({
                target_path: dto.targetPath,
                status_code: dto.statusCode ?? 301,
                source: 'clone',
              })
              .where('id', '=', existing.id)
              .execute()
            out.updated++
          } else {
            await (trx as any).insertInto('url_redirects')
              .values({
                shop_id: input.shopId,
                source_path: dto.sourcePath,
                target_path: dto.targetPath,
                status_code: dto.statusCode ?? 301,
                source: 'clone',
                clone_snapshot: JSON.stringify(dto),
              })
              .execute()
            out.inserted++
          }
        } catch (err) {
          out.errors.push({ sourceHandle: dto.sourcePath, reason: (err as Error).message })
        }
      }
    })

    return out
  },
}
