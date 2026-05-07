/**
 * Gbox Platform — Cloudflare Domain Detection (Phase 2B Sprint 2)
 *
 * Pure helpers for the Cloudflare-proxied custom-domain flow. The
 * seller points their domain at Cloudflare (either nameserver-level
 * or partial CNAME setup) → Cloudflare terminates SSL + proxies to
 * our origin → we only need to verify that:
 *
 *   1. The nameservers are Cloudflare (so SSL and DDoS are handled).
 *   2. The A/CNAME answer points at our storefront origin
 *      (the shops.gbox.co CNAME target set by ops).
 *
 * This replaces the Let's Encrypt + certbot flow from Phase 6.3.
 * See migration 035_domain_cloudflare_redirects for the schema, and
 * CLAUDE-EXTENDED.md "Online Store Rewrite" for the locked decision.
 *
 * Resolvers are injected so tests don't need real DNS and the
 * production caller can swap node:dns for a custom resolver (e.g.
 * Cloudflare DoH) without touching this file — same pattern as
 * domain-verification.ts.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * NS resolver: given a hostname, return its nameserver records as a
 * flat array of hostnames. Matches `dns/promises.resolveNs()`.
 */
export type DnsNsResolver = (host: string) => Promise<string[]>

/**
 * CNAME resolver: given a hostname, return its CNAME target(s). An
 * empty array means "no CNAME" (the host is an A/AAAA leaf).
 * Matches `dns/promises.resolveCname()`.
 */
export type DnsCnameResolver = (host: string) => Promise<string[]>

/**
 * A/AAAA resolver: given a hostname, return the IP addresses. Used as
 * the fallback when there's no CNAME chain to surface. Matches
 * `dns/promises.resolve4()` shape (an array of strings).
 */
export type DnsAResolver = (host: string) => Promise<string[]>

export interface DetectCloudflareInput {
  readonly domain: string
  readonly nsResolver: DnsNsResolver
  /** Optional — if provided, also resolve the A/CNAME target. */
  readonly cnameResolver?: DnsCnameResolver
  readonly aResolver?: DnsAResolver
}

export interface DetectCloudflareResult {
  /** True iff EVERY nameserver matches the Cloudflare pattern. */
  readonly cloudflareProxied: boolean
  /**
   * Full list of nameservers (lowercase, trailing dot stripped) so the
   * UI can show them to the seller even when `cloudflareProxied` is
   * false — tells them exactly what's currently set.
   */
  readonly nameservers: readonly string[]
  /**
   * The DNS target the apex (or www) resolves to, if we were asked to
   * look it up. For CNAMEs this is the target hostname; for A-only
   * records this is a comma-joined IP list. Null if the caller didn't
   * supply a resolver, or the lookup genuinely failed (NXDOMAIN, etc.)
   * — we don't distinguish, since the UI only uses this as an
   * informational string.
   */
  readonly dnsTarget: string | null
  /**
   * Populated when the NS lookup itself failed (SERVFAIL, timeout,
   * etc.) so the caller can surface "couldn't reach DNS" instead of
   * silently marking the domain not-on-Cloudflare.
   */
  readonly lookupError?: string
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Cloudflare's full-setup nameservers all live under
 * `*.ns.cloudflare.com`. The two names a zone gets assigned (e.g.
 * `dara.ns.cloudflare.com`, `igor.ns.cloudflare.com`) are rotated per
 * zone but always share this suffix — this is the official detection
 * pattern recommended by Cloudflare support docs.
 *
 * We deliberately don't try to detect "partial" (CNAME-only) setups
 * here — those don't move the NS records, so the Gbox UI surfaces a
 * separate message telling the seller to move NS for full SSL control.
 */
const CLOUDFLARE_NS_SUFFIX = '.ns.cloudflare.com'

/**
 * Floor for the zone-apex walk. We refuse to query NS for anything
 * shorter than `label.tld` — i.e. at least two labels. Stops the
 * walker from hitting the root servers with `com`, `co.uk`, etc.
 */
const MIN_APEX_LABELS = 2

// ---------------------------------------------------------------------------
// isCloudflareNameserver
// ---------------------------------------------------------------------------

/**
 * True iff the single nameserver hostname matches the Cloudflare
 * pattern. Pulled out so the test suite can lock the rule down
 * without having to stand up full resolver mocks.
 */
export function isCloudflareNameserver(ns: string): boolean {
  const clean = normalizeNs(ns)
  return clean.endsWith(CLOUDFLARE_NS_SUFFIX)
}

// ---------------------------------------------------------------------------
// resolveNsWithApexWalk
// ---------------------------------------------------------------------------

export interface ZoneApexLookup {
  /** The list of nameservers found at the apex we settled on. */
  readonly nameservers: readonly string[]
  /**
   * The hostname we actually queried to get `nameservers`. For a
   * bare apex input (`mystore.com`) this equals the input. For a
   * subdomain input (`www.mystore.com`) this is usually the
   * parent zone (`mystore.com`) — i.e. the first ancestor that
   * returned at least one NS record.
   */
  readonly apex: string | null
  /** Resolver error from the last attempt, if all attempts failed. */
  readonly lookupError?: string
}

/**
 * NS records only live at a zone apex. A naive `resolveNs(host)`
 * on `www.mystore.com` returns empty because the `www` hostname
 * isn't itself a delegated zone. This walker shortens the host one
 * label at a time and retries until either:
 *
 *   1. We get a non-empty NS response (the zone apex), OR
 *   2. We hit `MIN_APEX_LABELS` labels (stops us from walking into
 *      the public suffix / TLDs).
 *
 * Every failed attempt's error message is captured in `lookupError`
 * for the last one, so the caller can distinguish "DNS unreachable"
 * from "domain has no NS anywhere" without running a second pass.
 *
 * Exported so tests can lock the walking rules independently of
 * `detectCloudflare`.
 */
export async function resolveNsWithApexWalk(
  rawDomain: string,
  nsResolver: DnsNsResolver,
): Promise<ZoneApexLookup> {
  const start = stripTrailingDot(rawDomain.trim().toLowerCase())
  if (!start || start.split('.').length < MIN_APEX_LABELS) {
    // Can't be a real zone — don't even try.
    return { nameservers: [], apex: null }
  }

  let candidate: string | null = start
  let lastError: string | undefined

  while (candidate !== null) {
    try {
      const raw = await nsResolver(candidate)
      if (raw.length > 0) {
        const nameservers = Array.from(new Set(raw.map(normalizeNs))).sort()
        return { nameservers, apex: candidate }
      }
      // Empty response: resolver answered but zone has no NS here.
      // Move up one label — maybe the parent zone has them.
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
      // Keep walking even on error — NXDOMAIN for a subdomain is
      // expected; the apex usually answers.
    }

    const next = parentDomain(candidate)
    candidate = next && next.split('.').length >= MIN_APEX_LABELS ? next : null
  }

  return {
    nameservers: [],
    apex: null,
    ...(lastError !== undefined ? { lookupError: lastError } : {}),
  }
}

// ---------------------------------------------------------------------------
// detectCloudflare
// ---------------------------------------------------------------------------

/**
 * Detects whether `domain` is fronted by Cloudflare and, optionally,
 * what CNAME/A target it currently resolves to.
 *
 * Semantics:
 *   - `cloudflareProxied` is true only when EVERY NS matches the
 *     `*.ns.cloudflare.com` suffix. Partial matches (1 of 2) are
 *     treated as false — the seller must move all NS records for
 *     SSL to work end-to-end.
 *   - NS lookup failure (NXDOMAIN, SERVFAIL, timeout, …) does NOT
 *     throw. We return `cloudflareProxied: false`, empty
 *     `nameservers`, and populate `lookupError` so the UI can say
 *     "couldn't reach DNS" without halting the whole verify flow.
 *   - CNAME/A lookups are best-effort: if both resolvers throw, the
 *     result has `dnsTarget: null`. They're only called when the
 *     caller actually supplies them, so the Sprint 2 UI can choose
 *     to skip the target probe when it doesn't need the answer yet.
 */
export async function detectCloudflare(
  input: DetectCloudflareInput,
): Promise<DetectCloudflareResult> {
  const domain = stripTrailingDot(input.domain.trim().toLowerCase())

  // --- NS lookup (walks up to the zone apex) -----------------------------
  // Sellers often enter a subdomain like `www.mystore.com`; NS
  // records live at the zone apex (`mystore.com`), not on the `www`
  // label itself. The walker short-circuits on the first ancestor
  // that returns any NS record and stops one level above the TLD
  // so we never pester the root servers with `com`.
  const apex = await resolveNsWithApexWalk(domain, input.nsResolver)
  const nameservers = apex.nameservers

  const cloudflareProxied =
    nameservers.length > 0 && nameservers.every(isCloudflareNameserver)

  // --- Target lookup (CNAME preferred, A fallback) -----------------------
  // The UI uses this to show sellers "your domain currently points to
  // <target>" so they can eyeball whether it matches `shops.gbox.co`.
  const dnsTarget = await probeDnsTarget(domain, input)

  return {
    cloudflareProxied,
    nameservers,
    dnsTarget,
    ...(apex.lookupError !== undefined ? { lookupError: apex.lookupError } : {}),
  }
}

// ---------------------------------------------------------------------------
// parentDomain helper
// ---------------------------------------------------------------------------

/**
 * Strip the leftmost label. Returns null when there is nothing
 * left to strip. `foo.bar.baz.com` → `bar.baz.com` → `baz.com` →
 * `com` → null.
 */
function parentDomain(domain: string): string | null {
  const idx = domain.indexOf('.')
  if (idx === -1) return null
  const parent = domain.slice(idx + 1)
  return parent.length > 0 ? parent : null
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Try CNAME first — the typical "point your domain at shops.gbox.co"
 * setup answers CNAME for `www` and an ALIAS/A for the apex. If CNAME
 * is empty (or throws), fall back to A records. Returns null only if
 * both paths fail or no resolvers were provided.
 */
async function probeDnsTarget(
  domain: string,
  input: DetectCloudflareInput,
): Promise<string | null> {
  if (input.cnameResolver) {
    try {
      const cnames = await input.cnameResolver(domain)
      if (cnames.length > 0) {
        // Multiple CNAMEs on the same name is invalid DNS, but some
        // resolvers return the chain — take the first target since
        // that's what clients would actually follow.
        return stripTrailingDot(cnames[0]!.toLowerCase())
      }
    } catch {
      // swallow — try A next
    }
  }

  if (input.aResolver) {
    try {
      const ips = await input.aResolver(domain)
      if (ips.length > 0) {
        return ips.join(',')
      }
    } catch {
      // swallow — nothing more to try
    }
  }

  return null
}

function normalizeNs(ns: string): string {
  return stripTrailingDot(ns.trim().toLowerCase())
}

function stripTrailingDot(domain: string): string {
  return domain.endsWith('.') ? domain.slice(0, -1) : domain
}
