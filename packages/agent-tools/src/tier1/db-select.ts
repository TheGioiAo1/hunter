/**
 * db.select — execute a SELECT against a whitelisted table using a
 * read-only Kysely connection.
 *
 * Tier 1. Only SELECT is permitted — caller provides table + columns
 * + where clauses; no raw SQL. Whitelisted tables are the set the
 * god admin legitimately needs to inspect (shops, products, orders,
 * audit_logs, agent_sessions). All other tables return an error.
 */

import type { Kysely } from 'kysely'
import type { ToolDef, ToolResult } from '../types.ts'

const WHITELIST: ReadonlySet<string> = new Set([
  'shops',
  'products',
  'orders',
  'customers',
  'users',
  'audit_logs',
  'agent_sessions',
  'shop_domains',
  'metafields',
  'cron_tasks',
])

export interface DbSelectInput {
  table: string
  columns?: string[]
  where?: Array<{ column: string; op: '=' | '!=' | '>' | '<' | '>=' | '<=' | 'is' | 'in'; value: unknown }>
  limit?: number
  orderBy?: { column: string; direction?: 'asc' | 'desc' }
}

export interface DbSelectDeps {
  db: Kysely<any>
}

function parseInput(raw: unknown): DbSelectInput {
  if (!raw || typeof raw !== 'object') throw new Error('db.select: input must be an object')
  const r = raw as Record<string, unknown>
  if (typeof r.table !== 'string') throw new Error('db.select: table must be a string')
  const out: DbSelectInput = { table: r.table }
  if (Array.isArray(r.columns)) {
    out.columns = r.columns.map((c) => {
      if (typeof c !== 'string') throw new Error('db.select: columns must be strings')
      return c
    })
  }
  if (Array.isArray(r.where)) {
    out.where = r.where.map((w) => {
      if (!w || typeof w !== 'object') throw new Error('db.select: invalid where entry')
      const wr = w as Record<string, unknown>
      if (typeof wr.column !== 'string') throw new Error('db.select: where.column must be a string')
      if (typeof wr.op !== 'string') throw new Error('db.select: where.op must be a string')
      return {
        column: wr.column,
        op: wr.op as NonNullable<DbSelectInput['where']>[number]['op'],
        value: wr.value,
      }
    })
  }
  if (typeof r.limit === 'number') out.limit = r.limit
  if (r.orderBy && typeof r.orderBy === 'object') {
    const ob = r.orderBy as Record<string, unknown>
    if (typeof ob.column !== 'string') throw new Error('db.select: orderBy.column must be a string')
    out.orderBy = {
      column: ob.column,
      direction: ob.direction === 'desc' ? 'desc' : 'asc',
    }
  }
  return out
}

async function run(input: DbSelectInput, deps: DbSelectDeps): Promise<ToolResult> {
  if (!WHITELIST.has(input.table)) {
    return {
      kind: 'error',
      message: `db.select: table '${input.table}' is not on the whitelist. Allowed: ${[...WHITELIST].join(', ')}`,
      code: 'table_not_whitelisted',
    }
  }

  const hardLimit = Math.min(input.limit ?? 100, 1000)

  try {
    let q = deps.db
      .selectFrom(input.table)
      .limit(hardLimit) as any

    if (input.columns && input.columns.length > 0) {
      q = q.select(input.columns)
    } else {
      q = q.selectAll()
    }
    if (input.where) {
      for (const w of input.where) {
        q = q.where(w.column as any, w.op as any, w.value as any)
      }
    }
    if (input.orderBy) {
      q = q.orderBy(input.orderBy.column as any, input.orderBy.direction)
    }

    const rows = await q.execute()
    return { kind: 'ok', data: { table: input.table, rowCount: rows.length, rows } }
  } catch (err) {
    return { kind: 'error', message: (err as Error).message, code: 'query_failed' }
  }
}

export const dbSelectTool: ToolDef<DbSelectInput, DbSelectDeps> = {
  name: 'db.select',
  tier: 1,
  description: 'SELECT from a whitelisted table with column/where/limit/order.',
  parseInput,
  run,
}
