/**
 * Sidecar config — loaded once at boot.
 *
 * Values are sourced from env. A few are hard-coded defaults that
 * match the master plan / infra_topology memory notes:
 *   PORT=4326          (god-admin owns :4324, we use :4326 to avoid
 *                       the conflict — noted in the plan deviation)
 *   BIND_ADDRESS=127.0.0.1  (never exposed to the public internet —
 *                       the god-admin app proxies through nginx)
 */

import { resolve } from 'node:path'

export interface SidecarConfig {
  port: number
  bindAddress: string
  internalJwtSecret: string
  killswitchFile: string
  promptFile: string
  promptName: string
  /** Directory the prompt loader reads from. Defaults to packages/agent-core/prompts. */
  promptsDir?: string
  repoRoot: string
  /** Max concurrent chat requests allowed. 1 = serial. */
  maxConcurrency: number
  /**
   * Window (ms) used by the circuit breaker to count errors.
   * Breaker opens when `errorCountWindow` errors happen within this
   * window.
   */
  circuitBreakerWindowMs: number
  circuitBreakerErrorThreshold: number
}

function required(name: string, value: string | undefined): string {
  if (!value || value.length === 0) {
    throw new Error(`${name} is required but not set`)
  }
  return value
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): SidecarConfig {
  const repoRoot = env.REPO_ROOT ?? resolve(process.cwd(), '..', '..')
  return {
    port: parseInt(env.AGENT_SIDECAR_PORT ?? '4326', 10),
    bindAddress: env.AGENT_SIDECAR_BIND ?? '127.0.0.1',
    internalJwtSecret: required('AGENT_INTERNAL_JWT_SECRET', env.AGENT_INTERNAL_JWT_SECRET),
    killswitchFile: env.AGENT_KILLSWITCH_FILE ?? resolve(repoRoot, '.agent-killswitch'),
    promptFile:
      env.AGENT_PROMPT_FILE ??
      resolve(repoRoot, 'packages/agent-core/prompts/god-admin-default.md'),
    promptName: env.AGENT_PROMPT_NAME ?? 'god-admin-default',
    ...(env.AGENT_PROMPTS_DIR ? { promptsDir: env.AGENT_PROMPTS_DIR } : {}),
    repoRoot,
    maxConcurrency: parseInt(env.AGENT_MAX_CONCURRENCY ?? '1', 10),
    circuitBreakerWindowMs: parseInt(env.AGENT_CB_WINDOW_MS ?? '60000', 10),
    circuitBreakerErrorThreshold: parseInt(env.AGENT_CB_THRESHOLD ?? '5', 10),
  }
}
