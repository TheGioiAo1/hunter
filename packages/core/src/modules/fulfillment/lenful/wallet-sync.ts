/**
 * Lenful wallet snapshot (Phase F5).
 *
 * Lenful bills POD fulfillments by deducting from the seller's wallet
 * (our god-admin owns this wallet; sellers never touch it directly). We
 * want to track wallet balance over time so we can:
 *
 *   1. Alert when the balance drops below a configurable threshold.
 *   2. Show a mini timeline to god-admin so ops can anticipate top-ups.
 *
 * Invocation
 * ----------
 *   captureWalletSnapshot(db, opts): CaptureResult
 *     - Calls LenfulClient.walletBalance, inserts into
 *       lenful_wallet_snapshots, and evaluates the threshold.
 *     - Safe to call from a cron AND from a manual "Capture now" button.
 *
 *   getLatestSnapshot / listSnapshots: read helpers for the UI.
 *
 * Threshold
 * ---------
 * The alert threshold lives in `platform_settings` under key
 * `lenful_wallet_alert_threshold` (numeric string, USD). If unset,
 * defaults to 0 (no alert). The alert itself is surfaced via the UI
 * banner — no email gateway wired here.
 */

import type { Kysely } from 'kysely'
import type { Database } from '../../../../../db/src/schema/tables.js'
import { LenfulClient } from './client.ts'
import { getActiveCredential } from './credentials.ts'

export interface WalletSnapshot {
  readonly id: string
  readonly credential_id: string
  readonly balance: string
  readonly currency: string
  readonly captured_at: string
}

export interface CaptureResult {
  readonly ok: boolean
  readonly snapshot: WalletSnapshot | null
  readonly threshold: number | null
  readonly alert: boolean
  readonly error: string | null
}

const THRESHOLD_KEY = 'lenful_wallet_alert_threshold'

async function readThreshold(db: Kysely<Database>): Promise<number | null> {
  const row = await db
    .selectFrom('platform_settings')
    .select(['value'])
    .where('key', '=', THRESHOLD_KEY)
    .executeTakeFirst()
  if (!row) return null
  const raw = row.value
  if (raw === null || raw === undefined) return null
  const parsed = typeof raw === 'number' ? raw : Number.parseFloat(String(raw))
  return Number.isFinite(parsed) ? parsed : null
}

export async function setThreshold(
  db: Kysely<Database>,
  value: number,
  updatedBy: string | null,
): Promise<void> {
  const existing = await db
    .selectFrom('platform_settings')
    .select(['key'])
    .where('key', '=', THRESHOLD_KEY)
    .executeTakeFirst()
  const now = new Date().toISOString()
  if (existing) {
    await db
      .updateTable('platform_settings')
      .set({
        value: JSON.stringify(value) as any,
        updated_at: now,
        updated_by: updatedBy,
      })
      .where('key', '=', THRESHOLD_KEY)
      .execute()
  } else {
    await db
      .insertInto('platform_settings')
      .values({
        key: THRESHOLD_KEY,
        value: JSON.stringify(value) as any,
        updated_at: now,
        updated_by: updatedBy,
      })
      .execute()
  }
}

export async function getThreshold(
  db: Kysely<Database>,
): Promise<number | null> {
  return readThreshold(db)
}

function parseBalance(raw: unknown): { amount: number; currency: string } {
  if (raw && typeof raw === 'object') {
    const r = raw as Record<string, any>
    const amount = Number.parseFloat(String(r.balance ?? r.amount ?? r.available ?? 0))
    const currency = String(r.currency ?? r.currency_code ?? 'USD')
    return { amount: Number.isFinite(amount) ? amount : 0, currency }
  }
  const amount = Number.parseFloat(String(raw ?? 0))
  return { amount: Number.isFinite(amount) ? amount : 0, currency: 'USD' }
}

export async function captureWalletSnapshot(
  db: Kysely<Database>,
  opts: { triggeredBy?: string; userId?: string | null } = {},
): Promise<CaptureResult> {
  const cred = await getActiveCredential(db)
  if (!cred) {
    return { ok: false, snapshot: null, threshold: null, alert: false, error: 'No active credential' }
  }
  const client = new LenfulClient({
    db,
    credentialId: cred.id,
    triggeredBy: opts.triggeredBy ?? 'wallet-cron',
    userId: opts.userId ?? null,
  })

  try {
    const raw = await client.walletBalance()
    const { amount, currency } = parseBalance(raw)
    const now = new Date().toISOString()

    const inserted = await db
      .insertInto('lenful_wallet_snapshots')
      .values({
        credential_id: cred.id,
        balance: String(amount) as any,
        currency,
        raw_payload: JSON.stringify(raw) as any,
        captured_at: now,
      })
      .returning(['id', 'credential_id', 'balance', 'currency', 'captured_at'])
      .executeTakeFirstOrThrow()

    const threshold = await readThreshold(db)
    const alert = threshold !== null && amount < threshold

    return {
      ok: true,
      snapshot: {
        id: inserted.id,
        credential_id: inserted.credential_id,
        balance: String(inserted.balance),
        currency: inserted.currency,
        captured_at:
          typeof inserted.captured_at === 'string'
            ? inserted.captured_at
            : String(inserted.captured_at),
      },
      threshold,
      alert,
      error: null,
    }
  } catch (e: any) {
    return {
      ok: false,
      snapshot: null,
      threshold: null,
      alert: false,
      error: e?.message ?? String(e),
    }
  }
}

export async function getLatestSnapshot(
  db: Kysely<Database>,
): Promise<WalletSnapshot | null> {
  const row = await db
    .selectFrom('lenful_wallet_snapshots')
    .select(['id', 'credential_id', 'balance', 'currency', 'captured_at'])
    .orderBy('captured_at', 'desc')
    .limit(1)
    .executeTakeFirst()
  if (!row) return null
  return {
    id: row.id,
    credential_id: row.credential_id,
    balance: String(row.balance),
    currency: row.currency,
    captured_at:
      typeof row.captured_at === 'string' ? row.captured_at : String(row.captured_at),
  }
}

export async function listSnapshots(
  db: Kysely<Database>,
  limit: number = 30,
): Promise<ReadonlyArray<WalletSnapshot>> {
  const rows = await db
    .selectFrom('lenful_wallet_snapshots')
    .select(['id', 'credential_id', 'balance', 'currency', 'captured_at'])
    .orderBy('captured_at', 'desc')
    .limit(Math.max(1, Math.min(365, limit)))
    .execute()
  return rows.map((r) => ({
    id: r.id,
    credential_id: r.credential_id,
    balance: String(r.balance),
    currency: r.currency,
    captured_at:
      typeof r.captured_at === 'string' ? r.captured_at : String(r.captured_at),
  }))
}
