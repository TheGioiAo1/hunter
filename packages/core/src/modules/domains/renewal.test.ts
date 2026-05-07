/**
 * Gbox Platform — Certificate Renewal Loop tests
 * (Landing Page System Phase 1D)
 *
 * Drives `runRenewalBatch` through every interesting branch:
 *
 *   - empty candidate list → info("renewal.tick.empty") and zero summary
 *   - candidate inside window → lego renew → nginx block rewritten →
 *     single reload at the end → ssl_expires_at advances, failures cleared
 *   - candidate < hardAlertDays from expiry → logger.error fires
 *     ("renewal.hard_alert") even when renewal succeeds afterwards
 *   - lego returns noop (cert still fresh) → summary.alreadyFresh++ and
 *     NO nginx rewrite, NO reload
 *   - lego renew error → renewal_failures++, ssl_last_error written,
 *     warn log becomes error log after 3 consecutive failures
 *   - nginx-writer throws AFTER a successful renew → counted as failed
 *     with a distinct ssl_last_error
 *   - nginx reload returns non-zero → summary.nginxReloaded=false,
 *     logger.error fires
 *
 * Same isolation strategy as ssl-orchestrator.test.ts: in-memory DB,
 * injected spawn for lego + nginx, injected fs for the writer.
 */

import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  listRenewalCandidates,
  runRenewalBatch,
  type RenewalConfig,
  type RenewalLogger,
} from './renewal.js'

// ---------------------------------------------------------------------------
// Fake DB — same subset of Kysely as ssl-orchestrator.test.ts
// ---------------------------------------------------------------------------

interface FakeRow {
  id: string
  shop_id: string
  domain: string
  is_primary: boolean
  verified: boolean
  ssl_status: string | null
  ssl_provider: string | null
  ssl_issued_at: Date | null
  ssl_expires_at: Date | null
  ssl_last_error: string | null
  ssl_last_attempt_at: Date | null
  cert_path: string | null
  cert_key_path: string | null
  cert_chain_path: string | null
  renewal_failures: number
  ssl_staging: boolean
  verification_token: string | null
  verification_method: string
  verified_at: Date | null
  acme_challenge_token: string | null
  created_at: Date
}

interface Predicate {
  col: keyof FakeRow
  op: '=' | '!=' | 'is' | 'is not' | '<=' | '>='
  val: unknown
}

function matchPredicate(row: FakeRow, p: Predicate): boolean {
  const value: any = row[p.col]
  switch (p.op) {
    case '=':
      return value === p.val
    case '!=':
      return value !== p.val
    case 'is':
      return value === p.val
    case 'is not':
      return value !== p.val
    case '<=': {
      if (value == null) return false
      const lv = value instanceof Date ? value.getTime() : (value as any)
      const rv =
        p.val instanceof Date
          ? p.val.getTime()
          : typeof p.val === 'string'
            ? new Date(p.val).getTime()
            : (p.val as any)
      return lv <= rv
    }
    case '>=': {
      if (value == null) return false
      const lv = value instanceof Date ? value.getTime() : (value as any)
      const rv =
        p.val instanceof Date
          ? p.val.getTime()
          : typeof p.val === 'string'
            ? new Date(p.val).getTime()
            : (p.val as any)
      return lv >= rv
    }
  }
}

function createFakeDb(initial: FakeRow[] = []) {
  const rows: FakeRow[] = [...initial]

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

  const client: any = {
    selectFrom: () => makeSelectChain(),
    updateTable: () => makeUpdateChain(),
    __rows: rows,
  }
  return client
}

// ---------------------------------------------------------------------------
// Row factory — defaults to a row that's eligible for renewal
// ---------------------------------------------------------------------------

function makeRenewableRow(overrides: Partial<FakeRow> = {}): FakeRow {
  const base: FakeRow = {
    id: 'dom-1',
    shop_id: 'shop-1',
    domain: 'thaibeotit.com',
    is_primary: true,
    verified: true,
    ssl_status: 'active',
    ssl_provider: 'letsencrypt',
    ssl_issued_at: new Date('2026-02-01T00:00:00Z'),
    ssl_expires_at: new Date('2026-05-01T00:00:00Z'), // 20 days from now
    ssl_last_error: null,
    ssl_last_attempt_at: null,
    cert_path: '/etc/gbox/lego/certificates/thaibeotit.com.crt',
    cert_key_path: '/etc/gbox/lego/certificates/thaibeotit.com.key',
    cert_chain_path: '/etc/gbox/lego/certificates/thaibeotit.com.issuer.crt',
    renewal_failures: 0,
    ssl_staging: false,
    verification_token: 'tok',
    verification_method: 'txt',
    verified_at: new Date('2026-01-01T00:00:00Z'),
    acme_challenge_token: null,
    created_at: new Date('2026-01-01T00:00:00Z'),
  }
  return { ...base, ...overrides }
}

// ---------------------------------------------------------------------------
// Fake spawn + fake fs (same shape as ssl-orchestrator.test.ts)
// ---------------------------------------------------------------------------

interface FakeSpawnOutcome {
  exitCode: number | null
  stdout?: string
  stderr?: string
  hang?: boolean
}

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

interface FakeFs {
  writes: Map<string, string>
  renames: Array<{ from: string; to: string }>
  writeFileImpl: any
  renameImpl: any
  mkdirImpl: any
  /** If set, writeFileImpl throws this error on the next call. */
  throwOnNextWrite?: Error
}

function makeFakeFs(): FakeFs {
  const fs: FakeFs = {
    writes: new Map(),
    renames: [],
    writeFileImpl: null,
    renameImpl: null,
    mkdirImpl: null,
  }
  fs.writeFileImpl = async (p: string, contents: any) => {
    if (fs.throwOnNextWrite) {
      const err = fs.throwOnNextWrite
      fs.throwOnNextWrite = undefined
      throw err
    }
    fs.writes.set(String(p), String(contents))
  }
  fs.renameImpl = async (from: string, to: string) => {
    fs.renames.push({ from: String(from), to: String(to) })
    const body = fs.writes.get(String(from))
    if (body !== undefined) {
      fs.writes.delete(String(from))
      fs.writes.set(String(to), body)
    }
  }
  fs.mkdirImpl = async () => undefined
  return fs
}

// ---------------------------------------------------------------------------
// Config factory
// ---------------------------------------------------------------------------

interface BuildCfgOpts {
  acmeOutcomes?: FakeSpawnOutcome[]
  nginxOutcomes?: FakeSpawnOutcome[]
  now?: Date
  newNotAfter?: string
  newNotBefore?: string
  fs?: FakeFs
}

function buildConfig(opts: BuildCfgOpts = {}): {
  config: RenewalConfig
  acmeCalls: Array<{ binary: string; args: string[] }>
  nginxCalls: Array<{ binary: string; args: string[] }>
  fs: FakeFs
} {
  const fs = opts.fs ?? makeFakeFs()
  const { spawn: acmeSpawn, calls: acmeCalls } = makeFakeSpawn(
    opts.acmeOutcomes ?? [{ exitCode: 0, stdout: 'lego: ok\n' }],
  )
  const { spawn: nginxSpawn, calls: nginxCalls } = makeFakeSpawn(
    opts.nginxOutcomes ?? [
      { exitCode: 0, stdout: 'nginx: ok\n' },
      { exitCode: 0, stdout: 'reloaded\n' },
    ],
  )

  const meta = {
    domain: 'thaibeotit.com',
    notBefore: opts.newNotBefore ?? '2026-04-11T00:00:00Z',
    notAfter: opts.newNotAfter ?? '2026-07-10T00:00:00Z',
  }
  const readFileImpl = (async () => JSON.stringify(meta)) as any

  const config: RenewalConfig = {
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
      writeFileImpl: fs.writeFileImpl,
      renameImpl: fs.renameImpl,
      mkdirImpl: fs.mkdirImpl,
    },
    nginxReloader: {
      spawnImpl: nginxSpawn,
      noSudo: true,
      timeoutSeconds: 2,
    },
    nowImpl: () => opts.now ?? new Date('2026-04-11T12:00:00Z'),
    reloadOnce: true,
  }

  return { config, acmeCalls, nginxCalls, fs }
}

function makeLogger(): RenewalLogger & {
  events: Array<{ level: string; event: string; fields?: any }>
} {
  const events: Array<{ level: string; event: string; fields?: any }> = []
  return {
    events,
    info: (e, f) => events.push({ level: 'info', event: e, fields: f }),
    warn: (e, f) => events.push({ level: 'warn', event: e, fields: f }),
    error: (e, f) => events.push({ level: 'error', event: e, fields: f }),
  }
}

// ---------------------------------------------------------------------------
// listRenewalCandidates
// ---------------------------------------------------------------------------

describe('listRenewalCandidates', () => {
  it('returns rows whose ssl_expires_at <= now + windowDays', async () => {
    const db = createFakeDb([
      // Expires in 10 days — inside a 30-day window.
      makeRenewableRow({
        id: 'a',
        domain: 'a.example.io',
        ssl_expires_at: new Date('2026-04-21T00:00:00Z'),
      }),
      // Expires in 60 days — outside the window.
      makeRenewableRow({
        id: 'b',
        domain: 'b.example.io',
        ssl_expires_at: new Date('2026-06-11T00:00:00Z'),
      }),
      // No cert_path → excluded.
      makeRenewableRow({
        id: 'c',
        domain: 'c.example.io',
        ssl_expires_at: new Date('2026-04-12T00:00:00Z'),
        cert_path: null,
      }),
    ])

    const candidates = await listRenewalCandidates(
      db,
      new Date('2026-04-11T00:00:00Z'),
      30,
    )
    expect(candidates.map((r) => r.id)).toEqual(['a'])
  })

  it('orders by ssl_expires_at ascending (most urgent first)', async () => {
    const db = createFakeDb([
      makeRenewableRow({
        id: 'late',
        domain: 'late.io',
        ssl_expires_at: new Date('2026-04-25T00:00:00Z'),
      }),
      makeRenewableRow({
        id: 'early',
        domain: 'early.io',
        ssl_expires_at: new Date('2026-04-12T00:00:00Z'),
      }),
    ])
    const candidates = await listRenewalCandidates(
      db,
      new Date('2026-04-11T00:00:00Z'),
      30,
    )
    expect(candidates.map((r) => r.id)).toEqual(['early', 'late'])
  })

  it('returns empty array when no rows match', async () => {
    const db = createFakeDb()
    const candidates = await listRenewalCandidates(db, new Date(), 30)
    expect(candidates).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// runRenewalBatch — happy paths
// ---------------------------------------------------------------------------

describe('runRenewalBatch — success', () => {
  let db: any
  beforeEach(() => {
    db = createFakeDb()
  })

  it('emits the empty-tick log when there are no candidates', async () => {
    const logger = makeLogger()
    const { config } = buildConfig()
    const summary = await runRenewalBatch(db, config, logger)
    expect(summary).toEqual({
      candidates: 0,
      renewed: 0,
      alreadyFresh: 0,
      failed: 0,
      hardAlerts: 0,
      nginxReloaded: false,
    })
    expect(logger.events.find((e) => e.event === 'renewal.tick.empty')).toBeDefined()
  })

  it('renews a fresh cert, rewrites nginx, reloads once, updates the row', async () => {
    db.__rows.push(
      makeRenewableRow({
        ssl_expires_at: new Date('2026-04-25T00:00:00Z'), // 14 days left
      }),
    )
    const logger = makeLogger()
    const { config, acmeCalls, nginxCalls, fs } = buildConfig({
      newNotAfter: '2026-07-10T00:00:00Z',
    })

    const summary = await runRenewalBatch(db, config, logger)

    expect(summary.candidates).toBe(1)
    expect(summary.renewed).toBe(1)
    expect(summary.failed).toBe(0)
    expect(summary.nginxReloaded).toBe(true)

    // lego called once with `renew` subcommand.
    expect(acmeCalls.length).toBe(1)
    expect(acmeCalls[0]!.args).toContain('renew')

    // Nginx config file rewritten.
    const block = [...fs.writes.keys()].find((k) =>
      k.endsWith('thaibeotit.com.conf'),
    )
    expect(block).toBeDefined()

    // Single reload at the end of the batch (nginx -t + reload = 2 spawns).
    expect(nginxCalls.length).toBe(2)

    // Row updated: new expiry, failures cleared.
    const row = db.__rows[0] as FakeRow
    expect(row.ssl_expires_at?.toISOString()).toBe('2026-07-10T00:00:00.000Z')
    expect(row.renewal_failures).toBe(0)
    expect(row.ssl_last_error).toBeNull()
    expect(row.ssl_status).toBe('active')

    // Happy-path log events.
    expect(logger.events.find((e) => e.event === 'renewal.ok')).toBeDefined()
    expect(logger.events.find((e) => e.event === 'renewal.tick.done')).toBeDefined()
  })

  it('fires renewal.hard_alert when daysLeft <= hardAlertDays', async () => {
    db.__rows.push(
      makeRenewableRow({
        ssl_expires_at: new Date('2026-04-14T00:00:00Z'), // 3 days left
      }),
    )
    const logger = makeLogger()
    const { config } = buildConfig()

    const summary = await runRenewalBatch(db, config, logger)
    expect(summary.hardAlerts).toBe(1)
    const alert = logger.events.find((e) => e.event === 'renewal.hard_alert')
    expect(alert).toBeDefined()
    expect(alert!.level).toBe('error')
    expect(alert!.fields.daysLeft).toBeLessThanOrEqual(7)
  })

  it('counts a lego no-op as alreadyFresh (no nginx rewrite, no reload)', async () => {
    // Row must be in the renewal candidate window (≤ 30 days out) AND
    // lego must return the SAME expiry as what's already on disk, so
    // renewal.ts's `fresh` check trips into the noop branch.
    db.__rows.push(
      makeRenewableRow({
        ssl_expires_at: new Date('2026-04-25T00:00:00Z'), // 14 days left — candidate
      }),
    )
    const logger = makeLogger()
    const { config, nginxCalls, fs } = buildConfig({
      newNotAfter: '2026-04-25T00:00:00Z', // lego returns the same expiry
    })

    const summary = await runRenewalBatch(db, config, logger)
    expect(summary.alreadyFresh).toBe(1)
    expect(summary.renewed).toBe(0)
    expect(summary.nginxReloaded).toBe(false)
    // No reload because the window was met: reloadOnce only fires when
    // at least one cert actually changed.
    expect(nginxCalls.length).toBe(0)
    // No new nginx file written.
    expect(fs.writes.size).toBe(0)
    expect(logger.events.find((e) => e.event === 'renewal.noop')).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// runRenewalBatch — failure paths
// ---------------------------------------------------------------------------

describe('runRenewalBatch — failure', () => {
  it('records a lego failure, bumps renewal_failures, warn log (1st failure)', async () => {
    const db = createFakeDb()
    db.__rows.push(
      makeRenewableRow({
        ssl_expires_at: new Date('2026-04-25T00:00:00Z'),
        renewal_failures: 0,
      }),
    )
    const logger = makeLogger()
    const { config } = buildConfig({
      acmeOutcomes: [
        { exitCode: 1, stderr: 'acme: error: unauthorized' },
      ],
    })

    const summary = await runRenewalBatch(db, config, logger)
    expect(summary.failed).toBe(1)
    expect(summary.renewed).toBe(0)
    expect(summary.nginxReloaded).toBe(false)

    const row = db.__rows[0] as FakeRow
    expect(row.renewal_failures).toBe(1)
    expect(row.ssl_last_error).toMatch(/Renewal failed/)
    expect(row.ssl_last_attempt_at).not.toBeNull()

    const failed = logger.events.find((e) => e.event === 'renewal.failed')
    expect(failed).toBeDefined()
    expect(failed!.level).toBe('warn')
  })

  it('escalates to error log after 3 consecutive failures', async () => {
    const db = createFakeDb()
    db.__rows.push(
      makeRenewableRow({
        ssl_expires_at: new Date('2026-04-25T00:00:00Z'),
        renewal_failures: 2, // this attempt becomes the 3rd
      }),
    )
    const logger = makeLogger()
    const { config } = buildConfig({
      acmeOutcomes: [
        { exitCode: 1, stderr: 'acme: error: unauthorized' },
      ],
    })

    await runRenewalBatch(db, config, logger)
    const row = db.__rows[0] as FakeRow
    expect(row.renewal_failures).toBe(3)
    const failed = logger.events.find((e) => e.event === 'renewal.failed')
    expect(failed!.level).toBe('error')
  })

  it('counts an nginx-writer exception as failed with a distinct message', async () => {
    const db = createFakeDb()
    db.__rows.push(
      makeRenewableRow({
        ssl_expires_at: new Date('2026-04-25T00:00:00Z'),
      }),
    )
    const fs = makeFakeFs()
    fs.throwOnNextWrite = Object.assign(new Error('disk full'), {
      code: 'ENOSPC',
    })
    const logger = makeLogger()
    const { config } = buildConfig({
      fs,
      newNotAfter: '2026-07-10T00:00:00Z',
    })

    const summary = await runRenewalBatch(db, config, logger)
    expect(summary.failed).toBe(1)
    expect(summary.renewed).toBe(0)

    const row = db.__rows[0] as FakeRow
    expect(row.ssl_last_error).toMatch(/nginx-writer failed/)
    // Note: renewal_failures is NOT bumped on the nginx-writer branch
    // because the lego call actually succeeded. This is deliberate:
    // the cert is fresh on disk, only the Nginx refresh blew up, and
    // the next tick will retry the writer without re-hitting LE.
    expect(
      logger.events.find((e) => e.event === 'renewal.nginx_writer_failed'),
    ).toBeDefined()
  })

  it('logs renewal.nginx_reload_failed when systemctl reload exits non-zero', async () => {
    const db = createFakeDb()
    db.__rows.push(
      makeRenewableRow({
        ssl_expires_at: new Date('2026-04-25T00:00:00Z'),
      }),
    )
    const logger = makeLogger()
    const { config } = buildConfig({
      newNotAfter: '2026-07-10T00:00:00Z',
      nginxOutcomes: [
        { exitCode: 0, stdout: 'ok' },
        { exitCode: 1, stderr: 'reload failed' },
      ],
    })

    const summary = await runRenewalBatch(db, config, logger)
    // The row still renewed successfully — the reload at the end is
    // best-effort. But summary.nginxReloaded should be false.
    expect(summary.renewed).toBe(1)
    expect(summary.nginxReloaded).toBe(false)
    expect(
      logger.events.find((e) => e.event === 'renewal.nginx_reload_failed'),
    ).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// Misc — SAN derivation + injectable clock
// ---------------------------------------------------------------------------

describe('runRenewalBatch — SAN derivation', () => {
  it('re-issues www.<domain> for bare 2-label domains', async () => {
    const db = createFakeDb()
    db.__rows.push(
      makeRenewableRow({
        domain: 'thaibeotit.com',
        ssl_expires_at: new Date('2026-04-25T00:00:00Z'),
      }),
    )
    const { config, acmeCalls } = buildConfig({
      newNotAfter: '2026-07-10T00:00:00Z',
    })
    await runRenewalBatch(db, config)
    const argv = acmeCalls[0]!.args
    const domains = argv
      .map((a, i) => (a === '--domains' ? argv[i + 1] : null))
      .filter(Boolean)
    expect(domains).toEqual(['thaibeotit.com', 'www.thaibeotit.com'])
  })

  it('does NOT re-issue www.<domain> for 3+ label subdomains', async () => {
    const db = createFakeDb()
    db.__rows.push(
      makeRenewableRow({
        domain: 'shop.acme.io',
        ssl_expires_at: new Date('2026-04-25T00:00:00Z'),
      }),
    )
    const { config, acmeCalls } = buildConfig({
      newNotAfter: '2026-07-10T00:00:00Z',
    })
    await runRenewalBatch(db, config)
    const argv = acmeCalls[0]!.args
    const domains = argv
      .map((a, i) => (a === '--domains' ? argv[i + 1] : null))
      .filter(Boolean)
    expect(domains).toEqual(['shop.acme.io'])
  })
})

describe('runRenewalBatch — clock injection', () => {
  it('uses the nowImpl clock for candidate filtering', async () => {
    const db = createFakeDb()
    // Expires in 40 days from the natural wall clock but only 10 days
    // from our injected clock — should be inside the 30-day window.
    db.__rows.push(
      makeRenewableRow({
        ssl_expires_at: new Date('2030-01-11T00:00:00Z'),
      }),
    )
    // Suppress the vitest "dangling promise" warning if any — the
    // spy below just ensures we don't accidentally call real Date.
    const realNow = vi.spyOn(Date, 'now')

    const { config } = buildConfig({
      now: new Date('2030-01-01T00:00:00Z'),
      newNotAfter: '2030-04-01T00:00:00Z',
    })
    const summary = await runRenewalBatch(db, config)
    expect(summary.candidates).toBe(1)
    expect(summary.renewed).toBe(1)
    realNow.mockRestore()
  })
})
