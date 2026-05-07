/**
 * bash.run — execute a shell command wrapped by agent-guard Layer 3
 * (resource limits).
 *
 * Tier 3. Approval happens via the guard chain BEFORE we get here.
 * The guard chain has already validated the command string (parser +
 * blocklist) and cleared concurrency (max 1 in-flight bash).
 *
 * This tool:
 *   1. Builds the ulimit/nice/timeout wrapper via agent-guard's
 *      wrapBashCommand().
 *   2. Spawns bash -c with that wrapped script.
 *   3. Returns exit code + truncated stdout/stderr.
 *
 * Note: on Windows the bash wrapper isn't runnable natively — tests
 * must inject a fake `spawnImpl`.
 */

import { spawn } from 'node:child_process'
import { wrapBashCommand } from '@gbox/agent-guard'
import type { ToolDef, ToolResult } from '../types.ts'

export interface BashRunInput {
  command: string
  /** Working directory, relative to repoRoot. Defaults to repoRoot. */
  cwd?: string
}

export interface BashRunDeps {
  repoRoot: string
  /** Override for tests. */
  spawnImpl?: typeof spawn
}

const MAX_STDOUT = 16 * 1024
const MAX_STDERR = 8 * 1024

function parseInput(raw: unknown): BashRunInput {
  if (!raw || typeof raw !== 'object') throw new Error('bash.run: input must be an object')
  const r = raw as Record<string, unknown>
  if (typeof r.command !== 'string' || r.command.length === 0) {
    throw new Error('bash.run: command must be a non-empty string')
  }
  if (r.cwd !== undefined && typeof r.cwd !== 'string') {
    throw new Error('bash.run: cwd must be a string')
  }
  return { command: r.command, cwd: r.cwd as string | undefined }
}

async function run(input: BashRunInput, deps: BashRunDeps): Promise<ToolResult> {
  const cwd = input.cwd ?? deps.repoRoot
  const wrapped = wrapBashCommand(input.command, cwd)

  return new Promise((resolveP) => {
    try {
      const spawnFn = deps.spawnImpl ?? spawn
      const proc = spawnFn('bash', ['-c', wrapped], { cwd: deps.repoRoot, shell: false })
      let stdout = ''
      let stderr = ''
      proc.stdout?.on('data', (d: Buffer | string) => {
        if (stdout.length < MAX_STDOUT) stdout += d.toString()
      })
      proc.stderr?.on('data', (d: Buffer | string) => {
        if (stderr.length < MAX_STDERR) stderr += d.toString()
      })
      proc.on('error', (err: Error) => {
        resolveP({ kind: 'error', message: err.message, code: 'spawn_failed' })
      })
      proc.on('close', (code: number | null) => {
        resolveP({
          kind: 'ok',
          data: {
            exitCode: code ?? -1,
            stdout: stdout.slice(0, MAX_STDOUT),
            stderr: stderr.slice(0, MAX_STDERR),
            wrappedCommand: wrapped,
          },
        })
      })
    } catch (err) {
      resolveP({ kind: 'error', message: (err as Error).message, code: 'spawn_failed' })
    }
  })
}

export const bashRunTool: ToolDef<BashRunInput, BashRunDeps> = {
  name: 'bash.run',
  tier: 3,
  description: 'Run a bash command under agent-guard Layer 3 resource limits (ulimit + nice + 5min timeout).',
  parseInput,
  run,
}
