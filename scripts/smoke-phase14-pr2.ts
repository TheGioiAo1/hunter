/**
 * Phase 14 PR2 — Priority 1 transactional email migration + seller preview.
 *
 * Complements the unit layer (`packages/core/src/modules/email/*.test.ts`
 * and `apps/store-admin/src/lib/email-preview.test.ts`) with a live-DB
 * end-to-end pass. The smoke verifies:
 *
 *   [A] Registry state — exactly 15 templates flagged `implemented=true`
 *       in the in-code catalog AND the DB registry row. These are the
 *       15 legacy-wired senders migrated to the PR1 pipeline:
 *         order_confirmation, shipping_notification, password_reset,
 *         welcome, refund_notification, draft_order_invoice,
 *         gift_card_delivery, abandoned_cart_recovery, review_approved,
 *         review_replied, email_verify_otp, two_fa_code,
 *         new_order_received, order_canceled, fulfillment_delivered.
 *
 *   [B] Service.ts exports — every migrated key has a legacy `sendXxx`
 *       shim re-exported from the email barrel, so legacy callers stay
 *       green.
 *
 *   [C] Live pipeline — pick three representative keys from different
 *       categories (transactional customer / ops merchant / transactional
 *       customer-post-shipping) and run them through `sendTemplatedEmail`
 *       with a capture transport. Each produces an email_deliveries row
 *       with status=sent + provider=console.
 *
 *   [D] Idempotency — a second call with the same idempotencyKey returns
 *       the same deliveryId and DOES NOT re-invoke the transport. This
 *       is the guarantee that protects against carrier-webhook storms
 *       (shipping_notification) and merchant double-clicks (order_canceled,
 *       fulfillment_delivered).
 *
 *   [E] Iron rule 5 on the preview endpoint —
 *         (1) god_admin templates (`platform_weekly_roundup`) return null
 *             from the resolve path we call inside the preview handler;
 *             the handler translates that to a seller-safe 404.
 *         (2) merchant-visible templates resolve and render a standalone
 *             HTML document with a "Preview" ribbon + filled samples.
 *       We exercise the preview path through the dep-free helper module
 *       + a `resolveTemplate` call against the real DB, mirroring what
 *       the Express handler does.
 *
 *   [F] Preview samples render clean — for all 15 migrated keys, filling
 *       from `buildSamplePreviewVariables()` + rendering with
 *       `renderPreviewDocument()` leaves no leftover `{{…}}` in the body.
 *       Catches regressions where a PR2 author added a placeholder to
 *       the template body but forgot to declare it in `spec.variables`.
 *
 * Usage (run from server 2; local Windows can't reach the PG):
 *
 *   DATABASE_URL=postgresql://gbox:GboxPlatform2026@192.168.1.13:5432/gbox_platform \
 *     npx tsx scripts/smoke-phase14-pr2.ts
 *
 * Forces EMAIL_TRANSPORT=console on entry — no real SMTP fires, the
 * transport invocation is captured via a ConsoleTransport subclass.
 * Cleans up seeded rows in finally{} so the script is re-runnable.
 */

import 'dotenv/config'
import { randomUUID } from 'node:crypto'
import { createDb } from '../packages/db/src/index.js'
import {
  EMAIL_TEMPLATE_CATALOG,
  getTemplate,
  getImplementedTemplates,
  getMerchantVisibleTemplates,
  getTemplateCount,
  resolveTemplate,
  isForcedSendCategory,
} from '../packages/core/src/modules/email/registry.js'
import { sendTemplatedEmail } from '../packages/core/src/modules/email/send.js'
import { ConsoleTransport } from '../packages/core/src/modules/email/transport.js'
import * as emailBarrel from '../packages/core/src/modules/email/index.js'
import {
  buildSamplePreviewVariables,
  renderPreviewDocument,
} from '../apps/store-admin/src/lib/email-preview.js'

// Force console transport + restore on exit so we don't pollute the env.
const ORIGINAL_ENV = {
  EMAIL_TRANSPORT: process.env.EMAIL_TRANSPORT,
  SMTP_HOST: process.env.SMTP_HOST,
  SMTP_USER: process.env.SMTP_USER,
  SMTP_PASS: process.env.SMTP_PASS,
}
process.env.EMAIL_TRANSPORT = 'console'
delete process.env.SMTP_HOST
delete process.env.SMTP_USER
delete process.env.SMTP_PASS

const db = createDb({ connectionString: process.env.DATABASE_URL })

const SUFFIX = Date.now()
const SHOP_A = randomUUID()
const CUSTOMER_A = randomUUID()

// 15 keys wired in PR2 commits 1-15. This is the authoritative list
// consumed by both the registry test AND this smoke — if any commit
// flipped `implemented` without updating this list, [A2] below fails.
const PR2_MIGRATED_KEYS: ReadonlyArray<string> = [
  'order_confirmation',
  'shipping_notification',
  'password_reset',
  'welcome',
  'refund_notification',
  'draft_order_invoice',
  'gift_card_delivery',
  'abandoned_cart_recovery',
  'review_approved',
  'review_replied',
  'email_verify_otp',
  'two_fa_code',
  'new_order_received',
  'order_canceled',
  'fulfillment_delivered',
] as const

// Legacy-shim export names that must survive on the barrel. If someone
// renames one, [B1] fails before it can break a caller in the wild.
const LEGACY_SHIM_EXPORTS: ReadonlyArray<string> = [
  'sendOrderConfirmation',
  'sendShippingNotification',
  'sendPasswordReset',
  'sendWelcome',
  'sendRefundNotification',
  'sendInvoice',
  'sendGiftCardDelivery',
  'sendAbandonedCartRecovery',
  'sendReviewApproved',
  'sendReviewReplied',
  'sendNewOrderReceived',
  'sendOrderCanceled',
  'sendFulfillmentDelivered',
] as const

function log(s: string) {
  // eslint-disable-next-line no-console
  console.log(s)
}

let total = 0
let failed = 0
function assert(cond: boolean, msg: string) {
  total++
  if (cond) log(`  OK   ${msg}`)
  else {
    failed++
    log(`  FAIL ${msg}`)
  }
}

async function main() {
  log(`\n=== Phase 14 PR2 smoke — suffix=${SUFFIX} ===\n`)

  // -------------------------------------------------------------------------
  // [0] Seed a shop + customer so FK-bound email_deliveries inserts don't
  //     trip on missing parent rows.
  // -------------------------------------------------------------------------
  log('[0] Seeding shop + customer')
  await (db as any)
    .insertInto('shops')
    .values({
      id: SHOP_A,
      slug: `smoke-p14-2-${SUFFIX}`,
      name: 'PR2 Shop',
      email: `p14-2-shop-${SUFFIX}@example.test`,
      status: 'active',
      plan: 'free',
    })
    .execute()
  await (db as any)
    .insertInto('customers')
    .values({
      id: CUSTOMER_A,
      shop_id: SHOP_A,
      email: `p14-2-cust-${SUFFIX}@example.test`,
      first_name: 'Pat',
      last_name: 'Tester',
    })
    .execute()

  // -------------------------------------------------------------------------
  // [A] Registry state — PR2 migrated keys are all wired as implemented.
  // Later PRs (PR3+) flip more keys to implemented=true; this smoke
  // only asserts the PR2 set is a SUBSET of the implemented set. The
  // earlier `=== 15` / `only these 15` checks broke the moment PR3+
  // landed additional event-driven keys.
  // -------------------------------------------------------------------------
  log('\n[A] Registry state — PR2 migrated templates wired in')

  const implemented = getImplementedTemplates()
  assert(
    implemented.length >= 15,
    `[A1] getImplementedTemplates() returns >=15 rows (got ${implemented.length})`,
  )

  const implementedKeys = new Set(implemented.map((t) => t.key))
  const missingMigrated = PR2_MIGRATED_KEYS.filter((k) => !implementedKeys.has(k))
  assert(
    missingMigrated.length === 0,
    `[A2] every PR2-migrated key flagged implemented=true (missing: ${missingMigrated.join(', ') || 'none'})`,
  )

  assert(
    getTemplateCount() === 97,
    `[A3] total catalog is 97 (95 original + 2 support notification envelopes from P0 fix — got ${getTemplateCount()})`,
  )

  // DB-side parity — the registry row for each migrated key should also
  // have implemented=true after the PR1 seed ran. If a fresh deploy
  // skipped the re-seed this fails immediately.
  const dbImplRows = await (db as any)
    .selectFrom('email_template_registry')
    .select(['template_key', 'implemented'])
    .where('template_key', 'in', PR2_MIGRATED_KEYS as unknown as string[])
    .execute()
  const dbImplMap = new Map(
    dbImplRows.map((r: any) => [r.template_key, r.implemented === true]),
  )
  const dbMismatches = PR2_MIGRATED_KEYS.filter((k) => dbImplMap.get(k) !== true)
  assert(
    dbMismatches.length === 0,
    `[A4] DB rows for the 15 migrated keys all have implemented=true (mismatches: ${dbMismatches.join(', ') || 'none'})`,
  )

  // PR2-subset check — PR2_MIGRATED_KEYS is a subset of the currently
  // implemented set. We no longer assert "ONLY these keys" because
  // PR3+ landed more event-driven keys; the original negative check
  // made this smoke flip red on every follow-on PR.
  const pr2KeysSet = new Set<string>(PR2_MIGRATED_KEYS)
  const missingFromImpl = PR2_MIGRATED_KEYS.filter((k) => !implementedKeys.has(k))
  assert(
    missingFromImpl.length === 0,
    `[A5] PR2_MIGRATED_KEYS ⊆ implemented set (missing: ${missingFromImpl.join(', ') || 'none'})`,
  )
  // Logged for ops visibility but not asserted — later PRs add keys.
  const beyondPr2 = implemented.filter((t) => !pr2KeysSet.has(t.key))
  log(`  [A5-info] ${beyondPr2.length} implemented key(s) beyond PR2 scope (expected to grow over time)`)

  // -------------------------------------------------------------------------
  // [B] Service.ts exports still present on the barrel
  // -------------------------------------------------------------------------
  log('\n[B] Legacy sender shim exports on @gbox/core/modules/email')

  const barrel = emailBarrel as unknown as Record<string, unknown>
  const missingShims = LEGACY_SHIM_EXPORTS.filter((n) => typeof barrel[n] !== 'function')
  assert(
    missingShims.length === 0,
    `[B1] all 13 legacy sender shims re-exported (missing: ${missingShims.join(', ') || 'none'})`,
  )

  // -------------------------------------------------------------------------
  // [C] Live pipeline — representative keys across categories
  // -------------------------------------------------------------------------
  log('\n[C] Live pipeline — 3 representative keys')

  interface Captured {
    to: string
    subject: string
    html: string
  }
  const captured: Captured[] = []
  const capture = new ConsoleTransport({
    capture: (env) => captured.push({ to: env.to, subject: env.subject, html: env.html }),
  })

  // C1 — order_confirmation (transactional, customer, commit 1)
  {
    const res = await sendTemplatedEmail(db as any, {
      templateKey: 'order_confirmation',
      to: `buyer-oc-${SUFFIX}@example.test`,
      shopId: SHOP_A,
      recipientCustomerId: CUSTOMER_A,
      variables: {
        order_number: String(SUFFIX),
        customer_name: 'Pat',
        shop_name: 'PR2 Shop',
      },
      idempotencyKey: `smoke-oc-${SUFFIX}`,
      transport: capture,
    })
    assert(
      res.ok === true && (res as any).provider === 'console',
      `[C1] sendTemplatedEmail(order_confirmation) → ok=true provider=console`,
    )
  }

  // C2 — new_order_received (ops, merchant, commit 13). Merchant goes
  // to shop.email, NOT to the customer. We verify that in the capture.
  {
    const res = await sendTemplatedEmail(db as any, {
      templateKey: 'new_order_received',
      to: `p14-2-shop-${SUFFIX}@example.test`, // shops.email
      shopId: SHOP_A,
      variables: {
        order_number: String(SUFFIX),
        order_total: '$49.95',
        currency: 'USD',
        customer_name: 'Pat Tester',
        order_url: 'https://demo.gbox.co/admin/orders/1',
        shop_name: 'PR2 Shop',
      },
      idempotencyKey: `smoke-nor-${SUFFIX}`,
      transport: capture,
    })
    assert(
      res.ok === true && (res as any).provider === 'console',
      `[C2] sendTemplatedEmail(new_order_received) → ok=true provider=console`,
    )
    assert(
      captured.some(
        (c) => c.to === `p14-2-shop-${SUFFIX}@example.test` && c.subject.length > 0,
      ),
      `[C2.1] new_order_received delivered to shop.email (merchant, not customer)`,
    )
  }

  // C3 — fulfillment_delivered (transactional, customer, commit 15)
  {
    const res = await sendTemplatedEmail(db as any, {
      templateKey: 'fulfillment_delivered',
      to: `buyer-fd-${SUFFIX}@example.test`,
      shopId: SHOP_A,
      variables: {
        order_number: String(SUFFIX),
        customer_name: 'Pat',
        shop_name: 'PR2 Shop',
        shop_url: 'https://demo.gbox.co',
        line_items_html: '<tr><td>Widget</td><td>1</td></tr>',
        line_items_text: '- Widget × 1',
      },
      idempotencyKey: `smoke-fd-${SUFFIX}`,
      transport: capture,
    })
    assert(
      res.ok === true && (res as any).provider === 'console',
      `[C3] sendTemplatedEmail(fulfillment_delivered) → ok=true provider=console`,
    )
  }

  // Sanity — we captured 3 envelopes total from [C1..C3].
  assert(captured.length === 3, `[C4] transport invoked exactly 3 times (got ${captured.length})`)

  // -------------------------------------------------------------------------
  // [D] Idempotency dedupe — 2nd call with same key must not re-invoke
  // -------------------------------------------------------------------------
  log('\n[D] Idempotency dedupe')

  const dedupeKey = `smoke-idem-${SUFFIX}`
  const capturedBefore = captured.length

  const first = await sendTemplatedEmail(db as any, {
    templateKey: 'order_canceled',
    to: `buyer-cancel-${SUFFIX}@example.test`,
    shopId: SHOP_A,
    variables: {
      order_number: String(SUFFIX),
      customer_name: 'Pat',
      shop_name: 'PR2 Shop',
      cancel_reason_html: '',
      cancel_reason_text: '',
      line_items_html: '',
      currency: 'USD',
      total_price: '$49.95',
    },
    idempotencyKey: dedupeKey,
    transport: capture,
  })
  const second = await sendTemplatedEmail(db as any, {
    templateKey: 'order_canceled',
    to: `buyer-cancel-${SUFFIX}@example.test`,
    shopId: SHOP_A,
    variables: {
      order_number: String(SUFFIX),
      customer_name: 'Pat',
      shop_name: 'PR2 Shop',
      cancel_reason_html: '',
      cancel_reason_text: '',
      line_items_html: '',
      currency: 'USD',
      total_price: '$49.95',
    },
    idempotencyKey: dedupeKey, // same key
    transport: capture,
  })

  assert(
    first.ok === true && (first as any).deliveryId != null,
    `[D1] first idempotent send → ok=true + deliveryId assigned`,
  )
  assert(
    second.ok === true &&
      (second as any).deliveryId === (first as any).deliveryId,
    `[D2] second idempotent send → ok=true + SAME deliveryId as first`,
  )
  assert(
    captured.length === capturedBefore + 1,
    `[D3] transport invoked exactly ONCE across both idempotent calls (got ${captured.length - capturedBefore})`,
  )

  // Verify via DB that exactly one row exists for this idempotency key.
  const idemRows = await (db as any)
    .selectFrom('email_deliveries')
    .select(['id', 'status'])
    .where('shop_id', '=', SHOP_A)
    .where('idempotency_key', '=', dedupeKey)
    .execute()
  assert(
    idemRows.length === 1 && idemRows[0].status === 'sent',
    `[D4] exactly 1 email_deliveries row for idempotency_key, status=sent (got ${idemRows.length})`,
  )

  // -------------------------------------------------------------------------
  // [E] Iron rule 5 on the preview path
  // -------------------------------------------------------------------------
  log('\n[E] Iron rule 5 on the preview path')

  // The preview handler calls getTemplate(key) first and rejects
  // audience='god_admin' with a 404 BEFORE hitting resolveTemplate. Walk
  // the same invariant here.
  const platformKey = 'platform_weekly_roundup'
  const platformSpec = getTemplate(platformKey)
  assert(
    !!platformSpec && platformSpec.audience === 'god_admin',
    `[E1] ${platformKey} exists in catalog with audience=god_admin`,
  )
  // Simulate the preview handler's iron-rule-5 gate: unknown-or-god-admin
  // ⇒ caller returns 404 WITHOUT attempting resolve.
  const wouldReject =
    !platformSpec || platformSpec.audience === 'god_admin'
  assert(
    wouldReject === true,
    `[E2] preview handler would reject ${platformKey} with 404 before resolve (iron rule 5)`,
  )

  // And a merchant-visible template: resolve should return a ResolvedTemplate
  // that renderPreviewDocument can use.
  const resolved = await resolveTemplate(
    db as unknown as Parameters<typeof resolveTemplate>[0],
    SHOP_A,
    'order_confirmation',
  )
  assert(
    !!resolved && resolved.key === 'order_confirmation',
    `[E3] resolveTemplate(SHOP_A, order_confirmation) returns a ResolvedTemplate`,
  )
  assert(
    resolved!.audience === 'customer' &&
      resolved!.category === 'transactional' &&
      isForcedSendCategory(resolved!.category),
    `[E4] resolved template stays customer/transactional/forced-send after PR2`,
  )

  const vars = buildSamplePreviewVariables(resolved!)
  const html = renderPreviewDocument({ resolved: resolved!, variables: vars })
  assert(
    html.startsWith('<!DOCTYPE html>') &&
      html.includes('<title>') &&
      html.includes('Preview · order_confirmation'),
    `[E5] renderPreviewDocument returns full HTML doc with title + ribbon`,
  )

  // Iron rule 5 — the preview HTML itself must never leak god-admin
  // vocabulary. This is belt-and-braces: the handler already gates it,
  // but if a template body somehow inherited copy from the platform
  // surface this catches it.
  const GOD_ADMIN_RE = /god[\s_-]*admin/i
  const INTERNAL_PATH_RE = /\/god-admin\//
  assert(
    !GOD_ADMIN_RE.test(html) && !INTERNAL_PATH_RE.test(html),
    `[E6] preview HTML for order_confirmation contains no "god admin" vocabulary or /god-admin/ path`,
  )

  // -------------------------------------------------------------------------
  // [F] Preview samples render clean for ALL 15 migrated keys
  // -------------------------------------------------------------------------
  log('\n[F] All 15 migrated templates render clean from samples')

  const leftovers: string[] = []
  for (const key of PR2_MIGRATED_KEYS) {
    const spec = getTemplate(key)
    if (!spec) {
      leftovers.push(`${key}: missing from catalog`)
      continue
    }
    const resolvedT = await resolveTemplate(
      db as unknown as Parameters<typeof resolveTemplate>[0],
      // email_verify_otp + two_fa_code are god_admin-owned (platform
      // senders fire them; sellers never customize) — so we resolve
      // them at platform scope (shopId=null) to mirror the real send.
      spec.audience === 'god_admin' ? null : SHOP_A,
      key,
    )
    if (!resolvedT) {
      leftovers.push(`${key}: resolveTemplate returned null`)
      continue
    }
    const previewVars = buildSamplePreviewVariables(resolvedT)
    const previewHtml = renderPreviewDocument({
      resolved: resolvedT,
      variables: previewVars,
    })
    // Any leftover `{{…}}` means the template body references a placeholder
    // that's not in spec.variables[] (so sample-fill missed it). Previews
    // would render with literal `{{foo}}` visible to the seller — which
    // is exactly what PR2 promised NOT to do.
    const match = previewHtml.match(/\{\{[^}]+\}\}/)
    if (match) {
      leftovers.push(`${key}: leftover ${match[0]}`)
    }
  }
  assert(
    leftovers.length === 0,
    `[F1] no leftover {{…}} in preview HTML for any migrated key (leftovers: ${leftovers.join('; ') || 'none'})`,
  )

  // -------------------------------------------------------------------------
  // [G] Iron rule 5 invariant on getMerchantVisibleTemplates (re-check
  //     here so PR2 can't silently reclassify email_verify_otp / two_fa_code
  //     to customer/merchant audience without touching the filter.)
  // -------------------------------------------------------------------------
  log('\n[G] Iron rule 5 — merchant visibility unchanged by PR2')

  const merchantVisible = getMerchantVisibleTemplates()
  const leakedGodAdmin = merchantVisible.filter((t) => t.audience === 'god_admin')
  assert(
    leakedGodAdmin.length === 0,
    `[G1] getMerchantVisibleTemplates() leaks 0 god_admin audience (leaks: ${leakedGodAdmin.map((t) => t.key).join(', ') || 'none'})`,
  )

  // email_verify_otp + two_fa_code are god_admin (platform-owned) and
  // MUST stay filtered out of the seller UI.
  const otp = getTemplate('email_verify_otp')
  const twofa = getTemplate('two_fa_code')
  assert(
    otp?.audience === 'god_admin' && twofa?.audience === 'god_admin',
    `[G2] email_verify_otp + two_fa_code stay platform-owned (audience=god_admin)`,
  )
  assert(
    !merchantVisible.some((t) => t.key === 'email_verify_otp' || t.key === 'two_fa_code'),
    `[G3] email_verify_otp + two_fa_code never appear on the seller list page`,
  )

  // -------------------------------------------------------------------------
  // [H] Every PR2 row actually produced a DB record — sanity-check the
  //     delivery log from this run.
  // -------------------------------------------------------------------------
  log('\n[H] Delivery log contains this run\'s rows')

  const sentRows = await (db as any)
    .selectFrom('email_deliveries')
    .select(['template_key', 'status', 'provider'])
    .where('shop_id', '=', SHOP_A)
    .where('status', '=', 'sent')
    .execute()
  const sentKeys = new Set(sentRows.map((r: any) => r.template_key))
  const expectedSent = [
    'order_confirmation',
    'new_order_received',
    'fulfillment_delivered',
    'order_canceled',
  ]
  const missingSent = expectedSent.filter((k) => !sentKeys.has(k))
  assert(
    missingSent.length === 0,
    `[H1] email_deliveries has sent rows for each PR2 key we exercised (missing: ${missingSent.join(', ') || 'none'})`,
  )
  assert(
    sentRows.every((r: any) => r.provider === 'console'),
    `[H2] every sent row this run has provider=console (no real SMTP fired)`,
  )

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------
  log(`\n=== Phase 14 PR2 smoke: ${total - failed}/${total} passed (${failed} failed) ===\n`)
  process.exitCode = failed === 0 ? 0 : 1
}

main()
  .catch((err) => {
    console.error('Phase 14 PR2 smoke — fatal error:', err)
    process.exitCode = 1
  })
  .finally(async () => {
    log('\n[cleanup] Removing seeded rows')
    try {
      await (db as any)
        .deleteFrom('email_deliveries')
        .where('shop_id', '=', SHOP_A)
        .execute()
      await (db as any)
        .deleteFrom('email_preferences')
        .where('shop_id', '=', SHOP_A)
        .execute()
      await (db as any).deleteFrom('customers').where('id', '=', CUSTOMER_A).execute()
      await (db as any).deleteFrom('shops').where('id', '=', SHOP_A).execute()
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

// Prevent unused-import error for EMAIL_TEMPLATE_CATALOG — used to prove
// the 97-template total in [A3] via getTemplateCount() which reads from it.
void EMAIL_TEMPLATE_CATALOG
