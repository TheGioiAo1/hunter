/**
 * Public barrel for the Lenful fulfillment module.
 *
 * Only god-admin code should import from here. Seller code must not
 * reference any Lenful symbol — there's no CI check yet, so we rely
 * on code review + the DB trigger in migration 030.
 */

export * from './types.ts'
export { LenfulClient, LenfulApiError, LenfulAuthError } from './client.ts'
export {
  listCredentials,
  getActiveCredential,
  createCredential,
  updateCredential,
  deleteCredential,
  recordCredentialError,
  type LenfulCredentialPublic,
  type CreateCredentialInput,
  type UpdateCredentialInput,
} from './credentials.ts'
export {
  buildCreateOrderPayload,
  BuildError,
  type BuildErrorCode,
  type BuildInput,
  type BuildResult,
} from './builder.ts'
export { pushOrderToLenful, type PushOrderInput, type PushOrderResult } from './push-order.ts'
export {
  listGboxProductsWithMapping,
  listMappingsForProduct,
  saveMapping,
  deleteMapping,
  listDesignLibrary,
  upsertDesignRow,
  type LenfulMappingRow,
  type MappingListParams,
  type MappingListRow,
  type SaveMappingInput,
  type DesignLibraryRow,
} from './product-map.ts'
export {
  syncTrackingGlobal,
  syncTrackingForRow,
  type SyncResult,
  type SyncTrackingInput,
} from './tracking-sync.ts'
export {
  listRoutingRules,
  createRoutingRule,
  updateRoutingRule,
  deleteRoutingRule,
  evaluateRule,
  runAutoPushSweep,
  checkAutoPush,
  type RoutingRule,
  type CreateRoutingRuleInput,
  type AutoPushSweepResult,
} from './routing-rules.ts'
export {
  captureWalletSnapshot,
  getLatestSnapshot,
  listSnapshots,
  getThreshold,
  setThreshold,
  type WalletSnapshot,
  type CaptureResult,
} from './wallet-sync.ts'
export {
  registerLenfulCronHandlers,
  seedLenfulCronTasks,
  LENFUL_CRON_HANDLERS,
} from './cron-register.ts'
// Phase F8+ — local-v4 import fallback for the seller "Add to my store"
// button when no legacy_gbox_config is configured. Materializes a Lenful
// catalog entry as a draft Gbox product owned by the seller's own shop.
export {
  copyCatalogEntryToLocalProduct,
  type CopyCatalogEntryInput,
  type CopyCatalogEntryResult,
} from './copy-to-local.ts'
