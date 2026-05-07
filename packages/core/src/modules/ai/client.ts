/**
 * Gbox Platform — AI client (singleton Anthropic SDK wrapper)
 *
 * This is the one file in the codebase that actually talks to
 * Anthropic's Messages API. Everything else in `packages/core/src/modules/ai/`
 * builds request payloads (pure functions, unit-testable) and then
 * hands them here to be sent over the wire.
 *
 * Why a singleton?
 * ----------------
 *   The Anthropic SDK holds a keep-alive HTTPS agent internally.
 *   Creating a fresh `new Anthropic()` per request would churn
 *   sockets and blow up the event loop under load — especially on
 *   the god-admin AI panel which can fire 5-10 requests per operator
 *   per session. A process-wide singleton keeps one TLS pool alive.
 *
 * Why does this file also own the env-var read?
 * ---------------------------------------------
 *   Three reasons:
 *     1. We want to DEFER env reads until the first request. Tests
 *        that mock `process.env` need the client to read the value
 *        at call time, not at module load.
 *     2. If `ANTHROPIC_API_KEY` is missing, we must NEVER crash the
 *        host app (god-admin, store-admin, storefront). Instead
 *        `isAiConfigured()` returns false and the caller renders a
 *        "AI not configured" stub. This is part of the graceful
 *        degradation promise in the AI spec.
 *     3. Centralising the env-var names means rotating a key or
 *        switching providers is a one-file change.
 *
 * Safety posture
 * --------------
 *   - NEVER logs the API key or any prompt/response body to stdout
 *     by default. Wire a logger via `createAiClient({ onRequest, onResponse })`
 *     if the caller wants to audit (god-admin will wire it through
 *     the audit_logs table — see advisor.ts).
 *   - NEVER retries automatically. Retries are the caller's concern
 *     because different surfaces want different UX on failure
 *     (chat panel → show error inline, batch job → exponential backoff).
 *   - Respects AI_ENABLED=false as a hard kill switch — returns the
 *     same "not configured" state so ops can pull the plug during a
 *     cost spike without redeploying.
 */

import Anthropic from '@anthropic-ai/sdk'

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

/**
 * Default model used when the caller doesn't specify one. Pinned here
 * rather than in prompt-builder files so we can swap models for the
 * entire god-admin AI panel via a single env-var override.
 *
 * Choice rationale: Claude Opus 4.6 locked in by anh Thai (2026-04-10)
 * for the god-admin AI panel, theme cloner, and every other surface.
 * The depth of multi-table synthesis and the design-fidelity of the
 * theme cloner both benefit from Opus over Sonnet; cost tradeoff is
 * accepted since these surfaces are operator-gated (not customer
 * facing). Override per surface via AI_MODEL env var if needed.
 */
export const DEFAULT_AI_MODEL = 'claude-opus-4-6'

/**
 * Default cap on response tokens. 1500 tokens ≈ 1000 English words
 * which fills the side panel on a 1440px god-admin layout without
 * needing scroll. Individual callers can override per request.
 */
export const DEFAULT_MAX_TOKENS = 1500

/**
 * Reads the AI configuration from process.env EVERY call so tests
 * can mutate env and see the change without re-importing the module.
 *
 * @returns config snapshot (all fields defined — apiKey may be '')
 */
export interface AiConfig {
  apiKey: string
  model: string
  maxTokens: number
  enabled: boolean
}

export function readAiConfig(): AiConfig {
  const rawEnabled = (process.env.AI_ENABLED ?? 'true').toLowerCase()
  return {
    apiKey: process.env.ANTHROPIC_API_KEY ?? '',
    model: process.env.AI_MODEL ?? DEFAULT_AI_MODEL,
    maxTokens: parseInt(process.env.AI_MAX_TOKENS ?? String(DEFAULT_MAX_TOKENS), 10) || DEFAULT_MAX_TOKENS,
    enabled: rawEnabled !== 'false' && rawEnabled !== '0' && rawEnabled !== 'no',
  }
}

/**
 * Is the AI panel safe to invoke? Call sites should check this before
 * rendering the chat form — if it's false, show the "AI is not
 * configured" stub card instead.
 */
export function isAiConfigured(): boolean {
  const cfg = readAiConfig()
  return cfg.enabled && cfg.apiKey.length > 0
}

// ---------------------------------------------------------------------------
// Singleton SDK client
// ---------------------------------------------------------------------------

let singleton: Anthropic | null = null
let singletonKey = '' // key that the current singleton was initialised with

/**
 * Returns the process-wide Anthropic client, creating it on first
 * call. Automatically rebuilds the client if the API key env var
 * changes (useful in tests and during zero-downtime key rotation).
 *
 * Returns null if AI is disabled or the key is missing — callers MUST
 * check for null and fall back to the "not configured" stub.
 */
export function getAiClient(): Anthropic | null {
  const cfg = readAiConfig()
  if (!cfg.enabled || !cfg.apiKey) {
    return null
  }
  if (!singleton || singletonKey !== cfg.apiKey) {
    singleton = new Anthropic({ apiKey: cfg.apiKey })
    singletonKey = cfg.apiKey
  }
  return singleton
}

// ---------------------------------------------------------------------------
// Thin request wrapper
// ---------------------------------------------------------------------------

/**
 * Single input message for a chat turn. The god-admin panel keeps a
 * short rolling history client-side and sends the last ~10 turns
 * every request so the model has context of the operator's
 * investigation without growing unbounded.
 */
export interface ChatTurn {
  role: 'user' | 'assistant'
  content: string
}

export interface SendChatOptions {
  systemPrompt: string
  messages: ChatTurn[]
  /** Override default model from env. */
  model?: string
  /** Override default max_tokens from env. */
  maxTokens?: number
  /**
   * Optional temperature. We default to 0.3 across god-admin surfaces
   * because the operator is asking factual questions about concrete
   * data (revenue, orders, fulfillment state) — creativity is
   * explicitly NOT wanted. Override per-call for other use cases.
   */
  temperature?: number
}

export interface SendChatResult {
  text: string
  usage: {
    inputTokens: number
    outputTokens: number
  }
  stopReason: string | null
}

/**
 * Fire-and-await a single chat completion. Throws if the client isn't
 * configured so the caller can convert to a user-facing error. The
 * caller is responsible for its own timeout budget — the SDK has a
 * 10-minute default which is way too long for a chat panel; wrap
 * with Promise.race if you need a tighter budget.
 *
 * Why we expose a single function rather than re-exporting
 * `client.messages.create`:
 *   - Consistent return shape across all call sites (plain text +
 *     usage counters).
 *   - One place to add observability, rate limiting, and retry logic
 *     in the future without visiting every call site.
 *   - Matches the "ports and adapters" boundary that the rest of
 *     packages/core follows — the SDK is an implementation detail.
 */
export async function sendChat(opts: SendChatOptions): Promise<SendChatResult> {
  const client = getAiClient()
  if (!client) {
    throw new Error('AI is not configured (ANTHROPIC_API_KEY missing or AI_ENABLED=false)')
  }
  const cfg = readAiConfig()
  const response = await client.messages.create({
    model: opts.model ?? cfg.model,
    max_tokens: opts.maxTokens ?? cfg.maxTokens,
    temperature: opts.temperature ?? 0.3,
    system: opts.systemPrompt,
    messages: opts.messages.map((m) => ({
      role: m.role,
      content: m.content,
    })),
  })

  // Anthropic returns content as an array of blocks (text, tool_use, ...).
  // We only use text blocks in the god-admin panel — join them so the
  // caller gets a single string.
  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n\n')

  return {
    text,
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    },
    stopReason: response.stop_reason,
  }
}

/**
 * Testing hook: resets the singleton so the next `getAiClient()`
 * picks up a fresh env snapshot. Call this from test teardown after
 * mutating process.env.ANTHROPIC_API_KEY.
 */
export function __resetAiClientForTests(): void {
  singleton = null
  singletonKey = ''
}
