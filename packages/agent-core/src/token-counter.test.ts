import { describe, it, expect } from 'vitest'
import { countTokens } from './token-counter.ts'
import type { ChatMessage } from './types.ts'

function msg(role: ChatMessage['role'], content: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return {
    seq: 0,
    role,
    content,
    createdAt: '2026-04-10T00:00:00.000Z',
    ...extra,
  }
}

describe('countTokens', () => {
  it('counts empty string as zero', () => {
    expect(countTokens('')).toBe(0)
  })

  it('counts a short string proportionally', () => {
    // 9 chars / 3 = 3 tokens (ceiling)
    expect(countTokens('abcdefghi')).toBe(3)
  })

  it('rounds up partial tokens', () => {
    // 10 chars / 3 = 3.33 → 4
    expect(countTokens('abcdefghij')).toBe(4)
  })

  it('adds role markers for ChatMessage[]', () => {
    const messages: ChatMessage[] = [msg('user', 'hi')]
    // 4 (role) + ceil(2/3)=1 = 5
    expect(countTokens(messages)).toBe(5)
  })

  it('adds tool overhead when toolCallId + toolName present', () => {
    const messages: ChatMessage[] = [
      msg('tool', '{"ok":true}', { toolCallId: 'tc-1', toolName: 'repo.read' }),
    ]
    // 4 role + ceil(11/3)=4 + 2 (callId) + 2 (name) = 12
    expect(countTokens(messages)).toBe(12)
  })

  it('sums across multiple messages', () => {
    const messages: ChatMessage[] = [
      msg('user', 'abc'),      // 4 + 1 = 5
      msg('assistant', 'defg'), // 4 + 2 = 6
    ]
    expect(countTokens(messages)).toBe(11)
  })

  it('can handle a 180k-scale prose blob without blowing up', () => {
    // 540k chars ≈ 180k tokens at 3 chars/tok — verify the estimate is
    // in the right ballpark (within 10%).
    const blob = 'a'.repeat(540_000)
    const estimate = countTokens(blob)
    expect(estimate).toBeGreaterThanOrEqual(180_000 * 0.9)
    expect(estimate).toBeLessThanOrEqual(180_000 * 1.1)
  })
})
