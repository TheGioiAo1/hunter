/**
 * Gbox Platform — support-ai sentiment-flag surface (Phase 12.5 PR4).
 *
 * Runs every 5 minutes via the support-ai-sentiment cron (wired in
 * PR5). For every new seller message since the last tick, ask Sonnet:
 * "angry / neutral / happy?" and stash the verdict on the message
 * row (`sentiment_label`, `sentiment_scored_at`).
 *
 * Agents see an angry-face icon in the inbox list when a seller's
 * last message has sentiment='angry' — priority cue without having
 * to open the ticket.
 *
 * Why batch in cron instead of scoring on message insert?
 *   - Seller writes don't wait on AI latency (users click "Send" and
 *     see their message appear immediately).
 *   - One Anthropic call per 5-min window × N messages is cheaper
 *     than N call setups.
 *   - Easier to budget: the cron checks `isWithinBudget()` once per
 *     tick before spending.
 *
 * For Phase 12.5 the cron wiring is PR5's responsibility. This file
 * exposes the scoring function so PR5 can import it directly.
 */

import { redactPii } from './redact-pii.ts'
import { sendSupportChat, SupportAIError } from './client.ts'
import { logAIUsage } from './usage-tracker.ts'
import type { AISupportKeys } from './null-key-fallback.ts'
import { assertAISupportConfigured } from './null-key-fallback.ts'

export const SENTIMENT_LABELS = ['angry', 'neutral', 'happy'] as const
export type SentimentLabel = (typeof SENTIMENT_LABELS)[number]

export interface SentimentInput {
  readonly id: string
  readonly body: string
}

export interface SentimentBatchInput {
  readonly keys: AISupportKeys
  readonly messages: ReadonlyArray<SentimentInput>
  readonly shopId?: string
}

export interface SentimentResult {
  readonly messageId: string
  readonly label: SentimentLabel
  readonly score: number
}

export interface SentimentBatchResult {
  readonly results: SentimentResult[]
  readonly inputTokens: number
  readonly outputTokens: number
  readonly costCents: number
}

/**
 * Instruction: classify each body into one of three labels. Output
 * must be a JSON array matching the input order 1-to-1 so the
 * caller can zip it back to message ids without re-identifying them
 * to Anthropic (privacy minimisation).
 */
export function buildSentimentSystemPrompt(): string {
  return [
    'You are a short sentiment classifier for customer-support messages.',
    'Given a numbered list of message bodies, return a JSON array of the same length.',
    'Each element: {"index":N,"label":"angry"|"neutral"|"happy","score":0..1}.',
    'Angry: complaints, profanity, threats, escalation.',
    'Happy: thanks, satisfaction, resolution acknowledged.',
    'Everything else: neutral.',
    'NO explanations, NO markdown fences.',
  ].join('\n')
}

export function parseSentimentResponse(
  raw: string,
  expectedCount: number,
): { index: number; label: SentimentLabel; score: number }[] {
  const stripped = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
  let parsed: unknown
  try {
    parsed = JSON.parse(stripped)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const out: { index: number; label: SentimentLabel; score: number }[] = []
  for (const el of parsed) {
    if (!el || typeof el !== 'object') continue
    const p = el as Record<string, unknown>
    const index = Number(p.index)
    const label = String(p.label ?? '').toLowerCase()
    const score = Number(p.score ?? 0)
    if (!Number.isInteger(index) || index < 0 || index >= expectedCount) continue
    if (!(SENTIMENT_LABELS as readonly string[]).includes(label)) continue
    const clampedScore = Number.isFinite(score) ? Math.max(0, Math.min(1, score)) : 0
    out.push({ index, label: label as SentimentLabel, score: clampedScore })
  }
  return out
}

export async function scoreSentimentBatch(
  db: any,
  input: SentimentBatchInput,
): Promise<SentimentBatchResult> {
  assertAISupportConfigured(input.keys)

  if (input.messages.length === 0) {
    return { results: [], inputTokens: 0, outputTokens: 0, costCents: 0 }
  }

  // Truncate each body to keep the prompt bounded — 1000 chars is
  // plenty for sentiment detection (the first two sentences almost
  // always carry the signal). PII-redact FIRST, truncate SECOND,
  // so we never truncate through the middle of a `[REDACTED-...]`
  // sentinel.
  const lines = input.messages.map((m, i) => {
    const body = redactPii(m.body).slice(0, 1000)
    return `${i}. ${body}`
  })
  const userTurn = lines.join('\n---\n')

  try {
    const chat = await sendSupportChat({
      apiKey: input.keys.anthropicApiKey,
      model: 'sonnet-4-5',
      system: buildSentimentSystemPrompt(),
      messages: [{ role: 'user', content: userTurn }],
      maxTokens: Math.min(800, 30 * input.messages.length),
      temperature: 0,
    })

    const logRes = await logAIUsage(db, {
      surface: 'sentiment_flag',
      model: 'sonnet-4-5',
      inputTokens: chat.inputTokens,
      outputTokens: chat.outputTokens,
      shopId: input.shopId ?? null,
    })
    const costCents = logRes.ok ? logRes.costCents : 0

    const parsed = parseSentimentResponse(chat.text, input.messages.length)
    const results: SentimentResult[] = parsed.map((p) => ({
      messageId: input.messages[p.index].id,
      label: p.label,
      score: p.score,
    }))

    return {
      results,
      inputTokens: chat.inputTokens,
      outputTokens: chat.outputTokens,
      costCents,
    }
  } catch (err) {
    await logAIUsage(db, {
      surface: 'sentiment_flag',
      model: 'sonnet-4-5',
      inputTokens: 0,
      outputTokens: 0,
      shopId: input.shopId ?? null,
      error: err instanceof Error ? err.message : String(err),
    }).catch(() => {})
    if (err instanceof SupportAIError) throw err
    throw err
  }
}
