#!/usr/bin/env node
/**
 * rotate-webhook-secret.ts — rotate a shop's webhook signing secret.
 *
 * Phase 0 §8 Item #2. Until the god-admin developer/webhooks UI is
 * wired up in Phase 2 Admin Polish, ops rotates secrets via this CLI.
 *
 * CLI:
 *   npx tsx scripts/ops/rotate-webhook-secret.ts \
 *     --shop=<slug-or-id> \
 *     [--reason="rotation rationale"] \
 *     [--json]
 *
 * Behaviour:
 *   - Resolves the shop by slug OR UUID.
 *   - Calls `rotateShopWebhookSecret` which:
 *       * generates a fresh 48-byte hex secret
 *       * moves the current secret to `webhook.secret.previous`
 *       * stamps `webhook.secret.rotated_at`
 *     inside a single transaction.
 *   - Writes an audit_log entry (`webhook_secret_rotated`) so the
 *     rotation is visible on god-admin → Security.
 *   - Prints the new secret ONCE. The script never re-emits it after
 *     the transaction returns.
 *
 * Exit codes:
 *   0 — rotated
 *   1 — shop not found / bad args
 *   2 — rotation failed
 */

import 'dotenv/config'
import { createDb, destroyDb } from '@gbox/db'
import { rotateShopWebhookSecret, getRotationGraceDays } from '@gbox/core/modules/webhooks/hmac.js'

interface Args {
  shop: string
  reason: string | null
  json: boolean
}

function parseArgs(argv: string[]): Args {
  const out: Args = { shop: '', reason: null, json: false }
  for (const a of argv) {
    if (a.startsWith('--shop=')) {
      out.shop = a.slice('--shop='.length).trim()
    } else if (a.startsWith('--reason=')) {
      out.reason = a.slice('--reason='.length).trim() || null
    } else if (a === '--json') {
      out.json = true
    }
  }
  if (!out.shop) {
    throw new Error('missing --shop=<slug-or-id>')
  }
  return out
}

async function main(): Promise<number> {
  let args: Args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (err) {
    console.error(
      `[rotate-webhook-secret] bad args: ${err instanceof Error ? err.message : err}`,
    )
    return 1
  }

  const db = createDb()
  try {
    // Accept either a slug or a UUID. UUID match is exact; slug match
    // is scoped to the `slug` column. Ambiguous inputs should be rare
    // since slugs are enforced lowercase-hyphen.
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      args.shop,
    )
    const shop = await db
      .selectFrom('shops')
      .select(['id', 'slug', 'name'])
      .where((eb) =>
        isUuid ? eb('id', '=', args.shop) : eb('slug', '=', args.shop),
      )
      .executeTakeFirst()

    if (!shop) {
      console.error(`[rotate-webhook-secret] shop not found: ${args.shop}`)
      return 1
    }

    let result
    try {
      result = await rotateShopWebhookSecret(db, shop.id)
    } catch (err) {
      console.error(
        `[rotate-webhook-secret] rotation failed: ${err instanceof Error ? err.message : err}`,
      )
      return 2
    }

    // Audit entry so god-admin → Security shows the rotation.
    await db
      .insertInto('audit_logs')
      .values({
        shop_id: shop.id,
        user_id: null,
        action: 'webhook_secret_rotated',
        resource_type: 'webhook',
        resource_id: null,
        details: JSON.stringify({
          shop_slug: shop.slug,
          rotated_at: result.rotatedAt,
          grace_expires_at: result.graceExpiresAt,
          grace_days: getRotationGraceDays(),
          had_previous: result.previousSecret !== null,
          reason: args.reason,
          source: 'cli',
        }),
        ip_address: null,
      })
      .execute()
      .catch((err) =>
        console.error('[rotate-webhook-secret] audit log write failed:', err),
      )

    if (args.json) {
      // Machine-readable path — emits the new secret. Caller is expected
      // to redact before forwarding anywhere persistent.
      console.log(
        JSON.stringify({
          shop_id: shop.id,
          shop_slug: shop.slug,
          shop_name: shop.name,
          new_secret: result.newSecret,
          had_previous: result.previousSecret !== null,
          rotated_at: result.rotatedAt,
          grace_expires_at: result.graceExpiresAt,
          grace_days: getRotationGraceDays(),
        }),
      )
    } else {
      console.log(`[rotate-webhook-secret] Rotated ${shop.slug} (${shop.id})`)
      console.log(`  Rotated at:       ${result.rotatedAt}`)
      console.log(`  Grace expires at: ${result.graceExpiresAt}`)
      console.log(`  Grace window:     ${getRotationGraceDays()} days`)
      console.log(`  Had previous:     ${result.previousSecret !== null}`)
      console.log('')
      console.log('  NEW SECRET (show ONCE, hand off securely):')
      console.log(`    ${result.newSecret}`)
      console.log('')
      console.log(
        '  Merchants should update their verifier within the grace ' +
          'window. During that time every outbound delivery will carry ' +
          'both X-Gbox-Hmac-SHA256 (new) and X-Gbox-Hmac-SHA256-Previous (old).',
      )
    }

    return 0
  } finally {
    await destroyDb(db)
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(
      `[rotate-webhook-secret] uncaught: ${err instanceof Error ? err.stack : err}`,
    )
    process.exit(2)
  })
