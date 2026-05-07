/**
 * Clone Pro v6 — BYOK pre-flight ping helper
 *
 * Fires a $0.0001 verify ping against an AI provider's API endpoint.
 * Used by runPreflight (Task 4) and the settings POST handler (Task 6)
 * to confirm a seller's API key is valid before starting a clone job.
 *
 * Iron Rule 5: `error` is seller-safe (status code only).
 * `raw` is server-side only — never surface to sellers.
 *
 * No retries, no circuit breakers — this is a pure single-shot ping.
 * Retry policy is the caller's responsibility.
 */

export type AIProvider = 'anthropic' | 'openai' | 'google'

export interface PingProviderInput {
  provider: AIProvider
  apiKey: string
  model: string
  fetch?: typeof globalThis.fetch
}

export interface PingProviderResult {
  ok: boolean
  /** Sanitized; safe to surface to seller as "API key is no longer valid (last error: <error>)" */
  error?: string
  /** For support log only — NEVER expose to sellers */
  raw?: unknown
}

// ---------------------------------------------------------------------------
// Provider endpoint registry
// ---------------------------------------------------------------------------

const ENDPOINTS: Record<
  AIProvider,
  (model: string) => { url: string; build: (apiKey: string) => RequestInit }
> = {
  anthropic: () => ({
    url: 'https://api.anthropic.com/v1/messages',
    build: (apiKey) => ({
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        // Always ping with Haiku regardless of seller's work model:
        // cheapest verification cost (~$0.0001 per ping).
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ok' }],
      }),
    }),
  }),

  openai: () => ({
    url: 'https://api.openai.com/v1/chat/completions',
    build: (apiKey) => ({
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        // Always ping with the cheapest model tier regardless of seller's
        // work model — but use gpt-5 as the spec's canonical ping model.
        model: 'gpt-5',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ok' }],
      }),
    }),
  }),

  google: (model) => ({
    // Google's endpoint is model-path-based so we use the seller's model.
    url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    build: (apiKey) => ({
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: 'ok' }] }],
        generationConfig: { maxOutputTokens: 1 },
      }),
    }),
  }),
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function pingProvider(input: PingProviderInput): Promise<PingProviderResult> {
  const fetchImpl = input.fetch ?? globalThis.fetch
  const cfg = ENDPOINTS[input.provider](input.model)
  const init = cfg.build(input.apiKey)

  try {
    const res = await fetchImpl(cfg.url, init)
    if (res.ok) {
      return { ok: true }
    }
    const body = await res.json().catch(() => ({}))
    return {
      ok: false,
      // Iron Rule 5: status code only in the seller-visible error field.
      // Raw provider message (which can contain account internals) lives
      // only in `raw` — server-side diagnostic, never forwarded to UI.
      error: `${res.status} ${res.statusText || 'error'}`,
      raw: body,
    }
  } catch (err) {
    return { ok: false, error: 'network_error', raw: err }
  }
}
