/**
 * Clone Pro v5 — theme persister (phase ⑤, runs inside `withSerializable`)
 *
 * Upserts the full `ThemeTokens` DTO into `shop_theme_tokens` keyed by
 * `shop_id`. The plan originally called for a `theme_config` table; no
 * such table exists, so migration 091b creates `shop_theme_tokens(shop_id
 * PK, tokens_json jsonb, updated_at)` and we persist the whole DTO as a
 * single jsonb payload.
 *
 * Why jsonb: the token shape is still evolving (PR3 will add asset URLs,
 * PR4 will add custom CSS), and storefront renderers read the blob as a
 * whole anyway — normalising into columns now would be premature.
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import type { ThemeTokens } from '../types.js'

export interface PersistThemeResult {
  readonly inserted: number
}

export async function persistTheme(
  tx: Kysely<Database>,
  shopId: string,
  tokens: ThemeTokens,
): Promise<PersistThemeResult> {
  // No try/catch — see products-persist.ts header. Errors propagate to
  // withSerializable; swallowing them inside a pg transaction yields
  // `25P02 aborted` for every subsequent query.
  await tx
    .insertInto('shop_theme_tokens')
    .values({
      shop_id: shopId,
      tokens_json: tokens as any,
    })
    .onConflict((oc) =>
      oc.column('shop_id').doUpdateSet({
        tokens_json: tokens as any,
      }),
    )
    .execute()
  return { inserted: 1 }
}
