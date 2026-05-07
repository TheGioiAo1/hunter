/**
 * deploy.run — invoke scripts/deploy/blue-green-swap.ts against a
 * chosen target.
 *
 * Tier 3. The approval gate has already fired. The deployment-safety
 * guard layer has also already run — it blocks customer-facing
 * targets outside the maintenance window. By the time we're here
 * everything is green-lit, so this tool simply shells out to the
 * canonical deploy script and streams back its structured JSON.
 */

import { spawn } from 'node:child_process'
import type { ToolDef, ToolResult } from '../types.ts'

export type DeployTarget = 'storefront' | 'api' | 'god-admin' | 'accounts' | 'store-admin'

export interface DeployRunInput {
  target: DeployTarget
  env: 'staging' | 'production'
}

export interface DeployRunDeps {
  repoRoot: string
  /** Override subprocess runner in tests. */
  runCommand?: (
    cmd: string,
    args: string[],
    cwd: string,
  ) => Promise<{ exitCode: number; stdout: string; stderr: string }>
}

const ALLOWED_TARGETS: ReadonlySet<DeployTarget> = new Set([
  'storefront',
  'api',
  'god-admin',
  'accounts',
  'store-admin',
])

function parseInput(raw: unknown): DeployRunInput {
  if (!raw || typeof raw !== 'object') throw new Error('deploy.run: input must be an object')
  const r = raw as Record<string, unknown>
  if (typeof r.target !== 'string' || !ALLOWED_TARGETS.has(r.target as DeployTarget)) {
    throw new Error(`deploy.run: target must be one of ${[...ALLOWED_TARGETS].join('|')}`)
  }
  if (r.env !== 'staging' && r.env !== 'production') {
    throw new Error('deploy.run: env must be staging|production')
  }
  return { target: r.target as DeployTarget, env: r.env }
}

async function run(input: DeployRunInput, deps: DeployRunDeps): Promise<ToolResult> {
  const args = [
    'tsx',
    'scripts/deploy/blue-green-swap.ts',
    `--target=${input.target}`,
    `--env=${input.env}`,
  ]
  try {
    const runFn = deps.runCommand ?? defaultRun
    const result = await runFn('npx', args, deps.repoRoot)
    // The deploy script emits structured JSON on its last stdout line.
    let report: unknown = null
    const lastLine = result.stdout.trim().split('\n').pop()
    if (lastLine && lastLine.startsWith('{')) {
      try {
        report = JSON.parse(lastLine)
      } catch {
        /* ignore — fall back to raw stdout */
      }
    }
    return {
      kind: 'ok',
      data: {
        exitCode: result.exitCode,
        success: result.exitCode === 0,
        report,
        stdoutTail: result.stdout.slice(-8000),
        stderrTail: result.stderr.slice(-2000),
      },
    }
  } catch (err) {
    return { kind: 'error', message: (err as Error).message, code: 'spawn_failed' }
  }
}

function defaultRun(
  cmd: string,
  args: string[],
  cwd: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolveP) => {
    const proc = spawn(cmd, args, { cwd, shell: false })
    let stdout = ''
    let stderr = ''
    proc.stdout?.on('data', (d) => (stdout += d.toString()))
    proc.stderr?.on('data', (d) => (stderr += d.toString()))
    proc.on('close', (code) => resolveP({ exitCode: code ?? -1, stdout, stderr }))
  })
}

export const deployRunTool: ToolDef<DeployRunInput, DeployRunDeps> = {
  name: 'deploy.run',
  tier: 3,
  description: 'Blue/green deploy a target app. Guard chain refuses storefront outside maintenance window.',
  parseInput,
  run,
}
