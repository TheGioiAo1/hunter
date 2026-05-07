import { computePixelDiff } from '../verify/pixel-diff.js'
import { scanReachability } from '../verify/reachability.js'
import { checkCardinality } from '../verify/cardinality.js'
import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db'

export interface Stage9Input {
  db: Kysely<Database>
  shopId: string
  jobId: string
  sourceHomepageScreenshot: Buffer
  clonedHomepageScreenshot: Buffer
  clonedHomepageHtml: string
  sourceUrlCounts: { products: number; collections: number; pages: number; blogPosts: number }
}

export interface Stage9Result {
  pixelDiffPct: number
  cardinality: { ok: boolean; overallPct: number; productsPct: number }
  reachability: { totalAssets: number; ok: number; notFound: number }
}

export async function runStage9(input: Stage9Input): Promise<Stage9Result> {
  const pixel = await computePixelDiff(input.sourceHomepageScreenshot, input.clonedHomepageScreenshot)
  const cardinality = await checkCardinality({ db: input.db, shopId: input.shopId, sourceUrlCounts: input.sourceUrlCounts })
  const reachability = await scanReachability({ htmlBody: input.clonedHomepageHtml, concurrency: 10 })
  return {
    pixelDiffPct: pixel.diffPct,
    cardinality: { ok: cardinality.ok, overallPct: cardinality.overallPct, productsPct: cardinality.productsPct },
    reachability: { totalAssets: reachability.totalAssets, ok: reachability.ok, notFound: reachability.notFound },
  }
}
