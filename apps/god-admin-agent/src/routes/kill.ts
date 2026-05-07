/**
 * POST /agent/kill — immediately abort an in-flight turn.
 *
 * Body:  { "aid": "<session id>" }
 * Auth:  bearer JWT (same middleware as /agent/chat)
 *
 * This is the "panic button" in the chat panel UI. It does NOT
 * trip the circuit breaker — the operator is cancelling a turn,
 * not reporting a failure. If the breaker should open as well
 * (e.g. for "something is really wrong"), touch the killswitch
 * file — that path engages both.
 */

import type { Request, Response } from 'express'
import type { AgentRuntime, SessionManager } from '@gbox/agent-core'

export interface KillDeps {
  runtime: AgentRuntime
  sessionManager: SessionManager
}

export function createKillRoute(deps: KillDeps) {
  return async function killRoute(req: Request, res: Response): Promise<void> {
    const body = req.body as { aid?: string; reason?: string } | undefined
    if (!body?.aid || typeof body.aid !== 'string') {
      res.status(400).json({ error: 'aid_required' })
      return
    }
    deps.runtime.abort(body.aid)
    try {
      await deps.sessionManager.closeSession({
        aid: body.aid,
        reason: 'killswitch',
      })
    } catch {
      // Closing a non-existent session is non-fatal — the kill still
      // succeeded from the runtime's perspective.
    }
    res.json({ ok: true, aid: body.aid })
  }
}
