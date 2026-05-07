import { describe, it, expect, vi } from 'vitest'
import { writeCloneSnapshot, shouldOverwriteOnReclone } from './snapshot.js'

describe('snapshot helper (L17)', () => {
  it('writes clone_snapshot column with the row state at clone time', async () => {
    const exec = vi.fn().mockResolvedValue(undefined)
    const trx = {
      updateTable: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({
            where: vi.fn(() => ({ execute: exec })),
          })),
        })),
      })),
    }
    await writeCloneSnapshot(trx as any, {
      table: 'products' as any,
      shopId: 'shop-1',
      rowId: 'row-1',
      snapshot: { title: 'Old', body_html: '<p>x</p>' },
    })
    expect(trx.updateTable).toHaveBeenCalledWith('products')
    expect(exec).toHaveBeenCalledOnce()
  })

  it('shouldOverwriteOnReclone returns false when source=edited', () => {
    expect(shouldOverwriteOnReclone({ source: 'edited' })).toBe(false)
    expect(shouldOverwriteOnReclone({ source: 'manual' })).toBe(false)
    expect(shouldOverwriteOnReclone({ source: 'clone' })).toBe(true)
    expect(shouldOverwriteOnReclone({ source: undefined })).toBe(true)
  })
})
