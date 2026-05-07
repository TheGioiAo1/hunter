// scripts/smoke-clone-pro-v6-preflight.ts
//
// Manual smoke — run after deploying Sprint 0 to a test env:
//   DATABASE_URL=... npx tsx scripts/smoke-clone-pro-v6-preflight.ts
//
// Exit codes:
//   0 — runPreflight returned ok: true  (happy path verified)
//   1 — runPreflight returned ok: false (gate logic works; seller setup needs fix)
//   2 — unexpected exception            (script bug or DB unreachable)
//
// Pre-conditions:
//   - DATABASE_URL set (env or .env file)
//   - A shop row exists in `shops` matching SMOKE_SHOP_ID
//   - A `shop_ai_config` row for that shop with valid encrypted API key +
//     provider + model + enabled = true
//   - AI_ENCRYPTION_KEY (or PIXEL_ENCRYPTION_KEY) set to the 64-char hex KEK
import 'dotenv/config'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool } from 'pg'
import { runPreflight } from '../packages/core/src/modules/clone-pro/v6/preflight/gate.js'
import { pingProvider } from '../packages/core/src/modules/clone-pro/v6/preflight/ping-provider.js'
import { getAIConfig, getDecryptedAIKeys } from '../packages/core/src/modules/ai/config-service.js'

async function main() {
  const db = new Kysely<any>({
    dialect: new PostgresDialect({
      pool: new Pool({ connectionString: process.env.DATABASE_URL }),
    }),
  })

  const shopId = process.env.SMOKE_SHOP_ID ?? 'd549d092-0252-49fd-a9ea-ccb4bf4c3f3f' // best-store (lamdiepanh1903)
  const sourceUrl = 'https://bibliobloom.com'

  console.log(`Running preflight for shop=${shopId} source=${sourceUrl}`)

  const r = await runPreflight({
    db,
    shopId,
    sourceUrl,
    loadConfig: async (_db, sId) => {
      // Step 1: get public config to check provider + enabled state
      const cfg = await getAIConfig(_db as any, sId)
      if (!cfg || cfg.provider === 'none') return null

      // Step 2: decrypt keys — returns { provider, keys, model } | null
      // Returns null if !enabled or KEK missing
      const decrypted = await getDecryptedAIKeys(_db as any, sId)
      if (!decrypted) return null

      // keys shape: { openaiKey, anthropicKey, googleKey } (camelCase)
      const apiKeyMap: Record<string, string | null> = {
        anthropic: decrypted.keys.anthropicKey,
        openai:    decrypted.keys.openaiKey,
        google:    decrypted.keys.googleKey,
      }
      const apiKey = apiKeyMap[decrypted.provider]
      if (!apiKey) return null

      // model is already provider-resolved by getDecryptedAIKeys
      return {
        provider: decrypted.provider,
        model:    decrypted.model,
        apiKey,
      }
    },
    pingProvider,
    estimateUrlCount: async () => 712, // hard-coded for smoke
  })

  console.log('Result:', JSON.stringify(r, null, 2))

  if (r.ok) {
    console.log(`✓ Smoke pass — ${r.estimate.urlCount} URLs, $${r.estimate.aiCostUsd}`)
    process.exit(0)
  } else {
    console.log(`✗ Smoke fail — ${r.error}: ${r.detail ?? ''}`)
    process.exit(1)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(2)
})
