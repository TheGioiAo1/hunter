import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'

export type Classification =
  | 'product'
  | 'collection'
  | 'page'
  | 'blog_post'
  | 'policy'
  | '404'
  | 'other'

export interface UrlQueueEntry {
  id: string
  jobId: string
  sourceUrl: string
  classification: Classification | null
  discoveredVia: 'sitemap' | 'sitemap_index' | 'bfs' | 'robots'
  depth: number
  priority: number
  status: 'queued' | 'rendered' | 'scraped' | 'persisted' | 'failed' | 'skipped'
  error: string | null
}

export interface RenderedPage {
  queueId: string
  sourceUrl: string
  html: string
  screenshotSha1: string | null
  assetUrls: string[]
  viewportWidth: number
  viewportHeight: number
}

export interface AssetGraphEntry {
  sourceUrl: string
  contentType: 'image' | 'video' | 'css' | 'js' | 'font' | 'unknown'
  bucket:
    | 'product-image'
    | 'hero'
    | 'logo'
    | 'favicon'
    | 'icon'
    | 'font'
    | 'css'
    | 'js'
    | 'video'
    | 'generic-image'
  referencedFrom: string[]
}

export interface CloneJobConfig {
  jobId: string
  shopId: string
  sourceUrl: string
  scope: {
    products: boolean
    collections: boolean
    pages: boolean
    blog: boolean
    menu: boolean
    theme: boolean
  }
  autoPublish?: boolean
}

export interface StageContext {
  jobId: string
  shopId: string
  sourceUrl: string
  startedAt: string
  emitProgress: (pct: number, stage: string) => Promise<void>
  emitStage: (
    stage: string,
    status: 'running' | 'succeeded' | 'failed',
    detail?: string,
  ) => Promise<void>
}
