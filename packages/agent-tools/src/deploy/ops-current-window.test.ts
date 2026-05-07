import { describe, it, expect } from 'vitest'
import { opsCurrentWindowTool } from './ops-current-window.ts'

/**
 * Window definitions (spec §10):
 *   daily  — 03:00..04:00 GMT+7 (UTC 20:00..21:00 previous day)
 *   sunday — Sunday 02:00..05:00 GMT+7 (UTC Sat 19:00..22:00)
 */

describe('ops.current-window', () => {
  it('reports inside daily when clock is 03:30 GMT+7 (20:30 UTC)', async () => {
    // 2026-04-10 20:30 UTC → GMT+7 is 2026-04-11 03:30 → inside daily
    const result = await opsCurrentWindowTool.run(
      { atIso: '2026-04-10T20:30:00.000Z' },
      {},
    )
    expect(result.kind).toBe('ok')
    if (result.kind === 'ok') {
      expect((result.data as any).daily).toBe(true)
      expect((result.data as any).anyWindow).toBe(true)
    }
  })

  it('reports outside windows at 15:00 GMT+7 peak', async () => {
    // 2026-04-10 08:00 UTC → GMT+7 15:00 Fri → peak, no window
    const result = await opsCurrentWindowTool.run(
      { atIso: '2026-04-10T08:00:00.000Z' },
      {},
    )
    expect(result.kind).toBe('ok')
    if (result.kind === 'ok') {
      expect((result.data as any).daily).toBe(false)
      expect((result.data as any).sunday).toBe(false)
      expect((result.data as any).anyWindow).toBe(false)
    }
  })

  it('reports sunday window at Sun 03:30 GMT+7', async () => {
    // 2026-04-12 is Sunday. 03:30 GMT+7 = Saturday 20:30 UTC
    const result = await opsCurrentWindowTool.run(
      { atIso: '2026-04-11T20:30:00.000Z' },
      {},
    )
    expect(result.kind).toBe('ok')
    if (result.kind === 'ok') {
      expect((result.data as any).sunday).toBe(true)
      // Sunday 03:30 overlaps daily 03-04 too
      expect((result.data as any).daily).toBe(true)
    }
  })

  it('parseInput rejects non-string atIso', () => {
    expect(() => opsCurrentWindowTool.parseInput({ atIso: 123 })).toThrow()
  })
})
