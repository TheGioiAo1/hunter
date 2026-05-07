/**
 * Gbox Platform — Smoke Probe Tests (Phase 6.5)
 */

import { describe, it, expect, vi } from 'vitest'
import {
  httpProbe,
  runProbes,
  formatProbeReport,
  type ProbeFetcher,
  type ProbeResult,
} from './smoke-probes.js'

// A monotonically increasing fake clock so durationMs is predictable.
function makeClock(start = 1_000_000) {
  let t = start
  return {
    now() {
      return (t += 5)
    },
  }
}

function fakeFetch(
  status: number,
  body: string,
  delay = 0,
): ProbeFetcher {
  return vi.fn(async () => {
    if (delay) {
      await new Promise((r) => setTimeout(r, delay))
    }
    return {
      status,
      text: async () => body,
    }
  })
}

// ---------------------------------------------------------------------------
// httpProbe
// ---------------------------------------------------------------------------

describe('httpProbe', () => {
  it('returns ok=true for a 200 with no body assertion', async () => {
    const result = await httpProbe(
      { name: 'health', url: 'http://x/_health' },
      fakeFetch(200, '{"ok":true}'),
      makeClock(),
    )
    expect(result.ok).toBe(true)
    expect(result.name).toBe('health')
    expect(result.detail).toContain('200')
  })

  it('returns ok=false when the status mismatches', async () => {
    const result = await httpProbe(
      { name: 'health', url: 'http://x/_health' },
      fakeFetch(503, '{"ok":false}'),
      makeClock(),
    )
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('503')
    expect(result.detail).toContain('expected 200')
  })

  it('honors expectedStatus when set', async () => {
    const result = await httpProbe(
      {
        name: 'login redirect',
        url: 'http://x/login',
        expectedStatus: 302,
      },
      fakeFetch(302, ''),
      makeClock(),
    )
    expect(result.ok).toBe(true)
  })

  it('returns ok=true when expectBodyContains matches', async () => {
    const result = await httpProbe(
      {
        name: 'home',
        url: 'http://x/',
        expectBodyContains: 'gbox',
      },
      fakeFetch(200, '<html>welcome to gbox</html>'),
      makeClock(),
    )
    expect(result.ok).toBe(true)
  })

  it('returns ok=false when expectBodyContains is missing', async () => {
    const result = await httpProbe(
      {
        name: 'home',
        url: 'http://x/',
        expectBodyContains: 'gbox',
      },
      fakeFetch(200, '<html>nothing here</html>'),
      makeClock(),
    )
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('missing')
  })

  it('returns ok=false when the fetcher throws', async () => {
    const fetcher: ProbeFetcher = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    })
    const result = await httpProbe(
      { name: 'health', url: 'http://x/_health' },
      fetcher,
      makeClock(),
    )
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('ECONNREFUSED')
  })

  it('records a non-zero durationMs', async () => {
    const result = await httpProbe(
      { name: 'health', url: 'http://x/_health' },
      fakeFetch(200, ''),
      makeClock(),
    )
    expect(result.durationMs).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// runProbes
// ---------------------------------------------------------------------------

describe('runProbes', () => {
  it('runs every probe even when one fails', async () => {
    const probes = [
      async (): Promise<ProbeResult> => ({
        name: 'a',
        ok: true,
        detail: 'good',
        durationMs: 10,
      }),
      async (): Promise<ProbeResult> => ({
        name: 'b',
        ok: false,
        detail: 'bad',
        durationMs: 20,
      }),
      async (): Promise<ProbeResult> => ({
        name: 'c',
        ok: true,
        detail: 'good',
        durationMs: 30,
      }),
    ]
    const result = await runProbes(probes)
    expect(result.results).toHaveLength(3)
    expect(result.passed).toBe(2)
    expect(result.failed).toBe(1)
    expect(result.totalDurationMs).toBe(60)
  })

  it('handles an empty probe list', async () => {
    const result = await runProbes([])
    expect(result.passed).toBe(0)
    expect(result.failed).toBe(0)
    expect(result.totalDurationMs).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// formatProbeReport
// ---------------------------------------------------------------------------

describe('formatProbeReport', () => {
  it('renders a PASS row for a successful probe', () => {
    const text = formatProbeReport({
      results: [{ name: 'health', ok: true, detail: 'ok', durationMs: 12 }],
      passed: 1,
      failed: 0,
      totalDurationMs: 12,
    })
    expect(text).toContain('[PASS]')
    expect(text).toContain('health')
    expect(text).toContain('1 passed')
  })

  it('renders a FAIL row for a failed probe', () => {
    const text = formatProbeReport({
      results: [{ name: 'health', ok: false, detail: 'down', durationMs: 4 }],
      passed: 0,
      failed: 1,
      totalDurationMs: 4,
    })
    expect(text).toContain('[FAIL]')
    expect(text).toContain('1 failed')
  })
})
