/**
 * composeGuards — sequential runner with first-rejection short-circuit.
 *
 * The returned layer has name='compose' so tests can assert on the
 * composition wrapper specifically. Rejection results always carry
 * the inner (rejecting) layer's name in their `layer` field — that's
 * what gets written to audit_logs.guard_layer.
 */

import { EventEmitter } from 'node:events'
import type { GuardLayer, GuardResult, SessionContext, ToolCall } from './types.ts'
import { pathWhitelist } from './path-whitelist.ts'
import { commandParser } from './command-parser.ts'
import { blocklist } from './blocklist.ts'
import { resourceLimits } from './resource-limits.ts'
import { rateLimit } from './rate-limit.ts'
import { createApprovalGate, type ApprovalGate } from './approval-gate.ts'
import { deploymentSafety } from './deployment-safety.ts'

export function composeGuards(layers: GuardLayer[]): GuardLayer {
  return {
    name: 'compose',
    async check(call: ToolCall, ctx: SessionContext): Promise<GuardResult> {
      for (const layer of layers) {
        const result = await layer.check(call, ctx)
        if (!result.allowed) return result
      }
      return { allowed: true }
    },
  }
}

export interface DefaultGuardChainOptions {
  /** Shared emitter for approval_required events (caller supplies if they want to listen). */
  approvalEmitter?: EventEmitter
  /** Override the 120s approval timeout (testing). */
  approvalTimeoutMs?: number
}

export interface DefaultGuardChain {
  chain: GuardLayer
  approvalGate: ApprovalGate
  approvalEmitter: EventEmitter
}

/**
 * Canonical 7-layer guard chain used by PR 5 sidecar. Order matters:
 *   path-whitelist → command-parser → blocklist → resource-limits
 *   → rate-limit → deployment-safety → approval-gate
 *
 * Approval-gate is LAST so denials/timeouts aren't wasted on calls
 * that would fail an earlier pure check.
 */
export function defaultGuardChain(opts: DefaultGuardChainOptions = {}): DefaultGuardChain {
  const approvalEmitter = opts.approvalEmitter ?? new EventEmitter()
  const approvalGate = createApprovalGate(approvalEmitter, {
    timeoutMs: opts.approvalTimeoutMs,
  })
  const chain = composeGuards([
    pathWhitelist,
    commandParser,
    blocklist,
    resourceLimits,
    rateLimit,
    deploymentSafety,
    approvalGate,
  ])
  return { chain, approvalGate, approvalEmitter }
}
