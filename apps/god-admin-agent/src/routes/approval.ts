/**
 * POST /agent/approval — resolve a pending tier-3 approval.
 *
 * Request body:
 *   {
 *     "aid":        "<agent session id>",
 *     "toolCallId": "<id from the most-recent approval_required event>",
 *     "decision":   "approved" | "denied"
 *   }
 *
 * Response:
 *   200 { ok: true }                            — resolved
 *   404 { error: "no_pending_approval" }        — already resolved / timed out / unknown
 *   400 { error: "invalid_body", reason: "..." } — missing / bad fields
 *
 * Contract notes:
 *  - The route is JWT-protected (middleware applied in server.ts).
 *  - Resolution is idempotent from the HTTP caller's perspective: a
 *    second POST for an already-resolved approval returns 404, not
 *    409 — the UI treats either as "nothing to do" (it disables its
 *    buttons on first click).
 *  - This route does NOT emit SSE. The `approval_resolved` event is
 *    fanned out by the chat route's onEvent callback when the guard
 *    gate invokes the `onResolve` registered via approval-registry.
 */

import type { Request, Response } from 'express'
import type { ApprovalRegistry } from '../approval-registry.ts'

export interface ApprovalDeps {
  approvalRegistry: ApprovalRegistry
}

export function createApprovalRoute(deps: ApprovalDeps) {
  return function approvalRoute(req: Request, res: Response): void {
    const body = req.body as
      | { aid?: string; toolCallId?: string; decision?: string }
      | undefined

    const aid = body?.aid
    const toolCallId = body?.toolCallId
    const decision = body?.decision

    if (typeof aid !== 'string' || aid.length === 0) {
      res.status(400).json({ error: 'invalid_body', reason: 'aid is required' })
      return
    }
    if (typeof toolCallId !== 'string' || toolCallId.length === 0) {
      res
        .status(400)
        .json({ error: 'invalid_body', reason: 'toolCallId is required' })
      return
    }
    if (decision !== 'approved' && decision !== 'denied') {
      res
        .status(400)
        .json({ error: 'invalid_body', reason: 'decision must be approved|denied' })
      return
    }

    const ok = deps.approvalRegistry.resolve(aid, toolCallId, decision)
    if (!ok) {
      res.status(404).json({ error: 'no_pending_approval' })
      return
    }

    res.status(200).json({ ok: true })
  }
}
