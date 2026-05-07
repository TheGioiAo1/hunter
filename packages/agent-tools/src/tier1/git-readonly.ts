/**
 * git.status / git.diff / git.log — read-only git operations.
 *
 * Tier 1. Uses simple-git, which shells out to the system git binary.
 * We expose three tool slots (status/diff/log) via separate ToolDef
 * objects so each has a narrow input schema.
 */

import type { DefaultLogFields, SimpleGit } from 'simple-git'
import type { ToolDef, ToolResult } from '../types.ts'

export interface GitReadonlyDeps {
  git: Pick<SimpleGit, 'status' | 'diff' | 'log'>
}

// ---------------------------------------------------------------------------
// git.status
// ---------------------------------------------------------------------------

export const gitStatusTool: ToolDef<Record<string, never>, GitReadonlyDeps> = {
  name: 'git.status',
  tier: 1,
  description: 'Show the working tree status (staged, modified, untracked).',
  parseInput(raw) {
    if (raw && typeof raw === 'object' && Object.keys(raw).length > 0) {
      throw new Error('git.status: takes no arguments')
    }
    return {}
  },
  async run(_input, deps): Promise<ToolResult> {
    try {
      const status = await deps.git.status()
      return {
        kind: 'ok',
        data: {
          branch: status.current,
          ahead: status.ahead,
          behind: status.behind,
          staged: status.staged,
          modified: status.modified,
          not_added: status.not_added,
          deleted: status.deleted,
          conflicted: status.conflicted,
        },
      }
    } catch (err) {
      return { kind: 'error', message: (err as Error).message, code: 'git_failed' }
    }
  },
}

// ---------------------------------------------------------------------------
// git.diff
// ---------------------------------------------------------------------------

export interface GitDiffInput {
  pathspec?: string
  cached?: boolean
}

export const gitDiffTool: ToolDef<GitDiffInput, GitReadonlyDeps> = {
  name: 'git.diff',
  tier: 1,
  description: 'Show unified diff for unstaged (or staged with cached=true) changes.',
  parseInput(raw) {
    if (raw !== null && raw !== undefined && typeof raw !== 'object') {
      throw new Error('git.diff: input must be an object or omitted')
    }
    const r = (raw ?? {}) as Record<string, unknown>
    const out: GitDiffInput = {}
    if (r.pathspec !== undefined) {
      if (typeof r.pathspec !== 'string') throw new Error('git.diff: pathspec must be a string')
      out.pathspec = r.pathspec
    }
    if (r.cached !== undefined) {
      if (typeof r.cached !== 'boolean') throw new Error('git.diff: cached must be a boolean')
      out.cached = r.cached
    }
    return out
  },
  async run(input, deps) {
    try {
      const args: string[] = []
      if (input.cached) args.push('--cached')
      if (input.pathspec) args.push('--', input.pathspec)
      const diff = await deps.git.diff(args)
      return { kind: 'ok', data: { diff } }
    } catch (err) {
      return { kind: 'error', message: (err as Error).message, code: 'git_failed' }
    }
  },
}

// ---------------------------------------------------------------------------
// git.log
// ---------------------------------------------------------------------------

export interface GitLogInput {
  limit?: number
  pathspec?: string
}

export const gitLogTool: ToolDef<GitLogInput, GitReadonlyDeps> = {
  name: 'git.log',
  tier: 1,
  description: 'Show recent commits. Optional limit + pathspec filter.',
  parseInput(raw) {
    if (raw !== null && raw !== undefined && typeof raw !== 'object') {
      throw new Error('git.log: input must be an object or omitted')
    }
    const r = (raw ?? {}) as Record<string, unknown>
    const out: GitLogInput = {}
    if (r.limit !== undefined) {
      if (typeof r.limit !== 'number' || r.limit < 1) {
        throw new Error('git.log: limit must be a positive integer')
      }
      out.limit = r.limit
    }
    if (r.pathspec !== undefined) {
      if (typeof r.pathspec !== 'string') throw new Error('git.log: pathspec must be a string')
      out.pathspec = r.pathspec
    }
    return out
  },
  async run(input, deps) {
    try {
      const opts: { maxCount?: number; file?: string } = {}
      if (input.limit) opts.maxCount = input.limit
      if (input.pathspec) opts.file = input.pathspec
      const log = await deps.git.log<DefaultLogFields>(opts)
      return {
        kind: 'ok',
        data: {
          total: log.total,
          commits: log.all.map((c) => ({
            hash: c.hash,
            date: c.date,
            author_name: c.author_name,
            message: c.message,
          })),
        },
      }
    } catch (err) {
      return { kind: 'error', message: (err as Error).message, code: 'git_failed' }
    }
  },
}
