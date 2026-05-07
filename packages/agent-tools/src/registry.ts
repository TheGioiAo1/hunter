/**
 * Tool registry — the single place the sidecar looks up a tool by
 * name and dispatches an invocation.
 *
 * Flow:
 *  1. Resolve the tool by name.
 *  2. Parse the raw input via the tool's parseInput.
 *  3. Build a ToolCall shape and call the composed guard chain via
 *     guard.check(call, ctx). For tier-3 calls the approval-gate
 *     layer inside the composed chain awaits the human decision via
 *     an EventEmitter owned by the sidecar — dispatch() does NOT
 *     need to handle "needs_approval" separately, because the chain
 *     has already awaited.
 *  4. If guard denies → return a `blocked` result the sidecar turns
 *     into a `tool_guard_rejected` SseEvent.
 *  5. If guard allows → invoke tool.run(input, deps) and map the
 *     result to DispatchResult.
 */

import type {
  GuardLayer,
  SessionContext,
  ToolCall,
} from '@gbox/agent-guard'
import type { ToolDef, ToolResult } from './types.ts'

// ---------------------------------------------------------------------------
// Dispatch result
// ---------------------------------------------------------------------------

export type DispatchResult =
  | { kind: 'ok'; data: unknown }
  | { kind: 'error'; message: string; code?: string }
  | { kind: 'blocked'; layer: string; reason: string }
  | { kind: 'unknown_tool'; name: string }

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export interface ToolRegistry<TDeps> {
  list(): ToolDef<any, TDeps>[]
  get(name: string): ToolDef<any, TDeps> | undefined
  dispatch(args: DispatchArgs<TDeps>): Promise<DispatchResult>
}

export interface DispatchArgs<TDeps> {
  /** Raw tool call from the model. */
  call: ToolCall
  /** Session context the guard chain uses. */
  sessionContext: SessionContext
  /** Injected per-boot dependencies (db, fs, git, etc.). */
  deps: TDeps
  /** The composed guard chain from @gbox/agent-guard. */
  guard: GuardLayer
}

export function createRegistry<TDeps>(
  tools: readonly ToolDef<any, TDeps>[],
): ToolRegistry<TDeps> {
  const byName = new Map<string, ToolDef<any, TDeps>>()
  for (const tool of tools) {
    if (byName.has(tool.name)) {
      throw new Error(`duplicate tool name in registry: ${tool.name}`)
    }
    byName.set(tool.name, tool)
  }

  return {
    list() {
      return [...byName.values()]
    },
    get(name) {
      return byName.get(name)
    },
    async dispatch({ call, sessionContext, deps, guard }): Promise<DispatchResult> {
      const tool = byName.get(call.name)
      if (!tool) {
        return { kind: 'unknown_tool', name: call.name }
      }

      // Tier from registry overrides whatever the model supplied —
      // the model can't escalate to a higher tier by lying in its
      // tool_use payload.
      const enforcedCall: ToolCall = { ...call, tier: tool.tier }

      // 1. Input parsing
      let parsed: unknown
      try {
        parsed = tool.parseInput(enforcedCall.input)
      } catch (err) {
        return {
          kind: 'error',
          message: (err as Error).message,
          code: 'invalid_input',
        }
      }

      // 2. Guard chain — the composed chain's `check` returns
      //    { allowed: true } or { allowed: false, layer, reason }.
      //    For tier-3 calls the approval-gate layer awaits the human
      //    decision before resolving, so by the time we see the
      //    result the human has either approved or denied.
      const guardResult = await guard.check(
        { ...enforcedCall, input: parsed },
        sessionContext,
      )
      if (!guardResult.allowed) {
        return {
          kind: 'blocked',
          layer: guardResult.layer,
          reason: guardResult.reason,
        }
      }

      // 3. Handler
      const handlerResult = await tool.run(parsed, deps)
      return mapToolResult(handlerResult)
    },
  }
}

function mapToolResult(r: ToolResult): DispatchResult {
  switch (r.kind) {
    case 'ok':
      return { kind: 'ok', data: r.data }
    case 'error':
      return { kind: 'error', message: r.message, code: r.code }
    case 'needs_approval':
      // A tool that returns `needs_approval` from its handler is a
      // "post-guard soft block" — the tool itself decided mid-run
      // that it wants human review. We map it to `blocked` under a
      // synthetic layer name so the sidecar can surface it to the UI
      // the same way as a real guard denial.
      return {
        kind: 'blocked',
        layer: 'tool-self',
        reason: r.reason,
      }
  }
}
