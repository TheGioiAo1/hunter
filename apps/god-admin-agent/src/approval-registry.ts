/**
 * ApprovalRegistry — session-scoped in-memory approval tracker.
 *
 * Bridges the existing `packages/agent-guard/src/approval-gate.ts`
 * (which owns the `resolveApproval(toolCallId, decision)` semantics)
 * and the new HTTP `POST /agent/approval` endpoint.
 *
 * Why a sidecar-level registry rather than reaching directly into
 * the approval gate?
 *  1. The gate instance lives inside the guard chain, which today is
 *     NOT yet wired into `createAgentRuntime()`. The registry gives us
 *     a stable surface the approval HTTP route can depend on TODAY
 *     without blocking on the guard-chain integration PR.
 *  2. When the guard chain does get wired, the registry's hooks
 *     (`register` + `resolve`) are trivial to connect to the real
 *     `ApprovalGate` — same shape.
 *  3. The registry also hosts the approval timeout so resolutions
 *     arriving after the chat turn has already emitted `done` can
 *     still be cleanly reported (or swallowed) without leaking timers.
 *
 * The registry is created once in `buildApp()` and shared across all
 * routes that need it: chat route (to register a pending approval
 * when it forwards `approval_required` downstream) and approval
 * route (to resolve it).
 */

export type ApprovalDecision = 'approved' | 'denied'

export interface PendingApproval {
  aid: string
  toolCallId: string
  /** Wall-clock ms when this pending approval was registered. */
  registeredAt: number
  /**
   * Called once a decision arrives. The callback is what forwards the
   * `approval_resolved` SSE event back to the chat stream AND what
   * unblocks the real guard gate in the eventual wired version.
   */
  onResolve: (decision: ApprovalDecision | 'timeout') => void
  /** Node timer handle for the timeout — kept so we can clear it on resolve. */
  timer: ReturnType<typeof setTimeout>
}

export interface ApprovalRegistry {
  /**
   * Register a new pending approval. Returns a disposer that cancels
   * the timeout + unregisters WITHOUT calling `onResolve` — used when
   * the chat turn ends (SSE stream closed) before the human acts.
   */
  register(
    aid: string,
    toolCallId: string,
    onResolve: (decision: ApprovalDecision | 'timeout') => void,
    timeoutMs?: number,
  ): () => void

  /**
   * Resolve a pending approval by (aid, toolCallId). Returns true if a
   * pending entry existed + was resolved, false otherwise (already
   * resolved, timed out, or unknown). The HTTP route uses the return
   * value to decide between 200 and 404.
   */
  resolve(aid: string, toolCallId: string, decision: ApprovalDecision): boolean

  /** Test helper — current open-approval count. */
  size(): number
}

const DEFAULT_TIMEOUT_MS = 120_000

export function createApprovalRegistry(): ApprovalRegistry {
  const pending = new Map<string, PendingApproval>()

  function key(aid: string, toolCallId: string): string {
    return `${aid}::${toolCallId}`
  }

  return {
    register(aid, toolCallId, onResolve, timeoutMs = DEFAULT_TIMEOUT_MS) {
      const k = key(aid, toolCallId)
      // Defensive: drop any previous entry for the same (aid, tool_call_id)
      // pair. Shouldn't happen under normal flow but we never want two
      // live timers racing to resolve the same approval.
      const existing = pending.get(k)
      if (existing) {
        clearTimeout(existing.timer)
        pending.delete(k)
      }

      const timer = setTimeout(() => {
        const entry = pending.get(k)
        if (!entry) return
        pending.delete(k)
        entry.onResolve('timeout')
      }, timeoutMs)
      if (typeof timer.unref === 'function') timer.unref()

      pending.set(k, {
        aid,
        toolCallId,
        registeredAt: Date.now(),
        onResolve,
        timer,
      })

      return function dispose() {
        const entry = pending.get(k)
        if (!entry) return
        clearTimeout(entry.timer)
        pending.delete(k)
      }
    },

    resolve(aid, toolCallId, decision) {
      const k = key(aid, toolCallId)
      const entry = pending.get(k)
      if (!entry) return false
      clearTimeout(entry.timer)
      pending.delete(k)
      entry.onResolve(decision)
      return true
    },

    size() {
      return pending.size
    },
  }
}
