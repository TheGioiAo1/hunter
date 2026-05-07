import { describe, it, expect, vi } from 'vitest'
import { createAgentRuntime } from './agent-runtime.ts'
import type { SdkEvent, SdkQueryFn } from './agent-runtime.ts'
import type { SseEvent } from './types.ts'

function fakeSdk(events: SdkEvent[]): SdkQueryFn {
  return async function* () {
    for (const e of events) {
      yield e
    }
  }
}

describe('createAgentRuntime.sendMessage — happy path', () => {
  it('maps SDK assistant_delta → SseEvent assistant_delta', async () => {
    const runtime = createAgentRuntime({
      query: fakeSdk([
        { type: 'assistant_delta', text: 'hi ' },
        { type: 'assistant_delta', text: 'anh' },
      ]),
    })

    const seen: SseEvent[] = []
    await runtime.sendMessage('aid-1', 'xin chao', {
      onEvent: (e) => {
        seen.push(e)
      },
    })

    expect(seen.map((e) => e.type)).toEqual(['assistant_delta', 'assistant_delta', 'done'])
    expect((seen[0] as any).text).toBe('hi ')
    expect((seen[1] as any).text).toBe('anh')
  })

  it('maps tool_use + tool_result with ids preserved', async () => {
    const runtime = createAgentRuntime({
      query: fakeSdk([
        { type: 'tool_use', id: 'tc-1', name: 'repo.read', input: { path: 'x' } },
        { type: 'tool_result', id: 'tc-1', output: { ok: true } },
      ]),
    })

    const seen: SseEvent[] = []
    await runtime.sendMessage('aid-1', 'read x', {
      onEvent: (e) => {
        seen.push(e)
      },
    })

    expect(seen[0]).toMatchObject({
      type: 'tool_use',
      toolCallId: 'tc-1',
      name: 'repo.read',
    })
    expect(seen[1]).toMatchObject({
      type: 'tool_result',
      toolCallId: 'tc-1',
      output: { ok: true },
    })
    expect(seen.at(-1)).toEqual({ type: 'done' })
  })

  it('emits done exactly once per call', async () => {
    const runtime = createAgentRuntime({
      query: fakeSdk([{ type: 'assistant_delta', text: 'x' }]),
    })

    const seen: SseEvent[] = []
    await runtime.sendMessage('aid-1', 'm', {
      onEvent: (e) => {
        seen.push(e)
      },
    })

    const doneCount = seen.filter((e) => e.type === 'done').length
    expect(doneCount).toBe(1)
  })
})

describe('createAgentRuntime.sendMessage — errors', () => {
  it('maps a thrown SDK error to an SseEvent error', async () => {
    const runtime = createAgentRuntime({
      query: async function* () {
        yield { type: 'assistant_delta', text: 'a' }
        throw new Error('upstream 500')
      },
    })

    const seen: SseEvent[] = []
    await runtime.sendMessage('aid-1', 'm', {
      onEvent: (e) => {
        seen.push(e)
      },
    })

    const errEvent = seen.find((e) => e.type === 'error')
    expect(errEvent).toBeDefined()
    expect((errEvent as any).message).toBe('upstream 500')
  })

  it('translates an SDK error event into an SseEvent error passthrough', async () => {
    const runtime = createAgentRuntime({
      query: fakeSdk([
        { type: 'error', message: 'rate limited', code: 'RATE_LIMITED' },
      ]),
    })

    const seen: SseEvent[] = []
    await runtime.sendMessage('aid-1', 'm', {
      onEvent: (e) => {
        seen.push(e)
      },
    })

    expect(seen[0]).toMatchObject({
      type: 'error',
      message: 'rate limited',
      code: 'RATE_LIMITED',
    })
  })
})

describe('createAgentRuntime.abort', () => {
  it('abort(aid) stops the in-flight stream and emits done', async () => {
    // Build a query that yields forever until abort fires
    const runtime = createAgentRuntime({
      query: async function* ({ signal }) {
        while (!signal.aborted) {
          yield { type: 'assistant_delta', text: '.' }
          // Small wait lets the outer loop schedule the abort check
          await new Promise((r) => setTimeout(r, 5))
        }
      },
    })

    const seen: SseEvent[] = []
    const done = runtime.sendMessage('aid-1', 'loop', {
      onEvent: (e) => {
        seen.push(e)
        // Abort after we've seen a few deltas
        if (seen.length === 3) runtime.abort('aid-1')
      },
    })

    await done
    // Stream must have ended with a done event
    expect(seen.at(-1)).toEqual({ type: 'done' })
  })

  it('abort for an unknown aid is a no-op', () => {
    const runtime = createAgentRuntime({ query: fakeSdk([]) })
    expect(() => runtime.abort('nope')).not.toThrow()
  })
})
