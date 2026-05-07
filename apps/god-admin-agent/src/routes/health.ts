/**
 * GET /_health — cheap liveness endpoint.
 *
 * Reports: port, uptime, circuit-breaker state, killswitch state,
 * current prompt hash. Consumed by:
 *  - nginx upstream health checks
 *  - apps/god-admin's AgentHealthCard (PR 9)
 *  - ops.health tool (packages/agent-tools/src/tier2/ops-health.ts)
 *
 * No auth — the sidecar binds to 127.0.0.1, so this is only reachable
 * locally or via the nginx proxy on server 1.
 */

import type { Request, Response } from 'express'
import type { CircuitBreaker } from '../circuit-breaker.ts'
import type { Killswitch } from '../killswitch.ts'
import type { PromptWatcher } from '../prompt-watcher.ts'

export interface HealthDeps {
  startedAt: Date
  circuitBreaker: CircuitBreaker
  killswitch: Killswitch
  promptWatcher: PromptWatcher
  port: number
}

export function createHealthRoute(deps: HealthDeps) {
  return function healthRoute(_req: Request, res: Response): void {
    const now = Date.now()
    const cb = deps.circuitBreaker.snapshot()
    const prompt = deps.promptWatcher.current()

    res.json({
      status: 'ok',
      port: deps.port,
      uptimeMs: now - deps.startedAt.getTime(),
      startedAt: deps.startedAt.toISOString(),
      killswitch: { engaged: deps.killswitch.isEngaged() },
      circuitBreaker: cb,
      prompt: {
        hash: prompt.hash,
        loadedAt: prompt.loadedAt.toISOString(),
      },
    })
  }
}
