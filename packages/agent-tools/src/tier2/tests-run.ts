/**
 * tests.run — execute the vitest suite (optionally filtered) and
 * return the structured result.
 *
 * Tier 2 (cost + risk: moderate). The guard chain has already
 * cleared the call. We shell out via an injectable runner so tests
 * can fake the subprocess without actually launching vitest.
 */

import { spawn } from 'node:child_process'
import type { ToolDef, ToolResult } from '../types.ts'

export interface TestsRunInput {
  /** Optional vitest filter pattern (e.g. 'packages/agent-core'). */
  filter?: string
  /** Run only a specific file. */
  file?: string
}

export interface TestsRunDeps {
  repoRoot: string
  /** Override the subprocess runner for tests. */
  runCommand?: (
    cmd: string,
    args: string[],
    cwd: string,
  ) => Promise<{ exitCode: number; stdout: string; stderr: string }>
}

function parseInput(raw: unknown): TestsRunInput {
  if (raw !== null && raw !== undefined && typeof raw !== 'object') {
    throw new Error('tests.run: input must be an object or omitted')
  }
  const r = (raw ?? {}) as Record<string, unknown>
  const out: TestsRunInput = {}
  if (r.filter !== undefined) {
    if (typeof r.filter !== 'string') throw new Error('tests.run: filter must be a string')
    out.filter = r.filter
  }
  if (r.file !== undefined) {
    if (typeof r.file !== 'string') throw new Error('tests.run: file must be a string')
    out.file = r.file
  }
  return out
}

export function defaultRunCommand(
  cmd: string,
  args: string[],
  cwd: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { cwd, shell: false })
    let stdout = ''
    let stderr = ''
    proc.stdout?.on('data', (d) => (stdout += d.toString()))
    proc.stderr?.on('data', (d) => (stderr += d.toString()))
    proc.on('close', (code) => resolve({ exitCode: code ?? -1, stdout, stderr }))
  })
}

async function run(input: TestsRunInput, deps: TestsRunDeps): Promise<ToolResult> {
  const args = ['vitest', 'run', '--reporter=default']
  if (input.filter) args.push(input.filter)
  if (input.file) args.push(input.file)

  try {
    const runFn = deps.runCommand ?? defaultRunCommand
    const result = await runFn('npx', args, deps.repoRoot)

    // Vitest uses exit 0 for all-green, non-zero for any failure.
    const summary = extractSummary(result.stdout)
    return {
      kind: 'ok',
      data: {
        exitCode: result.exitCode,
        passed: result.exitCode === 0,
        summary,
        stdoutTail: result.stdout.slice(-8000),
        stderrTail: result.stderr.slice(-2000),
      },
    }
  } catch (err) {
    return { kind: 'error', message: (err as Error).message, code: 'spawn_failed' }
  }
}

function extractSummary(stdout: string): string | null {
  // Vitest's summary line looks like "Test Files  5 passed (5)"
  const m = stdout.match(/Test Files\s+.*\n\s*Tests\s+.*/m)
  return m ? m[0] : null
}

export const testsRunTool: ToolDef<TestsRunInput, TestsRunDeps> = {
  name: 'tests.run',
  tier: 2,
  description: 'Run the vitest suite with an optional filter or specific file.',
  parseInput,
  run,
}
