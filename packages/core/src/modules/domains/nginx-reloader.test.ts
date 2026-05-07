/**
 * Gbox Platform — Nginx Reloader tests
 * (Landing Page System Phase 1D)
 *
 * Exercises the argv builders and drives `reloadNginx` through an
 * injected fake spawn. Every spawn invocation is recorded so tests
 * can assert on the exact command line that would have been executed
 * — no real sudo / systemctl calls.
 */

import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import {
  buildReloadCommand,
  buildTestCommand,
  DebouncedNginxReloader,
  reloadNginx,
} from './nginx-reloader.js'

// ---------------------------------------------------------------------------
// Fake spawn factory
// ---------------------------------------------------------------------------

interface FakeCmdOutcome {
  exitCode: number | null
  stdout?: string
  stderr?: string
}

function makeFakeSpawn(
  outcomes: FakeCmdOutcome[],
): {
  spawn: any
  calls: Array<{ binary: string; args: string[] }>
} {
  const calls: Array<{ binary: string; args: string[] }> = []
  let i = 0
  const spawn: any = (binary: string, args: string[]) => {
    calls.push({ binary, args })
    const outcome = outcomes[i++] ?? { exitCode: 0 }
    const child = new EventEmitter() as any
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = () => {}
    queueMicrotask(() => {
      if (outcome.stdout) child.stdout.emit('data', Buffer.from(outcome.stdout))
      if (outcome.stderr) child.stderr.emit('data', Buffer.from(outcome.stderr))
      child.emit('close', outcome.exitCode)
    })
    return child
  }
  return { spawn, calls }
}

// ---------------------------------------------------------------------------
// buildTestCommand / buildReloadCommand
// ---------------------------------------------------------------------------

describe('buildTestCommand', () => {
  it('wraps nginx -t in sudo by default', () => {
    const { binary, args } = buildTestCommand({})
    expect(binary).toBe('sudo')
    expect(args).toEqual(['/usr/sbin/nginx', '-t'])
  })

  it('skips sudo when noSudo=true', () => {
    const { binary, args } = buildTestCommand({ noSudo: true })
    expect(binary).toBe('/usr/sbin/nginx')
    expect(args).toEqual(['-t'])
  })

  it('honours injected binaries', () => {
    const { binary, args } = buildTestCommand({
      sudoBinary: '/usr/bin/sudo',
      nginxBinary: '/opt/nginx/sbin/nginx',
    })
    expect(binary).toBe('/usr/bin/sudo')
    expect(args).toEqual(['/opt/nginx/sbin/nginx', '-t'])
  })
})

describe('buildReloadCommand', () => {
  it('wraps systemctl reload nginx in sudo by default', () => {
    const { binary, args } = buildReloadCommand({})
    expect(binary).toBe('sudo')
    expect(args).toEqual(['/bin/systemctl', 'reload', 'nginx'])
  })

  it('runs systemctl directly when noSudo=true', () => {
    const { binary, args } = buildReloadCommand({ noSudo: true })
    expect(binary).toBe('/bin/systemctl')
    expect(args).toEqual(['reload', 'nginx'])
  })
})

// ---------------------------------------------------------------------------
// reloadNginx (fake spawn)
// ---------------------------------------------------------------------------

describe('reloadNginx', () => {
  it('runs nginx -t then systemctl reload and returns ok on success', async () => {
    const { spawn, calls } = makeFakeSpawn([
      { exitCode: 0, stdout: 'nginx: configuration test is successful' },
      { exitCode: 0, stdout: '' },
    ])
    const result = await reloadNginx({ spawnImpl: spawn, timeoutSeconds: 1 })
    expect(result.ok).toBe(true)
    expect(calls).toHaveLength(2)
    expect(calls[0]!.args).toContain('-t')
    expect(calls[1]!.args).toContain('reload')
  })

  it('returns config_test_failed + skips reload when nginx -t is non-zero', async () => {
    const { spawn, calls } = makeFakeSpawn([
      {
        exitCode: 1,
        stderr: 'nginx: [emerg] invalid number of arguments in "server_name" directive',
      },
    ])
    const result = await reloadNginx({ spawnImpl: spawn, timeoutSeconds: 1 })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.kind).toBe('config_test_failed')
    expect(result.message).toMatch(/server_name/)
    // Only the -t command should have been spawned.
    expect(calls).toHaveLength(1)
  })

  it('returns reload_failed when systemctl reload is non-zero', async () => {
    const { spawn } = makeFakeSpawn([
      { exitCode: 0 },
      {
        exitCode: 1,
        stderr: 'Failed to reload nginx.service: Unit not found',
      },
    ])
    const result = await reloadNginx({ spawnImpl: spawn, timeoutSeconds: 1 })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.kind).toBe('reload_failed')
  })

  it('returns binary_missing when stderr mentions ENOENT', async () => {
    const { spawn } = makeFakeSpawn([
      { exitCode: 127, stderr: 'sudo: /usr/sbin/nginx: No such file or directory' },
    ])
    const result = await reloadNginx({ spawnImpl: spawn, timeoutSeconds: 1 })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.kind).toBe('binary_missing')
  })
})

// ---------------------------------------------------------------------------
// DebouncedNginxReloader
// ---------------------------------------------------------------------------

describe('DebouncedNginxReloader', () => {
  it('coalesces multiple request() calls into one reload', async () => {
    const { spawn, calls } = makeFakeSpawn([
      { exitCode: 0 },
      { exitCode: 0 },
    ])
    const debouncer = new DebouncedNginxReloader(
      { spawnImpl: spawn, timeoutSeconds: 1 },
      5, // 5ms debounce — fast for tests
    )
    const [a, b, c] = await Promise.all([
      debouncer.request(),
      debouncer.request(),
      debouncer.request(),
    ])
    // All three callers get the same result reference.
    expect(a).toBe(b)
    expect(b).toBe(c)
    // Exactly one actual reload fired (2 spawn calls: -t + reload).
    expect(calls).toHaveLength(2)
  })

  it('cancel() resolves the pending request with the reason', async () => {
    const { spawn, calls } = makeFakeSpawn([{ exitCode: 0 }, { exitCode: 0 }])
    const debouncer = new DebouncedNginxReloader(
      { spawnImpl: spawn, timeoutSeconds: 1 },
      10_000, // long debounce so cancel wins the race
    )
    const p = debouncer.request()
    debouncer.cancel()
    const result = await p
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toMatch(/cancelled/)
    expect(calls).toHaveLength(0)
  })
})
