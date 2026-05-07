import { describe, it, expect } from 'vitest'
import { resourceLimits, wrapBashCommand } from './resource-limits.ts'
import type { SessionContext, ToolCall } from './types.ts'

function ctx(overrides: Partial<SessionContext> = {}): SessionContext {
  return {
    sessionId: 's1',
    godAdminId: 'u1',
    toolCallCount: 0,
    tier3CallsLast5Min: [],
    consecutiveEditFailures: new Map(),
    bashInFlight: false,
    circuitBreakerOpen: false,
    trafficLevel: 'low',
    currentTime: new Date('2026-04-10T10:00:00Z'),
    repoRoot: '/tmp/gbox-repo',
    crossRepoRoots: [],
    ...overrides,
  }
}

function bashCall(command: string): ToolCall {
  return { id: 'tc1', name: 'bash.run', input: { command }, tier: 3 }
}

describe('wrapBashCommand', () => {
  it('prefixes ulimit + nice + timeout and sets cwd', () => {
    const wrapped = wrapBashCommand('npm test', '/tmp/gbox-repo')
    expect(wrapped).toContain('ulimit -v 2097152')
    expect(wrapped).toContain('cd "/tmp/gbox-repo"')
    expect(wrapped).toContain('nice -n 10')
    expect(wrapped).toContain('timeout --kill-after=5s 300s')
    expect(wrapped).toContain('bash -c')
    expect(wrapped).toContain('npm test')
  })

  it('escapes double quotes inside the inner command', () => {
    const wrapped = wrapBashCommand('echo "hello world"', '/tmp/gbox-repo')
    // The inner command must survive re-parsing — we backslash-escape
    // embedded double quotes.
    expect(wrapped).toMatch(/bash -c "echo \\"hello world\\""/)
  })

  it('rejects a relative cwd by throwing', () => {
    expect(() => wrapBashCommand('ls', 'relative/dir')).toThrow(/absolute/i)
  })
})

describe('resourceLimits guard layer', () => {
  it('passes through non-bash.run calls', async () => {
    const r = await resourceLimits.check(
      { id: 'tc1', name: 'repo.read', input: { path: 'x.ts' }, tier: 1 },
      ctx(),
    )
    expect(r).toEqual({ allowed: true })
  })

  it('allows bash.run when no other bash is in flight', async () => {
    const r = await resourceLimits.check(bashCall('npm test'), ctx())
    expect(r).toEqual({ allowed: true })
  })

  it('rejects bash.run when bashInFlight is true', async () => {
    const r = await resourceLimits.check(bashCall('npm test'), ctx({ bashInFlight: true }))
    expect(r.allowed).toBe(false)
    if (!r.allowed) {
      expect(r.layer).toBe('resource-limits')
      expect(r.reason).toMatch(/concurrent bash/i)
    }
  })

  it('rejects when repoRoot is not absolute', async () => {
    const r = await resourceLimits.check(bashCall('npm test'), ctx({ repoRoot: 'rel/path' }))
    expect(r.allowed).toBe(false)
    if (!r.allowed) expect(r.reason).toMatch(/absolute/i)
  })

  it('rejects bash.run with a non-string command (defensive)', async () => {
    const r = await resourceLimits.check(
      { id: 'tc1', name: 'bash.run', input: { command: 42 }, tier: 3 },
      ctx(),
    )
    expect(r.allowed).toBe(false)
  })
})
