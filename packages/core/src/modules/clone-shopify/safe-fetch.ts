/**
 * SSRF-safe HTTP fetcher for the clone pipeline.
 *
 * The clone server fetches arbitrary URLs supplied by users. That
 * makes it a prime SSRF target. Every outbound request must go
 * through this function — no direct `undici.request` or `fetch` in
 * clone-core/clone-pro-server code.
 *
 * Guarantees:
 *
 *   1. Only `http:` and `https:` schemes allowed. `file:`, `gopher:`,
 *      `data:`, `ftp:`, custom schemes → rejected.
 *   2. DNS resolution happens BEFORE the socket is opened. The
 *      resolved IPs are checked against a private/reserved block
 *      list; any hit aborts the request.
 *   3. Redirects are followed manually (up to `maxRedirects`) so
 *      each new target goes through the same checks — an attacker
 *      can't hide a private-IP target behind a public 302.
 *   4. Response body is capped at `maxBytes`. Stream is aborted the
 *      moment the cap is crossed; no unbounded `res.arrayBuffer()`.
 *   5. Total wall-clock per attempt is capped at `timeoutMs`.
 *
 * This module is pure Node — it uses `node:dns`, `node:net`, and
 * the global `fetch` (Node 20+, undici under the hood). It does
 * NOT touch the DB or Redis.
 */
import { promises as dnsPromises, type LookupAddress } from 'node:dns';
import net from 'node:net';
import { URL } from 'node:url';

export interface SafeFetchOptions {
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  readonly maxRedirects?: number;
  readonly userAgent?: string;
  readonly method?: 'GET' | 'HEAD';
  readonly extraHeaders?: Readonly<Record<string, string>>;
}

export interface SafeFetchResponse {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: Buffer;
  readonly finalUrl: string;
}

const DEFAULT_OPTIONS = {
  timeoutMs: 10_000,
  maxBytes: 26_214_400, // 25 MiB
  maxRedirects: 5,
  // Phase 7.3 — stable identity. The `GboxCloneBot` token is what
  // sites match in robots.txt (see clone-pro/constants.ts
  // `CLONE_BOT_UA_TOKEN`); the `+URL` suffix is Google's convention
  // for "who owns this crawler". Keep this string in sync with
  // `CLONE_BOT_USER_AGENT` in clone-pro/constants.ts — duplicated
  // because clone-shopify has no dep on clone-pro (reverse would
  // create a cycle).
  userAgent: 'GboxCloneBot/4.0 (+https://gbox.co/bot)',
  method: 'GET' as const,
};

export class SafeFetchError extends Error {
  public readonly code: string;
  public constructor(code: string, message: string) {
    super(message);
    this.name = 'SafeFetchError';
    this.code = code;
  }
}

/**
 * Returns `true` if the IP (v4 or v6) is in a private, loopback,
 * link-local, multicast, or otherwise non-routable range. Anything
 * that returns true here is refused as a clone target.
 *
 * We cover:
 *  v4:  10/8, 172.16/12, 192.168/16, 127/8, 169.254/16, 100.64/10,
 *       0.0.0.0/8, 224/4 (multicast), 240/4 (reserved)
 *  v6:  ::1, fc00::/7, fe80::/10, ::ffff:0:0/96 (v4-mapped),
 *       ff00::/8 (multicast), ::/128 (unspecified)
 */
export function isPrivateOrReservedIp(ip: string): boolean {
  if (net.isIP(ip) === 0) return true; // garbage → refuse

  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map((p) => Number.parseInt(p, 10));
    if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return true;
    const [a, b] = parts as [number, number, number, number];
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;
    return false;
  }

  // IPv6
  const lower = ip.toLowerCase();
  if (lower === '::' || lower === '::1') return true;
  if (lower.startsWith('fe80:')) return true; // link-local
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // ULA fc00::/7
  if (lower.startsWith('ff')) return true; // multicast
  // v4-mapped: ::ffff:<v4>
  if (lower.startsWith('::ffff:')) {
    const v4 = lower.slice('::ffff:'.length);
    if (net.isIPv4(v4)) return isPrivateOrReservedIp(v4);
  }
  return false;
}

async function assertHostnameIsPublic(hostname: string): Promise<void> {
  // Literal IP URLs: check directly, no DNS.
  if (net.isIP(hostname) !== 0) {
    if (isPrivateOrReservedIp(hostname)) {
      throw new SafeFetchError(
        'ssrf_private_ip',
        `Refusing to fetch literal-IP URL pointing at private/reserved range: ${hostname}`,
      );
    }
    return;
  }

  // Reject obviously internal TLDs that might round-trip to mDNS.
  const lowered = hostname.toLowerCase();
  if (
    lowered === 'localhost' ||
    lowered.endsWith('.localhost') ||
    lowered.endsWith('.local') ||
    lowered.endsWith('.internal') ||
    lowered.endsWith('.lan') ||
    lowered.endsWith('.home') ||
    lowered.endsWith('.intranet')
  ) {
    throw new SafeFetchError(
      'ssrf_internal_tld',
      `Refusing to fetch hostname with internal TLD: ${hostname}`,
    );
  }

  // Resolve A + AAAA and verify every result is publicly routable.
  let addrs: LookupAddress[];
  try {
    addrs = await dnsPromises.lookup(hostname, { all: true, verbatim: true });
  } catch (err) {
    throw new SafeFetchError(
      'dns_failed',
      `DNS lookup failed for ${hostname}: ${(err as Error).message}`,
    );
  }
  if (addrs.length === 0) {
    throw new SafeFetchError('dns_empty', `DNS returned no addresses for ${hostname}`);
  }
  for (const a of addrs) {
    if (isPrivateOrReservedIp(a.address)) {
      throw new SafeFetchError(
        'ssrf_private_ip',
        `DNS for ${hostname} resolved to private/reserved IP ${a.address}; refusing to fetch.`,
      );
    }
  }
}

function assertScheme(url: URL): void {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SafeFetchError(
      'bad_scheme',
      `Refusing to fetch non-http(s) URL: ${url.toString()}`,
    );
  }
}

interface FetchOnceResult {
  readonly statusCode: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: Buffer;
}

async function fetchOnce(
  url: URL,
  options: Required<SafeFetchOptions>,
): Promise<FetchOnceResult> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new SafeFetchError('timeout', 'safeFetch wall-clock timeout')),
    options.timeoutMs,
  );

  try {
    const res = await fetch(url.toString(), {
      method: options.method,
      headers: {
        'user-agent': options.userAgent,
        accept: '*/*',
        ...options.extraHeaders,
      },
      // Follow redirects ourselves so each hop is re-checked against
      // the SSRF denylist.
      redirect: 'manual',
      signal: controller.signal,
    });

    const headers: Record<string, string | string[] | undefined> = {};
    res.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });

    if (options.method === 'HEAD') {
      return { statusCode: res.status, headers, body: Buffer.alloc(0) };
    }

    // Stream the body with a running byte counter so we can abort
    // the moment we cross the cap.
    if (!res.body) {
      return { statusCode: res.status, headers, body: Buffer.alloc(0) };
    }
    const reader = res.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value) continue;
        const buf = Buffer.from(value);
        total += buf.length;
        if (total > options.maxBytes) {
          try {
            await reader.cancel();
          } catch {
            /* ignore */
          }
          throw new SafeFetchError(
            'body_too_large',
            `Response body exceeded ${options.maxBytes} bytes`,
          );
        }
        chunks.push(buf);
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* ignore */
      }
    }
    return { statusCode: res.status, headers, body: Buffer.concat(chunks) };
  } catch (err) {
    // Re-throw SafeFetchError unchanged; translate AbortError into our typed code.
    if (err instanceof SafeFetchError) throw err;
    const e = err as Error & { name?: string; cause?: unknown };
    if (e?.name === 'AbortError') {
      const cause = e.cause;
      if (cause instanceof SafeFetchError) throw cause;
      throw new SafeFetchError('timeout', 'safeFetch wall-clock timeout');
    }
    throw new SafeFetchError('fetch_failed', `fetch failed: ${e?.message ?? String(err)}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * SSRF-safe fetch. Follows redirects manually, re-checking each
 * target. Returns the final URL so callers can resolve relative
 * links correctly.
 */
export async function safeFetch(
  rawUrl: string,
  userOptions: SafeFetchOptions = {},
): Promise<SafeFetchResponse> {
  const options: Required<SafeFetchOptions> = {
    ...DEFAULT_OPTIONS,
    extraHeaders: {},
    ...userOptions,
  };

  let current: URL;
  try {
    current = new URL(rawUrl);
  } catch {
    throw new SafeFetchError('bad_url', `Not a valid URL: ${rawUrl}`);
  }

  for (let hop = 0; hop <= options.maxRedirects; hop += 1) {
    assertScheme(current);
    await assertHostnameIsPublic(current.hostname);

    const { statusCode, headers, body } = await fetchOnce(current, options);
    const locationRaw = headers['location'];
    const location = Array.isArray(locationRaw) ? locationRaw[0] : locationRaw;

    const isRedirect =
      statusCode >= 300 &&
      statusCode < 400 &&
      typeof location === 'string' &&
      location.length > 0;

    if (!isRedirect) {
      return {
        statusCode,
        headers,
        body,
        finalUrl: current.toString(),
      };
    }

    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      throw new SafeFetchError(
        'bad_redirect',
        `Upstream redirect target is not a valid URL: ${location}`,
      );
    }
    current = next;
  }

  throw new SafeFetchError(
    'too_many_redirects',
    `Exceeded max redirects (${options.maxRedirects})`,
  );
}
