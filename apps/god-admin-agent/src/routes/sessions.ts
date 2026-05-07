/**
 * Session lookup + list routes.
 *
 *   GET /agent/sessions        — paginated list, JSON { items, nextCursor }
 *   GET /agent/sessions/:aid   — full replay row for one session
 *
 * Query params on the list route:
 *   ?limit=<n>          — 1..200, default 50
 *   ?before=<iso>       — cursor, return rows with started_at < before
 *   ?god_admin_id=<id>  — filter to one god admin
 */

import type { Request, Response } from 'express'
import type { SessionManager } from '@gbox/agent-core'

export interface SessionsDeps {
  sessionManager: SessionManager
}

function parseLimit(raw: unknown): number {
  if (typeof raw !== 'string') return 50
  const n = parseInt(raw, 10)
  if (!Number.isFinite(n)) return 50
  return Math.min(Math.max(n, 1), 200)
}

export function createSessionListRoute(deps: SessionsDeps) {
  return async function sessionListRoute(req: Request, res: Response): Promise<void> {
    const limit = parseLimit(req.query['limit'])
    const beforeRaw = req.query['before']
    const before = typeof beforeRaw === 'string' ? beforeRaw : undefined
    const godRaw = req.query['god_admin_id']
    const godAdminId = typeof godRaw === 'string' ? godRaw : undefined

    const items = await deps.sessionManager.listSessions({
      limit,
      beforeCursor: before,
      godAdminId,
    })

    // Pagination cursor: the startedAt of the last item. Null when the
    // page isn't full, signalling there's no next page.
    const nextCursor =
      items.length === limit ? items[items.length - 1]?.startedAt ?? null : null

    res.json({ items, nextCursor })
  }
}

export function createSessionsRoute(deps: SessionsDeps) {
  return async function sessionsRoute(req: Request, res: Response): Promise<void> {
    const aidParam = req.params.aid
    const aid = Array.isArray(aidParam) ? aidParam[0] : aidParam
    if (!aid || typeof aid !== 'string') {
      res.status(400).json({ error: 'aid_required' })
      return
    }
    const row = await deps.sessionManager.getReplay(aid)
    if (!row) {
      res.status(404).json({ error: 'not_found' })
      return
    }
    res.json(row)
  }
}
