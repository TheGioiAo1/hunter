/**
 * Conversation compaction.
 *
 * Trigger: session token usage crosses 180k (spec §6.2). The SSE loop
 * calls compactConversation() synchronously before sending the next
 * turn to the LLM.
 *
 * Strategy:
 *   1. Keep the last `preserveTailCount` turns verbatim (default 6 —
 *      covers typical "question + answer + followup" triplets).
 *   2. Fold everything before that into a summary via a summariser
 *      callback (in prod this is a single-turn call to the same Claude
 *      model with a dedicated system prompt; tests inject a fake).
 *   3. The summary MUST retain: (a) "locked decisions" — any turn
 *      containing the phrases "LOCKED", "DECISION:", "APPROVED", or
 *      "REJECTED" — as bullet points verbatim; (b) a one-paragraph
 *      narrative of what was attempted and why.
 *   4. Return the new message list: [summary-message, ...preservedTail].
 *
 * Token budget: the returned compacted context is bounded by
 * `maxSummaryTokens` (default 6000). If the summariser overshoots,
 * we truncate the summary text (rare — usually Claude obeys).
 */

import type { ChatMessage, CompactResult } from './types.ts'
import { countTokens } from './token-counter.ts'

const LOCKED_MARKERS = ['LOCKED', 'DECISION:', 'APPROVED', 'REJECTED']

export interface CompactOptions {
  /** How many of the most-recent messages to keep verbatim. */
  preserveTailCount?: number
  /** Hard cap on the summary's token count. */
  maxSummaryTokens?: number
  /**
   * Summariser — given the prefix to fold + extracted locked bullets,
   * returns a one-paragraph narrative. In prod this is a Claude call;
   * in tests it's a fake that returns a deterministic string.
   */
  summarise: (args: {
    foldedMessages: ChatMessage[]
    lockedBullets: string[]
  }) => Promise<string>
}

export async function compactConversation(
  messages: ChatMessage[],
  opts: CompactOptions,
): Promise<CompactResult> {
  const preserveCount = opts.preserveTailCount ?? 6
  const maxSummaryTokens = opts.maxSummaryTokens ?? 6000

  const tokensBefore = countTokens(messages)

  // Nothing to fold — return unchanged.
  if (messages.length <= preserveCount) {
    return {
      foldedCount: 0,
      preservedTail: [...messages],
      summary: '',
      tokensAfter: tokensBefore,
      tokensBefore,
    }
  }

  const splitAt = messages.length - preserveCount
  const prefix = messages.slice(0, splitAt)
  const tail = messages.slice(splitAt)

  // Extract locked decisions — each bullet is the matched line verbatim
  // so the model can't paraphrase a "LOCKED" choice away.
  const lockedBullets: string[] = []
  for (const msg of prefix) {
    const lines = msg.content.split('\n')
    for (const line of lines) {
      if (LOCKED_MARKERS.some((marker) => line.includes(marker))) {
        lockedBullets.push(line.trim())
      }
    }
  }

  const narrative = await opts.summarise({
    foldedMessages: prefix,
    lockedBullets,
  })

  // Compose the final summary body. Locked bullets go first so they
  // survive any subsequent re-compaction.
  const parts: string[] = []
  if (lockedBullets.length > 0) {
    parts.push('## Locked decisions')
    for (const bullet of lockedBullets) {
      parts.push(`- ${bullet}`)
    }
    parts.push('')
  }
  parts.push('## Narrative')
  parts.push(narrative)
  let summaryText = parts.join('\n')

  // Enforce the token budget (cheap char-truncate if overshoot).
  const summaryTokens = countTokens(summaryText)
  if (summaryTokens > maxSummaryTokens) {
    const ratio = maxSummaryTokens / summaryTokens
    summaryText = summaryText.slice(0, Math.floor(summaryText.length * ratio))
    summaryText += '\n\n[...truncated by compactor]'
  }

  const summaryMessage: ChatMessage = {
    seq: prefix[0].seq,
    role: 'system',
    content: summaryText,
    createdAt: new Date().toISOString(),
  }

  const newMessages = [summaryMessage, ...tail]
  const tokensAfter = countTokens(newMessages)

  return {
    foldedCount: prefix.length,
    preservedTail: tail,
    summary: summaryText,
    tokensAfter,
    tokensBefore,
  }
}
