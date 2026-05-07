/**
 * God Admin — Kysely-backed PlatformSettingsStore (Phase 2 Step 2.5)
 *
 * Adapts the Kysely DB to the `PlatformSettingsStore` interface
 * defined in core. Keeps the god-admin route handlers free of any
 * direct SQL — they talk to `PlatformConfigService`, and this file
 * is the only place in the repo that knows about the
 * `platform_settings` table.
 *
 * Both `readAll()` and `write()` treat the `value` column as JSONB
 * and delegate coercion back to typed values to the service layer.
 */

import { sql, type Kysely } from 'kysely'
import type { Database } from '../../../../packages/db/src/index.js'
import type { PlatformSettingsStore } from '../../../../packages/core/src/modules/platform-config/index.js'

export class KyselyPlatformSettingsStore implements PlatformSettingsStore {
  constructor(
    private readonly db: Kysely<Database>,
    /** Optional user id to stamp into `updated_by` on writes. */
    private readonly updatedBy: string | null = null,
  ) {}

  async readAll(): Promise<Record<string, unknown>> {
    const rows = await this.db
      .selectFrom('platform_settings')
      .select(['key', 'value'])
      .execute()

    const out: Record<string, unknown> = {}
    for (const r of rows) {
      // `value` is JSONB — Kysely's JSONB column type returns the
      // parsed object directly for SELECT.
      out[r.key] = r.value
    }
    return out
  }

  async write(key: string, value: unknown): Promise<void> {
    // JSONB insert requires the value to be serialized as a string
    // that Postgres will then parse back. We use sql`::jsonb` cast
    // to keep this explicit.
    const json = JSON.stringify(value)
    await sql`
      INSERT INTO platform_settings (key, value, updated_at, updated_by)
      VALUES (${key}, ${json}::jsonb, now(), ${this.updatedBy})
      ON CONFLICT (key) DO UPDATE
        SET value = EXCLUDED.value,
            updated_at = now(),
            updated_by = EXCLUDED.updated_by
    `.execute(this.db)
  }
}

/**
 * Return a factory that binds a Kysely instance + optional user id
 * to a fresh `KyselyPlatformSettingsStore`. Used by the god-admin
 * route handler where the per-request user comes from the auth
 * middleware.
 */
export function makeKyselyPlatformStoreFactory(db: Kysely<Database>) {
  return (updatedBy: string | null = null) =>
    new KyselyPlatformSettingsStore(db, updatedBy)
}
