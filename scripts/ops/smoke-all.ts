/**
 * Gbox Platform — Unified Smoke Test Orchestrator (Phase 6.5)
 *
 * Runs every "is the production stack actually serving?" probe in
 * one pass and prints a green/red summary table. Designed to be the
 * last thing the deploy runbook runs before declaring a release
 * "done", and the first thing the on-call rotation runs when a
 * customer says "the site is down".
 *
 * What it checks (each row in the report):
 *
 *   [api]        GET  http://<host>:4321/_health           200 + status:ok
 *   [admin]      GET  http://<host>:4325/_health           200 + status:ok
 *   [accounts]   GET  http://<host>:4323/_health           200 + status:ok
 *   [storefront] GET  http://<host>:4326/_health           200 + status:ok
 *   [checkout]   GET  http://<host>:4327/_health           200 + status:ok
 *   [supporter]  GET  http://<host>:4328/healthz           200 + "ok"
 *   [pg]         SELECT 1                                  no error
 *   [redis]      PING                                      → PONG
 *
 * Anything else (the per-step `smoke-*.ts` scripts in `scripts/`)
 * stays as-is — those exercise specific features and are too slow to
 * run on every deploy. This orchestrator is the fast cardio check.
 *
 * Run from the repo root:
 *
 *   pnpm tsx scripts/ops/smoke-all.ts
 *   API_HOST=192.168.1.13 pnpm tsx scripts/ops/smoke-all.ts
 *
 * Exit codes: 0 = all green, 1 = at least one failure.
 */

import {
  httpProbe,
  runProbes,
  formatProbeReport,
  type ProbeResult,
  type ProbeFetcher,
} from '@gbox/core/modules/ops/smoke-probes.js'

const HOST = process.env.SMOKE_HOST ?? '127.0.0.1'
const API_PORT = process.env.SMOKE_API_PORT ?? '4321'
const ADMIN_PORT = process.env.SMOKE_ADMIN_PORT ?? '4325'
const ACCOUNTS_PORT = process.env.SMOKE_ACCOUNTS_PORT ?? '4323'
const STOREFRONT_PORT = process.env.SMOKE_STOREFRONT_PORT ?? '4326'
const CHECKOUT_PORT = process.env.SMOKE_CHECKOUT_PORT ?? '4327'
const SUPPORTER_PORT = process.env.SMOKE_SUPPORTER_PORT ?? '4328'

// Wrap global fetch into our injected-shape signature so the same
// helpers used in unit tests work here unchanged.
const fetcher: ProbeFetcher = async (url, init) => {
  const res = await fetch(url, init)
  return {
    status: res.status,
    text: () => res.text(),
  }
}

function url(port: string, path: string): string {
  return `http://${HOST}:${port}${path}`
}

// ---------------------------------------------------------------------------
// Database + Redis probes (separate from HTTP because they don't go through fetch)
// ---------------------------------------------------------------------------

async function probePostgres(): Promise<ProbeResult> {
  const start = Date.now()
  try {
    // Lazy import so the script can run on a box that has no
    // node_modules yet (e.g. for an inventory check).
    const { createDb } = await import('@gbox/db')
    const db = createDb()
    try {
      await db.selectFrom('shops').select('id').limit(1).execute()
      return {
        name: 'pg',
        ok: true,
        detail: `select from shops ok (${Date.now() - start}ms)`,
        durationMs: Date.now() - start,
      }
    } finally {
      await db.destroy()
    }
  } catch (err) {
    return {
      name: 'pg',
      ok: false,
      detail: `error: ${err instanceof Error ? err.message : String(err)}`,
      durationMs: Date.now() - start,
    }
  }
}

async function probeRedis(): Promise<ProbeResult> {
  const start = Date.now()
  try {
    const { getRedis, closeRedis } = await import(
      '@gbox/core/modules/cache/redis.js'
    )
    try {
      const redis = getRedis()
      const pong = await redis.ping()
      return {
        name: 'redis',
        ok: pong === 'PONG',
        detail: `ping → ${pong} (${Date.now() - start}ms)`,
        durationMs: Date.now() - start,
      }
    } finally {
      await closeRedis()
    }
  } catch (err) {
    return {
      name: 'redis',
      ok: false,
      detail: `error: ${err instanceof Error ? err.message : String(err)}`,
      durationMs: Date.now() - start,
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`== gbox smoke ==`)
  console.log(`host: ${HOST}`)
  console.log('')

  const result = await runProbes([
    () =>
      httpProbe(
        {
          name: 'api',
          url: url(API_PORT, '/_health'),
          expectBodyContains: '"status"',
        },
        fetcher,
      ),
    () =>
      httpProbe(
        {
          name: 'admin',
          url: url(ADMIN_PORT, '/_health'),
          expectBodyContains: '"status"',
        },
        fetcher,
      ),
    () =>
      httpProbe(
        {
          name: 'accounts',
          url: url(ACCOUNTS_PORT, '/_health'),
          expectBodyContains: '"status"',
        },
        fetcher,
      ),
    () =>
      httpProbe(
        {
          name: 'storefront',
          url: url(STOREFRONT_PORT, '/_health'),
          expectBodyContains: '"status"',
        },
        fetcher,
      ),
    () =>
      httpProbe(
        {
          name: 'checkout',
          url: url(CHECKOUT_PORT, '/_health'),
          expectBodyContains: '"status"',
        },
        fetcher,
      ),
    // Phase 12.5 PR6 — supporter.gbox.co staff portal (Astro SSR).
    // Uses /healthz endpoint returning "ok" (matches the nginx template
    // in scripts/deploy/nginx-server1.conf.template). Default-skip this
    // probe when SMOKE_SKIP_SUPPORTER=1 so legacy deploys don't trip.
    ...(process.env.SMOKE_SKIP_SUPPORTER === '1'
      ? []
      : [
          () =>
            httpProbe(
              {
                name: 'supporter',
                url: url(SUPPORTER_PORT, '/healthz'),
                expectBodyContains: 'ok',
              },
              fetcher,
            ),
        ]),
    () => probePostgres(),
    () => probeRedis(),
  ])

  console.log(formatProbeReport(result))

  if (result.failed > 0) {
    process.exit(1)
  }
  process.exit(0)
}

main().catch((err) => {
  console.error('SMOKE ORCHESTRATOR CRASHED:', err)
  process.exit(2)
})
