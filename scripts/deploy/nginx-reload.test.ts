/**
 * nginx-reload.test.ts — pins the "test first, then reload, abort if
 * test fails" contract, plus the ssh-wrapping for remote invocation.
 */

import { describe, it, expect } from 'vitest'
import { reloadNginx } from './nginx-reload.ts'
import type { RunResult } from './lib/runner.ts'

const okResult = (): RunResult => ({ exitCode: 0, stdout: '', stderr: '', durationMs: 1 })
const failResult = (stderr: string): RunResult => ({
  exitCode: 1,
  stdout: '',
  stderr,
  durationMs: 1,
})

describe('reloadNginx', () => {
  it('dry-run reports ok without running anything', async () => {
    let called = false
    const res = await reloadNginx({ sshHost: null, dryRun: true }, async () => {
      called = true
      return okResult()
    })
    expect(res).toEqual({ ok: true, testOk: true, reloaded: false, dryRun: true })
    expect(called).toBe(false)
  })

  it('runs nginx -t then systemctl reload on success', async () => {
    const calls: Array<{ cmd: string; args: string[] }> = []
    const res = await reloadNginx({ sshHost: null, dryRun: false }, async (cmd, args) => {
      calls.push({ cmd, args })
      return okResult()
    })
    expect(res.ok).toBe(true)
    expect(res.reloaded).toBe(true)
    expect(calls).toHaveLength(2)
    expect(calls[0]).toEqual({ cmd: 'sudo', args: ['nginx', '-t'] })
    expect(calls[1]).toEqual({ cmd: 'sudo', args: ['systemctl', 'reload', 'nginx'] })
  })

  it('aborts reload when nginx -t fails', async () => {
    let reloadCalled = false
    const res = await reloadNginx({ sshHost: null, dryRun: false }, async (_cmd, args) => {
      if (args.includes('-t')) return failResult('syntax error in site')
      reloadCalled = true
      return okResult()
    })
    expect(res.ok).toBe(false)
    expect(res.testOk).toBe(false)
    expect(res.reloaded).toBe(false)
    expect(res.testStderr).toContain('syntax error')
    expect(reloadCalled).toBe(false)
  })

  it('reports reload failure even when -t passes', async () => {
    const res = await reloadNginx({ sshHost: null, dryRun: false }, async (_cmd, args) => {
      if (args.includes('-t')) return okResult()
      return failResult('unit masked')
    })
    expect(res.ok).toBe(false)
    expect(res.testOk).toBe(true)
    expect(res.reloaded).toBe(false)
    expect(res.reloadStderr).toContain('unit masked')
  })

  it('wraps commands in ssh when sshHost is set', async () => {
    const calls: Array<{ cmd: string; args: string[] }> = []
    const res = await reloadNginx(
      { sshHost: 'botesty@192.168.1.13', dryRun: false },
      async (cmd, args) => {
        calls.push({ cmd, args })
        return okResult()
      },
    )
    expect(res.ok).toBe(true)
    expect(calls[0]?.cmd).toBe('ssh')
    expect(calls[0]?.args).toEqual(['botesty@192.168.1.13', 'sudo nginx -t'])
    expect(calls[1]?.args).toEqual(['botesty@192.168.1.13', 'sudo systemctl reload nginx'])
  })
})
