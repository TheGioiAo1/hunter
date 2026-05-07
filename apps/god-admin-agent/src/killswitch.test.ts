import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createKillswitch } from './killswitch.ts'

describe('killswitch', () => {
  it('stays disengaged when the file does not exist', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ks-'))
    try {
      const ks = createKillswitch({
        filePath: join(dir, 'nope'),
        pollMs: 10_000,
        onEngaged: vi.fn(),
      })
      await ks.pollNow()
      expect(ks.isEngaged()).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('fires onEngaged exactly once when the file appears', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ks-'))
    const filePath = join(dir, 'flag')
    const onEngaged = vi.fn()
    try {
      const ks = createKillswitch({ filePath, pollMs: 10_000, onEngaged })
      await ks.pollNow()
      expect(onEngaged).not.toHaveBeenCalled()

      writeFileSync(filePath, '')
      await ks.pollNow()
      await ks.pollNow() // second poll must NOT re-fire
      expect(onEngaged).toHaveBeenCalledTimes(1)
      expect(ks.isEngaged()).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('fires onDisengaged when the file is removed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ks-'))
    const filePath = join(dir, 'flag')
    const onEngaged = vi.fn()
    const onDisengaged = vi.fn()
    try {
      writeFileSync(filePath, '')
      const ks = createKillswitch({
        filePath,
        pollMs: 10_000,
        onEngaged,
        onDisengaged,
      })
      await ks.pollNow()
      expect(ks.isEngaged()).toBe(true)

      unlinkSync(filePath)
      await ks.pollNow()
      expect(ks.isEngaged()).toBe(false)
      expect(onDisengaged).toHaveBeenCalledTimes(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
