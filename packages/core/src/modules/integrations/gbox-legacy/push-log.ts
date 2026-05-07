/**
 * Insert rows into `legacy_gbox_push_log` (migration 033).
 *
 * One row per POST attempt — both success and failure. The god-admin
 * page reads from here to answer "which Lenful products were pushed,
 * by whom, with what response".
 */

import type { Kysely } from 'kysely'
import type { Database } from '../../../../../db/src/schema/tables.js'

export interface RecordPushInput {
  readonly configId: string
  readonly triggeredByUserId: string | null
  readonly triggeredFromShopId: string | null
  readonly lenfulProductId: string
  readonly lenfulProductSku: string | null
  readonly lenfulProductTitle: string | null
  readonly legacyShopId: string
  readonly legacyProductId: string | null
  readonly httpStatus: number
  readonly success: boolean
  readonly errorMessage: string | null
  readonly latencyMs: number | null
}

export async function recordPush(
  db: Kysely<Database>,
  input: RecordPushInput,
): Promise<void> {
  await db
    .insertInto('legacy_gbox_push_log')
    .values({
      config_id: input.configId,
      triggered_by_user_id: input.triggeredByUserId,
      triggered_from_shop_id: input.triggeredFromShopId,
      lenful_product_id: input.lenfulProductId,
      lenful_product_sku: input.lenfulProductSku,
      lenful_product_title: input.lenfulProductTitle,
      legacy_shop_id: input.legacyShopId,
      legacy_product_id: input.legacyProductId,
      http_status: input.httpStatus,
      success: input.success,
      error_message: input.errorMessage ? input.errorMessage.slice(0, 2000) : null,
      latency_ms: input.latencyMs,
    } as any)
    .execute()

  // Phase 14 PR6 — platform_integration_down alert. Only run the
  // health check on failures; success rows don't need a lookback
  // query. Fire-and-forget so a dead platform-alerts pipeline can't
  // block the push itself (the row is already written above).
  if (!input.success) {
    void (async () => {
      try {
        const { onIntegrationCallError } = await import('../health.js')
        await onIntegrationCallError(db, {
          integrationName: 'gbox-legacy',
          logSource: 'legacy_gbox_push_log',
          statusPageUrl: 'https://status.gbox.co/gbox-legacy',
        })
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          '[gbox-legacy] integration-down health check failed',
          err instanceof Error ? err.message : err,
        )
      }
    })()
  }
}

export interface RecentPushRow {
  readonly id: string
  readonly lenful_product_id: string
  readonly lenful_product_title: string | null
  readonly legacy_shop_id: string
  readonly legacy_product_id: string | null
  readonly http_status: number
  readonly success: boolean
  readonly error_message: string | null
  readonly latency_ms: number | null
  readonly triggered_by_user_id: string | null
  readonly created_at: string
}

export async function listRecentPushes(
  db: Kysely<Database>,
  limit = 50,
): Promise<ReadonlyArray<RecentPushRow>> {
  const rows = await db
    .selectFrom('legacy_gbox_push_log')
    .select([
      'id',
      'lenful_product_id',
      'lenful_product_title',
      'legacy_shop_id',
      'legacy_product_id',
      'http_status',
      'success',
      'error_message',
      'latency_ms',
      'triggered_by_user_id',
      'created_at',
    ])
    .orderBy('created_at', 'desc')
    .limit(Math.min(200, Math.max(1, limit)))
    .execute()
  return rows as unknown as ReadonlyArray<RecentPushRow>
}
