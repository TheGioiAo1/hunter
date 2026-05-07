import { describe, it, expect } from 'vitest'
import { encodeSseEvent, sseKeepAlive } from './sse-stream.ts'
import type { SseEvent } from './types.ts'

describe('encodeSseEvent', () => {
  it('encodes assistant_delta', () => {
    const frame = encodeSseEvent({ type: 'assistant_delta', text: 'hello anh' })
    expect(frame.text).toBe(
      'event: assistant_delta\ndata: {"text":"hello anh"}\n\n',
    )
  })

  it('encodes tool_use with structured input', () => {
    const frame = encodeSseEvent({
      type: 'tool_use',
      toolCallId: 'tc-1',
      name: 'repo.read',
      input: { path: 'CLAUDE.md' },
    })
    expect(frame.text).toContain('event: tool_use\n')
    expect(frame.text).toContain('"toolCallId":"tc-1"')
    expect(frame.text).toContain('"name":"repo.read"')
    expect(frame.text).toContain('"input":{"path":"CLAUDE.md"}')
    expect(frame.text.endsWith('\n\n')).toBe(true)
  })

  it('encodes tool_guard_rejected', () => {
    const event: SseEvent = {
      type: 'tool_guard_rejected',
      toolCallId: 'tc-2',
      layer: 'blocklist',
      reason: 'rm_rf_root',
    }
    const frame = encodeSseEvent(event)
    expect(frame.text).toBe(
      'event: tool_guard_rejected\ndata: {"toolCallId":"tc-2","layer":"blocklist","reason":"rm_rf_root"}\n\n',
    )
  })

  it('encodes approval_required with complex normalizedInput', () => {
    const frame = encodeSseEvent({
      type: 'approval_required',
      toolCallId: 'tc-3',
      name: 'repo.edit',
      normalizedInput: { path: 'apps/storefront/x.ts', diff: '+1 -1' },
    })
    const parsed = JSON.parse(frame.text.split('data: ')[1].trim())
    expect(parsed.normalizedInput.path).toBe('apps/storefront/x.ts')
  })

  it('encodes done event with empty payload', () => {
    const frame = encodeSseEvent({ type: 'done' })
    expect(frame.text).toBe('event: done\ndata: {}\n\n')
  })

  it('encodes error event with optional code', () => {
    const frame = encodeSseEvent({
      type: 'error',
      message: 'upstream timeout',
      code: 'UPSTREAM_TIMEOUT',
    })
    expect(frame.text).toContain('"message":"upstream timeout"')
    expect(frame.text).toContain('"code":"UPSTREAM_TIMEOUT"')
  })

  it('produces bytes that decode to the same text', () => {
    const frame = encodeSseEvent({ type: 'assistant_delta', text: 'xin chào' })
    const decoded = new TextDecoder().decode(frame.bytes)
    expect(decoded).toBe(frame.text)
  })
})

describe('sseKeepAlive', () => {
  it('produces a comment frame that EventSource ignores', () => {
    const frame = sseKeepAlive()
    // Lines starting with ":" are SSE comments per the HTML spec.
    expect(frame.text.startsWith(':')).toBe(true)
    expect(frame.text.endsWith('\n\n')).toBe(true)
  })
})
