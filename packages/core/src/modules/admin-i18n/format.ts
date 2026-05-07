/**
 * Gbox Platform — Locale-aware Formatters (Phase 2 Step 2.10)
 *
 * Thin wrappers around the `Intl.*` APIs that pin the right locale
 * and defaults so callers don't have to remember the incantations.
 * One place to configure currency / number / date formatting means
 * one place to audit for locale bugs.
 *
 * Everything is synchronous and allocation-light. The Intl factories
 * are cheap so we don't memoize — if profiling proves otherwise, a
 * per-locale cache goes right here.
 */

import type { AdminLocale } from './types.js'

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

/**
 * Format a number for display using the locale's conventions.
 * Passes every `Intl.NumberFormatOptions` through so callers can
 * tune precision, grouping, and unit.
 */
export function formatNumber(
  locale: AdminLocale,
  value: number,
  options?: Intl.NumberFormatOptions,
): string {
  if (!Number.isFinite(value)) return ''
  return new Intl.NumberFormat(locale, options).format(value)
}

/**
 * Format a currency amount. `currency` is an ISO 4217 code
 * (`USD`, `EUR`, `GBP`); case-insensitive. Defaults to `USD` because
 * the MVP market tier is US/EU and every EU account keeps books in
 * a specific currency that's set per-shop, not per-locale.
 */
export function formatCurrency(
  locale: AdminLocale,
  value: number,
  currency = 'USD',
  options?: Intl.NumberFormatOptions,
): string {
  if (!Number.isFinite(value)) return ''
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: currency.toUpperCase(),
    ...options,
  }).format(value)
}

/**
 * Format a ratio (0.15 → "15%"). `fractionDigits` controls display
 * precision.
 */
export function formatPercent(
  locale: AdminLocale,
  value: number,
  fractionDigits = 0,
): string {
  if (!Number.isFinite(value)) return ''
  return new Intl.NumberFormat(locale, {
    style: 'percent',
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(value)
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

/**
 * Coerce a `Date | string | number` input into a real `Date` or
 * return `null` if it's unparseable. Centralizes the input handling
 * so format functions don't branch.
 */
function asDate(value: Date | string | number): Date | null {
  const d = value instanceof Date ? value : new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

/**
 * Medium-length localized date. Example outputs:
 *   en-US  → "Apr 9, 2026"
 *   de-DE  → "9. Apr. 2026"
 *   fr-FR  → "9 avr. 2026"
 */
export function formatDate(
  locale: AdminLocale,
  value: Date | string | number,
  options?: Intl.DateTimeFormatOptions,
): string {
  const d = asDate(value)
  if (!d) return ''
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    ...options,
  }).format(d)
}

/**
 * Date + time together. Respects the locale's 12h vs 24h default —
 * de-DE uses 24h, en-US uses 12h, etc.
 */
export function formatDateTime(
  locale: AdminLocale,
  value: Date | string | number,
  options?: Intl.DateTimeFormatOptions,
): string {
  const d = asDate(value)
  if (!d) return ''
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    ...options,
  }).format(d)
}

/**
 * Time only. Used by activity timeline headers when the date is
 * already grouped into a section.
 */
export function formatTime(
  locale: AdminLocale,
  value: Date | string | number,
  options?: Intl.DateTimeFormatOptions,
): string {
  const d = asDate(value)
  if (!d) return ''
  return new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
    ...options,
  }).format(d)
}

// ---------------------------------------------------------------------------
// Relative time ("5 minutes ago")
// ---------------------------------------------------------------------------

const RELATIVE_THRESHOLDS: { unit: Intl.RelativeTimeFormatUnit; seconds: number }[] = [
  { unit: 'year', seconds: 60 * 60 * 24 * 365 },
  { unit: 'month', seconds: 60 * 60 * 24 * 30 },
  { unit: 'week', seconds: 60 * 60 * 24 * 7 },
  { unit: 'day', seconds: 60 * 60 * 24 },
  { unit: 'hour', seconds: 60 * 60 },
  { unit: 'minute', seconds: 60 },
  { unit: 'second', seconds: 1 },
]

/**
 * Humanize "how long ago" in the user's locale. Uses the native
 * Intl.RelativeTimeFormat so pluralization and wording are correct
 * for every locale without per-language rules.
 *
 * Positive offsets mean the past (what admin pages want); negative
 * would mean the future.
 */
export function formatRelative(
  locale: AdminLocale,
  value: Date | string | number,
  now: Date = new Date(),
): string {
  const d = asDate(value)
  if (!d) return ''
  const diffSeconds = Math.round((d.getTime() - now.getTime()) / 1000)
  const absSeconds = Math.abs(diffSeconds)
  const fmt = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  for (const threshold of RELATIVE_THRESHOLDS) {
    if (absSeconds >= threshold.seconds || threshold.unit === 'second') {
      const units = Math.round(diffSeconds / threshold.seconds)
      return fmt.format(units, threshold.unit)
    }
  }
  return fmt.format(0, 'second')
}
