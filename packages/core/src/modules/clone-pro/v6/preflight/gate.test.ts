import { describe, it, expect, vi } from 'vitest'
import { runPreflight } from './gate.js'

const STUB_DB: any = {}  // gate calls config-service which we mock

describe('runPreflight — Sprint 0 BYOK gate', () => {
  it('returns ai_required when shop has no AI config', async () => {
    const r = await runPreflight({
      db: STUB_DB,
      shopId: 'shop-1',
      sourceUrl: 'https://example.com',
      loadConfig: async () => null,
      pingProvider: vi.fn(),
      estimateUrlCount: vi.fn(),
    })
    expect(r.ok).toBe(false)
    expect(r.error).toBe('ai_required')
  })

  it('returns ai_required when provider is none', async () => {
    const r = await runPreflight({
      db: STUB_DB,
      shopId: 'shop-1',
      sourceUrl: 'https://example.com',
      loadConfig: async () => ({ provider: 'none' }) as any,
      pingProvider: vi.fn(),
      estimateUrlCount: vi.fn(),
    })
    expect(r.ok).toBe(false)
    expect(r.error).toBe('ai_required')
  })

  it('returns ai_key_invalid when ping fails', async () => {
    const r = await runPreflight({
      db: STUB_DB,
      shopId: 'shop-1',
      sourceUrl: 'https://example.com',
      loadConfig: async () => ({ provider: 'anthropic', model: 'claude-haiku-4-5-20251001', apiKey: 'sk-bad' }) as any,
      pingProvider: async () => ({ ok: false, error: '401 Unauthorized' }),
      estimateUrlCount: async () => 100,
    })
    expect(r.ok).toBe(false)
    expect(r.error).toBe('ai_key_invalid')
    expect(r.detail).toMatch(/401/)
  })

  it('returns ok=true with estimate when ping succeeds', async () => {
    const r = await runPreflight({
      db: STUB_DB,
      shopId: 'shop-1',
      sourceUrl: 'https://example.com',
      loadConfig: async () => ({ provider: 'anthropic', model: 'claude-haiku-4-5-20251001', apiKey: 'sk-ok' }) as any,
      pingProvider: async () => ({ ok: true }),
      estimateUrlCount: async () => 712,
    })
    expect(r.ok).toBe(true)
    expect(r.estimate).toBeDefined()
    expect(r.estimate?.urlCount).toBe(712)
  })
})
