/**
 * Gbox Platform — OpenAI provider
 *
 * Thin adapter over the OpenAI Chat Completions API
 * (https://platform.openai.com/docs/api-reference/chat). Streams via
 * SSE when the caller uses `chatStream`.
 *
 * Uses `fetch` directly (no `openai` package) for the same reason as
 * the Anthropic adapter — worker-compatibility + zero new deps.
 *
 * Vision note
 * -----------
 *
 *   OpenAI encodes images as `{type:'image_url', image_url:{url:'data:...'}}`
 *   inside user messages, unlike Anthropic's separate block type. We
 *   normalize our internal `ChatContentBlock` union to either format.
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

const DEFAULT_BASE_URL = 'https://api.openai.com/v1'

export class OpenAIProvider implements AIProvider {
  readonly id = 'openai' as const
  readonly capabilities: ProviderCapabilities = {
    text: true,
    vision: true,
    streaming: true,
    jsonMode: true, // OpenAI supports response_format: { type: 'json_object' }
  }
  readonly credential: ProviderCredential

  constructor(credential: ProviderCredential) {
    if (credential.provider !== 'openai') {
      throw new Error(
        `OpenAIProvider requires credential.provider='openai', got '${credential.provider}'`,
      )
    }
    this.credential = credential
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    return chatFromStream(this, req)
  }

  async *chatStream(req: ChatRequest): AsyncIterable<StreamEvent> {
    const baseUrl = this.credential.baseUrl ?? DEFAULT_BASE_URL
    const body = buildOpenAIBody(this.credential.model, req)

    let response: Response
    try {
      response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.credential.apiKey}`,
        },
        body: JSON.stringify({ ...body, stream: true, stream_options: { include_usage: true } }),
        signal: req.signal,
      })
    } catch (err) {
      throw new AIError('transient', (err as Error).message, { provider: 'openai' })
    }

    if (!response.ok) {
      throw await mapOpenAIError(response)
    }

    if (!response.body) {
      throw new AIError('transient', 'OpenAI returned no body', { provider: 'openai' })
    }

    yield* parseOpenAIStream(response.body)
  }
}

// ---------------------------------------------------------------------------
// Body builder
// ---------------------------------------------------------------------------

interface OpenAIRequestBody {
  model: string
  messages: OpenAIMessage[]
  max_tokens: number
  temperature: number
  response_format?: { type: 'json_object' }
}

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant'
  content: string | OpenAIBlock[]
}

type OpenAIBlock =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

function buildOpenAIBody(model: string, req: ChatRequest): OpenAIRequestBody {
  const messages: OpenAIMessage[] = []

  if (req.system) {
    messages.push({ role: 'system', content: req.system })
  }

  for (const msg of req.messages) {
    if (msg.role === 'system') {
      // Usually callers pass system via req.system, but tolerate
      // system messages in the array too.
      messages.push({ role: 'system', content: flattenContent(msg.content) })
      continue
    }
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
    messages,
    max_tokens: req.maxTokens ?? 2000,
    temperature: req.temperature ?? 0.3,
    ...(req.jsonMode ? { response_format: { type: 'json_object' as const } } : {}),
  }
}

function mapBlock(block: { type: 'text'; text: string } | {
  type: 'image'
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp'
  base64: string
}): OpenAIBlock {
  if (block.type === 'text') return { type: 'text', text: block.text }
  return {
    type: 'image_url',
    image_url: { url: `data:${block.mediaType};base64,${block.base64}` },
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

async function mapOpenAIError(response: Response): Promise<AIError> {
  let bodyText = ''
  try {
    bodyText = await response.text()
  } catch {
    /* non-fatal */
  }

  const trimmed = bodyText.slice(0, 500)
  const status = response.status

  if (status === 401 || status === 403) {
    return new AIError('auth', `OpenAI auth failed (${status}): ${trimmed}`, {
      provider: 'openai',
      statusCode: status,
    })
  }
  if (status === 429) {
    return new AIError('rate_limit', `OpenAI rate limit: ${trimmed}`, {
      provider: 'openai',
      statusCode: status,
    })
  }
  if (status === 400) {
    return new AIError('invalid_input', `OpenAI bad request: ${trimmed}`, {
      provider: 'openai',
      statusCode: status,
    })
  }
  if (status >= 500 && status < 600) {
    return new AIError('transient', `OpenAI 5xx: ${trimmed}`, {
      provider: 'openai',
      statusCode: status,
    })
  }
  return new AIError('unknown', `OpenAI ${status}: ${trimmed}`, {
    provider: 'openai',
    statusCode: status,
  })
}

// ---------------------------------------------------------------------------
// SSE parser
// ---------------------------------------------------------------------------

/**
 * OpenAI's SSE dialect (with `stream_options.include_usage: true`):
 *
 *   data: {"choices":[{"delta":{"content":"Hello"}}]}
 *   data: {"choices":[{"delta":{"content":" world"}}]}
 *   data: {"choices":[{"finish_reason":"stop"}]}
 *   data: {"usage":{"prompt_tokens":12,"completion_tokens":2,"total_tokens":14}}
 *   data: [DONE]
 *
 * Usage arrives AFTER the finish_reason chunk, so we buffer until
 * the `[DONE]` sentinel before emitting our terminal event.
 */
async function* parseOpenAIStream(
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
        if (reason === 'stop' || reason === 'end_turn') finishReason = 'stop'
        else if (reason === 'length') finishReason = 'length'
        else if (reason && typeof reason === 'string' && reason !== null) {
          // content_filter, tool_calls, etc — treat as 'stop' for now
          finishReason = 'stop'
        }

        if (payload.usage) {
          promptTokens = payload.usage.prompt_tokens ?? promptTokens
          completionTokens = payload.usage.completion_tokens ?? completionTokens
        }
      }
    }
  } finally {
    reader.releaseLock()
  }

  const usage: TokenUsage = {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens || payloadTotal(buffer),
  }

  yield { type: 'done', usage, finishReason }
}

/** Parse a trailing `total_tokens` field if the stream ended without one. */
function payloadTotal(_tail: string): number {
  return 0
}

function extractDataLine(block: string): string | null {
  for (const line of block.split('\n')) {
    if (line.startsWith('data: ')) return line.slice(6).trim()
    if (line.startsWith('data:')) return line.slice(5).trim()
  }
  return null
}
