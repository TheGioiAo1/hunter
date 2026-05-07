/**
 * Public barrel for the legacy Gbox integration module.
 *
 * Import sites:
 *   - apps/god-admin/src/pages/integrations-gbox-legacy.ts (config UI)
 *   - apps/store-admin/src/pages/products.ts              (push handler)
 *
 * Nothing else should reach into individual files.
 */

export * from './types.ts'
export {
  listConfigs,
  getActiveConfig,
  getActiveConfigResolved,
  getConfigById,
  createConfig,
  updateConfig,
  deleteConfig,
  markLoginOk,
  markLoginError,
  bumpPushCount,
  type LegacyGboxConfigPublic,
  type LegacyGboxConfigResolved,
  type CreateConfigInput,
  type UpdateConfigInput,
} from './config.ts'
export {
  loginLegacy,
  getValidToken,
  createLegacyProduct,
  fetchMyShops,
  type LoginResult,
  type CreateProductInput,
  type MyShopsResult,
} from './client.ts'
export { mapLenfulEntryToLegacyProduct } from './product-map.ts'
export {
  recordPush,
  listRecentPushes,
  type RecordPushInput,
  type RecentPushRow,
} from './push-log.ts'
export {
  getCachedToken,
  storeToken,
  invalidateToken,
} from './token-cache.ts'
