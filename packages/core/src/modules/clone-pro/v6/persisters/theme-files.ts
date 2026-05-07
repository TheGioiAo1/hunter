/**
 * Clone Pro v6 — theme-files persister (L17 provenance-aware)
 *
 * Persists ThemeFileDTO[] into the `theme_files` table.
 * Rows represent CSS / JS / font assets that were scraped and uploaded
 * to S3 during Stage 6. Each row is keyed by (shop_id, source_url).
 *
 * Respects L17: rows with source='edited' or source='manual' are NEVER
 * overwritten by a re-clone.
 *
 * Schema (migration 097 / `theme_files` table):
 *   - shop_id, kind, source_url, s3_key, cdn_url, byte_size
 *   - source: 'clone' | 'edited' | 'manual'
 *   - clone_snapshot: serialised DTO JSON
 */

import type { BucketPersister, PersistInput, PersistResult } from './types.js'
import { withSerializable } from '../../../db/transaction.js'
import { shouldOverwriteOnReclone } from './snapshot.js'

export interface ThemeFileDTO {
  kind: 'css' | 'js' | 'font'
  sourceUrl: string
  s3Key: string
  cdnUrl: string
  byteSize: number
}

export const themeFilesPersister: BucketPersister<ThemeFileDTO> = {
  bucketName: 'theme_files',

  async persist(input: PersistInput<ThemeFileDTO>): Promise<PersistResult> {
    const out: PersistResult = { inserted: 0, updated: 0, skippedEdited: 0, errors: [] }

    await withSerializable(input.db, async (trx) => {
      for (const dto of input.dtos) {
        try {
          const existing = await (trx as any)
            .selectFrom('theme_files')
            .where('shop_id', '=', input.shopId)
            .where('source_url', '=', dto.sourceUrl)
            .select(['id', 'source'])
            .executeTakeFirst() as { id: string; source: string } | undefined

          if (existing) {
            if (!shouldOverwriteOnReclone(existing)) {
              out.skippedEdited++
              continue
            }
            await (trx as any).updateTable('theme_files')
              .set({
                s3_key: dto.s3Key,
                cdn_url: dto.cdnUrl,
                byte_size: dto.byteSize,
                source: 'clone',
              })
              .where('id', '=', existing.id)
              .execute()
            out.updated++
          } else {
            await (trx as any).insertInto('theme_files')
              .values({
                shop_id: input.shopId,
                kind: dto.kind,
                source_url: dto.sourceUrl,
                s3_key: dto.s3Key,
                cdn_url: dto.cdnUrl,
                byte_size: dto.byteSize,
                source: 'clone',
                clone_snapshot: JSON.stringify(dto),
              })
              .execute()
            out.inserted++
          }
        } catch (err) {
          out.errors.push({ sourceHandle: dto.sourceUrl, reason: (err as Error).message })
        }
      }
    })

    return out
  },
}
