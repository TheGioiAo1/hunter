/**
 * Gbox Platform — Cloudflare Domain Service Tests (Phase 2B Sprint 2 + Phase 7 PR3)
 *
 * Covers every exported function in `cloudflare-service.ts`. Uses an
 * in-memory Kysely facade (same pattern as `service.test.ts`) so the
 * DB-backed paths (addDomain / verifyViaCloudflare / verifyDomain /
 * setPrimary / setRedirect / removeDomain) can be exercised without
 * Postgres. The facade simulates the two pieces of the real schema
 * that matter for these tests:
 *
 *   1. `returning(['id'])` on inserts — so addDomain's
 *      `.executeTakeFirstOrThrow()` can return a fresh UUID.
 *   2. ON DELETE SET NULL on `redirect_to_domain_id` — so removing a
 *      redirect target clears the source's pointer, matching
 *      migration 035's FK semantics.
 *
 * Phase 7 PR3 extends the old pure-only coverage (normalizeDomainInput)
 * to the full DB surface. We ran into the classic "the DB-bound paths
 * are exercised in the store-admin integration test suite" comment in
 * the original file — in practice that suite only covers the
 * onboarding-nudge branch, so these are net-new.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import {
  addDomain,
  normalizeDomainInput,
  removeDomain,
  setPrimary,
  setRedirect,
  verifyDomain,
  verifyViaCloudflare,
  type ResolverBundle,
} from './cloudflare-service.js'
import type {
  DnsAResolver,
  DnsCnameResolver,
  DnsNsResolver,
} from '../ops/cloudflare-detect.js'

// ---------------------------------------------------------------------------
// In-memory shop_domains store + Kysely facade
// ---------------------------------------------------------------------------

/**
 * Subset of the `shop_domains` row the cloudflare-service writes. Uses
 * plain JS types — nameservers is stored as a JSON string (the service
 * calls `JSON.stringify`) so the facade mirrors that.
 */
interface FakeRow {
  id: string
  shop_id: string
  domain: string
  is_primary: boolean
  ssl_status: string | null
  verified: boolean
  verification_token: string | null
  verification_method: string
  nameservers: string | null
  cloudflare_proxied: boolean
  dns_target: string | null
  last_checked_at: string | null
  updated_at: string | null
  verified_at: string | null
  redirect_to_domain_id: string | null
  created_at: Date
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

let idCounter = 0
function nextId(): string {
  idCounter += 1
  // UUID-ish shape so anything that asserts the length passes. The
  // tests never parse these back — just use them for FK linkage.
  return `00000000-0000-0000-0000-${String(idCounter).padStart(12, '0')}`
}

function createFakeDb(initialRows: FakeRow[] = []) {
  const rows: FakeRow[] = [...initialRows]

  const makeSelectChain = () => {
    const predicates: Predicate[] = []
    const chain: any = {
      select: () => chain,
      selectAll: () => chain,
      where: (col: keyof FakeRow, op: Predicate['op'], val: unknown) => {
        predicates.push({ col, op, val })
        return chain
      },
      orderBy: () => chain,
      limit: () => chain,
      execute: async () =>
        rows.filter((r) => predicates.every((p) => matchPredicate(r, p))),
      executeTakeFirst: async () =>
        rows.find((r) => predicates.every((p) => matchPredicate(r, p))),
      executeTakeFirstOrThrow: async () => {
        const r = rows.find((x) => predicates.every((p) => matchPredicate(x, p)))
        if (!r) throw new Error('no row found')
        return r
      },
    }
    return chain
  }

  const makeInsertChain = () => {
    let toInsert: Partial<FakeRow> | null = null
    let returnCols: string[] = []
    const chain: any = {
      values: (v: Partial<FakeRow>) => {
        toInsert = v
        return chain
      },
      returning: (cols: string[]) => {
        returnCols = cols
        return chain
      },
      execute: async () => {
        if (!toInsert) return
        const full = finishRow(toInsert)
        rows.push(full)
      },
      executeTakeFirstOrThrow: async () => {
        if (!toInsert) throw new Error('no values supplied')
        const full = finishRow(toInsert)
        rows.push(full)
        // Return a projection if `.returning()` was used.
        const out: Record<string, unknown> = {}
        for (const c of returnCols) out[c] = (full as any)[c]
        return out
      },
    }
    return chain
  }

  const makeUpdateChain = () => {
    const predicates: Predicate[] = []
    let patch: Record<string, unknown> = {}
    const chain: any = {
      set: (p: Record<string, unknown>) => {
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

  const makeDeleteChain = () => {
    const predicates: Predicate[] = []
    const chain: any = {
      where: (col: keyof FakeRow, op: Predicate['op'], val: unknown) => {
        predicates.push({ col, op, val })
        return chain
      },
      execute: async () => {
        for (let i = rows.length - 1; i >= 0; i--) {
          const row = rows[i]!
          if (predicates.every((p) => matchPredicate(row, p))) {
            // Simulate ON DELETE SET NULL on redirect_to_domain_id so
            // any row that was redirecting to this one gets cleared
            // (matches migration 035's FK semantics).
            const deletedId = row.id
            rows.splice(i, 1)
            for (const other of rows) {
              if (other.redirect_to_domain_id === deletedId) {
                other.redirect_to_domain_id = null
              }
            }
          }
        }
      },
    }
    return chain
  }

  const client: any = {
    selectFrom: () => makeSelectChain(),
    insertInto: () => makeInsertChain(),
    updateTable: () => makeUpdateChain(),
    deleteFrom: () => makeDeleteChain(),
    __rows: rows,
  }
  return client
}

function finishRow(partial: Partial<FakeRow>): FakeRow {
  return {
    id: partial.id ?? nextId(),
    shop_id: partial.shop_id ?? '',
    domain: partial.domain ?? '',
    is_primary: partial.is_primary ?? false,
    ssl_status: partial.ssl_status ?? null,
    verified: partial.verified ?? false,
    verification_token: partial.verification_token ?? null,
    verification_method: partial.verification_method ?? 'cloudflare',
    nameservers: partial.nameservers ?? null,
    cloudflare_proxied: partial.cloudflare_proxied ?? false,
    dns_target: partial.dns_target ?? null,
    last_checked_at: partial.last_checked_at ?? null,
    updated_at: partial.updated_at ?? null,
    verified_at: partial.verified_at ?? null,
    redirect_to_domain_id: partial.redirect_to_domain_id ?? null,
    created_at: partial.created_at ?? new Date(),
  }
}

// ---------------------------------------------------------------------------
// Resolver fakes
// ---------------------------------------------------------------------------

const CF_NS: string[] = ['dara.ns.cloudflare.com', 'igor.ns.cloudflare.com']
const NON_CF_NS: string[] = ['ns1.registrar.example', 'ns2.registrar.example']

function nsResolverOk(records: string[]): DnsNsResolver {
  return async () => records
}

function nsResolverThrow(message: string): DnsNsResolver {
  return async () => {
    throw new Error(message)
  }
}

function aResolverOk(ips: string[]): DnsAResolver {
  return async () => ips
}

function aResolverThrow(message: string): DnsAResolver {
  return async () => {
    throw new Error(message)
  }
}

function cnameResolverOk(targets: string[]): DnsCnameResolver {
  return async () => targets
}

function makeBundle(opts: {
  ns?: DnsNsResolver
  a?: DnsAResolver
  cname?: DnsCnameResolver
}): ResolverBundle {
  return {
    ns: opts.ns ?? nsResolverOk([]),
    ...(opts.a ? { a: opts.a } : {}),
    ...(opts.cname ? { cname: opts.cname } : {}),
  }
}

// ---------------------------------------------------------------------------
// normalizeDomainInput (pure, retained for regression)
// ---------------------------------------------------------------------------

describe('normalizeDomainInput', () => {
  it('lowercases, trims, strips scheme + trailing slashes', () => {
    expect(normalizeDomainInput('  HTTPS://Shop.Acme.IO/  ')).toBe('shop.acme.io')
    expect(normalizeDomainInput('shop.acme.io//')).toBe('shop.acme.io')
    expect(normalizeDomainInput('')).toBe('')
  })
})

// ---------------------------------------------------------------------------
// addDomain
// ---------------------------------------------------------------------------

describe('addDomain', () => {
  let db: any
  beforeEach(() => {
    db = createFakeDb()
  })

  it('inserts a pending row with a verification token + cloudflare method', async () => {
    const res = await addDomain(db, {
      shopId: 'shop-1',
      rawDomain: 'shop.acme.io',
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.domain).toBe('shop.acme.io')
    const row = (db.__rows as FakeRow[])[0]!
    expect(row.verified).toBe(false)
    expect(row.verification_method).toBe('cloudflare')
    expect(row.verification_token).toBeTruthy()
    expect(row.ssl_status).toBe('pending')
  })

  it('normalises scheme + uppercase before insert', async () => {
    const res = await addDomain(db, {
      shopId: 'shop-1',
      rawDomain: '  https://SHOP.Acme.IO/  ',
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.domain).toBe('shop.acme.io')
  })

  it('rejects invalid_domain for malformed input', async () => {
    for (const bad of ['', 'localhost', 'not a domain', '-bad.example.com']) {
      const res = await addDomain(db, { shopId: 'shop-1', rawDomain: bad })
      expect(res.ok).toBe(false)
      if (res.ok) continue
      expect(res.error).toBe('invalid_domain')
    }
  })

  it('rejects gbox.co + subdomains (reserved for platform)', async () => {
    const apex = await addDomain(db, { shopId: 'shop-1', rawDomain: 'gbox.co' })
    expect(apex.ok).toBe(false)
    if (!apex.ok) expect(apex.error).toBe('gbox_subdomain_not_allowed')

    const sub = await addDomain(db, {
      shopId: 'shop-1',
      rawDomain: 'foo.gbox.co',
    })
    expect(sub.ok).toBe(false)
    if (!sub.ok) expect(sub.error).toBe('gbox_subdomain_not_allowed')
  })

  it('rejects already_added when the same shop adds the same domain twice', async () => {
    await addDomain(db, { shopId: 'shop-1', rawDomain: 'shop.acme.io' })
    const dup = await addDomain(db, {
      shopId: 'shop-1',
      rawDomain: 'shop.acme.io',
    })
    expect(dup.ok).toBe(false)
    if (!dup.ok) expect(dup.error).toBe('already_added')
  })

  it('rejects already_claimed_by_other_shop when another shop owns the domain', async () => {
    await addDomain(db, { shopId: 'shop-1', rawDomain: 'shop.acme.io' })
    const other = await addDomain(db, {
      shopId: 'shop-2',
      rawDomain: 'shop.acme.io',
    })
    expect(other.ok).toBe(false)
    if (!other.ok) expect(other.error).toBe('already_claimed_by_other_shop')
  })

  it('reclaim: when shop A deletes, shop B can add the same domain', async () => {
    const a = await addDomain(db, {
      shopId: 'shop-1',
      rawDomain: 'shop.acme.io',
    })
    if (!a.ok) throw new Error('precondition')

    await removeDomain(db, { shopId: 'shop-1', domainId: a.id })

    const b = await addDomain(db, {
      shopId: 'shop-2',
      rawDomain: 'shop.acme.io',
    })
    expect(b.ok).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// verifyViaCloudflare
// ---------------------------------------------------------------------------

describe('verifyViaCloudflare', () => {
  it('returns not_found when the id does not belong to the shop', async () => {
    const db = createFakeDb()
    const a = await addDomain(db, {
      shopId: 'shop-1',
      rawDomain: 'shop.acme.io',
    })
    if (!a.ok) throw new Error('precondition')

    const res = await verifyViaCloudflare(db, {
      shopId: 'shop-2', // wrong shop
      domainId: a.id,
      resolvers: makeBundle({ ns: nsResolverOk(CF_NS) }),
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error).toBe('not_found')
  })

  it('flips verified=true + ssl_status=active when NS is on Cloudflare', async () => {
    const db = createFakeDb()
    const a = await addDomain(db, {
      shopId: 'shop-1',
      rawDomain: 'shop.acme.io',
    })
    if (!a.ok) throw new Error('precondition')

    const res = await verifyViaCloudflare(db, {
      shopId: 'shop-1',
      domainId: a.id,
      resolvers: makeBundle({
        ns: nsResolverOk(CF_NS),
        cname: cnameResolverOk(['shops.gbox.co']),
      }),
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.cloudflareProxied).toBe(true)
    expect(res.dnsTarget).toBe('shops.gbox.co')

    const row = (db.__rows as FakeRow[])[0]!
    expect(row.verified).toBe(true)
    expect(row.cloudflare_proxied).toBe(true)
    expect(row.ssl_status).toBe('active')
    expect(row.nameservers).toContain('cloudflare.com')
  })

  it('returns not_on_cloudflare + persists observed NS when not on CF', async () => {
    const db = createFakeDb()
    const a = await addDomain(db, {
      shopId: 'shop-1',
      rawDomain: 'shop.acme.io',
    })
    if (!a.ok) throw new Error('precondition')

    const res = await verifyViaCloudflare(db, {
      shopId: 'shop-1',
      domainId: a.id,
      resolvers: makeBundle({ ns: nsResolverOk(NON_CF_NS) }),
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error).toBe('not_on_cloudflare')
    expect(res.nameservers).toEqual(expect.arrayContaining(NON_CF_NS))

    const row = (db.__rows as FakeRow[])[0]!
    // Observed NS is persisted even on failure so the UI can render it.
    expect(row.nameservers).toContain('registrar.example')
    // But we don't accidentally mark the row verified.
    expect(row.verified).toBe(false)
    expect(row.cloudflare_proxied).toBe(false)
  })

  it('returns lookup_error when the NS resolver throws (SERVFAIL-ish)', async () => {
    const db = createFakeDb()
    const a = await addDomain(db, {
      shopId: 'shop-1',
      rawDomain: 'shop.acme.io',
    })
    if (!a.ok) throw new Error('precondition')

    const res = await verifyViaCloudflare(db, {
      shopId: 'shop-1',
      domainId: a.id,
      resolvers: makeBundle({ ns: nsResolverThrow('ESERVFAIL') }),
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error).toBe('lookup_error')
    expect(res.lookupErrorMessage).toContain('ESERVFAIL')
  })

  it('leaves verified=true sticky when a previously verified domain flakes', async () => {
    // Guards against "accidentally nuking a live domain because of a
    // flaky DNS probe" — the comment block in the service. If a
    // second verify pass returns not_on_cloudflare we only update
    // observed state, we don't flip verified back to false.
    const db = createFakeDb()
    const a = await addDomain(db, {
      shopId: 'shop-1',
      rawDomain: 'shop.acme.io',
    })
    if (!a.ok) throw new Error('precondition')

    // First pass succeeds → verified=true.
    await verifyViaCloudflare(db, {
      shopId: 'shop-1',
      domainId: a.id,
      resolvers: makeBundle({ ns: nsResolverOk(CF_NS) }),
    })
    expect((db.__rows as FakeRow[])[0]!.verified).toBe(true)

    // Second pass flakes (NS answer no longer CF).
    const res = await verifyViaCloudflare(db, {
      shopId: 'shop-1',
      domainId: a.id,
      resolvers: makeBundle({ ns: nsResolverOk(NON_CF_NS) }),
    })
    expect(res.ok).toBe(false)

    // verified STAYS true. Only cloudflare_proxied + observed state flip.
    const row = (db.__rows as FakeRow[])[0]!
    expect(row.verified).toBe(true)
    expect(row.cloudflare_proxied).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// verifyDomain (unified A-record + Cloudflare path)
// ---------------------------------------------------------------------------

describe('verifyDomain', () => {
  it('returns not_found when id does not belong to shop', async () => {
    const db = createFakeDb()
    const a = await addDomain(db, {
      shopId: 'shop-1',
      rawDomain: 'shop.acme.io',
    })
    if (!a.ok) throw new Error('precondition')

    const res = await verifyDomain(db, {
      shopId: 'shop-2',
      domainId: a.id,
      resolvers: makeBundle({ ns: nsResolverOk([]) }),
      platformIps: ['14.224.236.129'],
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error).toBe('not_found')
  })

  it('A-record match wins: flips to verified + method=a_record + cloudflare_proxied=false', async () => {
    const db = createFakeDb()
    const a = await addDomain(db, {
      shopId: 'shop-1',
      rawDomain: 'shop.acme.io',
    })
    if (!a.ok) throw new Error('precondition')

    const res = await verifyDomain(db, {
      shopId: 'shop-1',
      domainId: a.id,
      resolvers: makeBundle({
        ns: nsResolverOk(CF_NS), // would succeed if we fell through
        a: aResolverOk(['14.224.236.129']),
      }),
      platformIps: ['14.224.236.129'],
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.method).toBe('a_record')
    expect(res.matchedIp).toBe('14.224.236.129')
    expect(res.nameservers).toEqual([])

    const row = (db.__rows as FakeRow[])[0]!
    expect(row.verified).toBe(true)
    expect(row.verification_method).toBe('a_record')
    expect(row.cloudflare_proxied).toBe(false)
    expect(row.ssl_status).toBe('pending') // acme path, not CF
  })

  it('falls through to CF path when no A resolver is supplied', async () => {
    const db = createFakeDb()
    const a = await addDomain(db, {
      shopId: 'shop-1',
      rawDomain: 'shop.acme.io',
    })
    if (!a.ok) throw new Error('precondition')

    const res = await verifyDomain(db, {
      shopId: 'shop-1',
      domainId: a.id,
      resolvers: makeBundle({ ns: nsResolverOk(CF_NS) }),
      platformIps: ['14.224.236.129'],
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.method).toBe('cloudflare')

    const row = (db.__rows as FakeRow[])[0]!
    expect(row.verification_method).toBe('cloudflare')
    expect(row.cloudflare_proxied).toBe(true)
    expect(row.ssl_status).toBe('active')
  })

  it('falls through to CF path when A returns an unmatched IP', async () => {
    const db = createFakeDb()
    const a = await addDomain(db, {
      shopId: 'shop-1',
      rawDomain: 'shop.acme.io',
    })
    if (!a.ok) throw new Error('precondition')

    const res = await verifyDomain(db, {
      shopId: 'shop-1',
      domainId: a.id,
      resolvers: makeBundle({
        ns: nsResolverOk(CF_NS),
        a: aResolverOk(['203.0.113.5']), // unrelated IP, won't match
      }),
      platformIps: ['14.224.236.129'],
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.method).toBe('cloudflare')
  })

  it('not_verified: both A and NS answer, neither matches', async () => {
    const db = createFakeDb()
    const a = await addDomain(db, {
      shopId: 'shop-1',
      rawDomain: 'shop.acme.io',
    })
    if (!a.ok) throw new Error('precondition')

    const res = await verifyDomain(db, {
      shopId: 'shop-1',
      domainId: a.id,
      resolvers: makeBundle({
        ns: nsResolverOk(NON_CF_NS),
        a: aResolverOk(['203.0.113.5']),
      }),
      platformIps: ['14.224.236.129'],
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error).toBe('not_verified')

    // We STILL persist observed state so the UI can say "points to <x>".
    const row = (db.__rows as FakeRow[])[0]!
    expect(row.verified).toBe(false)
    expect(row.dns_target).toBe('203.0.113.5')
  })

  it('lookup_error: both A and NS resolvers throw', async () => {
    const db = createFakeDb()
    const a = await addDomain(db, {
      shopId: 'shop-1',
      rawDomain: 'shop.acme.io',
    })
    if (!a.ok) throw new Error('precondition')

    const res = await verifyDomain(db, {
      shopId: 'shop-1',
      domainId: a.id,
      resolvers: makeBundle({
        ns: nsResolverThrow('ESERVFAIL'),
        a: aResolverThrow('ESERVFAIL'),
      }),
      platformIps: ['14.224.236.129'],
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error).toBe('lookup_error')
  })
})

// ---------------------------------------------------------------------------
// setPrimary
// ---------------------------------------------------------------------------

describe('setPrimary', () => {
  async function seedVerified(
    db: any,
    shopId: string,
    domain: string,
  ): Promise<string> {
    const res = await addDomain(db, { shopId, rawDomain: domain })
    if (!res.ok) throw new Error('seedVerified failed')
    // Flip the in-memory row to verified so setPrimary's guard passes.
    const row = (db.__rows as FakeRow[]).find((r) => r.id === res.id)!
    row.verified = true
    return res.id
  }

  it('rejects not_found for wrong shop', async () => {
    const db = createFakeDb()
    const id = await seedVerified(db, 'shop-1', 'shop.acme.io')

    const res = await setPrimary(db, { shopId: 'shop-2', domainId: id })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error).toBe('not_found')
  })

  it('rejects not_verified on unverified domains', async () => {
    const db = createFakeDb()
    const a = await addDomain(db, {
      shopId: 'shop-1',
      rawDomain: 'shop.acme.io',
    })
    if (!a.ok) throw new Error('precondition')

    const res = await setPrimary(db, { shopId: 'shop-1', domainId: a.id })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error).toBe('not_verified')
  })

  it('promotes target + clears existing primary atomically', async () => {
    const db = createFakeDb()
    const first = await seedVerified(db, 'shop-1', 'first.acme.io')
    const second = await seedVerified(db, 'shop-1', 'second.acme.io')

    // Make first the primary manually.
    const firstRow = (db.__rows as FakeRow[]).find((r) => r.id === first)!
    firstRow.is_primary = true

    const promoted = await setPrimary(db, {
      shopId: 'shop-1',
      domainId: second,
    })
    expect(promoted.ok).toBe(true)

    const rows = db.__rows as FakeRow[]
    const primaries = rows.filter((r) => r.is_primary)
    expect(primaries.length).toBe(1)
    expect(primaries[0]!.id).toBe(second)
  })

  it('clears redirect_to_domain_id on promote (avoids primary-redirecting-itself loop)', async () => {
    const db = createFakeDb()
    const target = await seedVerified(db, 'shop-1', 'primary.acme.io')
    const source = await seedVerified(db, 'shop-1', 'redirector.acme.io')

    // Wire source → target redirect.
    const sourceRow = (db.__rows as FakeRow[]).find((r) => r.id === source)!
    sourceRow.redirect_to_domain_id = target

    // Now promote the source itself to primary.
    const res = await setPrimary(db, { shopId: 'shop-1', domainId: source })
    expect(res.ok).toBe(true)

    const after = (db.__rows as FakeRow[]).find((r) => r.id === source)!
    expect(after.is_primary).toBe(true)
    expect(after.redirect_to_domain_id).toBeNull()
  })

  it('is shop-scoped: promoting in shop-1 does not touch shop-2 primaries', async () => {
    const db = createFakeDb()
    const s1 = await seedVerified(db, 'shop-1', 'one.acme.io')
    const s2 = await seedVerified(db, 'shop-2', 'two.acme.io')

    const s2Row = (db.__rows as FakeRow[]).find((r) => r.id === s2)!
    s2Row.is_primary = true

    await setPrimary(db, { shopId: 'shop-1', domainId: s1 })

    // shop-2's primary unaffected.
    const rows = db.__rows as FakeRow[]
    expect(rows.find((r) => r.id === s2)!.is_primary).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// setRedirect
// ---------------------------------------------------------------------------

describe('setRedirect', () => {
  async function seedPair(db: any, shopId: string) {
    const a = await addDomain(db, { shopId, rawDomain: 'a.acme.io' })
    const b = await addDomain(db, { shopId, rawDomain: 'b.acme.io' })
    if (!a.ok || !b.ok) throw new Error('seedPair failed')
    // Verify `b` (target) by default — `a` stays unverified so we can
    // still test source-side paths. Individual tests override.
    const rowB = (db.__rows as FakeRow[]).find((r) => r.id === b.id)!
    rowB.verified = true
    return { sourceId: a.id, targetId: b.id }
  }

  it('rejects source_not_found for wrong shop', async () => {
    const db = createFakeDb()
    const { sourceId, targetId } = await seedPair(db, 'shop-1')

    const res = await setRedirect(db, {
      shopId: 'shop-2',
      sourceDomainId: sourceId,
      targetDomainId: targetId,
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error).toBe('source_not_found')
  })

  it('rejects primary_cannot_redirect when the source is primary', async () => {
    const db = createFakeDb()
    const { sourceId, targetId } = await seedPair(db, 'shop-1')
    // Mark source as primary.
    const row = (db.__rows as FakeRow[]).find((r) => r.id === sourceId)!
    row.is_primary = true

    const res = await setRedirect(db, {
      shopId: 'shop-1',
      sourceDomainId: sourceId,
      targetDomainId: targetId,
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error).toBe('primary_cannot_redirect')
  })

  it('allows clearing a redirect even on a primary domain (null target)', async () => {
    const db = createFakeDb()
    const { sourceId } = await seedPair(db, 'shop-1')
    const row = (db.__rows as FakeRow[]).find((r) => r.id === sourceId)!
    row.is_primary = true
    row.redirect_to_domain_id = 'stale-pointer'

    const res = await setRedirect(db, {
      shopId: 'shop-1',
      sourceDomainId: sourceId,
      targetDomainId: null,
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.targetId).toBeNull()

    expect((db.__rows as FakeRow[]).find((r) => r.id === sourceId)!.redirect_to_domain_id).toBeNull()
  })

  it('rejects self_redirect_not_allowed', async () => {
    const db = createFakeDb()
    const { sourceId } = await seedPair(db, 'shop-1')

    const res = await setRedirect(db, {
      shopId: 'shop-1',
      sourceDomainId: sourceId,
      targetDomainId: sourceId,
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error).toBe('self_redirect_not_allowed')
  })

  it('rejects target_not_found for wrong shop target', async () => {
    const db = createFakeDb()
    const { sourceId } = await seedPair(db, 'shop-1')
    // Target in a different shop.
    const other = await addDomain(db, {
      shopId: 'shop-2',
      rawDomain: 'other.acme.io',
    })
    if (!other.ok) throw new Error('precondition')
    const otherRow = (db.__rows as FakeRow[]).find((r) => r.id === other.id)!
    otherRow.verified = true

    const res = await setRedirect(db, {
      shopId: 'shop-1',
      sourceDomainId: sourceId,
      targetDomainId: other.id,
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error).toBe('target_not_found')
  })

  it('rejects target_not_verified when the target has verified=false', async () => {
    const db = createFakeDb()
    const { sourceId, targetId } = await seedPair(db, 'shop-1')
    // Flip target back to unverified.
    const row = (db.__rows as FakeRow[]).find((r) => r.id === targetId)!
    row.verified = false

    const res = await setRedirect(db, {
      shopId: 'shop-1',
      sourceDomainId: sourceId,
      targetDomainId: targetId,
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error).toBe('target_not_verified')
  })

  it('happy path: sets redirect_to_domain_id on source', async () => {
    const db = createFakeDb()
    const { sourceId, targetId } = await seedPair(db, 'shop-1')

    const res = await setRedirect(db, {
      shopId: 'shop-1',
      sourceDomainId: sourceId,
      targetDomainId: targetId,
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.sourceId).toBe(sourceId)
    expect(res.targetId).toBe(targetId)

    const row = (db.__rows as FakeRow[]).find((r) => r.id === sourceId)!
    expect(row.redirect_to_domain_id).toBe(targetId)
  })
})

// ---------------------------------------------------------------------------
// removeDomain
// ---------------------------------------------------------------------------

describe('removeDomain', () => {
  it('returns not_found for wrong shop (no cross-shop delete)', async () => {
    const db = createFakeDb()
    const a = await addDomain(db, {
      shopId: 'shop-1',
      rawDomain: 'shop.acme.io',
    })
    if (!a.ok) throw new Error('precondition')

    const res = await removeDomain(db, {
      shopId: 'shop-2',
      domainId: a.id,
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error).toBe('not_found')

    // Row still there.
    expect((db.__rows as FakeRow[]).length).toBe(1)
  })

  it('deletes the row and returns the domain string', async () => {
    const db = createFakeDb()
    const a = await addDomain(db, {
      shopId: 'shop-1',
      rawDomain: 'shop.acme.io',
    })
    if (!a.ok) throw new Error('precondition')

    const res = await removeDomain(db, {
      shopId: 'shop-1',
      domainId: a.id,
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.domain).toBe('shop.acme.io')
    expect((db.__rows as FakeRow[]).length).toBe(0)
  })

  it('clears redirect_to_domain_id on other rows that pointed at the removed one (ON DELETE SET NULL)', async () => {
    const db = createFakeDb()
    const source = await addDomain(db, {
      shopId: 'shop-1',
      rawDomain: 'source.acme.io',
    })
    const target = await addDomain(db, {
      shopId: 'shop-1',
      rawDomain: 'target.acme.io',
    })
    if (!source.ok || !target.ok) throw new Error('precondition')

    // Wire source → target redirect (bypass setRedirect's verify gate).
    const sourceRow = (db.__rows as FakeRow[]).find((r) => r.id === source.id)!
    sourceRow.redirect_to_domain_id = target.id

    // Delete the target.
    await removeDomain(db, { shopId: 'shop-1', domainId: target.id })

    // Source's pointer auto-cleared.
    const after = (db.__rows as FakeRow[]).find((r) => r.id === source.id)!
    expect(after.redirect_to_domain_id).toBeNull()
  })
})
