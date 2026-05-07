/**
 * Layer 5 — Approval gate.
 *
 * Tier-3 calls pause the chain, emit an `approval_required` event on a
 * shared EventEmitter, and await either an explicit resolveApproval()
 * call or a timeout. Tier-1/2 pass through. Tier-4 is blocked outright
 * (disabled for Phase 9.2).
 *
 * The gate is created via factory so a single instance + EventEmitter
 * is shared across the session — the sidecar wires its UI event stream
 * to the same emitter.
 */

import type { EventEmitter } from 'node:events'
import type { GuardLayer, GuardResult, SessionContext, ToolCall } from './types.ts'

const NAME = 'approval-gate'

export interface ApprovalEvent {
  toolCallId: string
  name: string
  normalizedInput: unknown
  doubleConfirm: boolean
}

export type ApprovalDecision = 'approved' | 'denied'

export interface ApprovalGateOptions {
  timeoutMs?: number
}

export interface ApprovalGate extends GuardLayer {
  resolveApproval(toolCallId: string, decision: ApprovalDecision): void
}

const DEFAULT_TIMEOUT_MS = 120_000

interface PendingApproval {
  resolve: (result: GuardResult) => void
  timer: ReturnType<typeof setTimeout>
}

export function createApprovalGate(
  emitter: EventEmitter,
  opts: ApprovalGateOptions = {},
): ApprovalGate {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const pending = new Map<string, PendingApproval>()

  function isGitPushToMain(call: ToolCall): boolean {
    if (call.name !== 'git.push') return false
    const inp = call.input as { branch?: unknown } | null
    return inp?.branch === 'main'
  }

  return {
    name: NAME,

    async check(call: ToolCall, _ctx: SessionContext): Promise<GuardResult> {
      if (call.tier === 4) {
        return {
          allowed: false,
          layer: NAME,
          reason: 'tier-4 (destructive) tools are disabled in Phase 9.2',
        }
      }
      if (call.tier === 1 || call.tier === 2) {
        return { allowed: true }
      }

      // Tier 3 — emit and await.
      const event: ApprovalEvent = {
        toolCallId: call.id,
        name: call.name,
        normalizedInput: call.input,
        doubleConfirm: isGitPushToMain(call),
      }

      return await new Promise<GuardResult>((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(call.id)
          resolve({
            allowed: false,
            layer: NAME,
            reason: `approval timeout after ${timeoutMs}ms`,
          })
        }, timeoutMs)

        pending.set(call.id, { resolve, timer })
        emitter.emit('approval_required', event)
      })
    },

    resolveApproval(toolCallId: string, decision: ApprovalDecision) {
      const entry = pending.get(toolCallId)
      if (!entry) return
      clearTimeout(entry.timer)
      pending.delete(toolCallId)
      if (decision === 'approved') {
        entry.resolve({ allowed: true })
      } else {
        entry.resolve({
          allowed: false,
          layer: NAME,
          reason: 'denied by god admin in approval modal',
        })
      }
    },
  }
}
