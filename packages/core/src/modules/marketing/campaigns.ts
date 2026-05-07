/**
 * Gbox Platform — Campaigns Service (Phase 8 PR1)
 *
 * CRUD + lifecycle transitions for merchant marketing campaigns. Models
 * an email blast:
 *
 *   • Merchant drafts → schedules for future send OR triggers immediately.
 *   • Cron picks up `status='scheduled' AND scheduled_at<=now()` at tick,
 *     snapshots the resolved audience into `campaign_recipients`, then
 *     dispatches one email per recipient.
 *   • Per-recipient send/open/click/bounce/unsubscribe timestamps are
 *     recorded on `campaign_recipients` for reporting + auditing.
 *
 * Tenancy: every callsite takes `shopId` and cross-shop reads return null
 * or throw a typed rejection. No campaign row is visible outside its shop.
 *
 * Status machine:
 *
 *   draft     ──schedule──▶ scheduled ──cron tick──▶ sending ──▶ sent
 *      │                        │                       │
 *      ├──sendNow─────────────┐ │                       │
 *      │                      ▼ ▼                       ▼
 *      └──delete              cancelled              failed
 *
 * Terminal states: sent, failed, cancelled. Terminal rows are immutable
 * except for recipient-level metric updates (opened_count++, etc.).
 *
 * The service never talks to SMTP directly — the cron driver pulls one
 * recipient at a time, calls `email/service.ts::sendEmail`, and feeds
 * the result back via `recordRecipientSent` / `markRecipientBounced`.
 * This separation keeps the service trivially unit-testable.
 */

import { sql, type Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import { emitIfEnabled } from '../automations/feature-flag.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CampaignStatus =
  | 'draft'
  | 'scheduled'
  | 'sending'
  | 'sent'
  | 'failed'
  | 'cancelled'

export interface CampaignRow {
  id: string
  shop_id: string
  name: string
  subject: string
  body_html: string
  audience_segment: string | null
  discount_id: string | null
  status: CampaignStatus
  scheduled_at: string | null
  sent_at: string | null
  recipient_count: number
  opened_count: number
  clicked_count: number
  error: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

export interface CampaignRecipientRow {
  id: string
  campaign_id: string
  customer_id: string | null
  email: string
  sent_at: string | null
  opened_at: string | null
  clicked_at: string | null
  bounced_at: string | null
  unsubscribed_at: string | null
  error: string | null
  created_at: string
}

export interface CreateCampaignInput {
  name: string
  subject: string
  body_html: string
  audience_segment?: string | null
  discount_id?: string | null
  created_by?: string | null
}

export interface UpdateCampaignInput {
  name?: string
  subject?: string
  body_html?: string
  audience_segment?: string | null
  discount_id?: string | null
}

export interface ListFilter {
  status?: CampaignStatus | CampaignStatus[]
  search?: string
  limit?: number
  offset?: number
}

export type CreateResult =
  | { ok: true; campaign: CampaignRow }
  | { ok: false; error: CreateError }

export type CreateError =
  | 'name_required'
  | 'subject_required'
  | 'body_required'
  | 'name_too_long'
  | 'subject_too_long'

export type UpdateResult =
  | { ok: true; campaign: CampaignRow }
  | { ok: false; error: UpdateError }

export type UpdateError =
  | 'not_found'
  | 'immutable_status'
  | 'name_required'
  | 'name_too_long'
  | 'subject_required'
  | 'subject_too_long'
  | 'body_required'

export type ScheduleResult =
  | { ok: true; campaign: CampaignRow }
  | { ok: false; error: ScheduleError }

export type ScheduleError =
  | 'not_found'
  | 'wrong_status'
  | 'send_at_in_past'
  | 'send_at_required'

export type DeleteResult =
  | { ok: true }
  | { ok: false; error: 'not_found' | 'not_deletable' }

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const NAME_MAX = 255
const SUBJECT_MAX = 500

type Validated<E extends string> =
  | { ok: true; value: string }
  | { ok: false; error: E }

function validateName(
  raw: string | undefined,
): Validated<'name_required' | 'name_too_long'> {
  if (!raw || !raw.trim()) return { ok: false, error: 'name_required' }
  if (raw.length > NAME_MAX) return { ok: false, error: 'name_too_long' }
  return { ok: true, value: raw.trim() }
}

function validateSubject(
  raw: string | undefined,
): Validated<'subject_required' | 'subject_too_long'> {
  if (!raw || !raw.trim()) return { ok: false, error: 'subject_required' }
  if (raw.length > SUBJECT_MAX) return { ok: false, error: 'subject_too_long' }
  return { ok: true, value: raw.trim() }
}

function validateBody(
  raw: string | undefined,
): Validated<'body_required'> {
  if (!raw || !raw.trim()) return { ok: false, error: 'body_required' }
  return { ok: true, value: raw }
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export async function createCampaign(
  db: Kysely<Database>,
  shopId: string,
  input: CreateCampaignInput,
): Promise<CreateResult> {
  const name = validateName(input.name)
  if (!name.ok) return { ok: false, error: name.error }

  const subject = validateSubject(input.subject)
  if (!subject.ok) return { ok: false, error: subject.error }

  const body = validateBody(input.body_html)
  if (!body.ok) return { ok: false, error: body.error }

  const row = await (db as any)
    .insertInto('campaigns')
    .values({
      shop_id: shopId,
      name: name.value,
      subject: subject.value,
      body_html: body.value,
      audience_segment: input.audience_segment ?? null,
      discount_id: input.discount_id ?? null,
      created_by: input.created_by ?? null,
    })
    .returningAll()
    .executeTakeFirstOrThrow()

  return { ok: true, campaign: coerce(row) }
}

export async function listCampaigns(
  db: Kysely<Database>,
  shopId: string,
  filter: ListFilter = {},
): Promise<{ rows: CampaignRow[]; total: number }> {
  const limit = Math.min(Math.max(filter.limit ?? 20, 1), 100)
  const offset = Math.max(filter.offset ?? 0, 0)

  let base = (db as any)
    .selectFrom('campaigns')
    .where('shop_id', '=', shopId)

  if (filter.status) {
    const statuses = Array.isArray(filter.status) ? filter.status : [filter.status]
    base = base.where('status', 'in', statuses)
  }

  if (filter.search && filter.search.trim()) {
    const s = `%${filter.search.trim().toLowerCase()}%`
    base = base.where((eb: any) =>
      eb.or([
        eb(eb.fn('lower', ['name']), 'like', s),
        eb(eb.fn('lower', ['subject']), 'like', s),
      ]),
    )
  }

  const [rows, totalResult] = await Promise.all([
    base
      .selectAll()
      .orderBy('created_at', 'desc')
      .limit(limit)
      .offset(offset)
      .execute(),
    base
      .select((eb: any) => eb.fn.count('id').as('count'))
      .executeTakeFirst(),
  ])

  return {
    rows: rows.map(coerce),
    total: Number((totalResult?.count ?? 0) as number | string),
  }
}

export async function getCampaign(
  db: Kysely<Database>,
  shopId: string,
  campaignId: string,
): Promise<CampaignRow | null> {
  const row = await (db as any)
    .selectFrom('campaigns')
    .where('id', '=', campaignId)
    .where('shop_id', '=', shopId)
    .selectAll()
    .executeTakeFirst()
  return row ? coerce(row) : null
}

export async function updateCampaign(
  db: Kysely<Database>,
  shopId: string,
  campaignId: string,
  patch: UpdateCampaignInput,
): Promise<UpdateResult> {
  const existing = await getCampaign(db, shopId, campaignId)
  if (!existing) return { ok: false, error: 'not_found' }
  if (existing.status !== 'draft' && existing.status !== 'scheduled') {
    return { ok: false, error: 'immutable_status' }
  }

  const updates: Record<string, unknown> = {}

  if (patch.name !== undefined) {
    const n = validateName(patch.name)
    if (!n.ok) return { ok: false, error: n.error as UpdateError }
    updates.name = n.value
  }

  if (patch.subject !== undefined) {
    const s = validateSubject(patch.subject)
    if (!s.ok) return { ok: false, error: s.error as UpdateError }
    updates.subject = s.value
  }

  if (patch.body_html !== undefined) {
    const b = validateBody(patch.body_html)
    if (!b.ok) return { ok: false, error: b.error as UpdateError }
    updates.body_html = b.value
  }

  if (patch.audience_segment !== undefined) {
    updates.audience_segment = patch.audience_segment
  }
  if (patch.discount_id !== undefined) {
    updates.discount_id = patch.discount_id
  }

  if (Object.keys(updates).length === 0) {
    return { ok: true, campaign: existing }
  }

  updates.updated_at = new Date().toISOString()

  const row = await (db as any)
    .updateTable('campaigns')
    .set(updates)
    .where('id', '=', campaignId)
    .where('shop_id', '=', shopId)
    .returningAll()
    .executeTakeFirstOrThrow()

  return { ok: true, campaign: coerce(row) }
}

export async function deleteCampaign(
  db: Kysely<Database>,
  shopId: string,
  campaignId: string,
): Promise<DeleteResult> {
  const existing = await getCampaign(db, shopId, campaignId)
  if (!existing) return { ok: false, error: 'not_found' }
  if (existing.status !== 'draft' && existing.status !== 'cancelled') {
    return { ok: false, error: 'not_deletable' }
  }
  await (db as any)
    .deleteFrom('campaigns')
    .where('id', '=', campaignId)
    .where('shop_id', '=', shopId)
    .execute()
  return { ok: true }
}

// ---------------------------------------------------------------------------
// Lifecycle transitions
// ---------------------------------------------------------------------------

export async function scheduleCampaign(
  db: Kysely<Database>,
  shopId: string,
  campaignId: string,
  sendAt: Date | string,
  now: Date = new Date(),
): Promise<ScheduleResult> {
  const existing = await getCampaign(db, shopId, campaignId)
  if (!existing) return { ok: false, error: 'not_found' }
  if (existing.status !== 'draft') return { ok: false, error: 'wrong_status' }

  const parsed = sendAt instanceof Date ? sendAt : new Date(sendAt)
  if (!parsed || Number.isNaN(parsed.getTime())) {
    return { ok: false, error: 'send_at_required' }
  }
  if (parsed.getTime() <= now.getTime()) {
    return { ok: false, error: 'send_at_in_past' }
  }

  const row = await (db as any)
    .updateTable('campaigns')
    .set({
      status: 'scheduled',
      scheduled_at: parsed.toISOString(),
      updated_at: now.toISOString(),
    })
    .where('id', '=', campaignId)
    .where('shop_id', '=', shopId)
    .returningAll()
    .executeTakeFirstOrThrow()

  // --- PR3 automation emit ---------------------------------------------
  // Drives campaign_promo / flash_sale / seasonal_promo /
  // newsletter_broadcast flows via campaignType-conditioned catalog
  // entries. The campaigns table has no `type` column today; we default
  // to 'promo' so the `campaign_promo` flow fires. Typed multi-flavor
  // campaigns are a future migration — scope doc §3b.
  await emitIfEnabled(db, {
    type: 'campaign.scheduled',
    shopId,
    campaignId,
    campaignType: 'promo',
    sendAt: parsed,
  })

  return { ok: true, campaign: coerce(row) }
}

export async function cancelScheduled(
  db: Kysely<Database>,
  shopId: string,
  campaignId: string,
): Promise<ScheduleResult> {
  const existing = await getCampaign(db, shopId, campaignId)
  if (!existing) return { ok: false, error: 'not_found' }
  if (existing.status !== 'scheduled') return { ok: false, error: 'wrong_status' }

  const row = await (db as any)
    .updateTable('campaigns')
    .set({
      status: 'draft',
      scheduled_at: null,
      updated_at: new Date().toISOString(),
    })
    .where('id', '=', campaignId)
    .where('shop_id', '=', shopId)
    .returningAll()
    .executeTakeFirstOrThrow()

  return { ok: true, campaign: coerce(row) }
}

export async function markCampaignSending(
  db: Kysely<Database>,
  campaignId: string,
): Promise<CampaignRow | null> {
  const row = await (db as any)
    .updateTable('campaigns')
    .set({ status: 'sending', updated_at: new Date().toISOString() })
    .where('id', '=', campaignId)
    .where('status', 'in', ['scheduled', 'draft'])
    .returningAll()
    .executeTakeFirst()
  return row ? coerce(row) : null
}

export async function markCampaignSent(
  db: Kysely<Database>,
  campaignId: string,
): Promise<CampaignRow | null> {
  const now = new Date().toISOString()
  const row = await (db as any)
    .updateTable('campaigns')
    .set({ status: 'sent', sent_at: now, updated_at: now })
    .where('id', '=', campaignId)
    .where('status', '=', 'sending')
    .returningAll()
    .executeTakeFirst()
  return row ? coerce(row) : null
}

export async function markCampaignFailed(
  db: Kysely<Database>,
  campaignId: string,
  error: string,
): Promise<CampaignRow | null> {
  const row = await (db as any)
    .updateTable('campaigns')
    .set({
      status: 'failed',
      error: error.slice(0, 2000),
      updated_at: new Date().toISOString(),
    })
    .where('id', '=', campaignId)
    .returningAll()
    .executeTakeFirst()
  return row ? coerce(row) : null
}

// ---------------------------------------------------------------------------
// Recipients
// ---------------------------------------------------------------------------

/**
 * Resolves the campaign's audience to a list of `{customer_id, email}`
 * and inserts one row per recipient into `campaign_recipients`. Safe to
 * re-run: duplicates are skipped via the unique (campaign_id, email) index.
 *
 * Returns the number of NEW rows actually written. Also updates the
 * campaign's `recipient_count` column with the total count after the
 * insert.
 */
export async function snapshotRecipients(
  db: Kysely<Database>,
  shopId: string,
  campaignId: string,
): Promise<{ inserted: number; total: number }> {
  const campaign = await getCampaign(db, shopId, campaignId)
  if (!campaign) throw new Error(`campaign ${campaignId} not found`)

  // Build customer query — audience_segment may be null (= all subscribers).
  let customerQ = (db as any)
    .selectFrom('customers')
    .select(['id', 'email'])
    .where('shop_id', '=', shopId)
    .where('accepts_marketing', '=', true)
    .where('email', 'is not', null)

  // Segment filter: currently matches customers.tags containing the
  // segment slug. A future PR can swap this to a customer_segments rule
  // engine — for now, tag-based segmenting is the simplest path that
  // plays nicely with the existing `tags` column.
  if (campaign.audience_segment && campaign.audience_segment.trim()) {
    const tag = campaign.audience_segment.trim()
    // Postgres array contains operator — tags is text[], NULL means no tags
    customerQ = customerQ.where(
      sql<boolean>`customers.tags @> ARRAY[${tag}]::text[]`,
    )
  }

  const customers: Array<{ id: string; email: string | null }> =
    await customerQ.execute()

  const rows = customers
    .filter((c) => c.email && c.email.trim())
    .map((c) => ({
      campaign_id: campaignId,
      customer_id: c.id,
      email: c.email!.trim().toLowerCase(),
    }))

  if (rows.length === 0) {
    await (db as any)
      .updateTable('campaigns')
      .set({ recipient_count: 0, updated_at: new Date().toISOString() })
      .where('id', '=', campaignId)
      .execute()
    return { inserted: 0, total: 0 }
  }

  // Bulk insert with ON CONFLICT DO NOTHING for idempotency.
  const inserted = await (db as any)
    .insertInto('campaign_recipients')
    .values(rows)
    .onConflict((oc: any) => oc.columns(['campaign_id', 'email']).doNothing())
    .execute()

  // Count actual rows for this campaign after insert
  const totalResult = await (db as any)
    .selectFrom('campaign_recipients')
    .select((eb: any) => eb.fn.count('id').as('count'))
    .where('campaign_id', '=', campaignId)
    .executeTakeFirst()
  const total = Number((totalResult?.count ?? 0) as number | string)

  await (db as any)
    .updateTable('campaigns')
    .set({ recipient_count: total, updated_at: new Date().toISOString() })
    .where('id', '=', campaignId)
    .execute()

  // Kysely ExecuteResult: numInsertedOrUpdatedRows (bigint)
  const insertedCount = Array.isArray(inserted)
    ? inserted.reduce(
        (sum: number, r: any) => sum + Number(r.numInsertedOrUpdatedRows ?? 0),
        0,
      )
    : Number((inserted as any)?.numInsertedOrUpdatedRows ?? 0)

  return { inserted: insertedCount, total }
}

export async function listRecipients(
  db: Kysely<Database>,
  campaignId: string,
  limit = 100,
  offset = 0,
): Promise<CampaignRecipientRow[]> {
  const rows = await (db as any)
    .selectFrom('campaign_recipients')
    .where('campaign_id', '=', campaignId)
    .orderBy('created_at', 'asc')
    .limit(Math.min(Math.max(limit, 1), 1000))
    .offset(Math.max(offset, 0))
    .selectAll()
    .execute()
  return rows as CampaignRecipientRow[]
}

export async function getNextPendingRecipient(
  db: Kysely<Database>,
  campaignId: string,
): Promise<CampaignRecipientRow | null> {
  const row = await (db as any)
    .selectFrom('campaign_recipients')
    .where('campaign_id', '=', campaignId)
    .where('sent_at', 'is', null)
    .where('bounced_at', 'is', null)
    .where('unsubscribed_at', 'is', null)
    .orderBy('created_at', 'asc')
    .limit(1)
    .selectAll()
    .executeTakeFirst()
  return row ?? null
}

export async function recordRecipientSent(
  db: Kysely<Database>,
  recipientId: string,
): Promise<void> {
  await (db as any)
    .updateTable('campaign_recipients')
    .set({ sent_at: new Date().toISOString() })
    .where('id', '=', recipientId)
    .execute()
}

export async function markRecipientOpened(
  db: Kysely<Database>,
  recipientId: string,
): Promise<void> {
  const now = new Date().toISOString()
  const updated = await (db as any)
    .updateTable('campaign_recipients')
    .set({ opened_at: now })
    .where('id', '=', recipientId)
    .where('opened_at', 'is', null)
    .returning('campaign_id')
    .executeTakeFirst()
  if (updated) {
    await sql`
      UPDATE campaigns
      SET opened_count = opened_count + 1,
          updated_at = now()
      WHERE id = ${updated.campaign_id}
    `.execute(db as any)
  }
}

export async function markRecipientClicked(
  db: Kysely<Database>,
  recipientId: string,
): Promise<void> {
  const now = new Date().toISOString()
  const updated = await (db as any)
    .updateTable('campaign_recipients')
    .set({ clicked_at: now })
    .where('id', '=', recipientId)
    .where('clicked_at', 'is', null)
    .returning('campaign_id')
    .executeTakeFirst()
  if (updated) {
    await sql`
      UPDATE campaigns
      SET clicked_count = clicked_count + 1,
          updated_at = now()
      WHERE id = ${updated.campaign_id}
    `.execute(db as any)
  }
}

export async function markRecipientBounced(
  db: Kysely<Database>,
  recipientId: string,
  error: string,
): Promise<void> {
  await (db as any)
    .updateTable('campaign_recipients')
    .set({
      bounced_at: new Date().toISOString(),
      error: error.slice(0, 2000),
    })
    .where('id', '=', recipientId)
    .execute()
}

export async function markRecipientUnsubscribed(
  db: Kysely<Database>,
  recipientId: string,
): Promise<void> {
  await (db as any)
    .updateTable('campaign_recipients')
    .set({ unsubscribed_at: new Date().toISOString() })
    .where('id', '=', recipientId)
    .execute()
}

// ---------------------------------------------------------------------------
// Coercion
// ---------------------------------------------------------------------------

function coerce(row: any): CampaignRow {
  return {
    id: String(row.id),
    shop_id: String(row.shop_id),
    name: String(row.name),
    subject: String(row.subject),
    body_html: String(row.body_html),
    audience_segment: row.audience_segment ?? null,
    discount_id: row.discount_id ?? null,
    status: row.status as CampaignStatus,
    scheduled_at: row.scheduled_at ?? null,
    sent_at: row.sent_at ?? null,
    recipient_count: Number(row.recipient_count ?? 0),
    opened_count: Number(row.opened_count ?? 0),
    clicked_count: Number(row.clicked_count ?? 0),
    error: row.error ?? null,
    created_by: row.created_by ?? null,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  }
}
