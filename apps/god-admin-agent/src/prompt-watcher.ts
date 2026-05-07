/**
 * Prompt watcher — reload the system prompt on disk change.
 *
 * The god-admin chat surface shows the current prompt hash. When
 * the on-disk file changes (during PR 8 we will edit it repeatedly)
 * the sidecar should pick up the new text and hash without a
 * restart. We use fs.watch, which is good enough for a single file.
 */

import { watch, type FSWatcher } from 'node:fs'
import { loadPrompt } from '@gbox/agent-core'

export interface PromptState {
  text: string
  hash: string
  loadedAt: Date
}

export interface PromptWatcherOptions {
  filePath: string
  promptName: string
  promptsDir?: string
  onChange: (state: PromptState) => void
}

export interface PromptWatcher {
  start(): Promise<PromptState>
  stop(): void
  current(): PromptState
}

export async function createPromptWatcher(
  opts: PromptWatcherOptions,
): Promise<PromptWatcher> {
  let current: PromptState = await readOnce(opts.promptName, opts.promptsDir)
  let watcher: FSWatcher | null = null
  let debounceTimer: NodeJS.Timeout | null = null

  async function reload(): Promise<void> {
    try {
      const next = await readOnce(opts.promptName, opts.promptsDir)
      if (next.hash !== current.hash) {
        current = next
        opts.onChange(current)
      }
    } catch {
      // ignore transient read errors — next change event will retry
    }
  }

  return {
    async start(): Promise<PromptState> {
      if (watcher) return current
      watcher = watch(opts.filePath, () => {
        if (debounceTimer) clearTimeout(debounceTimer)
        debounceTimer = setTimeout(() => {
          void reload()
        }, 100)
        if (typeof debounceTimer.unref === 'function') debounceTimer.unref()
      })
      return current
    },
    stop(): void {
      if (debounceTimer) {
        clearTimeout(debounceTimer)
        debounceTimer = null
      }
      if (watcher) {
        watcher.close()
        watcher = null
      }
    },
    current(): PromptState {
      return current
    },
  }
}

async function readOnce(
  promptName: string,
  promptsDir: string | undefined,
): Promise<PromptState> {
  const loaded = await loadPrompt({ name: promptName, promptsDir })
  return { text: loaded.content, hash: loaded.rawHash, loadedAt: new Date() }
}
