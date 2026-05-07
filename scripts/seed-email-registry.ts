/**
 * Seed the 95-template `email_template_registry` from the in-code catalog
 * (Phase 14 PR1).
 *
 * Re-running this script is safe: it's an UPSERT keyed on `template_key`.
 *
 *   - Fresh key      → INSERT.
 *   - Existing key   → UPDATE the default subject/body/variables/priority/
 *                      category/audience/description AND set implemented.
 *                      This keeps the seed authoritative for category /
 *                      audience (so renaming in code re-syncs the DB)
 *                      WITHOUT stomping seller / god-admin overrides of
 *                      the subject + body — those live in the "custom"
 *                      columns that don't exist yet (PR3 territory).
 *   - Obsolete key   → left alone. We don't delete — the admin UI shows
 *                      a "stale in catalog" warning for rows that aren't
 *                      in the current catalog so ops can clean up
 *                      deliberately.
 *
 * Usage:
 *   node --import tsx scripts/seed-email-registry.ts
 *   DATABASE_URL=postgres://... node --import tsx scripts/seed-email-registry.ts
 */

import 'dotenv/config'
import pg from 'pg'
import { EMAIL_TEMPLATE_CATALOG } from '../packages/core/src/modules/email/registry.js'

const DB_URL = process.env.DATABASE_URL
if (!DB_URL) {
  console.error('DATABASE_URL is not set')
  process.exit(1)
}

const pool = new pg.Pool({ connectionString: DB_URL })

async function main() {
  const client = await pool.connect()
  let inserted = 0
  let updated = 0
  try {
    await client.query('BEGIN')

    for (const spec of Object.values(EMAIL_TEMPLATE_CATALOG)) {
      const res = await client.query(
        `
        INSERT INTO email_template_registry (
          template_key, category, audience, priority,
          subject_default, body_html_default, body_text_default,
          variables, description, implemented, active
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, TRUE)
        ON CONFLICT (template_key) DO UPDATE SET
          category = EXCLUDED.category,
          audience = EXCLUDED.audience,
          priority = EXCLUDED.priority,
          subject_default = EXCLUDED.subject_default,
          body_html_default = EXCLUDED.body_html_default,
          body_text_default = EXCLUDED.body_text_default,
          variables = EXCLUDED.variables,
          description = EXCLUDED.description,
          implemented = EXCLUDED.implemented
        RETURNING (xmax = 0) AS inserted
        `,
        [
          spec.key,
          spec.category,
          spec.audience,
          spec.priority,
          spec.subject,
          spec.bodyHtml,
          spec.bodyText,
          JSON.stringify(spec.variables),
          spec.description,
          spec.implemented,
        ],
      )
      if (res.rows[0]?.inserted) inserted += 1
      else updated += 1
    }

    await client.query('COMMIT')

    const total = Object.keys(EMAIL_TEMPLATE_CATALOG).length
    console.log(
      `[seed-email-registry] ok — ${total} total, ${inserted} inserted, ${updated} updated`,
    )
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
    await pool.end()
  }
}

main().catch((err) => {
  console.error('[seed-email-registry] failed:', err)
  process.exit(1)
})
