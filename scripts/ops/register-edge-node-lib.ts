/**
 * Gbox Platform — register-edge-node pure helpers
 * (Landing Page System Phase 1D)
 *
 * Split out of `register-edge-node.ts` so the unit tests can import
 * the argv parser + validators without evaluating the CLI entry
 * point's side-effectful top-level imports (`dotenv/config`,
 * `@gbox/db`). Pure functions only — no Node APIs beyond string /
 * regex work.
 */

import type {
  EdgeNodeStatus,
  UpsertEdgeNodeInput,
} from '@gbox/core/modules/domains/edge-nodes.js'

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

/**
 * Parse the thin `--key value` argv style used by our ops scripts.
 * We don't pull in yargs/commander for a four-flag tool — keeping
 * the dep graph small matters on the edge host which bootstraps
 * with `pnpm install --prod`.
 */
export function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) {
      // Boolean flag — not used today but keep the shape stable.
      out[key] = 'true'
      continue
    }
    out[key] = next
    i++
  }
  return out
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const IPV4_RE = /^(?:\d{1,3}\.){3}\d{1,3}$/
// Loose IPv6 check — we just need to reject obvious nonsense; the
// database column has no strict format constraint and nginx never
// consumes this field directly.
const IPV6_RE = /^[0-9a-fA-F:.]+$/
const HOSTNAME_RE =
  /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/
const VALID_STATUSES: readonly EdgeNodeStatus[] = [
  'active',
  'draining',
  'offline',
]

export function assertValidHostname(hostname: string): void {
  if (!HOSTNAME_RE.test(hostname)) {
    throw new Error(
      `Invalid hostname "${hostname}" — must be a fully-qualified DNS name (e.g. edge-01.gbox.co)`,
    )
  }
}

export function assertValidIpv4(ipv4: string): void {
  if (!IPV4_RE.test(ipv4)) {
    throw new Error(`Invalid --ipv4 "${ipv4}" — expected dotted-quad`)
  }
  for (const octet of ipv4.split('.')) {
    const n = Number(octet)
    if (!(n >= 0 && n <= 255)) {
      throw new Error(`Invalid --ipv4 "${ipv4}" — octet ${octet} out of range`)
    }
  }
}

export function assertValidIpv6(ipv6: string): void {
  if (!IPV6_RE.test(ipv6) || !ipv6.includes(':')) {
    throw new Error(`Invalid --ipv6 "${ipv6}" — expected colon-separated hex`)
  }
}

export function assertValidStatus(
  status: string,
): asserts status is EdgeNodeStatus {
  if (!(VALID_STATUSES as readonly string[]).includes(status)) {
    throw new Error(
      `Invalid --status "${status}" — must be one of ${VALID_STATUSES.join('|')}`,
    )
  }
}

// ---------------------------------------------------------------------------
// Build input from argv + env
// ---------------------------------------------------------------------------

/**
 * Merge CLI flags with env-var fallbacks and validate. Pure function
 * so the unit test can drive it without stubbing process.argv or
 * process.env.
 *
 * Precedence: CLI flag > env var. Matches how the rest of our ops
 * scripts behave — the env var is the "sticky default" the operator
 * sets in /etc/gbox/edge.env, and the flag is the one-off override.
 */
export function buildInput(
  flags: Record<string, string>,
  env: NodeJS.ProcessEnv,
): UpsertEdgeNodeInput {
  const hostname = flags.hostname ?? env.EDGE_HOSTNAME
  const ipv4 = flags.ipv4 ?? env.EDGE_PUBLIC_IP
  const ipv6Raw = flags.ipv6 ?? env.EDGE_PUBLIC_IPV6
  const region = flags.region ?? env.EDGE_REGION
  const statusRaw = flags.status ?? env.EDGE_STATUS ?? 'active'
  const notes = flags.notes ?? env.EDGE_NOTES

  if (!hostname) {
    throw new Error('Missing --hostname (or EDGE_HOSTNAME env var)')
  }
  if (!ipv4) {
    throw new Error('Missing --ipv4 (or EDGE_PUBLIC_IP env var)')
  }
  assertValidHostname(hostname)
  assertValidIpv4(ipv4)
  if (ipv6Raw) assertValidIpv6(ipv6Raw)
  assertValidStatus(statusRaw)

  return {
    hostname,
    publicIpv4: ipv4,
    publicIpv6: ipv6Raw ?? null,
    region: region ?? null,
    status: statusRaw,
    notes: notes ?? null,
  }
}
