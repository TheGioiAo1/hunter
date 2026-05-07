/**
 * Clone Pro v6 — Verifier: Grep Gate (Iron Rule 5)
 *
 * Scans all persisted text columns for residual source-host references after
 * Stage 8 path rewriting. Any remaining absolute URL containing the source
 * host is flagged as a leak.
 *
 * Iron Rule 5: raw error details stay server-side (worker logs / admin
 * diagnostics). The result object is safe to log internally but MUST NOT be
 * exposed to seller-facing UI surfaces.
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'

const TABLES_TO_SCAN: { table: string; columns: string[] }[] = [
  { table: 'products', columns: ['title', 'body_html'] },
  { table: 'collections', columns: ['title', 'body_html'] },
  { table: 'pages', columns: ['title', 'body_html'] },
  { table: 'blog_posts', columns: ['title', 'body_html'] },
  { table: 'menu_items', columns: ['url'] },
]

export interface GrepGateInput {
  db: Kysely<Database>
  shopId: string
  sourceHost: string
}

export interface GrepGateLeak {
  table: string
  rowId: string
  column: string
  snippet: string
}

export interface GrepGateResult {
  ok: boolean
  totalLeaks: number
  leaks: GrepGateLeak[]
}

export async function verifyNoSourceLeaks(input: GrepGateInput): Promise<GrepGateResult> {
  const re = new RegExp(
    `https?:\\/\\/${input.sourceHost.replace(/\./g, '\\.')}`,
    'i',
  )
  const leaks: GrepGateLeak[] = []

  for (const cfg of TABLES_TO_SCAN) {
    // menu_items has no shop_id — join via menus.shop_id
    const rows = cfg.table === 'menu_items'
      ? await (input.db as any)
          .selectFrom('menu_items')
          .innerJoin('menus', 'menus.id', 'menu_items.menu_id')
          .where('menus.shop_id', '=', input.shopId)
          .select(['menu_items.id as id', ...cfg.columns.map((c) => `menu_items.${c} as ${c}`)])
          .execute() as any[]
      : await (input.db as any)
          .selectFrom(cfg.table)
          .where('shop_id', '=', input.shopId)
          .select(['id', ...cfg.columns])
          .execute() as any[]

    for (const row of rows) {
      for (const col of cfg.columns) {
        const v = row[col]
        if (typeof v !== 'string') continue
        if (re.test(v)) {
          leaks.push({
            table: cfg.table,
            rowId: row.id,
            column: col,
            snippet: v.slice(0, 200),
          })
        }
      }
    }
  }

  return {
    ok: leaks.length === 0,
    totalLeaks: leaks.length,
    leaks,
  }
}
