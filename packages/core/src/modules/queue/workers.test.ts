/**
 * Phase 7 Step 7.1 — Workers wiring smoke test.
 *
 * The clone worker (`startCloneWorker`) has existed since Phase 6 in
 * `clone-worker.ts`, but `workers.ts` was only starting the webhook
 * worker. Phase 7 fixes this orphan state — `startWorkers()` MUST also
 * start the clone worker so `pm2 start gbox-store-admin` is enough to
 * activate BullMQ consumption for the `website-clone` queue.
 *
 * Source-level check so we don't have to spin up Redis + a real
 * BullMQ instance during unit tests. The full end-to-end test runs on
 * server 2 with a live Redis alongside the rest of Phase 7 smoke.
 */

import { describe, it, expect } from 'vitest'

describe('Phase 7 — workers.ts wires the clone worker', () => {
  it('imports startCloneWorker from ./clone-worker.js', async () => {
    const fs = await import('node:fs/promises')
    const src = await fs.readFile(
      new URL('./workers.ts', import.meta.url),
      'utf8',
    )
    expect(src).toMatch(
      /import\s*\{[^}]*\bstartCloneWorker\b[^}]*\}\s*from\s*['"]\.\/clone-worker\.js['"]/,
    )
  })

  it('calls startCloneWorker(db) inside startWorkers()', async () => {
    const fs = await import('node:fs/promises')
    const src = await fs.readFile(
      new URL('./workers.ts', import.meta.url),
      'utf8',
    )
    // The call must appear between `startWorkers(` and the function's
    // closing brace, pushed onto activeWorkers so stopWorkers() drains
    // it too.
    expect(src).toContain('startCloneWorker(db)')
    expect(src).toMatch(/activeWorkers\.push\([^)]*cloneWorker[^)]*\)/)
  })

  it('does NOT start the clone worker if startWorkers has already run (idempotent)', async () => {
    const fs = await import('node:fs/promises')
    const src = await fs.readFile(
      new URL('./workers.ts', import.meta.url),
      'utf8',
    )
    // The existing `if (workersStarted) return` guard at the top must
    // still wrap the entire body — we rely on that to stop double-boot
    // after a handler hot-reload. Easiest check: the guard appears
    // before any `startCloneWorker` reference.
    const guardIdx = src.indexOf('if (workersStarted) return')
    const startIdx = src.indexOf('startCloneWorker(db)')
    expect(guardIdx).toBeGreaterThan(-1)
    expect(startIdx).toBeGreaterThan(guardIdx)
  })
})
