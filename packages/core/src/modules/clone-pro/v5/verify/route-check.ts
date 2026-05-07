/**
 * Clone Pro v5 — route-check verifier
 *
 * Fires HEAD requests against every imported URL (on preview subdomain).
 * Reports pass count + failure details. Used by grader for
 * route_check_pct (40% of composite grade).
 */

export interface RouteCheckOpts {
  readonly fetch?: typeof globalThis.fetch
  readonly timeoutMs?: number
  readonly concurrency?: number
}

export interface RouteCheckResult {
  readonly total: number
  readonly passCount: number
  readonly passRate: number    // 0..1
  readonly failures: readonly { url: string; reason: string }[]
}

export async function routeCheck(
  urls: readonly string[],
  opts: RouteCheckOpts = {},
): Promise<RouteCheckResult> {
  const fetchFn = opts.fetch ?? globalThis.fetch
  const concurrency = opts.concurrency ?? 10
  const timeoutMs = opts.timeoutMs ?? 5000
  const failures: { url: string; reason: string }[] = []
  let passCount = 0

  async function check(url: string): Promise<void> {
    try {
      const ctrl = new AbortController()
      const t = setTimeout(() => ctrl.abort(), timeoutMs)
      const res = await fetchFn(url, { method: 'HEAD', signal: ctrl.signal })
      clearTimeout(t)
      if (res.ok) passCount++
      else failures.push({ url, reason: `HTTP ${res.status}` })
    } catch (e) {
      failures.push({ url, reason: (e as Error).message })
    }
  }

  for (let i = 0; i < urls.length; i += concurrency) {
    const batch = urls.slice(i, i + concurrency)
    await Promise.all(batch.map(check))
  }

  return {
    total: urls.length,
    passCount,
    passRate: urls.length > 0 ? passCount / urls.length : 0,
    failures,
  }
}
