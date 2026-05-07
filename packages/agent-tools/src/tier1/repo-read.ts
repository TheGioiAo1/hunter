/**
 * repo.read — read a file from the gbox-platform checkout.
 *
 * Tier 1 (read-only). The path-whitelist guard layer has already
 * verified the path is inside the repo root and not in a deny list
 * by the time we get here. We still re-normalize + enforce a max
 * byte cap to protect against the agent asking for a 2GB file.
 */

import { readFile, stat } from 'node:fs/promises'
import { resolve, isAbsolute, join } from 'node:path'
import type { ToolDef, ToolResult } from '../types.ts'

export interface RepoReadInput {
  path: string
  /** Optional 1-based line range (inclusive). */
  fromLine?: number
  toLine?: number
}

export interface RepoReadDeps {
  repoRoot: string
  /** Optional override so tests can swap fs. */
  fsReadFile?: (p: string, enc: 'utf-8') => Promise<string>
  fsStat?: typeof stat
}

const MAX_BYTES = 512 * 1024 // 512 KB

function parseInput(raw: unknown): RepoReadInput {
  if (!raw || typeof raw !== 'object') throw new Error('repo.read: input must be an object')
  const r = raw as Record<string, unknown>
  if (typeof r.path !== 'string' || r.path.length === 0) {
    throw new Error('repo.read: path must be a non-empty string')
  }
  const out: RepoReadInput = { path: r.path }
  if (r.fromLine !== undefined) {
    if (typeof r.fromLine !== 'number' || r.fromLine < 1) {
      throw new Error('repo.read: fromLine must be a positive integer')
    }
    out.fromLine = r.fromLine
  }
  if (r.toLine !== undefined) {
    if (typeof r.toLine !== 'number' || r.toLine < 1) {
      throw new Error('repo.read: toLine must be a positive integer')
    }
    out.toLine = r.toLine
  }
  return out
}

async function run(input: RepoReadInput, deps: RepoReadDeps): Promise<ToolResult> {
  const readFileFn = deps.fsReadFile ?? ((p, e) => readFile(p, e))
  const statFn = deps.fsStat ?? stat

  const absPath = isAbsolute(input.path)
    ? input.path
    : resolve(join(deps.repoRoot, input.path))

  try {
    const st = await statFn(absPath)
    if (!st.isFile()) {
      return { kind: 'error', message: `not a regular file: ${input.path}`, code: 'not_a_file' }
    }
    if (st.size > MAX_BYTES) {
      return {
        kind: 'error',
        message: `file too large (${st.size} bytes > ${MAX_BYTES})`,
        code: 'too_large',
      }
    }

    const raw = await readFileFn(absPath, 'utf-8')
    let content = raw
    if (input.fromLine !== undefined || input.toLine !== undefined) {
      const lines = raw.split('\n')
      const from = (input.fromLine ?? 1) - 1
      const to = input.toLine ?? lines.length
      content = lines.slice(from, to).join('\n')
    }

    return {
      kind: 'ok',
      data: { path: input.path, content, bytes: st.size },
    }
  } catch (err) {
    return {
      kind: 'error',
      message: (err as Error).message,
      code: 'read_failed',
    }
  }
}

export const repoReadTool: ToolDef<RepoReadInput, RepoReadDeps> = {
  name: 'repo.read',
  tier: 1,
  description: 'Read a file from the gbox-platform checkout. Optional line range.',
  parseInput,
  run,
}
