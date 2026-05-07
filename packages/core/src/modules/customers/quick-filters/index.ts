/**
 * Customer quick-filters — public API.
 *
 * Kept flat (no sub-namespace) because the handler imports both types
 * and functions and hates two-import lines.
 */

export {
  listQuickFilters,
  getQuickFilter,
  saveQuickFilter,
  updateQuickFilter,
  deleteQuickFilter,
  reorderQuickFilters,
  normalizeQuickFilterQuery,
  queryToParams,
  paramsToQuery,
} from './service.js'

export type {
  QuickFilter,
  QuickFilterQuery,
  CreateQuickFilterInput,
} from './service.js'
