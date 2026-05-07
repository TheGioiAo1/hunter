/**
 * Seed mock Lenful catalog for local/dev testing.
 *
 * Populates `lenful_catalog` with ≥15 realistic POD products with full
 * multi-variant shapes (size × color, etc), so the seller-side Products
 * page "Lenful products" tab has something to render even before the
 * real Lenful catalog sync hits the live API.
 *
 * Safe to run multiple times — upserts on `lenful_product_id`.
 *
 * Run:
 *   node --import tsx scripts/seed-lenful-catalog.ts
 */

import 'dotenv/config'
import { createDb, destroyDb } from '../packages/db/src/index.ts'
import {
  upsertCatalogEntry,
  type NormalizedCatalogEntry,
  type NormalizedVariant,
  type NormalizedOption,
} from '../packages/core/src/modules/fulfillment/lenful/catalog-sync.ts'

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

interface BuildParams {
  productId: string
  sku: string
  title: string
  description: string
  category_slug: string
  category_name: string
  thumbnail: string
  gallery: string[]
  base_price: number
  axes: { name: string; values: string[] }[]
}

function buildCatalogEntry(p: BuildParams): NormalizedCatalogEntry {
  // Cartesian product of axes → variants
  const combos: { name: string; value: string }[][] = [[]]
  for (const axis of p.axes) {
    const next: { name: string; value: string }[][] = []
    for (const combo of combos) {
      for (const v of axis.values) {
        next.push([...combo, { name: axis.name, value: v }])
      }
    }
    combos.splice(0, combos.length, ...next)
  }

  const variants: NormalizedVariant[] = combos.map((opts, idx) => {
    const suffix = opts.map((o) => o.value.replace(/\s+/g, '')).join('-')
    const variantSku = `${p.sku}-${suffix}`
    const title = opts.map((o) => o.value).join(' / ')
    // Tiny price delta per axis for realism
    const priceDelta =
      opts.reduce((acc, o) => acc + (o.value.length % 3), 0) * 0.5
    return {
      id: `${p.productId}-v${idx + 1}`,
      sku: variantSku,
      title,
      options: opts,
      price: Number((p.base_price + priceDelta).toFixed(2)),
      thumbnail: p.thumbnail,
      raw: null,
    }
  })

  const options: NormalizedOption[] = p.axes.map((a) => ({
    name: a.name,
    values: a.values,
  }))

  return {
    lenful_product_id: p.productId,
    lenful_product_sku: p.sku,
    title: p.title,
    description: p.description,
    category_slug: p.category_slug,
    category_name: p.category_name,
    thumbnail_url: p.thumbnail,
    gallery_urls: p.gallery,
    base_price: p.base_price,
    currency: 'USD',
    variants,
    options,
    raw: {
      _seed: true,
      id: p.productId,
      product_sku: p.sku,
      title: p.title,
      category_slug: p.category_slug,
      category_name: p.category_name,
      thumbnail: p.thumbnail,
      base_price: p.base_price,
      // Mimic Lenful's raw shape so the normalizer would survive a round-trip
      variants: variants.map((v) => ({
        id: v.id,
        sku: v.sku,
        title: v.title,
        price: v.price,
        options: v.options,
      })),
      images: p.gallery,
      description: p.description,
    },
  }
}

// ─────────────────────────────────────────────────────────────
// Mock data — 16 POD products
// ─────────────────────────────────────────────────────────────

const SIZES_S_XXL = ['S', 'M', 'L', 'XL', '2XL']
const SIZES_YOUTH = ['YXS', 'YS', 'YM', 'YL']
const COLORS_BASIC = ['Black', 'White', 'Navy', 'Heather Grey']
const COLORS_FULL = ['Black', 'White', 'Navy', 'Red', 'Royal', 'Forest', 'Sand']
const MUG_OPTS = ['11oz', '15oz']
const POSTER_SIZES = ['12x18', '18x24', '24x36']
const CASE_MODELS = ['iPhone 14', 'iPhone 15', 'iPhone 15 Pro', 'Samsung S24']
const CANVAS_SIZES = ['8x10', '11x14', '16x20', '24x36']

const MOCKS: BuildParams[] = [
  {
    productId: 'lf-tshirt-classic',
    sku: 'LF-TS-CLSC',
    title: 'Classic Unisex Cotton Tee',
    description:
      'Soft 100% ring-spun cotton t-shirt with a relaxed unisex fit. Pre-shrunk and durable — the workhorse for every design in your store.',
    category_slug: 'apparel-tshirts',
    category_name: 'T-Shirts',
    thumbnail:
      'https://images.unsplash.com/photo-1521572163474-6864f9cf17ab?w=600&auto=format',
    gallery: [
      'https://images.unsplash.com/photo-1521572163474-6864f9cf17ab?w=1200&auto=format',
      'https://images.unsplash.com/photo-1503342217505-b0a15ec3261c?w=1200&auto=format',
    ],
    base_price: 12.5,
    axes: [
      { name: 'Size', values: SIZES_S_XXL },
      { name: 'Color', values: COLORS_FULL },
    ],
  },
  {
    productId: 'lf-tshirt-premium',
    sku: 'LF-TS-PREM',
    title: 'Premium Heavyweight Tee',
    description:
      'Heavier 6oz premium cotton for a structured drape. Great for bold graphics and long-wear comfort.',
    category_slug: 'apparel-tshirts',
    category_name: 'T-Shirts',
    thumbnail:
      'https://images.unsplash.com/photo-1618354691373-d851c5c3a990?w=600&auto=format',
    gallery: [
      'https://images.unsplash.com/photo-1618354691373-d851c5c3a990?w=1200&auto=format',
    ],
    base_price: 16.9,
    axes: [
      { name: 'Size', values: SIZES_S_XXL },
      { name: 'Color', values: COLORS_BASIC },
    ],
  },
  {
    productId: 'lf-longsleeve',
    sku: 'LF-TS-LONG',
    title: 'Classic Long Sleeve Tee',
    description:
      'A comfortable long-sleeve cotton tee, perfect for layering or standalone wear in cooler months.',
    category_slug: 'apparel-longsleeve',
    category_name: 'Long Sleeve',
    thumbnail:
      'https://images.unsplash.com/photo-1578587018452-892bacefd3f2?w=600&auto=format',
    gallery: [],
    base_price: 18.0,
    axes: [
      { name: 'Size', values: SIZES_S_XXL },
      { name: 'Color', values: ['Black', 'White', 'Navy'] },
    ],
  },
  {
    productId: 'lf-hoodie-pullover',
    sku: 'LF-HD-PULL',
    title: 'Pullover Hoodie',
    description:
      '50/50 cotton-poly blend pullover hoodie with a cozy front kangaroo pocket and soft-brushed fleece interior.',
    category_slug: 'apparel-hoodies',
    category_name: 'Hoodies',
    thumbnail:
      'https://images.unsplash.com/photo-1556821840-3a63f95609a7?w=600&auto=format',
    gallery: [
      'https://images.unsplash.com/photo-1556821840-3a63f95609a7?w=1200&auto=format',
      'https://images.unsplash.com/photo-1620799140408-edc6dcb6d633?w=1200&auto=format',
    ],
    base_price: 28.0,
    axes: [
      { name: 'Size', values: SIZES_S_XXL },
      { name: 'Color', values: ['Black', 'Heather Grey', 'Navy', 'Maroon'] },
    ],
  },
  {
    productId: 'lf-hoodie-zip',
    sku: 'LF-HD-ZIP',
    title: 'Full-Zip Hoodie',
    description:
      'Full-zip version of our classic hoodie. Premium YKK zipper, ribbed cuffs and hem for a long-lasting fit.',
    category_slug: 'apparel-hoodies',
    category_name: 'Hoodies',
    thumbnail:
      'https://images.unsplash.com/photo-1614975059251-992f11792b9f?w=600&auto=format',
    gallery: [],
    base_price: 34.0,
    axes: [
      { name: 'Size', values: SIZES_S_XXL },
      { name: 'Color', values: ['Black', 'Heather Grey', 'Navy'] },
    ],
  },
  {
    productId: 'lf-sweatshirt',
    sku: 'LF-SW-CREW',
    title: 'Crewneck Sweatshirt',
    description:
      'Classic crewneck sweatshirt with a soft-brushed fleece interior. Timeless style, year-round comfort.',
    category_slug: 'apparel-sweatshirts',
    category_name: 'Sweatshirts',
    thumbnail:
      'https://images.unsplash.com/photo-1578681994506-b8f463449011?w=600&auto=format',
    gallery: [],
    base_price: 26.5,
    axes: [
      { name: 'Size', values: SIZES_S_XXL },
      { name: 'Color', values: ['Black', 'White', 'Heather Grey', 'Navy'] },
    ],
  },
  {
    productId: 'lf-tank-top',
    sku: 'LF-TK-CLSC',
    title: 'Classic Unisex Tank Top',
    description:
      'Lightweight breathable tank top — the perfect summer canvas for your designs.',
    category_slug: 'apparel-tanks',
    category_name: 'Tank Tops',
    thumbnail:
      'https://images.unsplash.com/photo-1622445275463-afa2ab738c34?w=600&auto=format',
    gallery: [],
    base_price: 14.5,
    axes: [
      { name: 'Size', values: SIZES_S_XXL },
      { name: 'Color', values: ['Black', 'White', 'Heather Grey'] },
    ],
  },
  {
    productId: 'lf-youth-tee',
    sku: 'LF-YT-TEE',
    title: 'Youth Classic Tee',
    description:
      'Same premium cotton as our adult classic tee, sized for kids. Durable enough for the playground.',
    category_slug: 'apparel-youth',
    category_name: 'Kids & Youth',
    thumbnail:
      'https://images.unsplash.com/photo-1503944583220-79d8926ad5e2?w=600&auto=format',
    gallery: [],
    base_price: 11.0,
    axes: [
      { name: 'Size', values: SIZES_YOUTH },
      { name: 'Color', values: ['Black', 'White', 'Red', 'Royal'] },
    ],
  },
  {
    productId: 'lf-mug-ceramic',
    sku: 'LF-MG-CER',
    title: 'Classic Ceramic Mug',
    description:
      'Dishwasher- and microwave-safe ceramic mug with a high-gloss finish. Available in 11oz and 15oz.',
    category_slug: 'drinkware-mugs',
    category_name: 'Mugs',
    thumbnail:
      'https://images.unsplash.com/photo-1514228742587-6b1558fcca3d?w=600&auto=format',
    gallery: [
      'https://images.unsplash.com/photo-1514228742587-6b1558fcca3d?w=1200&auto=format',
    ],
    base_price: 8.5,
    axes: [
      { name: 'Size', values: MUG_OPTS },
      { name: 'Color', values: ['White', 'Black'] },
    ],
  },
  {
    productId: 'lf-mug-travel',
    sku: 'LF-MG-TRV',
    title: 'Stainless Steel Travel Mug',
    description:
      'Double-wall vacuum insulated stainless steel travel mug. Keeps drinks hot for 6h, cold for 12h.',
    category_slug: 'drinkware-mugs',
    category_name: 'Mugs',
    thumbnail:
      'https://images.unsplash.com/photo-1512568400610-62da28bc8a13?w=600&auto=format',
    gallery: [],
    base_price: 19.5,
    axes: [{ name: 'Color', values: ['Silver', 'Black', 'White'] }],
  },
  {
    productId: 'lf-poster-matte',
    sku: 'LF-PS-MAT',
    title: 'Matte Wall Poster',
    description:
      'Heavyweight 200gsm matte art paper with museum-grade archival inks. Ships rolled in a sturdy tube.',
    category_slug: 'wall-art-posters',
    category_name: 'Posters',
    thumbnail:
      'https://images.unsplash.com/photo-1513519245088-0e12902e5a38?w=600&auto=format',
    gallery: [],
    base_price: 14.0,
    axes: [{ name: 'Size', values: POSTER_SIZES }],
  },
  {
    productId: 'lf-canvas-wrap',
    sku: 'LF-CV-WRAP',
    title: 'Gallery Canvas Wrap',
    description:
      'Premium gallery-wrapped canvas print stretched over a 1.25" solid wood frame. Ready to hang.',
    category_slug: 'wall-art-canvas',
    category_name: 'Canvas',
    thumbnail:
      'https://images.unsplash.com/photo-1554907984-15263bfd63bd?w=600&auto=format',
    gallery: [],
    base_price: 32.0,
    axes: [{ name: 'Size', values: CANVAS_SIZES }],
  },
  {
    productId: 'lf-phone-case',
    sku: 'LF-PC-HRD',
    title: 'Hard Shell Phone Case',
    description:
      'Slim hard-shell phone case with scratch-resistant print. Precision cutouts and raised edges to protect the camera and screen.',
    category_slug: 'accessories-phone',
    category_name: 'Phone Cases',
    thumbnail:
      'https://images.unsplash.com/photo-1603898037225-1bea09c550c5?w=600&auto=format',
    gallery: [],
    base_price: 18.0,
    axes: [
      { name: 'Model', values: CASE_MODELS },
      { name: 'Finish', values: ['Matte', 'Glossy'] },
    ],
  },
  {
    productId: 'lf-tote-bag',
    sku: 'LF-BG-TOTE',
    title: 'Cotton Canvas Tote Bag',
    description:
      '100% natural cotton canvas tote with reinforced shoulder straps. Holds up to 25lbs without stretching.',
    category_slug: 'accessories-bags',
    category_name: 'Bags',
    thumbnail:
      'https://images.unsplash.com/photo-1591561954557-26941169b49e?w=600&auto=format',
    gallery: [],
    base_price: 13.5,
    axes: [{ name: 'Color', values: ['Natural', 'Black', 'Navy'] }],
  },
  {
    productId: 'lf-cap-dad',
    sku: 'LF-HT-DAD',
    title: 'Classic Dad Cap',
    description:
      'Unstructured 6-panel cotton twill dad cap with an adjustable strap back. One-size-fits-most.',
    category_slug: 'accessories-hats',
    category_name: 'Hats',
    thumbnail:
      'https://images.unsplash.com/photo-1588850561407-ed78c282e89b?w=600&auto=format',
    gallery: [],
    base_price: 15.0,
    axes: [{ name: 'Color', values: ['Black', 'White', 'Navy', 'Khaki', 'Red'] }],
  },
  {
    productId: 'lf-sticker-pack',
    sku: 'LF-ST-PACK',
    title: 'Die-Cut Vinyl Sticker',
    description:
      'Weatherproof die-cut vinyl sticker with a durable laminate finish. 3-year outdoor fade resistance.',
    category_slug: 'accessories-stickers',
    category_name: 'Stickers',
    thumbnail:
      'https://images.unsplash.com/photo-1585336261022-680e295ce3fe?w=600&auto=format',
    gallery: [],
    base_price: 3.5,
    axes: [
      { name: 'Size', values: ['3"', '4"', '5"'] },
      { name: 'Finish', values: ['Glossy', 'Matte', 'Holographic'] },
    ],
  },
]

async function main() {
  const db = createDb()
  let created = 0
  let updated = 0
  let totalVariants = 0

  try {
    for (const m of MOCKS) {
      const entry = buildCatalogEntry(m)
      totalVariants += entry.variants.length
      const existing = await db
        .selectFrom('lenful_catalog')
        .select(['lenful_product_id'])
        .where('lenful_product_id', '=', entry.lenful_product_id)
        .executeTakeFirst()
      await upsertCatalogEntry(db, entry)
      if (existing) updated++
      else created++
      console.log(
        `  ${existing ? '[upd]' : '[new]'} ${entry.lenful_product_id.padEnd(22)} ` +
          `${entry.title} (${entry.variants.length} variants)`,
      )
    }

    console.log('')
    console.log('-'.repeat(60))
    console.log(
      `Seeded Lenful catalog: ${created} new, ${updated} updated, ${MOCKS.length} total products, ${totalVariants} total variants`,
    )
  } finally {
    await destroyDb()
  }
}

main().catch(async (err) => {
  console.error('Seed error:', err)
  process.exit(1)
})
