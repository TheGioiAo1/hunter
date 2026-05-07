/**
 * Gbox Platform — Apps / Plugin Marketplace Service
 *
 * App definitions, installations, configuration, and webhook registration.
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'

// ---------------------------------------------------------------------------
// Input / output types
// ---------------------------------------------------------------------------

type Selectable<T> = { [K in keyof T]: T[K] extends import('kysely').ColumnType<infer S, any, any> ? S : T[K] }

export type AppDefinition = Selectable<Database['app_definitions']>
export type AppInstallation = Selectable<Database['app_installations']>
export type Webhook = Selectable<Database['webhooks']>

export interface AppDefinitionFilters {
  search?: string
  developer?: string
}

export interface Pagination {
  limit?: number
  offset?: number
}

export interface CreateAppDefinitionInput {
  name: string
  slug: string
  description?: string | null
  icon_url?: string | null
  developer?: string | null
  url?: string | null
  scopes?: string[]
}

export interface AppInstallationWithApp extends AppInstallation {
  app: AppDefinition
}

// ---------------------------------------------------------------------------
// Service functions
// ---------------------------------------------------------------------------

/**
 * List app definitions with optional filters and pagination.
 */
export async function listAppDefinitions(
  db: Kysely<Database>,
  filters: AppDefinitionFilters = {},
  pagination: Pagination = {},
): Promise<{ apps: AppDefinition[]; total: number }> {
  const { limit = 50, offset = 0 } = pagination

  let query = db.selectFrom('app_definitions').selectAll()
  let countQuery = db.selectFrom('app_definitions').select(db.fn.countAll<number>().as('count'))

  if (filters.search) {
    const pattern = `%${filters.search}%`
    query = query.where((eb) =>
      eb.or([eb('name', 'ilike', pattern), eb('description', 'ilike', pattern)]),
    )
    countQuery = countQuery.where((eb) =>
      eb.or([eb('name', 'ilike', pattern), eb('description', 'ilike', pattern)]),
    )
  }

  if (filters.developer) {
    query = query.where('developer', '=', filters.developer)
    countQuery = countQuery.where('developer', '=', filters.developer)
  }

  const [rows, countRow] = await Promise.all([
    query.orderBy('created_at', 'desc').limit(limit).offset(offset).execute(),
    countQuery.executeTakeFirstOrThrow(),
  ])

  return {
    apps: rows as AppDefinition[],
    total: Number(countRow.count),
  }
}

/**
 * Get a single app definition by ID, including the number of installations.
 */
export async function getAppDefinition(
  db: Kysely<Database>,
  appId: string,
): Promise<(AppDefinition & { installCount: number }) | null> {
  const app = await db
    .selectFrom('app_definitions')
    .selectAll()
    .where('id', '=', appId)
    .executeTakeFirst()

  if (!app) return null

  const countRow = await db
    .selectFrom('app_installations')
    .select(db.fn.countAll<number>().as('count'))
    .where('app_id', '=', appId)
    .where('status', '=', 'active')
    .executeTakeFirstOrThrow()

  return {
    ...(app as AppDefinition),
    installCount: Number(countRow.count),
  }
}

/**
 * Create a new app definition.
 */
export async function createAppDefinition(
  db: Kysely<Database>,
  data: CreateAppDefinitionInput,
): Promise<AppDefinition> {
  const row = await db
    .insertInto('app_definitions')
    .values({
      name: data.name,
      slug: data.slug,
      description: data.description ?? null,
      icon_url: data.icon_url ?? null,
      developer: data.developer ?? null,
      url: data.url ?? null,
      scopes: data.scopes ? JSON.stringify(data.scopes) : null,
    })
    .returningAll()
    .executeTakeFirstOrThrow()

  return row as AppDefinition
}

/**
 * Install an app into a shop.
 */
export async function installApp(
  db: Kysely<Database>,
  shopId: string,
  appId: string,
  config?: Record<string, unknown>,
): Promise<AppInstallation> {
  // Check if already installed
  const existing = await db
    .selectFrom('app_installations')
    .selectAll()
    .where('shop_id', '=', shopId)
    .where('app_id', '=', appId)
    .where('status', '=', 'active')
    .executeTakeFirst()

  if (existing) {
    throw new Error(`App ${appId} is already installed in shop ${shopId}`)
  }

  const row = await db
    .insertInto('app_installations')
    .values({
      shop_id: shopId,
      app_id: appId,
      config: config ? JSON.stringify(config) : null,
    })
    .returningAll()
    .executeTakeFirstOrThrow()

  return row as AppInstallation
}

/**
 * Uninstall an app from a shop by setting status to 'disabled'.
 */
export async function uninstallApp(
  db: Kysely<Database>,
  shopId: string,
  appId: string,
): Promise<void> {
  const result = await db
    .updateTable('app_installations')
    .set({ status: 'disabled', updated_at: new Date().toISOString() } as any)
    .where('shop_id', '=', shopId)
    .where('app_id', '=', appId)
    .where('status', '=', 'active')
    .execute()

  if (result.length === 0 || Number(result[0].numUpdatedRows) === 0) {
    throw new Error(`App ${appId} is not installed in shop ${shopId}`)
  }
}

/**
 * Get all installed apps for a shop with app definition details.
 */
export async function getInstalledApps(
  db: Kysely<Database>,
  shopId: string,
): Promise<AppInstallationWithApp[]> {
  const installations = await db
    .selectFrom('app_installations as ai')
    .innerJoin('app_definitions as ad', 'ad.id', 'ai.app_id')
    .select([
      'ai.id',
      'ai.shop_id',
      'ai.app_id',
      'ai.config',
      'ai.status',
      'ai.created_at',
      'ai.updated_at',
      'ad.id as app_def_id',
      'ad.name as app_name',
      'ad.slug as app_slug',
      'ad.description as app_description',
      'ad.icon_url as app_icon_url',
      'ad.developer as app_developer',
      'ad.url as app_url',
      'ad.scopes as app_scopes',
      'ad.created_at as app_created_at',
    ])
    .where('ai.shop_id', '=', shopId)
    .where('ai.status', '=', 'active')
    .execute()

  return installations.map((row): AppInstallationWithApp => ({
    id: row.id,
    shop_id: row.shop_id,
    app_id: row.app_id,
    // `config` is JSONB — kysely's runtime row type loses the
    // JsonB<unknown> brand because we use a manual select projection,
    // so we re-cast back to the canonical column type here.
    config: row.config as AppInstallationWithApp['config'],
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
    app: {
      id: row.app_def_id,
      name: row.app_name,
      slug: row.app_slug,
      description: row.app_description,
      icon_url: row.app_icon_url,
      developer: row.app_developer,
      url: row.app_url,
      scopes: row.app_scopes,
      created_at: row.app_created_at,
    } as AppDefinition,
  }))
}

/**
 * Update the config for an existing app installation.
 */
export async function updateAppConfig(
  db: Kysely<Database>,
  installationId: string,
  config: Record<string, unknown>,
): Promise<AppInstallation> {
  const row = await db
    .updateTable('app_installations')
    .set({
      config: JSON.stringify(config),
      updated_at: new Date().toISOString(),
    } as any)
    .where('id', '=', installationId)
    .returningAll()
    .executeTakeFirstOrThrow()

  return row as AppInstallation
}

/**
 * Register a webhook for a shop.
 */
export async function registerWebhook(
  db: Kysely<Database>,
  shopId: string,
  topic: string,
  address: string,
): Promise<Webhook> {
  const row = await db
    .insertInto('webhooks')
    .values({
      shop_id: shopId,
      topic,
      address,
    })
    .returningAll()
    .executeTakeFirstOrThrow()

  return row as Webhook
}

/**
 * List all webhooks for a shop.
 */
export async function listWebhooks(
  db: Kysely<Database>,
  shopId: string,
): Promise<Webhook[]> {
  const rows = await db
    .selectFrom('webhooks')
    .selectAll()
    .where('shop_id', '=', shopId)
    .orderBy('created_at', 'desc')
    .execute()

  return rows as Webhook[]
}
