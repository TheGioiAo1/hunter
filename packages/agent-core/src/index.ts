/**
 * @gbox/agent-core — public entry point
 *
 * Exports only the stable surface consumed by the sidecar and UI.
 * Internal helpers (prompt-loader cache, session-manager internals)
 * are accessible via subpath imports when needed.
 */

export * from './types.ts'
export {
  signInternalJwt,
  verifyInternalJwt,
  InvalidJwtError,
} from './jwt.ts'
export { encodeSseEvent, sseKeepAlive } from './sse-stream.ts'
export { countTokens } from './token-counter.ts'
export { createSessionManager } from './session-manager.ts'
export type {
  SessionManager,
  SessionReplayRow,
  SessionListItem,
  ListSessionsInput,
} from './session-manager.ts'
export { compactConversation } from './compaction.ts'
export { loadPrompt, hashPrompt } from './prompt-loader.ts'
export { createAgentRuntime } from './agent-runtime.ts'
export type { SdkEvent, SdkQueryArgs, SdkQueryFn } from './agent-runtime.ts'
