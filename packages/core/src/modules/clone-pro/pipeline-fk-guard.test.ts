/**
 * Regression — clone-pro pipeline FK-guard for products.clone_job_id.
 *
 * 2026-04-25 production incident: the import_data stage of the clone
 * pipeline failed every run with
 *
 *   insert or update on table "products" violates foreign key
 *   constraint "fk_products_clone_job_id"
 *
 * because the persist call passed `cloneJobId: crypto.randomUUID()`
 * — a freshly-minted UUID that, by definition, does not exist in
 * `storefront_clone_jobs.id`. The FK fired immediately on the first
 * row insert.
 *
 * The fix routes `config.jobId ?? null` through to the persist layer,
 * matching how `persistClonePages`, `persistCloneBlogPosts`,
 * `persistCloneCollections`, and `persistCloneMenus` already worked.
 *
 * This test is a SOURCE-LEVEL guard. We don't spin a fake DB / fake
 * persist function — we just refuse to ship a pipeline that ever
 * shapes a fresh UUID into the products call. Future contributors
 * who reintroduce the same pattern will see this fail.
 *
 * Companion regression: persist-products.test.ts already exercises
 * the type-level acceptance of `cloneJobId: null`.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const PIPELINE_PATH = join(HERE, 'pipeline.ts')
const PIPELINE_SRC = readFileSync(PIPELINE_PATH, 'utf8')

describe('clone-pro pipeline — products.clone_job_id FK guard (2026-04-25 regression)', () => {
  it('does NOT generate a fresh UUID for cloneJobId in the persistCloneProducts call', () => {
    // The exact pre-fix shape that broke production. If this string
    // ever creeps back into pipeline.ts, the FK breaks again.
    expect(PIPELINE_SRC).not.toMatch(/cloneJobId:\s*crypto\.randomUUID\(\)/)
    expect(PIPELINE_SRC).not.toMatch(/cloneJobId:\s*randomUUID\(\)/)
  })

  it('routes config.jobId (or null) into persistCloneProducts', () => {
    // Lock in the fix: the products persist call must receive the
    // pipeline's job id (or null for tests / non-job imports), never
    // a freshly-generated id.
    const products = PIPELINE_SRC.match(
      /persistCloneProducts\(db,\s*\{[\s\S]+?\}\)/,
    )
    expect(products).not.toBeNull()
    expect(products![0]).toMatch(/cloneJobId:\s*config\.jobId\s*\?\?\s*null/)
  })

  it('uses the same config.jobId pattern across all persist callers (consistency check)', () => {
    // Defense in depth: every persist-X call in the import_data
    // stage threads `config.jobId ?? null`. Catches future copy-paste
    // drift where someone "helpfully" generates a UUID for one
    // resource type but not the others.
    const persistCalls = [
      'persistCloneProducts',
      'persistClonePages',
      'persistCloneBlogPosts',
      'persistCloneMenus',
      'persistCloneCollections',
    ]
    for (const fn of persistCalls) {
      const calls = PIPELINE_SRC.match(new RegExp(`${fn}\\([\\s\\S]+?\\)`))
      if (!calls) continue // some only fire conditionally; skip if not present
      // Accept either a positional `config.jobId ?? null` arg (used by
      // the page/blog/menu/collection persisters) OR a named
      // `cloneJobId: config.jobId ?? null` field (products persister).
      const hasConfigJobId =
        /config\.jobId\s*\?\?\s*null/.test(calls[0]) ||
        /cloneJobId:\s*config\.jobId\s*\?\?\s*null/.test(calls[0])
      expect(hasConfigJobId, `${fn} must thread config.jobId ?? null`).toBe(
        true,
      )
    }
  })
})
