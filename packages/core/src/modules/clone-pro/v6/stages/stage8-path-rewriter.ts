/**
 * Clone Pro v6 — Stage 8: Path Rewriter
 *
 * Rewrites all source-domain absolute references (product, collection, page,
 * blog, policy, cart/account paths) to relative GBox paths, and rewrites CDN
 * asset URLs to the target CDN using the pre-built assetMap from Stage 6.
 *
 * Used by applyRewriterToDb to walk all text columns in-place after persist.
 */

export interface RewriteRules {
  sourceHost: string
  sourceCdnHosts: string[]
  targetCdnUrl: string
  productHandleResolver: (sourceHandle: string) => string
  collectionHandleResolver: (sourceHandle: string) => string
  pageHandleResolver: (sourceHandle: string) => string
  blogResolver: (blogHandle: string, postHandle: string) => string
  assetMap: Map<string, string>
}

export function rewriteSources(input: string, rules: RewriteRules): string {
  let out = input
  const sourceHostEsc = rules.sourceHost.replace(/\./g, '\\.')

  // /products/<handle>
  out = out.replace(
    new RegExp(`https?:\\/\\/${sourceHostEsc}/products/([\\w-]+)(?:\\?[^"'\\s]*)?`, 'g'),
    (_m, handle) => `/products/${rules.productHandleResolver(handle)}`,
  )

  // /collections/<handle>
  out = out.replace(
    new RegExp(`https?:\\/\\/${sourceHostEsc}/collections/([\\w-]+)(?:\\?[^"'\\s]*)?`, 'g'),
    (_m, handle) => `/collections/${rules.collectionHandleResolver(handle)}`,
  )

  // /pages/<handle>
  out = out.replace(
    new RegExp(`https?:\\/\\/${sourceHostEsc}/pages/([\\w-]+)`, 'g'),
    (_m, handle) => `/pages/${rules.pageHandleResolver(handle)}`,
  )

  // /policies/<handle> → /pages/<handle> (normalise)
  out = out.replace(
    new RegExp(`https?:\\/\\/${sourceHostEsc}/policies/([\\w-]+)`, 'g'),
    (_m, handle) => `/pages/${rules.pageHandleResolver(handle)}`,
  )

  // /blogs/<blog>/<post>
  out = out.replace(
    new RegExp(`https?:\\/\\/${sourceHostEsc}/blogs/([\\w-]+)/([\\w-]+)`, 'g'),
    (_m, blog, post) => `/blogs/${rules.blogResolver(blog, post)}`,
  )

  // /cart, /account, /account/login — preserve as relative paths
  out = out.replace(
    new RegExp(`https?:\\/\\/${sourceHostEsc}/(cart|account(?:\\/login)?)`, 'g'),
    (_m, path) => `/${path}`,
  )

  // CDN assets — rewrite using assetMap; iterate sourceCdnHosts first, then
  // sourceHost itself (in case images are served from the main domain).
  //
  // assetMap value is the full target URL (typically `clone_assets_map.cdn_url`,
  // e.g. `https://gbox-clone-storage.s3.ap-southeast-1.amazonaws.com/<seller>/<shop>/<sha1>.<ext>`).
  for (const cdnHost of [...rules.sourceCdnHosts, rules.sourceHost]) {
    const cdnEsc = cdnHost.replace(/\./g, '\\.')
    out = out.replace(
      new RegExp(`https?:\\/\\/${cdnEsc}/[^"'\\s)>]+`, 'g'),
      (m) => {
        // Try exact URL first, then URL without query string. Backwards compat:
        // older tests pass `${sha1}.${ext}` instead of full URL — if value
        // doesn't start with http, fall back to ${targetCdnUrl}/${value}.
        const mapped = rules.assetMap.get(m) ?? rules.assetMap.get(m.split('?')[0])
        if (!mapped) return m
        return mapped.startsWith('http') ? mapped : `${rules.targetCdnUrl}/${mapped}`
      },
    )
  }

  // Strip any remaining source-domain absolute references (bare host prefix)
  out = out.replace(new RegExp(`https?:\\/\\/${sourceHostEsc}`, 'g'), '')

  return out
}

// ---------------------------------------------------------------------------
// Database walker — rewrite all text columns in-place for a given shop
// ---------------------------------------------------------------------------

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'

const REWRITE_TABLES: { table: string; columns: string[] }[] = [
  { table: 'products', columns: ['title', 'body_html'] },
  { table: 'collections', columns: ['title', 'body_html'] },
  { table: 'pages', columns: ['title', 'body_html'] },
  { table: 'blog_posts', columns: ['title', 'body_html'] },
  { table: 'menu_items', columns: ['url'] },
]

export interface ApplyRewriterInput extends RewriteRules {
  db: Kysely<Database>
  shopId: string
}

export interface ApplyRewriterResult {
  rowsRewritten: number
}

export async function applyRewriterToDb(input: ApplyRewriterInput): Promise<ApplyRewriterResult> {
  let rowsRewritten = 0

  // ── product_images.src — rewrite SOURCE URLs to CDN URLs ──────────────
  // product_images has no shop_id; join via products. The src column is a
  // bare URL (not embedded HTML), so we lookup directly in assetMap by
  // source URL (with and without query params) instead of regex-replacing.
  rowsRewritten += await rewriteProductImages(input)

  for (const cfg of REWRITE_TABLES) {
    // menu_items has no shop_id — must join via menus.shop_id
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
      const updates: Record<string, string> = {}
      let changed = false

      for (const col of cfg.columns) {
        const original = row[col]
        if (typeof original !== 'string') continue
        const rewritten = rewriteSources(original, input)
        if (rewritten !== original) {
          updates[col] = rewritten
          changed = true
        }
      }

      if (changed) {
        await (input.db as any)
          .updateTable(cfg.table)
          .set(updates)
          .where('id', '=', row.id)
          .execute()
        rowsRewritten++
      }
    }
  }

  return { rowsRewritten }
}

/**
 * Walks v6-cloned product_images and rewrites .src from raw source URL
 * to the targetCdnUrl. Lookup is direct (no regex) since `src` is a bare
 * URL — we try the exact URL first, then the URL without query params.
 *
 * Storefront's DataSource reads `product_images.src` as-is, so this is
 * the chokepoint that makes product cards + product page images render
 * from S3 instead of the source domain.
 */
async function rewriteProductImages(input: ApplyRewriterInput): Promise<number> {
  const rows = await (input.db as any)
    .selectFrom('product_images')
    .innerJoin('products', 'products.id', 'product_images.product_id')
    .where('products.shop_id', '=', input.shopId)
    .where('product_images.source', '=', 'clone')
    .select([
      'product_images.id as id',
      'product_images.src as src',
    ])
    .execute() as { id: string; src: string | null }[]

  let n = 0
  for (const row of rows) {
    if (!row.src || typeof row.src !== 'string') continue
    const mapped = input.assetMap.get(row.src) ?? input.assetMap.get(row.src.split('?')[0])
    if (!mapped) continue
    // assetMap stores full cdn_url (preferred) or `sha1.ext` (legacy);
    // if legacy, fall back to targetCdnUrl prefix.
    const newSrc = mapped.startsWith('http') ? mapped : `${input.targetCdnUrl}/${mapped}`
    if (newSrc === row.src) continue
    await (input.db as any)
      .updateTable('product_images')
      .set({ src: newSrc })
      .where('id', '=', row.id)
      .execute()
    n++
  }
  return n
}
