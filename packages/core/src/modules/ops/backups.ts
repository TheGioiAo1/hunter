/**
 * Gbox Platform — Backup Inventory Helpers (Phase 6.2)
 *
 * Pure functions for parsing and reasoning about Postgres backup
 * snapshots produced by `scripts/ops/backup-postgres.sh`. The shape
 * the bash script writes is `gbox-<dbname>-<ISO8601 compact>.sql.gz`,
 * e.g. `gbox-gbox_platform-20260409T023000Z.sql.gz`.
 *
 * Why pure functions instead of a Service class? Listing files is the
 * caller's responsibility (Node fs, Cloudflare R2 API, S3 API, …) so
 * the same helpers serve both a local cron + a god-admin UI that
 * wants to surface "last backup", "total snapshots", "stale flag" etc.
 *
 * The god-admin dashboard imports `summariseBackups` to render the
 * "Backup status" card. The cron prune script imports
 * `pickStaleBackups` to decide which files to delete.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BackupEntry {
  /** Filename as listed on disk / in object storage. */
  filename: string
  /** Database name extracted from the filename. */
  database: string
  /** Wall-clock time the snapshot was taken (UTC). */
  takenAt: Date
  /** File size in bytes — caller fills this in from `fs.stat`. */
  sizeBytes: number
}

export interface ParsedBackup {
  database: string
  takenAt: Date
}

export interface BackupSummary {
  count: number
  /** Newest snapshot, or null when no backups exist. */
  latest: BackupEntry | null
  /** Sum of `sizeBytes` across every snapshot. */
  totalBytes: number
  /** Hours elapsed between `latest.takenAt` and `now`. */
  hoursSinceLatest: number | null
  /** healthy = within freshnessHours, stale = older, missing = none. */
  status: 'healthy' | 'stale' | 'missing'
}

export interface SummariseOptions {
  /** Defaults to `new Date()` so callers don't need to inject in production. */
  now?: Date
  /**
   * "Healthy" cutoff in hours. Defaults to 26 — gives a 2-hour grace
   * window on a nightly cron so a 30-minute backup that ran late
   * doesn't trip a false alarm.
   */
  freshnessHours?: number
}

export interface PickStaleOptions {
  now?: Date
  /** Snapshots older than this become candidates for deletion. */
  retainDays: number
}

// ---------------------------------------------------------------------------
// parseBackupFilename
// ---------------------------------------------------------------------------

// Filename grammar: `gbox-<db>-<YYYYMMDDTHHMMSSZ>.sql.gz`
//
// `<db>` may itself contain underscores or hyphens. We anchor on the
// trailing timestamp + extension and treat everything between
// `gbox-` and `-<timestamp>` as the database name. The bash script
// only generates utc timestamps, so the parser refuses anything
// without the trailing `Z`.
const FILENAME_RE =
  /^gbox-(.+?)-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.sql\.gz$/

export function parseBackupFilename(filename: string): ParsedBackup | null {
  const match = FILENAME_RE.exec(filename)
  if (!match) return null
  const [, database, y, m, d, h, mm, s] = match
  // Use Date.UTC so the parsed timestamp is timezone-stable on every host.
  const takenAt = new Date(
    Date.UTC(
      Number(y),
      Number(m) - 1,
      Number(d),
      Number(h),
      Number(mm),
      Number(s),
    ),
  )
  if (Number.isNaN(takenAt.getTime())) return null
  return { database: database!, takenAt }
}

// ---------------------------------------------------------------------------
// summariseBackups
// ---------------------------------------------------------------------------

export function summariseBackups(
  backups: BackupEntry[],
  opts: SummariseOptions = {},
): BackupSummary {
  const now = opts.now ?? new Date()
  const freshnessHours = opts.freshnessHours ?? 26

  if (backups.length === 0) {
    return {
      count: 0,
      latest: null,
      totalBytes: 0,
      hoursSinceLatest: null,
      status: 'missing',
    }
  }

  // Sort newest-first without mutating the caller's array.
  const sorted = [...backups].sort(
    (a, b) => b.takenAt.getTime() - a.takenAt.getTime(),
  )
  const latest = sorted[0]!
  const totalBytes = sorted.reduce((sum, b) => sum + b.sizeBytes, 0)
  const hoursSinceLatest = Math.floor(
    (now.getTime() - latest.takenAt.getTime()) / 3_600_000,
  )

  // Negative hours (backup taken in the future, e.g. clock skew) is
  // technically "fresh", so clamp at 0 for display.
  const hoursForStatus = Math.max(hoursSinceLatest, 0)
  const status: BackupSummary['status'] =
    hoursForStatus <= freshnessHours ? 'healthy' : 'stale'

  return {
    count: sorted.length,
    latest,
    totalBytes,
    hoursSinceLatest,
    status,
  }
}

// ---------------------------------------------------------------------------
// pickStaleBackups
// ---------------------------------------------------------------------------

export function pickStaleBackups(
  backups: BackupEntry[],
  opts: PickStaleOptions,
): BackupEntry[] {
  const now = opts.now ?? new Date()
  const cutoffMs = now.getTime() - opts.retainDays * 86_400_000
  return backups.filter((b) => b.takenAt.getTime() < cutoffMs)
}
