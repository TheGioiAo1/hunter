/**
 * audit.search — filtered read over audit_logs.
 *
 * Tier 1. Thin wrapper over db.select that always targets audit_logs
 * and exposes a compact filter shape the model can use without
 * constructing a full Kysely query.
 */

import type { Kysely } from 'kysely'
import type { ToolDef, ToolResult } from '../types.ts'

export interface AuditSearchInput {
  action?: string
  onBehalfOf?: string
  via?: string
  guardLayer?: string
  sinceIso?: string
  untilIso?: string
  limit?: number
}

export interface AuditSearchDeps {
  db: Kysely<any>
}

function parseInput(raw: unknown): AuditSearchInput {
  if (raw !== null && raw !== undefined && typeof raw !== 'object') {
    throw new Error('audit.search: input must be an object or omitted')
  }
  const r = (raw ?? {}) as Record<string, unknown>
  const out: AuditSearchInput = {}
  for (const key of ['action', 'onBehalfOf', 'via', 'guardLayer', 'sinceIso', 'untilIso'] as const) {
    if (r[key] !== undefined) {
      if (typeof r[key] !== 'string') throw new Error(`audit.search: ${key} must be a string`)
      out[key] = r[key] as string
    }
  }
  if (r.limit !== undefined) {
    if (typeof r.limit !== 'number' || r.limit < 1) {
      throw new Error('audit.search: limit must be a positive integer')
    }
    out.limit = r.limit
  }
  return out
}

async function run(input: AuditSearchInput, deps: AuditSearchDeps): Promise<ToolResult> {
  try {
    const limit = Math.min(input.limit ?? 50, 500)
    let q = deps.db.selectFrom('audit_logs').selectAll().limit(limit).orderBy('created_at', 'desc') as any

    if (input.action) q = q.where('action', '=', input.action)
    if (input.onBehalfOf) q = q.where('on_behalf_of', '=', input.onBehalfOf)
    if (input.via) q = q.where('via', '=', input.via)
    if (input.guardLayer) q = q.where('guard_layer', '=', input.guardLayer)
    if (input.sinceIso) q = q.where('created_at', '>=', input.sinceIso)
    if (input.untilIso) q = q.where('created_at', '<', input.untilIso)

    const rows = await q.execute()
    return { kind: 'ok', data: { rowCount: rows.length, rows } }
  } catch (err) {
    return { kind: 'error', message: (err as Error).message, code: 'query_failed' }
  }
}

export const auditSearchTool: ToolDef<AuditSearchInput, AuditSearchDeps> = {
  name: 'audit.search',
  tier: 1,
  description: 'Search audit_logs by action / on_behalf_of / via / guard_layer / time range.',
  parseInput,
  run,
}
