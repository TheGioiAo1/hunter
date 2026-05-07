/**
 * typecheck.run — run `tsc --noEmit` against the repo or a package.
 *
 * Tier 2. Uses the same injectable runner as tests.run so both can
 * share a fake in unit tests.
 */

import type { ToolDef, ToolResult } from '../types.ts'
import { defaultRunCommand } from './tests-run.ts'

export interface TypecheckRunInput {
  /** Optional tsconfig path (e.g. 'packages/agent-core/tsconfig.json'). */
  project?: string
}

export interface TypecheckRunDeps {
  repoRoot: string
  runCommand?: (
    cmd: string,
    args: string[],
    cwd: string,
  ) => Promise<{ exitCode: number; stdout: string; stderr: string }>
}

function parseInput(raw: unknown): TypecheckRunInput {
  if (raw !== null && raw !== undefined && typeof raw !== 'object') {
    throw new Error('typecheck.run: input must be an object or omitted')
  }
  const r = (raw ?? {}) as Record<string, unknown>
  if (r.project !== undefined && typeof r.project !== 'string') {
    throw new Error('typecheck.run: project must be a string')
  }
  return { project: r.project as string | undefined }
}

async function run(input: TypecheckRunInput, deps: TypecheckRunDeps): Promise<ToolResult> {
  const args = ['tsc', '--noEmit']
  if (input.project) args.push('-p', input.project)
  try {
    const runFn = deps.runCommand ?? defaultRunCommand
    const result = await runFn('npx', args, deps.repoRoot)
    return {
      kind: 'ok',
      data: {
        exitCode: result.exitCode,
        passed: result.exitCode === 0,
        stdoutTail: result.stdout.slice(-8000),
        stderrTail: result.stderr.slice(-2000),
      },
    }
  } catch (err) {
    return { kind: 'error', message: (err as Error).message, code: 'spawn_failed' }
  }
}

export const typecheckRunTool: ToolDef<TypecheckRunInput, TypecheckRunDeps> = {
  name: 'typecheck.run',
  tier: 2,
  description: 'Run tsc --noEmit against the repo or a specific tsconfig.',
  parseInput,
  run,
}
