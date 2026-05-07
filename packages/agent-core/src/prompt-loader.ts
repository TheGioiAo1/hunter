/**
 * Prompt loader + hot-reload.
 *
 * Reads `packages/agent-core/prompts/<name>.md` from disk, injects
 * dynamic sections, and returns the composed system prompt string.
 *
 * The sidecar (apps/god-admin-agent) uses `chokidar` to watch the
 * prompts directory; on file change it calls `loadPrompt()` again and
 * swaps the in-memory value. Sessions already in flight keep the old
 * prompt (they only re-read on the NEXT `sendMessage` turn).
 *
 * Dynamic sections supported:
 *   {{CURRENT_PHASE}}      — replaced with opts.currentPhase
 *   {{RECENT_COMMITS}}     — replaced with opts.recentCommits (multi-line)
 *   {{TIMESTAMP}}           — ISO timestamp at load time
 *
 * Security: this function ONLY reads files under the prompts/ dir —
 * callers pass a bare name ('god-admin-default'), not a path. We
 * hard-reject names containing '..' or '/' to prevent escape.
 */

import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Use fileURLToPath so spaces and other URL-encoded characters in the
// repo path are decoded correctly on all platforms. Using `.pathname`
// directly leaves "%20" in Windows paths with spaces, breaking readFile.
const PROMPTS_DIR_DEFAULT = fileURLToPath(new URL('../prompts/', import.meta.url))

export interface LoadPromptOptions {
  /** Bare filename without extension. Must not contain '/' or '..' */
  name: string
  /** Optional dynamic values to interpolate. */
  currentPhase?: string
  recentCommits?: string
  /** Override the base dir (tests point at a tmp dir). */
  promptsDir?: string
}

export interface LoadedPrompt {
  name: string
  content: string
  /** Hash of the raw source file — used as system_prompt_version. */
  rawHash: string
}

function assertSafeName(name: string): void {
  if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) {
    throw new Error(`unsafe prompt name: ${name}`)
  }
}

/**
 * Hash the raw bytes of a prompt file. Stable across platforms
 * (strips CRLF). Used to populate agent_sessions.system_prompt_version.
 */
export function hashPrompt(raw: string): string {
  const normalized = raw.replace(/\r\n/g, '\n')
  return 'sha256:' + createHash('sha256').update(normalized).digest('hex').slice(0, 16)
}

export async function loadPrompt(opts: LoadPromptOptions): Promise<LoadedPrompt> {
  assertSafeName(opts.name)

  const dir = opts.promptsDir ?? PROMPTS_DIR_DEFAULT
  const path = join(dir, `${opts.name}.md`)
  const raw = await readFile(path, 'utf-8')
  const rawHash = hashPrompt(raw)

  let content = raw
  content = content.replaceAll('{{CURRENT_PHASE}}', opts.currentPhase ?? '(unknown)')
  content = content.replaceAll('{{RECENT_COMMITS}}', opts.recentCommits ?? '(none)')
  content = content.replaceAll('{{TIMESTAMP}}', new Date().toISOString())

  return {
    name: opts.name,
    content,
    rawHash,
  }
}
