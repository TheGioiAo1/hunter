/**
 * blue-green-swap.test.ts — unit tests for the deploy orchestrator.
 *
 * We inject mocks for runCommand / runHealthProbe / runSmokeProbe /
 * runNginxReload so nothing actually shells out. The focus is on the
 * pipeline wiring: gate → drain → reload → health → smoke → (nginx),
 * plus the fail-fast behaviour and the window gate for customer-facing
 * targets.
 */

import { describe, it, expect } from 'vitest'
import { runSwap, resolveTarget, type SwapArgs } from './blue-green-swap.ts'

const OK_AT_DAILY = new Date('2026-04-08T20:30:00Z') // 03:30 GMT+7 (Thu)
const OUTSIDE_WINDOW = new Date('2026-04-09T10:00:00Z') // 17:00 GMT+7

function baseArgs(overrides: Partial<SwapArgs> = {}): SwapArgs {
  return {
    target: 'god-admin',
    env: 'staging',
    quietSeconds: 0,
    healthRetries: 3,
    healthIntervalMs: 1,
    healthTimeoutMs: 100,
    reloadNginx: false,
    dryRun: false,
    at: OK_AT_DAILY,
    ...overrides,
  }
}

describe('resolveTarget', () => {
  it('marks storefront and api as customer-facing', () => {
    expect(resolveTarget('storefront', 'production').customerFacing).toBe(true)
    expect(resolveTarget('api', 'production').customerFacing).toBe(true)
  })

  it('marks admin surfaces as NOT customer-facing', () => {
    expect(resolveTarget('god-admin', 'production').customerFacing).toBe(false)
    expect(resolveTarget('accounts', 'production').customerFacing).toBe(false)
    expect(resolveTarget('store-admin', 'production').customerFacing).toBe(false)
  })

  it('routes storefront via server 3 ssh', () => {
    const spec = resolveTarget('storefront', 'production')
    expect(spec.sshHost).toMatch(/192\.168\.1\.19/)
    expect(spec.healthUrl).toContain('192.168.1.19:4321')
  })

  it('routes api via server 2 ssh', () => {
    const spec = resolveTarget('api', 'production')
    expect(spec.sshHost).toMatch(/192\.168\.1\.30/)
  })

  it('routes god-admin via server 1 ssh and 127.0.0.1:4324 health', () => {
    const spec = resolveTarget('god-admin', 'production')
    expect(spec.sshHost).toMatch(/192\.168\.1\.13/)
    expect(spec.healthUrl).toBe('http://127.0.0.1:4324/_health')
  })
})

describe('runSwap pipeline — happy path', () => {
  it('runs all steps in order for a non-customer-facing target', async () => {
    const calls: string[] = []
    const result = await runSwap(baseArgs({ target: 'god-admin' }), {
      runCommand: async () => {
        calls.push('pm2-reload')
        return { exitCode: 0, stdout: 'reloaded', stderr: '', durationMs: 1 }
      },
      runHealthProbe: async () => {
        calls.push('health')
        return { ok: true, attempts: 1, lastStatus: 200 }
      },
      runSmokeProbe: async () => {
        calls.push('smoke')
        return [{ path: '/_health', ok: true, status: 200, durationMs: 1 }]
      },
      sleep: async () => {},
    })
    expect(result.ok).toBe(true)
    expect(result.failedStep).toBeNull()
    expect(result.steps.map((s) => s.name)).toEqual([
      'window-gate',
      'drain-slot',
      'pm2-reload',
      'health-probe',
      'smoke-probe',
    ])
    // window-gate is first and should be skipped for non-customer-facing
    expect(result.steps[0]?.info).toMatchObject({ skipped: expect.any(String) })
    expect(calls).toEqual(['pm2-reload', 'health', 'smoke'])
  })

  it('includes nginx-reload step when --reload-nginx is set', async () => {
    const result = await runSwap(baseArgs({ reloadNginx: true }), {
      runCommand: async () => ({ exitCode: 0, stdout: '', stderr: '', durationMs: 1 }),
      runHealthProbe: async () => ({ ok: true, attempts: 1, lastStatus: 200 }),
      runSmokeProbe: async () => [{ path: '/_health', ok: true, status: 200, durationMs: 1 }],
      runNginxReload: async () => ({ ok: true, testOk: true, reloaded: true, dryRun: false }),
      sleep: async () => {},
    })
    expect(result.ok).toBe(true)
    expect(result.steps.map((s) => s.name)).toContain('nginx-reload')
  })
})

describe('runSwap — window gate', () => {
  it('refuses customer-facing deploy outside maintenance window', async () => {
    const result = await runSwap(
      baseArgs({ target: 'storefront', at: OUTSIDE_WINDOW }),
      {
        runCommand: async () => {
          throw new Error('pm2 should not have been called')
        },
      },
    )
    expect(result.ok).toBe(false)
    expect(result.failedStep).toBe('window-gate')
    // Pipeline must stop — only the gate step should appear.
    expect(result.steps.map((s) => s.name)).toEqual(['window-gate'])
  })

  it('allows customer-facing deploy inside daily window', async () => {
    const result = await runSwap(
      baseArgs({ target: 'api', at: OK_AT_DAILY }),
      {
        runCommand: async () => ({ exitCode: 0, stdout: '', stderr: '', durationMs: 1 }),
        runHealthProbe: async () => ({ ok: true, attempts: 1, lastStatus: 200 }),
        runSmokeProbe: async () => [
          { path: '/_health', ok: true, status: 200, durationMs: 1 },
        ],
        sleep: async () => {},
      },
    )
    expect(result.ok).toBe(true)
    expect(result.steps[0]).toMatchObject({ name: 'window-gate', ok: true })
  })

  it('skips the window gate for non-customer-facing targets at ANY time', async () => {
    const result = await runSwap(
      baseArgs({ target: 'accounts', at: OUTSIDE_WINDOW }),
      {
        runCommand: async () => ({ exitCode: 0, stdout: '', stderr: '', durationMs: 1 }),
        runHealthProbe: async () => ({ ok: true, attempts: 1, lastStatus: 200 }),
        runSmokeProbe: async () => [
          { path: '/_health', ok: true, status: 200, durationMs: 1 },
        ],
        sleep: async () => {},
      },
    )
    expect(result.ok).toBe(true)
  })
})

describe('runSwap — fail-fast', () => {
  it('stops at pm2-reload failure and does NOT run health-probe', async () => {
    let healthCalled = false
    const result = await runSwap(baseArgs(), {
      runCommand: async () => ({
        exitCode: 1,
        stdout: '',
        stderr: 'pm2 boom',
        durationMs: 1,
      }),
      runHealthProbe: async () => {
        healthCalled = true
        return { ok: true, attempts: 1, lastStatus: 200 }
      },
      sleep: async () => {},
    })
    expect(result.ok).toBe(false)
    expect(result.failedStep).toBe('pm2-reload')
    expect(healthCalled).toBe(false)
    expect(result.steps.map((s) => s.name)).toEqual([
      'window-gate',
      'drain-slot',
      'pm2-reload',
    ])
  })

  it('stops at health-probe failure and does NOT run smoke-probe', async () => {
    let smokeCalled = false
    const result = await runSwap(baseArgs(), {
      runCommand: async () => ({ exitCode: 0, stdout: '', stderr: '', durationMs: 1 }),
      runHealthProbe: async () => ({
        ok: false,
        attempts: 3,
        lastStatus: 502,
        lastError: 'boom',
      }),
      runSmokeProbe: async () => {
        smokeCalled = true
        return []
      },
      sleep: async () => {},
    })
    expect(result.ok).toBe(false)
    expect(result.failedStep).toBe('health-probe')
    expect(smokeCalled).toBe(false)
  })

  it('stops at smoke-probe failure', async () => {
    const result = await runSwap(baseArgs(), {
      runCommand: async () => ({ exitCode: 0, stdout: '', stderr: '', durationMs: 1 }),
      runHealthProbe: async () => ({ ok: true, attempts: 1, lastStatus: 200 }),
      runSmokeProbe: async () => [
        { path: '/_health', ok: true, status: 200, durationMs: 1 },
        { path: '/god-admin/login', ok: false, status: 503, durationMs: 1 },
      ],
      sleep: async () => {},
    })
    expect(result.ok).toBe(false)
    expect(result.failedStep).toBe('smoke-probe')
    const smoke = result.steps.find((s) => s.name === 'smoke-probe')
    expect(smoke?.error).toContain('/god-admin/login')
  })
})

describe('runSwap — dry run', () => {
  it('emits ok result without calling runner/probes', async () => {
    let touched = false
    const result = await runSwap(baseArgs({ dryRun: true }), {
      runCommand: async () => {
        touched = true
        throw new Error('should not run')
      },
      runHealthProbe: async () => {
        touched = true
        return { ok: false, attempts: 0 }
      },
      runSmokeProbe: async () => {
        touched = true
        return []
      },
    })
    expect(result.ok).toBe(true)
    expect(touched).toBe(false)
  })
})
