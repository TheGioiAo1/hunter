/**
 * Gbox Platform — Verification Worker tests
 *
 * Landing Page System Phase 1D. Exercises `runVerificationBatch` +
 * the new `checkARecord` pure helper. The worker now runs BOTH a
 * TXT ownership check AND an A-record-to-edge-IP check before a
 * row is flagged `verified`; these tests cover every branch of
 * that two-step flow.
 */

import { describe, expect, it } from 'vitest'
import { addDomain } from './service.js'
import { expectedTxtRecord } from '../ops/domain-verification.js'
import {
  checkARecord,
  runVerificationBatch,
  type DnsARecordResolver,
  type VerificationLogger,
} from './verification-worker.js'

// ---------------------------------------------------------------------------
// Inline fake DB (subset — worker only uses list + verify + update paths)
// ---------------------------------------------------------------------------

interface FakeRow {
  id: string
  shop_id: string
  domain: string
  is_primary: boolean
  ssl_status: string | null
  verified: boolean
  created_at: Date
  verification_token: string | null
  verification_method: string
  verified_at: Date | null
  ssl_provider: string | null
  ssl_issued_at: Date | null
  ssl_expires_at: Date | null
  ssl_last_error: string | null
}
type Op = '=' | '!=' | 'is'
interface Predicate {
  col: keyof FakeRow
  op: Op
  val: unknown
}
function match(row: FakeRow, p: Predicate): boolean {
  const v = row[p.col]
  if (p.op === '=') return v === p.val
  if (p.op === '!=') return v !== p.val
  return v === p.val
}

function createFakeDb(): any {
  const rows: FakeRow[] = []
  const makeSelect = () => {
    const preds: Predicate[] = []
    let lim: number | null = null
    const orders: Array<{ col: keyof FakeRow; dir: 'asc' | 'desc' }> = []
    const run = () => {
      let out = rows.filter((r) => preds.every((p) => match(r, p)))
      for (const o of orders.slice().reverse()) {
        out = out.slice().sort((a, b) => {
          const av = a[o.col] as any
          const bv = b[o.col] as any
          if (av === bv) return 0
          if (av == null) return 1
          if (bv == null) return -1
          const cmp = av < bv ? -1 : 1
          return o.dir === 'asc' ? cmp : -cmp
        })
      }
      if (lim != null) out = out.slice(0, lim)
      return out
    }
    const chain: any = {
      selectAll: () => chain,
      select: () => chain,
      where: (c: keyof FakeRow, o: Op, v: unknown) => {
        preds.push({ col: c, op: o, val: v })
        return chain
      },
      orderBy: (c: keyof FakeRow, d: 'asc' | 'desc' = 'asc') => {
        orders.push({ col: c, dir: d })
        return chain
      },
      limit: (n: number) => {
        lim = n
        return chain
      },
      execute: async () => run(),
      executeTakeFirst: async () => run()[0],
      executeTakeFirstOrThrow: async () => {
        const r = run()[0]
        if (!r) throw new Error('no row')
        return r
      },
    }
    return chain
  }
  const makeUpdate = () => {
    const preds: Predicate[] = []
    let patch: Partial<FakeRow> = {}
    const chain: any = {
      set: (p: Partial<FakeRow>) => {
        patch = { ...patch, ...p }
        return chain
      },
      where: (c: keyof FakeRow, o: Op, v: unknown) => {
        preds.push({ col: c, op: o, val: v })
        return chain
      },
      execute: async () => {
        for (const row of rows) {
          if (preds.every((p) => match(row, p))) {
            Object.assign(row, patch)
          }
        }
      },
    }
    return chain
  }
  const makeInsert = () => {
    let toInsert: Partial<FakeRow> | null = null
    const chain: any = {
      values: (v: Partial<FakeRow>) => {
        toInsert = v
        return chain
      },
      execute: async () => {
        if (toInsert) {
          rows.push({
            id: toInsert.id ?? 'x',
            shop_id: toInsert.shop_id ?? '',
            domain: toInsert.domain ?? '',
            is_primary: toInsert.is_primary ?? false,
            ssl_status: toInsert.ssl_status ?? null,
            verified: toInsert.verified ?? false,
            created_at: toInsert.created_at ?? new Date(),
            verification_token: toInsert.verification_token ?? null,
            verification_method: toInsert.verification_method ?? 'txt',
            verified_at: toInsert.verified_at ?? null,
            ssl_provider: toInsert.ssl_provider ?? null,
            ssl_issued_at: toInsert.ssl_issued_at ?? null,
            ssl_expires_at: toInsert.ssl_expires_at ?? null,
            ssl_last_error: toInsert.ssl_last_error ?? null,
          })
        }
      },
    }
    return chain
  }
  const client: any = {
    selectFrom: () => makeSelect(),
    insertInto: () => makeInsert(),
    updateTable: () => makeUpdate(),
    deleteFrom: () => ({
      where: () => ({ where: () => ({ execute: async () => {} }) }),
    }),
    transaction: () => ({
      execute: async (cb: (trx: any) => Promise<unknown>) => cb(client),
    }),
    __rows: rows,
  }
  return client
}

// ---------------------------------------------------------------------------
// Logger helper
// ---------------------------------------------------------------------------

function collectingLogger() {
  const lines: Array<{ level: 'info' | 'warn' | 'error'; event: string; fields?: any }> =
    []
  const logger: VerificationLogger = {
    info: (event, fields) => lines.push({ level: 'info', event, fields }),
    warn: (event, fields) => lines.push({ level: 'warn', event, fields }),
    error: (event, fields) => lines.push({ level: 'error', event, fields }),
  }
  return { logger, lines }
}

// ---------------------------------------------------------------------------
// Default test fixtures
// ---------------------------------------------------------------------------

const EDGE_IP = '203.0.113.7'
const OTHER_IP = '198.51.100.42'
const EDGE_SET = new Set([EDGE_IP])

/** An A resolver that always returns the configured Gbox edge IP. */
const hitResolver: DnsARecordResolver = async () => [EDGE_IP]

// ---------------------------------------------------------------------------
// checkARecord pure helper
// ---------------------------------------------------------------------------

describe('checkARecord', () => {
  it('returns ok + matchedIp when any A record intersects the edge set', async () => {
    const res = await checkARecord(
      'thaibeotit.com',
      async () => [OTHER_IP, EDGE_IP],
      EDGE_SET,
    )
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.matchedIp).toBe(EDGE_IP)
  })

  it('returns mismatch when no A record is in the edge set', async () => {
    const res = await checkARecord(
      'thaibeotit.com',
      async () => [OTHER_IP],
      EDGE_SET,
    )
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reason).toBe('mismatch')
    expect(res.observed).toEqual([OTHER_IP])
  })

  it('returns not_found for an empty resolver result', async () => {
    const res = await checkARecord('thaibeotit.com', async () => [], EDGE_SET)
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reason).toBe('not_found')
  })

  it('maps ENOTFOUND to not_found', async () => {
    const res = await checkARecord(
      'thaibeotit.com',
      async () => {
        const err = new Error('nxdomain')
        ;(err as any).code = 'ENOTFOUND'
        throw err
      },
      EDGE_SET,
    )
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reason).toBe('not_found')
  })

  it('maps unexpected throws to lookup_error', async () => {
    const res = await checkARecord(
      'thaibeotit.com',
      async () => {
        throw new Error('servfail')
      },
      EDGE_SET,
    )
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reason).toBe('lookup_error')
  })
})

// ---------------------------------------------------------------------------
// runVerificationBatch
// ---------------------------------------------------------------------------

describe('runVerificationBatch', () => {
  it('returns empty summary when no pending rows', async () => {
    const db = createFakeDb()
    const { logger, lines } = collectingLogger()
    const summary = await runVerificationBatch(db, {
      txtResolver: async () => [],
      aResolver: hitResolver,
      edgeIpv4: EDGE_SET,
      logger,
    })
    expect(summary.total).toBe(0)
    expect(summary.verified).toBe(0)
    expect(lines.some((l) => l.event === 'domain_verifier.tick.empty')).toBe(
      true,
    )
  })

  it('warns when edgeIpv4 set is empty at tick start', async () => {
    const db = createFakeDb()
    await addDomain(db, { shopId: 's1', domain: 'a.example.io' })
    const { logger, lines } = collectingLogger()
    await runVerificationBatch(db, {
      txtResolver: async () => [],
      aResolver: hitResolver,
      edgeIpv4: new Set(),
      logger,
    })
    expect(lines.some((l) => l.event === 'domain_verifier.no_edge_ips')).toBe(
      true,
    )
  })

  it('flips rows to verified when BOTH TXT and A record match', async () => {
    const db = createFakeDb()
    const a = await addDomain(db, { shopId: 's1', domain: 'a.example.io' })
    const b = await addDomain(db, { shopId: 's1', domain: 'b.example.io' })
    if (!a.ok || !b.ok) throw new Error('seed')

    const tokens: Record<string, string> = {
      'a.example.io': a.record.verificationToken!,
      'b.example.io': b.record.verificationToken!,
    }
    const txtResolver = async (host: string): Promise<string[][]> => {
      const bare = host.replace('_gbox-verify.', '')
      const tok = tokens[bare]
      return tok ? [[expectedTxtRecord(tok)]] : []
    }
    const { logger } = collectingLogger()

    const summary = await runVerificationBatch(db, {
      txtResolver,
      aResolver: hitResolver,
      edgeIpv4: EDGE_SET,
      logger,
    })
    expect(summary.total).toBe(2)
    expect(summary.verified).toBe(2)
    expect(summary.aRecordMissing).toBe(0)
  })

  it('rolls back verified=false when TXT passes but A record misses', async () => {
    const db = createFakeDb()
    const a = await addDomain(db, { shopId: 's1', domain: 'wrong-a.example.io' })
    if (!a.ok) throw new Error('seed')

    const txtResolver = async (host: string): Promise<string[][]> => {
      if (host.includes('wrong-a'))
        return [[expectedTxtRecord(a.record.verificationToken!)]]
      return []
    }
    const aResolver: DnsARecordResolver = async () => [OTHER_IP]
    const { logger, lines } = collectingLogger()

    const summary = await runVerificationBatch(db, {
      txtResolver,
      aResolver,
      edgeIpv4: EDGE_SET,
      logger,
    })
    expect(summary.total).toBe(1)
    expect(summary.verified).toBe(0)
    expect(summary.aRecordMissing).toBe(1)

    // Row should have been rolled back to verified=false with an
    // ssl_last_error explaining the mismatch.
    const row = db.__rows[0]
    expect(row.verified).toBe(false)
    expect(row.verified_at).toBeNull()
    expect(row.ssl_last_error).toMatch(/A record/)
    expect(row.ssl_last_error).toContain(EDGE_IP)

    expect(
      lines.some((l) => l.event === 'domain_verifier.a_record_failed'),
    ).toBe(true)
  })

  it('counts TXT txt_not_found and txt_mismatch separately', async () => {
    const db = createFakeDb()
    await addDomain(db, { shopId: 's1', domain: 'missing.example.io' })
    await addDomain(db, { shopId: 's1', domain: 'wrong.example.io' })

    const txtResolver = async (host: string): Promise<string[][]> => {
      if (host.includes('missing')) return []
      if (host.includes('wrong'))
        return [['gbox-site-verification=totallywrong']]
      return []
    }
    const { logger, lines } = collectingLogger()

    const summary = await runVerificationBatch(db, {
      txtResolver,
      aResolver: hitResolver,
      edgeIpv4: EDGE_SET,
      logger,
    })
    expect(summary.total).toBe(2)
    expect(summary.verified).toBe(0)
    expect(summary.notFound).toBe(1)
    expect(summary.failed).toBe(1)
    expect(
      lines.some((l) => l.event === 'domain_verifier.txt_not_found'),
    ).toBe(true)
    expect(
      lines.some((l) => l.event === 'domain_verifier.txt_mismatch'),
    ).toBe(true)
  })

  it('treats ENOTFOUND TXT resolver errors as notFound (retriable)', async () => {
    const db = createFakeDb()
    await addDomain(db, { shopId: 's1', domain: 'nodns.example.io' })

    const txtResolver = async (): Promise<string[][]> => {
      const err = new Error('nxdomain')
      ;(err as any).code = 'ENOTFOUND'
      throw err
    }
    const { logger } = collectingLogger()
    const summary = await runVerificationBatch(db, {
      txtResolver,
      aResolver: hitResolver,
      edgeIpv4: EDGE_SET,
      logger,
    })
    expect(summary.notFound).toBe(1)
    expect(summary.failed).toBe(0)
    expect(summary.aRecordMissing).toBe(0)
  })

  it('respects batchSize', async () => {
    const db = createFakeDb()
    for (let i = 0; i < 5; i++) {
      await addDomain(db, {
        shopId: 's1',
        domain: `host${i}.example.io`,
      })
    }
    const { logger } = collectingLogger()
    const summary = await runVerificationBatch(db, {
      txtResolver: async () => [],
      aResolver: hitResolver,
      edgeIpv4: EDGE_SET,
      logger,
      batchSize: 2,
    })
    expect(summary.total).toBe(2)
  })
})
