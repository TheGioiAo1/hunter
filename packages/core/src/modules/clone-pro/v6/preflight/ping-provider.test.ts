import { describe, it, expect, vi, beforeEach } from 'vitest'
import { pingProvider } from './ping-provider.js'

describe('pingProvider — Sprint 0 BYOK gate', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('returns ok=true when Anthropic accepts a 1-token ping', async () => {
    const fakeFetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => ({
        id: 'msg_test', type: 'message', role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        model: 'claude-haiku-4-5-20251001',
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    })
    const result = await pingProvider({
      provider: 'anthropic',
      apiKey: 'sk-ant-test',
      model: 'claude-haiku-4-5-20251001',
      fetch: fakeFetch as any,
    })
    expect(result.ok).toBe(true)
    expect(result.error).toBeUndefined()
  })

  it('returns ok=false with sanitized error on 401', async () => {
    const fakeFetch = vi.fn().mockResolvedValue({
      status: 401,
      ok: false,
      json: async () => ({ error: { type: 'authentication_error', message: 'invalid x-api-key' } }),
    })
    const result = await pingProvider({
      provider: 'anthropic',
      apiKey: 'sk-ant-bad',
      model: 'claude-haiku-4-5-20251001',
      fetch: fakeFetch as any,
    })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/401/)
  })

  it('returns ok=false on 429 quota exceeded', async () => {
    const fakeFetch = vi.fn().mockResolvedValue({
      status: 429,
      ok: false,
      json: async () => ({ error: { type: 'rate_limit_error', message: 'quota exceeded' } }),
    })
    const result = await pingProvider({
      provider: 'openai',
      apiKey: 'sk-bad',
      model: 'gpt-5',
      fetch: fakeFetch as any,
    })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/429/)
  })

  it('routes Google provider to v1beta endpoint', async () => {
    const fakeFetch = vi.fn().mockResolvedValue({
      status: 200, ok: true,
      json: async () => ({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }),
    })
    await pingProvider({
      provider: 'google', apiKey: 'AIza-test', model: 'gemini-2.5-pro',
      fetch: fakeFetch as any,
    })
    expect(fakeFetch).toHaveBeenCalledWith(
      expect.stringContaining('generativelanguage.googleapis.com/v1beta'),
      expect.any(Object),
    )
  })

  it('returns ok=false with network_error when fetch itself throws', async () => {
    const fakeFetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    const result = await pingProvider({
      provider: 'anthropic',
      apiKey: 'sk-ant-test',
      model: 'claude-haiku-4-5-20251001',
      fetch: fakeFetch as any,
    })
    expect(result.ok).toBe(false)
    expect(result.error).toBe('network_error')
    expect(result.raw).toBeDefined()
  })
})
