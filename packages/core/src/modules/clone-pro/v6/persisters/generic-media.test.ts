import { describe, it, expect } from 'vitest'
import { genericMediaPersister, type GenericMediaDTO } from './generic-media.js'

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('GenericMediaPersister', () => {
  it('counts existing clone_assets_map rows for the job (no-op pass-through)', async () => {
    // Stage 6 already wrote N rows into clone_assets_map — this persister
    // just counts them to populate the bucket summary.
    const fakeDb = makeFakeDb(7)

    const r = await genericMediaPersister.persist({
      db: fakeDb as any,
      shopId: 'shop-1',
      jobId: 'job-1',
      dtos: [
        { sourceUrl: 'https://x.com/hero.jpg', bucketTag: 'hero' } as GenericMediaDTO,
        { sourceUrl: 'https://x.com/logo.png', bucketTag: 'logo' } as GenericMediaDTO,
      ],
    })

    expect(r.inserted).toBe(7)
    expect(r.updated).toBe(0)
    expect(r.skippedEdited).toBe(0)
    expect(r.errors).toHaveLength(0)
  })

  it('returns inserted=0 when no rows exist in clone_assets_map', async () => {
    const fakeDb = makeFakeDb(0)

    const r = await genericMediaPersister.persist({
      db: fakeDb as any,
      shopId: 'shop-1',
      jobId: 'job-1',
      dtos: [],
    })

    expect(r.inserted).toBe(0)
    expect(r.errors).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Fake DB builder — returns a count from selectFrom('clone_assets_map')
// ---------------------------------------------------------------------------
function makeFakeDb(count: number) {
  return {
    selectFrom: (_table: string) => ({
      where: () => ({
        where: () => ({
          where: () => ({
            select: () => ({
              executeTakeFirst: async () => ({ n: count }),
            }),
          }),
        }),
      }),
    }),
  }
}
