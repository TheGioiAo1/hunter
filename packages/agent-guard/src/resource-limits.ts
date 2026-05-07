/**
 * Layer 3 — Resource limits.
 *
 * Enforces `max_concurrent_bash: 1` by rejecting when ctx.bashInFlight
 * is true. Also exports wrapBashCommand() so the sidecar can wrap the
 * parsed command with ulimit/nice/timeout before spawning a child.
 * This layer does NOT execute anything itself.
 */

import { isAbsolute } from 'node:path'
import type { GuardLayer, GuardResult, SessionContext, ToolCall } from './types.ts'

const NAME = 'resource-limits'

const MEMORY_KB = 2 * 1024 * 1024 // 2 GB virtual memory (ulimit -v uses KB)
const TIMEOUT_SEC = 300
const KILL_GRACE_SEC = 5
const NICE = 10

/**
 * Build the wrapper command the sidecar will actually spawn. The
 * inner command runs inside `bash -c "<escaped>"` so multi-statement
 * pipelines survive intact.
 */
export function wrapBashCommand(inner: string, cwd: string): string {
  if (!isAbsolute(cwd)) {
    throw new Error(`resource-limits: cwd must be absolute, got ${cwd}`)
  }
  const escaped = inner.replace(/"/g, '\\"')
  return (
    `ulimit -v ${MEMORY_KB} && ` +
    `cd "${cwd}" && ` +
    `nice -n ${NICE} ` +
    `timeout --kill-after=${KILL_GRACE_SEC}s ${TIMEOUT_SEC}s ` +
    `bash -c "${escaped}"`
  )
}

interface BashInput {
  command?: unknown
}

export const resourceLimits: GuardLayer = {
  name: NAME,
  async check(call: ToolCall, ctx: SessionContext): Promise<GuardResult> {
    if (call.name !== 'bash.run') return { allowed: true }

    const input = call.input as BashInput | null
    if (!input || typeof input.command !== 'string') {
      return { allowed: false, layer: NAME, reason: 'bash.run command must be a string' }
    }

    if (!isAbsolute(ctx.repoRoot)) {
      return {
        allowed: false,
        layer: NAME,
        reason: `repoRoot must be absolute (got ${ctx.repoRoot})`,
      }
    }

    if (ctx.bashInFlight) {
      return { allowed: false, layer: NAME, reason: 'another concurrent bash.run is in flight' }
    }

    return { allowed: true }
  },
}
