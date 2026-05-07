#!/usr/bin/env node
/**
 * prune-audit-logs.ts — delete audit_logs rows past the retention window.
 *
 * Phase 0 §8 Item #6. Scheduled daily via systemd timer / pm2 cron on
 * server 1 so the audit_logs table can't grow unbounded. Default
 * retention window is 365 days; override with `AUDIT_LOG_RETENTION_DAYS`
 * or `--days=<n>`.
 *
 * CLI:
 *   npx tsx scripts/cron/prune-audit-logs.ts \
 *     [--days=365] \
 *     [--batch-size=1000] \
 *     [--max-batches=100] \
 *     [--dry-run]
 *
 * Exit codes:
 *   0 — prune succeeded (or nothing to delete)
 *   1 — truncated (hit maxBatches with rows still matching — re-run)
 *   2 — failure (DB unreachable, bad args, DELETE raised)
 *
 * Report line: single JSON object on the last stdout line, same
 * convention as scripts/cron/agent-daily-digest.ts so the monitoring
 * harness can parse it. Shape:
 *
 *   {
 *     "script": "prune-audit-logs",
 *     "days": 365,
 *     "dryRun": false,
 *     "cutoffIso": "2025-04-11T18:41:00.000Z",
 *     "matched": 1234,
 *     "deleted": 1234,
 *     "truncated": false,
 *     "batches": 2,
 *     "durationMs": 142,
 *     "statsBefore": { "total": ..., "oldestIso": ..., "newestIso": ... },
 *     "statsAfter":  { "total": ..., "oldestIso": ..., "newestIso": ... }
 *   }
 */

import 'dotenv/config'
import { createDb, destroyDb } from '@gbox/db'
import {
  pruneAuditLogs,
  getAuditLogStats,
  type PruneResult,
} from '@gbox/core/modules/audit/index.js'
// Phase 0 §8 Item #2 — piggyback the webhook-secret grace-window cleanup
// on the same daily job so expired `webhook.secret.previous` rows don't
// sit around forever. The cleanup is cheap (one SELECT + one DELETE
// bounded by the number of recently-rotated shops).
import { clearExpiredPreviousSecrets } from '@gbox/core/modules/webhooks/hmac.js'
// Phase 2 Admin Polish §2.3 — piggyback the background-export file
// sweeper here too. The Redis meta TTLs itself out after 72h, but the
// CSV files on disk need an explicit `unlink`. Running this inside the
// same cron keeps the audit-retention story to one job.
import { pruneExpiredAuditExports } from '@gbox/core/modules/audit/background-export.js'

interface Args {
  days: number
  batchSize: number
  maxBatches: number
  dryRun: boolean
}

function parseArgs(argv: string[]): Args {
  const envDays = process.env.AUDIT_LOG_RETENTION_DAYS
  const out: Args = {
    days: envDays ? parseInt(envDays, 10) : 365,
    batchSize: 1000,
    maxBatches: 100,
    dryRun: false,
  }
  for (const a of argv) {
    if (a.startsWith('--days=')) {
      const n = parseInt(a.slice('--days='.length), 10)
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error('--days must be a positive integer')
      }
      out.days = n
    } else if (a.startsWith('--batch-size=')) {
      const n = parseInt(a.slice('--batch-size='.length), 10)
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error('--batch-size must be a positive integer')
      }
      out.batchSize = n
    } else if (a.startsWith('--max-batches=')) {
      const n = parseInt(a.slice('--max-batches='.length), 10)
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error('--max-batches must be a positive integer')
      }
      out.maxBatches = n
    } else if (a === '--dry-run') {
      out.dryRun = true
    }
  }
  if (!Number.isFinite(out.days) || out.days <= 0) {
    throw new Error(
      `invalid retention window: days=${out.days} (env AUDIT_LOG_RETENTION_DAYS=${envDays ?? 'unset'})`,
    )
  }
  return out
}

async function main(): Promise<number> {
  let args: Args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (err) {
    console.error(
      `[prune-audit-logs] bad args: ${err instanceof Error ? err.message : err}`,
    )
    return 2
  }

  const db = createDb()
  try {
    const statsBefore = await getAuditLogStats(db)

    console.log(
      `[prune-audit-logs] days=${args.days} batchSize=${args.batchSize} ` +
        `maxBatches=${args.maxBatches} dryRun=${args.dryRun}`,
    )
    console.log(
      `[prune-audit-logs] before: total=${statsBefore.total} ` +
        `oldest=${statsBefore.oldestIso ?? '-'} newest=${statsBefore.newestIso ?? '-'}`,
    )

    let result: PruneResult
    try {
      result = await pruneAuditLogs(db, {
        olderThanDays: args.days,
        batchSize: args.batchSize,
        maxBatches: args.maxBatches,
        dryRun: args.dryRun,
      })
    } catch (err) {
      console.error(
        `[prune-audit-logs] prune failed: ${err instanceof Error ? err.message : err}`,
      )
      return 2
    }

    // Phase 0 §8 Item #2 — clean up expired webhook.secret.previous
    // rows. Cheap enough to piggyback and avoids a second cron entry.
    let webhookSecretsCleared = 0
    if (!args.dryRun) {
      try {
        const out = await clearExpiredPreviousSecrets(db)
        webhookSecretsCleared = out.cleared
      } catch (err) {
        console.error(
          '[prune-audit-logs] clearExpiredPreviousSecrets failed:',
          err instanceof Error ? err.message : err,
        )
      }
    }

    // Phase 2 §2.3 — sweep background audit-export CSV files whose
    // parent Redis meta has already expired (or whose mtime is past
    // the TTL). Cheap: reads AUDIT_EXPORT_DIR once, stats each file.
    let exportFilesDeleted = 0
    let exportBytesReclaimed = 0
    if (!args.dryRun) {
      try {
        const out = await pruneExpiredAuditExports()
        exportFilesDeleted = out.files_deleted
        exportBytesReclaimed = out.bytes_reclaimed
      } catch (err) {
        console.error(
          '[prune-audit-logs] pruneExpiredAuditExports failed:',
          err instanceof Error ? err.message : err,
        )
      }
    }

    const statsAfter = args.dryRun
      ? statsBefore
      : await getAuditLogStats(db)

    const report = {
      script: 'prune-audit-logs',
      days: args.days,
      dryRun: args.dryRun,
      cutoffIso: result.cutoffIso,
      matched: result.matched,
      deleted: result.deleted,
      truncated: result.truncated,
      batches: result.batches,
      durationMs: result.durationMs,
      statsBefore,
      statsAfter,
      webhookSecretsCleared,
      exportFilesDeleted,
      exportBytesReclaimed,
    }

    console.log(
      `[prune-audit-logs] done: matched=${result.matched} ` +
        `deleted=${result.deleted} batches=${result.batches} ` +
        `truncated=${result.truncated} durationMs=${result.durationMs} ` +
        `exportFilesDeleted=${exportFilesDeleted} ` +
        `exportBytesReclaimed=${exportBytesReclaimed}`,
    )
    console.log(JSON.stringify(report))

    if (result.truncated) {
      console.warn(
        '[prune-audit-logs] TRUNCATED — maxBatches reached with rows still ' +
          'matching. Re-run to finish.',
      )
      return 1
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
      `[prune-audit-logs] uncaught: ${err instanceof Error ? err.stack : err}`,
    )
    process.exit(2)
  })
