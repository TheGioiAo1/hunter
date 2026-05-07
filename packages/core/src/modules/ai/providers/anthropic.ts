/**
 * Gbox Platform — Anthropic provider
 *
 * Thin adapter over the Anthropic Messages API
 * (https://docs.anthropic.com/en/api/messages). Streams via SSE when
 * the caller uses `chatStream`, otherwise blocks for the full
 * response.
 *
 * Why not the `@anthropic-ai/sdk` package?
 *
 *   This is the `@gbox/core` package which must run on Cloudflare
 *   Workers (no `fs`, no `node:*` beyond `crypto`). The Anthropic SDK
 *   pulls in Node-only deps; a hand-written fetch path keeps us
 *   worker-compatible and dependency-free.
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

const DEFAULT_BASE_URL = 'https://api.anthropic.com/v1'
const API_VERSION = '2023-06-01'

export class AnthropicProvider implements AIProvider {
  readonly id = 'anthropic' as const
  readonly capabilities: ProviderCapabilities = {
    text: true,
    vision: true,
    streaming: true,
    jsonMode: false, // Anthropic has no native JSON mode; we hint via prompt.
  }
  readonly credential: ProviderCredential

  constructor(credential: ProviderCredential) {
    if (credential.provider !== 'anthropic') {
      throw new Error(
        `AnthropicProvider requires credential.provider='anthropic', got '${credential.provider}'`,
      )
    }
    this.credential = credential
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    return chatFromStream(this, req)
  }

  async *chatStream(req: ChatRequest): AsyncIterable<StreamEvent> {
    const baseUrl = this.credential.baseUrl ?? DEFAULT_BASE_URL
    const body = buildAnthropicBody(this.credential.model, req)

    let response: Response
    try {
      response = await fetch(`${baseUrl}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.credential.apiKey,
          'anthropic-version': API_VERSION,
        },
        body: JSON.stringify({ ...body, stream: true }),
        signal: req.signal,
      })
    } catch (err) {
      throw new AIError('transient', (err as Error).message, { provider: 'anthropic' })
    }

    if (!response.ok) {
      throw await mapAnthropicError(response)
    }

    if (!response.body) {
      throw new AIError('transient', 'Anthropic returned no body', { provider: 'anthropic' })
    }

    yield* parseAnthropicStream(response.body)
  }
}

// ---------------------------------------------------------------------------
// Body builder
// ---------------------------------------------------------------------------

interface AnthropicRequestBody {
  model: string
  system?: string
  max_tokens: number
  temperature: number
  messages: AnthropicMessage[]
}

interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: string | AnthropicBlock[]
}

type AnthropicBlock =
  | { type: 'text'; text: string }
  | {
      type: 'image'
      source: { type: 'base64'; media_type: string; data: string }
    }

function buildAnthropicBody(model: string, req: ChatRequest): AnthropicRequestBody {
  const messages: AnthropicMessage[] = []
  for (const msg of req.messages) {
    if (msg.role === 'system') continue // Anthropic takes system separately
    messages.push({
      role: msg.role,
      content:
        typeof msg.content === 'string'
          ? msg.content
          : msg.content.map(mapBlock),
    })
  }

  return {
    model,
    system: req.system,
    max_tokens: req.maxTokens ?? 2000,
    temperature: req.temperature ?? 0.3,
    messages,
  }
}

function mapBlock(block: { type: 'text'; text: string } | {
  type: 'image'
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp'
  base64: string
}): AnthropicBlock {
  if (block.type === 'text') return { type: 'text', text: block.text }
  return {
    type: 'image',
    source: { type: 'base64', media_type: block.mediaType, data: block.base64 },
  }
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

async function mapAnthropicError(response: Response): Promise<AIError> {
  let bodyText = ''
  try {
    bodyText = await response.text()
  } catch {
    /* non-fatal */
  }

  const trimmed = bodyText.slice(0, 500)
  const status = response.status

  if (status === 401 || status === 403) {
    return new AIError('auth', `Anthropic auth failed (${status}): ${trimmed}`, {
      provider: 'anthropic',
      statusCode: status,
    })
  }
  if (status === 429) {
    return new AIError('rate_limit', `Anthropic rate limit: ${trimmed}`, {
      provider: 'anthropic',
      statusCode: status,
    })
  }
  if (status === 400) {
    return new AIError('invalid_input', `Anthropic bad request: ${trimmed}`, {
      provider: 'anthropic',
      statusCode: status,
    })
  }
  if (status >= 500 && status < 600) {
    return new AIError('transient', `Anthropic 5xx: ${trimmed}`, {
      provider: 'anthropic',
      statusCode: status,
    })
  }
  return new AIError('unknown', `Anthropic ${status}: ${trimmed}`, {
    provider: 'anthropic',
    statusCode: status,
  })
}

// ---------------------------------------------------------------------------
// SSE parser
// ---------------------------------------------------------------------------

/**
 * Anthropic's SSE dialect:
 *
 *   event: content_block_delta
 *   data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}
 *
 *   event: message_delta
 *   data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":123}}
 *
 *   event: message_stop
 *   data: {"type":"message_stop"}
 *
 * We accumulate usage from `message_start` (input_tokens) and
 * `message_delta` (output_tokens), then emit one `done` event on
 * `message_stop`.
 */
async function* parseAnthropicStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<StreamEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let promptTokens = 0
  let completionTokens = 0
  let finishReason: StreamEvent & { type: 'done' } extends { finishReason: infer R }
    ? R
    : never = 'stop' as any

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
        if (!data || data === '[DONE]') continue

        let payload: any
        try {
          payload = JSON.parse(data)
        } catch {
          continue
        }

        if (payload.type === 'content_block_delta') {
          const text = payload.delta?.text
          if (typeof text === 'string' && text.length > 0) {
            yield { type: 'text', delta: text }
          }
        } else if (payload.type === 'message_start') {
          const usage = payload.message?.usage
          if (usage?.input_tokens) promptTokens = usage.input_tokens
          if (usage?.output_tokens) completionTokens = usage.output_tokens
        } else if (payload.type === 'message_delta') {
          if (payload.usage?.output_tokens) {
            completionTokens = payload.usage.output_tokens
          }
          const reason = payload.delta?.stop_reason
          if (reason === 'end_turn' || reason === 'stop_sequence') {
            finishReason = 'stop' as any
          } else if (reason === 'max_tokens') {
            finishReason = 'length' as any
          }
        } else if (payload.type === 'message_stop') {
          // Terminal event — flush below.
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

  yield { type: 'done', usage, finishReason: finishReason as any }
}

/**
 * SSE blocks look like:
 *   event: content_block_delta
 *   data: {"type":"..."}
 *
 * Extract the JSON payload from the `data:` line (Anthropic only
 * sends single-line JSON, never multi-line).
 */
function extractDataLine(block: string): string | null {
  for (const line of block.split('\n')) {
    if (line.startsWith('data: ')) {
      return line.slice(6).trim()
    }
    if (line.startsWith('data:')) {
      return line.slice(5).trim()
    }
  }
  return null
}
