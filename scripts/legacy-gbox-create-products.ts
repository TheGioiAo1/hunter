/**
 * Legacy GBox — Create Products via api-product.gbox.co
 *
 * Purpose
 * -------
 * Calls the legacy GBox product service (api-product.gbox.co) to POST new
 * products into a store, authenticated with a JWT obtained from the
 * legacy auth service (api-auth.gbox.co/api/token).
 *
 * This talks to the PRODUCTION legacy stack, NOT the gbox-platform v4
 * rewrite. Use sparingly and always review the --dry output before
 * re-running with --live.
 *
 * Security
 * --------
 * Credentials are read from environment variables ONLY. Never paste into
 * source or logs. Iron Rule #1 (CLAUDE.md).
 *
 *   GBOX_AUTH_EMAIL       (required)  legacy GBox seller email
 *   GBOX_AUTH_PASSWORD    (required)  legacy GBox seller password
 *   GBOX_SHOP_ID          (required)  e.g. 121212121211212
 *   GBOX_AUTH_BASE        (optional)  default https://api-auth.gbox.co
 *   GBOX_PRODUCT_BASE     (optional)  default https://api-product.gbox.co
 *
 * Run
 * ---
 *   node --import tsx scripts/legacy-gbox-create-products.ts               # dry (default)
 *   node --import tsx scripts/legacy-gbox-create-products.ts --live        # actually POST
 *   node --import tsx scripts/legacy-gbox-create-products.ts --live --limit 5
 *
 * Data source
 * -----------
 * Ships with 3 sample products inline (Classic Tee, Ceramic Mug, Canvas
 * Tote). Pass `--inline` (default) to use these. Passing `--from-file
 * path.json` reads a JSON array of partial Product objects to POST
 * instead; fields are merged on top of the sensible defaults below.
 *
 * Exit codes
 * ----------
 *   0  success (all POSTs 2xx or dry-run clean)
 *   1  bad args / env
 *   2  auth failed
 *   3  one or more product POSTs failed
 *  99  fatal
 */

import 'dotenv/config'
import { readFileSync } from 'node:fs'

// ───────────────────────────────────────────────────────────
// Types mirroring the api-product.gbox.co v1 swagger
// ───────────────────────────────────────────────────────────

interface ProductImage {
  readonly position: number
  readonly url: string
  readonly type?: number // DesignType enum
}

interface ProductOptionValue {
  readonly name: string
  readonly display_value: string
  readonly slug?: string
}

interface ProductOption {
  readonly name: string
  readonly slug?: string
  readonly values: ReadonlyArray<ProductOptionValue>
  readonly display_type?: string
}

interface ProductVariant {
  readonly name: string
  readonly sku: string
  readonly price: number
  readonly option_values?: ReadonlyArray<string>
  readonly weight?: number
  readonly mass_unit?: string
}

interface LegacyProduct {
  name: string
  sku?: string
  slug?: string
  vendor?: string
  tags?: string[]
  body_html?: string
  images?: ProductImage[]
  variants?: ProductVariant[]
  options?: ProductOption[]
  seo_title?: string
  seo_description?: string
  published?: boolean
}

// ───────────────────────────────────────────────────────────
// Inline sample catalog — 3 realistic starter products
// ───────────────────────────────────────────────────────────

const SAMPLE_PRODUCTS: LegacyProduct[] = [
  {
    name: 'Classic Unisex Tee',
    sku: 'GBX-TEE-CLASSIC',
    vendor: 'Gbox',
    tags: ['apparel', 'tee', 'unisex'],
    body_html:
      '<p>Soft-hand ringspun cotton tee with a classic crew neck. ' +
      'Pre-shrunk, tear-away label, side-seamed construction.</p>',
    seo_title: 'Classic Unisex Tee — Gbox',
    seo_description: 'Premium ringspun cotton unisex tee in 6 colors × 5 sizes.',
    published: true,
    images: [
      {
        position: 1,
        url: 'https://images.unsplash.com/photo-1521572163474-6864f9cf17ab?w=800',
      },
    ],
    options: [
      {
        name: 'Size',
        values: [
          { name: 'S', display_value: 'S' },
          { name: 'M', display_value: 'M' },
          { name: 'L', display_value: 'L' },
          { name: 'XL', display_value: 'XL' },
        ],
      },
      {
        name: 'Color',
        values: [
          { name: 'Black', display_value: 'Black' },
          { name: 'White', display_value: 'White' },
          { name: 'Navy', display_value: 'Navy' },
        ],
      },
    ],
    variants: [
      { name: 'S / Black', sku: 'GBX-TEE-S-BLACK', price: 19.99, option_values: ['S', 'Black'] },
      { name: 'M / Black', sku: 'GBX-TEE-M-BLACK', price: 19.99, option_values: ['M', 'Black'] },
      { name: 'L / Black', sku: 'GBX-TEE-L-BLACK', price: 19.99, option_values: ['L', 'Black'] },
      { name: 'M / White', sku: 'GBX-TEE-M-WHITE', price: 19.99, option_values: ['M', 'White'] },
      { name: 'L / Navy', sku: 'GBX-TEE-L-NAVY', price: 19.99, option_values: ['L', 'Navy'] },
    ],
  },
  {
    name: 'Classic Ceramic Mug (11oz)',
    sku: 'GBX-MUG-CERAMIC',
    vendor: 'Gbox',
    tags: ['drinkware', 'mug', 'ceramic'],
    body_html:
      '<p>Dishwasher and microwave safe 11oz ceramic mug. ' +
      'Full-wrap print area with vibrant edge-to-edge color.</p>',
    seo_title: 'Classic Ceramic Mug — Gbox',
    seo_description: '11oz ceramic coffee mug, full-wrap print area.',
    published: true,
    images: [
      {
        position: 1,
        url: 'https://images.unsplash.com/photo-1517256064527-09c73fc73e38?w=800',
      },
    ],
    options: [
      {
        name: 'Color',
        values: [
          { name: 'White', display_value: 'White' },
          { name: 'Black', display_value: 'Black' },
        ],
      },
    ],
    variants: [
      { name: 'White', sku: 'GBX-MUG-WHITE', price: 8.5, option_values: ['White'] },
      { name: 'Black', sku: 'GBX-MUG-BLACK', price: 9.5, option_values: ['Black'] },
    ],
  },
  {
    name: 'Cotton Canvas Tote Bag',
    sku: 'GBX-TOTE-CANVAS',
    vendor: 'Gbox',
    tags: ['bag', 'tote', 'canvas'],
    body_html:
      '<p>Heavyweight 12oz cotton canvas tote with 23-inch reinforced ' +
      'handles. Double-stitched seams. Print both sides.</p>',
    seo_title: 'Cotton Canvas Tote Bag — Gbox',
    seo_description: '12oz natural cotton canvas tote, reinforced handles, double-sided print.',
    published: true,
    images: [
      {
        position: 1,
        url: 'https://images.unsplash.com/photo-1544441893-675973e31985?w=800',
      },
    ],
    variants: [
      { name: 'Natural', sku: 'GBX-TOTE-NATURAL', price: 13.5 },
    ],
  },
]

// ───────────────────────────────────────────────────────────
// CLI arg parsing
// ───────────────────────────────────────────────────────────

interface Args {
  live: boolean
  limit: number
  fromFile: string | null
}

function parseArgs(argv: string[]): Args {
  let live = false
  let limit = 3
  let fromFile: string | null = null
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--live') live = true
    else if (a === '--dry') live = false
    else if (a === '--limit') limit = Math.max(1, parseInt(argv[++i] ?? '3', 10) || 3)
    else if (a === '--from-file') fromFile = argv[++i] ?? null
    else if (a === '--inline') fromFile = null
  }
  return { live, limit, fromFile }
}

// ───────────────────────────────────────────────────────────
// Auth
// ───────────────────────────────────────────────────────────

async function login(
  authBase: string,
  email: string,
  password: string,
): Promise<string> {
  const url = `${authBase.replace(/\/$/, '')}/api/token`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: '*/*',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email, password }),
  })
  const rawText = await res.text()
  let body: any = null
  try {
    body = rawText ? JSON.parse(rawText) : null
  } catch {
    throw new Error(
      `auth: non-JSON response (status ${res.status}): ${rawText.slice(0, 200)}`,
    )
  }
  if (!res.ok) {
    throw new Error(
      `auth: login failed (status ${res.status}): ${body?.message ?? rawText.slice(0, 200)}`,
    )
  }

  // Swagger says response is "Success" without a typed body. Probe common
  // shapes in order of likelihood on a .NET auth service.
  const candidates = [
    body?.access_token,
    body?.token,
    body?.data?.access_token,
    body?.data?.token,
    body?.result?.access_token,
    body?.result?.token,
    typeof body === 'string' ? body : null,
  ].filter((v): v is string => typeof v === 'string' && v.length > 20)

  if (candidates.length === 0) {
    throw new Error(
      `auth: login returned 200 but no recognizable token field. body keys=${Object.keys(body ?? {}).join(',')}; body preview=${JSON.stringify(body).slice(0, 400)}`,
    )
  }
  return candidates[0]!
}

// ───────────────────────────────────────────────────────────
// Create product
// ───────────────────────────────────────────────────────────

interface CreateResult {
  readonly name: string
  readonly status: number
  readonly ok: boolean
  readonly body: any
}

async function createProduct(
  productBase: string,
  shopId: string,
  token: string,
  product: LegacyProduct,
): Promise<CreateResult> {
  const qs = new URLSearchParams({ check_exists: 'false', clone: 'false' })
  const url = `${productBase.replace(/\/$/, '')}/api/${encodeURIComponent(shopId)}?${qs.toString()}`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: '*/*',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ ...product, shop_id: shopId }),
  })
  const txt = await res.text()
  let body: any = null
  try {
    body = txt ? JSON.parse(txt) : null
  } catch {
    body = { _non_json: txt.slice(0, 400) }
  }
  return { name: product.name, status: res.status, ok: res.ok, body }
}

// ───────────────────────────────────────────────────────────
// Main
// ───────────────────────────────────────────────────────────

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv.slice(2))

  const email = (process.env.GBOX_AUTH_EMAIL || '').trim()
  const password = process.env.GBOX_AUTH_PASSWORD || ''
  const shopId = (process.env.GBOX_SHOP_ID || '').trim()
  const authBase = (process.env.GBOX_AUTH_BASE || 'https://api-auth.gbox.co').trim()
  const productBase = (process.env.GBOX_PRODUCT_BASE || 'https://api-product.gbox.co').trim()

  if (!shopId) {
    console.error('[legacy-create] GBOX_SHOP_ID env required (e.g. 121212121211212)')
    return 1
  }
  if (args.live && (!email || !password)) {
    console.error('[legacy-create] --live requires GBOX_AUTH_EMAIL + GBOX_AUTH_PASSWORD env')
    return 1
  }

  // Resolve dataset
  let dataset: LegacyProduct[]
  if (args.fromFile) {
    try {
      const raw = readFileSync(args.fromFile, 'utf8')
      const parsed = JSON.parse(raw)
      if (!Array.isArray(parsed)) throw new Error('expected JSON array')
      dataset = parsed as LegacyProduct[]
    } catch (err: any) {
      console.error(`[legacy-create] --from-file failed: ${err?.message ?? err}`)
      return 1
    }
  } else {
    dataset = SAMPLE_PRODUCTS
  }
  dataset = dataset.slice(0, args.limit)

  console.log('── Config ──────────────────────────────────────')
  console.log(` authBase     : ${authBase}`)
  console.log(` productBase  : ${productBase}`)
  console.log(` shopId       : ${shopId}`)
  console.log(` mode         : ${args.live ? 'LIVE (will POST)' : 'DRY (will print)'}`)
  console.log(` dataset size : ${dataset.length}`)
  console.log(` source       : ${args.fromFile ?? 'inline sample'}`)
  console.log('')

  // Dry: just show what we'd send and stop
  if (!args.live) {
    console.log('── DRY RUN — payloads that WOULD be POSTed ─────')
    for (let i = 0; i < dataset.length; i++) {
      const p = dataset[i]!
      console.log(`\n[${i + 1}/${dataset.length}] POST ${productBase}/api/${shopId}?check_exists=false&clone=false`)
      console.log(JSON.stringify({ ...p, shop_id: shopId }, null, 2))
    }
    console.log('\n(no HTTP calls made — pass --live to actually POST)')
    return 0
  }

  // Live: auth → create each
  console.log('── Auth ────────────────────────────────────────')
  let token: string
  try {
    token = await login(authBase, email, password)
    console.log(`[auth] ok — token length=${token.length}, prefix=${token.slice(0, 16)}…`)
  } catch (err: any) {
    console.error(`[auth] ${err?.message ?? err}`)
    return 2
  }

  console.log('')
  console.log('── Creating products ──────────────────────────')
  const results: CreateResult[] = []
  for (let i = 0; i < dataset.length; i++) {
    const p = dataset[i]!
    const r = await createProduct(productBase, shopId, token, p)
    results.push(r)
    const tag = r.ok ? '✓' : '✗'
    const idOrErr = r.ok
      ? (r.body?.id ?? r.body?.data?.id ?? r.body?._id ?? '(no id in response)')
      : (r.body?.message ?? JSON.stringify(r.body).slice(0, 200))
    console.log(
      `${tag} [${i + 1}/${dataset.length}] ${p.name.padEnd(32)} status=${r.status} ${idOrErr}`,
    )
  }

  const okCount = results.filter((r) => r.ok).length
  const failCount = results.length - okCount
  console.log('')
  console.log('── Summary ────────────────────────────────────')
  console.log(` ok   : ${okCount}`)
  console.log(` fail : ${failCount}`)

  if (failCount > 0) {
    console.log('')
    console.log(' First failures:')
    for (const r of results.filter((x) => !x.ok).slice(0, 5)) {
      console.log(`   · ${r.name} — ${r.status} :: ${JSON.stringify(r.body).slice(0, 300)}`)
    }
    return 3
  }
  return 0
}

main(process.argv)
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('[legacy-create] FATAL:', err)
    process.exit(99)
  })
