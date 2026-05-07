import { describe, it, expect, vi } from 'vitest'
import { compactConversation } from './compaction.ts'
import type { ChatMessage } from './types.ts'

function makeMsg(seq: number, content: string, role: ChatMessage['role'] = 'user'): ChatMessage {
  return {
    seq,
    role,
    content,
    createdAt: `2026-04-10T00:00:${String(seq).padStart(2, '0')}.000Z`,
  }
}

describe('compactConversation — basic flow', () => {
  it('no-op when message count is below preserveTailCount', async () => {
    const messages = [makeMsg(0, 'hi'), makeMsg(1, 'bye')]
    const summarise = vi.fn()

    const result = await compactConversation(messages, { summarise, preserveTailCount: 6 })

    expect(result.foldedCount).toBe(0)
    expect(result.summary).toBe('')
    expect(result.preservedTail).toHaveLength(2)
    expect(summarise).not.toHaveBeenCalled()
  })

  it('folds the prefix and preserves the tail verbatim', async () => {
    // 10 messages, tail count 3 → fold 7, keep 3
    const messages = Array.from({ length: 10 }, (_, i) => makeMsg(i, `msg-${i}`))
    type SummariseArgs = { foldedMessages: ChatMessage[]; lockedBullets: string[] }
    const summarise = vi.fn<(args: SummariseArgs) => Promise<string>>(
      async () => 'everything before was boilerplate',
    )

    const result = await compactConversation(messages, {
      summarise,
      preserveTailCount: 3,
    })

    expect(result.foldedCount).toBe(7)
    expect(result.preservedTail.map((m) => m.content)).toEqual(['msg-7', 'msg-8', 'msg-9'])
    expect(summarise).toHaveBeenCalledOnce()
    expect(summarise.mock.calls[0]![0]!.foldedMessages).toHaveLength(7)
  })
})

describe('compactConversation — locked decisions', () => {
  it('extracts LOCKED lines verbatim as bullets', async () => {
    const messages = [
      makeMsg(0, 'normal chit chat'),
      makeMsg(1, 'DECISION: use Postgres\nsome other text'),
      makeMsg(2, 'APPROVED the migration plan'),
      makeMsg(3, 'REJECTED the rewrite in Rust'),
      makeMsg(4, 'Iron rule LOCKED: bcrypt over sha256'),
      makeMsg(5, 'tail-1'),
      makeMsg(6, 'tail-2'),
      makeMsg(7, 'tail-3'),
    ]

    type SummariseArgs = { foldedMessages: ChatMessage[]; lockedBullets: string[] }
    const summarise = vi.fn<(args: SummariseArgs) => Promise<string>>(
      async ({ lockedBullets }) => {
        // Fake summariser echoes bullet count so we can assert it received them
        return `narrative (${lockedBullets.length} bullets)`
      },
    )

    const result = await compactConversation(messages, {
      summarise,
      preserveTailCount: 3,
    })

    // Summariser saw 4 locked bullets
    expect(summarise.mock.calls[0]![0]!.lockedBullets).toHaveLength(4)

    // Summary preserves each bullet as a verbatim "- " line
    expect(result.summary).toContain('- DECISION: use Postgres')
    expect(result.summary).toContain('- APPROVED the migration plan')
    expect(result.summary).toContain('- REJECTED the rewrite in Rust')
    expect(result.summary).toContain('- Iron rule LOCKED: bcrypt over sha256')
    expect(result.summary).toContain('narrative (4 bullets)')
  })

  it('omits the locked-decisions section entirely when there are none', async () => {
    const messages = Array.from({ length: 10 }, (_, i) => makeMsg(i, `plain ${i}`))
    const summarise = vi.fn(async () => 'narrative')

    const result = await compactConversation(messages, {
      summarise,
      preserveTailCount: 3,
    })

    expect(result.summary).not.toContain('Locked decisions')
    expect(result.summary).toContain('## Narrative')
    expect(result.summary).toContain('narrative')
  })
})

describe('compactConversation — token budget', () => {
  it('records tokensBefore and tokensAfter', async () => {
    const messages = Array.from({ length: 20 }, (_, i) => makeMsg(i, 'a'.repeat(100)))
    const summarise = vi.fn(async () => 'tiny')

    const result = await compactConversation(messages, {
      summarise,
      preserveTailCount: 3,
    })

    expect(result.tokensBefore).toBeGreaterThan(result.tokensAfter)
  })

  it('truncates the summary when it overshoots maxSummaryTokens', async () => {
    const messages = Array.from({ length: 10 }, (_, i) => makeMsg(i, `msg ${i}`))
    const giantSummary = 'x'.repeat(60_000) // ~20k tokens
    const summarise = vi.fn(async () => giantSummary)

    const result = await compactConversation(messages, {
      summarise,
      preserveTailCount: 3,
      maxSummaryTokens: 1000,
    })

    expect(result.summary).toContain('[...truncated by compactor]')
    expect(result.summary.length).toBeLessThan(giantSummary.length)
  })
})
