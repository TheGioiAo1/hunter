#!/usr/bin/env tsx
/**
 * Gbox Platform — SSL State Reconciler
 *
 * Called by `scripts/ops/renew-ssl-certs.sh` after certbot renew.
 * Reads cert files from /etc/letsencrypt/live/ and reconciles the
 * `shop_domains` table's ssl_* columns with what's on disk.
 *
 * Flow:
 *   1. Read all verified domains from shop_domains
 *   2. For each, check if /etc/letsencrypt/live/<domain>/cert.pem exists
 *   3. If it does, read the cert's notAfter date via openssl
 *   4. Update ssl_issued_at / ssl_expires_at / ssl_provider / ssl_last_error
 *
 * Environment:
 *   DATABASE_URL — Postgres connection string
 *   LETSENCRYPT_DIR — defaults to /etc/letsencrypt/live
 *
 * Usage:
 *   sudo tsx scripts/ops/reconcile-ssl-state.ts
 */

import { createDb, destroyDb } from '@gbox/db'
import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

const LETSENCRYPT_DIR = process.env.LETSENCRYPT_DIR ?? '/etc/letsencrypt/live'

async function main() {
  console.log('[reconcile-ssl] Starting SSL state reconciliation...')
  console.log(`[reconcile-ssl] Looking for certs in: ${LETSENCRYPT_DIR}`)

  const db = createDb()

  try {
    // Load all verified domains
    const domains = await db
      .selectFrom('shop_domains' as any)
      .select([
        'id',
        'domain',
        'verified',
        'ssl_provider',
        'ssl_issued_at',
        'ssl_expires_at',
      ] as any[])
      .where('verified', '=', true)
      .execute() as any[]

    console.log(`[reconcile-ssl] Found ${domains.length} verified domain(s)`)

    let updated = 0
    let missing = 0
    let errors = 0

    for (const row of domains) {
      const certDir = path.join(LETSENCRYPT_DIR, row.domain)
      const certPath = path.join(certDir, 'cert.pem')

      if (!existsSync(certPath)) {
        // No cert on disk — mark as missing if we thought one existed
        if (row.ssl_provider) {
          await db
            .updateTable('shop_domains' as any)
            .set({
              ssl_last_error: 'Certificate file not found on disk',
            })
            .where('id', '=', row.id)
            .execute()
          console.log(`[reconcile-ssl] ${row.domain}: cert not found on disk`)
          errors++
        } else {
          missing++
        }
        continue
      }

      // Read cert notAfter via openssl
      try {
        const notAfterStr = execSync(
          `openssl x509 -enddate -noout -in "${certPath}" 2>/dev/null`,
          { encoding: 'utf8', timeout: 5000 },
        ).trim()

        // Format: "notAfter=Jul 10 12:00:00 2026 GMT"
        const match = notAfterStr.match(/notAfter=(.+)/)
        if (!match) {
          console.error(`[reconcile-ssl] ${row.domain}: could not parse notAfter: ${notAfterStr}`)
          errors++
          continue
        }

        const expiresAt = new Date(match[1])
        if (isNaN(expiresAt.getTime())) {
          console.error(`[reconcile-ssl] ${row.domain}: invalid date: ${match[1]}`)
          errors++
          continue
        }

        // Read notBefore for ssl_issued_at
        const notBeforeStr = execSync(
          `openssl x509 -startdate -noout -in "${certPath}" 2>/dev/null`,
          { encoding: 'utf8', timeout: 5000 },
        ).trim()

        const beforeMatch = notBeforeStr.match(/notBefore=(.+)/)
        const issuedAt = beforeMatch ? new Date(beforeMatch[1]) : new Date()

        // Update DB
        await db
          .updateTable('shop_domains' as any)
          .set({
            ssl_provider: 'letsencrypt',
            ssl_issued_at: issuedAt,
            ssl_expires_at: expiresAt,
            ssl_last_error: null,
          })
          .where('id', '=', row.id)
          .execute()

        const daysLeft = Math.floor((expiresAt.getTime() - Date.now()) / 86_400_000)
        console.log(`[reconcile-ssl] ${row.domain}: expires ${expiresAt.toISOString()} (${daysLeft}d left)`)
        updated++
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.error(`[reconcile-ssl] ${row.domain}: openssl error: ${message}`)

        await db
          .updateTable('shop_domains' as any)
          .set({
            ssl_last_error: `openssl error: ${message.slice(0, 200)}`,
          })
          .where('id', '=', row.id)
          .execute()
        errors++
      }
    }

    console.log(`[reconcile-ssl] Done: ${updated} updated, ${missing} no cert yet, ${errors} errors`)
  } finally {
    await destroyDb()
  }
}

main().catch((err) => {
  console.error('[reconcile-ssl] Fatal:', err)
  process.exit(1)
})
