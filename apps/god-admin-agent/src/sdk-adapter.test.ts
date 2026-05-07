/**
 * sdk-adapter.test.ts — unit tests for createSdkQuery + mapSdkMessage.
 *
 * We DO NOT pull in the real @anthropic-ai/claude-agent-sdk here —
 * the adapter takes an `sdkQueryImpl` override for exactly this
 * reason. The tests verify:
 *
 *   1. mapSdkMessage correctly maps partial stream deltas, assistant
 *      tool_use blocks, tool_result blocks, and error result messages.
 *   2. createSdkQuery passes the current prompt-watcher content as
 *      options.systemPrompt on every call (verifying hot-reload).
 *   3. createSdkQuery forwards the user AbortSignal to an internal
 *      AbortController that the stub query() sees.
 *   4. createSdkQuery terminates with a `done` event at the natural
 *      end of the stream AND after an abort.
 *   5. createSdkQuery wraps thrown errors into an error SdkEvent
 *      unless the error is caused by abort.
 */

import { describe, it, expect } from 'vitest'
import { createSdkQuery, mapSdkMessage, type SdkLikeMessage } from './sdk-adapter.ts'
import type { SdkEvent, SdkQueryArgs } from '@gbox/agent-core'

const fakePromptWatcher = (text: string) => {
  const state = { text, hash: 'sha256:' + text.length.toString(16), loadedAt: new Date() }
  return {
    current: () => state,
    start: async () => state,
    stop: () => {},
  }
}

async function collect(iter: AsyncIterable<SdkEvent>): Promise<SdkEvent[]> {
  const out: SdkEvent[] = []
  for await (const e of iter) out.push(e)
  return out
}

function makeArgs(overrides: Partial<SdkQueryArgs> = {}): SdkQueryArgs {
  return {
    aid: 'aid-1',
    userText: 'hello',
    signal: new AbortController().signal,
    ...overrides,
  }
}

describe('mapSdkMessage', () => {
  it('maps a content_block_delta text_delta to assistant_delta', () => {
    const msg: SdkLikeMessage = {
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'Xin' },
      },
    }
    expect(mapSdkMessage(msg)).toEqual([{ type: 'assistant_delta', text: 'Xin' }])
  })

  it('drops non-text stream events', () => {
    const msg: SdkLikeMessage = {
      type: 'stream_event',
      event: { type: 'message_start' },
    }
    expect(mapSdkMessage(msg)).toEqual([])
  })

  it('maps an assistant message with tool_use blocks', () => {
    const msg: SdkLikeMessage = {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'using tool' },
          { type: 'tool_use', id: 'call-42', name: 'repo.read', input: { path: 'x.ts' } },
        ],
      },
    }
    expect(mapSdkMessage(msg)).toEqual([
      {
        type: 'tool_use',
        toolCallId: 'call-42',
        name: 'repo.read',
        input: { path: 'x.ts' },
      },
    ])
  })

  it('maps a user message with tool_result blocks', () => {
    const msg: SdkLikeMessage = {
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call-42',
            content: { stdout: 'ok' },
          },
        ],
      },
    }
    expect(mapSdkMessage(msg)).toEqual([
      { type: 'tool_result', toolCallId: 'call-42', output: { stdout: 'ok' } },
    ])
  })

  it('maps a result error into an error SdkEvent', () => {
    const msg: SdkLikeMessage = {
      type: 'result',
      subtype: 'error_max_tokens',
      is_error: true,
      result: 'ran out of tokens',
    }
    expect(mapSdkMessage(msg)).toEqual([
      { type: 'error', message: 'ran out of tokens' },
    ])
  })

  it('ignores a successful result (runtime emits its own done)', () => {
    const msg: SdkLikeMessage = { type: 'result', subtype: 'success' }
    expect(mapSdkMessage(msg)).toEqual([])
  })
})

describe('createSdkQuery', () => {
  it('passes the current prompt-watcher content as systemPrompt', async () => {
    let seenSystemPrompt: string | null = null
    const watcher = fakePromptWatcher('YOU ARE EM')
    const query = createSdkQuery({
      promptWatcher: watcher,
      sdkQueryImpl: async function* stub({ options }) {
        seenSystemPrompt = options.systemPrompt
        yield {
          type: 'stream_event',
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } },
        }
      },
    })
    const events = await collect(query(makeArgs()))
    expect(seenSystemPrompt).toBe('YOU ARE EM')
    expect(events).toEqual([
      { type: 'assistant_delta', text: 'hi' },
      { type: 'done' },
    ])
  })

  it('picks up a hot-reloaded prompt on the NEXT call', async () => {
    let systemPromptInStub = ''
    let current = 'prompt-v1'
    const watcher = {
      current: () => ({ text: current, hash: 'h', loadedAt: new Date() }),
      start: async () => ({ text: current, hash: 'h', loadedAt: new Date() }),
      stop: () => {},
    }
    const query = createSdkQuery({
      promptWatcher: watcher,
      sdkQueryImpl: async function* stub({ options }) {
        systemPromptInStub = options.systemPrompt
        yield { type: 'result', subtype: 'success' }
      },
    })
    await collect(query(makeArgs()))
    expect(systemPromptInStub).toBe('prompt-v1')
    current = 'prompt-v2'
    await collect(query(makeArgs({ userText: 'again' })))
    expect(systemPromptInStub).toBe('prompt-v2')
  })

  it('forwards the user AbortSignal into the SDK controller', async () => {
    const userCtrl = new AbortController()
    let seenController: AbortController | undefined
    const query = createSdkQuery({
      promptWatcher: fakePromptWatcher('p'),
      sdkQueryImpl: async function* stub({ options }) {
        seenController = options.abortController
        yield {
          type: 'stream_event',
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'a' } },
        }
        yield {
          type: 'stream_event',
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'b' } },
        }
      },
    })
    const events: SdkEvent[] = []
    const iter = query(makeArgs({ signal: userCtrl.signal }))
    for await (const e of iter) {
      events.push(e)
      if (events.length === 1) userCtrl.abort()
    }
    expect(seenController).toBeDefined()
    expect(seenController!.signal.aborted).toBe(true)
    // First delta gets through; the stream terminates early.
    expect(events[0]).toEqual({ type: 'assistant_delta', text: 'a' })
  })

  it('emits `done` even on empty stream', async () => {
    const query = createSdkQuery({
      promptWatcher: fakePromptWatcher('p'),
      sdkQueryImpl: async function* stub() {},
    })
    const events = await collect(query(makeArgs()))
    expect(events).toEqual([{ type: 'done' }])
  })

  it('wraps thrown errors into an error event', async () => {
    const query = createSdkQuery({
      promptWatcher: fakePromptWatcher('p'),
      sdkQueryImpl: async function* stub(): AsyncIterable<SdkLikeMessage> {
        throw new Error('boom')
      },
    })
    const events = await collect(query(makeArgs()))
    expect(events).toEqual([{ type: 'error', message: 'boom' }])
  })

  it('treats AbortError as graceful end, not error', async () => {
    const query = createSdkQuery({
      promptWatcher: fakePromptWatcher('p'),
      sdkQueryImpl: async function* stub(): AsyncIterable<SdkLikeMessage> {
        const err = new Error('aborted')
        err.name = 'AbortError'
        throw err
      },
    })
    const events = await collect(query(makeArgs()))
    expect(events).toEqual([{ type: 'done' }])
  })
})
