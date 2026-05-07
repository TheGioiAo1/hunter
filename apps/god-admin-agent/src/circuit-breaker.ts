/**
 * Circuit breaker — rolling error window.
 *
 * When `errorThreshold` errors happen within `windowMs`, the breaker
 * trips to 'open'. Callers must check `isOpen()` before dispatching
 * a chat turn. A single manual `close()` resets the state (used by
 * the UI's "acknowledged" button and by prompt hot-reload).
 */

export interface CircuitBreakerOptions {
  windowMs: number
  errorThreshold: number
  now?: () => number
}

export interface CircuitBreaker {
  isOpen(): boolean
  recordError(): void
  recordSuccess(): void
  close(): void
  snapshot(): { open: boolean; errorsInWindow: number; threshold: number }
}

export function createCircuitBreaker(opts: CircuitBreakerOptions): CircuitBreaker {
  const now = opts.now ?? (() => Date.now())
  let open = false
  let errors: number[] = [] // timestamps

  function prune(t: number): void {
    const cutoff = t - opts.windowMs
    // Errors are appended chronologically; drop everything older than cutoff.
    let i = 0
    while (i < errors.length && errors[i]! < cutoff) i++
    if (i > 0) errors = errors.slice(i)
  }

  return {
    isOpen(): boolean {
      prune(now())
      return open
    },
    recordError(): void {
      const t = now()
      errors.push(t)
      prune(t)
      if (errors.length >= opts.errorThreshold) {
        open = true
      }
    },
    recordSuccess(): void {
      // Successes do not auto-close a tripped breaker — operator must
      // acknowledge. But we DO prune the error window so a single
      // streak of successes keeps the counter cool.
      prune(now())
    },
    close(): void {
      open = false
      errors = []
    },
    snapshot() {
      prune(now())
      return { open, errorsInWindow: errors.length, threshold: opts.errorThreshold }
    },
  }
}
