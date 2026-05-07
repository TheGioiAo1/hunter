import { describe, it, expect, vi } from 'vitest'
import { runStage11 } from './stage11-auto-publish.js'

describe('Stage 11 — auto-publish', () => {
  it('does not publish on F grade', async () => {
    const r = await runStage11({
      db: {
        selectFrom: () => ({ where: () => ({ select: () => ({ executeTakeFirst: async () => ({ domain: 'best-store.gbox.co' }) }) }) }),
        updateTable: vi.fn(),
      } as any,
      jobId: 'j',
      shopId: 's',
      gradeLetter: 'F',
    })
    expect(r.published).toBe(false)
    expect(r.reason).toBe('grade_F')
  })

  it('does not publish when shop has no domain', async () => {
    const r = await runStage11({
      db: {
        selectFrom: () => ({ where: () => ({ select: () => ({ executeTakeFirst: async () => ({ domain: null }) }) }) }),
        updateTable: vi.fn(),
      } as any,
      jobId: 'j',
      shopId: 's',
      gradeLetter: 'B',
    })
    expect(r.published).toBe(false)
    expect(r.reason).toBe('no_domain')
  })

  it('publishes when grade >= D and domain present + auto-publish env on', async () => {
    const updateExec = vi.fn().mockResolvedValue(undefined)
    // Multi-chain where() builder so publishCloneJobRows() works
    // (jobs row uses 1 where; per-content tables use up to 3 chained wheres).
    const buildWhereChain = (): any => ({
      where: () => buildWhereChain(),
      execute: updateExec,
    })
    const fakeDb = {
      selectFrom: () => ({ where: () => ({ select: () => ({ executeTakeFirst: async () => ({ domain: 'best-store.gbox.co' }) }) }) }),
      updateTable: () => ({ set: () => buildWhereChain() }),
    }
    delete process.env.AUTO_PUBLISH_AFTER_CLONE  // default ON
    const r = await runStage11({ db: fakeDb as any, jobId: 'j', shopId: 's', gradeLetter: 'B' })
    expect(r.published).toBe(true)
    // 1 storefront_clone_jobs + 4 per-content tables (products, collections, pages, blog_posts) = 5 calls
    expect(updateExec).toHaveBeenCalledTimes(5)
  })

  it('respects per-clone autoPublish=false override', async () => {
    const buildWhereChain = (): any => ({
      where: () => buildWhereChain(),
      execute: vi.fn(),
    })
    const fakeDb = {
      selectFrom: () => ({ where: () => ({ select: () => ({ executeTakeFirst: async () => ({ domain: 'best-store.gbox.co' }) }) }) }),
      updateTable: () => ({ set: () => buildWhereChain() }),
    }
    const r = await runStage11({ db: fakeDb as any, jobId: 'j', shopId: 's', gradeLetter: 'A', configOverride: false })
    expect(r.published).toBe(false)
    expect(r.reason).toBe('auto_publish_disabled')
  })
})
