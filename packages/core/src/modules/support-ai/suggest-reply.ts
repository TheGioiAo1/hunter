/**
 * Gbox Platform — support-ai suggest-reply surface (Phase 12.5 PR4).
 *
 * The "AI suggest" button in the agent's reply composer. Given:
 *   - the current ticket (subject, category, priority)
 *   - the last ~10 messages on the thread
 *   - optional hints from the agent ("decline politely", "offer 10% off")
 *
 * produce ONE candidate reply in the ticket's language. Layer 1 is
 * suggest-only — the agent still clicks "Send" to post it. Layer 2
 * (auto-reply) is deferred to Phase 14+ per spec §10.6 after we
 * have 30 days of accuracy data.
 *
 * Iron Rule 5: the system prompt MUST NOT mention "god admin" or
 * leak any internal route. The model's output also MUST be
 * sanitised by the caller before display (see canned-reply-render
 * or the seller widget's escape pass) — this module trusts nothing.
 *
 * Data flow:
 *
 *   1. Caller builds a `SuggestReplyInput` from DB rows.
 *   2. We redact PII in every message body (redactPii).
 *   3. pickModel() decides Sonnet vs Opus.
 *   4. Build the Anthropic prompt (system + messages array).
 *   5. sendSupportChat() fires it.
 *   6. logAIUsage() records the row on success OR failure.
 *   7. Return { text, model, costCents } to caller.
 *
 * Null-key fallback: caller is expected to have gated the button on
 * isAISupportConfigured(). If they didn't and the key is missing,
 * `assertAISupportConfigured()` throws AINotConfiguredError before
 * we touch the network.
 */

import type { SupportAiModel, TicketSnapshot } from './pick-model.ts'
import { pickModel } from './pick-model.ts'
import { redactPii } from './redact-pii.ts'
import { sendSupportChat, SupportAIError } from './client.ts'
import { logAIUsage } from './usage-tracker.ts'
import type { AISupportKeys } from './null-key-fallback.ts'
import { assertAISupportConfigured } from './null-key-fallback.ts'

/**
 * One message in the ticket history we feed to the model. The
 * `role` is the Anthropic chat role, not the DB sender_type — the
 * caller is responsible for mapping `seller`/`agent`/`system` to
 * `user`/`assistant`/`user` respectively (agent_internal_note
 * messages should NOT be included).
 */
export interface ThreadMessage {
  readonly role: 'user' | 'assistant'
  /** Plain-text body. Already decrypted from support_messages. */
  readonly content: string
}

export interface SuggestReplyInput {
  /** AI runtime keys + budget state. */
  readonly keys: AISupportKeys
  /** Ticket metadata — category, priority, subject. */
  readonly ticket: TicketSnapshot
  /** Ordered messages, oldest first. */
  readonly history: ReadonlyArray<ThreadMessage>
  /** Agent hint — optional, e.g. "offer partial refund" or "ask for proof". */
  readonly hint?: string
  /** Confidence 0..1 supplied by the caller (default 0). */
  readonly confidence?: number
  /** Preferred reply language — default 'en'. */
  readonly language?: 'en' | 'vi'
  /** For the usage-tracker row. */
  readonly ticketId?: string
  readonly shopId?: string
  readonly actorUserId?: string
}

export interface SuggestReplyResult {
  readonly text: string
  readonly model: SupportAiModel
  readonly inputTokens: number
  readonly outputTokens: number
  readonly costCents: number
}

/**
 * Build the system prompt. Pinned language defaults keep the agent
 * in control — the model doesn't invent a tone or a policy from
 * nowhere. Iron Rule 5 enforced in the literal string; grep for
 * 'god' / 'admin' in smoke tests.
 */
export function buildSuggestReplySystemPrompt(language: 'en' | 'vi'): string {
  if (language === 'vi') {
    return [
      'Bạn là một trợ lý hỗ trợ khách hàng cho nền tảng Gbox.',
      'Viết một câu trả lời duy nhất cho ticket hiện tại, tông giọng chuyên nghiệp, thân thiện, không trịch thượng.',
      'KHÔNG thêm lời chào đầu thừa (vd: "Xin chào bạn"), đi thẳng vào giải quyết vấn đề.',
      'KHÔNG bịa dữ liệu đơn hàng, ngày tháng, số tiền. Nếu cần dữ liệu cụ thể, hãy hỏi seller cung cấp.',
      'KHÔNG nhắc đến các URL quản trị nội bộ hoặc tên hệ thống nội bộ.',
      'Giới hạn 180 từ. Kết thúc bằng một câu hỏi rõ ràng nếu cần thêm thông tin, nếu không thì không cần.',
    ].join('\n')
  }
  return [
    'You are a customer support assistant for the Gbox platform.',
    'Write ONE reply candidate for the current ticket. Professional, warm, never condescending.',
    'DO NOT add filler greetings ("Hi there!"); get to the point.',
    'DO NOT invent order data, dates, or amounts. If specific data is needed, ask the seller to provide it.',
    'DO NOT mention any internal admin URLs or internal system names.',
    'Limit 180 words. End with a concrete follow-up question if more info is needed; otherwise do not.',
  ].join('\n')
}

/**
 * Fire the suggest-reply flow end-to-end. Throws AINotConfiguredError
 * or SupportAIError on failure; logs a usage row in every case.
 *
 * db is typed `any` because the Kysely cross-package type drift —
 * see the apps/supporter handlers for the same workaround.
 */
export async function suggestReply(
  db: any,
  input: SuggestReplyInput,
): Promise<SuggestReplyResult> {
  assertAISupportConfigured(input.keys)

  const language = input.language ?? 'en'
  const model = pickModel(input.ticket, input.confidence ?? 0)

  // PII-safe the history + ticket subject before anything goes out.
  const safeHistory = input.history.map((m) => ({
    role: m.role,
    content: redactPii(m.content),
  }))
  const safeSubject = redactPii(input.ticket.subject)
  const safeHint = input.hint ? redactPii(input.hint) : null

  const systemPrompt = buildSuggestReplySystemPrompt(language)

  // Frame the ticket + any hint as a user turn prepended to the
  // conversation. This gives the model the "task" it needs to do
  // WITHOUT bleeding it into the system prompt (where it'd be
  // cached differently by Anthropic).
  const framing =
    `Ticket category: ${input.ticket.category}\n` +
    `Priority: ${input.ticket.priority}\n` +
    `Subject: ${safeSubject}\n` +
    (safeHint ? `Agent hint: ${safeHint}\n` : '') +
    `\nPlease draft the next agent reply.`

  const messages = [
    { role: 'user' as const, content: framing },
    ...safeHistory,
  ]

  try {
    const chat = await sendSupportChat({
      apiKey: input.keys.anthropicApiKey,
      model,
      system: systemPrompt,
      messages,
      maxTokens: 800,
      temperature: 0.3,
    })

    const logRes = await logAIUsage(db, {
      surface: 'suggest_reply',
      model,
      inputTokens: chat.inputTokens,
      outputTokens: chat.outputTokens,
      ticketId: input.ticketId ?? null,
      shopId: input.shopId ?? null,
      actorUserId: input.actorUserId ?? null,
    })
    const costCents = logRes.ok ? logRes.costCents : 0

    return {
      text: chat.text.trim(),
      model,
      inputTokens: chat.inputTokens,
      outputTokens: chat.outputTokens,
      costCents,
    }
  } catch (err) {
    // Still log the failed attempt so dashboards can surface error rates.
    await logAIUsage(db, {
      surface: 'suggest_reply',
      model,
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
