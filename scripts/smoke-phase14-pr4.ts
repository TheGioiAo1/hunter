/**
 * Phase 14 PR4 — Email analytics (open + click tracking) end-to-end smoke.
 *
 * Complements the unit layer (packages/core/src/modules/email/tracking.test.ts
 * + analytics.test.ts + apps/storefront/src/middleware/email-tracking-
 * routes.test.ts — 84 cases) with a live-DB run that walks the full
 * pipeline:
 *
 *   generateTrackingToken(deliveryId)
 *     → rewriteHtmlLinks + injectPixel    (render-time wiring)
 *     → UPDATE email_deliveries.tracking_token (commit 4 persistence)
 *     → mini Express app bound to recordOpen / recordClick
 *     → HTTP GET /email/track/open/:token.gif
 *         · live SELECT by tracking_token
 *         · UPDATE open_count + opened_at
 *         · INSERT email_events (event_type='open')
 *     → HTTP GET /email/track/click/:token?u=<base64url(target)>
 *         · live decodeClickTarget
 *         · UPDATE click_count + clicked_at
 *         · INSERT email_events (event_type='click')
 *         · 302 Location: <target>
 *     → getEmailSummary / getDailyEmailMetrics / getTemplateBreakdown
 *       read back the numbers and assert the dashboard would render
 *       non-zero values.
 *
 * Invariants asserted (roughly one letter per scope §4 requirement):
 *
 *   [A] Migration 086 schema present
 *       [A1] email_deliveries has tracking_token, open_count, click_count
 *            columns.
 *       [A2] Partial UNIQUE index `WHERE tracking_token IS NOT NULL` exists
 *            (inserting the same non-null token twice is rejected).
 *
 *   [B] Tracking primitives (no DB)
 *       [B1] generateTrackingToken is deterministic + 32 hex chars.
 *       [B2] verifyTrackingToken accepts a round-trip; rejects tamper.
 *       [B3] rewriteHtmlLinksWithCount reports accurate rewrite count.
 *       [B4] injectPixel places <img> before </body>.
 *
 *   [C] Send-side integration (commit 4)
 *       [C1] Inserting an email_deliveries row + setting tracking_token
 *            from the pure-function token round-trips through the DB
 *            untouched (belt-and-braces the UPDATE path in send.ts).
 *
 *   [D] Open pixel route (mini Express, live DB)
 *       [D1] GET /email/track/open/:token.gif returns 200 + image/gif +
 *            the exact 43-byte transparent GIF.
 *       [D2] Cache-Control: no-store; X-Content-Type-Options: nosniff.
 *       [D3] After hit: open_count == 1, opened_at != null.
 *       [D4] email_events has 1 row with event_type='open' and
 *            ip_hash/ua populated.
 *       [D5] Second hit: open_count == 2, opened_at unchanged (still
 *            the first-hit timestamp).
 *       [D6] Garbage token (not 32 hex) still returns 200 GIF but
 *            writes no DB rows (anti-enumeration).
 *
 *   [E] Click redirect route
 *       [E1] GET /email/track/click/:token?u=<base64url(https://x.com/y)>
 *            returns 302 + Location: https://x.com/y.
 *       [E2] After hit: click_count == 1, clicked_at != null.
 *       [E3] email_events has 1 row with event_type='click' and
 *            clicked_url set to the decoded target.
 *       [E4] Missing ?u= query param → 302 /, no recorder call.
 *       [E5] Garbage target (javascript:) → 302 /, no counter bump.
 *
 *   [F] Analytics aggregations (live DB, same seeded shop)
 *       [F1] getEmailSummary({since, until}) returns:
 *            - sent >= 1
 *            - delivered = sent - bounced  (bounced_at IS NOT NULL filter)
 *            - opens + clicks reflect our test hits
 *            - uniqueOpens >= 1, uniqueClicks >= 1
 *            - openRate / clickRate are 0-100 (no NaN / Infinity)
 *       [F2] getDailyEmailMetrics({since, until}) zero-fills the range
 *            and places our seeded row on today's date.
 *       [F3] getTemplateBreakdown() returns our template_key with the
 *            correct rate shape.
 *
 *   [G] Iron rule 5 — seller-safe + shop-scoped
 *       [G1] Analytics queries filtered by shop_id never surface another
 *            shop's rows. Seed a second shop with its own delivery +
 *            hits; assert shop A's summary excludes shop B.
 *       [G2] The literal strings "god admin" / "god_admin" / "/god-admin/"
 *            never appear in the built pixel URL, click URL, or analytics
 *            response.
 *
 * Usage (run from server 2; local Windows can't reach the PG):
 *
 *   DATABASE_URL=postgresql://gbox:GboxPlatform2026@192.168.1.13:5432/gbox_platform \
 *     npx tsx scripts/smoke-phase14-pr4.ts
 *
 * Forces EMAIL_TRACKING_SECRET=test-secret-pr4 + EMAIL_TRACKING_IP_SALT=
 * test-salt-pr4 + EMAIL_TRACKING_ENABLED=1 on entry; restores prior env
 * in finally{} so subsequent smokes see a clean process env. Cleans up
 * every seeded row — script is re-runnable without side effects.
 */

import 'dotenv/config'
import { randomUUID } from 'node:crypto'
import express from 'express'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createDb } from '../packages/db/src/index.js'
import {
  generateTrackingToken,
  verifyTrackingToken,
  buildPixelUrl,
  buildClickUrl,
  base64UrlEncode,
  rewriteHtmlLinksWithCount,
  injectPixel,
  TRANSPARENT_GIF_PIXEL,
  resolveTrackingBaseUrl,
  isTrackingEnabled,
  isTrackedCategory,
} from '../packages/core/src/modules/email/tracking.js'
import {
  recordOpen,
  recordClick,
} from '../packages/core/src/modules/email/tracking-recorder.js'
import {
  getEmailSummary,
  getDailyEmailMetrics,
  getTemplateBreakdown,
  lastNDays,
} from '../packages/core/src/modules/email/analytics.js'
import { buildEmailTrackingRoutes } from '../apps/storefront/src/middleware/email-tracking-routes.js'

// ─── Env isolation ────────────────────────────────────────────────
const ORIGINAL_ENV = {
  EMAIL_TRACKING_SECRET: process.env.EMAIL_TRACKING_SECRET,
  EMAIL_TRACKING_IP_SALT: process.env.EMAIL_TRACKING_IP_SALT,
  EMAIL_TRACKING_ENABLED: process.env.EMAIL_TRACKING_ENABLED,
  EMAIL_TRACKING_BASE_URL: process.env.EMAIL_TRACKING_BASE_URL,
}
process.env.EMAIL_TRACKING_SECRET = 'test-secret-pr4'
process.env.EMAIL_TRACKING_IP_SALT = 'test-salt-pr4'
process.env.EMAIL_TRACKING_ENABLED = '1'
process.env.EMAIL_TRACKING_BASE_URL = 'https://gbox.test'

const db = createDb({ connectionString: process.env.DATABASE_URL })

const SUFFIX = Date.now()
const SHOP_A = randomUUID()
const SHOP_B = randomUUID()

// Pins the test to the current calendar day so getDailyEmailMetrics
// lands our row on today's bar. We also use it as the since/until for
// the range, so the range is 1 day = 1 row.
const TODAY = new Date().toISOString().slice(0, 10)

// ─── Minimal assertion helper (mirrors PR3 smoke) ─────────────────
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

// Track IDs created so cleanup is precise (no shotgun DELETE ... WHERE
// shop_id IN (...) — that would miss rows created against SHOP_A between
// runs if a prior run crashed pre-cleanup).
const CREATED_DELIVERY_IDS: number[] = []

async function seedDelivery(opts: {
  shopId: string
  templateKey: string
  recipientEmail: string
  trackingToken: string | null
  sentAt: Date
  bouncedAt?: Date | null
}): Promise<number> {
  const row = await (db as any)
    .insertInto('email_deliveries')
    .values({
      template_key: opts.templateKey,
      shop_id: opts.shopId,
      recipient_email: opts.recipientEmail,
      recipient_customer_id: null,
      recipient_user_id: null,
      subject: `PR4 smoke ${SUFFIX}`,
      body_preview: 'smoke preview',
      status: 'sent',
      provider: 'console',
      smtp_message_id: `<smoke-${SUFFIX}-${randomUUID()}@gbox.test>`,
      failed_reason: null,
      failed_at: null,
      sent_at: opts.sentAt.toISOString(),
      bounced_at: opts.bouncedAt ? opts.bouncedAt.toISOString() : null,
      opened_at: null,
      clicked_at: null,
      idempotency_key: null,
      tracking_token: opts.trackingToken,
    })
    .returning(['id'])
    .executeTakeFirstOrThrow()
  const id = Number(row.id)
  CREATED_DELIVERY_IDS.push(id)
  return id
}

async function main() {
  log(`\n=== Phase 14 PR4 smoke — suffix=${SUFFIX} ===\n`)

  // -------------------------------------------------------------------------
  // [0] Seed shops so FK-bound inserts don't fail. email_deliveries.shop_id
  //     is nullable but FK-constrained to shops.id, so we must create both.
  // -------------------------------------------------------------------------
  log('[0] Seeding 2 shops')
  for (const [id, slugSuffix] of [
    [SHOP_A, 'a'],
    [SHOP_B, 'b'],
  ] as const) {
    await (db as any)
      .insertInto('shops')
      .values({
        id,
        slug: `smoke-p14-4-${slugSuffix}-${SUFFIX}`,
        name: `PR4 Shop ${slugSuffix.toUpperCase()}`,
        email: `p14-4-shop-${slugSuffix}-${SUFFIX}@example.test`,
        status: 'active',
        plan: 'free',
      })
      .execute()
  }

  // -------------------------------------------------------------------------
  // [A] Migration 086 schema present — quick sanity read via information_schema.
  // -------------------------------------------------------------------------
  log('\n[A] Migration 086 schema present')

  const cols = await (db as any)
    .selectFrom('information_schema.columns' as any)
    .select(['column_name', 'data_type'])
    .where('table_schema', '=', 'public')
    .where('table_name', '=', 'email_deliveries')
    .where('column_name', 'in', ['tracking_token', 'open_count', 'click_count'])
    .execute()
  const colNames = cols.map((r: any) => r.column_name).sort()
  assert(
    colNames.join(',') === 'click_count,open_count,tracking_token',
    `[A1] email_deliveries has tracking_token + open_count + click_count (got: ${colNames.join(',')})`,
  )

  // Insert two rows with the same tracking_token → second must fail
  // on the partial UNIQUE index. We use a dedicated collision probe
  // (not the main flow) so a failure here doesn't cascade into later
  // sections.
  const collisionToken = 'ffffffffffffffffffffffffffffffff'
  const probeA = await seedDelivery({
    shopId: SHOP_A,
    templateKey: 'campaign_promo',
    recipientEmail: `probe-a-${SUFFIX}@example.test`,
    trackingToken: collisionToken,
    sentAt: new Date(),
  })
  let collided = false
  try {
    await seedDelivery({
      shopId: SHOP_A,
      templateKey: 'campaign_promo',
      recipientEmail: `probe-b-${SUFFIX}@example.test`,
      trackingToken: collisionToken,
      sentAt: new Date(),
    })
  } catch (err) {
    collided = true
  }
  assert(
    collided,
    `[A2] duplicate tracking_token on non-NULL is rejected by partial UNIQUE index`,
  )
  // probeA stays in CREATED_DELIVERY_IDS for cleanup; the failed second
  // insert never registered, so nothing to track there.
  void probeA

  // Sanity: NULL tracking_token doesn't collide with itself.
  await seedDelivery({
    shopId: SHOP_A,
    templateKey: 'password_reset',
    recipientEmail: `probe-null-a-${SUFFIX}@example.test`,
    trackingToken: null,
    sentAt: new Date(),
  })
  await seedDelivery({
    shopId: SHOP_A,
    templateKey: 'password_reset',
    recipientEmail: `probe-null-b-${SUFFIX}@example.test`,
    trackingToken: null,
    sentAt: new Date(),
  })
  assert(
    true,
    `[A2b] two rows with NULL tracking_token coexist (partial index predicate honoured)`,
  )

  // -------------------------------------------------------------------------
  // [B] Tracking primitives — deterministic + tamper-proof
  // -------------------------------------------------------------------------
  log('\n[B] Tracking primitives')

  const probeId = 4242
  const t1 = generateTrackingToken(probeId)
  const t2 = generateTrackingToken(probeId)
  assert(
    t1 === t2 && /^[0-9a-f]{32}$/.test(t1),
    `[B1] generateTrackingToken deterministic + 32 hex chars (got ${t1})`,
  )
  assert(
    verifyTrackingToken(t1, probeId) === true &&
      verifyTrackingToken(t1, probeId + 1) === false &&
      verifyTrackingToken(t1.replace('a', 'b'), probeId) === false,
    `[B2] verifyTrackingToken accepts round-trip, rejects id-mismatch, rejects tamper`,
  )

  const rewriteIn = `<p>Hi</p><p><a href="https://shop.com/product">Buy</a> or <a href="https://gbox.co/faq">FAQ</a></p>`
  const { html: rewriteOut, count: rewriteCount } = rewriteHtmlLinksWithCount(
    rewriteIn,
    t1,
    'https://gbox.test',
  )
  assert(
    rewriteCount === 2 &&
      rewriteOut.includes('/email/track/click/') &&
      !rewriteOut.includes('https://shop.com/product"') &&
      !rewriteOut.includes('https://gbox.co/faq"'),
    `[B3] rewriteHtmlLinksWithCount rewrote 2 links (count=${rewriteCount})`,
  )

  const injected = injectPixel(`<html><body><p>hi</p></body></html>`, `https://gbox.test/email/track/open/${t1}.gif`)
  assert(
    /<img[^>]*email\/track\/open\/[a-f0-9]{32}\.gif[^>]*\/?>\s*<\/body>/.test(injected),
    `[B4] injectPixel placed <img> before </body>`,
  )

  assert(
    isTrackingEnabled() === true,
    `[B5] isTrackingEnabled() returns true with EMAIL_TRACKING_ENABLED=1`,
  )
  assert(
    isTrackedCategory('marketing') && isTrackedCategory('lifecycle') && isTrackedCategory('reviews'),
    `[B6] isTrackedCategory accepts marketing / lifecycle / reviews`,
  )
  assert(
    !isTrackedCategory('transactional') && !isTrackedCategory('system') && !isTrackedCategory(null),
    `[B7] isTrackedCategory rejects transactional / system / null`,
  )

  // -------------------------------------------------------------------------
  // [C] Send-side integration check — mint token, persist on row, round-trip.
  //     Simulates what sendTemplatedEmail does in send.ts after step 4.
  // -------------------------------------------------------------------------
  log('\n[C] Send-side integration — persist tracking_token on delivery row')

  const mainDeliveryId = await seedDelivery({
    shopId: SHOP_A,
    templateKey: 'campaign_promo',
    recipientEmail: `main-${SUFFIX}@example.test`,
    trackingToken: null, // start null; mimic the send-pipeline flow
    sentAt: new Date(),
  })
  const mainToken = generateTrackingToken(mainDeliveryId)
  await (db as any)
    .updateTable('email_deliveries')
    .set({ tracking_token: mainToken })
    .where('id', '=', mainDeliveryId)
    .execute()

  const readback = await (db as any)
    .selectFrom('email_deliveries')
    .select(['tracking_token', 'open_count', 'click_count', 'opened_at', 'clicked_at'])
    .where('id', '=', mainDeliveryId)
    .executeTakeFirstOrThrow()
  assert(
    readback.tracking_token === mainToken,
    `[C1a] tracking_token round-trips (expected=${mainToken}, got=${readback.tracking_token})`,
  )
  assert(
    Number(readback.open_count) === 0 &&
      Number(readback.click_count) === 0 &&
      readback.opened_at == null &&
      readback.clicked_at == null,
    `[C1b] fresh delivery has 0 opens, 0 clicks, null timestamps`,
  )

  // -------------------------------------------------------------------------
  // [D] Open pixel route — mini Express bound to real recordOpen, live DB.
  // -------------------------------------------------------------------------
  log('\n[D] Open pixel route — real DB recorder')

  const app = express()
  app.use(
    buildEmailTrackingRoutes({
      recordOpen: async (token, meta) => {
        await recordOpen(db as any, token, meta)
      },
      recordClick: async (token, encoded, meta) => {
        const r = await recordClick(db as any, token, encoded, meta)
        return { target: r.ok ? r.target : null }
      },
    }),
  )
  const server: Server = createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  const baseUrl = `http://127.0.0.1:${address.port}`

  const pixelRes = await fetch(`${baseUrl}/email/track/open/${mainToken}.gif`, {
    headers: { 'user-agent': 'SmokeClient/1.0 PR4' },
  })
  assert(
    pixelRes.status === 200 && pixelRes.headers.get('content-type') === 'image/gif',
    `[D1] GET /email/track/open/:token.gif → 200 image/gif (got ${pixelRes.status} ${pixelRes.headers.get('content-type')})`,
  )
  const pixelBuf = Buffer.from(await pixelRes.arrayBuffer())
  assert(
    pixelBuf.length === TRANSPARENT_GIF_PIXEL.length &&
      pixelBuf.equals(TRANSPARENT_GIF_PIXEL),
    `[D1b] pixel body matches TRANSPARENT_GIF_PIXEL byte-for-byte (${pixelBuf.length}B)`,
  )
  const cc1 = pixelRes.headers.get('cache-control') ?? ''
  assert(
    cc1.includes('no-store') &&
      pixelRes.headers.get('x-content-type-options') === 'nosniff',
    `[D2] cache-control: no-store + X-Content-Type-Options: nosniff`,
  )

  // Recorder runs fire-and-forget; give it a moment to commit.
  await new Promise((r) => setTimeout(r, 150))
  const afterHit1 = await (db as any)
    .selectFrom('email_deliveries')
    .select(['open_count', 'opened_at', 'click_count', 'clicked_at'])
    .where('id', '=', mainDeliveryId)
    .executeTakeFirstOrThrow()
  assert(
    Number(afterHit1.open_count) === 1 && afterHit1.opened_at != null,
    `[D3] after 1 pixel hit: open_count=1, opened_at set (got open_count=${afterHit1.open_count}, opened_at=${afterHit1.opened_at ? 'set' : 'null'})`,
  )
  const firstOpenedAt = afterHit1.opened_at

  const events1 = await (db as any)
    .selectFrom('email_events')
    .select(['event_type', 'user_agent', 'ip_hash', 'clicked_url'])
    .where('delivery_id', '=', mainDeliveryId)
    .where('event_type', '=', 'open')
    .execute()
  assert(
    events1.length === 1 &&
      (events1[0].user_agent ?? '').startsWith('SmokeClient/1.0') &&
      events1[0].clicked_url == null,
    `[D4] 1 email_events row (event_type=open) with UA set, clicked_url=null`,
  )

  // Second hit — counter bumps but opened_at stays at first-hit timestamp.
  // pg-node parses TIMESTAMPTZ as Date, so compare by numeric time
  // rather than by reference (`===` on two Dates is always false).
  await fetch(`${baseUrl}/email/track/open/${mainToken}.gif`)
  await new Promise((r) => setTimeout(r, 150))
  const afterHit2 = await (db as any)
    .selectFrom('email_deliveries')
    .select(['open_count', 'opened_at'])
    .where('id', '=', mainDeliveryId)
    .executeTakeFirstOrThrow()
  const hit1Ms = firstOpenedAt instanceof Date ? firstOpenedAt.getTime() : new Date(firstOpenedAt as any).getTime()
  const hit2Ms = afterHit2.opened_at instanceof Date ? afterHit2.opened_at.getTime() : new Date(afterHit2.opened_at as any).getTime()
  assert(
    Number(afterHit2.open_count) === 2 && hit1Ms === hit2Ms,
    `[D5] 2nd hit: open_count=2, opened_at UNCHANGED from first hit`,
  )

  // Garbage token — route serves pixel, recorder skips DB work.
  const eventsBeforeGarbage = await countEvents(mainDeliveryId)
  const garbageRes = await fetch(`${baseUrl}/email/track/open/not-a-real-token.gif`)
  assert(
    garbageRes.status === 200 && garbageRes.headers.get('content-type') === 'image/gif',
    `[D6a] garbage token still returns 200 GIF (anti-enumeration)`,
  )
  await new Promise((r) => setTimeout(r, 100))
  const eventsAfterGarbage = await countEvents(mainDeliveryId)
  assert(
    eventsBeforeGarbage === eventsAfterGarbage,
    `[D6b] garbage token writes NO email_events rows`,
  )

  // -------------------------------------------------------------------------
  // [E] Click redirect route
  // -------------------------------------------------------------------------
  log('\n[E] Click redirect route')

  const TARGET_URL = 'https://shop.gbox.test/products/widget'
  const encoded = base64UrlEncode(TARGET_URL)
  const clickRes = await fetch(
    `${baseUrl}/email/track/click/${mainToken}?u=${encoded}`,
    { redirect: 'manual' },
  )
  assert(
    clickRes.status === 302 && clickRes.headers.get('location') === TARGET_URL,
    `[E1] click 302s to decoded target (status=${clickRes.status}, loc=${clickRes.headers.get('location')})`,
  )
  await new Promise((r) => setTimeout(r, 150))

  const afterClick = await (db as any)
    .selectFrom('email_deliveries')
    .select(['click_count', 'clicked_at'])
    .where('id', '=', mainDeliveryId)
    .executeTakeFirstOrThrow()
  assert(
    Number(afterClick.click_count) === 1 && afterClick.clicked_at != null,
    `[E2] click_count=1, clicked_at set (got click_count=${afterClick.click_count})`,
  )

  const clickEvents = await (db as any)
    .selectFrom('email_events')
    .select(['event_type', 'clicked_url'])
    .where('delivery_id', '=', mainDeliveryId)
    .where('event_type', '=', 'click')
    .execute()
  assert(
    clickEvents.length === 1 && clickEvents[0].clicked_url === TARGET_URL,
    `[E3] email_events has 1 click row with clicked_url=${TARGET_URL}`,
  )

  // Missing ?u= query param → 302 /
  const noTargetRes = await fetch(
    `${baseUrl}/email/track/click/${mainToken}`,
    { redirect: 'manual' },
  )
  assert(
    noTargetRes.status === 302 && noTargetRes.headers.get('location') === '/',
    `[E4] missing ?u= → 302 / (no recorder work)`,
  )

  // javascript: scheme target → 302 /, no counter bump
  const clickCountBeforeMalicious = Number(afterClick.click_count)
  const maliciousEncoded = base64UrlEncode('javascript:alert(1)')
  const maliciousRes = await fetch(
    `${baseUrl}/email/track/click/${mainToken}?u=${maliciousEncoded}`,
    { redirect: 'manual' },
  )
  assert(
    maliciousRes.status === 302 && maliciousRes.headers.get('location') === '/',
    `[E5a] javascript: target → 302 /`,
  )
  await new Promise((r) => setTimeout(r, 100))
  const afterMalicious = await (db as any)
    .selectFrom('email_deliveries')
    .select(['click_count'])
    .where('id', '=', mainDeliveryId)
    .executeTakeFirstOrThrow()
  assert(
    Number(afterMalicious.click_count) === clickCountBeforeMalicious,
    `[E5b] malicious target did not bump click_count (still ${afterMalicious.click_count})`,
  )

  // -------------------------------------------------------------------------
  // [F] Analytics aggregations — the dashboard's data contract.
  // -------------------------------------------------------------------------
  log('\n[F] Analytics aggregations')

  // To make delivered = sent - bounced non-trivial, seed one bounced row
  // for SHOP_A (same template) so the summary has bounced=1.
  const bouncedId = await seedDelivery({
    shopId: SHOP_A,
    templateKey: 'campaign_promo',
    recipientEmail: `bounced-${SUFFIX}@example.test`,
    trackingToken: null,
    sentAt: new Date(),
    bouncedAt: new Date(),
  })
  void bouncedId

  const range = { since: TODAY, until: TODAY }
  const summary = await getEmailSummary(db as any, SHOP_A, range)
  // Shop A has (from [A]): 1 campaign_promo (collision probe), 2 password_reset
  // (null-token probes), 1 campaign_promo (main), 1 campaign_promo (bounced).
  // = 5 sent, 1 bounced, delivered = 4. Main has 2 opens + 1 click.
  assert(
    summary.sent >= 5 && summary.bounced >= 1 && summary.delivered === summary.sent - summary.bounced,
    `[F1a] summary.sent=${summary.sent}, bounced=${summary.bounced}, delivered=${summary.delivered} (delivered = sent - bounced)`,
  )
  assert(
    summary.opens === 2 && summary.clicks === 1,
    `[F1b] summary.opens=${summary.opens}, clicks=${summary.clicks} (our recorded hits)`,
  )
  assert(
    summary.uniqueOpens >= 1 && summary.uniqueClicks >= 1,
    `[F1c] uniqueOpens=${summary.uniqueOpens}, uniqueClicks=${summary.uniqueClicks} (>=1 each)`,
  )
  assert(
    Number.isFinite(summary.openRate) &&
      summary.openRate >= 0 &&
      summary.openRate <= 100 &&
      Number.isFinite(summary.clickRate) &&
      summary.clickRate >= 0 &&
      summary.clickRate <= 100 &&
      Number.isFinite(summary.bounceRate),
    `[F1d] all rates finite + clamped 0-100 (open=${summary.openRate}, click=${summary.clickRate}, bounce=${summary.bounceRate})`,
  )

  const daily = await getDailyEmailMetrics(db as any, SHOP_A, range)
  assert(
    daily.length === 1 && daily[0].date === TODAY,
    `[F2a] daily metrics returns exactly 1 day for 1-day range (got ${daily.length})`,
  )
  assert(
    daily[0].sent === summary.sent && daily[0].opens === summary.opens,
    `[F2b] today's daily row matches summary (sent=${daily[0].sent}, opens=${daily[0].opens})`,
  )

  // Zero-fill check: a 3-day range with data only on today should
  // produce 3 rows (the two older rows zero-filled).
  const start = new Date(TODAY + 'T00:00:00Z')
  start.setUTCDate(start.getUTCDate() - 2)
  const threeDayRange = {
    since: start.toISOString().slice(0, 10),
    until: TODAY,
  }
  const daily3 = await getDailyEmailMetrics(db as any, SHOP_A, threeDayRange)
  assert(
    daily3.length === 3 &&
      daily3[0].sent === 0 &&
      daily3[1].sent === 0 &&
      daily3[2].sent === summary.sent,
    `[F2c] 3-day range zero-fills the 2 past days, today has our sends`,
  )

  const breakdown = await getTemplateBreakdown(db as any, SHOP_A, range, { limit: 50 })
  const promo = breakdown.find((r) => r.templateKey === 'campaign_promo')
  assert(
    !!promo && promo.opens === 2 && promo.clicks === 1,
    `[F3a] getTemplateBreakdown has campaign_promo row with opens=2, clicks=1`,
  )
  assert(
    !!promo &&
      Number.isFinite(promo.openRate) &&
      Number.isFinite(promo.clickRate) &&
      Number.isFinite(promo.bounceRate),
    `[F3b] campaign_promo row rates are all finite numbers`,
  )

  // -------------------------------------------------------------------------
  // [G] Iron rule 5 — shop scoping + no god_admin leakage.
  //
  // Seed a row on SHOP_B with a different template + a click. SHOP_A's
  // summary must NOT include it.
  // -------------------------------------------------------------------------
  log('\n[G] Iron rule 5 — shop scoping + no leaks')

  const crossShopId = await seedDelivery({
    shopId: SHOP_B,
    templateKey: 'abandoned_cart_recovery',
    recipientEmail: `cross-shop-${SUFFIX}@example.test`,
    trackingToken: generateTrackingToken(0xdeadbeef), // any valid-shape token
    sentAt: new Date(),
  })
  // Manually stamp SHOP_B delivery with a click + an event so its numbers
  // are visible on SHOP_B's side but MUST NOT show up for SHOP_A.
  await (db as any)
    .updateTable('email_deliveries')
    .set({
      click_count: 5,
      clicked_at: new Date().toISOString(),
      open_count: 3,
      opened_at: new Date().toISOString(),
    })
    .where('id', '=', crossShopId)
    .execute()

  const shopASummaryAfterCross = await getEmailSummary(db as any, SHOP_A, range)
  assert(
    shopASummaryAfterCross.opens === summary.opens &&
      shopASummaryAfterCross.clicks === summary.clicks &&
      shopASummaryAfterCross.sent === summary.sent,
    `[G1] SHOP_A summary unchanged by SHOP_B activity (opens=${shopASummaryAfterCross.opens}/clicks=${shopASummaryAfterCross.clicks}/sent=${shopASummaryAfterCross.sent})`,
  )

  const shopBSummary = await getEmailSummary(db as any, SHOP_B, range)
  assert(
    shopBSummary.opens === 3 && shopBSummary.clicks === 5,
    `[G1b] SHOP_B sees its own counts (opens=${shopBSummary.opens}, clicks=${shopBSummary.clicks})`,
  )

  // God-admin leakage scan — every URL + every module export must be
  // clean.
  const pixelUrl = buildPixelUrl(resolveTrackingBaseUrl(), mainToken)
  const clickUrlSample = buildClickUrl(resolveTrackingBaseUrl(), mainToken, 'https://shop.com/')
  const analyticsBlob = JSON.stringify({
    summary,
    daily,
    breakdown,
    shopASummaryAfterCross,
    shopBSummary,
  })
  const leakSurfaces = [pixelUrl, clickUrlSample, analyticsBlob]
  const leakPatterns = [/god[\s_-]?admin/i, /\/god-admin\//i]
  const leaks: string[] = []
  for (const surface of leakSurfaces) {
    for (const pat of leakPatterns) {
      if (pat.test(surface)) {
        leaks.push(`${pat.source} matched in ${surface.slice(0, 60)}...`)
      }
    }
  }
  assert(
    leaks.length === 0,
    `[G2] no god_admin string in pixel URL / click URL / analytics response (leaks: ${leaks.join(' | ') || 'none'})`,
  )

  // Shut down the ephemeral HTTP server.
  await new Promise<void>((resolve) => server.close(() => resolve()))

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------
  log(`\n=== Phase 14 PR4 smoke: ${total - failed}/${total} passed (${failed} failed) ===\n`)
  process.exitCode = failed === 0 ? 0 : 1
}

async function countEvents(deliveryId: number): Promise<number> {
  const row = await (db as any)
    .selectFrom('email_events')
    .select((eb: any) => eb.fn.countAll().as('c'))
    .where('delivery_id', '=', deliveryId)
    .executeTakeFirst()
  return Number(row?.c ?? 0)
}

main()
  .catch((err) => {
    console.error('Phase 14 PR4 smoke — fatal error:', err)
    process.exitCode = 1
  })
  .finally(async () => {
    log('\n[cleanup] Removing seeded rows')
    try {
      // Clean up events first (FK cascade would handle it, but we're explicit).
      if (CREATED_DELIVERY_IDS.length > 0) {
        await (db as any)
          .deleteFrom('email_events')
          .where('delivery_id', 'in', CREATED_DELIVERY_IDS)
          .execute()
      }
      await (db as any).deleteFrom('email_deliveries').where('shop_id', '=', SHOP_A).execute()
      await (db as any).deleteFrom('email_deliveries').where('shop_id', '=', SHOP_B).execute()
      await (db as any).deleteFrom('email_preferences').where('shop_id', '=', SHOP_A).execute()
      await (db as any).deleteFrom('email_preferences').where('shop_id', '=', SHOP_B).execute()
      await (db as any).deleteFrom('shops').where('id', '=', SHOP_A).execute()
      await (db as any).deleteFrom('shops').where('id', '=', SHOP_B).execute()
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
