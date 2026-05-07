/**
 * git.commit / git.push — the two git mutation tools.
 *
 * Tier 3. Approval happens at the guard layer; we simply drive
 * simple-git through the injected SimpleGit instance.
 *
 * git.push intentionally REFUSES pushing to `main` unless
 * `force: false` AND the guard chain has double-confirmed (the
 * approval-gate's `doubleConfirm` flag fires for git.push on main,
 * so by the time we're running the human has clicked "approve" twice).
 */

import type { SimpleGit } from 'simple-git'
import type { ToolDef, ToolResult } from '../types.ts'

// ---------------------------------------------------------------------------
// git.commit
// ---------------------------------------------------------------------------

export interface GitCommitInput {
  message: string
  /** Specific files to stage; omit to use already-staged changes. */
  files?: string[]
}

export interface GitMutationDeps {
  git: Pick<SimpleGit, 'add' | 'commit' | 'push'>
}

export const gitCommitTool: ToolDef<GitCommitInput, GitMutationDeps> = {
  name: 'git.commit',
  tier: 3,
  description: 'Create a git commit with the given message. Optionally stages the listed files first.',
  parseInput(raw) {
    if (!raw || typeof raw !== 'object') throw new Error('git.commit: input must be an object')
    const r = raw as Record<string, unknown>
    if (typeof r.message !== 'string' || r.message.length === 0) {
      throw new Error('git.commit: message must be a non-empty string')
    }
    const out: GitCommitInput = { message: r.message }
    if (r.files !== undefined) {
      if (!Array.isArray(r.files)) throw new Error('git.commit: files must be an array')
      out.files = r.files.map((f) => {
        if (typeof f !== 'string') throw new Error('git.commit: files must be strings')
        return f
      })
    }
    return out
  },
  async run(input, deps): Promise<ToolResult> {
    try {
      if (input.files && input.files.length > 0) {
        await deps.git.add(input.files)
      }
      const result = await deps.git.commit(input.message)
      return {
        kind: 'ok',
        data: {
          commit: result.commit,
          summary: {
            changes: result.summary.changes,
            insertions: result.summary.insertions,
            deletions: result.summary.deletions,
          },
          branch: result.branch,
        },
      }
    } catch (err) {
      return { kind: 'error', message: (err as Error).message, code: 'commit_failed' }
    }
  },
}

// ---------------------------------------------------------------------------
// git.push
// ---------------------------------------------------------------------------

export interface GitPushInput {
  remote: string
  branch: string
  /** Defaults to false. Pushing force is never auto-allowed. */
  force?: boolean
}

export const gitPushTool: ToolDef<GitPushInput, GitMutationDeps> = {
  name: 'git.push',
  tier: 3,
  description: 'Push a branch to a remote. Main branch requires double-confirm (enforced at approval gate).',
  parseInput(raw) {
    if (!raw || typeof raw !== 'object') throw new Error('git.push: input must be an object')
    const r = raw as Record<string, unknown>
    if (typeof r.remote !== 'string' || r.remote.length === 0) {
      throw new Error('git.push: remote must be a non-empty string')
    }
    if (typeof r.branch !== 'string' || r.branch.length === 0) {
      throw new Error('git.push: branch must be a non-empty string')
    }
    const force = r.force === true
    if (force) {
      throw new Error('git.push: force push is never auto-allowed by this tool. Use the CLI if required.')
    }
    return { remote: r.remote, branch: r.branch, force: false }
  },
  async run(input, deps): Promise<ToolResult> {
    try {
      const result = await deps.git.push(input.remote, input.branch)
      return {
        kind: 'ok',
        data: {
          remote: input.remote,
          branch: input.branch,
          pushed: result.pushed?.map((p) => ({
            local: p.local,
            remote: p.remote,
            alreadyUpdated: p.alreadyUpdated,
          })),
        },
      }
    } catch (err) {
      return { kind: 'error', message: (err as Error).message, code: 'push_failed' }
    }
  },
}
