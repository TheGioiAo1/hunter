/**
 * Gbox Platform — Google (Gemini) provider
 *
 * Adapter over the Gemini API
 * (https://ai.google.dev/gemini-api/docs/text-generation). Streams
 * via `:streamGenerateContent?alt=sse`.
 *
 * Gemini's API is noticeably different from Anthropic/OpenAI:
 *
 *   - Roles are `user` / `model` (not `assistant`)
 *   - System prompt rides in `systemInstruction.parts[]`, not a message
 *   - Image parts are `{inline_data:{mime_type, data}}`
 *   - Usage arrives inline on the last chunk as `usageMetadata`
 *
 * We hide all of that behind the same AIProvider interface so the
 * router and callers stay vendor-neutral.
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

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta'

export class GoogleProvider implements AIProvider {
  readonly id = 'google' as const
  readonly capabilities: ProviderCapabilities = {
    text: true,
    vision: true,
    streaming: true,
    jsonMode: true,
  }
  readonly credential: ProviderCredential

  constructor(credential: ProviderCredential) {
    if (credential.provider !== 'google') {
      throw new Error(
        `GoogleProvider requires credential.provider='google', got '${credential.provider}'`,
      )
    }
    this.credential = credential
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    return chatFromStream(this, req)
  }

  async *chatStream(req: ChatRequest): AsyncIterable<StreamEvent> {
    const baseUrl = this.credential.baseUrl ?? DEFAULT_BASE_URL
    const url = `${baseUrl}/models/${this.credential.model}:streamGenerateContent?alt=sse&key=${this.credential.apiKey}`
    const body = buildGoogleBody(req)

    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: req.signal,
      })
    } catch (err) {
      throw new AIError('transient', (err as Error).message, { provider: 'google' })
    }

    if (!response.ok) {
      throw await mapGoogleError(response)
    }

    if (!response.body) {
      throw new AIError('transient', 'Google returned no body', { provider: 'google' })
    }

    yield* parseGoogleStream(response.body)
  }
}

// ---------------------------------------------------------------------------
// Body builder
// ---------------------------------------------------------------------------

interface GoogleRequestBody {
  contents: GoogleContent[]
  systemInstruction?: { parts: GooglePart[] }
  generationConfig: {
    maxOutputTokens: number
    temperature: number
    responseMimeType?: 'application/json'
  }
}

interface GoogleContent {
  role: 'user' | 'model'
  parts: GooglePart[]
}

type GooglePart =
  | { text: string }
  | { inline_data: { mime_type: string; data: string } }

function buildGoogleBody(req: ChatRequest): GoogleRequestBody {
  const contents: GoogleContent[] = []
  for (const msg of req.messages) {
    if (msg.role === 'system') continue // rides in systemInstruction
    contents.push({
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: toParts(msg.content),
    })
  }

  const body: GoogleRequestBody = {
    contents,
    generationConfig: {
      maxOutputTokens: req.maxTokens ?? 2000,
      temperature: req.temperature ?? 0.3,
      ...(req.jsonMode ? { responseMimeType: 'application/json' as const } : {}),
    },
  }

  if (req.system) {
    body.systemInstruction = { parts: [{ text: req.system }] }
  }

  return body
}

function toParts(content: string | readonly any[]): GooglePart[] {
  if (typeof content === 'string') return [{ text: content }]
  return content.map((block) => {
    if (block.type === 'text') return { text: block.text }
    return {
      inline_data: {
        mime_type: block.mediaType,
        data: block.base64,
      },
    }
  })
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

async function mapGoogleError(response: Response): Promise<AIError> {
  let bodyText = ''
  try {
    bodyText = await response.text()
  } catch {
    /* non-fatal */
  }

  const trimmed = bodyText.slice(0, 500)
  const status = response.status

  if (status === 401 || status === 403) {
    return new AIError('auth', `Google auth failed (${status}): ${trimmed}`, {
      provider: 'google',
      statusCode: status,
    })
  }
  if (status === 429) {
    return new AIError('rate_limit', `Google rate limit: ${trimmed}`, {
      provider: 'google',
      statusCode: status,
    })
  }
  if (status === 400) {
    return new AIError('invalid_input', `Google bad request: ${trimmed}`, {
      provider: 'google',
      statusCode: status,
    })
  }
  if (status >= 500 && status < 600) {
    return new AIError('transient', `Google 5xx: ${trimmed}`, {
      provider: 'google',
      statusCode: status,
    })
  }
  return new AIError('unknown', `Google ${status}: ${trimmed}`, {
    provider: 'google',
    statusCode: status,
  })
}

// ---------------------------------------------------------------------------
// SSE parser
// ---------------------------------------------------------------------------

/**
 * Gemini's streaming dialect:
 *
 *   data: {"candidates":[{"content":{"parts":[{"text":"Hello"}],"role":"model"},"finishReason":"..."}],"usageMetadata":{...}}
 *
 * Each chunk is a complete JSON object (no multiline). Usage arrives
 * on every chunk but stabilises on the last one — we use the last
 * observed values.
 */
async function* parseGoogleStream(
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

        let payload: any
        try {
          payload = JSON.parse(data)
        } catch {
          continue
        }

        const parts = payload.candidates?.[0]?.content?.parts
        if (Array.isArray(parts)) {
          for (const part of parts) {
            if (typeof part.text === 'string' && part.text.length > 0) {
              yield { type: 'text', delta: part.text }
            }
          }
        }

        const reason = payload.candidates?.[0]?.finishReason
        if (reason === 'STOP') finishReason = 'stop'
        else if (reason === 'MAX_TOKENS') finishReason = 'length'

        if (payload.usageMetadata) {
          promptTokens = payload.usageMetadata.promptTokenCount ?? promptTokens
          completionTokens = payload.usageMetadata.candidatesTokenCount ?? completionTokens
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
