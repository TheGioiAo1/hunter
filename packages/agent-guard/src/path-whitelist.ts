/**
 * Layer 1 — Path whitelist.
 *
 * Only tool calls that operate on a specific file path are inspected.
 * For those, we resolve the path to absolute form, follow symlinks,
 * then confirm the resolved path lives inside `ctx.repoRoot` or one
 * of `ctx.crossRepoRoots`, and does not match any deny pattern.
 *
 * Deny patterns take precedence over allow. Tool calls without a
 * `path` field are pass-through — the command-parser / blocklist
 * layers handle `bash.run`.
 */

import { realpathSync } from 'node:fs'
import { isAbsolute, resolve, sep } from 'node:path'
import type { GuardLayer, GuardResult, SessionContext, ToolCall } from './types.ts'

const NAME = 'path-whitelist'

/** Glob-ish patterns expressed as relative-path suffixes. Matched after
 *  normalising both sides to forward slashes. */
const DENY_SUBPATHS = [
  '/node_modules/',
  '/.git/objects/',
  '/.git/hooks/',
  '/dist/',
  '/build/',
  '/.superpowers/',
]

/** Basename patterns — matched against the final path segment. */
const DENY_BASENAME_PREFIXES = ['.env']

interface PathInput {
  path?: unknown
}

function extractPath(input: unknown): string | undefined | { invalid: string } {
  if (input == null || typeof input !== 'object') return undefined
  if (!('path' in input)) return undefined
  const p = (input as PathInput).path
  if (p === undefined) return undefined
  if (typeof p !== 'string') return { invalid: 'path must be a string' }
  if (p.length === 0) return { invalid: 'path must not be empty' }
  return p
}

function toForwardSlash(p: string): string {
  return p.split(sep).join('/')
}

function isInsideRoot(absPath: string, root: string): boolean {
  // Normalise both to trailing-separator form so /a/b is not considered
  // inside /a/bc.
  const a = toForwardSlash(resolve(absPath))
  const r = toForwardSlash(resolve(root))
  const rWithSep = r.endsWith('/') ? r : r + '/'
  return a === r || a.startsWith(rWithSep)
}

function matchesDeny(absPath: string): string | null {
  const fwd = toForwardSlash(absPath)
  for (const sub of DENY_SUBPATHS) {
    if (fwd.includes(sub)) return sub
  }
  const basename = fwd.split('/').pop() ?? ''
  for (const prefix of DENY_BASENAME_PREFIXES) {
    if (basename.startsWith(prefix)) return `basename:${prefix}*`
  }
  return null
}

export const pathWhitelist: GuardLayer = {
  name: NAME,
  async check(call: ToolCall, ctx: SessionContext): Promise<GuardResult> {
    const extracted = extractPath(call.input)
    if (extracted === undefined) {
      // Tool does not take a path — pass through.
      return { allowed: true }
    }
    if (typeof extracted === 'object') {
      return { allowed: false, layer: NAME, reason: extracted.invalid }
    }

    // 1. Resolve to absolute, relative to repoRoot for relative inputs.
    const abs = isAbsolute(extracted) ? resolve(extracted) : resolve(ctx.repoRoot, extracted)

    // 2. Follow symlinks. If target does not exist, realpathSync throws;
    //    fall back to the un-resolved form (new-file writes are normal).
    let resolved = abs
    try {
      resolved = realpathSync(abs)
    } catch {
      // File doesn't exist yet — treat the declared absolute path as
      // canonical for the containment check.
    }

    // 3. Containment: must live inside ONE allowed root.
    const allowedRoots = [ctx.repoRoot, ...ctx.crossRepoRoots]
    const insideSome = allowedRoots.some((root) => isInsideRoot(resolved, root))
    if (!insideSome) {
      return {
        allowed: false,
        layer: NAME,
        reason: `resolved path ${resolved} is outside allowed roots (possible symlink escape or traversal)`,
      }
    }

    // 4. Deny list (evaluated on resolved form so symlinks can't sneak).
    const denyHit = matchesDeny(resolved)
    if (denyHit) {
      return {
        allowed: false,
        layer: NAME,
        reason: `matches deny pattern ${denyHit}`,
      }
    }

    return { allowed: true }
  },
}
