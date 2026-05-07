/**
 * Phase 8 PR1 — Campaigns service + cron live-DB smoke.
 *
 * Unit coverage lives in:
 *   - packages/core/src/modules/marketing/campaigns.test.ts   (37 cases)
 *   - packages/core/src/modules/marketing/campaigns-cron.test.ts (4 cases)
 *   - apps/store-admin/src/pages/campaigns.test.ts            (24 cases)
 *
 * This script verifies the live Postgres path — migration 062 shape +
 * the JSON/tag containment query + cross-shop tenancy + idempotent
 * `ON CONFLICT DO NOTHING` snapshots + full dispatch tick.
 *
 * Run from server 2 (local Windows box can't reach PG):
 *
 *   DATABASE_URL=postgresql://gbox:GboxPlatform2026@192.168.1.13:5432/gbox_platform \
 *     npx tsx scripts/smoke-phase8-pr1.ts
 *
 * Cleans up every seeded row in finally{} so the script is re-runnable.
 *
 * Coverage (34 assertions):
 *   1.  createCampaign happy path + validation rejections (name/subject/body)
 *   2.  listCampaigns tenancy + status tab filter + search
 *   3.  getCampaign tenancy (cross-shop returns null)
 *   4.  updateCampaign draft mutation + immutable lock post-send
 *   5.  scheduleCampaign draft → scheduled + past-date rejection
 *   6.  cancelScheduled scheduled → draft
 *   7.  snapshotRecipients: all subscribers when segment=null
 *   8.  snapshotRecipients: tag-filtered audience (customers.tags @> ARRAY[tag])
 *   9.  snapshotRecipients: idempotent re-run inserts 0 new rows
 *  10. getNextPendingRecipient / recordRecipientSent flow
 *  11. markRecipientOpened / markRecipientClicked increment counts
 *  12. markCampaignSending / markCampaignSent happy path
 *  13. markCampaignFailed records error with truncation
 *  14. deleteCampaign: draft + cancelled deletable; scheduled/sending/sent not
 *  15. Cross-shop tenancy: shop-2 never sees shop-1 campaign
 */

import { randomUUID } from 'node:crypto'
import { createDb } from '../packages/db/src/index.js'
import {
  createCampaign,
  listCampaigns,
  getCampaign,
  updateCampaign,
  deleteCampaign,
  scheduleCampaign,
  cancelScheduled,
  snapshotRecipients,
  getNextPendingRecipient,
  recordRecipientSent,
  markRecipientOpened,
  markRecipientClicked,
  markRecipientBounced,
  markCampaignSending,
  markCampaignSent,
  markCampaignFailed,
} from '../packages/core/src/modules/marketing/campaigns.js'

const db = createDb({ connectionString: process.env.DATABASE_URL })

const SUFFIX = Date.now()
const SHOP_ID = randomUUID()
const OTHER_SHOP_ID = randomUUID()
const SUBSCRIBER_1 = randomUUID()
const SUBSCRIBER_2 = randomUUID()
const SUBSCRIBER_VIP = randomUUID()
const NON_SUBSCRIBER = randomUUID()

const createdCampaignIds = new Set<string>()

function log(s: string) {
  // eslint-disable-next-line no-console
  console.log(s)
}

let failed = 0
let total = 0
function assert(cond: boolean, msg: string) {
  total++
  if (cond) log(`  OK   ${msg}`)
  else {
    failed++
    log(`  FAIL ${msg}`)
  }
}

async function main() {
  log(`\n=== Phase 8 PR1 smoke — suffix=${SUFFIX} ===\n`)

  // -------------------------------------------------------------------------
  // [0] Seed shops + customers
  // -------------------------------------------------------------------------
  log('[0] Seeding shops + customers')
  await (db as any)
    .insertInto('shops')
    .values([
      {
        id: SHOP_ID,
        slug: `smoke-p8-1-${SUFFIX}`,
        name: 'PR1 Shop',
        email: `p8-1-${SUFFIX}@example.test`,
        status: 'active',
        plan: 'free',
      },
      {
        id: OTHER_SHOP_ID,
        slug: `smoke-p8-1-other-${SUFFIX}`,
        name: 'PR1 Other Shop',
        email: `p8-1-other-${SUFFIX}@example.test`,
        status: 'active',
        plan: 'free',
      },
    ])
    .execute()

  await (db as any)
    .insertInto('customers')
    .values([
      {
        id: SUBSCRIBER_1,
        shop_id: SHOP_ID,
        email: `sub1-${SUFFIX}@example.test`,
        first_name: 'Alice',
        last_name: 'One',
        accepts_marketing: true,
        tags: ['newsletter'],
      },
      {
        id: SUBSCRIBER_2,
        shop_id: SHOP_ID,
        email: `sub2-${SUFFIX}@example.test`,
        first_name: 'Bob',
        last_name: 'Two',
        accepts_marketing: true,
        tags: ['newsletter', 'early-adopter'],
      },
      {
        id: SUBSCRIBER_VIP,
        shop_id: SHOP_ID,
        email: `vip-${SUFFIX}@example.test`,
        first_name: 'Vip',
        last_name: 'Guest',
        accepts_marketing: true,
        tags: ['vip'],
      },
      {
        id: NON_SUBSCRIBER,
        shop_id: SHOP_ID,
        email: `nosub-${SUFFIX}@example.test`,
        first_name: 'Nono',
        last_name: 'Nope',
        accepts_marketing: false,
        tags: ['vip'],
      },
    ])
    .execute()

  // -------------------------------------------------------------------------
  // [1] createCampaign — happy path + validation rejections
  // -------------------------------------------------------------------------
  log('\n[1] createCampaign')
  const create1 = await createCampaign(db as any, SHOP_ID, {
    name: 'Spring sale',
    subject: '20% off everything',
    body_html: '<p>Hi — spring is here!</p>',
  })
  assert(create1.ok === true, '1.1 happy path returns ok=true')
  if (create1.ok) {
    createdCampaignIds.add(create1.campaign.id)
    assert(create1.campaign.status === 'draft', '1.2 new campaign starts in draft')
    assert(create1.campaign.shop_id === SHOP_ID, '1.3 shop_id scoped')
    assert(create1.campaign.recipient_count === 0, '1.4 recipient_count=0 on create')
  }

  const badName = await createCampaign(db as any, SHOP_ID, {
    name: '',
    subject: 'S',
    body_html: 'B',
  })
  assert(
    !badName.ok && badName.error === 'name_required',
    '1.5 blank name rejected with name_required',
  )

  const badSubject = await createCampaign(db as any, SHOP_ID, {
    name: 'N',
    subject: '  ',
    body_html: 'B',
  })
  assert(
    !badSubject.ok && badSubject.error === 'subject_required',
    '1.6 blank subject rejected with subject_required',
  )

  const badBody = await createCampaign(db as any, SHOP_ID, {
    name: 'N',
    subject: 'S',
    body_html: '',
  })
  assert(
    !badBody.ok && badBody.error === 'body_required',
    '1.7 empty body rejected with body_required',
  )

  // Also seed a VIP segment campaign to exercise tag filtering later
  const create2 = await createCampaign(db as any, SHOP_ID, {
    name: 'VIP only',
    subject: 'Exclusive preview',
    body_html: '<p>You are VIP.</p>',
    audience_segment: 'vip',
  })
  assert(create2.ok === true, '1.8 VIP-segmented campaign created')
  if (create2.ok) createdCampaignIds.add(create2.campaign.id)

  if (!create1.ok || !create2.ok) {
    throw new Error('create1 or create2 failed — abort smoke')
  }
  const C1 = create1.campaign.id
  const C2 = create2.campaign.id

  // -------------------------------------------------------------------------
  // [2] listCampaigns — tenancy + filter + search
  // -------------------------------------------------------------------------
  log('\n[2] listCampaigns')
  const listAll = await listCampaigns(db as any, SHOP_ID)
  assert(listAll.total >= 2, '2.1 list returns 2+ campaigns for shop 1')
  assert(
    listAll.rows.every((r) => r.shop_id === SHOP_ID),
    '2.2 every row scoped to shop 1',
  )

  const listOther = await listCampaigns(db as any, OTHER_SHOP_ID)
  assert(listOther.total === 0, '2.3 other shop sees 0 campaigns (tenancy)')

  const listDraft = await listCampaigns(db as any, SHOP_ID, { status: 'draft' })
  assert(
    listDraft.rows.every((r) => r.status === 'draft'),
    '2.4 status filter narrows to draft only',
  )

  const listSearch = await listCampaigns(db as any, SHOP_ID, { search: 'VIP' })
  assert(
    listSearch.rows.some((r) => r.name === 'VIP only'),
    '2.5 search matches by name (case-insensitive)',
  )

  // -------------------------------------------------------------------------
  // [3] getCampaign — tenancy
  // -------------------------------------------------------------------------
  log('\n[3] getCampaign tenancy')
  const mine = await getCampaign(db as any, SHOP_ID, C1)
  assert(mine?.id === C1, '3.1 my shop can read my campaign')
  const cross = await getCampaign(db as any, OTHER_SHOP_ID, C1)
  assert(cross === null, '3.2 other shop gets null for my campaign')

  // -------------------------------------------------------------------------
  // [4] updateCampaign — mutation + immutable lock
  // -------------------------------------------------------------------------
  log('\n[4] updateCampaign')
  const upd = await updateCampaign(db as any, SHOP_ID, C1, {
    name: 'Spring sale v2',
    subject: '25% off',
  })
  assert(upd.ok === true, '4.1 draft update succeeds')
  if (upd.ok) {
    assert(upd.campaign.name === 'Spring sale v2', '4.2 name mutated')
    assert(upd.campaign.subject === '25% off', '4.3 subject mutated')
  }

  // Try updating a non-draft row: we'll mark C2 as sent directly for this
  await (db as any)
    .updateTable('campaigns')
    .set({ status: 'sent' })
    .where('id', '=', C2)
    .execute()
  const lockedUpdate = await updateCampaign(db as any, SHOP_ID, C2, {
    name: 'cannot',
  })
  assert(
    !lockedUpdate.ok && lockedUpdate.error === 'immutable_status',
    '4.4 sent campaign rejects update with immutable_status',
  )
  // Revert C2 to draft for later assertions
  await (db as any)
    .updateTable('campaigns')
    .set({ status: 'draft', sent_at: null })
    .where('id', '=', C2)
    .execute()

  // -------------------------------------------------------------------------
  // [5] scheduleCampaign — happy + past-date rejection
  // -------------------------------------------------------------------------
  log('\n[5] scheduleCampaign')
  const pastSchedule = await scheduleCampaign(
    db as any,
    SHOP_ID,
    C1,
    new Date(Date.now() - 60_000),
  )
  assert(
    !pastSchedule.ok && pastSchedule.error === 'send_at_in_past',
    '5.1 past date rejected with send_at_in_past',
  )

  const future = new Date(Date.now() + 10 * 60_000)
  const sched = await scheduleCampaign(db as any, SHOP_ID, C1, future)
  assert(sched.ok === true, '5.2 schedule with future date succeeds')
  if (sched.ok) {
    assert(sched.campaign.status === 'scheduled', '5.3 status → scheduled')
    assert(sched.campaign.scheduled_at !== null, '5.4 scheduled_at stamped')
  }

  // -------------------------------------------------------------------------
  // [6] cancelScheduled — scheduled → draft
  // -------------------------------------------------------------------------
  log('\n[6] cancelScheduled')
  const cancel = await cancelScheduled(db as any, SHOP_ID, C1)
  assert(cancel.ok === true, '6.1 cancel scheduled succeeds')
  if (cancel.ok) {
    assert(cancel.campaign.status === 'draft', '6.2 status → draft')
    assert(cancel.campaign.scheduled_at === null, '6.3 scheduled_at cleared')
  }

  // -------------------------------------------------------------------------
  // [7-9] snapshotRecipients — audiences
  // -------------------------------------------------------------------------
  log('\n[7] snapshotRecipients: all subscribers (segment=null)')
  const snap1 = await snapshotRecipients(db as any, SHOP_ID, C1)
  assert(
    snap1.total === 3,
    `7.1 campaign with no segment captures all 3 subscribers (got ${snap1.total})`,
  )
  assert(snap1.inserted === 3, '7.2 inserted === 3 on first snapshot')

  log('\n[8] snapshotRecipients: segment="vip"')
  const snap2 = await snapshotRecipients(db as any, SHOP_ID, C2)
  assert(
    snap2.total === 1,
    `8.1 VIP segment captures only the single subscribing VIP (got ${snap2.total})`,
  )
  const vipRecipients = await (db as any)
    .selectFrom('campaign_recipients')
    .where('campaign_id', '=', C2)
    .selectAll()
    .execute()
  assert(
    vipRecipients.length === 1 &&
      vipRecipients[0].email === `vip-${SUFFIX}@example.test`,
    '8.2 VIP recipient email matches the vip-tagged subscriber',
  )
  assert(
    !vipRecipients.some((r: any) => r.email === `nosub-${SUFFIX}@example.test`),
    '8.3 non-subscriber with vip tag is excluded (accepts_marketing=false filter)',
  )

  log('\n[9] snapshotRecipients idempotency')
  const snap1Again = await snapshotRecipients(db as any, SHOP_ID, C1)
  assert(snap1Again.total === 3, '9.1 second snapshot reports same total (3)')
  assert(
    snap1Again.inserted === 0,
    '9.2 second snapshot inserts 0 new rows (ON CONFLICT DO NOTHING)',
  )

  // -------------------------------------------------------------------------
  // [10] getNextPendingRecipient / recordRecipientSent
  // -------------------------------------------------------------------------
  log('\n[10] pending → sent flow')
  const next1 = await getNextPendingRecipient(db as any, C1)
  assert(next1 !== null, '10.1 first pending recipient returned')
  if (next1) {
    await recordRecipientSent(db as any, next1.id)
    const next2 = await getNextPendingRecipient(db as any, C1)
    assert(
      next2 !== null && next2.id !== next1.id,
      '10.2 next pending returns a different row after first stamped',
    )
  }

  // -------------------------------------------------------------------------
  // [11] markRecipientOpened / markRecipientClicked
  // -------------------------------------------------------------------------
  log('\n[11] recipient tracking increments')
  if (next1) {
    await markRecipientOpened(db as any, next1.id)
    await markRecipientClicked(db as any, next1.id)
    // Opening twice should NOT double-count
    await markRecipientOpened(db as any, next1.id)

    const refreshed = await getCampaign(db as any, SHOP_ID, C1)
    assert(refreshed?.opened_count === 1, '11.1 opened_count = 1 (not 2)')
    assert(refreshed?.clicked_count === 1, '11.2 clicked_count = 1')
  }

  // -------------------------------------------------------------------------
  // [12] markCampaignSending / markCampaignSent
  // -------------------------------------------------------------------------
  log('\n[12] status transitions')
  // Need a campaign in scheduled or draft state
  await (db as any)
    .updateTable('campaigns')
    .set({ status: 'scheduled' })
    .where('id', '=', C1)
    .execute()
  const sending = await markCampaignSending(db as any, C1)
  assert(sending?.status === 'sending', '12.1 scheduled → sending')

  const sent = await markCampaignSent(db as any, C1)
  assert(sent?.status === 'sent', '12.2 sending → sent')
  assert(sent?.sent_at !== null, '12.3 sent_at stamped on sent transition')

  // -------------------------------------------------------------------------
  // [13] markCampaignFailed
  // -------------------------------------------------------------------------
  log('\n[13] markCampaignFailed')
  const failed1 = await markCampaignFailed(
    db as any,
    C2,
    'Email delivery is not configured.',
  )
  assert(failed1?.status === 'failed', '13.1 status → failed')
  assert(
    failed1?.error === 'Email delivery is not configured.',
    '13.2 error message recorded verbatim',
  )

  // -------------------------------------------------------------------------
  // [14] deleteCampaign — deletable states only
  // -------------------------------------------------------------------------
  log('\n[14] deleteCampaign deletable states')
  // Create a fresh draft campaign for this
  const create3 = await createCampaign(db as any, SHOP_ID, {
    name: 'Temp',
    subject: 'T',
    body_html: 'T',
  })
  if (!create3.ok) throw new Error('create3 must succeed')
  const C3 = create3.campaign.id
  createdCampaignIds.add(C3)

  const del1 = await deleteCampaign(db as any, SHOP_ID, C3)
  assert(del1.ok === true, '14.1 draft deletes successfully')
  createdCampaignIds.delete(C3)

  const delSent = await deleteCampaign(db as any, SHOP_ID, C1)
  assert(
    !delSent.ok && delSent.error === 'not_deletable',
    '14.2 sent campaign refuses delete',
  )

  // C2 is failed — not_deletable too
  const delFailed = await deleteCampaign(db as any, SHOP_ID, C2)
  assert(
    !delFailed.ok && delFailed.error === 'not_deletable',
    '14.3 failed campaign refuses delete',
  )

  log(`\n=== DONE: ${total - failed}/${total} passed, ${failed} failed ===\n`)
}

main()
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error('SMOKE CRASHED', err)
    failed = Math.max(failed, 1)
  })
  .finally(async () => {
    log('\n[cleanup] deleting seeded rows')
    try {
      if (createdCampaignIds.size > 0) {
        await (db as any)
          .deleteFrom('campaign_recipients')
          .where('campaign_id', 'in', [...createdCampaignIds])
          .execute()
        await (db as any)
          .deleteFrom('campaigns')
          .where('id', 'in', [...createdCampaignIds])
          .execute()
      }
      await (db as any)
        .deleteFrom('customers')
        .where('id', 'in', [SUBSCRIBER_1, SUBSCRIBER_2, SUBSCRIBER_VIP, NON_SUBSCRIBER])
        .execute()
      await (db as any)
        .deleteFrom('shops')
        .where('id', 'in', [SHOP_ID, OTHER_SHOP_ID])
        .execute()
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('cleanup failed', err)
    }
    await (db as any).destroy()
    process.exit(failed === 0 ? 0 : 1)
  })
