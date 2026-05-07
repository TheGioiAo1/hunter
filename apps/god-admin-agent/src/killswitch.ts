/**
 * Killswitch — a file on disk whose presence means "no new turns,
 * abort anything in flight".
 *
 * The sidecar polls this file every `pollMs`. When it flips from
 * absent → present we trip the circuit breaker AND call `onEngaged`
 * so the caller can abort all in-flight agent runs.
 *
 * Why a file and not a DB flag? The oncall engineer on server 1
 * should be able to stop the agent even if Postgres is down.
 * `touch /srv/gbox/.agent-killswitch` is the last-resort brake.
 */

import { stat } from 'node:fs/promises'

export interface KillswitchOptions {
  filePath: string
  pollMs: number
  onEngaged: (reason: string) => void
  onDisengaged?: () => void
}

export interface Killswitch {
  start(): void
  stop(): void
  isEngaged(): boolean
  /** For tests — force a poll cycle synchronously. */
  pollNow(): Promise<void>
}

export function createKillswitch(opts: KillswitchOptions): Killswitch {
  let engaged = false
  let timer: NodeJS.Timeout | null = null

  async function checkOnce(): Promise<void> {
    let exists = false
    try {
      await stat(opts.filePath)
      exists = true
    } catch {
      exists = false
    }
    if (exists && !engaged) {
      engaged = true
      opts.onEngaged(`killswitch file present: ${opts.filePath}`)
    } else if (!exists && engaged) {
      engaged = false
      opts.onDisengaged?.()
    }
  }

  return {
    start(): void {
      if (timer) return
      // First poll immediately so startup respects an already-present file.
      void checkOnce()
      timer = setInterval(() => {
        void checkOnce()
      }, opts.pollMs)
      // Don't keep the process alive solely for this poller.
      if (typeof timer.unref === 'function') timer.unref()
    },
    stop(): void {
      if (timer) {
        clearInterval(timer)
        timer = null
      }
    },
    isEngaged(): boolean {
      return engaged
    },
    async pollNow(): Promise<void> {
      await checkOnce()
    },
  }
}
