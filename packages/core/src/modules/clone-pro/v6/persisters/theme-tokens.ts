/**
 * Clone Pro v6 — theme-tokens persister (L17 provenance-aware)
 *
 * Persists a single ThemeTokensDTO into the `shop_theme_tokens` table.
 * One row per shop (PK = shop_id). Uses UPSERT semantics: insert when no
 * row exists, update when an existing clone-sourced row is present.
 * Respects L17: rows with source='edited' or source='manual' are NEVER
 * overwritten by a re-clone.
 *
 * Schema (confirmed from ShopThemeTokensTable in tables.ts):
 *   - PK: shop_id (string)
 *   - tokens_json: JsonB<Record<string, unknown>>
 *   - source: Generated<'clone' | 'edited' | 'manual'>
 *   - clone_snapshot: ColumnType<unknown, string | null, string | null>
 *   - tokens_edited_at: string | null
 *   - updated_at: Generated<string>
 *
 * There is NO id column — shop_id is the primary key, so writeCloneSnapshot
 * (which uses 'id') is not applicable here. The snapshot is written inline
 * at insert time.
 */

import type { BucketPersister, PersistInput, PersistResult } from './types.js'
import type { ThemeTokensDTO } from '../scrapers/types.js'
import { withSerializable } from '../../../db/transaction.js'
import { shouldOverwriteOnReclone } from './snapshot.js'

export const themeTokensPersister: BucketPersister<ThemeTokensDTO> = {
  bucketName: 'shop_theme_tokens',

  async persist(input: PersistInput<ThemeTokensDTO>): Promise<PersistResult> {
    const out: PersistResult = { inserted: 0, updated: 0, skippedEdited: 0, errors: [] }

    if (input.dtos.length === 0) return out

    // Only one row per shop — take the first DTO (scraper emits exactly 1)
    const dto = input.dtos[0]
    const tokensJson = JSON.stringify(dto)

    await withSerializable(input.db, async (trx) => {
      try {
        const existing = await (trx as any)
          .selectFrom('shop_theme_tokens')
          .where('shop_id', '=', input.shopId)
          .select(['source'])
          .executeTakeFirst() as { source: string } | undefined

        if (existing) {
          if (!shouldOverwriteOnReclone(existing)) {
            out.skippedEdited++
            return
          }
          await (trx as any).updateTable('shop_theme_tokens')
            .set({
              tokens_json: tokensJson,
              source: 'clone',
            })
            .where('shop_id', '=', input.shopId)
            .execute()
          out.updated++
        } else {
          await (trx as any).insertInto('shop_theme_tokens')
            .values({
              shop_id: input.shopId,
              tokens_json: tokensJson,
              source: 'clone',
              clone_snapshot: tokensJson,
            })
            .execute()
          out.inserted++
        }
      } catch (err) {
        // sourceHandle is not applicable for single-row table — use shop_id
        out.errors.push({ sourceHandle: input.shopId, reason: (err as Error).message })
      }
    })

    return out
  },
}
