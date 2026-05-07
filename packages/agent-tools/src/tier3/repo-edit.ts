/**
 * repo.edit — Edit-style text-replacement in a single file.
 *
 * Tier 3. By the time we get here the guard chain has already
 * approved (or denied) the call via the approval-gate. We perform
 * an exact-string replace, matching the Edit tool's semantics:
 *   - old_string must exist exactly once (or replace_all must be true)
 *   - new_string replaces it
 *   - file must exist and be within repoRoot
 */

import { readFile, writeFile, stat } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import type { ToolDef, ToolResult } from '../types.ts'

export interface RepoEditInput {
  path: string
  oldString: string
  newString: string
  replaceAll?: boolean
}

export interface RepoEditDeps {
  repoRoot: string
  fsReadFile?: (p: string, enc: 'utf-8') => Promise<string>
  fsWriteFile?: (p: string, data: string, enc: 'utf-8') => Promise<void>
  fsStat?: typeof stat
}

function parseInput(raw: unknown): RepoEditInput {
  if (!raw || typeof raw !== 'object') throw new Error('repo.edit: input must be an object')
  const r = raw as Record<string, unknown>
  if (typeof r.path !== 'string' || r.path.length === 0) {
    throw new Error('repo.edit: path must be a non-empty string')
  }
  if (typeof r.oldString !== 'string') throw new Error('repo.edit: oldString must be a string')
  if (typeof r.newString !== 'string') throw new Error('repo.edit: newString must be a string')
  if (r.oldString === r.newString) {
    throw new Error('repo.edit: oldString and newString must differ')
  }
  return {
    path: r.path,
    oldString: r.oldString,
    newString: r.newString,
    replaceAll: r.replaceAll === true,
  }
}

async function run(input: RepoEditInput, deps: RepoEditDeps): Promise<ToolResult> {
  const readFileFn = deps.fsReadFile ?? ((p, e) => readFile(p, e))
  const writeFileFn = deps.fsWriteFile ?? ((p, d, e) => writeFile(p, d, e))
  const statFn = deps.fsStat ?? stat

  const absPath = isAbsolute(input.path) ? input.path : resolve(join(deps.repoRoot, input.path))

  try {
    const st = await statFn(absPath)
    if (!st.isFile()) {
      return { kind: 'error', message: `not a regular file: ${input.path}`, code: 'not_a_file' }
    }

    const original = await readFileFn(absPath, 'utf-8')

    if (!input.replaceAll) {
      // Require exactly one occurrence — matches Edit tool semantics.
      const first = original.indexOf(input.oldString)
      if (first === -1) {
        return {
          kind: 'error',
          message: `repo.edit: oldString not found in ${input.path}`,
          code: 'not_found',
        }
      }
      const second = original.indexOf(input.oldString, first + 1)
      if (second !== -1) {
        return {
          kind: 'error',
          message: `repo.edit: oldString matches multiple locations in ${input.path}; pass replaceAll=true to replace all`,
          code: 'ambiguous',
        }
      }
      const updated =
        original.slice(0, first) + input.newString + original.slice(first + input.oldString.length)
      await writeFileFn(absPath, updated, 'utf-8')
      return { kind: 'ok', data: { path: input.path, replacements: 1 } }
    }

    // replaceAll path
    const parts = original.split(input.oldString)
    if (parts.length === 1) {
      return {
        kind: 'error',
        message: `repo.edit: oldString not found in ${input.path}`,
        code: 'not_found',
      }
    }
    const updated = parts.join(input.newString)
    await writeFileFn(absPath, updated, 'utf-8')
    return { kind: 'ok', data: { path: input.path, replacements: parts.length - 1 } }
  } catch (err) {
    return { kind: 'error', message: (err as Error).message, code: 'edit_failed' }
  }
}

export const repoEditTool: ToolDef<RepoEditInput, RepoEditDeps> = {
  name: 'repo.edit',
  tier: 3,
  description: 'Exact string replacement in one file. Single match unless replaceAll=true.',
  parseInput,
  run,
}
