/**
 * Gbox Platform — Database Template Loader (storefront)
 *
 * Loads template source from PostgreSQL. Two backing tables, switched
 * by env flag `THEME_LOADER_VERSION`:
 *
 *   v1 (default) → `theme_assets` (legacy v6 path; FK theme_id, key, value)
 *   v2           → `theme_files`  (Clone Pro v7 generated themes;
 *                                  shop_id + path + content + is_active)
 *
 * Backwards compatibility: existing v6 shops keep using `theme_assets`
 * because the env flag defaults to `v1`. Only shops with explicit
 * `THEME_LOADER_VERSION=v2` (set by Stage 11 v7 publish) flip to
 * `theme_files`. The same DbLoader instance can be constructed with
 * `opts.version='v2'` to override the env (test-time override and
 * future per-shop dispatch).
 *
 * Iron Rule 5: this loader never composes seller-facing strings. A
 * missing template returns null and the upstream pipeline (handler.ts)
 * scrubs through `safeMessage` at the boundary.
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import type { LoadResult, LogicalPath, TemplateLoader } from '../loader.js'

export type DbLoaderVersion = 'v1' | 'v2'

export interface DbLoaderOpts {
  /**
   * Backing-table version. Falls back to `process.env.THEME_LOADER_VERSION`
   * when omitted; ultimately defaults to `'v1'` (legacy theme_assets).
   */
  version?: DbLoaderVersion
}

function resolveVersion(opts?: DbLoaderOpts): DbLoaderVersion {
  if (opts?.version) return opts.version
  const env = process.env.THEME_LOADER_VERSION
  return env === 'v2' ? 'v2' : 'v1'
}

export class DbLoader implements TemplateLoader {
  readonly name = 'db'

  private readonly version: DbLoaderVersion

  /**
   * `themeOrShopId` is interpreted by version:
   *   v1 → theme_id (FK to themes.id)
   *   v2 → shop_id  (FK to shops.id)
   */
  constructor(
    private readonly db: Kysely<Database>,
    private readonly themeOrShopId: string,
    opts?: DbLoaderOpts,
  ) {
    this.version = resolveVersion(opts)
  }

  async load(path: LogicalPath): Promise<string | null> {
    if (this.version === 'v2') return this.loadV2(path)
    return this.loadV1(path)
  }

  async loadWithMeta(path: LogicalPath): Promise<LoadResult | null> {
    if (this.version === 'v2') return this.loadWithMetaV2(path)
    return this.loadWithMetaV1(path)
  }

  async exists(path: LogicalPath): Promise<boolean> {
    if (this.version === 'v2') {
      const row = await (this.db as any)
        .selectFrom('theme_files')
        .select('id')
        .where('shop_id', '=', this.themeOrShopId)
        .where('is_active', '=', true)
        .where('path', '=', path)
        .executeTakeFirst()
      return !!row
    }
    const row = await this.db
      .selectFrom('theme_assets')
      .select('id')
      .where('theme_id', '=', this.themeOrShopId)
      .where('key', '=', path)
      .executeTakeFirst()
    return !!row
  }

  async list(prefix = ''): Promise<LogicalPath[]> {
    if (this.version === 'v2') {
      let q: any = (this.db as any)
        .selectFrom('theme_files')
        .select('path')
        .where('shop_id', '=', this.themeOrShopId)
        .where('is_active', '=', true)
      if (prefix) q = q.where('path', 'like', `${prefix}%`)
      q = q.orderBy('path', 'asc')
      const rows = (await q.execute()) as Array<{ path: string }>
      return rows.map((r) => r.path)
    }
    let query = this.db
      .selectFrom('theme_assets')
      .select('key')
      .where('theme_id', '=', this.themeOrShopId)
      .orderBy('key', 'asc')

    if (prefix) {
      query = query.where('key', 'like', `${prefix}%`)
    }

    const rows = await query.execute()
    return rows.map((r) => r.key)
  }

  // ---------------------------------------------------------------------
  // v1 (theme_assets)
  // ---------------------------------------------------------------------

  private async loadV1(path: LogicalPath): Promise<string | null> {
    const row = await this.db
      .selectFrom('theme_assets')
      .select('value')
      .where('theme_id', '=', this.themeOrShopId)
      .where('key', '=', path)
      .executeTakeFirst()

    return (row?.value as string) ?? null
  }

  private async loadWithMetaV1(path: LogicalPath): Promise<LoadResult | null> {
    const row = await this.db
      .selectFrom('theme_assets')
      .select(['value', 'updated_at'])
      .where('theme_id', '=', this.themeOrShopId)
      .where('key', '=', path)
      .executeTakeFirst()

    if (!row || row.value == null) return null

    return {
      source: row.value as string,
      updatedAt: row.updated_at ? String(row.updated_at) : undefined,
    }
  }

  // ---------------------------------------------------------------------
  // v2 (theme_files)
  // ---------------------------------------------------------------------

  private async loadV2(path: LogicalPath): Promise<string | null> {
    const row = await (this.db as any)
      .selectFrom('theme_files')
      .select(['content'])
      .where('shop_id', '=', this.themeOrShopId)
      .where('is_active', '=', true)
      .where('path', '=', path)
      .executeTakeFirst()

    return (row?.content as string | null) ?? null
  }

  private async loadWithMetaV2(path: LogicalPath): Promise<LoadResult | null> {
    const row = await (this.db as any)
      .selectFrom('theme_files')
      .select(['content', 'updated_at'])
      .where('shop_id', '=', this.themeOrShopId)
      .where('is_active', '=', true)
      .where('path', '=', path)
      .executeTakeFirst()

    if (!row || row.content == null) return null

    return {
      source: row.content as string,
      updatedAt: row.updated_at ? String(row.updated_at) : undefined,
    }
  }
}
