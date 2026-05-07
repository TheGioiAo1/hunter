/**
 * repo.grep — search file contents for a regex inside the repo.
 *
 * Tier 1. Reads each candidate file (filtered by optional glob) and
 * runs the regex line-by-line. Capped at MAX_MATCHES and
 * MAX_FILE_BYTES to protect context size.
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import type { ToolDef, ToolResult } from '../types.ts'

export interface RepoGrepInput {
  pattern: string
  /** Optional glob pre-filter. Default: all files. */
  fileGlob?: string
  /** Max total matches to return. Default 100. */
  limit?: number
  /** Case insensitive. Default false. */
  ignoreCase?: boolean
}

export interface RepoGrepDeps {
  repoRoot: string
  walkOverride?: (root: string) => Promise<string[]>
  readFileOverride?: (path: string) => Promise<string>
}

const MAX_FILE_BYTES = 1 * 1024 * 1024 // 1 MB per file

function parseInput(raw: unknown): RepoGrepInput {
  if (!raw || typeof raw !== 'object') throw new Error('repo.grep: input must be an object')
  const r = raw as Record<string, unknown>
  if (typeof r.pattern !== 'string' || r.pattern.length === 0) {
    throw new Error('repo.grep: pattern must be a non-empty string')
  }
  return {
    pattern: r.pattern,
    fileGlob: typeof r.fileGlob === 'string' ? r.fileGlob : undefined,
    limit: typeof r.limit === 'number' ? r.limit : undefined,
    ignoreCase: r.ignoreCase === true,
  }
}

async function walk(root: string): Promise<string[]> {
  const out: string[] = []
  async function visit(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git') continue
      const full = join(dir, e.name)
      if (e.isDirectory()) await visit(full)
      else if (e.isFile()) out.push(full)
    }
  }
  await visit(root)
  return out
}

async function run(input: RepoGrepInput, deps: RepoGrepDeps): Promise<ToolResult> {
  try {
    let re: RegExp
    try {
      re = new RegExp(input.pattern, input.ignoreCase ? 'i' : '')
    } catch (err) {
      return { kind: 'error', message: `invalid regex: ${(err as Error).message}`, code: 'bad_regex' }
    }

    const limit = input.limit ?? 100
    const files = await (deps.walkOverride ?? walk)(deps.repoRoot)
    const readFn = deps.readFileOverride ?? ((p) => readFile(p, 'utf-8'))

    const matches: Array<{ path: string; line: number; text: string }> = []
    for (const abs of files) {
      try {
        const st = await stat(abs)
        if (st.size > MAX_FILE_BYTES) continue
        const content = await readFn(abs)
        const lines = content.split('\n')
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i])) {
            matches.push({
              path: relative(deps.repoRoot, abs).replaceAll('\\', '/'),
              line: i + 1,
              text: lines[i],
            })
            if (matches.length >= limit) break
          }
        }
        if (matches.length >= limit) break
      } catch {
        // Skip unreadable files silently — grep should be resilient.
      }
    }

    return {
      kind: 'ok',
      data: {
        pattern: input.pattern,
        matches,
        truncated: matches.length >= limit,
      },
    }
  } catch (err) {
    return { kind: 'error', message: (err as Error).message, code: 'grep_failed' }
  }
}

export const repoGrepTool: ToolDef<RepoGrepInput, RepoGrepDeps> = {
  name: 'repo.grep',
  tier: 1,
  description: 'Regex search file contents across the repo.',
  parseInput,
  run,
}
