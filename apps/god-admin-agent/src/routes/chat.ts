/**
 * POST /agent/chat — SSE-streamed chat turn.
 *
 * Request body:
 *   { "aid": "<existing session id or null>", "text": "<user message>" }
 *
 * If `aid` is null, the sidecar opens a new session first and reports
 * the new id back as the first `session_opened` event.
 *
 * The response is Server-Sent Events (`text/event-stream`). We reuse
 * the event types defined in @gbox/agent-core/types.ts and the
 * `encodeSseEvent` helper so the wire format stays identical to what
 * the ChatPanel.vue composable (PR 6) expects.
 *
 * Flow:
 *  1. Reject early if the circuit breaker is open or killswitch is engaged.
 *  2. Verify the JWT (middleware).
 *  3. Open session if aid is null.
 *  4. Append the user message.
 *  5. Stream the runtime's events back; persist assistant/tool events
 *     into the conversation JSONB as they arrive.
 *  6. Close connection cleanly on `done`.
 */

import type { Request, Response } from 'express'
import {
  encodeSseEvent,
  sseKeepAlive,
  type AgentRuntime,
  type ChatMessage,
  type SessionManager,
  type SseEvent,
} from '@gbox/agent-core'
import type { CircuitBreaker } from '../circuit-breaker.ts'
import type { Killswitch } from '../killswitch.ts'
import type { PromptWatcher } from '../prompt-watcher.ts'
import type { ApprovalRegistry } from '../approval-registry.ts'

export interface ChatDeps {
  runtime: AgentRuntime
  sessionManager: SessionManager
  circuitBreaker: CircuitBreaker
  killswitch: Killswitch
  promptWatcher: PromptWatcher
  approvalRegistry: ApprovalRegistry
}

/**
 * Per-session sequence counter. The sidecar runs single-process so
 * an in-memory map is safe. On restart, counters reset — which is
 * fine because a new chat turn from the UI after a restart starts
 * a new session id anyway.
 */
const seqByAid = new Map<string, number>()

function nextSeq(aid: string): number {
  const n = (seqByAid.get(aid) ?? -1) + 1
  seqByAid.set(aid, n)
  return n
}

function nowIso(): string {
  return new Date().toISOString()
}

export function createChatRoute(deps: ChatDeps) {
  return async function chatRoute(req: Request, res: Response): Promise<void> {
    // Fast-fail if the breaker is open or killswitch is engaged.
    if (deps.killswitch.isEngaged()) {
      res.status(503).json({ error: 'killswitch_engaged' })
      return
    }
    if (deps.circuitBreaker.isOpen()) {
      res.status(503).json({ error: 'circuit_breaker_open' })
      return
    }

    const body = req.body as { aid?: string | null; text?: string } | undefined
    const userText = body?.text
    if (typeof userText !== 'string' || userText.length === 0) {
      res.status(400).json({ error: 'text_required' })
      return
    }

    // Resolve session id — open a new row if the client didn't provide one.
    let aid: string
    if (typeof body?.aid === 'string' && body.aid.length > 0) {
      aid = body.aid
    } else {
      const godAdminId = req.jwt?.sid ?? 'god_admin_default'
      aid = await deps.sessionManager.openSession({
        godAdminId,
        systemPromptVersion: deps.promptWatcher.current().hash,
      })
    }

    // Start SSE response.
    res.status(200)
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no') // disable nginx buffering
    res.flushHeaders?.()

    // Heartbeat every 15s so proxies don't drop idle streams.
    const keepAlive = setInterval(() => {
      try {
        res.write(sseKeepAlive().bytes)
      } catch {
        /* client gone — cleanup happens in req.on('close') */
      }
    }, 15_000)
    if (typeof keepAlive.unref === 'function') keepAlive.unref()

    // Announce the session id immediately so the client can persist it.
    res.write(`event: session_opened\ndata: ${JSON.stringify({ aid })}\n\n`)

    // Persist the user message before we kick the runtime.
    const userMsg: ChatMessage = {
      seq: nextSeq(aid),
      role: 'user',
      content: userText,
      createdAt: nowIso(),
    }
    await deps.sessionManager.appendMessage({ aid, message: userMsg })

    // Build abort signal for the runtime. Abort when:
    //  - the HTTP connection closes
    //  - killswitch engages mid-stream
    const abortController = new AbortController()
    req.on('close', () => abortController.abort())

    // Track approval disposers opened during this turn so that if the
    // SSE stream closes before the human responds, we clean up the
    // in-memory registry entries (their timers would eventually fire,
    // but disposing explicitly keeps size() accurate in logs/metrics).
    const openApprovalDisposers: Array<() => void> = []

    let hadError = false

    try {
      await deps.runtime.sendMessage(aid, userText, {
        signal: abortController.signal,
        onEvent: async (evt: SseEvent): Promise<void> => {
          // Mirror assistant + tool events into the conversation JSONB.
          // Heartbeats, done and guard events are stream-only.
          if (evt.type === 'assistant_delta') {
            // Deltas are collapsed at turn end by the UI; we don't
            // persist every token fragment into the row to keep it small.
          } else if (evt.type === 'tool_use') {
            await deps.sessionManager.appendMessage({
              aid,
              message: {
                seq: nextSeq(aid),
                role: 'assistant',
                content: `[tool_use] ${evt.name} ${JSON.stringify(evt.input).slice(0, 500)}`,
                createdAt: nowIso(),
                toolCallId: evt.toolCallId,
                toolName: evt.name,
              },
            })
            await deps.sessionManager.updateMetrics({ aid, toolCallDelta: 1 })
          } else if (evt.type === 'tool_result') {
            await deps.sessionManager.appendMessage({
              aid,
              message: {
                seq: nextSeq(aid),
                role: 'tool',
                content: JSON.stringify(evt.output).slice(0, 2000),
                createdAt: nowIso(),
                toolCallId: evt.toolCallId,
              },
            })
          } else if (evt.type === 'tool_guard_rejected') {
            await deps.sessionManager.updateMetrics({ aid, toolCallRejectedDelta: 1 })
          } else if (evt.type === 'approval_required') {
            await deps.sessionManager.updateMetrics({ aid, approvalDelta: 1 })
            // Register a pending approval keyed by (aid, toolCallId). When
            // POST /agent/approval resolves it, the callback forwards an
            // `approval_resolved` SSE event back through this same stream.
            const dispose = deps.approvalRegistry.register(
              aid,
              evt.toolCallId,
              (decision) => {
                try {
                  res.write(
                    encodeSseEvent({
                      type: 'approval_resolved',
                      toolCallId: evt.toolCallId,
                      decision,
                    }).bytes,
                  )
                } catch {
                  /* client gone — timer already cleared, nothing to do */
                }
              },
            )
            openApprovalDisposers.push(dispose)
          } else if (evt.type === 'approval_resolved' && evt.decision === 'denied') {
            await deps.sessionManager.updateMetrics({ aid, approvalDeniedDelta: 1 })
          } else if (evt.type === 'error') {
            hadError = true
          }

          // Forward the event to the client.
          try {
            res.write(encodeSseEvent(evt).bytes)
          } catch {
            abortController.abort()
          }
        },
      })
    } catch (err) {
      hadError = true
      try {
        res.write(
          encodeSseEvent({
            type: 'error',
            message: (err as Error).message ?? 'sidecar error',
          }).bytes,
        )
      } catch {
        /* client gone */
      }
    } finally {
      clearInterval(keepAlive)
      // Dispose any pending approvals registered during this turn —
      // their timeouts would fire eventually but disposing explicitly
      // keeps approval_registry.size() honest for ops.
      for (const dispose of openApprovalDisposers) {
        try {
          dispose()
        } catch {
          /* registry entries are cheap — swallow any teardown error */
        }
      }
      if (hadError) {
        deps.circuitBreaker.recordError()
        if (deps.circuitBreaker.isOpen()) {
          try {
            res.write(encodeSseEvent({ type: 'circuit_breaker', state: 'open' }).bytes)
          } catch {
            /* client gone */
          }
        }
      } else {
        deps.circuitBreaker.recordSuccess()
      }
      try {
        res.end()
      } catch {
        /* already closed */
      }
    }
  }
}
