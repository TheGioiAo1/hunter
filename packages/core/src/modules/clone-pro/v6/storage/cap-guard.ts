import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'

const DEFAULT_CAP_BYTES = 5 * 1024 * 1024 * 1024  // 5 GB

export interface CapGuardInput {
  db: Kysely<Database>
  capBytes?: number
}

export class CapGuard {
  constructor(private readonly input: CapGuardInput) {}

  async check(shopId: string, addBytes: number): Promise<{ ok: boolean; reason?: string }> {
    const cap = this.input.capBytes ?? DEFAULT_CAP_BYTES
    const r = await this.input.db
      .selectFrom('clone_assets_map')
      .where('shop_id', '=', shopId)
      .select((eb) => eb.fn.sum('byte_size').as('total'))
      .executeTakeFirst()
    // pg-node returns SUM as string for bigint, null for empty result. Normalize via JS coalesce.
    const total = Number((r as any)?.total ?? 0)
    if (total + addBytes > cap) {
      return { ok: false, reason: `${formatBytes(total + addBytes)} would exceed cap ${formatBytes(cap)}` }
    }
    return { ok: true }
  }
}

function formatBytes(n: number): string {
  if (n < 1e6) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1e9) return `${(n / 1e6).toFixed(1)} MB`
  return `${(n / 1e9).toFixed(2)} GB`
}
