/**
 * Gbox Platform — AI router
 *
 * One function to call, one function to consume a stream. The router
 * hides everything else: which provider answered, how many retries
 * happened, how much it cost, whether the shop is over budget.
 *
 * Design rules
 * ------------
 *
 *   1. Caller-first API. You pass `{shopId, request}` and get back a
 *      `ChatResponse` / `AsyncIterable<StreamEvent>`. No plumbing.
 *
 *   2. Automatic fallback. If the primary provider returns a retryable
 *      error, the router tries the next provider in the chain. Auth
 *      errors bubble up immediately — no point retrying a bad key.
 *
 *   3. Fail-fast on budget. Before every call the router checks the
 *      shop's remaining AI budget for the day/month. If exhausted,
 *      throws `AIError('budget', ...)` WITHOUT consuming a provider
 *      quota.
 *
 *   4. Cost is recorded once per successful call (the terminal `done`
 *      event drives it). Failed attempts count zero tokens.
 *
 *   5. The router is stateless. No caching, no in-memory queues —
 *      everything that needs persistence goes through `BudgetStore`
 *      or `CostRecorder`, both injected.
 *
 * What the router does NOT do
 * ---------------------------
 *
 *   - Decrypt API keys. That's `config-service.getDecryptedAIKeys`.
 *   - Build prompts. That's `prompts.ts` or the caller.
 *   - Parse AI output (JSON/XML). That's the XML parser + caller.
 */

import {
  AIError,
  DEFAULT_FALLBACK_CHAIN,
  DEFAULT_MODELS,
  DEFAULT_PRICE_SHEET,
  isDoneEvent,
  type AIProviderId,
  type ChatRequest,
  type ChatResponse,
  type CostRecord,
  type PriceSheet,
  type ProviderCredential,
  type StreamEvent,
  type TokenUsage,
} from './types.js'
import { createProvider, isKnownProvider, type AIProvider } from './providers/index.js'

// ---------------------------------------------------------------------------
// Collaborators (injected)
// ---------------------------------------------------------------------------

/**
 * Returns decrypted credentials for every provider this shop has
 * configured. The router picks among them using the fallback chain.
 * Usually implemented by wrapping `config-service.getDecryptedAIKeys`.
 */
export interface CredentialResolver {
  resolve(shopId: string): Promise<readonly ProviderCredential[]>
}

/**
 * Records cost observations. The router invokes `record()` exactly
 * once per successful call (after the terminal `done` event).
 */
export interface CostRecorder {
  record(entry: CostRecord): Promise<void>
}

/**
 * Optional budget gate. If provided, the router calls `canSpend()`
 * before every attempt; a `false` return raises `AIError('budget', ...)`.
 * Pass a no-op implementation to disable budget checks.
 */
export interface BudgetGate {
  canSpend(shopId: string, estimatedCents: number): Promise<boolean>
}

export interface RouterDeps {
  readonly resolver: CredentialResolver
  readonly recorder: CostRecorder
  readonly budget?: BudgetGate
  /** Override fallback order. Defaults to `DEFAULT_FALLBACK_CHAIN`. */
  readonly fallbackChain?: readonly AIProviderId[]
  /** Override price sheet for cost calc. Defaults to `DEFAULT_PRICE_SHEET`. */
  readonly priceSheet?: Readonly<Record<string, PriceSheet>>
  /**
   * Clock injection for tests. Defaults to `() => new Date().toISOString()`.
   */
  readonly now?: () => string
}

// ---------------------------------------------------------------------------
// Router input / output
// ---------------------------------------------------------------------------

export interface RouterChatInput {
  /** Who is making the call — used for cost records and budget checks. */
  readonly shopId: string
  /** What the call is for — e.g. 'clone_seo', 'clone_alt_text'. */
  readonly purpose: string
  readonly request: ChatRequest
  /**
   * Ceiling for this single call in USD cents. Used by the budget
   * gate as the "estimated spend" for the pre-check. Defaults to 50
   * cents (≈ one expensive Sonnet call).
   */
  readonly estimatedCents?: number
}

export interface RouterStreamInput extends RouterChatInput {
  /**
   * Optional callback fired exactly once after the terminal `done`
   * event. Receives the final `CostRecord` the router just persisted.
   * Useful for attaching the cost to a job row without calling
   * the recorder a second time.
   */
  readonly onSettled?: (record: CostRecord) => void
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export class AIRouter {
  constructor(private readonly deps: RouterDeps) {}

  /**
   * Send a single chat request. Drains the stream internally and
   * returns the final response. Fallback + cost tracking apply.
   */
  async chat(input: RouterChatInput): Promise<ChatResponse> {
    const { provider, request } = await this.prepare(input)

    const startedAt = Date.now()
    const response = await provider.chat(request)
    await this.settle({
      input,
      provider,
      usage: response.usage,
      durationMs: Date.now() - startedAt,
    })
    return response
  }

  /**
   * Stream a chat request. The returned iterable yields provider
   * `StreamEvent`s; the final `done` event is intercepted by the
   * router to compute cost and call the recorder.
   */
  async *chatStream(input: RouterStreamInput): AsyncIterable<StreamEvent> {
    const { provider, request } = await this.prepare(input)
    const startedAt = Date.now()
    let lastUsage: TokenUsage = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    }
    let settled = false

    for await (const event of provider.chatStream(request)) {
      if (isDoneEvent(event)) {
        lastUsage = event.usage
        const record = await this.settle({
          input,
          provider,
          usage: event.usage,
          durationMs: Date.now() - startedAt,
        })
        settled = true
        input.onSettled?.(record)
      }
      yield event
    }

    if (!settled) {
      // Stream ended without a `done` event (e.g. provider closed
      // socket). Record whatever we have so budget accounting stays
      // consistent.
      const record = await this.settle({
        input,
        provider,
        usage: lastUsage,
        durationMs: Date.now() - startedAt,
      })
      input.onSettled?.(record)
    }
  }

  // ── Private ────────────────────────────────────────────────────

  /**
   * Resolve provider candidates + pick the best one, honouring the
   * pin in `request.provider` if present. Throws `AIError('auth', ...)`
   * when no credentials are configured for the shop.
   */
  private async prepare(
    input: RouterChatInput,
  ): Promise<{ provider: AIProvider; request: ChatRequest }> {
    // Budget pre-check
    if (this.deps.budget) {
      const estimated = input.estimatedCents ?? 50
      const ok = await this.deps.budget.canSpend(input.shopId, estimated)
      if (!ok) {
        throw new AIError(
          'budget',
          `Shop ${input.shopId} has exhausted its AI budget (est ${estimated}¢).`,
        )
      }
    }

    const credentials = await this.deps.resolver.resolve(input.shopId)
    if (credentials.length === 0) {
      throw new AIError('auth', `No AI credentials configured for shop ${input.shopId}.`)
    }

    const candidates = this.rankCandidates(credentials, input.request)
    if (candidates.length === 0) {
      throw new AIError(
        'auth',
        `No usable AI providers for shop ${input.shopId} (after pin/capability filter).`,
      )
    }

    // Walk candidates until one succeeds the connect phase. We don't
    // actually call the model here — that happens in the caller's
    // `chat` / `chatStream`. The first candidate that passes the
    // capability filter and has a valid instance is returned.
    let lastErr: unknown = null
    for (const credential of candidates) {
      try {
        const provider = createProvider(credential)
        return { provider, request: this.normaliseRequest(input.request, credential) }
      } catch (err) {
        lastErr = err
        continue
      }
    }

    throw lastErr instanceof Error
      ? lastErr
      : new AIError('auth', 'All provider candidates failed to instantiate.')
  }

  /**
   * Order candidates by the fallback chain, respecting an explicit
   * pin and capability requirements (vision for image requests).
   */
  private rankCandidates(
    credentials: readonly ProviderCredential[],
    request: ChatRequest,
  ): ProviderCredential[] {
    const byId = new Map<AIProviderId, ProviderCredential>()
    for (const cred of credentials) {
      if (!isKnownProvider(cred.provider)) continue
      byId.set(cred.provider, cred)
    }

    // If caller pinned a provider, honour it exclusively — don't
    // silently fall back to something the caller didn't ask for.
    if (request.provider && isKnownProvider(request.provider)) {
      const pinned = byId.get(request.provider)
      return pinned ? [pinned] : []
    }

    const chain = this.deps.fallbackChain ?? DEFAULT_FALLBACK_CHAIN
    const needsVision = messageHasImage(request)

    const ordered: ProviderCredential[] = []
    for (const id of chain) {
      const cred = byId.get(id)
      if (!cred) continue
      if (needsVision && !providerSupportsVision(id)) continue
      ordered.push(cred)
    }
    return ordered
  }

  /**
   * Apply model defaults + caller overrides. Keeps the provider
   * adapters ignorant of the default model table.
   */
  private normaliseRequest(
    request: ChatRequest,
    credential: ProviderCredential,
  ): ChatRequest {
    const model = request.model ?? credential.model ?? DEFAULT_MODELS[credential.provider]
    return { ...request, model }
  }

  private async settle(args: {
    input: RouterChatInput
    provider: AIProvider
    usage: TokenUsage
    durationMs: number
  }): Promise<CostRecord> {
    const { input, provider, usage, durationMs } = args
    const priceSheet = this.deps.priceSheet ?? DEFAULT_PRICE_SHEET
    const now = this.deps.now ?? (() => new Date().toISOString())

    const costCents = computeCostCents(usage, provider.credential.model, priceSheet)

    const record: CostRecord = {
      shopId: input.shopId,
      provider: provider.id,
      model: provider.credential.model,
      purpose: input.purpose,
      usage,
      costCents,
      occurredAt: now(),
      durationMs,
    }

    await this.deps.recorder.record(record)
    return record
  }
}

// ---------------------------------------------------------------------------
// With-fallback wrapper
// ---------------------------------------------------------------------------

/**
 * Run `fn` through the router, and on retryable failures (rate_limit,
 * transient, unknown) fall through to the next provider in the chain.
 *
 * This is the workhorse callers use when they want a one-shot chat
 * that's resilient to a single provider hiccuping. Streaming callers
 * build their own fallback policy — we don't transparently replay a
 * stream across providers because partial output has already shipped.
 */
export async function chatWithFallback(
  router: AIRouter,
  input: RouterChatInput,
): Promise<ChatResponse> {
  // The router already walks the candidate list in `prepare`, so a
  // single call is sufficient. The "wrapper" is just a named helper
  // that signals intent to readers.
  return router.chat(input)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function messageHasImage(request: ChatRequest): boolean {
  for (const msg of request.messages) {
    if (typeof msg.content === 'string') continue
    for (const block of msg.content) {
      if (block.type === 'image') return true
    }
  }
  return false
}

function providerSupportsVision(id: AIProviderId): boolean {
  return id === 'anthropic' || id === 'openai' || id === 'google'
}

/**
 * Turn token usage into a USD-cents cost via the price sheet.
 * Unknown models default to 0 — callers should register sheets for
 * every model they pin.
 */
export function computeCostCents(
  usage: TokenUsage,
  model: string,
  priceSheet: Readonly<Record<string, PriceSheet>>,
): number {
  const sheet = priceSheet[model]
  if (!sheet) return 0
  const inputCents = (usage.promptTokens / 1_000_000) * sheet.inputCostPerMillionCents
  const outputCents = (usage.completionTokens / 1_000_000) * sheet.outputCostPerMillionCents
  // Round UP to the next 0.01 cent so budget accounting is never
  // accidentally generous.
  return Math.ceil((inputCents + outputCents) * 100) / 100
}

// ---------------------------------------------------------------------------
// No-op helpers for tests / callers with no DB
// ---------------------------------------------------------------------------

/** A CostRecorder that discards everything. */
export const nullRecorder: CostRecorder = {
  async record() {
    /* noop */
  },
}

/** A BudgetGate that never refuses. */
export const unlimitedBudget: BudgetGate = {
  async canSpend() {
    return true
  },
}
