/**
 * Gbox Platform — Platform Config barrel (Phase 2 Step 2.5)
 *
 * Re-exports the typed definitions + the storage-agnostic service
 * so consumers can import from a single path:
 *
 *   import {
 *     PLATFORM_SETTING_DEFS,
 *     PlatformConfigService,
 *     InMemoryPlatformSettingsStore,
 *   } from '@gbox/core/modules/platform-config'
 */

export {
  type PlatformSettingKind,
  type PlatformSettingOption,
  type PlatformSettingDef,
  type PlatformSettingKey,
  PLATFORM_SETTING_DEFS,
  PLATFORM_SETTING_MAP,
  groupByCategory,
  coerceValue,
  validateValue,
} from './definitions.js'

export {
  type PlatformSettingsStore,
  type ResolvedPlatformSetting,
  type ApplyChangeResult,
  InMemoryPlatformSettingsStore,
  PlatformConfigService,
} from './service.js'
