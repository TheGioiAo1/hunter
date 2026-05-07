/**
 * drain-slot.test.ts — the drain script is a 20-liner, but we pin
 * the exact contract the orchestrator relies on: it sleeps for
 * quietSeconds*1000, returns ok=true with the pm2Name echoed back,
 * and skips the sleep entirely when quietSeconds is 0.
 */

import { describe, it, expect } from 'vitest'
import { drainSlot } from './drain-slot.ts'

describe('drainSlot', () => {
  it('sleeps for quietSeconds * 1000 ms and reports ok', async () => {
    const sleeps: number[] = []
    const fakeSleep = async (ms: number): Promise<void> => {
      sleeps.push(ms)
    }
    const result = await drainSlot({ pm2Name: 'gbox-api', quietSeconds: 5 }, fakeSleep)
    expect(result).toEqual({
      ok: true,
      pm2Name: 'gbox-api',
      quietSeconds: 5,
      slept: true,
    })
    expect(sleeps).toEqual([5000])
  })

  it('skips sleep entirely when quietSeconds is 0', async () => {
    const sleeps: number[] = []
    const fakeSleep = async (ms: number): Promise<void> => {
      sleeps.push(ms)
    }
    const result = await drainSlot(
      { pm2Name: 'gbox-storefront', quietSeconds: 0 },
      fakeSleep,
    )
    expect(result.slept).toBe(false)
    expect(sleeps).toEqual([])
  })
})
