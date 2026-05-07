import 'dotenv/config'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool } from 'pg'
import { buildAssetGraph } from '../packages/core/src/modules/clone-pro/v6/stages/stage5-asset-graph.js'
import { downloadAssetsToS3 } from '../packages/core/src/modules/clone-pro/v6/stages/stage6-asset-download.js'
import { buildS3Client, putObjectIfAbsent } from '../packages/core/src/modules/clone-pro/v6/storage/s3-client.js'
import { CapGuard } from '../packages/core/src/modules/clone-pro/v6/storage/cap-guard.js'

async function main() {
  if (!process.env.DATABASE_URL || !process.env.AWS_ACCESS_KEY_ID) {
    console.log('Skipping — DATABASE_URL or AWS creds not set'); process.exit(0)
  }
  const db = new Kysely<any>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: process.env.DATABASE_URL }) }) })
  const client = buildS3Client({ region: process.env.AWS_REGION ?? 'ap-southeast-1', accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY! })

  const fakeRendered = [{
    queueId: 'smoke-q', sourceUrl: 'https://example.com/',
    html: '', screenshotSha1: null,
    assetUrls: ['https://cdn.shopify.com/s/files/1/0001/sample.jpg'],
    viewportWidth: 1280, viewportHeight: 800, classification: 'page' as const,
  }]
  const graph = buildAssetGraph({ pages: fakeRendered })
  const r = await downloadAssetsToS3({
    assets: graph,
    shopId: process.env.SMOKE_SHOP_ID ?? 'd549d092-0252-49fd-a9ea-ccb4bf4c3f3f',
    jobId: 'smoke-job',
    sellerUuid: '20d9e33a-260e-4ee7-bce1-786480bf4ece',
    bucket: process.env.S3_BUCKET ?? 'gbox-clone-storage',
    cdnHost: process.env.CDN_HOST ?? 'cdn.gbox.co',
    s3Put: (input) => putObjectIfAbsent({ client, ...input }),
    db, cap: new CapGuard({ db }),
    concurrency: 5,
  })
  console.log(r)
  process.exit(r.downloaded + r.skipped > 0 ? 0 : 1)
}
main().catch((e) => { console.error(e); process.exit(2) })
