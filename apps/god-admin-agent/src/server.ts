/**
 * Gbox God-Admin AGENT Sidecar — Express server
 *
 * Port: 4326  (gbox-god-admin already owns :4324; master plan says
 *              :4324 but deploying there would collide — deviation
 *              recorded in the commit message for PR 5)
 * Bind: 127.0.0.1 (never exposed directly; nginx on server 1 proxies
 *              /god-admin/agent/* to us)
 *
 * Routes:
 *   GET  /_health             — liveness + breaker/killswitch state
 *   POST /agent/chat          — SSE chat turn (JWT required)
 *   POST /agent/kill          — abort in-flight turn (JWT required)
 *   GET  /agent/sessions/:aid — replay a session (JWT required)
 *
 * Wiring:
 *   - createDb()            from @gbox/db
 *   - createSessionManager  from @gbox/agent-core
 *   - createAgentRuntime    from @gbox/agent-core (with injected SdkQueryFn)
 *   - createDefaultRegistry from @gbox/agent-tools
 *   - killswitch + circuit breaker + prompt watcher
 *
 * The SDK query function is injected lazily so this file does not
 * hard-depend on @anthropic-ai/claude-agent-sdk at import time.
 * In prod we wire it via `./sdk-adapter.ts`. In smoke tests we
 * swap in a stub that emits a scripted event list.
 */

import { existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { config as dotenvConfig } from 'dotenv'
;(function loadRootEnv() {
  let dir = process.cwd()
  for (let i = 0; i < 8; i++) {
    const p = resolve(dir, '.env')
    if (existsSync(p)) { dotenvConfig({ path: p }); return }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
})()
import express from 'express'
import {
  createAgentRuntime,
  type SdkQueryFn,
  type SessionManager,
  type SessionListItem,
  type SessionReplayRow,
  type ChatMessage,
} from '@gbox/agent-core'
import { loadConfig, type SidecarConfig } from './config.ts'
import { createCircuitBreaker } from './circuit-breaker.ts'
import { createKillswitch } from './killswitch.ts'
import { createPromptWatcher } from './prompt-watcher.ts'
import { createJwtAuth } from './middleware/jwt-auth.ts'
import { createHealthRoute } from './routes/health.ts'
import { createChatRoute } from './routes/chat.ts'
import { createKillRoute } from './routes/kill.ts'
import { createSessionListRoute, createSessionsRoute } from './routes/sessions.ts'
import { createApprovalRoute } from './routes/approval.ts'
import { createApprovalRegistry } from './approval-registry.ts'

export interface BuildAppOptions {
  config: SidecarConfig
  sdkQuery: SdkQueryFn
  sessionManagerOverride?: SessionManager
}

function createInMemorySessionManager(): SessionManager & {
  rows: Map<string, SessionReplayRow>
} {
  const rows = new Map<string, SessionReplayRow>()
  let counter = 0
  return {
    rows,
    async openSession({ godAdminId, systemPromptVersion, model, tokenBudget }) {
      counter += 1
      const id = `aid-${counter.toString().padStart(4, '0')}`
      rows.set(id, {
        id,
        godAdminId,
        startedAt: new Date().toISOString(),
        endedAt: null,
        endedReason: null,
        promptCount: 0,
        toolCallCount: 0,
        toolCallRejectedCount: 0,
        approvalCount: 0,
        approvalDeniedCount: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        costUsd: '0.000000',
        conversation: [] as ChatMessage[],
        compactedContext: null,
        compactCount: 0,
        systemPromptVersion,
        model: model ?? 'claude-sonnet-4-5',
      } as SessionReplayRow & { tokenBudget?: number })
      return id
    },
    async appendMessage({ aid, message }) {
      const row = rows.get(aid)
      if (!row) return
      ;(row.conversation as ChatMessage[]).push(message)
    },
    async updateMetrics(input) {
      const row = rows.get(input.aid)
      if (!row) return
      if (input.inputTokensDelta !== undefined) row.totalInputTokens += input.inputTokensDelta
      if (input.outputTokensDelta !== undefined) row.totalOutputTokens += input.outputTokensDelta
      if (input.toolCallDelta !== undefined) row.toolCallCount += input.toolCallDelta
      if (input.toolCallRejectedDelta !== undefined) row.toolCallRejectedCount += input.toolCallRejectedDelta
      if (input.approvalDelta !== undefined) row.approvalCount += input.approvalDelta
      if (input.approvalDeniedDelta !== undefined) row.approvalDeniedCount += input.approvalDeniedDelta
      if (input.promptCountDelta !== undefined) row.promptCount += input.promptCountDelta
      if (input.costUsdDelta !== undefined) {
        const next = Number(row.costUsd) + input.costUsdDelta
        row.costUsd = next.toFixed(6)
      }
    },
    async closeSession({ aid, reason }) {
      const row = rows.get(aid)
      if (!row || row.endedAt) return
      row.endedAt = new Date().toISOString()
      row.endedReason = reason
    },
    async getReplay(aid) {
      return rows.get(aid) ?? null
    },
    async listSessions(input = {}) {
      const limit = Math.min(Math.max(input.limit ?? 50, 1), 200)
      let items = [...rows.values()]
      if (input.godAdminId) items = items.filter((r) => r.godAdminId === input.godAdminId)
      if (input.beforeCursor) items = items.filter((r) => r.startedAt < input.beforeCursor!)
      items.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))
      return items.slice(0, limit).map((row) => {
        const firstUser = (row.conversation as ChatMessage[]).find((m) => m.role === 'user')
        return {
          id: row.id,
          godAdminId: row.godAdminId,
          startedAt: row.startedAt,
          endedAt: row.endedAt,
          endedReason: row.endedReason,
          promptCount: row.promptCount,
          toolCallCount: row.toolCallCount,
          costUsd: row.costUsd,
          firstUserMessage: firstUser ? String(firstUser.content).slice(0, 160) : null,
        } satisfies SessionListItem
      })
    },
  }
}

export async function buildApp(opts: BuildAppOptions): Promise<{
  app: express.Express
  shutdown: () => Promise<void>
  promptWatcher: Awaited<ReturnType<typeof createPromptWatcher>>
}> {
  const startedAt = new Date()
  const sessionManager = opts.sessionManagerOverride ?? createInMemorySessionManager()
  const runtime = createAgentRuntime({ query: opts.sdkQuery })
  // Approval registry is shared between the chat route (registers pending
  // approvals when an `approval_required` SSE event goes out) and the
  // approval route (resolves them when the human clicks Approve/Deny).
  const approvalRegistry = createApprovalRegistry()

  const circuitBreaker = createCircuitBreaker({
    windowMs: opts.config.circuitBreakerWindowMs,
    errorThreshold: opts.config.circuitBreakerErrorThreshold,
  })

  const killswitch = createKillswitch({
    filePath: opts.config.killswitchFile,
    pollMs: 2000,
    onEngaged: (reason) => {
      // Open the breaker as well so any request that slips past the
      // killswitch check in chat.ts still fails fast.
      circuitBreaker.recordError()
      circuitBreaker.recordError()
      circuitBreaker.recordError()
      circuitBreaker.recordError()
      circuitBreaker.recordError()
      console.warn(`[agent-sidecar] killswitch engaged: ${reason}`)
    },
    onDisengaged: () => {
      console.warn('[agent-sidecar] killswitch disengaged')
    },
  })

  const promptWatcher = await createPromptWatcher({
    filePath: opts.config.promptFile,
    promptName: opts.config.promptName,
    ...(opts.config.promptsDir ? { promptsDir: opts.config.promptsDir } : {}),
    onChange: (state) => {
      console.warn(`[agent-sidecar] prompt hot-reloaded: ${state.hash}`)
    },
  })
  await promptWatcher.start()
  killswitch.start()

  const app = express()
  app.disable('x-powered-by')
  app.use(express.json({ limit: '1mb' }))

  const jwtAuth = createJwtAuth({ secret: opts.config.internalJwtSecret })

  // Public: health endpoint. No JWT — binding is 127.0.0.1 and the
  // dashboard proxy is the only external route that hits us.
  app.get(
    '/_health',
    createHealthRoute({
      startedAt,
      circuitBreaker,
      killswitch,
      promptWatcher,
      port: opts.config.port,
    }),
  )

  // Protected: agent routes require the short-lived JWT.
  app.post(
    '/agent/chat',
    jwtAuth,
    createChatRoute({
      runtime,
      sessionManager,
      circuitBreaker,
      killswitch,
      promptWatcher,
      approvalRegistry,
    }),
  )

  app.post('/agent/kill', jwtAuth, createKillRoute({ runtime, sessionManager }))
  app.get('/agent/sessions', jwtAuth, createSessionListRoute({ sessionManager }))
  app.get('/agent/sessions/:aid', jwtAuth, createSessionsRoute({ sessionManager }))
  app.post('/agent/approval', jwtAuth, createApprovalRoute({ approvalRegistry }))

  // Unknown route → 404 JSON.
  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found' })
  })

  return {
    app,
    promptWatcher,
    async shutdown() {
      killswitch.stop()
      promptWatcher.stop()
    },
  }
}

/**
 * Module entry point. `npm run start` from apps/god-admin-agent
 * lands here.
 */
async function main(): Promise<void> {
  const config = loadConfig()

  // Lazy-import the SDK adapter so import-time failures in the SDK
  // don't crash `tsc --noEmit` or unit tests that don't need it.
  //
  // The adapter needs the prompt watcher so every query() call reads
  // the current (hot-reloaded) system prompt without a restart. But
  // the watcher is created inside buildApp(), so we need a two-phase
  // wiring: build with a lazy SdkQueryFn that forwards to a mutable
  // slot, then fill the slot after buildApp() returns with the real
  // adapter.
  let realQuery: SdkQueryFn | null = null
  const lazySdkQuery: SdkQueryFn = async function* lazy(args) {
    if (!realQuery) {
      yield { type: 'error', message: 'sdk adapter not yet initialised' }
      return
    }
    yield* realQuery(args)
  }

  const { app, shutdown, promptWatcher } = await buildApp({
    config,
    sdkQuery: lazySdkQuery,
  })

  const { createSdkQuery } = await import('./sdk-adapter.ts')
  realQuery = createSdkQuery({ promptWatcher })
  const server = app.listen(config.port, config.bindAddress, () => {
    console.log(
      `[agent-sidecar] listening on http://${config.bindAddress}:${config.port}`,
    )
  })

  const shutdownHandler = async (signal: string): Promise<void> => {
    console.log(`[agent-sidecar] ${signal} received, shutting down`)
    server.close()
    await shutdown()
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdownHandler('SIGTERM'))
  process.on('SIGINT', () => void shutdownHandler('SIGINT'))
}

// Only run main() when invoked directly, not when imported for tests.
const isDirectRun =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('server.ts')
if (isDirectRun) {
  void main().catch((err) => {
    console.error('[agent-sidecar] fatal:', err)
    process.exit(1)
  })
}
