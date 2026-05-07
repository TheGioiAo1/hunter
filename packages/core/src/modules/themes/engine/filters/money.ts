/**
 * Gbox Platform — Money filter set
 *
 * Decision #1 Step 1.5 — Shopify-compatible money filters. Templates
 * will write:
 *
 *     {{ product.price | money }}                 → "$19.99"
 *     {{ product.price | money_with_currency }}   → "$19.99 USD"
 *     {{ product.price | money_without_currency }} → "19.99"
 *     {{ product.price | money_without_trailing_zeros }} → "$20"
 *
 * Shopify compatibility notes:
 *
 *   1. Amounts are INTEGERS in the shop's minor currency unit (cents for
 *      USD, xu for VND, etc.). `{{ 1999 | money }}` → "$19.99" because
 *      1999 cents = $19.99. Matches every Shopify theme exactly — no
 *      theme in the store has ever passed dollars to `| money`.
 *
 *   2. The filter reads `shop.money_format` and
 *      `shop.money_with_currency_format` from the render context. These
 *      are set by the merchant in Settings → General → Currency
 *      formatting. Example defaults:
 *           money_format:               "${{amount}}"
 *           money_with_currency_format: "${{amount}} USD"
 *
 *   3. Format strings use Shopify's token set, documented at
 *      https://shopify.dev/docs/storefronts/themes/architecture/settings/html-templates#money-formats
 *
 *         {{amount}}                                  1,134.65
 *         {{amount_no_decimals}}                      1,135
 *         {{amount_with_comma_separator}}             1.134,65
 *         {{amount_no_decimals_with_comma_separator}} 1.135
 *         {{amount_with_space_separator}}             1 134,65
 *         {{amount_no_decimals_with_space_separator}} 1 135
 *         {{amount_with_apostrophe_separator}}        1'134.65
 *
 *      Unknown tokens are left as-is so merchants can use literal
 *      `{{currency}}` placeholders in their format strings (Shopify
 *      treats unrecognised tokens as text too).
 *
 *   4. `money_without_trailing_zeros` replaces `{{amount*}}` with
 *      `{{amount_no_decimals*}}` IFF the amount is exactly whole
 *      (cents % 100 === 0). This matches Shopify's behaviour: "$20.00"
 *      becomes "$20" but "$19.99" stays "$19.99".
 *
 *   5. `money_without_currency` always uses `{{amount}}` regardless of
 *      shop settings — Shopify defines it that way so merchants can
 *      render bare decimal numbers for price-range sliders etc.
 *
 * Why async filters?
 *   Same reason as the `t` filter (Step 1.4): reading `shop.*` via
 *   `this.context.get([...])` is promise-friendly in LiquidJS and the
 *   engine always runs `parseAndRender` (async path), so there's no
 *   overhead from the microtask hop.
 *
 * Why integer cents instead of a Money drop object?
 *   A richer `Money { amount, currency_code }` drop is on the roadmap
 *   for Step 1.12 (render context builder) where it will matter for
 *   multi-currency stores. Right now Step 1.5 only has the filters;
 *   they accept whatever the caller passes (number / numeric string /
 *   Money drop) and coerce to cents. When the drop arrives, the
 *   coercion below already handles its `.amount` field.
 */

import type { Liquid } from 'liquidjs'

const DEFAULT_MONEY_FORMAT = '${{amount}}'
const DEFAULT_MONEY_WITH_CURRENCY_FORMAT = '${{amount}} USD'

/**
 * Insert `sep` every 3 digits from the right of an integer string.
 * Accepts only non-negative integer digit strings; caller handles sign.
 */
function thousands(intStr: string, sep: string): string {
  // JS regex lookahead handles this cleanly. `\B` prevents matching at
  // string start (so "100" → "100", not ",100").
  return intStr.replace(/\B(?=(\d{3})+(?!\d))/g, sep)
}

/**
 * Coerce an arbitrary filter input to an integer number of minor units
 * (cents). Handles:
 *   - numbers (assumed already in cents)
 *   - numeric strings
 *   - null / undefined / NaN → 0
 *   - Money-drop-like objects with `.amount` or `.price` field
 *
 * Returns 0 on any unresolvable input — Shopify does not throw on bad
 * money inputs, it silently renders "$0.00".
 */
function toCents(value: unknown): number {
  if (value === null || value === undefined || value === '') return 0
  if (typeof value === 'number') {
    return Number.isFinite(value) ? Math.round(value) : 0
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return 0
    const n = Number(trimmed)
    return Number.isFinite(n) ? Math.round(n) : 0
  }
  if (typeof value === 'object') {
    const anyV = value as any
    if (typeof anyV.amount === 'number' || typeof anyV.amount === 'string') {
      return toCents(anyV.amount)
    }
    if (typeof anyV.price === 'number' || typeof anyV.price === 'string') {
      return toCents(anyV.price)
    }
  }
  return 0
}

/**
 * Render a single Shopify `{{amount*}}` token given an ABSOLUTE cent
 * amount (caller has already stripped the sign).
 *
 * Returns the special sentinel `null` for unknown tokens so the caller
 * can leave unrecognised `{{...}}` blocks untouched in the format
 * string. This is how Shopify handles bespoke tokens like `{{currency}}`
 * that merchants sometimes paste in.
 */
function formatAmountToken(absCents: number, token: string): string | null {
  const whole = Math.floor(absCents / 100)
  const fraction = absCents % 100
  const wholeStr = String(whole)
  const fracStr = String(fraction).padStart(2, '0')
  // "Round to nearest whole unit" for the *_no_decimals variants:
  //   1999 cents → 20 units   (rounds .99 up)
  //   1950 cents → 20 units   (banker-agnostic: we use Math.round)
  //   1949 cents → 19 units
  const wholeRounded = String(Math.round(absCents / 100))

  switch (token) {
    case 'amount':
      return thousands(wholeStr, ',') + '.' + fracStr
    case 'amount_no_decimals':
      return thousands(wholeRounded, ',')
    case 'amount_with_comma_separator':
      return thousands(wholeStr, '.') + ',' + fracStr
    case 'amount_no_decimals_with_comma_separator':
      return thousands(wholeRounded, '.')
    case 'amount_with_space_separator':
      return thousands(wholeStr, ' ') + ',' + fracStr
    case 'amount_no_decimals_with_space_separator':
      return thousands(wholeRounded, ' ')
    case 'amount_with_apostrophe_separator':
      return thousands(wholeStr, "'") + '.' + fracStr
    default:
      return null
  }
}

/**
 * Apply a Shopify money format string to an amount in cents.
 *
 * Negative amounts are handled by:
 *   1. Formatting the absolute value via the token substitutions
 *      (so `{{amount}}` alone never contains a minus sign)
 *   2. Prepending `-` to the FINAL formatted string
 *
 * This mirrors Shopify's output: `${{amount}}` with -500 cents renders
 * as `-$5.00` (minus outside the currency symbol), not `$-5.00`.
 *
 * Unknown tokens (anything that isn't `amount*`) are passed through
 * untouched so merchants can include custom placeholders.
 */
function applyMoneyFormat(cents: number, format: string): string {
  const negative = cents < 0
  const absCents = Math.abs(cents)
  const body = format.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, token) => {
    const formatted = formatAmountToken(absCents, token)
    return formatted === null ? match : formatted
  })
  return negative ? '-' + body : body
}

/**
 * For `money_without_trailing_zeros`: rewrite decimal tokens to their
 * no-decimals counterparts when the amount is a whole unit. Only
 * the three tokens that have standard no-decimals variants are
 * rewritten; `amount_with_apostrophe_separator` is left alone (Shopify
 * doesn't ship an `amount_no_decimals_with_apostrophe_separator` token).
 */
function stripTrailingZerosFormat(format: string): string {
  return format.replace(
    /\{\{\s*amount(_with_comma_separator|_with_space_separator)?\s*\}\}/g,
    (_match, suffix) => `{{amount_no_decimals${suffix || ''}}}`,
  )
}

/** Read the shop drop off the current render context. */
async function getShop(ctx: any): Promise<any> {
  if (!ctx) return null
  try {
    return await ctx.get(['shop'])
  } catch {
    return null
  }
}

function readFormat(shop: any, field: string, fallback: string): string {
  if (shop && typeof shop === 'object') {
    const v = (shop as any)[field]
    if (typeof v === 'string' && v.length > 0) return v
  }
  return fallback
}

export function registerMoneyFilters(liquid: Liquid): void {
  // ---- money -------------------------------------------------------------
  liquid.registerFilter('money', async function moneyFilter(
    this: any,
    value: unknown,
  ): Promise<string> {
    const cents = toCents(value)
    const shop = await getShop(this?.context)
    const fmt = readFormat(shop, 'money_format', DEFAULT_MONEY_FORMAT)
    return applyMoneyFormat(cents, fmt)
  })

  // ---- money_with_currency ----------------------------------------------
  liquid.registerFilter('money_with_currency', async function (
    this: any,
    value: unknown,
  ): Promise<string> {
    const cents = toCents(value)
    const shop = await getShop(this?.context)
    const fmt = readFormat(
      shop,
      'money_with_currency_format',
      DEFAULT_MONEY_WITH_CURRENCY_FORMAT,
    )
    return applyMoneyFormat(cents, fmt)
  })

  // ---- money_without_currency -------------------------------------------
  // Always uses the bare `{{amount}}` token regardless of shop settings —
  // matches Shopify's documented behaviour.
  liquid.registerFilter('money_without_currency', function (value: unknown): string {
    const cents = toCents(value)
    return applyMoneyFormat(cents, '{{amount}}')
  })

  // ---- money_without_trailing_zeros -------------------------------------
  liquid.registerFilter('money_without_trailing_zeros', async function (
    this: any,
    value: unknown,
  ): Promise<string> {
    const cents = toCents(value)
    const shop = await getShop(this?.context)
    let fmt = readFormat(shop, 'money_format', DEFAULT_MONEY_FORMAT)
    if (cents % 100 === 0) {
      fmt = stripTrailingZerosFormat(fmt)
    }
    return applyMoneyFormat(cents, fmt)
  })

  // ---- money_with_currency_without_trailing_zeros -----------------------
  // Rare but Shopify ships it; mirrors the money_without_trailing_zeros
  // logic but against money_with_currency_format.
  liquid.registerFilter(
    'money_with_currency_without_trailing_zeros',
    async function (this: any, value: unknown): Promise<string> {
      const cents = toCents(value)
      const shop = await getShop(this?.context)
      let fmt = readFormat(
        shop,
        'money_with_currency_format',
        DEFAULT_MONEY_WITH_CURRENCY_FORMAT,
      )
      if (cents % 100 === 0) {
        fmt = stripTrailingZerosFormat(fmt)
      }
      return applyMoneyFormat(cents, fmt)
    },
  )

  // ---- weight_with_unit --------------------------------------------------
  // Shopify `product.weight` is grams (integer). The filter output
  // depends on the product's own `weight_unit` field ('g' | 'kg' | 'lb'
  // | 'oz'); when called as `| weight_with_unit` LiquidJS passes just
  // the value, so we peek at the surrounding object for a sibling
  // weight_unit via the second (optional) positional arg instead. This
  // matches the Shopify pattern `{{ product.weight | weight_with_unit: product.weight_unit }}`.
  liquid.registerFilter('weight_with_unit', function (
    value: unknown,
    unit?: unknown,
  ): string {
    const grams =
      typeof value === 'number'
        ? value
        : typeof value === 'string'
          ? Number(value) || 0
          : 0
    const u = typeof unit === 'string' && unit.length > 0 ? unit : 'g'
    switch (u) {
      case 'kg':
        return formatWeight(grams / 1000) + ' kg'
      case 'lb':
        return formatWeight(grams / 453.59237) + ' lb'
      case 'oz':
        return formatWeight(grams / 28.349523125) + ' oz'
      case 'g':
      default:
        return formatWeight(grams) + ' g'
    }
  })
}

/**
 * Format a weight for display. Integers render without decimals
 * (`500 g`), fractionals render with up to 2 decimals (`1.5 kg`,
 * `2.25 lb`). Matches Shopify's visual output closely enough for
 * theme parity.
 */
function formatWeight(value: number): string {
  if (Number.isInteger(value)) return String(value)
  // toFixed(2) then strip trailing zeros and any dangling dot.
  //    1.50  → "1.50" → "1.5"
  //    2.76  → "2.76" → "2.76"
  //    2.70  → "2.70" → "2.7"
  return value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')
}
