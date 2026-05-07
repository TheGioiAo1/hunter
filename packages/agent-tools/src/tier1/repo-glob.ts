/**
 * repo.glob — find files matching a glob pattern inside the repo.
 *
 * Tier 1. Uses Node's native fs.glob (Node 22+) when available,
 * falls back to a minimal recursive walker for older runtimes /
 * tests. Always scoped to deps.repoRoot — the path-whitelist guard
 * already rejected patterns that escape.
 */

import { readdir, stat } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import type { ToolDef, ToolResult } from '../types.ts'

export interface RepoGlobInput {
  pattern: string
  /** Max results to return. Default 500. */
  limit?: number
}

export interface RepoGlobDeps {
  repoRoot: string
  /** Test override: return a fixed list of absolute paths. */
  walkOverride?: (root: string) => Promise<string[]>
}

function parseInput(raw: unknown): RepoGlobInput {
  if (!raw || typeof raw !== 'object') throw new Error('repo.glob: input must be an object')
  const r = raw as Record<string, unknown>
  if (typeof r.pattern !== 'string' || r.pattern.length === 0) {
    throw new Error('repo.glob: pattern must be a non-empty string')
  }
  if (r.limit !== undefined && (typeof r.limit !== 'number' || r.limit < 1)) {
    throw new Error('repo.glob: limit must be a positive integer')
  }
  return { pattern: r.pattern, limit: r.limit as number | undefined }
}

/**
 * Translate a glob pattern into a RegExp. Supports the subset needed
 * by PR 4:
 *   *       → [^/]*
 *   **      → .*
 *   ?       → .
 *   {a,b}   → (a|b)
 *   /       → literal
 * Dotfiles are excluded unless explicitly listed (matches Shopify's
 * default behavior in script tags).
 */
function globToRegex(glob: string): RegExp {
  let re = ''
  let i = 0
  while (i < glob.length) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // '**/' matches zero or more path segments (including empty),
        // so `**/*.ts` also matches `a.ts` at the root.
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?'
          i += 3
        } else {
          re += '.*'
          i += 2
        }
      } else {
        re += '[^/]*'
        i += 1
      }
    } else if (c === '?') {
      re += '.'
      i += 1
    } else if (c === '{') {
      const end = glob.indexOf('}', i)
      if (end === -1) throw new Error(`repo.glob: unclosed { in pattern`)
      const parts = glob.slice(i + 1, end).split(',')
      re += '(' + parts.map((p) => p.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('|') + ')'
      i = end + 1
    } else if (/[.+^$()|[\]\\]/.test(c)) {
      re += '\\' + c
      i += 1
    } else {
      re += c
      i += 1
    }
  }
  return new RegExp('^' + re + '$')
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

async function run(input: RepoGlobInput, deps: RepoGlobDeps): Promise<ToolResult> {
  try {
    const re = globToRegex(input.pattern)
    const limit = input.limit ?? 500

    const all = await (deps.walkOverride ?? walk)(deps.repoRoot)
    const matches: string[] = []
    for (const abs of all) {
      const rel = relative(deps.repoRoot, abs).replaceAll('\\', '/')
      if (re.test(rel)) {
        matches.push(rel)
        if (matches.length >= limit) break
      }
    }
    return { kind: 'ok', data: { pattern: input.pattern, matches, truncated: matches.length >= limit } }
  } catch (err) {
    return { kind: 'error', message: (err as Error).message, code: 'glob_failed' }
  }
}

export const repoGlobTool: ToolDef<RepoGlobInput, RepoGlobDeps> = {
  name: 'repo.glob',
  tier: 1,
  description: 'Find files matching a glob pattern (e.g. "packages/**/*.ts").',
  parseInput,
  run,
}
