/**
 * Shared tool contract for @gbox/agent-tools.
 *
 * Every tool implementation exports a `ToolDef` — the registry maps
 * the tool name to this def, and the sidecar dispatches tool calls
 * by name.
 *
 * The separation between ToolDef and the actual handler closure lets
 * us:
 *   - Declare tier / name / description statically for prompt
 *     composition without loading the handler.
 *   - Inject runtime dependencies (db, fs, git) per-sidecar boot via
 *     the `deps` closure. Tests pass fakes; prod passes real Kysely,
 *     simple-git, etc.
 */

import type { ToolCallTier } from '@gbox/agent-guard'

// ---------------------------------------------------------------------------
// ToolResult — discriminated union every tool returns
// ---------------------------------------------------------------------------

export type ToolResult =
  | { kind: 'ok'; data: unknown }
  | { kind: 'error'; message: string; code?: string }
  | { kind: 'needs_approval'; normalizedInput: unknown; reason: string }

// ---------------------------------------------------------------------------
// ToolDef — static + dynamic parts of a tool
// ---------------------------------------------------------------------------

export interface ToolDef<TInput = unknown, TDeps = unknown> {
  /** Canonical dotted name, e.g. 'repo.read'. */
  name: string
  /** Which guard tier this tool belongs to. */
  tier: ToolCallTier
  /** One-line description shown in the system prompt tool catalog. */
  description: string
  /**
   * Zod-ish input validator — we keep it as a plain function so this
   * package doesn't take a hard dep on zod. Returns the parsed input
   * or throws a readable error.
   */
  parseInput(raw: unknown): TInput
  /**
   * Execute the tool. The dispatcher has ALREADY run the guard chain
   * before calling this — tools must not re-implement path checks /
   * rate limits / etc. Tools MAY return `needs_approval` when their
   * internal logic decides a specific instance should be blocked
   * (e.g. repo.edit on a file the user hasn't ACKed this session).
   */
  run(input: TInput, deps: TDeps): Promise<ToolResult>
}
