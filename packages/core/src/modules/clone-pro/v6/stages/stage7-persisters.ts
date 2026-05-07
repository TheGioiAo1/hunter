/**
 * Clone Pro v6 — Stage 7: Persister Dispatcher
 *
 * Runs all registered BucketPersisters in sequence and aggregates their
 * results. Each bucket runs independently — a failure in one bucket does not
 * block subsequent buckets (fail-tolerance per L17).
 *
 * Per-bucket failure threshold: if more than `failureThresholdPct`% of DTOs
 * in a bucket produce errors, that bucket name is added to `bucketFailures`.
 * The orchestrator can use this to decide whether to abort or warn.
 *
 * Skips buckets with no DTOs (empty arrays / null themeTokens).
 * Skips buckets not registered in the registry (optional injection for tests).
 */

import type { BucketPersister, PersistResult } from '../persisters/types.js'

export interface PersisterRegistry {
  products?: BucketPersister<any>
  collections?: BucketPersister<any>
  pages?: BucketPersister<any>
  blogPosts?: BucketPersister<any>
  menus?: BucketPersister<any>
  themeTokens?: BucketPersister<any>
  themeFiles?: BucketPersister<any>
  urlRedirects?: BucketPersister<any>
  genericMedia?: BucketPersister<any>
}

export interface RunPersistersInput {
  db: any
  shopId: string
  jobId: string
  dtos: {
    products: any[]
    collections: any[]
    pages: any[]
    blogPosts: any[]
    menus: any[]
    themeTokens: any | null
    themeFiles: any[]
    urlRedirects: any[]
    genericMedia: any[]
  }
  registry: PersisterRegistry
  /** Percentage of errors per bucket that triggers a bucketFailures entry. Default: 5 */
  failureThresholdPct?: number
}

export interface RunPersistersResult {
  products: PersistResult
  collections: PersistResult
  pages: PersistResult
  blogPosts: PersistResult
  menus: PersistResult
  themeTokens: PersistResult
  themeFiles: PersistResult
  urlRedirects: PersistResult
  genericMedia: PersistResult
  /** Names of buckets that exceeded the failure threshold */
  bucketFailures: string[]
}

const EMPTY: PersistResult = { inserted: 0, updated: 0, skippedEdited: 0, errors: [] }

export async function runPersisters(input: RunPersistersInput): Promise<RunPersistersResult> {
  const threshold = input.failureThresholdPct ?? 5

  const out: RunPersistersResult = {
    products: EMPTY,
    collections: EMPTY,
    pages: EMPTY,
    blogPosts: EMPTY,
    menus: EMPTY,
    themeTokens: EMPTY,
    themeFiles: EMPTY,
    urlRedirects: EMPTY,
    genericMedia: EMPTY,
    bucketFailures: [],
  }

  type BucketName = keyof Omit<RunPersistersResult, 'bucketFailures'>

  const buckets: {
    name: BucketName
    dtos: any[]
    persister: BucketPersister<any> | undefined
  }[] = [
    { name: 'products', dtos: input.dtos.products, persister: input.registry.products },
    { name: 'collections', dtos: input.dtos.collections, persister: input.registry.collections },
    { name: 'pages', dtos: input.dtos.pages, persister: input.registry.pages },
    { name: 'blogPosts', dtos: input.dtos.blogPosts, persister: input.registry.blogPosts },
    { name: 'menus', dtos: input.dtos.menus, persister: input.registry.menus },
    {
      name: 'themeTokens',
      dtos: input.dtos.themeTokens != null ? [input.dtos.themeTokens] : [],
      persister: input.registry.themeTokens,
    },
    { name: 'themeFiles', dtos: input.dtos.themeFiles, persister: input.registry.themeFiles },
    { name: 'urlRedirects', dtos: input.dtos.urlRedirects, persister: input.registry.urlRedirects },
    { name: 'genericMedia', dtos: input.dtos.genericMedia, persister: input.registry.genericMedia },
  ]

  for (const b of buckets) {
    if (!b.persister) continue
    if (b.dtos.length === 0) continue

    const r = await b.persister.persist({
      db: input.db,
      shopId: input.shopId,
      jobId: input.jobId,
      dtos: b.dtos,
    })

    out[b.name] = r

    const total = b.dtos.length
    if (total > 0 && (r.errors.length / total) * 100 > threshold) {
      out.bucketFailures.push(b.name)
    }
  }

  return out
}
