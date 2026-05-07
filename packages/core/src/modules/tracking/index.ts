/**
 * Public barrel for the multi-pixel tracking module.
 *
 * Consumers:
 *   - store-admin: pixel manager UI (config CRUD)
 *   - storefront: pixel injector middleware (client-snippet)
 *   - platform-api: /api/track handler (dispatch-server, dedupe)
 */

export * from './types.ts'
export { partnerEventName } from './event-map.ts'
export {
  listPixels,
  listActivePixels,
  listActivePixelsWithTokens,
  getPixel,
  createPixel,
  updatePixel,
  deletePixel,
  setPixelActive,
} from './config.ts'
export { newEventId, claimEventId, type ClaimResult } from './dedupe.ts'
export {
  dispatchServerSide,
  type DispatchAttempt,
  type DispatchResult,
} from './dispatch-server.ts'
export { buildClientSnippet, type BuildSnippetInput } from './client-snippet.ts'
