/**
 * Gbox Platform — SSL Orchestrator tests
 * (Landing Page System Phase 1D)
 *
 * The orchestrator glues three sub-modules together (acme-client,
 * nginx-writer, nginx-reloader) plus the shop_domains DB rows. Each
 * sub-module already has its own unit tests covering its internals,
 * so this file focuses on the orchestration logic:
 *
 *   - isInCooldown — pure, 4 branches
 *   - requestSsl happy path + every error branch
 *   - removeDomainAndSsl teardown flow
 *   - syncPendingSslBatch aggregation into summary
 *
 * How we isolate the orchestrator:
 *
 *   - DB: in-memory Kysely facade (same shape as service.test.ts but
 *     with Phase 1D columns).
 *   - acme-client: injected `spawnImpl` + `readFileImpl` on
 *     `AcmeClientConfig` so `issueCertificate` runs without lego.
 *   - nginx-writer: injected `writeFileImpl` / `renameImpl` /
 *     `mkdirImpl` that record calls into an in-memory map. No real
 *     disk touched. We skip the orchestrator's `fs.stat` "replaced"
 *     probe by letting it throw ENOENT — that path already works.
 *   - nginx-reloader: injected `spawnImpl` that returns exit code 0.
 *
 * Clocks are frozen with `nowImpl` so cooldown arithmetic is exact.
 */

import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  isInCooldown,
  requestSsl,
  removeDomainAndSsl,
  syncPendingSslBatch,
  resolveShopByHostname,
  type SslOrchestratorConfig,
} from './ssl-orchestrator.js'
import type { DomainRecord } from './service.js'

// ---------------------------------------------------------------------------
// In-memory shop_domains table (superset of service.test.ts with Phase 1D cols)
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
  // Phase 1D columns
  cert_path: string | null
  cert_key_path: string | null
  cert_chain_path: string | null
  acme_challenge_token: string | null
  ssl_last_attempt_at: Date | null
  renewal_failures: number
  ssl_staging: boolean
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

function createFakeDb(initialRows: FakeRow[] = []) {
  const rows: FakeRow[] = [...initialRows]

  const makeSelectChain = () => {
    const predicates: Predicate[] = []
    let limitN: number | null = null
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
      if (limitN != null) out = out.slice(0, limitN)
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
      limit: (n: number) => {
        limitN = n
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

  const makeDeleteChain = () => {
    const predicates: Predicate[] = []
    const chain: any = {
      where: (col: keyof FakeRow, op: Predicate['op'], val: unknown) => {
        predicates.push({ col, op, val })
        return chain
      },
      execute: async () => {
        for (let i = rows.length - 1; i >= 0; i--) {
          if (predicates.every((p) => matchPredicate(rows[i]!, p))) {
            rows.splice(i, 1)
          }
        }
      },
    }
    return chain
  }

  const client: any = {
    selectFrom: () => makeSelectChain(),
    updateTable: () => makeUpdateChain(),
    deleteFrom: () => makeDeleteChain(),
    transaction: () => ({
      execute: async (cb: (trx: any) => Promise<unknown>) => cb(client),
    }),
    __rows: rows,
  }
  return client
}

// Minimal row factory — every Phase 1D column defaults to the
// "brand new row, just verified, no cert yet" state.
function makeRow(overrides: Partial<FakeRow>): FakeRow {
  const now = new Date('2026-04-11T00:00:00Z')
  return {
    id: overrides.id ?? 'dom-1',
    shop_id: overrides.shop_id ?? 'shop-1',
    domain: overrides.domain ?? 'thaibeotit.com',
    is_primary: overrides.is_primary ?? true,
    ssl_status: overrides.ssl_status ?? null,
    verified: overrides.verified ?? true,
    created_at: overrides.created_at ?? now,
    verification_token: overrides.verification_token ?? 'tok-1234',
    verification_method: overrides.verification_method ?? 'txt',
    verified_at: overrides.verified_at ?? now,
    ssl_provider: overrides.ssl_provider ?? null,
    ssl_issued_at: overrides.ssl_issued_at ?? null,
    ssl_expires_at: overrides.ssl_expires_at ?? null,
    ssl_last_error: overrides.ssl_last_error ?? null,
    cert_path: overrides.cert_path ?? null,
    cert_key_path: overrides.cert_key_path ?? null,
    cert_chain_path: overrides.cert_chain_path ?? null,
    acme_challenge_token: overrides.acme_challenge_token ?? null,
    ssl_last_attempt_at: overrides.ssl_last_attempt_at ?? null,
    renewal_failures: overrides.renewal_failures ?? 0,
    ssl_staging: overrides.ssl_staging ?? false,
  }
}

// ---------------------------------------------------------------------------
// Fake child_process.spawn — copied from acme-client.test.ts
// ---------------------------------------------------------------------------

interface FakeSpawnOutcome {
  exitCode: number | null
  stdout?: string
  stderr?: string
  hang?: boolean
}

/**
 * Build a fake spawn that responds with a configurable outcome on
 * each call. The first call gets `outcomes[0]`, second gets
 * `outcomes[1]`, etc. Out-of-range calls repeat the last outcome —
 * useful for nginx-reloader which invokes `nginx -t` then
 * `systemctl reload`, and we want both to succeed with the same
 * shape.
 */
function makeFakeSpawn(outcomes: FakeSpawnOutcome[]): {
  spawn: any
  calls: Array<{ binary: string; args: string[] }>
} {
  const calls: Array<{ binary: string; args: string[] }> = []
  let i = 0
  const spawn: any = (binary: string, args: string[]) => {
    calls.push({ binary, args })
    const outcome = outcomes[i] ?? outcomes[outcomes.length - 1]!
    i++

    const child = new EventEmitter() as any
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = () => child.emit('close', null)

    queueMicrotask(() => {
      if (outcome.stdout) child.stdout.emit('data', Buffer.from(outcome.stdout))
      if (outcome.stderr) child.stderr.emit('data', Buffer.from(outcome.stderr))
      if (!outcome.hang) child.emit('close', outcome.exitCode)
    })
    return child
  }
  return { spawn, calls }
}

// ---------------------------------------------------------------------------
// Fake fs for nginx-writer — no real disk
// ---------------------------------------------------------------------------

interface FakeFs {
  writes: Map<string, string> // final path → contents
  renames: Array<{ from: string; to: string }>
  unlinked: string[]
  writeFileImpl: any
  renameImpl: any
  mkdirImpl: any
  unlinkImpl: any
}

function makeFakeFs(): FakeFs {
  const writes = new Map<string, string>()
  const renames: Array<{ from: string; to: string }> = []
  const unlinked: string[] = []

  // The writer writes to `<final>.tmp` then renames to `<final>`.
  const writeFileImpl: any = async (p: string, contents: any) => {
    writes.set(String(p), String(contents))
  }
  const renameImpl: any = async (from: string, to: string) => {
    renames.push({ from: String(from), to: String(to) })
    const body = writes.get(String(from))
    if (body !== undefined) {
      writes.delete(String(from))
      writes.set(String(to), body)
    }
  }
  const mkdirImpl: any = async () => undefined
  const unlinkImpl: any = async (p: string) => {
    const key = String(p)
    if (writes.has(key)) {
      writes.delete(key)
      unlinked.push(key)
      return
    }
    const err: any = new Error('ENOENT')
    err.code = 'ENOENT'
    throw err
  }

  return {
    writes,
    renames,
    unlinked,
    writeFileImpl,
    renameImpl,
    mkdirImpl,
    unlinkImpl,
  }
}

// ---------------------------------------------------------------------------
// Orchestrator config factory
// ---------------------------------------------------------------------------

interface BuildConfigOpts {
  acmeOutcome?: FakeSpawnOutcome
  nginxOutcomes?: FakeSpawnOutcome[]
  /** If set, replaces the default success metadata. */
  certMeta?: { notBefore: string; notAfter: string }
  /** Clock for cooldown / attempt-at bookkeeping. */
  now?: Date
}

function buildConfig(opts: BuildConfigOpts = {}) {
  const nginxFs = makeFakeFs()
  const { spawn: acmeSpawn, calls: acmeCalls } = makeFakeSpawn([
    opts.acmeOutcome ?? { exitCode: 0, stdout: 'lego: ok\n' },
  ])
  const { spawn: nginxSpawn, calls: nginxCalls } = makeFakeSpawn(
    opts.nginxOutcomes ?? [
      { exitCode: 0, stdout: 'nginx: syntax ok\n' },
      { exitCode: 0, stdout: 'reloaded\n' },
    ],
  )

  const meta =
    opts.certMeta ?? {
      notBefore: '2026-04-11T00:00:00Z',
      notAfter: '2026-07-10T00:00:00Z',
    }
  const readFileImpl = (async () =>
    JSON.stringify({
      domain: 'thaibeotit.com',
      notBefore: meta.notBefore,
      notAfter: meta.notAfter,
    })) as any

  const config: SslOrchestratorConfig = {
    acme: {
      accountEmail: 'ops@gbox.co',
      legoPath: '/etc/gbox/lego',
      webrootPath: '/var/www/acme-webroot',
      spawnImpl: acmeSpawn,
      readFileImpl,
      timeoutSeconds: 2,
    },
    nginxWriter: {
      domainsDir: '/etc/nginx/gbox-domains',
      storefrontUpstream: 'http://127.0.0.1:4321',
      writeFileImpl: nginxFs.writeFileImpl,
      renameImpl: nginxFs.renameImpl,
      mkdirImpl: nginxFs.mkdirImpl,
      unlinkImpl: nginxFs.unlinkImpl,
    },
    nginxReloader: {
      spawnImpl: nginxSpawn,
      noSudo: true,
      timeoutSeconds: 2,
    },
    nowImpl: () => opts.now ?? new Date('2026-04-11T12:00:00Z'),
  }

  return { config, nginxFs, acmeCalls, nginxCalls }
}

// ---------------------------------------------------------------------------
// isInCooldown
// ---------------------------------------------------------------------------

describe('isInCooldown', () => {
  const base: DomainRecord = {
    id: 'd',
    shopId: 's',
    domain: 'thaibeotit.com',
    isPrimary: true,
    verified: true,
    verificationToken: 't',
    verificationMethod: 'txt',
    verifiedAt: new Date(0),
    sslProvider: null,
    sslStatus: null,
    sslIssuedAt: null,
    sslExpiresAt: null,
    sslLastError: null,
    createdAt: new Date(0),
    verificationStatus: 'verified',
    instructions: { recordHost: '', recordValue: '', recordType: 'TXT' } as any,
    certPath: null,
    certKeyPath: null,
    certChainPath: null,
    acmeChallengeToken: null,
    sslLastAttemptAt: null,
    renewalFailures: 0,
    sslStaging: false,
  }

  it('returns cooling=false when there is no last error', () => {
    const res = isInCooldown(base, 60_000, new Date())
    expect(res.cooling).toBe(false)
    expect(res.retryAt).toBeNull()
  })

  it('returns cooling=false when there is no last attempt timestamp', () => {
    const res = isInCooldown(
      { ...base, sslLastError: 'nope' },
      60_000,
      new Date(),
    )
    expect(res.cooling).toBe(false)
  })

  it('returns cooling=true when elapsed < cooldown', () => {
    const last = new Date('2026-04-11T12:00:00Z')
    const now = new Date('2026-04-11T12:30:00Z')
    const res = isInCooldown(
      { ...base, sslLastError: 'nope', sslLastAttemptAt: last },
      60 * 60 * 1000,
      now,
    )
    expect(res.cooling).toBe(true)
    expect(res.retryAt?.toISOString()).toBe('2026-04-11T13:00:00.000Z')
  })

  it('returns cooling=false when elapsed >= cooldown', () => {
    const last = new Date('2026-04-11T12:00:00Z')
    const now = new Date('2026-04-11T13:30:00Z')
    const res = isInCooldown(
      { ...base, sslLastError: 'nope', sslLastAttemptAt: last },
      60 * 60 * 1000,
      now,
    )
    expect(res.cooling).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// requestSsl
// ---------------------------------------------------------------------------

describe('requestSsl', () => {
  let db: any
  beforeEach(() => {
    db = createFakeDb()
  })

  it('happy path — issues cert, writes nginx block, reloads, marks active', async () => {
    db.__rows.push(makeRow({ id: 'dom-1', shop_id: 'shop-1' }))

    const { config, nginxFs, acmeCalls, nginxCalls } = buildConfig()

    const res = await requestSsl(
      db,
      { shopId: 'shop-1', domainId: 'dom-1' },
      config,
    )

    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.record.sslProvider).toBe('letsencrypt')
    expect(res.record.sslIssuedAt).not.toBeNull()
    expect(res.record.certPath).toContain('thaibeotit.com.crt')
    expect(res.record.renewalFailures).toBe(0)

    // lego called exactly once with the primary domain in argv.
    expect(acmeCalls.length).toBe(1)
    expect(acmeCalls[0]!.args).toContain('thaibeotit.com')
    // www.thaibeotit.com auto-added as SAN (bare 2-label domain).
    expect(acmeCalls[0]!.args).toContain('www.thaibeotit.com')

    // nginx config file written.
    const nginxFile = [...nginxFs.writes.keys()].find((p) =>
      p.endsWith('thaibeotit.com.conf'),
    )
    expect(nginxFile).toBeDefined()
    const body = nginxFs.writes.get(nginxFile!)!
    expect(body).toContain('server_name thaibeotit.com')
    expect(body).toContain('ssl_certificate ')

    // nginx -t + reload called (2 spawn calls total).
    expect(nginxCalls.length).toBe(2)
  })

  it('does NOT add www SAN when the domain already starts with www.', async () => {
    db.__rows.push(
      makeRow({ id: 'dom-1', shop_id: 'shop-1', domain: 'www.example.io' }),
    )
    const { config, acmeCalls } = buildConfig()
    const res = await requestSsl(
      db,
      { shopId: 'shop-1', domainId: 'dom-1' },
      config,
    )
    expect(res.ok).toBe(true)
    // Only the primary domain should appear, no www.www.
    const domainArgs = acmeCalls[0]!.args
      .map((a, i) => (a === '--domains' ? acmeCalls[0]!.args[i + 1] : null))
      .filter(Boolean)
    expect(domainArgs).toEqual(['www.example.io'])
  })

  it('does NOT add www SAN when the domain is a 3+ label subdomain', async () => {
    db.__rows.push(
      makeRow({ id: 'dom-1', shop_id: 'shop-1', domain: 'shop.acme.com' }),
    )
    const { config, acmeCalls } = buildConfig()
    const res = await requestSsl(
      db,
      { shopId: 'shop-1', domainId: 'dom-1' },
      config,
    )
    expect(res.ok).toBe(true)
    const domainArgs = acmeCalls[0]!.args
      .map((a, i) => (a === '--domains' ? acmeCalls[0]!.args[i + 1] : null))
      .filter(Boolean)
    expect(domainArgs).toEqual(['shop.acme.com'])
  })

  it('returns not_found when the domain id does not belong to shop', async () => {
    db.__rows.push(makeRow({ id: 'dom-1', shop_id: 'shop-1' }))
    const { config } = buildConfig()
    const res = await requestSsl(
      db,
      { shopId: 'shop-2', domainId: 'dom-1' },
      config,
    )
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.code).toBe('not_found')
  })

  it('returns not_verified when the domain has not passed DNS check', async () => {
    db.__rows.push(makeRow({ id: 'dom-1', shop_id: 'shop-1', verified: false }))
    const { config } = buildConfig()
    const res = await requestSsl(
      db,
      { shopId: 'shop-1', domainId: 'dom-1' },
      config,
    )
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.code).toBe('not_verified')
  })

  it('returns cooldown when last attempt is within the window', async () => {
    const now = new Date('2026-04-11T12:00:00Z')
    const lastAttempt = new Date('2026-04-11T11:30:00Z') // 30 min ago
    db.__rows.push(
      makeRow({
        id: 'dom-1',
        shop_id: 'shop-1',
        ssl_last_error: 'ACME failed last time',
        ssl_last_attempt_at: lastAttempt,
      }),
    )
    const { config } = buildConfig({ now })
    const res = await requestSsl(
      db,
      { shopId: 'shop-1', domainId: 'dom-1' },
      config,
    )
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.code).toBe('cooldown')
    if (res.code !== 'cooldown') return
    // Default cooldown is 1 hour, last attempt 30 min ago → retry in 30 min.
    expect(res.retryAt.toISOString()).toBe('2026-04-11T12:30:00.000Z')
  })

  it('translates ACME rate-limited error into extended cooldown', async () => {
    const now = new Date('2026-04-11T12:00:00Z')
    db.__rows.push(makeRow({ id: 'dom-1', shop_id: 'shop-1' }))

    const { config } = buildConfig({
      now,
      acmeOutcome: {
        exitCode: 1,
        stderr: 'acme: error: 429 :: too many certificates already issued',
      },
    })
    const res = await requestSsl(
      db,
      { shopId: 'shop-1', domainId: 'dom-1' },
      config,
    )
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.code).toBe('acme_error')
    if (res.code !== 'acme_error') return
    expect(res.kind).toBe('rate_limited')

    // The row's ssl_last_attempt_at should have been back-dated by
    // (24h - 1h) = 23h to enforce a 24-hour cooldown on the next tick.
    const row = db.__rows[0]
    expect(row.ssl_last_attempt_at).toBeInstanceOf(Date)
    const diffMs = row.ssl_last_attempt_at.getTime() - now.getTime()
    expect(diffMs).toBe(23 * 60 * 60 * 1000)
    expect(row.ssl_last_error).toContain('rate_limited')
  })

  it('bubbles up a generic ACME error into code=acme_error', async () => {
    db.__rows.push(makeRow({ id: 'dom-1', shop_id: 'shop-1' }))
    const { config } = buildConfig({
      acmeOutcome: {
        exitCode: 1,
        stderr: 'acme: error: unauthorized',
      },
    })
    const res = await requestSsl(
      db,
      { shopId: 'shop-1', domainId: 'dom-1' },
      config,
    )
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.code).toBe('acme_error')
    if (res.code !== 'acme_error') return
    expect(res.kind).toBe('unauthorized')
    const row = db.__rows[0]
    expect(row.ssl_last_error).toContain('unauthorized')
  })

  it('persists cert_path BEFORE reload so a reload failure keeps metadata', async () => {
    db.__rows.push(makeRow({ id: 'dom-1', shop_id: 'shop-1' }))
    const { config } = buildConfig({
      nginxOutcomes: [
        { exitCode: 0, stdout: 'nginx: syntax ok\n' },
        { exitCode: 1, stderr: 'reload failed' },
      ],
    })
    const res = await requestSsl(
      db,
      { shopId: 'shop-1', domainId: 'dom-1' },
      config,
    )
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.code).toBe('nginx_error')

    // DB row has cert_path written even though reload failed.
    const row = db.__rows[0]
    expect(row.cert_path).toContain('thaibeotit.com.crt')
    expect(row.ssl_last_error).toContain('reload')
  })

  it('returns nginx_error when nginx -t fails (config_test_failed)', async () => {
    db.__rows.push(makeRow({ id: 'dom-1', shop_id: 'shop-1' }))
    const { config } = buildConfig({
      nginxOutcomes: [
        { exitCode: 1, stderr: 'invalid directive in line 42' },
      ],
    })
    const res = await requestSsl(
      db,
      { shopId: 'shop-1', domainId: 'dom-1' },
      config,
    )
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.code).toBe('nginx_error')
    if (res.code !== 'nginx_error') return
    expect(res.nginxReload.ok).toBe(false)
  })

  it('clears renewal_failures on a successful issue', async () => {
    db.__rows.push(
      makeRow({ id: 'dom-1', shop_id: 'shop-1', renewal_failures: 5 }),
    )
    const { config } = buildConfig()
    const res = await requestSsl(
      db,
      { shopId: 'shop-1', domainId: 'dom-1' },
      config,
    )
    expect(res.ok).toBe(true)
    const row = db.__rows[0]
    expect(row.renewal_failures).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// removeDomainAndSsl
// ---------------------------------------------------------------------------

describe('removeDomainAndSsl', () => {
  it('removes the nginx block, deletes the row, reloads nginx', async () => {
    const db = createFakeDb()
    db.__rows.push(makeRow({ id: 'dom-1', shop_id: 'shop-1' }))

    // Pre-populate the fake fs with an existing config file for the
    // domain so the unlink path has something to remove.
    const { config, nginxFs, nginxCalls } = buildConfig()
    nginxFs.writes.set(
      '/etc/nginx/gbox-domains/thaibeotit.com.conf',
      '# stale block',
    )

    const res = await removeDomainAndSsl(db, 'shop-1', 'dom-1', config)
    expect(res.ok).toBe(true)

    // Row gone from DB.
    expect(db.__rows.length).toBe(0)
    // Config file gone from fake fs.
    expect(nginxFs.writes.has('/etc/nginx/gbox-domains/thaibeotit.com.conf')).toBe(
      false,
    )
    // nginx -t + reload both attempted.
    expect(nginxCalls.length).toBe(2)
  })

  it('returns ok=false with message when the domain id is unknown', async () => {
    const db = createFakeDb()
    const { config } = buildConfig()
    const res = await removeDomainAndSsl(db, 'shop-1', 'ghost', config)
    expect(res.ok).toBe(false)
    expect(res.message).toContain('not found')
  })

  it('still reports ok=true when nginx reload fails (best-effort teardown)', async () => {
    const db = createFakeDb()
    db.__rows.push(makeRow({ id: 'dom-1', shop_id: 'shop-1' }))
    const { config, nginxFs } = buildConfig({
      nginxOutcomes: [
        { exitCode: 0, stdout: 'ok' },
        { exitCode: 1, stderr: 'reload failed' },
      ],
    })
    nginxFs.writes.set(
      '/etc/nginx/gbox-domains/thaibeotit.com.conf',
      '# block',
    )
    const res = await removeDomainAndSsl(db, 'shop-1', 'dom-1', config)
    // Row + file are gone, reload failed but teardown is still "ok".
    expect(res.ok).toBe(true)
    expect(res.message).toMatch(/nginx reload failed/i)
    expect(db.__rows.length).toBe(0)
  })

  it('tolerates missing nginx config file (ENOENT on unlink)', async () => {
    const db = createFakeDb()
    db.__rows.push(makeRow({ id: 'dom-1', shop_id: 'shop-1' }))
    const { config } = buildConfig()
    // Note: no file pre-populated — unlink will ENOENT.
    const res = await removeDomainAndSsl(db, 'shop-1', 'dom-1', config)
    expect(res.ok).toBe(true)
    expect(db.__rows.length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// syncPendingSslBatch
// ---------------------------------------------------------------------------

describe('syncPendingSslBatch', () => {
  it('aggregates a mix of outcomes into a summary', async () => {
    const db = createFakeDb()
    // Row A: happy path — will succeed.
    db.__rows.push(
      makeRow({ id: 'a', shop_id: 'shop-1', domain: 'thaibeotit.com' }),
    )
    // Row B: already in cooldown — should be skipped as cooldown.
    db.__rows.push(
      makeRow({
        id: 'b',
        shop_id: 'shop-1',
        domain: 'cool.example.io',
        ssl_last_error: 'prev fail',
        ssl_last_attempt_at: new Date('2026-04-11T11:30:00Z'),
      }),
    )

    const now = new Date('2026-04-11T12:00:00Z')
    const { config } = buildConfig({ now })

    const summary = await syncPendingSslBatch(db, { config, batchSize: 10 })
    // listPendingSsl filters on (verified=true AND ssl_issued_at IS null),
    // both rows qualify. A issues, B cooldowns.
    expect(summary.total).toBeGreaterThanOrEqual(2)
    expect(summary.issued).toBe(1)
    expect(summary.cooldowns).toBe(1)
    expect(summary.acmeErrors).toBe(0)
    expect(summary.nginxErrors).toBe(0)
  })

  it('returns zeros when there are no pending rows', async () => {
    const db = createFakeDb()
    const { config } = buildConfig()
    const summary = await syncPendingSslBatch(db, { config })
    expect(summary.total).toBe(0)
    expect(summary.issued).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// resolveShopByHostname
// ---------------------------------------------------------------------------

describe('resolveShopByHostname', () => {
  it('returns the matching row for a registered hostname', async () => {
    const db = createFakeDb()
    db.__rows.push(
      makeRow({ id: 'a', shop_id: 'shop-1', domain: 'thaibeotit.com' }),
    )
    const rec = await resolveShopByHostname(db, 'thaibeotit.com')
    expect(rec?.shopId).toBe('shop-1')
  })

  it('normalizes the query host (trailing dot, upper case)', async () => {
    const db = createFakeDb()
    db.__rows.push(makeRow({ id: 'a', shop_id: 'shop-1', domain: 'acme.io' }))
    const rec = await resolveShopByHostname(db, 'Acme.IO.')
    expect(rec?.domain).toBe('acme.io')
  })

  it('returns null for an unknown hostname', async () => {
    const db = createFakeDb()
    expect(await resolveShopByHostname(db, 'nope.example.io')).toBeNull()
  })
})
