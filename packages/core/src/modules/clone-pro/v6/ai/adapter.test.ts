import { describe, it, expect, vi } from 'vitest'
import { callAIProvider } from './adapter.js'

describe('AI adapter — Sprint 1 multi-provider', () => {
  it('routes Anthropic request to /v1/messages', async () => {
    const fakeFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [{ type: 'text', text: 'product\ncollection\npage' }],
        usage: { input_tokens: 100, output_tokens: 5 },
      }),
    })
    const r = await callAIProvider({
      provider: 'anthropic',
      apiKey: 'sk-ant-test',
      model: 'claude-haiku-4-5-20251001',
      systemPrompt: 'classify',
      userPrompt: 'urls',
      fetch: fakeFetch as any,
    })
    expect(r.text).toBe('product\ncollection\npage')
    expect(fakeFetch).toHaveBeenCalledWith(
      'https://api.anthropic.com/v1/messages',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('routes OpenAI to /v1/chat/completions', async () => {
    const fakeFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'product' } }],
        usage: { prompt_tokens: 100, completion_tokens: 1 },
      }),
    })
    const r = await callAIProvider({
      provider: 'openai',
      apiKey: 'sk-test',
      model: 'gpt-5',
      systemPrompt: 'sys',
      userPrompt: 'usr',
      fetch: fakeFetch as any,
    })
    expect(r.text).toBe('product')
  })

  it('routes Google to generativelanguage v1beta', async () => {
    const fakeFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: 'page' }] } }],
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 1 },
      }),
    })
    const r = await callAIProvider({
      provider: 'google',
      apiKey: 'AIza',
      model: 'gemini-2.5-pro',
      systemPrompt: 'sys',
      userPrompt: 'usr',
      fetch: fakeFetch as any,
    })
    expect(r.text).toBe('page')
  })

  it('throws AIProviderError on non-2xx', async () => {
    const fakeFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => 'rate limited',
    })
    await expect(
      callAIProvider({
        provider: 'anthropic',
        apiKey: 'sk',
        model: 'claude-haiku-4-5-20251001',
        systemPrompt: 's',
        userPrompt: 'u',
        fetch: fakeFetch as any,
      }),
    ).rejects.toThrow(/429/)
  })
})
