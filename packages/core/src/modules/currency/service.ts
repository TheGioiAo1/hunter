/**
 * Gbox Platform — Multi-Currency Service (Shopify Markets pattern)
 *
 * Responsibilities:
 *   1. Look up FX rates from the `currency_rates` table.
 *   2. Convert monetary amounts between any two ISO-4217 currencies.
 *   3. Cache hot-path rates in Redis to avoid hammering the DB on every
 *      price conversion.
 *
 * Design notes:
 *   - Amounts are always passed/returned as strings with 2 decimals so we
 *     never round-trip through JavaScript `number` precision.
 *   - Rates are `numeric(18,10)` in the DB — use them as strings and do
 *     multiplication via the built-in decimal library, not Number().
 *   - `convert(a, USD, USD)` is a no-op and avoids the DB entirely.
 *   - Missing rates fall back to going through USD as a pivot
 *     (A → USD → B) because we always seed USD→X rows.
 *   - If no rate exists at all, throws — the caller must decide whether
 *     to fail the checkout or fall back to shop currency.
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import { cacheGet, cacheSet } from '../cache/redis.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Money {
  amount: string   // decimal string, e.g. '19.99'
  currency: string // ISO-4217, e.g. 'USD'
}

export interface ConvertedMoney extends Money {
  shop_money: Money        // original
  presentment_money: Money // converted
  rate: string             // exchange rate used (numeric(18,10))
}

const RATE_CACHE_TTL = 60 * 15 // 15 minutes

// ---------------------------------------------------------------------------
// Rate lookup
// ---------------------------------------------------------------------------

/**
 * Get the latest FX rate from `base` to `quote`.
 * Returns the rate as a decimal string, or null if no rate is found.
 *
 * Lookup order:
 *   1. Redis cache (`fx:BASE:QUOTE`).
 *   2. Direct row in `currency_rates` (latest effective_at).
 *   3. Pivot via USD (base→USD * USD→quote).
 */
export async function getRate(
  db: Kysely<Database>,
  base: string,
  quote: string,
): Promise<string | null> {
  base = base.toUpperCase()
  quote = quote.toUpperCase()

  if (base === quote) return '1'

  // 1. Cache hit?
  const cacheKey = `fx:${base}:${quote}`
  const cached = await cacheGet<string>(cacheKey)
  if (cached) return cached

  // 2. Direct row?
  const direct = await db
    .selectFrom('currency_rates')
    .select(['rate'])
    .where('base_currency', '=', base)
    .where('quote_currency', '=', quote)
    .orderBy('effective_at', 'desc')
    .executeTakeFirst()

  if (direct?.rate) {
    await cacheSet(cacheKey, direct.rate, RATE_CACHE_TTL)
    return String(direct.rate)
  }

  // 3. Pivot via USD.
  if (base !== 'USD' && quote !== 'USD') {
    const [baseToUsd, usdToQuote] = await Promise.all([
      getRate(db, base, 'USD'),
      getRate(db, 'USD', quote),
    ])
    if (baseToUsd && usdToQuote) {
      const rate = multiplyDecimal(baseToUsd, usdToQuote, 10)
      await cacheSet(cacheKey, rate, RATE_CACHE_TTL)
      return rate
    }
  }

  // 4. Inverse? (e.g. if we have EUR→USD but were asked for USD→EUR we
  //    could 1/rate, but that introduces rounding error so we skip it and
  //    rely on callers seeding both directions.)
  return null
}

/**
 * Convert an amount from one currency to another, returning a Shopify-style
 * pair of shop_money + presentment_money.
 *
 * Throws if no rate path exists.
 */
export async function convert(
  db: Kysely<Database>,
  amount: string,
  from: string,
  to: string,
): Promise<ConvertedMoney> {
  from = from.toUpperCase()
  to = to.toUpperCase()

  if (from === to) {
    const money: Money = { amount: normalizeAmount(amount), currency: from }
    return {
      ...money,
      shop_money: money,
      presentment_money: money,
      rate: '1',
    }
  }

  const rate = await getRate(db, from, to)
  if (!rate) {
    throw new Error(`No FX rate available: ${from} → ${to}`)
  }

  const converted = normalizeAmount(multiplyDecimal(amount, rate, 2))
  return {
    amount: converted,
    currency: to,
    shop_money: { amount: normalizeAmount(amount), currency: from },
    presentment_money: { amount: converted, currency: to },
    rate,
  }
}

/**
 * Upsert a manual rate. Used by admin "set exchange rate" UI and by cron
 * jobs that pull from ECB / fixer.io.
 */
export async function setRate(
  db: Kysely<Database>,
  base: string,
  quote: string,
  rate: string,
  source: string = 'manual',
): Promise<void> {
  await db
    .insertInto('currency_rates')
    .values({
      base_currency: base.toUpperCase(),
      quote_currency: quote.toUpperCase(),
      rate,
      source,
    } as any)
    .execute()
}

// ---------------------------------------------------------------------------
// Decimal helpers — string-based to avoid float precision bugs
//
// We intentionally do NOT pull in big.js / decimal.js here to keep the
// core module dependency-free. The math we need is limited (multiply two
// positive decimals, truncate to N places) so we hand-roll it.
// ---------------------------------------------------------------------------

function multiplyDecimal(a: string, b: string, precision: number): string {
  // Split into integer parts to avoid float rounding on large values.
  const [aInt, aFrac = ''] = a.split('.')
  const [bInt, bFrac = ''] = b.split('.')

  const aBig = BigInt((aInt + aFrac).replace(/^-/, '')) * (a.startsWith('-') ? -1n : 1n)
  const bBig = BigInt((bInt + bFrac).replace(/^-/, '')) * (b.startsWith('-') ? -1n : 1n)

  const product = aBig * bBig
  const totalFracDigits = aFrac.length + bFrac.length

  // Scale into `precision` fractional digits.
  let str = product.toString()
  const negative = str.startsWith('-')
  if (negative) str = str.slice(1)

  if (totalFracDigits === 0) {
    return (negative ? '-' : '') + str + '.' + '0'.repeat(precision)
  }

  // Pad with leading zeros so we have at least `totalFracDigits + 1` digits.
  if (str.length <= totalFracDigits) {
    str = str.padStart(totalFracDigits + 1, '0')
  }

  const intPart = str.slice(0, str.length - totalFracDigits)
  let fracPart = str.slice(str.length - totalFracDigits)

  if (precision < totalFracDigits) {
    // Truncate (floor toward zero, Shopify rounds half-even but for
    // display we do banker's rounding rarely matters at 2 decimals).
    fracPart = fracPart.slice(0, precision)
  } else if (precision > totalFracDigits) {
    fracPart = fracPart.padEnd(precision, '0')
  }

  return (negative ? '-' : '') + intPart + (precision > 0 ? '.' + fracPart : '')
}

function normalizeAmount(amount: string): string {
  // Ensure 2 decimal places for display.
  const [int, frac = ''] = amount.split('.')
  return int + '.' + (frac + '00').slice(0, 2)
}
