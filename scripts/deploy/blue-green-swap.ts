#!/usr/bin/env node
/**
 * blue-green-swap.ts — the canonical deploy orchestrator.
 *
 * This script is what the agent's `deploy.run` tool spawns via:
 *   npx tsx scripts/deploy/blue-green-swap.ts --target=<t> --env=<e>
 *
 * It chains the pre-flight → drain → reload → verify steps into one
 * linear pipeline and emits a single-line JSON report to stdout (the
 * LAST non-empty line) so the agent sidecar can parse it cleanly.
 *
 * Pipeline per target:
 *   1. Resolve target spec (host, pm2-name, health URL, public base,
 *      customer-facing flag).
 *   2. If customer-facing: gate on insideDailyWindow||insideSundayWindow.
 *      This mirrors the deployment-safety guard in the agent — the
 *      duplication is intentional so oncall can run this script with
 *      no agent involvement and still get the same refusal.
 *   3. drain-slot: sleep a quiet period so in-flight requests finish.
 *   4. pm2 reload (local or via ssh depending on target.host).
 *   5. health-probe: hammer the slot's /_health until it's 200.
 *   6. smoke-probe: hit a handful of customer-visible paths, fail on
 *      any 5xx.
 *   7. nginx-reload: only when --reload-nginx is passed (the default
 *      swap doesn't change the nginx site config, so skip the sudo).
 *
 * CLI:
 *   --target=storefront|api|god-admin|accounts|store-admin   (required)
 *   --env=staging|production                                  (required)
 *   --quiet-seconds=<n>         drain window (default 5)
 *   --health-retries=<n>        probe retries (default 15)
 *   --health-interval-ms=<n>    probe interval (default 2000)
 *   --health-timeout-ms=<n>     probe timeout (default 3000)
 *   --reload-nginx              also reload nginx on server 1
 *   --dry-run                   skip side effects, still emit report
 *   --at=<iso>                  override "now" for window gate (tests)
 *
 * Exit codes:
 *   0 — full pipeline green
 *   1 — one of the steps failed (see report.failedStep)
 *   2 — bad args / unexpected error
 */

import { emitReport, run } from './lib/runner.ts'
import { insideDailyWindow, insideSundayWindow } from './lib/windows.ts'
import { probeWithRetries } from './health-probe.ts'
import { probeTarget } from './smoke-probe.ts'
import { drainSlot } from './drain-slot.ts'
import { reloadNginx } from './nginx-reload.ts'
import type { RunResult } from './lib/runner.ts'

export type Target = 'storefront' | 'api' | 'god-admin' | 'accounts' | 'store-admin'

export interface TargetSpec {
  target: Target
  /** null → run pm2 locally. Otherwise ssh <host> <cmd>. */
  sshHost: string | null
  pm2Name: string
  healthUrl: string
  publicBase: string
  customerFacing: boolean
}

/**
 * Resolve the deploy topology for a target. The values below mirror
 * scripts/deploy/nginx-server1.conf.template and the server{1,2,3}
 * update scripts. If you change the topology in one place, change it
 * here too.
 */
export function resolveTarget(target: Target, env: 'staging' | 'production'): TargetSpec {
  const s1 = 'botesty@192.168.1.13'
  const s2 = 'unbutu2@192.168.1.30'
  const s3 = 'unbutu1@192.168.1.19'

  // Both staging and production hit the same LAN today — the env flag
  // is forwarded to the agent's audit log and to this script's report,
  // but does not change the box we talk to. This will matter once we
  // stand up a real staging tier.
  void env

  switch (target) {
    case 'storefront':
      return {
        target,
        sshHost: s3,
        pm2Name: 'gbox-storefront',
        healthUrl: 'http://192.168.1.19:4321/_health',
        publicBase: 'http://192.168.1.13',
        customerFacing: true,
      }
    case 'api':
      return {
        target,
        sshHost: s2,
        pm2Name: 'gbox-api',
        healthUrl: 'http://192.168.1.30:4321/_health',
        publicBase: 'http://192.168.1.13',
        customerFacing: true,
      }
    case 'god-admin':
      return {
        target,
        sshHost: s1,
        pm2Name: 'gbox-god-admin',
        healthUrl: 'http://127.0.0.1:4324/_health',
        publicBase: 'http://192.168.1.13',
        customerFacing: false,
      }
    case 'accounts':
      return {
        target,
        sshHost: s1,
        pm2Name: 'gbox-accounts',
        healthUrl: 'http://127.0.0.1:4323/_health',
        publicBase: 'http://192.168.1.13',
        customerFacing: false,
      }
    case 'store-admin':
      return {
        target,
        sshHost: s1,
        pm2Name: 'gbox-store-admin',
        healthUrl: 'http://127.0.0.1:4325/_health',
        publicBase: 'http://192.168.1.13',
        customerFacing: false,
      }
  }
}

export interface SwapArgs {
  target: Target
  env: 'staging' | 'production'
  quietSeconds: number
  healthRetries: number
  healthIntervalMs: number
  healthTimeoutMs: number
  reloadNginx: boolean
  dryRun: boolean
  at: Date
}

function parseArgs(argv: string[]): SwapArgs {
  const out: SwapArgs = {
    target: '' as Target,
    env: '' as SwapArgs['env'],
    quietSeconds: 5,
    healthRetries: 15,
    healthIntervalMs: 2000,
    healthTimeoutMs: 3000,
    reloadNginx: false,
    dryRun: false,
    at: new Date(),
  }
  for (const a of argv) {
    if (a.startsWith('--target=')) out.target = a.slice('--target='.length) as Target
    else if (a.startsWith('--env=')) out.env = a.slice('--env='.length) as SwapArgs['env']
    else if (a.startsWith('--quiet-seconds=')) out.quietSeconds = parseInt(a.slice('--quiet-seconds='.length), 10)
    else if (a.startsWith('--health-retries=')) out.healthRetries = parseInt(a.slice('--health-retries='.length), 10)
    else if (a.startsWith('--health-interval-ms=')) out.healthIntervalMs = parseInt(a.slice('--health-interval-ms='.length), 10)
    else if (a.startsWith('--health-timeout-ms=')) out.healthTimeoutMs = parseInt(a.slice('--health-timeout-ms='.length), 10)
    else if (a === '--reload-nginx') out.reloadNginx = true
    else if (a === '--dry-run') out.dryRun = true
    else if (a.startsWith('--at=')) {
      const iso = a.slice('--at='.length)
      const d = new Date(iso)
      if (isNaN(d.getTime())) throw new Error(`invalid --at value: ${iso}`)
      out.at = d
    }
  }
  if (!out.target) throw new Error('--target is required')
  if (!out.env) throw new Error('--env is required')
  const allowed: Target[] = ['storefront', 'api', 'god-admin', 'accounts', 'store-admin']
  if (!allowed.includes(out.target)) {
    throw new Error(`unknown target: ${out.target}. Allowed: ${allowed.join(', ')}`)
  }
  if (out.env !== 'staging' && out.env !== 'production') {
    throw new Error('--env must be staging|production')
  }
  return out
}

export interface SwapDeps {
  /** Inject for tests. */
  runCommand?: (cmd: string, args: string[]) => Promise<RunResult>
  sleep?: (ms: number) => Promise<void>
  /** Override fetch-based probes — used by blue-green-swap.test.ts. */
  runHealthProbe?: typeof probeWithRetries
  runSmokeProbe?: typeof probeTarget
  runNginxReload?: typeof reloadNginx
}

export interface SwapStep {
  name: string
  ok: boolean
  durationMs: number
  info?: Record<string, unknown>
  error?: string
}

export interface SwapResult {
  ok: boolean
  target: Target
  env: 'staging' | 'production'
  customerFacing: boolean
  at: string
  steps: SwapStep[]
  failedStep: string | null
}

export async function runSwap(args: SwapArgs, deps: SwapDeps = {}): Promise<SwapResult> {
  const spec = resolveTarget(args.target, args.env)
  const steps: SwapStep[] = []
  let failedStep: string | null = null

  const record = async <T>(
    name: string,
    fn: () => Promise<{ ok: boolean; info?: Record<string, unknown>; error?: string; value?: T }>,
  ): Promise<{ ok: boolean; value?: T }> => {
    const t0 = Date.now()
    try {
      const res = await fn()
      steps.push({
        name,
        ok: res.ok,
        durationMs: Date.now() - t0,
        info: res.info,
        error: res.error,
      })
      if (!res.ok && failedStep === null) failedStep = name
      return { ok: res.ok, value: res.value }
    } catch (err) {
      steps.push({
        name,
        ok: false,
        durationMs: Date.now() - t0,
        error: (err as Error).message,
      })
      if (failedStep === null) failedStep = name
      return { ok: false }
    }
  }

  const runner = deps.runCommand ?? ((cmd, as) => run(cmd, as, { timeoutMs: 5 * 60_000 }))
  const healthFn = deps.runHealthProbe ?? probeWithRetries
  const smokeFn = deps.runSmokeProbe ?? probeTarget
  const nginxFn = deps.runNginxReload ?? reloadNginx

  // --- Step 1: window gate (customer-facing only) ---------------------
  const gate = await record('window-gate', async () => {
    if (!spec.customerFacing) {
      return { ok: true, info: { skipped: 'target is not customer-facing' } }
    }
    const daily = insideDailyWindow(args.at)
    const sunday = insideSundayWindow(args.at)
    const ok = daily || sunday
    return {
      ok,
      info: { daily, sunday, at: args.at.toISOString() },
      error: ok ? undefined : 'outside maintenance windows — customer-facing deploy refused',
    }
  })
  if (!gate.ok) return finalize(args, spec, steps, failedStep)

  // --- Step 2: drain-slot ----------------------------------------------
  const drain = await record('drain-slot', async () => {
    if (args.dryRun) return { ok: true, info: { dryRun: true, quietSeconds: args.quietSeconds } }
    const d = await drainSlot(
      { pm2Name: spec.pm2Name, quietSeconds: args.quietSeconds },
      deps.sleep,
    )
    return { ok: d.ok, info: { slept: d.slept, quietSeconds: d.quietSeconds } }
  })
  if (!drain.ok) return finalize(args, spec, steps, failedStep)

  // --- Step 3: pm2 reload ----------------------------------------------
  const reload = await record('pm2-reload', async () => {
    if (args.dryRun) {
      return { ok: true, info: { dryRun: true, pm2Name: spec.pm2Name, host: spec.sshHost } }
    }
    const inner = ['pm2', 'reload', spec.pm2Name, '--update-env']
    const cmd = spec.sshHost ? 'ssh' : inner[0]!
    const cmdArgs = spec.sshHost ? [spec.sshHost, inner.join(' ')] : inner.slice(1)
    const res = await runner(cmd, cmdArgs)
    if (res.exitCode !== 0) {
      return {
        ok: false,
        info: { exitCode: res.exitCode, host: spec.sshHost },
        error: res.stderr.slice(-1000) || `pm2 reload exited ${res.exitCode}`,
      }
    }
    return {
      ok: true,
      info: { exitCode: 0, host: spec.sshHost, stdoutTail: res.stdout.slice(-500) },
    }
  })
  if (!reload.ok) return finalize(args, spec, steps, failedStep)

  // --- Step 4: health-probe --------------------------------------------
  const health = await record('health-probe', async () => {
    if (args.dryRun) return { ok: true, info: { dryRun: true, url: spec.healthUrl } }
    const res = await healthFn({
      url: spec.healthUrl,
      retries: args.healthRetries,
      intervalMs: args.healthIntervalMs,
      timeoutMs: args.healthTimeoutMs,
    })
    return {
      ok: res.ok,
      info: { attempts: res.attempts, lastStatus: res.lastStatus, url: spec.healthUrl },
      error: res.ok ? undefined : res.lastError ?? `health probe failed after ${res.attempts} attempts`,
    }
  })
  if (!health.ok) return finalize(args, spec, steps, failedStep)

  // --- Step 5: smoke-probe ---------------------------------------------
  const smoke = await record('smoke-probe', async () => {
    if (args.dryRun) return { ok: true, info: { dryRun: true, base: spec.publicBase } }
    const lines = await smokeFn(spec.target, spec.publicBase, args.healthTimeoutMs)
    const ok = lines.every((l) => l.ok)
    const firstBad = lines.find((l) => !l.ok)
    return {
      ok,
      info: { base: spec.publicBase, probes: lines },
      error: ok
        ? undefined
        : `smoke failed at ${firstBad?.path}: ${firstBad?.error ?? `status ${firstBad?.status}`}`,
    }
  })
  if (!smoke.ok) return finalize(args, spec, steps, failedStep)

  // --- Step 6: nginx-reload (optional) ---------------------------------
  if (args.reloadNginx) {
    await record('nginx-reload', async () => {
      const res = await nginxFn({ sshHost: 'botesty@192.168.1.13', dryRun: args.dryRun })
      return {
        ok: res.ok,
        info: { testOk: res.testOk, reloaded: res.reloaded, dryRun: res.dryRun },
        error: res.ok ? undefined : res.testStderr ?? res.reloadStderr ?? 'nginx reload failed',
      }
    })
  }

  return finalize(args, spec, steps, failedStep)
}

function finalize(
  args: SwapArgs,
  spec: TargetSpec,
  steps: SwapStep[],
  failedStep: string | null,
): SwapResult {
  return {
    ok: failedStep === null && steps.every((s) => s.ok),
    target: spec.target,
    env: args.env,
    customerFacing: spec.customerFacing,
    at: args.at.toISOString(),
    steps,
    failedStep,
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const result = await runSwap(args)
  emitReport({ script: 'blue-green-swap', ...result })
  process.exit(result.ok ? 0 : 1)
}

const isDirect = process.argv[1]?.endsWith('blue-green-swap.ts')
if (isDirect) {
  void main().catch((err) => {
    emitReport({ script: 'blue-green-swap', ok: false, error: (err as Error).message })
    process.exit(2)
  })
}
