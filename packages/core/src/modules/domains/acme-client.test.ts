/**
 * Gbox Platform — ACME Client tests
 * (Landing Page System Phase 1D)
 *
 * Exercises the pure parts of acme-client.ts directly (`buildLegoArgs`,
 * `buildLegoRenewArgs`, `classifyLegoError`, `certificateFilePaths`)
 * and drives `issueCertificate` / `renewCertificate` through an
 * injected fake `spawn` so there's no real child process involved.
 *
 * The fake spawn returns a minimal object that looks enough like a
 * Node `ChildProcess` for `runSpawn`'s subset of the API: a stdout/
 * stderr EventEmitter, an `on('close')` hook, and a no-op `kill`.
 */

import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import {
  buildLegoArgs,
  buildLegoRenewArgs,
  certificateFilePaths,
  classifyLegoError,
  issueCertificate,
  renewCertificate,
  type AcmeClientConfig,
} from './acme-client.js'

// ---------------------------------------------------------------------------
// Fake spawn plumbing
// ---------------------------------------------------------------------------

interface FakeSpawnOutcome {
  exitCode: number | null
  stdout?: string
  stderr?: string
  /** If true, never emit close — runSpawn should hit its timeout. */
  hang?: boolean
}

function makeFakeSpawn(outcome: FakeSpawnOutcome): {
  spawn: any
  calls: Array<{ binary: string; args: string[] }>
} {
  const calls: Array<{ binary: string; args: string[] }> = []
  const spawn: any = (binary: string, args: string[]) => {
    calls.push({ binary, args })

    const child = new EventEmitter() as any
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    // kill() mirrors a real SIGTERM → child exits → close fires.
    // Needed so runSpawn's timeout path (sees timedOut=true, sends
    // SIGTERM, then waits for close) actually resolves under test.
    child.kill = () => child.emit('close', null)

    // Emit on next microtask so runSpawn's listeners are attached.
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
// buildLegoArgs
// ---------------------------------------------------------------------------

describe('buildLegoArgs', () => {
  const base: AcmeClientConfig = {
    accountEmail: 'ops@gbox.co',
    legoPath: '/etc/gbox/lego',
    webrootPath: '/var/www/acme-webroot',
  }

  it('emits an http01 argv for production by default', () => {
    const args = buildLegoArgs(base, { domain: 'thaibeotit.com' })
    expect(args).toContain('--path')
    expect(args).toContain('/etc/gbox/lego')
    expect(args).toContain('--email')
    expect(args).toContain('ops@gbox.co')
    expect(args).toContain('--accept-tos')
    expect(args).toContain('--http')
    expect(args).toContain('--http.webroot')
    expect(args).toContain('/var/www/acme-webroot')
    expect(args).toContain('--domains')
    expect(args).toContain('thaibeotit.com')
    // Production ACME URL should be explicit so tests / audits can
    // tell which endpoint was used without re-reading config.
    expect(args).toContain('https://acme-v02.api.letsencrypt.org/directory')
    expect(args[args.length - 1]).toBe('run')
  })

  it('switches to the LE staging URL when environment=staging', () => {
    const args = buildLegoArgs(
      { ...base, environment: 'staging' },
      { domain: 'thaibeotit.com' },
    )
    expect(args).toContain(
      'https://acme-staging-v02.api.letsencrypt.org/directory',
    )
    expect(args).not.toContain('https://acme-v02.api.letsencrypt.org/directory')
  })

  it('passes every SAN as an additional --domains flag', () => {
    const args = buildLegoArgs(base, {
      domain: 'thaibeotit.com',
      sans: ['www.thaibeotit.com', 'shop.thaibeotit.com'],
    })
    const domainFlags = args
      .map((a, i) => (a === '--domains' ? args[i + 1] : null))
      .filter(Boolean)
    expect(domainFlags).toEqual([
      'thaibeotit.com',
      'www.thaibeotit.com',
      'shop.thaibeotit.com',
    ])
  })

  it('switches to --dns for dns01 challenge', () => {
    const args = buildLegoArgs(
      { ...base, dnsProvider: 'cloudflare' },
      { domain: '*.gbox.co', challenge: 'dns01' },
    )
    expect(args).toContain('--dns')
    expect(args).toContain('cloudflare')
    expect(args).not.toContain('--http')
  })

  it('throws when dns01 is requested without a provider', () => {
    expect(() =>
      buildLegoArgs(base, { domain: '*.gbox.co', challenge: 'dns01' }),
    ).toThrow(/dnsProvider is required/)
  })
})

// ---------------------------------------------------------------------------
// buildLegoRenewArgs
// ---------------------------------------------------------------------------

describe('buildLegoRenewArgs', () => {
  const base: AcmeClientConfig = { accountEmail: 'ops@gbox.co' }

  it('swaps run for renew and appends --days', () => {
    const args = buildLegoRenewArgs(base, {
      domain: 'thaibeotit.com',
      renewalDays: 30,
    })
    expect(args[args.length - 3]).toBe('renew')
    expect(args[args.length - 2]).toBe('--days')
    expect(args[args.length - 1]).toBe('30')
    expect(args).not.toContain('run')
  })

  it('defaults renewalDays to 30', () => {
    const args = buildLegoRenewArgs(base, { domain: 'thaibeotit.com' })
    expect(args[args.length - 1]).toBe('30')
  })
})

// ---------------------------------------------------------------------------
// classifyLegoError
// ---------------------------------------------------------------------------

describe('classifyLegoError', () => {
  it('detects LE rate-limit language', () => {
    expect(
      classifyLegoError(1, '', 'error: too many certificates already issued'),
    ).toBe('rate_limited')
    expect(classifyLegoError(1, '', 'rate limit exceeded')).toBe('rate_limited')
    expect(classifyLegoError(1, '', 'HTTP 429')).toBe('rate_limited')
  })

  it('detects DNS propagation failures', () => {
    expect(classifyLegoError(1, '', 'dial tcp: no such host')).toBe(
      'dns_not_ready',
    )
    expect(classifyLegoError(1, '', 'DNS problem: NXDOMAIN looking up A')).toBe(
      'dns_not_ready',
    )
  })

  it('detects HTTP-01 unreachable errors', () => {
    expect(
      classifyLegoError(1, '', 'unauthorized: invalid response from challenge'),
    ).toBe('unauthorized')
    expect(classifyLegoError(1, '', 'timeout during connect')).toBe(
      'unauthorized',
    )
  })

  it('returns timeout when exitCode is null', () => {
    expect(classifyLegoError(null, '', '')).toBe('timeout')
  })

  it('falls back to unknown for unrecognised output', () => {
    expect(classifyLegoError(1, '', 'something happened')).toBe('unknown')
  })
})

// ---------------------------------------------------------------------------
// certificateFilePaths
// ---------------------------------------------------------------------------

describe('certificateFilePaths', () => {
  it('maps a bare domain to the expected cert filenames', () => {
    const p = certificateFilePaths('/etc/gbox/lego', 'thaibeotit.com')
    expect(p.certPath).toBe('/etc/gbox/lego/certificates/thaibeotit.com.crt')
    expect(p.keyPath).toBe('/etc/gbox/lego/certificates/thaibeotit.com.key')
    expect(p.chainPath).toBe(
      '/etc/gbox/lego/certificates/thaibeotit.com.issuer.crt',
    )
    expect(p.metaPath).toBe('/etc/gbox/lego/certificates/thaibeotit.com.json')
  })

  it('rewrites a wildcard into `_.` to produce a valid filename', () => {
    const p = certificateFilePaths('/etc/gbox/lego', '*.gbox.co')
    expect(p.certPath).toBe('/etc/gbox/lego/certificates/_.gbox.co.crt')
  })

  it('normalises Windows-style legoPath separators to POSIX', () => {
    const p = certificateFilePaths('C:\\etc\\gbox\\lego', 'thaibeotit.com')
    expect(p.certPath).toBe('C:/etc/gbox/lego/certificates/thaibeotit.com.crt')
  })
})

// ---------------------------------------------------------------------------
// issueCertificate (injected spawn)
// ---------------------------------------------------------------------------

describe('issueCertificate', () => {
  const baseConfig: AcmeClientConfig = {
    accountEmail: 'ops@gbox.co',
    legoPath: '/etc/gbox/lego',
    timeoutSeconds: 1,
  }

  it('returns ok + parsed metadata on a successful lego run', async () => {
    const { spawn, calls } = makeFakeSpawn({
      exitCode: 0,
      stdout: 'lego: issuing certificate\n',
    })
    const readFileImpl = (async () =>
      JSON.stringify({
        domain: 'thaibeotit.com',
        notBefore: '2026-04-11T00:00:00Z',
        notAfter: '2026-07-10T00:00:00Z',
      })) as any

    const result = await issueCertificate(
      { ...baseConfig, spawnImpl: spawn, readFileImpl },
      { domain: 'thaibeotit.com' },
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.domain).toBe('thaibeotit.com')
    expect(result.value.certPath).toContain('thaibeotit.com.crt')
    expect(result.value.expiresAt.toISOString()).toBe('2026-07-10T00:00:00.000Z')
    expect(result.value.environment).toBe('production')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.args).toContain('thaibeotit.com')
  })

  it('classifies a lego rate-limit exit as kind=rate_limited', async () => {
    const { spawn } = makeFakeSpawn({
      exitCode: 1,
      stderr: 'acme: error: 429 :: too many certificates already issued',
    })
    const result = await issueCertificate(
      { ...baseConfig, spawnImpl: spawn },
      { domain: 'thaibeotit.com' },
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.kind).toBe('rate_limited')
  })

  it('surfaces binary_missing when stderr mentions ENOENT', async () => {
    const { spawn } = makeFakeSpawn({
      exitCode: 127,
      stderr: 'spawn lego ENOENT',
    })
    const result = await issueCertificate(
      { ...baseConfig, spawnImpl: spawn },
      { domain: 'thaibeotit.com' },
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.kind).toBe('binary_missing')
  })

  it('returns timeout kind when spawn never closes in time', async () => {
    const { spawn } = makeFakeSpawn({ exitCode: 0, hang: true })
    const result = await issueCertificate(
      { ...baseConfig, timeoutSeconds: 0.05, spawnImpl: spawn },
      { domain: 'thaibeotit.com' },
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.kind).toBe('timeout')
  })

  it('returns unknown kind if metadata JSON is unreadable even after success', async () => {
    const { spawn } = makeFakeSpawn({ exitCode: 0, stdout: 'ok' })
    const readFileImpl = (async () => {
      throw Object.assign(new Error('nope'), { code: 'ENOENT' })
    }) as any
    const result = await issueCertificate(
      { ...baseConfig, spawnImpl: spawn, readFileImpl },
      { domain: 'thaibeotit.com' },
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.kind).toBe('unknown')
  })
})

// ---------------------------------------------------------------------------
// renewCertificate
// ---------------------------------------------------------------------------

describe('renewCertificate', () => {
  it('spawns lego with the renew subcommand + --days', async () => {
    const { spawn, calls } = makeFakeSpawn({ exitCode: 0, stdout: 'ok' })
    const readFileImpl = (async () =>
      JSON.stringify({
        notBefore: '2026-04-11T00:00:00Z',
        notAfter: '2026-07-10T00:00:00Z',
      })) as any
    await renewCertificate(
      {
        accountEmail: 'ops@gbox.co',
        legoPath: '/etc/gbox/lego',
        spawnImpl: spawn,
        readFileImpl,
        timeoutSeconds: 1,
      },
      { domain: 'thaibeotit.com', renewalDays: 30 },
    )
    expect(calls).toHaveLength(1)
    const argv = calls[0]!.args
    expect(argv).toContain('renew')
    expect(argv).toContain('--days')
    expect(argv).toContain('30')
    expect(argv).not.toContain('run')
  })
})
