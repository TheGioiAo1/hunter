/**
 * Phase 7 Step 7.1 — `enqueueWebsiteClone` contract smoke.
 * Phase B — `enqueueTranscode` / `enqueueMediaIngest` contract smoke.
 *
 * The POST /clone-pro/start handler needs the BullMQ job id so it can
 * persist `storefront_clone_jobs.bullmq_job_id` (migration 046) in the
 * same request. Before Phase 7 the helper returned `Promise<void>` —
 * callers had no way to stamp the link. This file pins the new return
 * shape so regressions are caught at the source level.
 *
 * Phase B adds two more queues — video transcode (expensive, needs the
 * returned job id so callers can stamp `videos.transcode_job_id`) and
 * media ingest (cheap, fire-and-forget). Pinning both here means a
 * future refactor that drops the return shape fails at unit test time
 * instead of silently at runtime on a production S3 event.
 *
 * Source-level assertion because the actual call requires a live
 * Redis + BullMQ — unavailable on this Windows dev box. The full
 * round-trip runs on server 2 as part of Phase 7 / Phase B smoke.
 */

import { describe, it, expect, beforeAll } from 'vitest'

describe('Phase 7 — queues.ts: enqueueWebsiteClone contract', () => {
  it('enqueueWebsiteClone is declared to return { id: string }', async () => {
    const fs = await import('node:fs/promises')
    const src = await fs.readFile(
      new URL('./queues.ts', import.meta.url),
      'utf8',
    )
    // The signature must include `{ id: string }` as the resolve
    // shape. Before Phase 7 this was Promise<void> — that broke the
    // bullmq_job_id persistence path. Non-greedy `[\s\S]*?` spans
    // newlines + the nested parens inside the param block
    // (`import('./clone-worker.js')`).
    expect(src).toMatch(
      /export\s+async\s+function\s+enqueueWebsiteClone[\s\S]*?\)\s*:\s*Promise<\{\s*id:\s*string\s*\}>/,
    )
  })

  it('enqueueWebsiteClone returns the Job id from BullMQ', async () => {
    const fs = await import('node:fs/promises')
    const src = await fs.readFile(
      new URL('./queues.ts', import.meta.url),
      'utf8',
    )
    // Must capture the Job reference from .add() and return its id
    // coerced to string (BullMQ typings allow `string | number | undefined`).
    expect(src).toMatch(/const\s+\w+\s*=\s*await\s+websiteCloneQueue\(\)\.add\(/)
    expect(src).toMatch(/return\s*\{\s*id:\s*String\(/)
  })
})

describe('Phase B — queues.ts: transcode + media-ingest contracts', () => {
  // Keep a single file-read cached across tests in this block. Node's
  // cache usually makes this cheap, but spelling it out removes any
  // coupling between tests.
  let src: string
  beforeAll(async () => {
    const fs = await import('node:fs/promises')
    src = await fs.readFile(new URL('./queues.ts', import.meta.url), 'utf8')
  })

  // -------------------------------------------------------------------------
  // TranscodeJob payload shape
  // -------------------------------------------------------------------------

  it('TranscodeJob declares shopId, videoId, srcKey, bucket', () => {
    // Non-greedy `[\s\S]*?` so the match stops at the first closing brace
    // after the field block — not the end of the file.
    const match = src.match(
      /export\s+interface\s+TranscodeJob\s*\{([\s\S]*?)\n\}/,
    )
    expect(match).not.toBeNull()
    const body = match![1]
    expect(body).toMatch(/shopId:\s*string/)
    expect(body).toMatch(/videoId:\s*string/)
    expect(body).toMatch(/srcKey:\s*string/)
    expect(body).toMatch(/bucket:\s*string/)
    // ladder is optional (ships with a default in the worker).
    expect(body).toMatch(/ladder\?:/)
  })

  // -------------------------------------------------------------------------
  // enqueueTranscode — must return { id } because callers stamp
  // videos.transcode_job_id for dashboard visibility.
  // -------------------------------------------------------------------------

  it('enqueueTranscode is declared to return { id: string }', () => {
    expect(src).toMatch(
      /export\s+async\s+function\s+enqueueTranscode[\s\S]*?\)\s*:\s*Promise<\{\s*id:\s*string\s*\}>/,
    )
  })

  it('enqueueTranscode uses idempotent jobId scoped to shop+video', () => {
    // Locks the jobId format so S3 event duplicates collapse to one
    // ffmpeg run — renaming the key silently breaks idempotency.
    expect(src).toMatch(
      /jobId:\s*`video:\$\{data\.shopId\}:\$\{data\.videoId\}`/,
    )
  })

  it('enqueueTranscode overrides retry policy (2 attempts, fixed 5min backoff)', () => {
    // Transcode is expensive — default 5-attempt exponential backoff
    // would burn GPU time. If someone drops these overrides, cost
    // regression won't be visible until the bill arrives.
    const block = src.match(
      /export\s+async\s+function\s+enqueueTranscode[\s\S]*?^\}/m,
    )
    expect(block).not.toBeNull()
    expect(block![0]).toMatch(/attempts:\s*2\b/)
    expect(block![0]).toMatch(/type:\s*'fixed'/)
    expect(block![0]).toMatch(/delay:\s*300_?000\b/)
  })

  // -------------------------------------------------------------------------
  // MediaIngestJob payload shape
  // -------------------------------------------------------------------------

  it('MediaIngestJob declares shopId, assetId, srcKey, bucket', () => {
    const match = src.match(
      /export\s+interface\s+MediaIngestJob\s*\{([\s\S]*?)\n\}/,
    )
    expect(match).not.toBeNull()
    const body = match![1]
    expect(body).toMatch(/shopId:\s*string/)
    expect(body).toMatch(/assetId:\s*string/)
    expect(body).toMatch(/srcKey:\s*string/)
    expect(body).toMatch(/bucket:\s*string/)
    expect(body).toMatch(/contentType\?:/)
  })

  // -------------------------------------------------------------------------
  // enqueueMediaIngest — fire-and-forget, but jobId must still pin for
  // dedup on S3 duplicate events.
  // -------------------------------------------------------------------------

  it('enqueueMediaIngest returns Promise<void> (fire-and-forget)', () => {
    expect(src).toMatch(
      /export\s+async\s+function\s+enqueueMediaIngest[\s\S]*?\)\s*:\s*Promise<void>/,
    )
  })

  it('enqueueMediaIngest uses idempotent jobId scoped to shop+asset', () => {
    expect(src).toMatch(
      /jobId:\s*`ingest:\$\{data\.shopId\}:\$\{data\.assetId\}`/,
    )
  })
})
