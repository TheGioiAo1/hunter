/**
 * Gbox Platform — Media Module Entry Point
 *
 * Phase B — CDN pipeline (spec §10-12, §16).
 *
 * Re-exports the imgproxy signer (low-level) and the `cdnImage()` helper
 * (storefront-friendly wrapper). Consumers should import from this file
 * so internal module structure can be rearranged later without churning
 * every call site.
 *
 *   import { cdnImage, cdnSrcSet, defaultSrcSet } from '@gbox/core/media'
 *   import { signImgproxyUrl, readImgproxyConfigFromEnv } from '@gbox/core/media'
 */

export {
  IMGPROXY_SIGNATURE_SIZE,
  WIDTH_BUCKETS,
  type WidthBucket,
  type ImgproxyOptions,
  type ImgproxySignerConfig,
  type SignImgproxyUrlInput,
  isHexKey,
  normalizeWidth,
  buildProcessingOptions,
  base64urlEncode,
  signImgproxyPath,
  signImgproxyUrl,
  readImgproxyConfigFromEnv,
  preWarmUrls,
} from './imgproxy.js'

export {
  type MediaAssetLike,
  cdnImage,
  cdnSrcSet,
  defaultSrcSet,
  cdnThemeLibraryAsset,
} from './cdn.js'
