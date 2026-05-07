/**
 * Gbox Platform — Merchant Daily Sales Digest cron (Phase 14 PR6)
 *
 * Iterates every active shop, aggregates yesterday's sales, and sends
 * the `daily_sales_digest` email (audience=merchant) to the shop
 * owner. Runs at 06:05 UTC in production — 5 minutes after the
 * platform daily digest so GMV numbers line up even if both land on
 * the same server.
 *
 * Unlike the 3 god-admin crons, this one:
 *   - Uses the regular `sendTemplatedEmail` path (merchant audience)
 *   - Respects the shop's `automation_flows` toggle for the
 *     `daily_sales_digest_flow` entry (merchant can opt out via
 *     /settings/finance-alerts, spec §3f)
 *   - Skips shops with zero orders yesterday (no point emailing
 *     "0 sales" — mailing costs + inbox fatigue)
 *   - Uses idempotency key `daily_sales_digest:<shopId>:<date>` so a
 *     re-run on the same UTC day is a no-op
 *
 * Iron rule 5: this template is `audience=merchant`, so shopId is
 * REQUIRED (never null). send.ts's gate passes cleanly.
 *
 * Usage:
 *
 *   # Real cron (06:05 UTC daily):
 *   pnpm tsx scripts/ops/run-merchant-daily-digest.ts
 *
 *   # Single shop + dry run:
 *   pnpm tsx scripts/ops/run-merchant-daily-digest.ts \
 *     --shop-id=<uuid> --date=2026-04-21 --dry-run
 *
 * Flags:
 *   --date=YYYY-MM-DD   UTC date to summarise (default: yesterday)
 *   --shop-id=<uuid>    Single shop (default: all active shops)
 *   --dry-run           Compute + print, don't call sendTemplatedEmail
 *   --help
 *
 * Environment:
 *   MERCHANT_DIGEST_ENABLED    Kill-switch. '0'/'false'/'no' → exit 0
 *                              without sending anything. Default: '1'.
 *
 * Exit codes:
 *   0  all shops processed (sent OR skipped OR zero-orders)
 *   1  bad arguments
 *   2  database error
 *   3  at least one per-shop send failed
 */

import { sql } from 'kysely'

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

interface CliOptions {
  date: string | null
  shopId: string | null
  dryRun: boolean
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { date: null, shopId: null, dryRun: false }
  for (const arg of argv) {
    if (arg === '--dry-run') opts.dryRun = true
    else if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    } else if (arg.startsWith('--date=')) {
      const v = arg.slice('--date='.length)
      if (!ISO_DATE_RE.test(v)) {
        console.error(`bad --date: ${arg} (expected YYYY-MM-DD)`)
        process.exit(1)
      }
      opts.date = v
    } else if (arg.startsWith('--shop-id=')) {
      opts.shopId = arg.slice('--shop-id='.length)
    } else {
      console.error(`unknown arg: ${arg}`)
      printHelp()
      process.exit(1)
    }
  }
  return opts
}

function printHelp(): void {
  console.log(`usage: run-merchant-daily-digest [--date=YYYY-MM-DD] [--shop-id=UUID] [--dry-run]

Sends the 'daily_sales_digest' email to each active shop's owner. Skips
shops with zero orders yesterday. Idempotent within a UTC day.`)
}

// ---------------------------------------------------------------------------
// Utils
// ---------------------------------------------------------------------------

function yesterdayUtc(): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

/**
 * Read `MERCHANT_DIGEST_ENABLED` — false iff explicitly '0'/'false'/
 * 'no' (case-insensitive). Absent / empty / anything-else → true.
 * Mirrors the convention used by `isPlatformAlertsEnabled()`.
 */
export function isMerchantDigestEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.MERCHANT_DIGEST_ENABLED
  if (raw == null) return true
  const norm = String(raw).trim().toLowerCase()
  if (norm === '' || norm === '0' || norm === 'false' || norm === 'no') {
    return false
  }
  return true
}

function formatCurrency(amount: number | string | null | undefined, currency: string): string {
  const n = Number(amount ?? 0)
  if (!Number.isFinite(n)) return `${currency} 0.00`
  const formatted = n.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
  // Keep currency-agnostic — just prefix the ISO code rather than
  // assuming $; merchant sees whatever they configured.
  return `${currency} ${formatted}`
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// ---------------------------------------------------------------------------
// Per-shop worker
// ---------------------------------------------------------------------------

async function digestOneShop(
  db: any,
  shop: { id: string; name: string; slug: string; currency: string | null },
  date: string,
  dryRun: boolean,
): Promise<'sent' | 'skipped_pref' | 'skipped_no_orders' | 'no_recipient' | 'failed' | 'would_send'> {
  const start = `${date}T00:00:00Z`
  const endExclusive = new Date(new Date(start).getTime() + 86400000)
    .toISOString()
    .replace(/\.\d+Z$/, 'Z')

  // ---- Aggregate yesterday ----
  const totalsRow = await db
    .selectFrom('orders')
    .select([
      db.fn.count<string>('id').as('order_count'),
      sql<string>`COALESCE(SUM(total_price::numeric), 0)`.as('total_sales'),
    ])
    .where('shop_id', '=', shop.id)
    .where('created_at', '>=', start)
    .where('created_at', '<', endExclusive)
    .where((eb: any) =>
      eb.or([
        eb('cancelled_at', 'is', null),
        eb('cancelled_at', '>=', endExclusive),
      ]),
    )
    .executeTakeFirst()

  const orderCount = Number(totalsRow?.order_count ?? 0)
  const totalSalesRaw = Number(totalsRow?.total_sales ?? 0)

  if (orderCount === 0) return 'skipped_no_orders'

  // ---- Top 5 products by line-item revenue ----
  const topProducts = await db
    .selectFrom('order_line_items as li')
    .innerJoin('orders as o', 'o.id', 'li.order_id')
    .select([
      'li.title as title',
      db.fn.count<string>('li.id').as('units'),
      sql<string>`COALESCE(SUM((li.price::numeric - COALESCE(li.total_discount::numeric, 0)) * li.quantity), 0)`.as(
        'revenue',
      ),
    ])
    .where('o.shop_id', '=', shop.id)
    .where('o.created_at', '>=', start)
    .where('o.created_at', '<', endExclusive)
    .where((eb: any) =>
      eb.or([
        eb('o.cancelled_at', 'is', null),
        eb('o.cancelled_at', '>=', endExclusive),
      ]),
    )
    .groupBy('li.title')
    .orderBy(
      sql`COALESCE(SUM((li.price::numeric - COALESCE(li.total_discount::numeric, 0)) * li.quantity), 0)`,
      'desc',
    )
    .limit(5)
    .execute()

  const currency = (shop.currency ?? 'USD').toUpperCase()
  const topProductsHtml =
    topProducts.length === 0
      ? '<p style="color:#666;margin:0">No products sold yesterday.</p>'
      : '<ol style="margin:0;padding-left:20px;font-family:system-ui,sans-serif">' +
        topProducts
          .map(
            (r: any) =>
              `<li style="margin:6px 0"><strong>${escapeHtml(
                r.title ?? 'Untitled',
              )}</strong> — ${formatCurrency(r.revenue, currency)} <span style="color:#888">(${Number(
                r.units,
              )} units)</span></li>`,
          )
          .join('') +
        '</ol>'

  // ---- Recipient: owner email via user_shops → users ----
  const owner = await db
    .selectFrom('user_shops as us')
    .innerJoin('users as u', 'u.id', 'us.user_id')
    .select(['u.email as email'])
    .where('us.shop_id', '=', shop.id)
    .where('us.role', '=', 'owner')
    .where('us.disabled_at', 'is', null)
    .limit(1)
    .executeTakeFirst()

  if (!owner?.email) return 'no_recipient'

  if (dryRun) {
    console.log(
      `  would send: shop=${shop.name} to=${owner.email} orders=${orderCount} sales=${formatCurrency(
        totalSalesRaw,
        currency,
      )}`,
    )
    return 'would_send'
  }

  // ---- Send ----
  const { sendTemplatedEmail } = await import('@gbox/core/modules/email/send.js')
  const result = await sendTemplatedEmail(db, {
    templateKey: 'daily_sales_digest',
    to: owner.email,
    shopId: shop.id,
    variables: {
      shop_name: shop.name,
      total_sales: formatCurrency(totalSalesRaw, currency),
      order_count: String(orderCount),
      top_products_html: topProductsHtml,
      date,
    },
    idempotencyKey: `daily_sales_digest:${shop.id}:${date}`,
  })

  if (result.ok) return 'sent'
  if (result.reason === 'skipped_pref' || result.reason === 'skipped_suppressed') {
    return 'skipped_pref'
  }
  return 'failed'
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const date = opts.date ?? yesterdayUtc()

  if (!isMerchantDigestEnabled()) {
    console.log('MERCHANT_DIGEST_ENABLED=0 — skipping cron.')
    return
  }

  const { createDb } = await import('@gbox/db')
  const db = createDb()

  let exitCode = 0
  try {
    let shopsQuery = db
      .selectFrom('shops')
      .select(['id', 'name', 'slug', 'currency'])
      .where('status', '=', 'active')
    if (opts.shopId) {
      shopsQuery = shopsQuery.where('id', '=', opts.shopId)
    }
    const shops = await shopsQuery.execute()

    console.log('== Merchant Daily Sales Digest ==')
    console.log(`  date:       ${date}`)
    console.log(`  shops:      ${shops.length}${opts.shopId ? ` (filtered)` : ''}`)
    console.log(`  mode:       ${opts.dryRun ? 'DRY RUN' : 'LIVE SEND'}`)
    console.log('')

    if (shops.length === 0) {
      console.log('no active shops — nothing to do.')
      return
    }

    const tally: Record<string, number> = {
      sent: 0,
      skipped_pref: 0,
      skipped_no_orders: 0,
      no_recipient: 0,
      failed: 0,
      would_send: 0,
    }

    for (const shop of shops) {
      try {
        const outcome = await digestOneShop(db, shop as any, date, opts.dryRun)
        tally[outcome] = (tally[outcome] ?? 0) + 1
        if (outcome === 'sent') {
          console.log(`  SENT  shop=${shop.name}`)
        } else if (outcome === 'failed') {
          console.log(`  FAIL  shop=${shop.name}`)
        }
      } catch (err: any) {
        tally.failed = (tally.failed ?? 0) + 1
        console.error(
          `  FAIL  shop=${shop.name}: ${err?.message ?? err}`,
        )
      }
    }

    console.log('')
    console.log('== Done ==')
    for (const [k, v] of Object.entries(tally)) {
      console.log(`  ${k.padEnd(20)} ${v}`)
    }

    if (tally.failed > 0) exitCode = 3
  } catch (err: any) {
    console.error('FATAL:', err.message ?? err)
    exitCode = 2
  } finally {
    await db.destroy()
  }

  process.exit(exitCode)
}

const isDirect =
  typeof import.meta.url === 'string' &&
  typeof process.argv[1] === 'string' &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop() ?? '')

if (isDirect) {
  main().catch((err) => {
    console.error('unhandled:', err)
    process.exit(2)
  })
}
