/**
 * Public entry point for @gbox/god-admin-agent — only used by tests
 * and other apps that want to boot the sidecar in-process. In prod,
 * PM2 invokes src/server.ts directly.
 */

export { buildApp, type BuildAppOptions } from './server.ts'
export { loadConfig, type SidecarConfig } from './config.ts'
export { createCircuitBreaker, type CircuitBreaker } from './circuit-breaker.ts'
export { createKillswitch, type Killswitch } from './killswitch.ts'
export { createPromptWatcher, type PromptWatcher, type PromptState } from './prompt-watcher.ts'
export { createJwtAuth, type JwtAuthOptions } from './middleware/jwt-auth.ts'
