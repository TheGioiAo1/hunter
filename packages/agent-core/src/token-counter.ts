/**
 * Rough token counter for threshold triggers (compaction, context pill).
 *
 * We intentionally do NOT use a real BPE (tiktoken, etc.) here — those
 * packages ship WASM binaries that slow down cold start and we only
 * need an estimate precise enough to decide when to trigger compaction
 * at the 180k threshold. A 10% error bar is fine.
 *
 * Heuristic (derived from Anthropic's rough rule of thumb for Claude):
 * - 1 token ≈ 3.5 chars for English prose
 * - 1 token ≈ 2 chars for dense code / JSON (more symbols)
 * - Tool result blobs can be dominated by JSON, so we bias downward.
 *
 * For a message we count the role marker (~4 tokens) + body chars / 3.
 * Good enough for "did we cross 180k" — the actual compaction decision
 * lives in compaction.ts and uses this estimate.
 */

import type { ChatMessage } from './types.ts'

const CHARS_PER_TOKEN = 3
const ROLE_MARKER_TOKENS = 4

/**
 * Estimate token count for one or more messages. Accepts either a
 * single string (raw content) or a ChatMessage[] (to include role
 * markers and tool overhead).
 */
export function countTokens(input: string | ChatMessage[]): number {
  if (typeof input === 'string') {
    return Math.ceil(input.length / CHARS_PER_TOKEN)
  }

  let total = 0
  for (const msg of input) {
    total += ROLE_MARKER_TOKENS
    total += Math.ceil(msg.content.length / CHARS_PER_TOKEN)
    if (msg.toolCallId) total += 2
    if (msg.toolName) total += 2
  }
  return total
}
