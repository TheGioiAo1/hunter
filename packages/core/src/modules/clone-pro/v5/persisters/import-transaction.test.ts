import { describe, it, expect, vi } from 'vitest'
import { runCloneImport } from './import-transaction.js'

describe('runCloneImport', () => {
  it('calls fn inside withSerializable + writes checkpoint on success', async () => {
    const calls: string[] = []
    const fakeRun = async (_db: any, fn: any) => {
      calls.push('tx-start')
      const r = await fn(_db)
      calls.push('tx-end')
      return r
    }
    const writes: Array<{ table: string; values: any }> = []
    const fakeDb = {
      insertInto: (table: string) => ({
        values: (v: any) => ({ execute: async () => writes.push({ table, values: v }) }),
      }),
    }
    const result = await runCloneImport(
      fakeDb as any,
      'job-1',
      async (_tx) => {
        calls.push('persist')
        return { inserted: 5 }
      },
      { _withSerializable: fakeRun as any },
    )

    expect(calls).toEqual(['tx-start', 'persist', 'tx-end'])
    expect(result).toEqual({ inserted: 5 })
    // Checkpoint write happened inside the tx, targeting clone_checkpoints.
    expect(writes).toHaveLength(1)
    expect(writes[0].table).toBe('clone_checkpoints')
    expect(writes[0].values).toMatchObject({
      job_id: 'job-1',
      phase: 'persist',
      step: 'complete',
    })
  })

  it('propagates error from fn — no checkpoint written', async () => {
    const writes: any[] = []
    const fakeDb = {
      insertInto: (_t: string) => ({
        values: (v: any) => ({ execute: async () => writes.push(v) }),
      }),
    }
    // The tx runner faithfully re-throws whatever fn throws (mirrors
    // Kysely's transaction semantics).
    const fakeRun = async (_db: any, fn: any) => {
      await fn(_db)
    }
    await expect(
      runCloneImport(
        fakeDb as any,
        'job-x',
        async () => {
          throw new Error('persist boom')
        },
        { _withSerializable: fakeRun as any },
      ),
    ).rejects.toThrow(/boom/)
    expect(writes).toHaveLength(0) // checkpoint never written
  })

  it('falls back to real withSerializable when no seam is provided', async () => {
    // Smoke-level wiring check — we just assert the opts.fn path is
    // reachable without having to hit a real DB. The real tx runner
    // expects a Kysely instance, so we stub transaction() to throw and
    // verify the call reaches it.
    const fakeDb: any = {
      transaction: () => {
        throw new Error('stub-reached-real-runner')
      },
    }
    await expect(
      runCloneImport(fakeDb, 'job-z', async () => undefined),
    ).rejects.toThrow(/stub-reached-real-runner/)
  })
})
