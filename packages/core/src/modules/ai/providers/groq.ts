/**
 * Gbox Platform — Groq provider
 *
 * Groq serves open-weight models (Llama, Kimi, Mixtral) behind an
 * OpenAI-compatible API. We piggyback on OpenAI's request/response
 * shape and just swap the base URL + credential.
 *
 * Groq is the "fast + cheap" slot in the fallback chain. It doesn't
 * do vision at the moment, so `capabilities.vision = false` — the
 * router will skip it for screenshot requests.
 */

import {
  AIError,
  type ChatRequest,
  type ChatResponse,
  type ProviderCapabilities,
  type ProviderCredential,
  type StreamEvent,
  type TokenUsage,
} from '../types.js'
import { chatFromStream, type AIProvider } from './base.js'

const DEFAULT_BASE_URL = 'https://api.groq.com/openai/v1'

export class GroqProvider implements AIProvider {
  readonly id = 'groq' as const
  readonly capabilities: ProviderCapabilities = {
    text: true,
    vision: false, // Groq's vision models are in preview and gated
    streaming: true,
    jsonMode: true,
  }
  readonly credential: ProviderCredential

  constructor(credential: ProviderCredential) {
    if (credential.provider !== 'groq') {
      throw new Error(
        `GroqProvider requires credential.provider='groq', got '${credential.provider}'`,
      )
    }
    this.credential = credential
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    return chatFromStream(this, req)
  }

  async *chatStream(req: ChatRequest): AsyncIterable<StreamEvent> {
    const baseUrl = this.credential.baseUrl ?? DEFAULT_BASE_URL
    const body = buildGroqBody(this.credential.model, req)

    let response: Response
    try {
      response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.credential.apiKey}`,
        },
        body: JSON.stringify({ ...body, stream: true }),
        signal: req.signal,
      })
    } catch (err) {
      throw new AIError('transient', (err as Error).message, { provider: 'groq' })
    }

    if (!response.ok) {
      throw await mapGroqError(response)
    }

    if (!response.body) {
      throw new AIError('transient', 'Groq returned no body', { provider: 'groq' })
    }

    yield* parseGroqStream(response.body)
  }
}

// ---------------------------------------------------------------------------
// Body builder (OpenAI-compatible)
// ---------------------------------------------------------------------------

interface GroqRequestBody {
  model: string
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
  max_tokens: number
  temperature: number
  response_format?: { type: 'json_object' }
}

function buildGroqBody(model: string, req: ChatRequest): GroqRequestBody {
  const messages: GroqRequestBody['messages'] = []

  if (req.system) messages.push({ role: 'system', content: req.system })

  for (const msg of req.messages) {
    // Groq is text-only for our purposes — flatten any image blocks
    messages.push({
      role: msg.role,
      content: flattenContent(msg.content),
    })
  }

  return {
    model,
    messages,
    max_tokens: req.maxTokens ?? 2000,
    temperature: req.temperature ?? 0.3,
    ...(req.jsonMode ? { response_format: { type: 'json_object' as const } } : {}),
  }
}

function flattenContent(content: string | readonly any[]): string {
  if (typeof content === 'string') return content
  return content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

async function mapGroqError(response: Response): Promise<AIError> {
  let bodyText = ''
  try {
    bodyText = await response.text()
  } catch {
    /* non-fatal */
  }

  const trimmed = bodyText.slice(0, 500)
  const status = response.status

  if (status === 401 || status === 403) {
    return new AIError('auth', `Groq auth failed (${status}): ${trimmed}`, {
      provider: 'groq',
      statusCode: status,
    })
  }
  if (status === 429) {
    return new AIError('rate_limit', `Groq rate limit: ${trimmed}`, {
      provider: 'groq',
      statusCode: status,
    })
  }
  if (status === 400) {
    return new AIError('invalid_input', `Groq bad request: ${trimmed}`, {
      provider: 'groq',
      statusCode: status,
    })
  }
  if (status >= 500 && status < 600) {
    return new AIError('transient', `Groq 5xx: ${trimmed}`, {
      provider: 'groq',
      statusCode: status,
    })
  }
  return new AIError('unknown', `Groq ${status}: ${trimmed}`, {
    provider: 'groq',
    statusCode: status,
  })
}

// ---------------------------------------------------------------------------
// SSE parser (OpenAI-compatible)
// ---------------------------------------------------------------------------

async function* parseGroqStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<StreamEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let promptTokens = 0
  let completionTokens = 0
  let finishReason: 'stop' | 'length' | 'error' | 'cancelled' = 'stop'

  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      let sepIdx: number
      while ((sepIdx = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, sepIdx)
        buffer = buffer.slice(sepIdx + 2)
        const data = extractDataLine(block)
        if (!data) continue
        if (data === '[DONE]') continue

        let payload: any
        try {
          payload = JSON.parse(data)
        } catch {
          continue
        }

        const choice = payload.choices?.[0]
        const deltaText = choice?.delta?.content
        if (typeof deltaText === 'string' && deltaText.length > 0) {
          yield { type: 'text', delta: deltaText }
        }
        const reason = choice?.finish_reason
        if (reason === 'stop') finishReason = 'stop'
        else if (reason === 'length') finishReason = 'length'

        // Groq includes x_groq.usage on the final chunk.
        const usage = payload.x_groq?.usage ?? payload.usage
        if (usage) {
          promptTokens = usage.prompt_tokens ?? promptTokens
          completionTokens = usage.completion_tokens ?? completionTokens
        }
      }
    }
  } finally {
    reader.releaseLock()
  }

  const usage: TokenUsage = {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
  }

  yield { type: 'done', usage, finishReason }
}

function extractDataLine(block: string): string | null {
  for (const line of block.split('\n')) {
    if (line.startsWith('data: ')) return line.slice(6).trim()
    if (line.startsWith('data:')) return line.slice(5).trim()
  }
  return null
}
