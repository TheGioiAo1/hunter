#!/usr/bin/env node
/**
 * nginx-reload.ts — validate and reload nginx on server 1.
 *
 * Wraps `nginx -t` + `systemctl reload nginx`. Used by
 * blue-green-swap.ts after an upstream swap, and also as a standalone
 * CLI when the oncall engineer tweaks the site config.
 *
 * Must run on server 1 (192.168.1.13). The --ssh-host flag exists so
 * the agent can invoke it from server 2/3 if it ever needs to (it
 * shells out to ssh — key-based auth assumed; no password prompting).
 *
 * CLI:
 *   npx tsx scripts/deploy/nginx-reload.ts [--ssh-host=user@host] [--dry-run]
 *
 * Exit codes:
 *   0 — `nginx -t` passed and reload returned 0
 *   1 — `nginx -t` failed OR reload failed (no reload attempted if -t failed)
 *   2 — unexpected error (couldn't spawn, bad args)
 */

import { emitReport, run } from './lib/runner.ts'
import type { RunResult } from './lib/runner.ts'

interface Args {
  sshHost: string | null
  dryRun: boolean
}

function parseArgs(argv: string[]): Args {
  const out: Args = { sshHost: null, dryRun: false }
  for (const a of argv) {
    if (a.startsWith('--ssh-host=')) out.sshHost = a.slice('--ssh-host='.length)
    else if (a === '--dry-run') out.dryRun = true
  }
  return out
}

export interface NginxReloadResult {
  ok: boolean
  testOk: boolean
  reloaded: boolean
  testStderr?: string
  reloadStderr?: string
  dryRun: boolean
}

type Runner = (cmd: string, args: string[]) => Promise<RunResult>

export async function reloadNginx(
  args: Args,
  runner: Runner = (cmd, as) => run(cmd, as, { timeoutMs: 30_000 }),
): Promise<NginxReloadResult> {
  const wrap = (inner: string[]): { cmd: string; args: string[] } => {
    if (args.sshHost) {
      return { cmd: 'ssh', args: [args.sshHost, inner.join(' ')] }
    }
    return { cmd: inner[0]!, args: inner.slice(1) }
  }

  if (args.dryRun) {
    return { ok: true, testOk: true, reloaded: false, dryRun: true }
  }

  const testCmd = wrap(['sudo', 'nginx', '-t'])
  const testRes = await runner(testCmd.cmd, testCmd.args)
  if (testRes.exitCode !== 0) {
    return {
      ok: false,
      testOk: false,
      reloaded: false,
      testStderr: testRes.stderr.slice(-2000),
      dryRun: false,
    }
  }

  const reloadCmd = wrap(['sudo', 'systemctl', 'reload', 'nginx'])
  const reloadRes = await runner(reloadCmd.cmd, reloadCmd.args)
  if (reloadRes.exitCode !== 0) {
    return {
      ok: false,
      testOk: true,
      reloaded: false,
      reloadStderr: reloadRes.stderr.slice(-2000),
      dryRun: false,
    }
  }

  return { ok: true, testOk: true, reloaded: true, dryRun: false }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const result = await reloadNginx(args)
  emitReport({ script: 'nginx-reload', ...result })
  process.exit(result.ok ? 0 : 1)
}

const isDirect = process.argv[1]?.endsWith('nginx-reload.ts')
if (isDirect) {
  void main().catch((err) => {
    emitReport({ script: 'nginx-reload', ok: false, error: (err as Error).message })
    process.exit(2)
  })
}
