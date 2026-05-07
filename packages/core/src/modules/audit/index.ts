/**
 * Audit module barrel — Phase 0 §8 Item #6.
 *
 * Re-exports the retention + export helpers so callers can import
 * from `@gbox/core/modules/audit` instead of reaching into the two
 * submodules directly.
 */

export {
  pruneAuditLogs,
  getAuditLogStats,
  type PruneOptions,
  type PruneResult,
} from './retention.js'

export {
  fetchAuditLogsForExport,
  rowsToCsv,
  buildExportFilename,
  type ExportFilters,
  type ExportRow,
} from './export.js'
