/**
 * repo.write — Write-style whole-file replacement / creation.
 *
 * Tier 3. Requires approval. Creates parent directories as needed.
 * Caps file size at 2 MB to protect the repo from accidental blobs.
 */

import { writeFile, mkdir } from 'node:fs/promises'
import { isAbsolute, join, resolve, dirname } from 'node:path'
import type { ToolDef, ToolResult } from '../types.ts'

export interface RepoWriteInput {
  path: string
  content: string
}

export interface RepoWriteDeps {
  repoRoot: string
  fsWriteFile?: (p: string, data: string, enc: 'utf-8') => Promise<void>
  fsMkdir?: (p: string, opts: { recursive: true }) => Promise<string | undefined>
}

const MAX_BYTES = 2 * 1024 * 1024

function parseInput(raw: unknown): RepoWriteInput {
  if (!raw || typeof raw !== 'object') throw new Error('repo.write: input must be an object')
  const r = raw as Record<string, unknown>
  if (typeof r.path !== 'string' || r.path.length === 0) {
    throw new Error('repo.write: path must be a non-empty string')
  }
  if (typeof r.content !== 'string') {
    throw new Error('repo.write: content must be a string')
  }
  return { path: r.path, content: r.content }
}

async function run(input: RepoWriteInput, deps: RepoWriteDeps): Promise<ToolResult> {
  if (Buffer.byteLength(input.content, 'utf-8') > MAX_BYTES) {
    return {
      kind: 'error',
      message: `repo.write: content exceeds ${MAX_BYTES} bytes`,
      code: 'too_large',
    }
  }

  const absPath = isAbsolute(input.path) ? input.path : resolve(join(deps.repoRoot, input.path))
  const writeFileFn = deps.fsWriteFile ?? ((p, d, e) => writeFile(p, d, e))
  const mkdirFn = deps.fsMkdir ?? ((p, o) => mkdir(p, o))

  try {
    await mkdirFn(dirname(absPath), { recursive: true })
    await writeFileFn(absPath, input.content, 'utf-8')
    return { kind: 'ok', data: { path: input.path, bytes: Buffer.byteLength(input.content, 'utf-8') } }
  } catch (err) {
    return { kind: 'error', message: (err as Error).message, code: 'write_failed' }
  }
}

export const repoWriteTool: ToolDef<RepoWriteInput, RepoWriteDeps> = {
  name: 'repo.write',
  tier: 3,
  description: 'Create or overwrite a file. Parent directories are created. 2MB cap.',
  parseInput,
  run,
}
