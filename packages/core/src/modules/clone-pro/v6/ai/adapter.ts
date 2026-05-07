/**
 * Clone Pro v6 — Provider-agnostic AI adapter
 *
 * Maps Anthropic Messages API / OpenAI Chat / Google Gemini to one unified
 * return shape: { text, usage: { inputTokens, outputTokens } }.
 *
 * Throws AIProviderError on non-2xx responses.
 * The `fetch` param is injectable for unit testing.
 */

import type { AIProvider } from '../preflight/ping-provider.js'

export interface CallAIInput {
  provider: AIProvider
  apiKey: string
  model: string
  systemPrompt: string
  userPrompt: string
  maxTokens?: number
  fetch?: typeof globalThis.fetch
}

export interface CallAIResult {
  text: string
  usage: { inputTokens: number; outputTokens: number }
}

export class AIProviderError extends Error {
  constructor(
    public status: number,
    public bodyText: string,
    message: string,
  ) {
    super(message)
    this.name = 'AIProviderError'
  }
}

export async function callAIProvider(input: CallAIInput): Promise<CallAIResult> {
  const fetchImpl = input.fetch ?? globalThis.fetch
  switch (input.provider) {
    case 'anthropic':
      return callAnthropic(input, fetchImpl)
    case 'openai':
      return callOpenAI(input, fetchImpl)
    case 'google':
      return callGoogle(input, fetchImpl)
  }
}

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

async function callAnthropic(
  input: CallAIInput,
  fetchImpl: typeof globalThis.fetch,
): Promise<CallAIResult> {
  const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': input.apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: input.model,
      max_tokens: input.maxTokens ?? 1024,
      system: input.systemPrompt,
      messages: [{ role: 'user', content: input.userPrompt }],
    }),
  })
  if (!res.ok) {
    const bodyText = await res.text().catch(() => '')
    throw new AIProviderError(res.status, bodyText, `Anthropic ${res.status}`)
  }
  const body = (await res.json()) as any
  const text = body.content?.[0]?.text ?? ''
  return {
    text,
    usage: {
      inputTokens: body.usage?.input_tokens ?? 0,
      outputTokens: body.usage?.output_tokens ?? 0,
    },
  }
}

// ---------------------------------------------------------------------------
// OpenAI
// ---------------------------------------------------------------------------

async function callOpenAI(
  input: CallAIInput,
  fetchImpl: typeof globalThis.fetch,
): Promise<CallAIResult> {
  const res = await fetchImpl('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${input.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: input.model,
      max_tokens: input.maxTokens ?? 1024,
      messages: [
        { role: 'system', content: input.systemPrompt },
        { role: 'user', content: input.userPrompt },
      ],
    }),
  })
  if (!res.ok) {
    const bodyText = await res.text().catch(() => '')
    throw new AIProviderError(res.status, bodyText, `OpenAI ${res.status}`)
  }
  const body = (await res.json()) as any
  return {
    text: body.choices?.[0]?.message?.content ?? '',
    usage: {
      inputTokens: body.usage?.prompt_tokens ?? 0,
      outputTokens: body.usage?.completion_tokens ?? 0,
    },
  }
}

// ---------------------------------------------------------------------------
// Google Gemini
// ---------------------------------------------------------------------------

async function callGoogle(
  input: CallAIInput,
  fetchImpl: typeof globalThis.fetch,
): Promise<CallAIResult> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${input.model}:generateContent`
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-goog-api-key': input.apiKey,
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: input.systemPrompt }] },
      contents: [{ parts: [{ text: input.userPrompt }] }],
      generationConfig: { maxOutputTokens: input.maxTokens ?? 1024 },
    }),
  })
  if (!res.ok) {
    const bodyText = await res.text().catch(() => '')
    throw new AIProviderError(res.status, bodyText, `Google ${res.status}`)
  }
  const body = (await res.json()) as any
  return {
    text: body.candidates?.[0]?.content?.parts?.[0]?.text ?? '',
    usage: {
      inputTokens: body.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: body.usageMetadata?.candidatesTokenCount ?? 0,
    },
  }
}
