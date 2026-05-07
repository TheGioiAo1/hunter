/**
 * Gbox Platform — AI provider interface
 *
 * Every concrete provider (Anthropic, OpenAI, Google, Groq) implements
 * this interface. The router consumes it and never knows which vendor
 * answered — that's the whole point.
 *
 * A provider promises two things:
 *
 *   chat(req)        → one-shot ChatResponse. Internally this is
 *                      implemented by draining `chatStream` and
 *                      accumulating text; providers that expose a
 *                      non-streaming endpoint can short-circuit.
 *
 *   chatStream(req)  → async iterator of StreamEvent. Text deltas
 *                      arrive in `text` events; the terminal `done`
 *                      event carries usage numbers the cost tracker
 *                      reads.
 *
 * Implementations MUST:
 *
 *   - Honour `req.signal` (AbortSignal) for cancellation.
 *   - Map HTTP errors onto `AIError` with the right `kind` so the
 *     router can pick retry vs. fallback.
 *   - Never log the API key, prompt, or response body.
 *
 * Implementations MUST NOT:
 *
 *   - Persist anything (cost records are the router's job).
 *   - Know about shops, tenants, or budgets — this layer is tenant-blind.
 */

import type {
  AIProviderId,
  ChatRequest,
  ChatResponse,
  ProviderCapabilities,
  ProviderCredential,
  StreamEvent,
} from '../types.js'

/**
 * The minimal surface every provider exposes. Both methods take a
 * fully-formed `ChatRequest`; the router is responsible for resolving
 * provider/model before calling.
 */
export interface AIProvider {
  /** Stable identifier used by the router to route and by cost records. */
  readonly id: AIProviderId
  /** What this provider can do today. Callers check before picking. */
  readonly capabilities: ProviderCapabilities
  /** Resolved credential (decrypted key + model pin). */
  readonly credential: ProviderCredential

  /** Single-response chat. Blocking — caller waits for the whole thing. */
  chat(req: ChatRequest): Promise<ChatResponse>

  /** Streaming chat. Yields text deltas, terminates with one `done` event. */
  chatStream(req: ChatRequest): AsyncIterable<StreamEvent>
}

/**
 * A non-streaming helper that every provider reuses: drain the
 * stream, accumulate text, and synthesize a `ChatResponse` from the
 * terminal `done` event.
 *
 * Providers can override `chat()` if they expose a cheaper
 * non-streaming endpoint, but this default keeps the implementation
 * footprint small.
 */
export async function chatFromStream(
  provider: AIProvider,
  req: ChatRequest,
): Promise<ChatResponse> {
  const startedAt = Date.now()
  const chunks: string[] = []
  let usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
  let finishReason: ChatResponse['finishReason'] = 'stop'

  for await (const event of provider.chatStream(req)) {
    if (event.type === 'text') {
      chunks.push(event.delta)
    } else if (event.type === 'error') {
      finishReason = 'error'
      // Provider impls throw on fatal errors; an error event here is
      // informational — the caller chose not to abort, so we just
      // record the finish reason and stop accumulating.
      break
    } else if (event.type === 'done') {
      usage = event.usage
      finishReason = event.finishReason
    }
  }

  return {
    provider: provider.id,
    model: provider.credential.model,
    text: chunks.join(''),
    usage,
    finishReason,
    durationMs: Date.now() - startedAt,
  }
}
