/**
 * Gbox Platform — support-ai summarize-thread surface (Phase 12.5 PR4).
 *
 * Fires when an agent opens a ticket with >10 messages: render a
 * 3-bullet "catch me up" summary above the message list so the
 * agent doesn't have to read 40 turns of back-and-forth.
 *
 * Always uses Sonnet — summarisation is a shallow task that Opus
 * wouldn't meaningfully improve on. Locked in pick-model.ts
 * comments (branch 4 fallback).
 *
 * Key design choice: bullets not paragraphs. The agent wants to
 * scan. We tell the model to emit exactly three bullets, each one
 * line, each one fact. The caller splits on '\n-' before display.
 */

import { redactPii } from './redact-pii.ts'
import { sendSupportChat, SupportAIError } from './client.ts'
import { logAIUsage } from './usage-tracker.ts'
import type { AISupportKeys } from './null-key-fallback.ts'
import { assertAISupportConfigured } from './null-key-fallback.ts'
import type { ThreadMessage } from './suggest-reply.ts'

export interface SummarizeThreadInput {
  readonly keys: AISupportKeys
  /** Ordered messages, oldest first. Internal notes included for agent context. */
  readonly history: ReadonlyArray<ThreadMessage>
  readonly language?: 'en' | 'vi'
  readonly ticketId?: string
  readonly shopId?: string
  readonly actorUserId?: string
}

export interface SummarizeThreadResult {
  /** Full text returned by Anthropic (includes the bullets as-is). */
  readonly text: string
  /** Parsed bullets, each one line, with the leading '- ' stripped. */
  readonly bullets: string[]
  readonly inputTokens: number
  readonly outputTokens: number
  readonly costCents: number
}

/**
 * Instruction: exactly three bullets, each a single fact the agent
 * needs before replying. No headers, no meta-commentary, no invite
 * to ask more questions.
 */
export function buildSummarizeThreadSystemPrompt(language: 'en' | 'vi'): string {
  if (language === 'vi') {
    return [
      'Bạn đọc một cuộc hội thoại hỗ trợ khách hàng và tóm tắt cho đồng nghiệp.',
      'Trả về CHÍNH XÁC 3 gạch đầu dòng, mỗi dòng là MỘT sự thật cụ thể.',
      'Định dạng: mỗi dòng bắt đầu bằng "- " và một sự thật.',
      'KHÔNG thêm tiêu đề, kết luận, hoặc lời mời phản hồi.',
      'KHÔNG bịa thông tin không có trong hội thoại.',
    ].join('\n')
  }
  return [
    'You read a customer-support conversation and summarize for a colleague.',
    'Return EXACTLY 3 bullets, each a single concrete fact.',
    'Format: each line starts with "- " followed by one fact.',
    'NO headings, NO closing remark, NO invitation to ask more.',
    'NEVER invent details that are not in the transcript.',
  ].join('\n')
}

/**
 * Parse the "- one\n- two\n- three" string into three strings.
 * Tolerates extra whitespace, Markdown bullet variations (`*`, `•`),
 * and up to 5 bullets (we truncate at 3 for display consistency).
 */
export function parseSummaryBullets(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[-*\u2022]\s+/.test(line))
    .map((line) => line.replace(/^[-*\u2022]\s+/, '').trim())
    .filter((line) => line.length > 0)
    .slice(0, 3)
}

export async function summarizeThread(
  db: any,
  input: SummarizeThreadInput,
): Promise<SummarizeThreadResult> {
  assertAISupportConfigured(input.keys)

  const language = input.language ?? 'en'
  const safeHistory = input.history.map((m) => ({
    role: m.role,
    content: redactPii(m.content),
  }))

  // Collapse the turns into a single user message so we don't burn
  // format tokens on role markers. The model treats the whole
  // transcript as input to summarize.
  const transcript = safeHistory
    .map((m) => `${m.role === 'user' ? 'Seller' : 'Agent'}: ${m.content}`)
    .join('\n\n')

  const systemPrompt = buildSummarizeThreadSystemPrompt(language)
  const messages = [{ role: 'user' as const, content: transcript }]

  try {
    const chat = await sendSupportChat({
      apiKey: input.keys.anthropicApiKey,
      // Summarisation always uses Sonnet — it's the cheap, fast
      // branch of the hybrid tier.
      model: 'sonnet-4-5',
      system: systemPrompt,
      messages,
      maxTokens: 300,
      temperature: 0.2,
    })

    const logRes = await logAIUsage(db, {
      surface: 'summarize_thread',
      model: 'sonnet-4-5',
      inputTokens: chat.inputTokens,
      outputTokens: chat.outputTokens,
      ticketId: input.ticketId ?? null,
      shopId: input.shopId ?? null,
      actorUserId: input.actorUserId ?? null,
    })
    const costCents = logRes.ok ? logRes.costCents : 0

    return {
      text: chat.text.trim(),
      bullets: parseSummaryBullets(chat.text),
      inputTokens: chat.inputTokens,
      outputTokens: chat.outputTokens,
      costCents,
    }
  } catch (err) {
    await logAIUsage(db, {
      surface: 'summarize_thread',
      model: 'sonnet-4-5',
      inputTokens: 0,
      outputTokens: 0,
      ticketId: input.ticketId ?? null,
      shopId: input.shopId ?? null,
      actorUserId: input.actorUserId ?? null,
      error: err instanceof Error ? err.message : String(err),
    }).catch(() => {})
    if (err instanceof SupportAIError) throw err
    throw err
  }
}
