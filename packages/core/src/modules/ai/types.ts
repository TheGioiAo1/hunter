/**
 * Gbox Platform — AI runtime types
 *
 * This module defines the shared vocabulary for the AI runtime layer
 * (providers, router, streaming, cost tracking). Pure types only — no
 * HTTP, no DB, no side effects. Anything that needs network lives in
 * `providers/*.ts`; anything that needs a database lives in
 * `config-service.ts` or `cost-tracker.ts`.
 *
 * Design goals
 * ------------
 *
 *   1. Provider-agnostic. A caller writes one `ChatRequest` and the
 *      router picks a provider/model at send time. Switching from
 *      Anthropic to Gemini never changes the caller.
 *
 *   2. Streamable by default. Every provider yields `StreamEvent`s the
 *      same way — the SSE layer upstream doesn't care who answered.
 *
 *   3. Observable. `CostRecord` is emitted for every call so admin
 *      dashboards can show "cloning a site costs $X on average".
 *
 *   4. Fails closed. When a provider returns a rate-limit or 5xx, the
 *      router downgrades to the next provider in the fallback chain.
 *      Callers never see a transient failure unless every provider
 *      refuses.
 */

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

/**
 * The concrete providers this runtime knows how to call. `'none'` is
 * a sentinel that means "no AI available" — callers should degrade
 * gracefully (e.g. rule-based extraction) when this is the only
 * choice.
 */
export type AIProviderId = 'anthropic' | 'openai' | 'google' | 'groq' | 'none'

/**
 * Provider capabilities. Matches what the runtime can actually wire
 * up today — `vision` means the provider accepts image inputs in the
 * same request, `streaming` means it emits SSE-style chunks.
 */
export interface ProviderCapabilities {
  readonly text: boolean
  readonly vision: boolean
  readonly streaming: boolean
  readonly jsonMode: boolean
}

/**
 * Runtime credentials + model pin for a provider. Built by the router
 * from decrypted `shop_ai_config` rows; never logged, never echoed.
 */
export interface ProviderCredential {
  readonly provider: AIProviderId
  readonly apiKey: string
  readonly model: string
  readonly baseUrl?: string
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/** Role in a chat transcript. */
export type ChatRole = 'system' | 'user' | 'assistant'

/**
 * A single content block inside a chat message. Matches the Anthropic
 * Messages API block model because it's the richest of the three
 * providers — the others are adapted down.
 */
export type ChatContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp'; readonly base64: string }

export interface ChatMessage {
  readonly role: ChatRole
  /**
   * Either a raw string (shorthand for one text block) or an array of
   * content blocks. Providers normalize this at send time.
   */
  readonly content: string | readonly ChatContentBlock[]
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/**
 * A single chat call. The router resolves `provider`/`model` at send
 * time if either is absent — callers usually leave both blank and
 * rely on the per-shop `shop_ai_config` row.
 */
export interface ChatRequest {
  /** Optional provider pin. If omitted, router picks via fallback chain. */
  readonly provider?: AIProviderId
  /** Optional model pin. If omitted, router uses the provider's default. */
  readonly model?: string
  /** System prompt. Applied as Anthropic `system` or OpenAI `system`-role. */
  readonly system?: string
  /** User/assistant turns. Always non-empty. */
  readonly messages: readonly ChatMessage[]
  /** Hard cap on completion length. Default 2000 at the provider layer. */
  readonly maxTokens?: number
  /** 0–1. Default 0.3 at the provider layer (deterministic-leaning). */
  readonly temperature?: number
  /**
   * Hint: request the response as JSON. The router falls back to a
   * post-hoc JSON extractor if the provider doesn't honour the hint.
   */
  readonly jsonMode?: boolean
  /**
   * Abort signal for cancellation. Used by the admin UI when a user
   * closes a clone preview before the model finishes.
   */
  readonly signal?: AbortSignal
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

/**
 * One event in a streaming response. `text` is a partial token chunk;
 * `done` is emitted exactly once at the end and carries the usage
 * numbers the cost tracker needs.
 */
export type StreamEvent =
  | { readonly type: 'text'; readonly delta: string }
  | { readonly type: 'error'; readonly message: string; readonly retryable: boolean }
  | { readonly type: 'done'; readonly usage: TokenUsage; readonly finishReason: FinishReason }

export type FinishReason = 'stop' | 'length' | 'error' | 'cancelled'

/** Normalised token accounting across providers. */
export interface TokenUsage {
  readonly promptTokens: number
  readonly completionTokens: number
  readonly totalTokens: number
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

/**
 * The non-streaming return shape. Includes the provider/model the
 * router actually used so callers can surface attribution and the
 * cost tracker can settle pricing.
 */
export interface ChatResponse {
  readonly provider: AIProviderId
  readonly model: string
  readonly text: string
  readonly usage: TokenUsage
  readonly finishReason: FinishReason
  readonly durationMs: number
}

// ---------------------------------------------------------------------------
// Cost
// ---------------------------------------------------------------------------

/**
 * One provider/model's price sheet in USD cents per 1M tokens. The
 * router looks this up at `done` time to compute the dollar cost and
 * append a `CostRecord` to telemetry.
 */
export interface PriceSheet {
  readonly inputCostPerMillionCents: number
  readonly outputCostPerMillionCents: number
}

/**
 * A single observation the cost tracker records. Shops can query these
 * to see "the last clone cost me $0.62 and used 45_000 tokens".
 */
export interface CostRecord {
  readonly shopId: string
  readonly provider: AIProviderId
  readonly model: string
  /** What the call was for — e.g. 'clone_seo', 'clone_alt_text'. */
  readonly purpose: string
  readonly usage: TokenUsage
  /** Dollar cost in USD cents. */
  readonly costCents: number
  readonly occurredAt: string
  readonly durationMs: number
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Typed error the router uses to decide whether to retry on the same
 * provider, fall through to the next one, or bubble the failure up.
 *
 *   - rate_limit      retry on same provider after backoff
 *   - transient       retry on same provider once, then fall through
 *   - auth            fall through immediately (bad key, no retry)
 *   - invalid_input   bubble up (caller error, no fallback helps)
 *   - budget          bubble up (shop exceeded AI spend cap)
 *   - unknown         fall through
 */
export type AIErrorKind =
  | 'rate_limit'
  | 'transient'
  | 'auth'
  | 'invalid_input'
  | 'budget'
  | 'unknown'

export class AIError extends Error {
  readonly kind: AIErrorKind
  readonly provider: AIProviderId | null
  readonly statusCode: number | null
  constructor(
    kind: AIErrorKind,
    message: string,
    opts?: { provider?: AIProviderId; statusCode?: number },
  ) {
    super(message)
    this.name = 'AIError'
    this.kind = kind
    this.provider = opts?.provider ?? null
    this.statusCode = opts?.statusCode ?? null
  }
}

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

/** Narrow a StreamEvent to the terminal `done` event. */
export function isDoneEvent(
  event: StreamEvent,
): event is Extract<StreamEvent, { type: 'done' }> {
  return event.type === 'done'
}

/** Narrow a StreamEvent to a `text` delta. */
export function isTextEvent(
  event: StreamEvent,
): event is Extract<StreamEvent, { type: 'text' }> {
  return event.type === 'text'
}

/** Narrow a StreamEvent to an `error`. */
export function isErrorEvent(
  event: StreamEvent,
): event is Extract<StreamEvent, { type: 'error' }> {
  return event.type === 'error'
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/**
 * Fallback chain the router uses when the caller doesn't pin a
 * provider. Order: Anthropic (best quality) → Google (cheapest/fast) →
 * OpenAI (widest coverage) → Groq (fast/cheap). `'none'` is the
 * terminator — callers that opt into AI should have at least one
 * key configured.
 */
export const DEFAULT_FALLBACK_CHAIN: readonly AIProviderId[] = [
  'anthropic',
  'google',
  'openai',
  'groq',
]

/**
 * Per-provider default model. Pinned so callers get a predictable
 * model without reading env vars. Can be overridden per shop via
 * `shop_ai_config`.
 */
export const DEFAULT_MODELS: Readonly<Record<AIProviderId, string>> = {
  anthropic: 'claude-sonnet-4-20250514',
  openai: 'gpt-4o-mini',
  google: 'gemini-2.0-flash',
  groq: 'moonshotai/kimi-k2-instruct-0905',
  none: '',
}

/**
 * Current price sheets (USD cents per 1M tokens). Keep these in sync
 * with each provider's public pricing page. Missing models default
 * to the provider's flagship price — callers can pass a custom sheet
 * when they know better.
 */
export const DEFAULT_PRICE_SHEET: Readonly<Record<string, PriceSheet>> = {
  // Anthropic (https://www.anthropic.com/pricing)
  'claude-sonnet-4-20250514': { inputCostPerMillionCents: 300, outputCostPerMillionCents: 1500 },
  'claude-haiku-3-5': { inputCostPerMillionCents: 80, outputCostPerMillionCents: 400 },
  // OpenAI (https://openai.com/pricing)
  'gpt-4o-mini': { inputCostPerMillionCents: 15, outputCostPerMillionCents: 60 },
  'gpt-4o': { inputCostPerMillionCents: 250, outputCostPerMillionCents: 1000 },
  'gpt-5': { inputCostPerMillionCents: 500, outputCostPerMillionCents: 2000 },
  // Google (https://ai.google.dev/pricing)
  'gemini-2.0-flash': { inputCostPerMillionCents: 10, outputCostPerMillionCents: 40 },
  'gemini-3-pro-preview': { inputCostPerMillionCents: 150, outputCostPerMillionCents: 600 },
  // Groq (https://wow.groq.com/)
  'moonshotai/kimi-k2-instruct-0905': { inputCostPerMillionCents: 30, outputCostPerMillionCents: 150 },
}
