/**
 * Gbox Platform — A-Record Domain Detection (Phase 2B Sprint 3)
 *
 * Shopify-style DNS verification: the seller adds an `A` record at
 * their domain pointing directly at our platform origin IP (or a
 * `CNAME` → `shops.<apex>` that eventually resolves to the same IP),
 * and we verify by resolving the hostname and checking the answer
 * against the configured `PLATFORM_IP_V4` env value.
 *
 * This is the lower-friction alternative to the Cloudflare NS flow
 * implemented in `cloudflare-detect.ts`. Sellers who don't want to
 * move their nameservers can just add a single A record and be done.
 *
 * Why A record instead of CNAME-match?
 *   - CNAME at the apex is invalid DNS per RFC 1034; most registrars
 *     reject it. Using A keeps the UX identical for apex and
 *     subdomain setups.
 *   - A `CNAME www → shops.platform.tld` resolves (transparently) to
 *     the same A record on the resolver path, so we don't actually
 *     need to distinguish the two at verify-time. We only care
 *     that the final answer matches our IP.
 *
 * Resolver is injected so tests don't need real DNS — same pattern
 * as `cloudflare-detect.ts`.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A/AAAA resolver — matches `dns/promises.resolve4()`. Returns the
 * set of IP addresses the hostname resolves to. An empty array
 * means "no A records"; throws for network errors (NXDOMAIN,
 * SERVFAIL, timeout, …).
 */
export type DnsAResolver = (host: string) => Promise<string[]>

export interface DetectARecordInput {
  readonly domain: string
  readonly aResolver: DnsAResolver
  /**
   * One or more IPv4 addresses that identify the Gbox origin. At
   * least one of these must appear in the resolved A record set
   * for `matched` to be true.
   *
   * In production this is typically a single VIP (e.g. the Server 1
   * public IP `14.224.236.129`). HA setups can supply multiple.
   */
  readonly platformIps: readonly string[]
}

export interface DetectARecordResult {
  /**
   * True iff the resolved A record set contains at least one IP
   * from `platformIps`. False when there's no overlap, the
   * resolver returned empty, or the lookup threw.
   */
  readonly matched: boolean
  /**
   * Everything the resolver returned, lowercase + trimmed so the
   * UI can render them verbatim (e.g. "Points to 104.21.10.20").
   * Empty when the lookup failed or had no records.
   */
  readonly observedIps: readonly string[]
  /**
   * Mirror of the input so the UI can say "expected
   * `<platformIp>` but got `<observedIps>`" without re-plumbing
   * the env value through the caller.
   */
  readonly platformIps: readonly string[]
  /**
   * Populated when the A lookup itself failed (NXDOMAIN, SERVFAIL,
   * timeout, …). Lets the UI distinguish "DNS propagation hasn't
   * finished" (NXDOMAIN) from "seller has DNS infra problems"
   * (SERVFAIL) — same pattern as `cloudflare-detect.ts`.
   */
  readonly lookupError?: string
}

// ---------------------------------------------------------------------------
// detectARecord
// ---------------------------------------------------------------------------

/**
 * Resolve the A records for `domain` and check whether any of them
 * match the configured Gbox origin IP(s).
 *
 * Semantics:
 *   - Trim/lowercase the domain before resolving. Matches exactly
 *     what `cloudflare-detect.ts` does for consistency.
 *   - Resolver failures are CAUGHT and surfaced via `lookupError`.
 *     We never throw from this function — callers treat the result
 *     as an informational object. Consistent with the sibling
 *     `detectCloudflare` contract.
 *   - `matched=true` requires ≥1 observed IP to appear in
 *     `platformIps`. Order doesn't matter; we use a `Set` for O(1)
 *     membership. Empty `platformIps` always yields `matched=false`
 *     (guards against misconfigured env var).
 */
export async function detectARecord(
  input: DetectARecordInput,
): Promise<DetectARecordResult> {
  const domain = stripTrailingDot(input.domain.trim().toLowerCase())
  const platformIps = normaliseIpList(input.platformIps)

  let observedIps: string[] = []
  let lookupError: string | undefined
  try {
    const raw = await input.aResolver(domain)
    observedIps = raw.map((ip) => ip.trim().toLowerCase()).filter(Boolean)
  } catch (err) {
    // Mirror detectCloudflare's behaviour — no throws, just an
    // informational error string. The UI branches on lookupError to
    // show NXDOMAIN vs SERVFAIL vs generic messaging.
    lookupError = err instanceof Error ? err.message : String(err)
  }

  // Empty platformIps guard: we must never return matched=true if
  // the caller forgot to wire up the env var. That would silently
  // verify every seller's domain against nothing.
  const matched =
    platformIps.length > 0 &&
    observedIps.some((ip) => platformIps.includes(ip))

  return {
    matched,
    observedIps,
    platformIps,
    ...(lookupError !== undefined ? { lookupError } : {}),
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Normalise the platformIps input: lowercase + trim + drop empty
 * entries + dedupe. We don't attempt to validate IPv4 format
 * strictly — the env var is operator-controlled; a garbage value
 * would just result in `matched=false` for every domain, which is
 * the safe failure mode.
 */
function normaliseIpList(raw: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const entry of raw) {
    const cleaned = entry.trim().toLowerCase()
    if (!cleaned) continue
    if (seen.has(cleaned)) continue
    seen.add(cleaned)
    out.push(cleaned)
  }
  return out
}

function stripTrailingDot(domain: string): string {
  return domain.endsWith('.') ? domain.slice(0, -1) : domain
}

// ---------------------------------------------------------------------------
// parsePlatformIpEnv
// ---------------------------------------------------------------------------

/**
 * Helper the store-admin uses to parse the `GBOX_PLATFORM_IP_V4`
 * env var into the `platformIps` array. Supports comma-separated
 * values for HA setups and ignores whitespace:
 *
 *   "14.224.236.129"                       → ["14.224.236.129"]
 *   "14.224.236.129, 203.0.113.5"          → ["14.224.236.129", "203.0.113.5"]
 *   undefined / "" / "   "                 → []
 *
 * Exported so tests can lock the parsing rules without depending on
 * `process.env` mutation.
 */
export function parsePlatformIpEnv(raw: string | undefined | null): string[] {
  if (!raw) return []
  return normaliseIpList(raw.split(','))
}
