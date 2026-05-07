/**
 * Customer CSV — Phase 4 PR4 barrel export.
 *
 * Consumers import from `@gbox/core/modules/customers/csv/index.js` to
 * reach the parser + plan builder + applier + exporter.
 */

export {
  CUSTOMER_CSV_COLUMNS,
  CUSTOMER_CSV_HEADERS,
  buildAliasMap,
  normalizeHeader,
  parseBooleanCell,
  encodeBooleanCell,
  parseTagsCell,
  encodeTagsCell,
  type CustomerCsvField,
  type CustomerCsvTarget,
  type CustomerCsvColumn,
} from './columns.js'

export {
  parseCustomersCsv,
  CustomerHeaderIndex,
  ParseError,
  type ParsedCustomer,
  type ParsedCustomerAddress,
  type ParsedCustomersCsv,
  type ParsedCustomerCsvNote,
} from './csv-parser.js'

export {
  customerToRow,
  exportCustomersCsv,
  exportCustomersCsvStream,
  type ExportCustomer,
  type ExportCustomerAddress,
} from './export.js'

export {
  buildImportPlan,
  type ImportAction,
  type ImportPlan,
  type ImportPlanItem,
  type ImportStats,
  type ValidationIssue,
} from './import-plan.js'

export {
  applyImportPlan,
  type ApplyResult,
  type ApplyItemResult,
} from './import-apply.js'
