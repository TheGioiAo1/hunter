/**
 * Security Module — Input Validation, Rate Limiting, Security Headers, CORS
 *
 * Centralized security utilities for all Gbox Platform servers.
 */

export { schemas, validate, sanitize } from './validation.js'
export {
  createRateLimiter,
  authLimiter,
  apiLimiter,
  apiReadLimiter,
  strictLimiter,
  pageLimiter,
  checkoutLimiter,
  paymentLimiter,
  refundLimiter,
} from './rate-limit.js'
export { securityHeaders } from './headers.js'
export { corsConfig, adminCorsConfig, dynamicShopCors } from './cors.js'
export { requireScope } from './scopes.js'
export type { Scope } from './scopes.js'
export { safeOrderBy } from './safe-order-by.js'
export type { OrderBySpec } from './safe-order-by.js'
export {
  detectFileType,
  assertAllowedFileType,
  validateUploadedFile,
  SIGNATURES,
} from './file-validation.js'
export { sanitizeHtml, stripHtml } from './sanitize-html.js'
export {
  sanitizeForResponse,
  type SanitizeOptions,
} from './sanitize.js'
export {
  sanitizeResponseMiddleware,
  type SanitizeMiddlewareOptions,
} from './sanitize-middleware.js'
