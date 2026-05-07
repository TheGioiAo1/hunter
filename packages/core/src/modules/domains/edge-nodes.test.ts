/**
 * Gbox Platform — Edge Node Registry tests
 * (Landing Page System Phase 1D)
 *
 * Exercises every branch of `edge-nodes.ts` against a hand-rolled
 * Kysely facade. Same shape as `service.test.ts` — we only speak the
 * tiny subset of the query-builder API that `edge-nodes.ts` actually
 * calls (`selectFrom`, `insertInto`, `updateTable` with `where` /
 * `orderBy` / `selectAll` / `select` / `set`).
 *
 * Coverage:
 *   - listActiveEdgeNodes — only active rows, ordered by hostname
 *   - loadActiveEdgeIpv4Set — set semantics, excludes non-active
 *   - upsertEdgeNode — insert path + update path + optional fields
 *   - setEdgeNodeStatus — happy path + missing hostname
 *   - mapRow — status defaulting, null date coercion
 *
 * The test also piggybacks the `buildInput` / `parseArgs` unit tests
 * for `scripts/ops/register-edge-node.ts` because those helpers are
 * pure and share the same "edge node registration" feature slice —
 * a single test file keeps the two pieces co-located so breaking one
 * lights up both in CI.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import {
  listActiveEdgeNodes,
  loadActiveEdgeIpv4Set,
  setEdgeNodeStatus,
  upsertEdgeNode,
  type EdgeNodeStatus,
} from './edge-nodes.js'
import {
  assertValidHostname,
  assertValidIpv4,
  assertValidIpv6,
  assertValidStatus,
  buildInput,
  parseArgs,
} from '../../../../../scripts/ops/register-edge-node-lib.js'

// ---------------------------------------------------------------------------
// In-memory edge_nodes store + Kysely facade
// ---------------------------------------------------------------------------

interface FakeRow {
  id: string
  hostname: string
  public_ipv4: string
  public_ipv6: string | null
  region: string | null
  status: string
  notes: string | null
  created_at: Date | null
  updated_at: Date | null
}

interface Predicate {
  col: keyof FakeRow
  op: '=' | '!=' | 'is'
  val: unknown
}

function matchPredicate(row: FakeRow, p: Predicate): boolean {
  const value = row[p.col]
  switch (p.op) {
    case '=':
      return value === p.val
    case '!=':
      return value !== p.val
    case 'is':
      return value === p.val
  }
}

let seqId = 0
function nextId(): string {
  seqId++
  return `edge-${seqId.toString(16).padStart(4, '0')}`
}

function createFakeDb(initial: FakeRow[] = []) {
  const rows: FakeRow[] = [...initial]

  const makeSelectChain = () => {
    const predicates: Predicate[] = []
    const orderBys: Array<{ col: keyof FakeRow; dir: 'asc' | 'desc' }> = []

    const applyFilters = (): FakeRow[] => {
      let out = rows.filter((r) => predicates.every((p) => matchPredicate(r, p)))
      for (const ob of orderBys.slice().reverse()) {
        out = out.slice().sort((a, b) => {
          const av = a[ob.col] as any
          const bv = b[ob.col] as any
          if (av === bv) return 0
          if (av == null) return 1
          if (bv == null) return -1
          const cmp = av < bv ? -1 : 1
          return ob.dir === 'asc' ? cmp : -cmp
        })
      }
      return out
    }

    const chain: any = {
      selectAll: () => chain,
      select: () => chain,
      where: (col: keyof FakeRow, op: Predicate['op'], val: unknown) => {
        predicates.push({ col, op, val })
        return chain
      },
      orderBy: (col: keyof FakeRow, dir: 'asc' | 'desc' = 'asc') => {
        orderBys.push({ col, dir })
        return chain
      },
      execute: async () => applyFilters(),
      executeTakeFirst: async () => applyFilters()[0],
      executeTakeFirstOrThrow: async () => {
        const r = applyFilters()[0]
        if (!r) throw new Error('no row found')
        return r
      },
    }
    return chain
  }

  const makeUpdateChain = () => {
    const predicates: Predicate[] = []
    let patch: Partial<FakeRow> = {}

    const chain: any = {
      set: (p: Partial<FakeRow>) => {
        patch = { ...patch, ...p }
        return chain
      },
      where: (col: keyof FakeRow, op: Predicate['op'], val: unknown) => {
        predicates.push({ col, op, val })
        return chain
      },
      execute: async () => {
        for (const row of rows) {
          if (predicates.every((p) => matchPredicate(row, p))) {
            Object.assign(row, patch)
          }
        }
      },
    }
    return chain
  }

  const makeInsertChain = () => {
    let toInsert: Partial<FakeRow> | null = null
    const chain: any = {
      values: (v: Partial<FakeRow>) => {
        toInsert = v
        return chain
      },
      execute: async () => {
        if (!toInsert) return
        const full: FakeRow = {
          id: (toInsert.id as string | undefined) ?? nextId(),
          hostname: toInsert.hostname ?? '',
          public_ipv4: toInsert.public_ipv4 ?? '',
          public_ipv6: toInsert.public_ipv6 ?? null,
          region: toInsert.region ?? null,
          status: toInsert.status ?? 'active',
          notes: toInsert.notes ?? null,
          created_at: toInsert.created_at ?? new Date(),
          updated_at: toInsert.updated_at ?? new Date(),
        }
        rows.push(full)
      },
    }
    return chain
  }

  const client: any = {
    selectFrom: (_t: string) => makeSelectChain(),
    insertInto: (_t: string) => makeInsertChain(),
    updateTable: (_t: string) => makeUpdateChain(),
    __rows: rows,
  }
  return client
}

// Shared row factory — every field explicit so a failing test's
// diff is readable (no hidden defaults).
function row(overrides: Partial<FakeRow> = {}): FakeRow {
  // Use `in` checks for nullable fields so callers can explicitly
  // pass `null` and have it propagate through instead of being
  // swallowed by a `??` fallback.
  const base: FakeRow = {
    id: overrides.id ?? nextId(),
    hostname: overrides.hostname ?? 'edge-test.example.com',
    public_ipv4: overrides.public_ipv4 ?? '203.0.113.1',
    public_ipv6: 'public_ipv6' in overrides ? overrides.public_ipv6! : null,
    region: 'region' in overrides ? overrides.region! : null,
    status: overrides.status ?? 'active',
    notes: 'notes' in overrides ? overrides.notes! : null,
    created_at:
      'created_at' in overrides
        ? overrides.created_at!
        : new Date('2026-01-01T00:00:00Z'),
    updated_at:
      'updated_at' in overrides
        ? overrides.updated_at!
        : new Date('2026-01-01T00:00:00Z'),
  }
  return base
}

beforeEach(() => {
  seqId = 0
})

// ---------------------------------------------------------------------------
// listActiveEdgeNodes
// ---------------------------------------------------------------------------

describe('listActiveEdgeNodes', () => {
  it('returns only active rows sorted by hostname', async () => {
    const db = createFakeDb([
      row({ hostname: 'edge-03.gbox.co', public_ipv4: '203.0.113.3' }),
      row({ hostname: 'edge-01.gbox.co', public_ipv4: '203.0.113.1' }),
      row({ hostname: 'edge-02.gbox.co', public_ipv4: '203.0.113.2', status: 'draining' }),
      row({ hostname: 'edge-04.gbox.co', public_ipv4: '203.0.113.4', status: 'offline' }),
    ])

    const nodes = await listActiveEdgeNodes(db)
    expect(nodes.map((n) => n.hostname)).toEqual([
      'edge-01.gbox.co',
      'edge-03.gbox.co',
    ])
    expect(nodes.every((n) => n.status === 'active')).toBe(true)
  })

  it('returns empty array when the table is empty', async () => {
    const db = createFakeDb()
    expect(await listActiveEdgeNodes(db)).toEqual([])
  })

  it('maps all fields including nullable ones', async () => {
    const db = createFakeDb([
      row({
        hostname: 'edge-01.gbox.co',
        public_ipv4: '203.0.113.1',
        public_ipv6: '2001:db8::1',
        region: 'ap-southeast-1',
        notes: 'HA pair primary',
      }),
    ])

    const [node] = await listActiveEdgeNodes(db)
    expect(node).toBeDefined()
    expect(node!.publicIpv4).toBe('203.0.113.1')
    expect(node!.publicIpv6).toBe('2001:db8::1')
    expect(node!.region).toBe('ap-southeast-1')
    expect(node!.notes).toBe('HA pair primary')
    expect(node!.status).toBe('active')
  })

  it('coerces missing created_at to the epoch so callers never see null', async () => {
    const db = createFakeDb([
      row({ hostname: 'edge-01.gbox.co', created_at: null, updated_at: null }),
    ])
    const [node] = await listActiveEdgeNodes(db)
    expect(node!.createdAt).toBeInstanceOf(Date)
    expect(node!.createdAt.getTime()).toBe(0)
    expect(node!.updatedAt.getTime()).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// loadActiveEdgeIpv4Set
// ---------------------------------------------------------------------------

describe('loadActiveEdgeIpv4Set', () => {
  it('returns a Set of active IPv4s only — draining and offline excluded', async () => {
    const db = createFakeDb([
      row({ hostname: 'a', public_ipv4: '203.0.113.1' }),
      row({ hostname: 'b', public_ipv4: '203.0.113.2' }),
      row({ hostname: 'c', public_ipv4: '198.51.100.1', status: 'draining' }),
      row({ hostname: 'd', public_ipv4: '198.51.100.2', status: 'offline' }),
    ])

    const set = await loadActiveEdgeIpv4Set(db)
    expect(set).toBeInstanceOf(Set)
    expect(set.size).toBe(2)
    expect(set.has('203.0.113.1')).toBe(true)
    expect(set.has('203.0.113.2')).toBe(true)
    expect(set.has('198.51.100.1')).toBe(false)
  })

  it('dedupes if two active rows share the same IP (rare, but HA failover quirk)', async () => {
    const db = createFakeDb([
      row({ hostname: 'a', public_ipv4: '203.0.113.1' }),
      row({ hostname: 'b', public_ipv4: '203.0.113.1' }),
    ])
    const set = await loadActiveEdgeIpv4Set(db)
    expect(set.size).toBe(1)
  })

  it('returns an empty Set when no active rows exist', async () => {
    const db = createFakeDb([row({ status: 'offline' })])
    const set = await loadActiveEdgeIpv4Set(db)
    expect(set.size).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// upsertEdgeNode
// ---------------------------------------------------------------------------

describe('upsertEdgeNode', () => {
  it('inserts a new row when hostname is unseen', async () => {
    const db = createFakeDb()
    const node = await upsertEdgeNode(db, {
      hostname: 'edge-01.gbox.co',
      publicIpv4: '203.0.113.7',
      region: 'ap-southeast-1',
      notes: 'bootstrap',
    })

    expect(node.hostname).toBe('edge-01.gbox.co')
    expect(node.publicIpv4).toBe('203.0.113.7')
    expect(node.region).toBe('ap-southeast-1')
    expect(node.status).toBe('active')
    expect(node.notes).toBe('bootstrap')
    expect(db.__rows.length).toBe(1)
  })

  it('updates the existing row when hostname already present (idempotent re-run)', async () => {
    const db = createFakeDb([
      row({
        hostname: 'edge-01.gbox.co',
        public_ipv4: '203.0.113.1',
        region: 'us-east-1',
        notes: 'old',
      }),
    ])

    const node = await upsertEdgeNode(db, {
      hostname: 'edge-01.gbox.co',
      publicIpv4: '203.0.113.99',
      region: 'ap-southeast-1',
      notes: 'rotated',
    })

    expect(node.publicIpv4).toBe('203.0.113.99')
    expect(node.region).toBe('ap-southeast-1')
    expect(node.notes).toBe('rotated')
    // Still one row — we updated in place, did not insert.
    expect(db.__rows.length).toBe(1)
  })

  it('defaults status to active and nullable fields to null when omitted', async () => {
    const db = createFakeDb()
    const node = await upsertEdgeNode(db, {
      hostname: 'edge-02.gbox.co',
      publicIpv4: '203.0.113.8',
    })

    expect(node.status).toBe('active')
    expect(node.region).toBeNull()
    expect(node.publicIpv6).toBeNull()
    expect(node.notes).toBeNull()
  })

  it('accepts explicit non-active status (e.g. bootstrapping a drain row)', async () => {
    const db = createFakeDb()
    const node = await upsertEdgeNode(db, {
      hostname: 'edge-03.gbox.co',
      publicIpv4: '203.0.113.9',
      status: 'draining',
    })
    expect(node.status).toBe('draining')
  })

  it('accepts IPv6 addresses on the insert path', async () => {
    const db = createFakeDb()
    const node = await upsertEdgeNode(db, {
      hostname: 'edge-04.gbox.co',
      publicIpv4: '203.0.113.10',
      publicIpv6: '2001:db8::10',
    })
    expect(node.publicIpv6).toBe('2001:db8::10')
  })
})

// ---------------------------------------------------------------------------
// setEdgeNodeStatus
// ---------------------------------------------------------------------------

describe('setEdgeNodeStatus', () => {
  it('flips an existing row through the lifecycle', async () => {
    const db = createFakeDb([row({ hostname: 'edge-01.gbox.co', status: 'active' })])

    const draining = await setEdgeNodeStatus(db, 'edge-01.gbox.co', 'draining')
    expect(draining?.status).toBe('draining')

    const offline = await setEdgeNodeStatus(db, 'edge-01.gbox.co', 'offline')
    expect(offline?.status).toBe('offline')

    // And no longer shows up in the active list.
    const active = await listActiveEdgeNodes(db)
    expect(active.length).toBe(0)
  })

  it('returns null for an unknown hostname (no insert)', async () => {
    const db = createFakeDb()
    const res = await setEdgeNodeStatus(db, 'nobody.gbox.co', 'offline')
    expect(res).toBeNull()
    expect(db.__rows.length).toBe(0)
  })

  it('updates updated_at on every transition so god-admin can sort by recency', async () => {
    const db = createFakeDb([
      row({
        hostname: 'edge-01.gbox.co',
        created_at: new Date('2026-01-01T00:00:00Z'),
        updated_at: new Date('2026-01-01T00:00:00Z'),
      }),
    ])
    const before = Date.now()
    const updated = await setEdgeNodeStatus(db, 'edge-01.gbox.co', 'draining')
    expect(updated).toBeDefined()
    expect(updated!.updatedAt.getTime()).toBeGreaterThanOrEqual(before)
  })
})

// ---------------------------------------------------------------------------
// register-edge-node CLI parsers
// ---------------------------------------------------------------------------

describe('parseArgs', () => {
  it('parses --key value pairs', () => {
    expect(
      parseArgs(['--hostname', 'edge-01.gbox.co', '--ipv4', '203.0.113.1']),
    ).toEqual({ hostname: 'edge-01.gbox.co', ipv4: '203.0.113.1' })
  })

  it('treats a --flag followed by another --flag as a boolean', () => {
    expect(parseArgs(['--dry-run', '--hostname', 'a.b.c'])).toEqual({
      'dry-run': 'true',
      hostname: 'a.b.c',
    })
  })

  it('ignores bare positional tokens that are not flags', () => {
    expect(parseArgs(['register', '--hostname', 'a.b.c'])).toEqual({
      hostname: 'a.b.c',
    })
  })

  it('handles empty argv', () => {
    expect(parseArgs([])).toEqual({})
  })
})

describe('assertValidHostname', () => {
  it('accepts FQDNs', () => {
    expect(() => assertValidHostname('edge-01.gbox.co')).not.toThrow()
    expect(() => assertValidHostname('a.b.c.example.io')).not.toThrow()
  })

  it('rejects single labels and empty input', () => {
    expect(() => assertValidHostname('localhost')).toThrow(/Invalid hostname/)
    expect(() => assertValidHostname('')).toThrow(/Invalid hostname/)
  })

  it('rejects hostnames containing shell metacharacters', () => {
    expect(() => assertValidHostname('edge;rm.gbox.co')).toThrow(/Invalid hostname/)
  })
})

describe('assertValidIpv4', () => {
  it('accepts dotted quads', () => {
    expect(() => assertValidIpv4('203.0.113.7')).not.toThrow()
    expect(() => assertValidIpv4('0.0.0.0')).not.toThrow()
    expect(() => assertValidIpv4('255.255.255.255')).not.toThrow()
  })

  it('rejects out-of-range octets', () => {
    expect(() => assertValidIpv4('256.0.0.1')).toThrow(/out of range/)
    expect(() => assertValidIpv4('1.2.3.999')).toThrow(/out of range/)
  })

  it('rejects non-dotted-quad strings', () => {
    expect(() => assertValidIpv4('not-an-ip')).toThrow(/dotted-quad/)
    expect(() => assertValidIpv4('1.2.3')).toThrow(/dotted-quad/)
    expect(() => assertValidIpv4('2001:db8::1')).toThrow(/dotted-quad/)
  })
})

describe('assertValidIpv6', () => {
  it('accepts compressed IPv6', () => {
    expect(() => assertValidIpv6('2001:db8::1')).not.toThrow()
    expect(() => assertValidIpv6('::1')).not.toThrow()
  })

  it('rejects IPv4-shaped or non-hex strings', () => {
    expect(() => assertValidIpv6('203.0.113.1')).toThrow(/colon/)
    expect(() => assertValidIpv6('hello')).toThrow(/colon/)
  })
})

describe('assertValidStatus', () => {
  it('accepts the three valid statuses', () => {
    for (const s of ['active', 'draining', 'offline'] as EdgeNodeStatus[]) {
      expect(() => assertValidStatus(s)).not.toThrow()
    }
  })

  it('rejects anything else', () => {
    expect(() => assertValidStatus('deleted')).toThrow(/must be one of/)
    expect(() => assertValidStatus('')).toThrow(/must be one of/)
  })
})

describe('buildInput', () => {
  it('prefers flags over env when both are set', () => {
    const input = buildInput(
      { hostname: 'flag.gbox.co', ipv4: '203.0.113.1' },
      { EDGE_HOSTNAME: 'env.gbox.co', EDGE_PUBLIC_IP: '198.51.100.1' } as any,
    )
    expect(input.hostname).toBe('flag.gbox.co')
    expect(input.publicIpv4).toBe('203.0.113.1')
  })

  it('falls back to env when a flag is absent', () => {
    const input = buildInput(
      {},
      {
        EDGE_HOSTNAME: 'env.gbox.co',
        EDGE_PUBLIC_IP: '198.51.100.1',
        EDGE_REGION: 'ap-southeast-1',
      } as any,
    )
    expect(input.hostname).toBe('env.gbox.co')
    expect(input.publicIpv4).toBe('198.51.100.1')
    expect(input.region).toBe('ap-southeast-1')
    expect(input.status).toBe('active')
  })

  it('throws when hostname is missing entirely', () => {
    expect(() =>
      buildInput({ ipv4: '203.0.113.1' }, {} as any),
    ).toThrow(/Missing --hostname/)
  })

  it('throws when ipv4 is missing entirely', () => {
    expect(() =>
      buildInput({ hostname: 'edge.gbox.co' }, {} as any),
    ).toThrow(/Missing --ipv4/)
  })

  it('propagates validation errors from the asserters', () => {
    expect(() =>
      buildInput({ hostname: 'localhost', ipv4: '1.2.3.4' }, {} as any),
    ).toThrow(/Invalid hostname/)
    expect(() =>
      buildInput({ hostname: 'edge.gbox.co', ipv4: '300.0.0.1' }, {} as any),
    ).toThrow(/out of range/)
  })

  it('returns the full UpsertEdgeNodeInput shape with nullable defaults', () => {
    const input = buildInput(
      { hostname: 'edge.gbox.co', ipv4: '203.0.113.1' },
      {} as any,
    )
    expect(input).toEqual({
      hostname: 'edge.gbox.co',
      publicIpv4: '203.0.113.1',
      publicIpv6: null,
      region: null,
      status: 'active',
      notes: null,
    })
  })
})
