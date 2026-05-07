import { describe, it, expect } from 'vitest'
import {
  renderLiveLog,
  liveLogCss,
  liveLogRuntimeScriptBody,
} from './live-log.js'

describe('LiveLog', () => {
  it('renders a log region with aria-live=polite and non-atomic', () => {
    const html = renderLiveLog({ sseUrl: '/events/xyz' })
    expect(html).toContain('role="log"')
    expect(html).toContain('aria-live="polite"')
    expect(html).toContain('aria-atomic="false"')
  })
  it('embeds the SSE URL on data-sse-url', () => {
    expect(renderLiveLog({ sseUrl: '/events/abc' })).toContain(
      'data-sse-url="/events/abc"',
    )
  })
  it('respects custom id when provided', () => {
    expect(renderLiveLog({ sseUrl: '/e', id: 'custom-log' })).toContain(
      'id="custom-log"',
    )
  })
  it('defaults max-lines to 200', () => {
    expect(renderLiveLog({ sseUrl: '/e' })).toContain('data-max-lines="200"')
  })
  it('honors custom maxLines', () => {
    expect(renderLiveLog({ sseUrl: '/e', maxLines: 500 })).toContain(
      'data-max-lines="500"',
    )
  })
  it('escapes sseUrl to prevent attribute injection', () => {
    const html = renderLiveLog({ sseUrl: '"><img>' })
    expect(html).not.toContain('"><img>')
  })
  it('exports liveLogCss with monospace font + level colors', () => {
    expect(liveLogCss).toMatch(/gbx-live-log/)
    expect(liveLogCss).toMatch(/gbx-log-error/)
    expect(liveLogCss).toMatch(/var\(--status-failed\)/)
  })
  it('runtime script body opens EventSource + appends log lines', () => {
    const js = liveLogRuntimeScriptBody()
    expect(js).toContain('EventSource')
    expect(js).toContain('data-sse-url')
    expect(js).toContain('gbx-log-line')
  })
})
