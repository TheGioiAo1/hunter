/**
 * Phase 9 PR4 — Staff + Permissions + Security + Alerts.
 *
 * Unit coverage lives in:
 *   - packages/core/src/modules/staff/permissions.test.ts     (31 cases)
 *   - packages/core/src/modules/staff/invitations.test.ts     ( 5 cases)
 *   - packages/core/src/modules/staff/login-events.test.ts    (10 cases)
 *   - packages/core/src/modules/staff/alerts.test.ts          (15 cases)
 *
 * This script verifies the live Postgres path — migration 069 shape,
 * invitation lifecycle, member CRUD + guards, login-event new-device
 * detection, alert dispatch + fan-out + preferences, and the
 * iron-rule-5 audit.
 *
 * Run from server 2:
 *
 *   DATABASE_URL=postgresql://gbox:GboxPlatform2026@192.168.1.13:5432/gbox_platform \
 *     npx tsx scripts/smoke-phase9-pr4.ts
 *
 * Cleans up every seeded row in finally{} so the script is re-runnable.
 *
 * Coverage (assertions numbered below):
 *   [1]  Migration 069 — staff_invitations table exists
 *   [2]  Migration 069 — staff_login_events table exists
 *   [3]  Migration 069 — staff_alerts table exists
 *   [4]  Migration 069 — staff_alert_preferences table exists
 *   [5]  Migration 069 — user_shops.permissions_computed + disabled_at exist
 *   [6]  Migration 069 — UNIQUE partial index on pending invitations
 *   [7]  createInvitation — happy path returns raw token + hashed row
 *   [8]  createInvitation — duplicate pending rejected
 *   [9]  createInvitation — bad role rejected
 *   [10] findInvitationByToken — finds pending row
 *   [11] acceptInvitation — creates user_shops row with resolved perms
 *   [12] acceptInvitation — stamps accepted_at + accepted_by_user_id
 *   [13] revokeInvitation — stamps revoked_at
 *   [14] listMembers — returns invited staff with join on users
 *   [15] updateMember — persists new role + permissions_computed
 *   [16] disableMember — stamps disabled_at
 *   [17] reenableMember — clears disabled_at
 *   [18] removeMember — deletes row, owner guard holds
 *   [19] recordLoginEvent — success outcome persists row
 *   [20] recordLoginEvent — second login from same fp has is_new_device=false
 *   [21] recordLoginEvent — fresh fingerprint has is_new_device=true
 *   [22] hasSeenDevice — consistent with stored events
 *   [23] dispatchAlert (target_user_id) — one row + email target honouring pref
 *   [24] dispatchAlert (fan-out) — skips users with via_inapp=false
 *   [25] upsertPreference — overrides catalog default
 *   [26] markAlertRead / dismissAlert — stamps timestamps
 *   [27] Iron rule 5 audit — no 'god admin' strings in staff error copy
 */

import { randomUUID } from 'node:crypto'
import { createDb } from '../packages/db/src/index.js'
import {
  createInvitation,
  findInvitationByToken,
  acceptInvitation,
  revokeInvitation,
  _hashToken,
  DuplicateInvitationError,
  InvalidInvitationInputError,
} from '../packages/core/src/modules/staff/invitations.js'
import {
  listMembers,
  updateMember,
  disableMember,
  reenableMember,
  removeMember,
  CannotRemoveOwnerError,
} from '../packages/core/src/modules/staff/members.js'
import {
  recordLoginEvent,
  hasSeenDevice,
  listLoginEvents,
} from '../packages/core/src/modules/staff/login-events.js'
import {
  dispatchAlert,
  upsertPreference,
  listAlerts,
  markAlertRead,
  dismissAlert,
} from '../packages/core/src/modules/staff/alerts.js'
import { resolvePermissions } from '../packages/core/src/modules/staff/permissions.js'

const db = createDb({ connectionString: process.env.DATABASE_URL })

const SUFFIX = Date.now()
const SHOP_A = randomUUID()
const OWNER_ID = randomUUID()
const INVITEE_A_ID = randomUUID()
const INVITEE_B_ID = randomUUID()

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
  log(`\n=== Phase 9 PR4 smoke — suffix=${SUFFIX} ===\n`)

  // -------------------------------------------------------------------------
  // [0] Seed shop + owner + two invitee user rows
  // -------------------------------------------------------------------------
  log('[0] Seeding shop A + owner + two invitee users')
  await (db as any)
    .insertInto('users')
    .values([
      {
        id: OWNER_ID,
        email: `p9-4-owner-${SUFFIX}@example.test`,
        name: 'Owner User',
        status: 'active',
        role: 'owner', // platform-level role; shop-level is 'owner' too here
      },
      {
        id: INVITEE_A_ID,
        email: `p9-4-a-${SUFFIX}@example.test`,
        name: 'Invitee Alice',
        status: 'active',
        role: 'staff',
      },
      {
        id: INVITEE_B_ID,
        email: `p9-4-b-${SUFFIX}@example.test`,
        name: 'Invitee Bob',
        status: 'active',
        role: 'staff',
      },
    ])
    .execute()

  await (db as any)
    .insertInto('shops')
    .values({
      id: SHOP_A,
      slug: `smoke-p9-4-${SUFFIX}`,
      name: 'PR4 Shop',
      email: `p9-4-shop-${SUFFIX}@example.test`,
      status: 'active',
      plan: 'free',
    })
    .execute()

  // Owner row on user_shops so listMembers returns at least one "owner".
  await (db as any)
    .insertInto('user_shops')
    .values({
      user_id: OWNER_ID,
      shop_id: SHOP_A,
      role: 'owner',
      permissions: JSON.stringify([]),
      permissions_computed: JSON.stringify([]),
    })
    .execute()

  // -------------------------------------------------------------------------
  // [1..6] Migration 069 shape
  // -------------------------------------------------------------------------
  log('\n[1..6] Migration 069 shape')

  async function tableExists(name: string): Promise<boolean> {
    const rows = await (db as any)
      .selectFrom('information_schema.tables' as any)
      .where('table_name', '=', name)
      .select(['table_name'])
      .execute()
    return rows.length === 1
  }

  assert(await tableExists('staff_invitations'), '[1] staff_invitations table exists')
  assert(await tableExists('staff_login_events'), '[2] staff_login_events table exists')
  assert(await tableExists('staff_alerts'), '[3] staff_alerts table exists')
  assert(await tableExists('staff_alert_preferences'), '[4] staff_alert_preferences table exists')

  const usCols = await (db as any)
    .selectFrom('information_schema.columns' as any)
    .where('table_name', '=', 'user_shops')
    .select(['column_name'])
    .execute()
  const usSet = new Set(usCols.map((c: any) => c.column_name))
  assert(
    usSet.has('permissions_computed') && usSet.has('disabled_at')
      && usSet.has('invited_by') && usSet.has('invited_at')
      && usSet.has('last_active_at'),
    '[5] user_shops columns (permissions_computed/disabled_at/invited_*/last_active_at) exist',
  )

  const idxRows = await (db as any)
    .selectFrom('pg_indexes' as any)
    .where('indexname', '=', 'idx_staff_invitations_pending')
    .select(['indexdef'])
    .execute()
  const idxDef = String(idxRows[0]?.indexdef ?? '')
  assert(
    idxDef.includes('UNIQUE')
      && /status/i.test(idxDef)
      && /'pending'/i.test(idxDef),
    '[6] UNIQUE partial index on pending invitations exists',
  )

  // -------------------------------------------------------------------------
  // [7..9] createInvitation
  // -------------------------------------------------------------------------
  log('\n[7..9] createInvitation')

  const invA = await createInvitation(db as any, {
    shop_id: SHOP_A,
    email: `p9-4-a-${SUFFIX}@example.test`,
    role: 'staff',
    permissions: ['orders:view', 'products:view'],
    invited_by: OWNER_ID,
  })
  // Pull the stored row to verify token_hash is the SHA-256 of the raw token.
  const storedA = await (db as any)
    .selectFrom('staff_invitations')
    .select(['token_hash'])
    .where('id', '=', invA.invitation.id)
    .executeTakeFirst()
  const rawHash = _hashToken(invA.token)
  assert(
    typeof invA.token === 'string' && invA.token.length === 64
      && String(storedA?.token_hash).length === 64
      && String(storedA?.token_hash) === rawHash
      && String(storedA?.token_hash) !== invA.token,
    '[7] createInvitation returns 64-char raw token + SHA-256 token_hash persisted (raw never stored)',
  )

  let dupRejected = false
  try {
    await createInvitation(db as any, {
      shop_id: SHOP_A,
      email: `p9-4-a-${SUFFIX}@example.test`,
      role: 'staff',
      permissions: [],
      invited_by: OWNER_ID,
    })
  } catch (err) {
    dupRejected = err instanceof DuplicateInvitationError
  }
  assert(dupRejected, '[8] duplicate pending invitation rejected with DuplicateInvitationError')

  let badRoleRejected = false
  try {
    await createInvitation(db as any, {
      shop_id: SHOP_A,
      email: `p9-4-other-${SUFFIX}@example.test`,
      role: 'owner' as any,
      permissions: [],
      invited_by: OWNER_ID,
    })
  } catch (err) {
    badRoleRejected = err instanceof InvalidInvitationInputError
  }
  assert(badRoleRejected, '[9] role=owner invitation rejected with InvalidInvitationInputError')

  // -------------------------------------------------------------------------
  // [10..13] findInvitationByToken + acceptInvitation + revokeInvitation
  // -------------------------------------------------------------------------
  log('\n[10..13] find/accept/revoke invitation')

  const found = await findInvitationByToken(db as any, invA.token)
  assert(!!found && found.id === invA.invitation.id, '[10] findInvitationByToken finds pending row')

  const accepted = await acceptInvitation(db as any, {
    token: invA.token,
    accepting_user_id: INVITEE_A_ID,
  })
  const expectedComputed = resolvePermissions('staff', ['orders:view', 'products:view'])
  assert(
    accepted.user_shop.user_id === INVITEE_A_ID
      && accepted.user_shop.role === 'staff'
      && Array.isArray(accepted.user_shop.permissions_computed)
      && accepted.user_shop.permissions_computed.length === expectedComputed.length,
    '[11] acceptInvitation creates user_shops row with resolved permissions',
  )

  const acceptedRow = await (db as any)
    .selectFrom('staff_invitations')
    .selectAll()
    .where('id', '=', invA.invitation.id)
    .executeTakeFirst()
  assert(
    acceptedRow?.status === 'accepted'
      && acceptedRow?.accepted_at
      && acceptedRow?.accepted_by_user_id === INVITEE_A_ID,
    '[12] acceptInvitation stamps status/accepted_at/accepted_by_user_id',
  )

  // Create + revoke a second invitation.
  const invB = await createInvitation(db as any, {
    shop_id: SHOP_A,
    email: `p9-4-revoke-${SUFFIX}@example.test`,
    role: 'limited',
    permissions: [],
    invited_by: OWNER_ID,
  })
  await revokeInvitation(db as any, {
    id: invB.invitation.id,
    shop_id: SHOP_A,
    revoked_by: OWNER_ID,
  })
  const revokedRow = await (db as any)
    .selectFrom('staff_invitations')
    .selectAll()
    .where('id', '=', invB.invitation.id)
    .executeTakeFirst()
  assert(
    revokedRow?.status === 'revoked' && revokedRow?.revoked_at,
    '[13] revokeInvitation stamps revoked_at + status=revoked',
  )

  // -------------------------------------------------------------------------
  // [14..18] Member CRUD + guards
  // -------------------------------------------------------------------------
  log('\n[14..18] Member CRUD + guards')

  const members = await listMembers(db as any, SHOP_A)
  // Owner + invitee A (invitee B was not accepted).
  assert(
    members.length === 2
      && members.some((m: any) => m.user_id === OWNER_ID && m.role === 'owner')
      && members.some((m: any) => m.user_id === INVITEE_A_ID && m.role === 'staff'),
    '[14] listMembers returns owner + accepted invitee with users join',
  )

  await updateMember(db as any, {
    shop_id: SHOP_A,
    user_id: INVITEE_A_ID,
    role: 'admin',
    permissions: ['customers:view', 'analytics:view'],
    actor_user_id: OWNER_ID,
  })
  const updated = await (db as any)
    .selectFrom('user_shops')
    .select(['role', 'permissions', 'permissions_computed'])
    .where('user_id', '=', INVITEE_A_ID)
    .where('shop_id', '=', SHOP_A)
    .executeTakeFirst()
  const computedAdmin = resolvePermissions('admin', ['customers:view', 'analytics:view'])
  const rawComputed = updated?.permissions_computed
  const computedArr: string[] = Array.isArray(rawComputed)
    ? rawComputed
    : typeof rawComputed === 'string' ? JSON.parse(rawComputed) : []
  assert(
    updated?.role === 'admin' && computedArr.length === computedAdmin.length,
    '[15] updateMember persists role + permissions_computed',
  )

  await disableMember(db as any, {
    shop_id: SHOP_A,
    user_id: INVITEE_A_ID,
    actor_user_id: OWNER_ID,
  })
  const disabled = await (db as any)
    .selectFrom('user_shops')
    .select(['disabled_at'])
    .where('user_id', '=', INVITEE_A_ID)
    .where('shop_id', '=', SHOP_A)
    .executeTakeFirst()
  assert(!!disabled?.disabled_at, '[16] disableMember stamps disabled_at')

  await reenableMember(db as any, {
    shop_id: SHOP_A,
    user_id: INVITEE_A_ID,
    actor_user_id: OWNER_ID,
  })
  const reenabled = await (db as any)
    .selectFrom('user_shops')
    .select(['disabled_at'])
    .where('user_id', '=', INVITEE_A_ID)
    .where('shop_id', '=', SHOP_A)
    .executeTakeFirst()
  assert(reenabled?.disabled_at === null, '[17] reenableMember clears disabled_at')

  // removeMember: owner cannot be removed (even by a different actor).
  let ownerGuard = false
  try {
    await removeMember(db as any, {
      shop_id: SHOP_A,
      user_id: OWNER_ID,
      actor_user_id: INVITEE_A_ID,
    })
  } catch (err) {
    ownerGuard = err instanceof CannotRemoveOwnerError
  }
  await removeMember(db as any, {
    shop_id: SHOP_A,
    user_id: INVITEE_A_ID,
    actor_user_id: OWNER_ID,
  })
  const remaining = await (db as any)
    .selectFrom('user_shops')
    .select(['user_id'])
    .where('shop_id', '=', SHOP_A)
    .execute()
  assert(
    ownerGuard && remaining.length === 1 && remaining[0].user_id === OWNER_ID,
    '[18] removeMember deletes non-owner; owner guard rejects owner removal',
  )

  // -------------------------------------------------------------------------
  // [19..22] Login events + new-device detection
  // -------------------------------------------------------------------------
  log('\n[19..22] Login events + new-device detection')

  const ev1 = await recordLoginEvent(db as any, {
    user_id: OWNER_ID,
    shop_id: SHOP_A,
    outcome: 'success',
    ip_address: '203.0.113.10',
    user_agent: 'Mozilla/5.0 (Macintosh) Chrome/120',
  })
  assert(!!ev1 && ev1.outcome === 'success', '[19] recordLoginEvent — success outcome persists row')

  // Same fingerprint (same /24 + version-stripped UA) → is_new_device=false.
  const ev2 = await recordLoginEvent(db as any, {
    user_id: OWNER_ID,
    shop_id: SHOP_A,
    outcome: 'success',
    ip_address: '203.0.113.99', // same /24
    user_agent: 'Mozilla/5.0 (Macintosh) Chrome/121', // only version differs
  })
  assert(
    !!ev2 && ev2.is_new_device === false,
    '[20] second login on same fingerprint → is_new_device=false',
  )

  // Totally different UA + IP block → is_new_device=true.
  const ev3 = await recordLoginEvent(db as any, {
    user_id: OWNER_ID,
    shop_id: SHOP_A,
    outcome: 'success',
    ip_address: '198.51.100.1',
    user_agent: 'Mozilla/5.0 (iPhone) Safari/604',
  })
  assert(
    !!ev3 && ev3.is_new_device === true,
    '[21] fresh fingerprint → is_new_device=true',
  )

  const seen = await hasSeenDevice(db as any, OWNER_ID, ev1!.device_fingerprint!)
  assert(seen === true, '[22] hasSeenDevice true for a fingerprint we\'ve already logged in from')

  const list = await listLoginEvents(db as any, { user_id: OWNER_ID, limit: 10 })
  assert(list.length >= 3, '[22b] listLoginEvents returns recorded rows')

  // -------------------------------------------------------------------------
  // [23..26] Alerts dispatch + preferences + read/dismiss
  // -------------------------------------------------------------------------
  log('\n[23..26] Alerts')

  // Need a staff member again for fan-out — accept invitee B.
  const invC = await createInvitation(db as any, {
    shop_id: SHOP_A,
    email: `p9-4-b-${SUFFIX}@example.test`,
    role: 'staff',
    permissions: [],
    invited_by: OWNER_ID,
  })
  await acceptInvitation(db as any, {
    token: invC.token,
    accepting_user_id: INVITEE_B_ID,
  })

  // Target single user.
  const single = await dispatchAlert(db as any, {
    shop_id: SHOP_A,
    event_type: 'staff.new_device_login',
    title: 'New device sign-in',
    message: 'You signed in from a new device.',
    target_user_id: OWNER_ID,
  })
  assert(
    single.created.length === 1 && single.created[0].target_user_id === OWNER_ID,
    '[23] dispatchAlert(target_user_id) creates a single alert row',
  )

  // Mute in-app for invitee B on order.placed; then fan-out should only
  // hit the owner (invitee B skipped).
  await upsertPreference(db as any, {
    user_id: INVITEE_B_ID,
    shop_id: SHOP_A,
    event_type: 'order.placed',
    via_email: false,
    via_inapp: false,
  })
  const fanOut = await dispatchAlert(db as any, {
    shop_id: SHOP_A,
    event_type: 'order.placed',
    title: 'New order placed',
    message: 'Smoke order.',
  })
  const fanUsers = new Set(fanOut.created.map((a: any) => String(a.target_user_id)))
  assert(
    fanOut.created.length === 1 && fanUsers.has(OWNER_ID) && !fanUsers.has(INVITEE_B_ID),
    '[24] fan-out respects via_inapp=false preference (invitee B skipped)',
  )

  // Catalog default for order.payment_failed is inapp=true + email=true
  // for both users, so expect 2 inapp rows (both unmuted).
  const fanOut2 = await dispatchAlert(db as any, {
    shop_id: SHOP_A,
    event_type: 'order.payment_failed',
    title: 'Payment failed',
    message: 'Smoke payment failure.',
  })
  assert(fanOut2.created.length === 2, '[25a] default pref (inapp=true) fans out to both staff')

  // Confirm preference override takes effect.
  const muted = await dispatchAlert(db as any, {
    shop_id: SHOP_A,
    event_type: 'order.placed',
    title: 'Another order',
    message: 'Smoke order 2.',
  })
  assert(muted.created.length === 1, '[25b] upsertPreference override still effective on next dispatch')

  // Mark one alert read + dismiss another.
  const firstAlert = single.created[0]
  await markAlertRead(db as any, firstAlert.id, SHOP_A, OWNER_ID)
  const afterRead = await (db as any)
    .selectFrom('staff_alerts')
    .select(['read_at'])
    .where('id', '=', firstAlert.id)
    .executeTakeFirst()
  const secondAlert = fanOut.created.find((a: any) => String(a.target_user_id) === OWNER_ID)
    ?? fanOut.created[0]
  await dismissAlert(db as any, secondAlert.id, SHOP_A, OWNER_ID)
  const afterDismiss = await (db as any)
    .selectFrom('staff_alerts')
    .select(['dismissed_at'])
    .where('id', '=', secondAlert.id)
    .executeTakeFirst()
  assert(
    !!afterRead?.read_at && !!afterDismiss?.dismissed_at,
    '[26] markAlertRead + dismissAlert stamp timestamps',
  )

  const alertsUnread = await listAlerts(db as any, {
    shop_id: SHOP_A,
    user_id: OWNER_ID,
    status: 'unread',
  })
  assert(Array.isArray(alertsUnread), '[26b] listAlerts returns array')

  // -------------------------------------------------------------------------
  // [27] Iron rule 5 audit — no 'god admin' strings in staff error copy
  // -------------------------------------------------------------------------
  log('\n[27] Iron rule 5 audit')
  const godAdmin = /god[\s-]*admin/i
  const messages: string[] = []
  try {
    await createInvitation(db as any, {
      shop_id: SHOP_A,
      email: 'not-an-email',
      role: 'staff',
      permissions: [],
      invited_by: OWNER_ID,
    })
  } catch (e: any) {
    messages.push(e.message ?? String(e))
  }
  try {
    await createInvitation(db as any, {
      shop_id: SHOP_A,
      email: `p9-4-dup2-${SUFFIX}@example.test`,
      role: 'owner' as any,
      permissions: [],
      invited_by: OWNER_ID,
    })
  } catch (e: any) {
    messages.push(e.message ?? String(e))
  }
  try {
    await removeMember(db as any, {
      shop_id: SHOP_A,
      user_id: OWNER_ID,
      actor_user_id: OWNER_ID,
    })
  } catch (e: any) {
    messages.push(e.message ?? String(e))
  }
  assert(
    messages.length >= 2
      && messages.every((m) => !godAdmin.test(m)),
    `[27] No god-admin strings in error copy (scanned ${messages.length} messages)`,
  )

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------
  log(`\n=== Phase 9 PR4 smoke: ${total - failed}/${total} passed (${failed} failed) ===\n`)
  process.exitCode = failed === 0 ? 0 : 1
}

main()
  .catch((err) => {
    console.error('Phase 9 PR4 smoke — fatal error:', err)
    process.exitCode = 1
  })
  .finally(async () => {
    log('\n[cleanup] Removing seeded rows')
    try {
      await (db as any).deleteFrom('staff_alert_preferences').where('shop_id', '=', SHOP_A).execute()
      await (db as any).deleteFrom('staff_alerts').where('shop_id', '=', SHOP_A).execute()
      await (db as any).deleteFrom('staff_login_events').where('shop_id', '=', SHOP_A).execute()
      await (db as any).deleteFrom('staff_invitations').where('shop_id', '=', SHOP_A).execute()
      await (db as any).deleteFrom('user_shops').where('shop_id', '=', SHOP_A).execute()
      await (db as any).deleteFrom('shops').where('id', '=', SHOP_A).execute()
      await (db as any).deleteFrom('users')
        .where('id', 'in', [OWNER_ID, INVITEE_A_ID, INVITEE_B_ID])
        .execute()
      log('[cleanup] Done.')
    } catch (err) {
      console.error('[cleanup] failed:', err)
    }
    await (db as any).destroy()
  })
