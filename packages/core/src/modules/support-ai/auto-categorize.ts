/**
 * Gbox Platform — support-ai auto-categorize surface (Phase 12.5 PR4).
 *
 * Fires on incoming ticket creation. Given the seller's opening
 * message + subject, suggest ONE of the 6 support categories. The
 * agent confirms in one click; on confirm we update the ticket row
 * and the model's pick influences future routing (L1 queue vs L2
 * queue).
 *
 * Always Sonnet — classification is the cheapest flavor of task,
 * and wrong category is an agent-fixable mistake (L1 agent
 * reassigns), not a platform-level incident.
 *
 * Output contract:
 *   - exactly one category from the fixed enum
 *   - one short rationale (< 80 chars) we DON'T display to the
 *     agent (it's a confidence prop for pickModel() in future
 *     suggest-reply calls on this ticket)
 *   - confidence 0..1 the model volunteers
 *
 * The model is told to emit strict JSON. We parse defensively —
 * if the response is malformed, caller falls back to the default
 * category ('other') without throwing.
 */

import { redactPii } from './redact-pii.ts'
import { sendSupportChat, SupportAIError } from './client.ts'
import { logAIUsage } from './usage-tracker.ts'
import type { AISupportKeys } from './null-key-fallback.ts'
import { assertAISupportConfigured } from './null-key-fallback.ts'

/**
 * The six canonical support categories — match SupportCategory in
 * packages/db/src/schema/tables.ts. Kept as a string literal union
 * so the model's output can be type-checked at the parse step.
 */
export const SUPPORT_CATEGORIES = [
  'payment',
  'technical',
  'onboarding',
  'account',
  'product_order',
  'other',
] as const

export type SupportCategoryId = (typeof SUPPORT_CATEGORIES)[number]

export interface AutoCategorizeInput {
  readonly keys: AISupportKeys
  readonly subject: string
  readonly body: string
  readonly language?: 'en' | 'vi'
  readonly ticketId?: string
  readonly shopId?: string
  readonly actorUserId?: string
}

export interface AutoCategorizeResult {
  readonly category: SupportCategoryId
  readonly confidence: number
  readonly rationale: string
  readonly inputTokens: number
  readonly outputTokens: number
  readonly costCents: number
}

export function buildAutoCategorizeSystemPrompt(language: 'en' | 'vi'): string {
  const categoryList = SUPPORT_CATEGORIES.join(', ')
  if (language === 'vi') {
    return [
      'Bạn phân loại ticket hỗ trợ khách hàng cho nền tảng Gbox.',
      `Chọn MỘT category từ danh sách: ${categoryList}.`,
      'Trả lời CHÍNH XÁC theo JSON: {"category":"...","confidence":0.x,"rationale":"..."}.',
      'confidence là số thập phân 0..1. rationale tối đa 80 ký tự, bằng tiếng Anh.',
      'KHÔNG thêm markdown fence, KHÔNG thêm text ngoài JSON.',
    ].join('\n')
  }
  return [
    'You classify customer support tickets for the Gbox platform.',
    `Pick EXACTLY ONE category from: ${categoryList}.`,
    'Respond with STRICT JSON: {"category":"...","confidence":0.x,"rationale":"..."}.',
    'confidence is a float 0..1. rationale is at most 80 chars, English.',
    'NO markdown fences, NO text outside the JSON.',
  ].join('\n')
}

/**
 * Defensive parse: tolerates stray whitespace, markdown fences, and
 * extra keys. Returns null if the required fields can't be extracted.
 * Caller is responsible for clamping confidence and defaulting the
 * category if null.
 */
export function parseCategorizeResponse(
  raw: string,
): { category: SupportCategoryId; confidence: number; rationale: string } | null {
  const stripped = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
  let parsed: unknown
  try {
    parsed = JSON.parse(stripped)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const p = parsed as Record<string, unknown>
  const cat = String(p.category ?? '').toLowerCase()
  if (!(SUPPORT_CATEGORIES as readonly string[]).includes(cat)) return null
  const conf = Number(p.confidence ?? 0)
  const confidence = Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : 0
  const rationale = String(p.rationale ?? '').slice(0, 80)
  return { category: cat as SupportCategoryId, confidence, rationale }
}

export async function autoCategorize(
  db: any,
  input: AutoCategorizeInput,
): Promise<AutoCategorizeResult> {
  assertAISupportConfigured(input.keys)

  const language = input.language ?? 'en'
  const safeSubject = redactPii(input.subject)
  const safeBody = redactPii(input.body).slice(0, 2000)

  const systemPrompt = buildAutoCategorizeSystemPrompt(language)
  const userTurn = `Subject: ${safeSubject}\n\nBody:\n${safeBody}`

  try {
    const chat = await sendSupportChat({
      apiKey: input.keys.anthropicApiKey,
      model: 'sonnet-4-5',
      system: systemPrompt,
      messages: [{ role: 'user', content: userTurn }],
      maxTokens: 120,
      temperature: 0.1,
    })

    const logRes = await logAIUsage(db, {
      surface: 'auto_categorize',
      model: 'sonnet-4-5',
      inputTokens: chat.inputTokens,
      outputTokens: chat.outputTokens,
      ticketId: input.ticketId ?? null,
      shopId: input.shopId ?? null,
      actorUserId: input.actorUserId ?? null,
    })
    const costCents = logRes.ok ? logRes.costCents : 0

    const parsed = parseCategorizeResponse(chat.text) ?? {
      category: 'other' as SupportCategoryId,
      confidence: 0,
      rationale: 'unparseable model response — defaulted to other',
    }

    return {
      category: parsed.category,
      confidence: parsed.confidence,
      rationale: parsed.rationale,
      inputTokens: chat.inputTokens,
      outputTokens: chat.outputTokens,
      costCents,
    }
  } catch (err) {
    await logAIUsage(db, {
      surface: 'auto_categorize',
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
