/**
 * ops.health — probe the 3 service HTTP health endpoints (storefront,
 * api, god-admin) and return their status + latency.
 *
 * Tier 2. Uses fetch (Node 20+). Each URL is probed with a 5s
 * timeout. Returns structured results instead of throwing so the
 * model can reason over partial failures.
 */

import type { ToolDef, ToolResult } from '../types.ts'

export interface OpsHealthInput {
  /** Override the default service list (tests use this). */
  targets?: Array<{ name: string; url: string }>
}

export interface OpsHealthDeps {
  /** Injected fetch for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch
  /** Default target list (per infra_topology.md). */
  defaultTargets?: Array<{ name: string; url: string }>
}

const BUILTIN_TARGETS: ReadonlyArray<{ name: string; url: string }> = [
  { name: 'storefront', url: 'http://192.168.1.19:4321/_health' },
  { name: 'api', url: 'http://192.168.1.30:4321/_health' },
  { name: 'god-admin', url: 'http://192.168.1.13:4324/_health' },
]

const TIMEOUT_MS = 5000

function parseInput(raw: unknown): OpsHealthInput {
  if (raw !== null && raw !== undefined && typeof raw !== 'object') {
    throw new Error('ops.health: input must be an object or omitted')
  }
  const r = (raw ?? {}) as Record<string, unknown>
  if (r.targets !== undefined) {
    if (!Array.isArray(r.targets)) throw new Error('ops.health: targets must be an array')
    const parsed = r.targets.map((t, i) => {
      if (!t || typeof t !== 'object') throw new Error(`ops.health: targets[${i}] must be an object`)
      const tr = t as Record<string, unknown>
      if (typeof tr.name !== 'string' || typeof tr.url !== 'string') {
        throw new Error(`ops.health: targets[${i}] needs name + url strings`)
      }
      return { name: tr.name, url: tr.url }
    })
    return { targets: parsed }
  }
  return {}
}

async function probeOne(
  target: { name: string; url: string },
  fetchImpl: typeof fetch,
): Promise<{
  name: string
  url: string
  ok: boolean
  status: number | null
  latencyMs: number
  error?: string
}> {
  const start = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetchImpl(target.url, { signal: controller.signal })
    return {
      name: target.name,
      url: target.url,
      ok: res.ok,
      status: res.status,
      latencyMs: Date.now() - start,
    }
  } catch (err) {
    return {
      name: target.name,
      url: target.url,
      ok: false,
      status: null,
      latencyMs: Date.now() - start,
      error: (err as Error).message,
    }
  } finally {
    clearTimeout(timer)
  }
}

async function run(input: OpsHealthInput, deps: OpsHealthDeps): Promise<ToolResult> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const targets = input.targets ?? deps.defaultTargets ?? BUILTIN_TARGETS
  const results = await Promise.all(targets.map((t) => probeOne(t, fetchImpl)))

  const allHealthy = results.every((r) => r.ok)
  return {
    kind: 'ok',
    data: {
      allHealthy,
      results,
    },
  }
}

export const opsHealthTool: ToolDef<OpsHealthInput, OpsHealthDeps> = {
  name: 'ops.health',
  tier: 2,
  description: 'Probe the 3 service /_health endpoints and report status + latency.',
  parseInput,
  run,
}
