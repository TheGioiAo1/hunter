/**
 * Gbox Platform — Smoke Probe Helpers (Phase 6.5)
 *
 * Tiny pure-ish primitives the unified smoke orchestrator
 * (`scripts/ops/smoke-all.ts`) uses to check production endpoints.
 * Each probe returns a structured `ProbeResult` rather than throwing,
 * so the orchestrator can render a green/red table with one row per
 * check instead of bailing on the first failure.
 *
 * The actual HTTP/DB calls are injected via the `fetcher` argument so
 * the helpers stay unit-testable without spinning up real servers.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProbeResult {
  name: string
  ok: boolean
  /** Human-readable detail line shown next to the row in the report. */
  detail: string
  /** Wall-clock duration of the probe in milliseconds. */
  durationMs: number
}

export interface HttpProbeInput {
  name: string
  url: string
  /** Defaults to 200. */
  expectedStatus?: number
  /**
   * Optional substring that must appear in the response body. Useful
   * for catching "200 but the server is in a half-broken state and
   * returns the maintenance page" cases.
   */
  expectBodyContains?: string
  /** Defaults to 5000. */
  timeoutMs?: number
}

/** Minimal `fetch`-shaped function. Lets tests inject a stub. */
export type ProbeFetcher = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<{
  status: number
  text(): Promise<string>
}>

// ---------------------------------------------------------------------------
// httpProbe
// ---------------------------------------------------------------------------

/**
 * Checks an HTTP endpoint. Catches network errors, status mismatches,
 * and missing-needle failures into a single `ProbeResult` shape.
 */
export async function httpProbe(
  input: HttpProbeInput,
  fetcher: ProbeFetcher,
  clock: { now(): number } = Date,
): Promise<ProbeResult> {
  const expectedStatus = input.expectedStatus ?? 200
  const timeoutMs = input.timeoutMs ?? 5000
  const start = clock.now()

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const res = await fetcher(input.url, { signal: controller.signal })
    const body = await res.text()
    const durationMs = clock.now() - start

    if (res.status !== expectedStatus) {
      return {
        name: input.name,
        ok: false,
        detail: `${input.url} → ${res.status} (expected ${expectedStatus})`,
        durationMs,
      }
    }

    if (input.expectBodyContains && !body.includes(input.expectBodyContains)) {
      return {
        name: input.name,
        ok: false,
        detail: `${input.url} body missing "${input.expectBodyContains}"`,
        durationMs,
      }
    }

    return {
      name: input.name,
      ok: true,
      detail: `${input.url} → ${res.status} (${durationMs}ms)`,
      durationMs,
    }
  } catch (err) {
    const durationMs = clock.now() - start
    const msg = err instanceof Error ? err.message : String(err)
    return {
      name: input.name,
      ok: false,
      detail: `${input.url} → error: ${msg}`,
      durationMs,
    }
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// runProbes — sequential, no fail-fast
// ---------------------------------------------------------------------------

export interface RunProbesResult {
  results: ProbeResult[]
  passed: number
  failed: number
  totalDurationMs: number
}

/**
 * Runs an array of async probe thunks and aggregates the results.
 * Always runs every probe — never short-circuits on the first
 * failure — because a smoke run's job is to give the operator the
 * full picture in one pass.
 */
export async function runProbes(
  probes: Array<() => Promise<ProbeResult>>,
): Promise<RunProbesResult> {
  const results: ProbeResult[] = []
  let totalDurationMs = 0
  for (const probe of probes) {
    const result = await probe()
    results.push(result)
    totalDurationMs += result.durationMs
  }
  return {
    results,
    passed: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    totalDurationMs,
  }
}

// ---------------------------------------------------------------------------
// formatProbeReport — pretty terminal output
// ---------------------------------------------------------------------------

/**
 * Renders a result set as a plain-text table the orchestrator prints
 * to stdout. Kept here (not in the script) so the same format ships
 * to log aggregation jobs and integration tests can assert against
 * the rendered shape.
 */
export function formatProbeReport(result: RunProbesResult): string {
  const lines: string[] = []
  for (const r of result.results) {
    const icon = r.ok ? 'PASS' : 'FAIL'
    lines.push(`  [${icon}] ${r.name.padEnd(32, ' ')} ${r.detail}`)
  }
  lines.push('')
  lines.push(
    `  ${result.passed} passed, ${result.failed} failed (${result.totalDurationMs}ms total)`,
  )
  return lines.join('\n')
}
