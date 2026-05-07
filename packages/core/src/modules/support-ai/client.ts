/**
 * Gbox Platform — support-ai Anthropic SDK adapter (Phase 12.5 PR4).
 *
 * Thin wrapper around the Anthropic Messages API, purpose-built for
 * support tickets. Reuses Phase 10's singleton SDK client (in
 * packages/core/src/modules/ai/client.ts) when it's available and
 * its env-configured key happens to be the one we want; otherwise
 * builds a dedicated support-only client from the key god admin
 * pasted into /god-admin/settings/ai.
 *
 * Why a separate file from phase-10 client.ts?
 *
 *   1. Phase 10 reads `ANTHROPIC_API_KEY` from env. Phase 12.5 reads
 *      the key from `platform_settings.ai_anthropic_api_key` so Thai
 *      can rotate it without a redeploy. We DON'T want the env var
 *      path bleeding into the support runtime.
 *
 *   2. Phase 10 returns a Sonnet-4.5-only pinned client. Phase 12.5
 *      needs to switch models per-invocation (Sonnet for 90%, Opus
 *      for high-stakes). A dedicated adapter lets us pass `model`
 *      through without polluting Phase 10's signature.
 *
 *   3. Failure modes. Phase 10 `sendChat()` throws a generic Error
 *      on network failure. Phase 12.5 callers need to distinguish
 *      rate-limit, auth failure, and content-policy violations so
 *      the UI can show different copy. This file maps the SDK error
 *      shape to `SupportAIError` once, upstream stays clean.
 *
 *   4. Instrumentation. Every call here writes a `support_ai_usage`
 *      row. Phase 10's client.ts is unaware of that table.
 *
 * What we DO NOT reimplement:
 *   - The Anthropic SDK itself. Import `Anthropic` from
 *     `@anthropic-ai/sdk` directly.
 *   - The singleton caching. We build a client per request — the
 *     key may have just rotated via /god-admin/settings/ai, and the
 *     Anthropic SDK's internal TLS pool is cheap to recreate.
 *     Revisit the singleton if we see latency regressions.
 */

import Anthropic from '@anthropic-ai/sdk'
import type { SupportAiModel } from './pick-model.ts'
import { ANTHROPIC_SKU } from './pick-model.ts'

/**
 * Typed error thrown when the Anthropic call fails. The `kind`
 * discriminator lets callers render different UI copy without
 * parsing error strings.
 *
 * `transient` == retryable on same key (rate limit, 500, transient
 *                network glitch)
 * `auth`      == bad/expired key; god admin must re-paste
 * `policy`    == Anthropic content policy blocked the prompt —
 *                caller should show "can't generate this" and
 *                offer the canned replies list instead
 * `unknown`   == everything else; log + fail loudly
 */
export type SupportAIErrorKind = 'transient' | 'auth' | 'policy' | 'unknown'

export class SupportAIError extends Error {
  readonly kind: SupportAIErrorKind
  readonly statusCode: number | null
  constructor(kind: SupportAIErrorKind, message: string, statusCode?: number) {
    super(message)
    this.name = 'SupportAIError'
    this.kind = kind
    this.statusCode = statusCode ?? null
  }
}

/**
 * Per-invocation request shape. Intentionally slim — the router
 * in this phase doesn't need streaming / tool-use / vision.
 */
export interface SendSupportChatInput {
  /** Decrypted Anthropic key (already fetched from platform_settings). */
  readonly apiKey: string
  /** Semantic model id — ANTHROPIC_SKU maps to the Anthropic SKU. */
  readonly model: SupportAiModel
  /** System instructions. Built by the calling surface (suggest-reply, etc.). */
  readonly system: string
  /** The conversation turns. */
  readonly messages: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>
  /** Hard cap on completion length. Default 800 — enough for a ticket reply. */
  readonly maxTokens?: number
  /** 0..1. Default 0.3 — deterministic-leaning so similar tickets get similar replies. */
  readonly temperature?: number
  /** Optional AbortSignal (god admin cancels in-flight suggestion). */
  readonly signal?: AbortSignal
}

export interface SendSupportChatResult {
  readonly text: string
  readonly inputTokens: number
  readonly outputTokens: number
  readonly stopReason: string | null
}

const DEFAULT_MAX_TOKENS = 800
const DEFAULT_TEMPERATURE = 0.3

/**
 * Fire one Anthropic call and return the plain-text completion +
 * token usage. Throws SupportAIError on any failure.
 *
 * Creates a fresh `Anthropic` client per call deliberately — see
 * the comment on §3 above.
 */
export async function sendSupportChat(
  input: SendSupportChatInput,
): Promise<SendSupportChatResult> {
  if (!input.apiKey) {
    throw new SupportAIError('auth', 'Missing Anthropic API key')
  }
  const client = new Anthropic({ apiKey: input.apiKey })

  try {
    const response = await client.messages.create(
      {
        model: ANTHROPIC_SKU[input.model],
        max_tokens: input.maxTokens ?? DEFAULT_MAX_TOKENS,
        temperature: input.temperature ?? DEFAULT_TEMPERATURE,
        system: input.system,
        messages: input.messages.map((m) => ({
          role: m.role,
          content: m.content,
        })),
      },
      input.signal ? { signal: input.signal } : undefined,
    )

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('\n\n')

    return {
      text,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      stopReason: response.stop_reason,
    }
  } catch (err) {
    throw mapAnthropicError(err)
  }
}

/**
 * Map an SDK error or arbitrary exception to SupportAIError. The
 * Anthropic SDK throws a few known error classes at runtime; we
 * check for shapes rather than importing SDK-private types so a
 * minor-version SDK bump doesn't break the mapping.
 *
 * Exported so unit tests can assert the mapping without network.
 */
export function mapAnthropicError(err: unknown): SupportAIError {
  // Known shape: { status, message, error?: { type } }
  const e = err as { status?: number; message?: string; error?: { type?: string } } | undefined
  const status = e?.status ?? null
  const msg = e?.message ?? 'Unknown Anthropic error'

  if (status === 401 || status === 403) {
    return new SupportAIError('auth', msg, status)
  }
  if (status === 429) {
    return new SupportAIError('transient', msg, status)
  }
  if (status !== null && status >= 500 && status < 600) {
    return new SupportAIError('transient', msg, status)
  }
  const errorType = e?.error?.type
  if (errorType === 'content_filter' || errorType === 'content_policy_violation') {
    return new SupportAIError('policy', msg, status ?? undefined)
  }
  return new SupportAIError('unknown', msg, status ?? undefined)
}
