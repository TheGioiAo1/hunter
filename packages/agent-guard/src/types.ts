/**
 * @gbox/agent-guard — public types.
 *
 * These interfaces are the contract between the guard chain and its
 * consumers (PR 3 agent-core, PR 4 agent-tools, PR 5 sidecar). Renaming
 * any field here breaks downstream packages — bump a minor version
 * and coordinate across packages instead.
 */

export type ToolCallTier = 1 | 2 | 3 | 4

export type DeployRisk = 'safe' | 'admin-only' | 'customer-facing'

export type TrafficLevel = 'peak' | 'normal' | 'low'

/** Single Claude Agent SDK tool invocation, pre-execution. */
export interface ToolCall {
  /** ulid — becomes audit_logs.tool_call_id. */
  id: string
  /** e.g. 'repo.edit', 'bash.run', 'deploy.run'. */
  name: string
  /** Tool-specific payload; guard layers treat as unknown and narrow per-layer. */
  input: unknown
  tier: ToolCallTier
}

/**
 * Per-session mutable state. Loaded from `agent_sessions` + in-memory
 * counters by the sidecar (PR 5) and passed into the guard chain on
 * every tool call. Guard layers MUST NOT mutate this — mutations happen
 * in the sidecar after the chain returns.
 */
export interface SessionContext {
  sessionId: string
  godAdminId: string
  toolCallCount: number
  /** Epoch-ms timestamps of the last ≤20 tier-3 calls. */
  tier3CallsLast5Min: number[]
  /** Absolute file path → consecutive `repo.edit` failure count. */
  consecutiveEditFailures: Map<string, number>
  bashInFlight: boolean
  circuitBreakerOpen: boolean
  trafficLevel: TrafficLevel
  /** Injected so tests don't depend on wall-clock Date.now(). */
  currentTime: Date
  /** Absolute path to gbox-platform checkout. */
  repoRoot: string
  /** Other whitelisted repo roots (absolute). e.g. gbox-emdash-admin. */
  crossRepoRoots: string[]
}

export type GuardResult =
  | { allowed: true }
  | { allowed: false; layer: string; reason: string }

export interface GuardLayer {
  /** Stable layer identifier — persisted to audit_logs.guard_layer. */
  name: string
  check(call: ToolCall, ctx: SessionContext): Promise<GuardResult>
}

/**
 * Thrown by the sidecar after the chain returns a rejecting result.
 * Layers themselves do NOT throw — they return `{ allowed: false, ... }`.
 */
export class GuardRejection extends Error {
  constructor(
    public readonly layer: string,
    public readonly reason: string,
  ) {
    super(`[${layer}] ${reason}`)
    this.name = 'GuardRejection'
  }
}
