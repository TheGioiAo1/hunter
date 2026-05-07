/**
 * Seed the `translations` table from theme locale files in `theme_assets`.
 *
 * Usage: node --import tsx scripts/seed-translations.ts
 */

import 'dotenv/config'
import pg from 'pg'

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })

function flatten(
  obj: Record<string, unknown>,
  prefix = '',
  out: Record<string, string> = {},
): Record<string, string> {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      flatten(v as Record<string, unknown>, key, out)
    } else {
      out[key] = String(v)
    }
  }
  return out
}

async function main() {
  const client = await pool.connect()
  try {
    // Get all active shops
    const shops = await client.query(
      "SELECT id, slug FROM shops WHERE status = 'active'",
    )

    for (const shop of shops.rows) {
      // Get non-schema locale files from the shop's main theme
      const assets = await client.query(
        `SELECT ta.key, ta.value FROM theme_assets ta
         JOIN themes t ON ta.theme_id = t.id
         WHERE t.shop_id = $1 AND t.role = 'main'
         AND ta.key LIKE 'locales/%'
         AND ta.key NOT LIKE '%.schema.%'`,
        [shop.id],
      )

      for (const asset of assets.rows) {
        const match = asset.key.match(
          /locales\/([a-z]{2})(?:\.default)?\.json$/i,
        )
        if (!match) continue
        const locale = match[1]!

        let json: Record<string, unknown>
        try {
          json = JSON.parse(asset.value)
        } catch {
          console.warn(`  Skipping invalid JSON: ${asset.key}`)
          continue
        }

        const entries = flatten(json)
        let count = 0

        for (const [key, value] of Object.entries(entries)) {
          await client.query(
            `INSERT INTO translations (id, shop_id, locale, key, value, namespace, created_at, updated_at)
             VALUES (gen_random_uuid(), $1, $2, $3, $4, 'theme', NOW(), NOW())
             ON CONFLICT DO NOTHING`,
            [shop.id, locale, key, value],
          )
          count++
        }

        console.log(
          `  ${shop.slug} [${locale}]: ${count} translations seeded`,
        )
      }
    }

    // Verify
    const total = await client.query('SELECT count(*) FROM translations')
    console.log(`\nTotal translations in DB: ${total.rows[0].count}`)
  } finally {
    client.release()
    await pool.end()
  }
}

main().catch(console.error)
