/**
 * @gbox/agent-core — locked public types
 *
 * Phase 9.1. These types are the contract between the sidecar
 * (apps/god-admin-agent), the chat UI (apps/god-admin), and the
 * agent runtime. Renaming anything here is a breaking change to
 * the wire format for the SSE stream.
 *
 * Full design: docs/superpowers/specs/2026-04-09-phase-9-1-9-2-pair-programmer-design.md §6
 */

// ---------------------------------------------------------------------------
// Chat message (persisted in agent_sessions.conversation JSONB)
// ---------------------------------------------------------------------------

export type ChatRole = 'user' | 'assistant' | 'system' | 'tool'

export interface ChatMessage {
  /** Monotonic per-session index starting at 0. */
  seq: number
  role: ChatRole
  /** Plain text content. For tool messages this is the JSON-stringified result. */
  content: string
  /** ISO timestamp (ms precision). */
  createdAt: string
  /** Populated when role === 'tool'. */
  toolCallId?: string
  /** Populated when role === 'tool'. */
  toolName?: string
  /** Token counts from the model response (assistant messages only). */
  inputTokens?: number
  outputTokens?: number
}

// ---------------------------------------------------------------------------
// Compaction result (spec §6.2)
// ---------------------------------------------------------------------------

export interface CompactResult {
  /** Number of original messages folded into the summary. */
  foldedCount: number
  /** Tail messages kept verbatim (most-recent turns). */
  preservedTail: ChatMessage[]
  /** Model-generated summary of the folded prefix. */
  summary: string
  /** Token count of the resulting compacted context. */
  tokensAfter: number
  /** Token count BEFORE compaction ran. */
  tokensBefore: number
}

// ---------------------------------------------------------------------------
// SSE wire format (locked — UI depends on exact field names)
// ---------------------------------------------------------------------------

export type SseEvent =
  | { type: 'assistant_delta'; text: string }
  | { type: 'tool_use'; toolCallId: string; name: string; input: unknown }
  | { type: 'tool_guard_rejected'; toolCallId: string; layer: string; reason: string }
  | { type: 'approval_required'; toolCallId: string; name: string; normalizedInput: unknown }
  | { type: 'approval_resolved'; toolCallId: string; decision: 'approved' | 'denied' | 'timeout' }
  | { type: 'tool_result'; toolCallId: string; output: unknown }
  | { type: 'compact_triggered'; tokensBeforeCompact: number; tokensAfterCompact: number }
  | { type: 'circuit_breaker'; state: 'open' | 'closed' }
  | { type: 'done' }
  | { type: 'error'; message: string; code?: string }

// ---------------------------------------------------------------------------
// Internal JWT claims (dashboard ↔ sidecar)
// ---------------------------------------------------------------------------
//
// sid = dashboard session id (the cookie session that authenticated
//       the human at apps/god-admin)
// aid = agent session id (the row in agent_sessions this message is
//       appended to)

export interface InternalJwtClaims {
  sub: 'god_admin_default'
  sid: string
  aid: string
  iat: number
  exp: number
}

// ---------------------------------------------------------------------------
// Agent runtime contract
// ---------------------------------------------------------------------------
//
// The runtime is an abstraction over @anthropic-ai/claude-agent-sdk so
// tests can mock it without loading the real SDK.

export interface AgentRuntimeSendOptions {
  /** Abort signal for the caller to cancel mid-stream. */
  signal?: AbortSignal
  /** Called for every SSE event emitted by the agent. */
  onEvent: (event: SseEvent) => void | Promise<void>
}

export interface AgentRuntime {
  /**
   * Send a user message into an existing agent session and stream
   * events back via onEvent. Resolves when the turn completes.
   * Throws AbortError if the signal fires.
   */
  sendMessage(
    aid: string,
    userText: string,
    opts: AgentRuntimeSendOptions,
  ): Promise<void>

  /**
   * Force-abort any in-flight turn for this aid. Safe to call
   * repeatedly; no-op if nothing is running.
   */
  abort(aid: string): void
}
