/**
 * Gbox Platform — Activity Audit Trail module
 *
 * Barrel re-export. See `./types.ts` for the action taxonomy and
 * `./service.ts` for the Kysely-backed read/write API.
 */

export type {
  ActivityAction,
  ActivityCategory,
  ActivityRecord,
  ActivityResourceType,
  AuthAction,
  CatalogAction,
  CustomerAction,
  FinanceAction,
  ListActivityOptions,
  OrderAction,
  PlatformAction,
  RecordActivityInput,
  StoreAction,
  UserAction,
} from './types.js'

export { categorizeAction, humanizeAction } from './types.js'

export {
  listActivity,
  listActivityForResource,
  recordActivity,
} from './service.js'
