/**
 * Gbox Platform — AI Copywriter Service (Phase 10 PR1)
 *
 * Higher-level service that wraps the AI router with purpose-specific
 * helpers for the seller-facing assistant:
 *
 *   - `generateProductDescription` — 3 description variants
 *   - `suggestProductTags` — JSON array of tags
 *   - `suggestCampaignContent` — subject + body + CTA for marketing email
 *   - `suggestEmailSubjects` — N subject lines for a given email purpose
 *
 * Design rules:
 *
 *   1. Each function returns a PARSED result (not the raw AI text), so
 *      admin UI / REST handlers get a typed object. Parsing failures
 *      bubble up as `CopywriterParseError` with the raw text for debug.
 *
 *   2. Each function takes an `AIRouter` instance plus a `shopId` +
 *      `purpose` tag so the cost tracker + budget gate work correctly
 *      per-shop.
 *
 *   3. No network I/O here — the router handles retries + fallback.
 *      This module is pure orchestration + parsing.
 *
 *   4. Returns include token usage + cost (surfaced from the router's
 *      `ChatResponse`) so the admin UI can show "≈ 0.3¢" per action.
 */

import {
  buildProductDescriptionPrompt,
  buildProductTagsPrompt,
  buildCampaignSuggestionPrompt,
  buildEmailSubjectPrompt,
  type ProductDescriptionPromptInput,
  type ProductTagsPromptInput,
  type CampaignSuggestionPromptInput,
  type EmailSubjectPromptInput,
  type AiPromptRequest,
} from './prompts.js'
import type { AIRouter } from './router.js'
import type { ChatRequest, ChatResponse, TokenUsage } from './types.js'

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class CopywriterParseError extends Error {
  readonly rawText: string
  constructor(reason: string, rawText: string) {
    super(`Copywriter parse failure: ${reason}`)
    this.name = 'CopywriterParseError'
    this.rawText = rawText
  }
}

// ---------------------------------------------------------------------------
// Result envelope (every function returns this shape)
// ---------------------------------------------------------------------------

export interface CopywriterCost {
  readonly provider: string
  readonly model: string
  readonly costCents: number
  readonly usage: TokenUsage
  readonly durationMs: number
}

export interface CopywriterResult<T> {
  readonly data: T
  readonly cost: CopywriterCost
  /** The raw model text, kept around for debugging / audit. */
  readonly rawText: string
}

// ---------------------------------------------------------------------------
// Common glue — turn an AiPromptRequest into a ChatRequest + invoke router
// ---------------------------------------------------------------------------

function toChatRequest(prompt: AiPromptRequest): ChatRequest {
  return {
    system: prompt.system,
    messages: [
      {
        role: 'user',
        content: prompt.messages[0]?.content ?? '',
      },
    ],
    maxTokens: prompt.max_tokens,
    temperature: prompt.temperature,
    model: prompt.model,
  }
}

function toCost(response: ChatResponse, costCents: number): CopywriterCost {
  return {
    provider: response.provider,
    model: response.model,
    costCents,
    usage: response.usage,
    durationMs: response.durationMs,
  }
}

async function invokeRouter(
  router: AIRouter,
  shopId: string,
  purpose: string,
  prompt: AiPromptRequest,
): Promise<ChatResponse> {
  return router.chat({
    shopId,
    purpose,
    request: toChatRequest(prompt),
    estimatedCents: estimateCents(prompt.max_tokens),
  })
}

function estimateCents(maxTokens: number): number {
  // Sonnet-4 output tokens at ~3 cents / 1M, plus prompt — crude upper bound.
  const perMillion = 300 // 3¢ per 1k output tokens ≈ 3000¢ per 1M
  return Math.max(1, Math.ceil((maxTokens / 1_000_000) * perMillion))
}

// ---------------------------------------------------------------------------
// Product description — 3 variants separated by `---`
// ---------------------------------------------------------------------------

export interface ProductDescriptionOutput {
  readonly variants: string[]
}

export function parseProductDescription(raw: string): ProductDescriptionOutput {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new CopywriterParseError('empty response', raw)
  }
  const parts = raw
    .split(/\n\s*-{3,}\s*\n/g)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  if (parts.length === 0) {
    throw new CopywriterParseError('no variants found', raw)
  }
  return { variants: parts.slice(0, 3) }
}

export async function generateProductDescription(
  router: AIRouter,
  shopId: string,
  input: ProductDescriptionPromptInput,
): Promise<CopywriterResult<ProductDescriptionOutput>> {
  const prompt = buildProductDescriptionPrompt(input)
  const response = await invokeRouter(router, shopId, 'product_description', prompt)
  const data = parseProductDescription(response.text)
  const costCents = 0 // the router already settled cost; we don't re-compute here
  return { data, cost: toCost(response, costCents), rawText: response.text }
}

// ---------------------------------------------------------------------------
// Product tags — JSON `{tags: string[]}`
// ---------------------------------------------------------------------------

export interface ProductTagsOutput {
  readonly tags: string[]
}

export function parseProductTags(raw: string): ProductTagsOutput {
  const json = stripCodeFences(raw)
  let obj: any
  try {
    obj = JSON.parse(json)
  } catch {
    throw new CopywriterParseError('not valid JSON', raw)
  }
  if (!obj || !Array.isArray(obj.tags)) {
    throw new CopywriterParseError('missing tags[] field', raw)
  }
  const tags = obj.tags
    .map((t: unknown) => (typeof t === 'string' ? t.trim() : ''))
    .filter((t: string) => t.length > 0)
    .slice(0, 20)
  return { tags }
}

export async function suggestProductTags(
  router: AIRouter,
  shopId: string,
  input: ProductTagsPromptInput,
): Promise<CopywriterResult<ProductTagsOutput>> {
  const prompt = buildProductTagsPrompt(input)
  const response = await invokeRouter(router, shopId, 'product_tags', prompt)
  const data = parseProductTags(response.text)
  return { data, cost: toCost(response, 0), rawText: response.text }
}

// ---------------------------------------------------------------------------
// Campaign content — JSON with subjects + body + CTA + send time
// ---------------------------------------------------------------------------

export interface CampaignContentOutput {
  readonly subject_lines: string[]
  readonly preview_text: string
  readonly body_html: string
  readonly cta_label: string
  readonly recommended_send_time: string
}

export function parseCampaignContent(raw: string): CampaignContentOutput {
  const json = stripCodeFences(raw)
  let obj: any
  try {
    obj = JSON.parse(json)
  } catch {
    throw new CopywriterParseError('not valid JSON', raw)
  }
  if (!obj || typeof obj !== 'object') {
    throw new CopywriterParseError('not an object', raw)
  }
  const subjectArr = Array.isArray(obj.subject_lines) ? obj.subject_lines : []
  const subjects = subjectArr
    .map((s: unknown) => (typeof s === 'string' ? s.trim() : ''))
    .filter((s: string) => s.length > 0)
  if (subjects.length === 0) {
    throw new CopywriterParseError('no subject_lines', raw)
  }
  return {
    subject_lines: subjects.slice(0, 5),
    preview_text: typeof obj.preview_text === 'string' ? obj.preview_text.trim() : '',
    body_html: typeof obj.body_html === 'string' ? obj.body_html : '',
    cta_label: typeof obj.cta_label === 'string' ? obj.cta_label.trim() : 'Shop now',
    recommended_send_time:
      typeof obj.recommended_send_time === 'string'
        ? obj.recommended_send_time.trim()
        : '',
  }
}

export async function suggestCampaignContent(
  router: AIRouter,
  shopId: string,
  input: CampaignSuggestionPromptInput,
): Promise<CopywriterResult<CampaignContentOutput>> {
  const prompt = buildCampaignSuggestionPrompt(input)
  const response = await invokeRouter(router, shopId, 'campaign_content', prompt)
  const data = parseCampaignContent(response.text)
  return { data, cost: toCost(response, 0), rawText: response.text }
}

// ---------------------------------------------------------------------------
// Email subject line brainstorm
// ---------------------------------------------------------------------------

export interface EmailSubjectsOutput {
  readonly subjects: string[]
}

export function parseEmailSubjects(raw: string): EmailSubjectsOutput {
  const json = stripCodeFences(raw)
  let obj: any
  try {
    obj = JSON.parse(json)
  } catch {
    throw new CopywriterParseError('not valid JSON', raw)
  }
  if (!obj || !Array.isArray(obj.subjects)) {
    throw new CopywriterParseError('missing subjects[] field', raw)
  }
  const subjects = obj.subjects
    .map((s: unknown) => (typeof s === 'string' ? s.trim() : ''))
    .filter((s: string) => s.length > 0)
    .slice(0, 10)
  if (subjects.length === 0) {
    throw new CopywriterParseError('empty subjects[]', raw)
  }
  return { subjects }
}

export async function suggestEmailSubjects(
  router: AIRouter,
  shopId: string,
  input: EmailSubjectPromptInput,
): Promise<CopywriterResult<EmailSubjectsOutput>> {
  const prompt = buildEmailSubjectPrompt(input)
  const response = await invokeRouter(router, shopId, 'email_subjects', prompt)
  const data = parseEmailSubjects(response.text)
  return { data, cost: toCost(response, 0), rawText: response.text }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * LLMs sometimes wrap JSON in ```json ... ``` fences even when the
 * system prompt asks for plain JSON. Strip them defensively.
 */
export function stripCodeFences(raw: string): string {
  if (typeof raw !== 'string') return ''
  let text = raw.trim()
  if (text.startsWith('```')) {
    text = text.replace(/^```(json)?\s*\n?/i, '')
    text = text.replace(/\n?```\s*$/i, '')
  }
  return text.trim()
}
