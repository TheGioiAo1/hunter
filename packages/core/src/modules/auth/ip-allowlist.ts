/**
 * IP allowlist — CIDR matching for Phase 0 §8 Item #4.
 *
 * Pure helpers (no DB, no Express) so they're trivially unit-testable
 * and can be reused by the god-admin and store-admin middlewares plus
 * any future CLI tooling. The matcher supports both IPv4 and IPv6 CIDRs
 * without an external dependency — we rely on node's built-in
 * `net.isIPv4` / `net.isIPv6` and a small BigInt conversion.
 *
 * Semantics (shared with `users.ip_allowlist` from migration 016):
 *
 *   - NULL / empty array    → allowlist disabled, caller permitted.
 *   - Non-empty array       → caller's IP must match at least one CIDR.
 *                             Otherwise the caller is refused (403).
 *
 * Bare IPs without a mask are accepted as /32 (IPv4) or /128 (IPv6) so
 * ops can type `1.2.3.4` instead of `1.2.3.4/32`.
 *
 * This module is intentionally TINY. If we ever need things like
 * private-range detection, hostnames, or overlapping-range merging,
 * move to `ipaddr.js` rather than grow this file.
 */

import { isIPv4, isIPv6 } from 'node:net'

export interface ParsedCidr {
  /** Original input, preserved for logs/audit. */
  raw: string
  /** 'v4' or 'v6'. */
  family: 'v4' | 'v6'
  /** Network address as BigInt (masked low bits zeroed). */
  network: bigint
  /** Prefix length in bits (0–32 for v4, 0–128 for v6). */
  prefix: number
  /** Bit width for the family (32 or 128), cached for matching. */
  width: number
}

/**
 * Thrown when a CIDR cannot be parsed. Callers should surface the
 * message to the operator — they're editing the list by hand.
 */
export class InvalidCidrError extends Error {
  constructor(public readonly raw: string, reason: string) {
    super(`invalid CIDR "${raw}": ${reason}`)
    this.name = 'InvalidCidrError'
  }
}

/**
 * Parse a single CIDR string into a `ParsedCidr`.
 *
 * Accepts:
 *   - "10.0.0.0/8"           → IPv4 CIDR
 *   - "1.2.3.4"              → IPv4 /32
 *   - "2001:db8::/32"        → IPv6 CIDR
 *   - "::1"                  → IPv6 /128
 */
export function parseCidr(raw: string): ParsedCidr {
  const trimmed = raw.trim()
  if (!trimmed) {
    throw new InvalidCidrError(raw, 'empty string')
  }

  const slashIdx = trimmed.indexOf('/')
  const ipPart = slashIdx === -1 ? trimmed : trimmed.slice(0, slashIdx)
  const prefixPart = slashIdx === -1 ? null : trimmed.slice(slashIdx + 1)

  let family: 'v4' | 'v6'
  let width: number
  if (isIPv4(ipPart)) {
    family = 'v4'
    width = 32
  } else if (isIPv6(ipPart)) {
    family = 'v6'
    width = 128
  } else {
    throw new InvalidCidrError(raw, 'not a valid IPv4 or IPv6 address')
  }

  let prefix: number
  if (prefixPart === null) {
    prefix = width
  } else {
    const n = Number(prefixPart)
    if (!Number.isInteger(n) || n < 0 || n > width) {
      throw new InvalidCidrError(
        raw,
        `prefix must be integer in 0..${width}`,
      )
    }
    prefix = n
  }

  const ipInt = ipToBigInt(ipPart, family)
  const mask = prefixMask(prefix, width)
  const network = ipInt & mask

  return { raw: trimmed, family, network, prefix, width }
}

/**
 * Parse an array of CIDR strings, collecting validation errors rather
 * than stopping on the first bad one. Returns both the successfully
 * parsed entries and a list of problems so the settings UI can render
 * per-row feedback.
 */
export function parseCidrList(raws: readonly string[]): {
  valid: ParsedCidr[]
  errors: { raw: string; message: string }[]
} {
  const valid: ParsedCidr[] = []
  const errors: { raw: string; message: string }[] = []
  for (const r of raws) {
    if (typeof r !== 'string' || r.trim() === '') continue
    try {
      valid.push(parseCidr(r))
    } catch (err) {
      errors.push({
        raw: r,
        message:
          err instanceof InvalidCidrError
            ? err.message
            : err instanceof Error
              ? err.message
              : String(err),
      })
    }
  }
  return { valid, errors }
}

/**
 * Check whether an IP (as a string) falls inside a parsed CIDR.
 * Returns false on parse errors rather than throwing so caller code
 * stays short in the hot path.
 */
export function ipInCidr(ip: string, cidr: ParsedCidr): boolean {
  let family: 'v4' | 'v6'
  if (isIPv4(ip)) family = 'v4'
  else if (isIPv6(ip)) family = 'v6'
  else return false

  // Different families never match. We don't try to treat IPv4-mapped
  // IPv6 ("::ffff:1.2.3.4") as IPv4 here — the middleware normalises
  // that before calling us.
  if (family !== cidr.family) return false

  const ipInt = ipToBigInt(ip, family)
  const mask = prefixMask(cidr.prefix, cidr.width)
  return (ipInt & mask) === cidr.network
}

/**
 * Check whether an IP is allowed by an entire allowlist. Empty or
 * missing lists always return `true` (allowlist disabled).
 *
 * The caller is expected to have already parsed the allowlist with
 * `parseCidrList` — passing `ParsedCidr[]` keeps the hot path alloc-free.
 */
export function ipInAllowlist(
  ip: string,
  allowlist: readonly ParsedCidr[] | null | undefined,
): boolean {
  if (!allowlist || allowlist.length === 0) return true
  for (const cidr of allowlist) {
    if (ipInCidr(ip, cidr)) return true
  }
  return false
}

/**
 * Normalise an incoming request IP. Express populates `req.ip` from
 * the socket or X-Forwarded-For; IPv4 over IPv6 shows up as
 * `::ffff:1.2.3.4` which we fold back to `1.2.3.4` so a user who
 * allowlisted `1.2.3.4/32` doesn't silently fail.
 */
export function normaliseRequestIp(ip: string | undefined | null): string | null {
  if (!ip) return null
  const trimmed = ip.trim()
  if (!trimmed) return null
  // IPv4-mapped IPv6 → IPv4
  const mapped = trimmed.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i)
  if (mapped && isIPv4(mapped[1])) return mapped[1]
  if (isIPv4(trimmed) || isIPv6(trimmed)) return trimmed
  return null
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function ipToBigInt(ip: string, family: 'v4' | 'v6'): bigint {
  if (family === 'v4') {
    const parts = ip.split('.')
    let n = 0n
    for (const p of parts) {
      n = (n << 8n) | BigInt(Number(p))
    }
    return n
  }
  // IPv6 — expand '::' then split into 8 hextets.
  return ipv6ToBigInt(ip)
}

function ipv6ToBigInt(ip: string): bigint {
  // Handle embedded IPv4 (e.g. "::ffff:1.2.3.4") by converting the
  // trailing dotted-quad into two hextets.
  let str = ip
  const lastColon = str.lastIndexOf(':')
  const tail = str.slice(lastColon + 1)
  if (tail.includes('.') && isIPv4(tail)) {
    const v4 = ipToBigInt(tail, 'v4')
    const hi = (v4 >> 16n) & 0xffffn
    const lo = v4 & 0xffffn
    str =
      str.slice(0, lastColon + 1) +
      hi.toString(16) +
      ':' +
      lo.toString(16)
  }

  // Split into head/tail around '::' if present.
  let head: string[] = []
  let tailParts: string[] = []
  if (str.includes('::')) {
    const [h, t] = str.split('::')
    head = h ? h.split(':') : []
    tailParts = t ? t.split(':') : []
  } else {
    head = str.split(':')
  }

  const missing = 8 - head.length - tailParts.length
  if (missing < 0) {
    // Malformed — shouldn't happen because isIPv6 passed, but be safe.
    throw new InvalidCidrError(ip, 'too many IPv6 hextets')
  }
  const zeros = new Array(missing).fill('0')
  const all = [...head, ...zeros, ...tailParts]

  let n = 0n
  for (const h of all) {
    const v = BigInt(parseInt(h || '0', 16))
    n = (n << 16n) | v
  }
  return n
}

function prefixMask(prefix: number, width: number): bigint {
  if (prefix === 0) return 0n
  if (prefix === width) return (1n << BigInt(width)) - 1n
  const host = width - prefix
  const all = (1n << BigInt(width)) - 1n
  return (all >> BigInt(host)) << BigInt(host)
}
