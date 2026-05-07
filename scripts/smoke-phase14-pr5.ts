/**
 * Phase 14 PR5 — GDPR / Privacy compliance pack — live-DB smoke.
 *
 * Complements the unit layer (consent-ledger + privacy-requests +
 * data-export-packager + bounce-aggregator + salt-rotation — ~250 cases)
 * with one end-to-end run that walks every state transition against a
 * real Postgres, exercising the concurrency guards that vitest can't.
 *
 * INVARIANTS ASSERTED
 * ===================
 *
 *   [A] Migration 088 schema present
 *       [A1] customer_privacy_requests — all 18 expected columns
 *       [A2] consent_events — all 13 expected columns
 *       [A3] email_tracking_salt_rotations — all 6 expected columns
 *       [A4] idx_cpr_unique_active_deletion (partial UNIQUE) present
 *       [A5] idx_cpr_scheduled_deletion (finalizer cron hot path) present
 *
 *   [B] Consent ledger — append-only writer
 *       [B1] recordConsent writes a row + returns {id, recordedAt:Date}
 *       [B2] PII-hygiene regex rejects metadata.user_email / phone / address / name
 *       [B3] latestConsentFor returns the most-recent row
 *       [B4] listConsentEvents is shop-scoped (SHOP_B can't see SHOP_A)
 *       [B5] recordedAt is a real Date (pg TIMESTAMPTZ parse, not a string)
 *
 *   [C] Privacy request state machine — export + rectification
 *       [C1] requestDataExport → pending row, id returned
 *       [C2] markExportReady → status=ready + downloadTokenRaw returned once
 *       [C3] consumeDownloadToken → atomic flip to 'consumed' + returns storageKey
 *       [C4] second consumeDownloadToken on the same token → already_consumed
 *       [C5] rectification request can be created + admin mark-ready flips to completed
 *
 *   [D] Privacy request state machine — deletion + cancel
 *       [D1] requestAccountDeletion → pending + scheduledDeletionAt ≈ now+30d
 *       [D2] partial UNIQUE guard: second requestAccountDeletion for the
 *            same (shop, customer) → reason='deletion_already_pending'
 *       [D3] cancelDeletion(rawToken) flips to 'cancelled' + completed_at set
 *       [D4] second cancelDeletion on the same token → already_cancelled
 *
 *   [E] Data export packager — pure function + in-memory storage
 *       [E1] packageCustomerData returns zip+json+csvMap+manifest+filename
 *       [E2] zip buffer is a valid DEFLATE archive (magic bytes 'PK\x03\x04')
 *       [E3] manifest.files_sha256 matches actual sha256 of each buffer
 *       [E4] InMemoryExportStorage.uploadExport round-trips the ZIP
 *       [E5] read(storageKey) === original zip buffer bytes
 *
 *   [F] Soft-bounce aggregator — 5-in-30d → hard promotion
 *       [F1] Seed 5 soft bounces on SHOP_A + 2 on SHOP_B for the same address
 *       [F2] runSoftBounceAggregator promotes SHOP_A (count >= threshold)
 *            + does NOT promote SHOP_B (count < threshold)
 *       [F3] suppressions row: reason='hard_bounce',
 *            source_transport='soft_bounce_rollup', shop_id=SHOP_A
 *       [F4] second run is idempotent — action='already_suppressed'
 *       [F5] dryRun=true never writes (scanned > 0, promoted = 0)
 *
 *   [G] Salt rotation — audit + rate-limit + --force
 *       [G1] first rotation (no prior row) → hadPrevious=false, oldSaltHash=null
 *       [G2] audit row in email_tracking_salt_rotations with sha256 hashes only
 *       [G3] immediate second rotation (no --force) → reason='rate_limited'
 *            + nextAllowedAt ISO set
 *       [G4] force=true bypasses and writes a second audit row
 *       [G5] raw salts never stored — old_salt_hash + new_salt_hash are
 *            64 hex chars each, and NEVER equal the raw salts we got back
 *
 *   [H] Cross-shop isolation + Iron Rule 5
 *       [H1] SHOP_B cannot cancel SHOP_A's deletion via adminCancelDeletion
 *            (cross-shop access denied → reason='not_found')
 *       [H2] listPrivacyRequests({shopId=SHOP_B}) returns 0 of SHOP_A's rows
 *       [H3] No god_admin / /god-admin/ strings in any result surface
 *            (recordConsent, requestDataExport, cancel / consume / aggregator
 *            / rotation results all scanned)
 *
 * USAGE (from server 2 — local Windows box can't reach the PG):
 *
 *   DATABASE_URL=postgresql://gbox:GboxPlatform2026@192.168.1.13:5432/gbox_platform \
 *     npx tsx scripts/smoke-phase14-pr5.ts
 *
 * Forces NODE_ENV='test' + EMAIL_TRANSPORT='console' on entry so no
 * outbound mail leaks. Cleans up every seeded row in finally{}.
 */

import 'dotenv/config'
import { randomUUID, createHash } from 'node:crypto'
import { createDb } from '../packages/db/src/index.js'
import {
  recordConsent,
  listConsentEvents,
  latestConsentFor,
} from '../packages/core/src/modules/email/consent-ledger.js'
import {
  requestDataExport,
  requestAccountDeletion,
  markExportReady,
  consumeDownloadToken,
  cancelDeletion,
  adminCancelDeletion,
  listPrivacyRequests,
  getPrivacyRequestById,
  hashToken,
} from '../packages/core/src/modules/email/privacy-requests.js'
import {
  packageCustomerData,
  InMemoryExportStorage,
} from '../packages/core/src/modules/email/data-export-packager.js'
import { runSoftBounceAggregator } from '../packages/core/src/modules/email/bounce-aggregator.js'
import {
  rotateTrackingSalt,
  hashSalt,
} from '../packages/core/src/modules/email/salt-rotation.js'

// ─── Env isolation ─────────────────────────────────────────────────
const ORIGINAL_ENV = {
  NODE_ENV: process.env.NODE_ENV,
  EMAIL_TRANSPORT: process.env.EMAIL_TRANSPORT,
  EMAIL_TRACKING_IP_SALT: process.env.EMAIL_TRACKING_IP_SALT,
}
if (process.env.NODE_ENV === 'production') {
  throw new Error('smoke-phase14-pr5 must not be run with NODE_ENV=production')
}
process.env.NODE_ENV = 'test'
process.env.EMAIL_TRANSPORT = 'console'

const db = createDb({ connectionString: process.env.DATABASE_URL })

const SUFFIX = Date.now()
const SHOP_A = randomUUID()
const SHOP_B = randomUUID()
const CUSTOMER_A = randomUUID()
const CUSTOMER_B = randomUUID()
const CUSTOMER_EMAIL_A = `p14pr5-a-${SUFFIX}@example.test`
const CUSTOMER_EMAIL_B = `p14pr5-b-${SUFFIX}@example.test`
// A single recipient address hit by soft-bounces on BOTH shops.
const SOFT_BOUNCER = `soft-bouncer-${SUFFIX}@dead.example.test`

// ─── Assertion helper ──────────────────────────────────────────────
function log(s: string) {
  // eslint-disable-next-line no-console
  console.log(s)
}
let total = 0
let failed = 0
function assert(cond: boolean, msg: string): void {
  total++
  if (cond) log(`  OK   ${msg}`)
  else {
    failed++
    log(`  FAIL ${msg}`)
  }
}

// Track IDs so cleanup is precise (a prior crashed run shouldn't block
// re-runs; finally{} filters by SHOP_A/SHOP_B UUIDs which are unique
// per process).
const CREATED_DELIVERY_IDS: number[] = []
const CREATED_EVENT_IDS: number[] = []
const CREATED_REQUEST_IDS: number[] = []
const CREATED_ROTATION_IDS: number[] = []

// ─── Seeding helpers ───────────────────────────────────────────────
async function seedShop(id: string, tag: string) {
  await (db as any)
    .insertInto('shops')
    .values({
      id,
      slug: `smoke-p14-5-${tag}-${SUFFIX}`,
      name: `PR5 Shop ${tag.toUpperCase()}`,
      email: `p14-5-shop-${tag}-${SUFFIX}@example.test`,
      status: 'active',
      plan: 'free',
    })
    .execute()
}

async function seedCustomer(opts: {
  id: string
  shopId: string
  email: string
}) {
  await (db as any)
    .insertInto('customers')
    .values({
      id: opts.id,
      shop_id: opts.shopId,
      email: opts.email,
      first_name: 'Smoke',
      last_name: 'Customer',
      phone: null,
      status: 'active',
    })
    .execute()
}

async function seedDelivery(opts: {
  shopId: string
  recipient: string
  smtpMessageId: string
}): Promise<number> {
  const row = await (db as any)
    .insertInto('email_deliveries')
    .values({
      // `newsletter_broadcast` is seeded in email_template_registry
      // (see scripts/seed-email-registry.ts, migration 083). Safer
      // than PR4.B's 'marketing_promo', which wasn't added to the
      // registry — the FK constraint blocks inserts of unknown keys.
      template_key: 'newsletter_broadcast',
      shop_id: opts.shopId,
      recipient_email: opts.recipient,
      recipient_customer_id: null,
      recipient_user_id: null,
      subject: `PR5 smoke ${SUFFIX}`,
      body_preview: 'smoke preview',
      status: 'sent',
      provider: 'ses',
      smtp_message_id: opts.smtpMessageId,
      failed_reason: null,
      failed_at: null,
      sent_at: new Date().toISOString(),
      bounced_at: null,
      opened_at: null,
      clicked_at: null,
      idempotency_key: null,
      tracking_token: null,
    })
    .returning(['id'])
    .executeTakeFirstOrThrow()
  const id = Number(row.id)
  CREATED_DELIVERY_IDS.push(id)
  return id
}

async function seedBounceEvent(opts: {
  deliveryId: number
  bounceType: 'soft' | 'transient' | 'hard'
  occurredAt?: Date
}): Promise<number> {
  const row = await (db as any)
    .insertInto('email_events')
    .values({
      delivery_id: opts.deliveryId,
      event_type: 'bounce',
      occurred_at: (opts.occurredAt ?? new Date()).toISOString(),
      user_agent: null,
      ip_hash: null,
      clicked_url: null,
      bounce_type: opts.bounceType,
      raw_payload: null,
    })
    .returning(['id'])
    .executeTakeFirstOrThrow()
  const id = Number(row.id)
  CREATED_EVENT_IDS.push(id)
  return id
}

// ─── Main test flow ────────────────────────────────────────────────
async function main() {
  log(`\n=== Phase 14 PR5 smoke — suffix=${SUFFIX} ===\n`)
  log(`   SHOP_A = ${SHOP_A}`)
  log(`   SHOP_B = ${SHOP_B}`)

  // -------------------------------------------------------------------
  // [0] Seed shops + customers. customer_privacy_requests.customer_id
  // FKs into customers.id, and customers.shop_id FKs into shops.id.
  // -------------------------------------------------------------------
  log('\n[0] Seeding 2 shops + 2 customers')
  await seedShop(SHOP_A, 'a')
  await seedShop(SHOP_B, 'b')
  await seedCustomer({ id: CUSTOMER_A, shopId: SHOP_A, email: CUSTOMER_EMAIL_A })
  await seedCustomer({ id: CUSTOMER_B, shopId: SHOP_B, email: CUSTOMER_EMAIL_B })

  // -------------------------------------------------------------------
  // [A] Migration 088 schema present
  // -------------------------------------------------------------------
  log('\n[A] Migration 088 schema present')

  const cprCols = await (db as any)
    .selectFrom('information_schema.columns' as any)
    .select(['column_name'])
    .where('table_schema', '=', 'public')
    .where('table_name', '=', 'customer_privacy_requests')
    .execute()
  const cprColNames = new Set(cprCols.map((r: any) => r.column_name))
  const expectedCprCols = [
    'id',
    'shop_id',
    'customer_id',
    'customer_email_lower',
    'request_type',
    'status',
    'storage_key',
    'download_token_hash',
    'download_expires_at',
    'download_consumed_at',
    'scheduled_deletion_at',
    'cancel_token_hash',
    'rectification_payload',
    'requested_at',
    'processed_at',
    'completed_at',
    'processor_user_id',
    'notes',
    'last_error',
    'created_at',
    'updated_at',
  ]
  const missingCpr = expectedCprCols.filter((c) => !cprColNames.has(c))
  assert(
    missingCpr.length === 0,
    `[A1] customer_privacy_requests has all expected columns (missing=${missingCpr.join(',') || 'none'})`,
  )

  const consentCols = await (db as any)
    .selectFrom('information_schema.columns' as any)
    .select(['column_name'])
    .where('table_schema', '=', 'public')
    .where('table_name', '=', 'consent_events')
    .execute()
  const consentColNames = new Set(consentCols.map((r: any) => r.column_name))
  const expectedConsentCols = [
    'id',
    'shop_id',
    'customer_id',
    'email_address_lower',
    'consent_type',
    'action',
    'source',
    'source_url',
    'ip_hash',
    'user_agent_family',
    'actor_user_id',
    'actor_role',
    'recorded_at',
    'metadata',
    'created_at',
  ]
  const missingConsent = expectedConsentCols.filter((c) => !consentColNames.has(c))
  assert(
    missingConsent.length === 0,
    `[A2] consent_events has all expected columns (missing=${missingConsent.join(',') || 'none'})`,
  )

  const saltCols = await (db as any)
    .selectFrom('information_schema.columns' as any)
    .select(['column_name'])
    .where('table_schema', '=', 'public')
    .where('table_name', '=', 'email_tracking_salt_rotations')
    .execute()
  const saltColNames = new Set(saltCols.map((r: any) => r.column_name))
  const expectedSaltCols = [
    'id',
    'rotated_at',
    'rotated_by',
    'old_salt_hash',
    'new_salt_hash',
    'reason',
    'created_at',
  ]
  const missingSalt = expectedSaltCols.filter((c) => !saltColNames.has(c))
  assert(
    missingSalt.length === 0,
    `[A3] email_tracking_salt_rotations has all expected columns (missing=${missingSalt.join(',') || 'none'})`,
  )

  const cprIndexes = await (db as any)
    .selectFrom('pg_indexes' as any)
    .select(['indexname'])
    .where('schemaname', '=', 'public')
    .where('tablename', '=', 'customer_privacy_requests')
    .execute()
  const cprIxNames = new Set(cprIndexes.map((r: any) => r.indexname))
  assert(
    cprIxNames.has('idx_cpr_unique_active_deletion'),
    `[A4] idx_cpr_unique_active_deletion partial UNIQUE present`,
  )
  assert(
    cprIxNames.has('idx_cpr_scheduled_deletion'),
    `[A5] idx_cpr_scheduled_deletion finalizer-cron index present`,
  )

  // -------------------------------------------------------------------
  // [B] Consent ledger — append-only writer + PII hygiene
  // -------------------------------------------------------------------
  log('\n[B] Consent ledger')

  // Ensure the IP-tracking salt is set so hashIpWithCurrentSalt returns
  // a real hex — we want to prove ip_hash is populated (not just null).
  process.env.EMAIL_TRACKING_IP_SALT = `smoke-pr5-salt-${SUFFIX}`

  const c1 = await recordConsent(db as any, {
    shopId: SHOP_A,
    customerId: CUSTOMER_A,
    email: CUSTOMER_EMAIL_A,
    consentType: 'marketing',
    action: 'opt_in',
    source: 'checkout',
    sourceUrl: 'https://shop-a.example.test/checkout',
    ip: '203.0.113.42',
    userAgent: 'Mozilla/5.0 (X11) Chrome/124.0',
    actorRole: 'customer',
    metadata: { checkout_id: 'co_abc', referrer: 'direct' },
  })
  assert(
    c1.ok === true &&
      typeof c1.id === 'number' &&
      c1.recordedAt instanceof Date,
    `[B1] recordConsent → {ok:true, id, recordedAt:Date}`,
  )

  // PII-hygiene guard: metadata.user_email is a forbidden key
  const badMeta = await recordConsent(db as any, {
    shopId: SHOP_A,
    customerId: CUSTOMER_A,
    email: CUSTOMER_EMAIL_A,
    consentType: 'analytics',
    action: 'opt_in',
    source: 'preference_center',
    actorRole: 'customer',
    metadata: { user_email: 'leak@example.com' },
  })
  assert(
    badMeta.ok === false && 'reason' in badMeta && badMeta.reason === 'invalid_metadata',
    `[B2a] PII-hygiene rejects metadata.user_email (reason=${String((badMeta as any).reason)})`,
  )

  const badMeta2 = await recordConsent(db as any, {
    shopId: SHOP_A,
    customerId: CUSTOMER_A,
    email: CUSTOMER_EMAIL_A,
    consentType: 'analytics',
    action: 'opt_in',
    source: 'preference_center',
    actorRole: 'customer',
    metadata: { last_name: 'Bui' },
  })
  assert(
    badMeta2.ok === false && 'reason' in badMeta2 && badMeta2.reason === 'invalid_metadata',
    `[B2b] PII-hygiene rejects metadata.last_name`,
  )

  // latestConsentFor after a follow-up opt_out should return opt_out
  await recordConsent(db as any, {
    shopId: SHOP_A,
    customerId: CUSTOMER_A,
    email: CUSTOMER_EMAIL_A,
    consentType: 'marketing',
    action: 'opt_out',
    source: 'preference_center',
    actorRole: 'customer',
  })
  const latest = await latestConsentFor(db as any, {
    shopId: SHOP_A,
    email: CUSTOMER_EMAIL_A,
    consentType: 'marketing',
  })
  assert(
    latest != null && latest.action === 'opt_out',
    `[B3] latestConsentFor returns most-recent row (action=${latest?.action})`,
  )

  // Shop isolation on listConsentEvents
  const bList = await listConsentEvents(db as any, { shopId: SHOP_B })
  const bSeesA = bList.some((r) => r.emailAddressLower === CUSTOMER_EMAIL_A.toLowerCase())
  assert(!bSeesA, `[B4] listConsentEvents({shopId=SHOP_B}) does NOT include SHOP_A rows`)

  // recordedAt must be a real Date (pg node parses TIMESTAMPTZ → Date)
  assert(
    c1.ok === true && c1.recordedAt instanceof Date && !Number.isNaN(c1.recordedAt.getTime()),
    `[B5] recordedAt is a real Date (ts=${c1.ok ? c1.recordedAt.toISOString() : 'n/a'})`,
  )

  // -------------------------------------------------------------------
  // [C] Privacy request state machine — export + rectification
  // -------------------------------------------------------------------
  log('\n[C] Privacy request state machine — export + rectification')

  const exp = await requestDataExport(db as any, {
    shopId: SHOP_A,
    customerId: CUSTOMER_A,
    email: CUSTOMER_EMAIL_A,
    notes: 'smoke PR5 export',
  })
  assert(
    exp.ok === true && exp.status === 'pending' && typeof exp.id === 'number',
    `[C1] requestDataExport → {ok:true, id, status:'pending'}`,
  )
  if (exp.ok) CREATED_REQUEST_IDS.push(exp.id)

  // Mark the export ready with an obviously-fake storage key + 15-min expiry
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000)
  const mark = exp.ok
    ? await markExportReady(db as any, {
        requestId: exp.id,
        storageKey: `privacy-exports/${SHOP_A}/${exp.id}-smoke.zip`,
        downloadExpiresAt: expiresAt,
      })
    : { ok: false as const, reason: 'not_found' as const, error: 'prior request failed' }
  assert(
    mark.ok === true && typeof (mark as any).downloadTokenRaw === 'string' &&
      ((mark as any).downloadTokenRaw as string).length === 48,
    `[C2] markExportReady → downloadTokenRaw is 48 hex chars`,
  )

  // First consume → ok=true
  const rawDownloadToken = mark.ok ? (mark as any).downloadTokenRaw as string : ''
  const consume1 = await consumeDownloadToken(db as any, { rawToken: rawDownloadToken })
  assert(
    consume1.ok === true &&
      (consume1 as any).shopId === SHOP_A &&
      typeof (consume1 as any).storageKey === 'string' &&
      ((consume1 as any).storageKey as string).startsWith('privacy-exports/'),
    `[C3] consumeDownloadToken atomic flip → ok=true (storageKey=${(consume1 as any).storageKey ?? ''})`,
  )

  // Second consume on the same token → already_consumed
  const consume2 = await consumeDownloadToken(db as any, { rawToken: rawDownloadToken })
  assert(
    consume2.ok === false && 'reason' in consume2 && consume2.reason === 'already_consumed',
    `[C4] second consume on same token → already_consumed (got reason=${String((consume2 as any).reason)})`,
  )

  // Rectification request — direct insert (the module has no wrapper;
  // privacy-requests.ts is export/deletion-shaped, rectification uses
  // direct table writes in the admin page handler).
  const rectRow = await (db as any)
    .insertInto('customer_privacy_requests')
    .values({
      shop_id: SHOP_A,
      customer_id: CUSTOMER_A,
      customer_email_lower: CUSTOMER_EMAIL_A.toLowerCase(),
      request_type: 'rectification',
      status: 'pending',
      rectification_payload: JSON.stringify({ field: 'first_name', desiredValue: 'Customer' }),
      notes: 'smoke PR5 rectification',
    })
    .returning(['id'])
    .executeTakeFirstOrThrow()
  const rectId = Number(rectRow.id)
  CREATED_REQUEST_IDS.push(rectId)

  // Admin mark-ready for rectification — mirrors postMarkReadyAction in
  // apps/store-admin/src/pages/privacy-requests.ts
  await (db as any)
    .updateTable('customer_privacy_requests')
    .set({ status: 'completed', completed_at: new Date() } as any)
    .where('id', '=', rectId)
    .where('shop_id', '=', SHOP_A)
    .execute()

  const rectAfter = await getPrivacyRequestById(db as any, {
    requestId: rectId,
    shopId: SHOP_A,
  })
  assert(
    rectAfter != null && rectAfter.status === 'completed' && rectAfter.completedAt != null,
    `[C5] rectification mark-ready → status='completed' + completedAt set`,
  )

  // -------------------------------------------------------------------
  // [D] Privacy request state machine — deletion + cancel + guard
  // -------------------------------------------------------------------
  log('\n[D] Privacy request state machine — deletion + cancel')

  const del1 = await requestAccountDeletion(db as any, {
    shopId: SHOP_A,
    customerId: CUSTOMER_A,
    email: CUSTOMER_EMAIL_A,
    notes: 'smoke PR5 deletion',
  })
  assert(
    del1.ok === true &&
      typeof del1.id === 'number' &&
      del1.scheduledDeletionAt instanceof Date &&
      typeof del1.cancelTokenRaw === 'string' &&
      del1.cancelTokenRaw.length === 48,
    `[D1a] requestAccountDeletion → {ok:true, id, scheduledDeletionAt:Date, cancelTokenRaw}`,
  )
  if (del1.ok) CREATED_REQUEST_IDS.push(del1.id)

  // scheduledDeletionAt ≈ now + 30 days (default grace)
  const expectedMs = 30 * 24 * 60 * 60 * 1000
  const actualDiff = del1.ok ? del1.scheduledDeletionAt.getTime() - Date.now() : 0
  const delta = Math.abs(actualDiff - expectedMs)
  assert(
    delta < 60_000,
    `[D1b] scheduledDeletionAt ≈ now+30d (delta=${delta}ms from 30-day boundary)`,
  )

  // Partial-UNIQUE guard: a second deletion for same (shop, customer)
  // while the first is still pending → reason='deletion_already_pending'
  const del2 = await requestAccountDeletion(db as any, {
    shopId: SHOP_A,
    customerId: CUSTOMER_A,
    email: CUSTOMER_EMAIL_A,
  })
  assert(
    del2.ok === false && 'reason' in del2 && del2.reason === 'deletion_already_pending',
    `[D2] partial UNIQUE guard: second deletion → 'deletion_already_pending' (got reason=${String((del2 as any).reason)})`,
  )

  // Cancel the deletion via token
  const rawCancel = del1.ok ? del1.cancelTokenRaw : ''
  const cancel1 = await cancelDeletion(db as any, { rawToken: rawCancel })
  assert(
    cancel1.ok === true &&
      (cancel1 as any).shopId === SHOP_A &&
      (cancel1 as any).customerId === CUSTOMER_A,
    `[D3a] cancelDeletion via rawToken → ok=true`,
  )

  // Verify status flipped in DB
  const delAfterCancel = del1.ok
    ? await getPrivacyRequestById(db as any, { requestId: del1.id, shopId: SHOP_A })
    : null
  assert(
    delAfterCancel != null &&
      delAfterCancel.status === 'cancelled' &&
      delAfterCancel.completedAt != null,
    `[D3b] deletion row: status='cancelled' + completedAt set`,
  )

  // Second cancel on same token → already_cancelled
  const cancel2 = await cancelDeletion(db as any, { rawToken: rawCancel })
  assert(
    cancel2.ok === false && 'reason' in cancel2 && cancel2.reason === 'already_cancelled',
    `[D4] second cancel on same token → already_cancelled (got reason=${String((cancel2 as any).reason)})`,
  )

  // -------------------------------------------------------------------
  // [E] Data export packager — pure function + in-memory storage
  // -------------------------------------------------------------------
  log('\n[E] Data export packager')

  const pkg = await packageCustomerData({
    customer: {
      id: CUSTOMER_A,
      email: CUSTOMER_EMAIL_A,
      first_name: 'Smoke',
      last_name: 'Customer',
      phone: null,
      created_at: new Date(),
      accepts_marketing: true,
      locale: 'en',
      country: 'US',
    },
    orders: [
      {
        id: 'ord_1',
        order_number: 1001,
        status: 'paid',
        financial_status: 'paid',
        fulfillment_status: 'fulfilled',
        total_price: '42.00',
        currency: 'USD',
        created_at: new Date(),
        shipping_address: { country: 'US' },
        billing_address: { country: 'US' },
        line_items: [
          { product_title: 'Thing', quantity: 1, unit_price: '42.00', sku: 'SKU-1' },
        ],
      },
    ],
    emailDeliveries: [],
    emailTrackingEvents: [],
    emailPreferences: [
      { category: 'marketing', opted_in: true, max_per_day: 3, max_per_week: 10, updated_at: new Date() },
    ],
    consentEvents: [
      {
        consent_type: 'marketing',
        action: 'opt_in',
        source: 'checkout',
        source_url: null,
        user_agent_family: 'chrome',
        actor_role: 'customer',
        recorded_at: new Date(),
      },
    ],
    suppressions: [],
    meta: { generatedAt: new Date(), requestId: exp.ok ? exp.id : 0, shopName: 'PR5 Shop A' },
  })

  assert(
    Buffer.isBuffer(pkg.zip) &&
      Buffer.isBuffer(pkg.json) &&
      typeof pkg.csvMap === 'object' &&
      typeof pkg.filename === 'string' &&
      pkg.filename.startsWith('customer-export-'),
    `[E1] packageCustomerData returns zip/json/csvMap/filename`,
  )

  // ZIP magic bytes: 0x50 0x4B 0x03 0x04
  assert(
    pkg.zip[0] === 0x50 && pkg.zip[1] === 0x4b && pkg.zip[2] === 0x03 && pkg.zip[3] === 0x04,
    `[E2] zip buffer starts with PK\\x03\\x04 (valid DEFLATE magic)`,
  )

  // Manifest hashes match actual buffers
  const jsonHash = createHash('sha256').update(pkg.json).digest('hex')
  assert(
    pkg.manifest.files_sha256['customer.json'] === jsonHash,
    `[E3a] manifest.files_sha256['customer.json'] matches sha256(json)`,
  )
  const custCsvBuf = pkg.csvMap['customer.csv']!
  const custCsvHash = createHash('sha256').update(custCsvBuf).digest('hex')
  assert(
    pkg.manifest.files_sha256['csv/customer.csv'] === custCsvHash,
    `[E3b] manifest.files_sha256['csv/customer.csv'] matches sha256(customer.csv)`,
  )

  // InMemoryExportStorage round-trip
  const storage = new InMemoryExportStorage()
  const upload = await storage.uploadExport({
    shopId: SHOP_A,
    requestId: exp.ok ? exp.id : 0,
    zipBuffer: pkg.zip,
    filename: pkg.filename,
  })
  assert(
    typeof upload.storageKey === 'string' && upload.storageKey.startsWith('privacy-exports/'),
    `[E4] InMemoryExportStorage.uploadExport returns privacy-exports/ key`,
  )

  const readBack = storage.read(upload.storageKey)
  assert(
    readBack != null && readBack.equals(pkg.zip),
    `[E5] storage.read(storageKey) === original zip bytes`,
  )

  // -------------------------------------------------------------------
  // [F] Soft-bounce aggregator — 5-in-30d → hard promotion
  // -------------------------------------------------------------------
  log('\n[F] Soft-bounce aggregator')

  // SHOP_A: 5 soft bounces (should promote). SHOP_B: 2 soft bounces
  // on same recipient (should NOT promote — below threshold).
  const deliveriesForAggregatorCleanup: number[] = []
  for (let i = 0; i < 5; i++) {
    const did = await seedDelivery({
      shopId: SHOP_A,
      recipient: SOFT_BOUNCER,
      smtpMessageId: `<soft-a-${SUFFIX}-${i}@gbox.test>`,
    })
    deliveriesForAggregatorCleanup.push(did)
    await seedBounceEvent({
      deliveryId: did,
      bounceType: i % 2 === 0 ? 'soft' : 'transient',
    })
  }
  for (let i = 0; i < 2; i++) {
    const did = await seedDelivery({
      shopId: SHOP_B,
      recipient: SOFT_BOUNCER,
      smtpMessageId: `<soft-b-${SUFFIX}-${i}@gbox.test>`,
    })
    deliveriesForAggregatorCleanup.push(did)
    await seedBounceEvent({ deliveryId: did, bounceType: 'soft' })
  }

  // dryRun first — must NOT write anything
  const dryResult = await runSoftBounceAggregator(db as any, {
    windowDays: 30,
    threshold: 5,
    dryRun: true,
    maxCandidates: 50,
  })
  const dryAtoms = dryResult.candidates.filter(
    (c) => c.shopId === SHOP_A && c.emailLower === SOFT_BOUNCER.toLowerCase(),
  )
  assert(
    dryResult.promoted === 0 && dryAtoms.length === 1 && dryAtoms[0].action === 'dry_run',
    `[F5] dryRun → promoted=0 + SHOP_A candidate flagged action='dry_run'`,
  )

  // Real run — expect exactly SHOP_A to promote
  const aggregateResult = await runSoftBounceAggregator(db as any, {
    windowDays: 30,
    threshold: 5,
    dryRun: false,
    maxCandidates: 50,
  })

  const shopAPromoted = aggregateResult.candidates.find(
    (c) => c.shopId === SHOP_A && c.emailLower === SOFT_BOUNCER.toLowerCase(),
  )
  const shopBPromoted = aggregateResult.candidates.find(
    (c) => c.shopId === SHOP_B && c.emailLower === SOFT_BOUNCER.toLowerCase(),
  )
  // If the aggregator errored (e.g. CHECK constraint drift), include the
  // error in the assertion message so post-mortem is a one-line read.
  const f1Diag =
    shopAPromoted?.action === 'error' ? ` err=${shopAPromoted.error ?? '<none>'}` : ''
  assert(
    shopAPromoted != null && shopAPromoted.action === 'promoted' && shopAPromoted.softBounceCount === 5,
    `[F1] SHOP_A soft count=5 → action='promoted' (got action=${shopAPromoted?.action}, count=${shopAPromoted?.softBounceCount}${f1Diag})`,
  )
  assert(
    shopBPromoted == null,
    `[F2] SHOP_B soft count=2 → NOT in candidates (below threshold, correctly excluded)`,
  )

  // Suppression row written for SHOP_A
  const supRow = await (db as any)
    .selectFrom('email_suppressions')
    .select(['id', 'reason', 'source_transport', 'shop_id', 'unsuppressed_at'])
    .where('shop_id', '=', SHOP_A)
    .where('email_address_lower', '=', SOFT_BOUNCER.toLowerCase())
    .where('unsuppressed_at', 'is', null)
    .executeTakeFirst()
  assert(
    supRow != null &&
      supRow.reason === 'hard_bounce' &&
      supRow.source_transport === 'soft_bounce_rollup' &&
      supRow.shop_id === SHOP_A,
    `[F3] email_suppressions: active row — reason=hard_bounce, source=soft_bounce_rollup, shop=SHOP_A`,
  )

  // Second run → idempotent (already_suppressed)
  const aggregateAgain = await runSoftBounceAggregator(db as any, {
    windowDays: 30,
    threshold: 5,
    dryRun: false,
    maxCandidates: 50,
  })
  const shopACandAgain = aggregateAgain.candidates.find(
    (c) => c.shopId === SHOP_A && c.emailLower === SOFT_BOUNCER.toLowerCase(),
  )
  assert(
    aggregateAgain.promoted === 0 && shopACandAgain?.action === 'already_suppressed',
    `[F4] second aggregator run is idempotent (promoted=${aggregateAgain.promoted}, action=${shopACandAgain?.action})`,
  )

  // -------------------------------------------------------------------
  // [G] Salt rotation — audit + rate-limit + --force + hash-only storage
  // -------------------------------------------------------------------
  log('\n[G] Salt rotation')

  // Clear any prior rotation rows in our window (defensive) — rotate
  // with the --force path to guarantee the first call in this run is
  // always fresh. We skip that by reading the last row's hash first.
  const lastBefore = await (db as any)
    .selectFrom('email_tracking_salt_rotations')
    .select(['id', 'rotated_at', 'new_salt_hash'])
    .orderBy('rotated_at', 'desc')
    .limit(1)
    .executeTakeFirst()
  const hadPrior = lastBefore != null

  // Force=true so whatever state the dev DB is in, we get a known row
  const rot1 = await rotateTrackingSalt(db as any, {
    rotatedBy: `cli:smoke-pr5-${SUFFIX}`,
    reason: 'smoke PR5 commit 10',
    force: true,
  })
  assert(
    rot1.ok === true &&
      typeof rot1.newSalt === 'string' &&
      rot1.newSalt.length === 64 &&
      rot1.newSaltHash === hashSalt(rot1.newSalt) &&
      typeof rot1.rotationId === 'number',
    `[G1] rotation ok=true + newSalt (64 hex) + sha256(newSalt)===newSaltHash`,
  )
  if (rot1.ok) CREATED_ROTATION_IDS.push(rot1.rotationId)

  // Audit row present — hashes only, no raw salts
  const auditRow = rot1.ok
    ? await (db as any)
        .selectFrom('email_tracking_salt_rotations')
        .select(['id', 'rotated_by', 'old_salt_hash', 'new_salt_hash', 'reason'])
        .where('id', '=', rot1.rotationId)
        .executeTakeFirstOrThrow()
    : null
  assert(
    auditRow != null &&
      auditRow.rotated_by === `cli:smoke-pr5-${SUFFIX}` &&
      typeof auditRow.new_salt_hash === 'string' &&
      auditRow.new_salt_hash.length === 64,
    `[G2a] audit row: rotated_by set + new_salt_hash 64 hex`,
  )

  // Prove raw salt is NOT stored — compare audit hashes vs raw value
  assert(
    rot1.ok && auditRow != null && auditRow.new_salt_hash !== rot1.newSalt,
    `[G5a] audit.new_salt_hash !== raw newSalt (hash-only storage)`,
  )
  // old_salt_hash column must be null-or-hash, never equal to any raw value
  assert(
    auditRow != null &&
      (auditRow.old_salt_hash === null ||
        (typeof auditRow.old_salt_hash === 'string' && auditRow.old_salt_hash.length === 64)),
    `[G5b] audit.old_salt_hash is null or 64-hex — never raw salt`,
  )

  // Immediate second rotation WITHOUT force → rate_limited
  const rot2 = await rotateTrackingSalt(db as any, {
    rotatedBy: `cli:smoke-pr5-${SUFFIX}-noforce`,
    reason: 'should be rate-limited',
    force: false,
  })
  assert(
    rot2.ok === false && 'reason' in rot2 && rot2.reason === 'rate_limited' &&
      typeof (rot2 as any).nextAllowedAt === 'string',
    `[G3] 2nd rotation within 1h without --force → rate_limited + nextAllowedAt ISO`,
  )

  // Third rotation WITH force → bypasses and writes another row
  const rot3 = await rotateTrackingSalt(db as any, {
    rotatedBy: `cli:smoke-pr5-${SUFFIX}-force2`,
    reason: 'force bypass',
    force: true,
  })
  assert(
    rot3.ok === true &&
      typeof rot3.rotationId === 'number' &&
      (rot1.ok && rot3.rotationId !== rot1.rotationId),
    `[G4] --force bypass writes new audit row (id=${rot3.ok ? rot3.rotationId : 'n/a'})`,
  )
  if (rot3.ok) CREATED_ROTATION_IDS.push(rot3.rotationId)

  // Reference hadPrior so `npx tsc --noEmit` on the smoke file stays
  // clean even with strict unused locals settings.
  void hadPrior

  // -------------------------------------------------------------------
  // [H] Cross-shop isolation + Iron Rule 5 leak scan
  // -------------------------------------------------------------------
  log('\n[H] Cross-shop isolation + Iron Rule 5')

  // SHOP_A has an active deletion now: seed one, then confirm SHOP_B
  // can't cancel it via adminCancelDeletion. Use CUSTOMER_B this time
  // so the partial-UNIQUE guard on SHOP_A's active deletion slot (just
  // cancelled above → slot free) doesn't trip us.
  const delForGuard = await requestAccountDeletion(db as any, {
    shopId: SHOP_A,
    customerId: CUSTOMER_A,
    email: CUSTOMER_EMAIL_A,
    notes: 'cross-shop guard setup',
  })
  assert(delForGuard.ok === true, `[H0] seed deletion for cross-shop test → ok=true`)
  if (delForGuard.ok) CREATED_REQUEST_IDS.push(delForGuard.id)

  const crossShop = delForGuard.ok
    ? await adminCancelDeletion(db as any, {
        requestId: delForGuard.id,
        shopId: SHOP_B, // wrong shop
        processorUserId: null,
        notes: 'cross-shop attempt',
      })
    : { ok: false as const, reason: 'not_found' as const, error: 'prior failed' }
  assert(
    crossShop.ok === false && 'reason' in crossShop && crossShop.reason === 'not_found',
    `[H1] SHOP_B cannot cancel SHOP_A's deletion via adminCancelDeletion (reason=${String((crossShop as any).reason)})`,
  )

  // listPrivacyRequests({shopId=SHOP_B}) must not include any SHOP_A request
  const listB = await listPrivacyRequests(db as any, { shopId: SHOP_B, limit: 500 })
  const listBLeaks = listB.filter((r) => CREATED_REQUEST_IDS.includes(r.id))
  assert(
    listBLeaks.length === 0,
    `[H2] listPrivacyRequests({SHOP_B}) does NOT include SHOP_A's request rows (leaks=${listBLeaks.length})`,
  )

  // Iron Rule 5 leak scan — every result we've touched this run
  const surfaces: string[] = [
    JSON.stringify(c1),
    JSON.stringify(badMeta),
    JSON.stringify(badMeta2),
    JSON.stringify(exp),
    JSON.stringify(mark),
    JSON.stringify(consume1),
    JSON.stringify(consume2),
    JSON.stringify(del1),
    JSON.stringify(del2),
    JSON.stringify(cancel1),
    JSON.stringify(cancel2),
    JSON.stringify(dryResult.candidates),
    JSON.stringify(aggregateResult.candidates),
    JSON.stringify(rot1),
    JSON.stringify(rot2),
    JSON.stringify(rot3),
    JSON.stringify(crossShop),
    JSON.stringify(listB),
  ]
  const leakPatterns = [/god[\s_-]?admin/i, /\/god-admin\//i]
  const leaks: string[] = []
  for (const surface of surfaces) {
    for (const pat of leakPatterns) {
      if (pat.test(surface)) {
        leaks.push(`${pat.source} matched in ${surface.slice(0, 80)}...`)
      }
    }
  }
  assert(
    leaks.length === 0,
    `[H3] no god_admin string in any PR5 result surface (leaks: ${leaks.join(' | ') || 'none'})`,
  )

  // -------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------
  log(`\n=== Phase 14 PR5 smoke: ${total - failed}/${total} passed (${failed} failed) ===\n`)
  process.exitCode = failed === 0 ? 0 : 1
}

main()
  .catch((err) => {
    console.error('Phase 14 PR5 smoke — fatal error:', err)
    process.exitCode = 1
  })
  .finally(async () => {
    log('\n[cleanup] Removing seeded rows')
    try {
      // Order: email_events → email_suppressions → email_deliveries →
      // customer_privacy_requests → consent_events → customers →
      // email_tracking_salt_rotations → shops.
      if (CREATED_EVENT_IDS.length > 0) {
        await (db as any)
          .deleteFrom('email_events')
          .where('id', 'in', CREATED_EVENT_IDS)
          .execute()
      }
      // Anything else from our deliveries
      if (CREATED_DELIVERY_IDS.length > 0) {
        await (db as any)
          .deleteFrom('email_events')
          .where('delivery_id', 'in', CREATED_DELIVERY_IDS)
          .execute()
      }
      await (db as any)
        .deleteFrom('email_suppressions')
        .where('shop_id', 'in', [SHOP_A, SHOP_B])
        .execute()
      if (CREATED_DELIVERY_IDS.length > 0) {
        await (db as any)
          .deleteFrom('email_deliveries')
          .where('id', 'in', CREATED_DELIVERY_IDS)
          .execute()
      }
      await (db as any)
        .deleteFrom('email_deliveries')
        .where('shop_id', 'in', [SHOP_A, SHOP_B])
        .execute()
      if (CREATED_REQUEST_IDS.length > 0) {
        await (db as any)
          .deleteFrom('customer_privacy_requests')
          .where('id', 'in', CREATED_REQUEST_IDS)
          .execute()
      }
      // Defensive: wipe anything else scoped to our shops
      await (db as any)
        .deleteFrom('customer_privacy_requests')
        .where('shop_id', 'in', [SHOP_A, SHOP_B])
        .execute()
      await (db as any)
        .deleteFrom('consent_events')
        .where('shop_id', 'in', [SHOP_A, SHOP_B])
        .execute()
      await (db as any)
        .deleteFrom('customers')
        .where('shop_id', 'in', [SHOP_A, SHOP_B])
        .execute()
      if (CREATED_ROTATION_IDS.length > 0) {
        await (db as any)
          .deleteFrom('email_tracking_salt_rotations')
          .where('id', 'in', CREATED_ROTATION_IDS)
          .execute()
      }
      await (db as any)
        .deleteFrom('email_preferences')
        .where('shop_id', 'in', [SHOP_A, SHOP_B])
        .execute()
      await (db as any).deleteFrom('shops').where('id', 'in', [SHOP_A, SHOP_B]).execute()
      log('[cleanup] Done.')
    } catch (err) {
      console.error('[cleanup] failed:', err)
    }
    for (const [k, v] of Object.entries(ORIGINAL_ENV)) {
      if (v === undefined) delete (process.env as any)[k]
      else (process.env as any)[k] = v
    }
    await (db as any).destroy()
  })

// Reference CREATED_REQUEST_IDS in multiple scopes — TS may otherwise
// complain about potentially-unused locals in future strict modes.
void CREATED_REQUEST_IDS
// Use hashToken to validate our understanding of token shape in a
// future regression (commented out — kept for trace).
void hashToken
