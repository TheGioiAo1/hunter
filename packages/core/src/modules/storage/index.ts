/**
 * Gbox Platform — Storage Module Entry Point
 *
 * Phase B + Decision #1 Step 1.2a — factory that returns the appropriate
 * `ObjectStore` for each bucket role.
 *
 * Four bucket roles (spec §4.1):
 *
 *   - PUBLIC_MEDIA   `gbox-public-media-prod`    — shop images/videos/themes
 *   - THEME_LIBRARY  `gbox-theme-library-prod`   — platform-curated theme marketplace
 *   - PRIVATE        `gbox-private-prod`         — downloads, invoices, exports, POD
 *   - BACKUPS        `gbox-backups-prod`         — DB dumps, audit logs (admin-only)
 *
 * Plus the LEGACY role:
 *   - LEGACY_THEME   R2 bucket `gbox-theme-assets` — theme engine assets from
 *     Phase 1 that have not yet migrated. Kept as a separate accessor so the
 *     migration to S3 (spec §21) can flip buckets one at a time without
 *     breaking the theme engine mid-cutover.
 *
 * Rules:
 *   - Production (`NODE_ENV === 'production'`): require the matching env
 *     vars or throw. No silent MemoryStore fallback in prod.
 *   - Dev/test: if env vars are set use S3/R2, otherwise MemoryStore.
 *   - Singletons are cached per-process AND per-role. Call
 *     `resetObjectStores()` to clear all caches at once (tests).
 *
 * Why one singleton per role instead of "one store per bucket name":
 *   Callers want semantics ("I'm writing a public image") not mechanics
 *   ("bucket name X in region Y"). The factory hides bucket naming
 *   conventions so renaming a bucket in AWS is a one-line env change
 *   here, not a 200-site grep-and-replace in application code.
 */

export type { ObjectStore, PutOptions, UrlOptions } from './interface.js'
export { MemoryStore } from './memory-store.js'
export { R2Store, type R2StoreConfig } from './r2-store.js'
export { S3Store, type S3StoreConfig } from './s3-store.js'

import { MemoryStore } from './memory-store.js'
import { R2Store, type R2StoreConfig } from './r2-store.js'
import { S3Store, type S3StoreConfig } from './s3-store.js'
import type { ObjectStore } from './interface.js'

/**
 * Role enum — matches spec §4.1 bucket purposes.
 */
export type BucketRole =
  | 'public-media'
  | 'theme-library'
  | 'private'
  | 'backups'
  | 'legacy-theme'

// ---------------------------------------------------------------------------
// Legacy R2 config reader (Phase 1 theme assets — still lives on R2 until the
// migration in spec §21). Kept verbatim from the pre-Phase-B implementation.
// ---------------------------------------------------------------------------

export function readR2ConfigFromEnv(): R2StoreConfig | null {
  const endpoint = process.env.R2_ENDPOINT
  const accessKeyId = process.env.R2_ACCESS_KEY_ID
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY
  const bucket = process.env.R2_BUCKET || 'gbox-theme-assets'
  const publicBaseUrl = process.env.R2_PUBLIC_BASE_URL || 'https://cdn.gbox.co'

  if (!endpoint || !accessKeyId || !secretAccessKey) return null

  return { endpoint, accessKeyId, secretAccessKey, bucket, publicBaseUrl }
}

// ---------------------------------------------------------------------------
// S3 config reader — Phase B. One factory per role; each returns `null` if
// the relevant env var is missing so the caller can decide fallback policy.
// ---------------------------------------------------------------------------

/**
 * Read generic AWS env vars shared by every S3Store instance.
 *
 * We intentionally do NOT require explicit access key env vars — in
 * production the expected pattern is an IAM role attached to the EC2 /
 * ECS task, which the AWS SDK picks up automatically. Explicit creds are
 * only needed for local dev + CI live tests.
 */
function readAwsBaseConfig(): { region: string; accessKeyId?: string; secretAccessKey?: string } {
  return {
    region: process.env.AWS_REGION || 'ap-southeast-1',
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  }
}

export function readS3PublicMediaConfigFromEnv(): S3StoreConfig | null {
  const bucket = process.env.S3_PUBLIC_BUCKET
  if (!bucket) return null
  return {
    ...readAwsBaseConfig(),
    bucket,
    publicBaseUrl: process.env.CDN_PUBLIC_BASE_URL || 'https://cdn.gbox.co',
  }
}

export function readS3ThemeLibraryConfigFromEnv(): S3StoreConfig | null {
  const bucket = process.env.S3_THEME_LIBRARY_BUCKET
  if (!bucket) return null
  return {
    ...readAwsBaseConfig(),
    bucket,
    // Theme library shares the same Cloudflare zone but path-scoped
    // (cdn.gbox.co/themes/* → S3_THEME via origin rule). Override lets
    // callers point at a dedicated zone later without code changes.
    publicBaseUrl: process.env.CDN_THEME_LIBRARY_BASE_URL || 'https://cdn.gbox.co',
  }
}

export function readS3PrivateConfigFromEnv(): S3StoreConfig | null {
  const bucket = process.env.S3_PRIVATE_BUCKET
  if (!bucket) return null
  return {
    ...readAwsBaseConfig(),
    bucket,
    // No publicBaseUrl — forces every url() call through the
    // `s3-signed://` sentinel. Callers MUST use signedUrl() or go
    // through the download.gbox.co Worker.
    defaultCacheControl: 'private, no-store',
  }
}

export function readS3BackupsConfigFromEnv(): S3StoreConfig | null {
  const bucket = process.env.S3_BACKUPS_BUCKET
  if (!bucket) return null
  return {
    ...readAwsBaseConfig(),
    bucket,
    defaultCacheControl: 'private, no-store',
  }
}

// ---------------------------------------------------------------------------
// Cached singletons — one slot per role.
// ---------------------------------------------------------------------------

const cache = new Map<BucketRole, ObjectStore>()

/**
 * Build the store for the requested role. Used internally by the role
 * accessors; exposed for tests / diagnostics.
 */
function buildStoreForRole(role: BucketRole): ObjectStore {
  switch (role) {
    case 'public-media': {
      const cfg = readS3PublicMediaConfigFromEnv()
      if (cfg) return new S3Store(cfg)
      break
    }
    case 'theme-library': {
      const cfg = readS3ThemeLibraryConfigFromEnv()
      if (cfg) return new S3Store(cfg)
      break
    }
    case 'private': {
      const cfg = readS3PrivateConfigFromEnv()
      if (cfg) return new S3Store(cfg)
      break
    }
    case 'backups': {
      const cfg = readS3BackupsConfigFromEnv()
      if (cfg) return new S3Store(cfg)
      break
    }
    case 'legacy-theme': {
      const cfg = readR2ConfigFromEnv()
      if (cfg) return new R2Store(cfg)
      break
    }
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      `Storage: role "${role}" is not configured. NODE_ENV=production but the required ` +
        `env vars (AWS_REGION + S3_*_BUCKET, or R2_* for legacy-theme) are missing. ` +
        'Refusing to use MemoryStore in production.',
    )
  }

  return new MemoryStore()
}

/**
 * Public-media bucket — shop images/videos/themes. Fronted by Cloudflare
 * at `cdn.gbox.co`. Default target for product/collection/review uploads.
 */
export function getPublicMediaStore(): ObjectStore {
  const cached = cache.get('public-media')
  if (cached) return cached
  const store = buildStoreForRole('public-media')
  cache.set('public-media', store)
  return store
}

/**
 * Theme library bucket — platform-curated theme marketplace. Only
 * god-admin + GitHub Actions OIDC can write here. Fronted by Cloudflare
 * at `cdn.gbox.co/themes/*`.
 */
export function getThemeLibraryStore(): ObjectStore {
  const cached = cache.get('theme-library')
  if (cached) return cached
  const store = buildStoreForRole('theme-library')
  cache.set('theme-library', store)
  return store
}

/**
 * Private bucket — signed-URL-only. Digital downloads, invoices,
 * exports, POD files. Never fronted by Cloudflare directly; the
 * `download.gbox.co` Worker (spec §10.5) issues presigned URLs after
 * validating a JWT.
 */
export function getPrivateStore(): ObjectStore {
  const cached = cache.get('private')
  if (cached) return cached
  const store = buildStoreForRole('private')
  cache.set('private', store)
  return store
}

/**
 * Backups bucket — DB dumps, audit logs, admin-only. Lifecycle rules
 * push to Glacier after the retention window (spec §8.4). Never exposed
 * to public or seller-facing code paths.
 */
export function getBackupsStore(): ObjectStore {
  const cached = cache.get('backups')
  if (cached) return cache.get('backups')!
  const store = buildStoreForRole('backups')
  cache.set('backups', store)
  return store
}

/**
 * Legacy R2 theme-assets store. Still wired for the Phase 1 theme
 * engine. Will be retired after the §21 migration to S3 public-media
 * completes.
 */
export function getLegacyThemeStore(): ObjectStore {
  const cached = cache.get('legacy-theme')
  if (cached) return cached
  const store = buildStoreForRole('legacy-theme')
  cache.set('legacy-theme', store)
  return store
}

// ---------------------------------------------------------------------------
// Back-compat shim — theme engine & tests call `getObjectStore()` expecting
// the ONE store from Phase 1. Route it to the legacy R2 store until the §21
// migration lands, then flip to public-media.
// ---------------------------------------------------------------------------

/**
 * @deprecated Prefer `getPublicMediaStore()`, `getThemeLibraryStore()`,
 * `getPrivateStore()`, or `getBackupsStore()` depending on asset type.
 *
 * Kept for back-compat with the Phase 1 theme engine; returns the
 * legacy R2 store. Will be removed after spec §21 migration.
 */
export function getObjectStore(): ObjectStore {
  return getLegacyThemeStore()
}

/**
 * Reset every cached store. Primarily for tests that need a fresh
 * instance between cases (e.g. when swapping env vars).
 */
export function resetObjectStores(): void {
  cache.clear()
}

/**
 * @deprecated Use `resetObjectStores()`. Kept for back-compat.
 */
export function resetObjectStore(): void {
  resetObjectStores()
}

/**
 * Override the cached store for a specific role. Primarily for tests
 * that want to inject a MemoryStore seeded with fixture data.
 */
export function setObjectStore(role: BucketRole, store: ObjectStore): void
export function setObjectStore(store: ObjectStore): void
export function setObjectStore(roleOrStore: BucketRole | ObjectStore, maybeStore?: ObjectStore) {
  if (typeof roleOrStore === 'string') {
    cache.set(roleOrStore, maybeStore!)
  } else {
    // Back-compat single-arg form: override the legacy slot.
    cache.set('legacy-theme', roleOrStore)
  }
}
