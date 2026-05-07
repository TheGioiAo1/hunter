/**
 * session-manager unit tests — Kysely is mocked via a fluent chain
 * recorder. We verify the SQL plumbing shapes, not real DB behavior;
 * the real DB is exercised in integration smoke tests.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createSessionManager } from './session-manager.ts'
import type { SessionManager } from './session-manager.ts'
import type { ChatMessage } from './types.ts'

// ---------------------------------------------------------------------------
// Mock Kysely chain
// ---------------------------------------------------------------------------
//
// Every Kysely chain call (e.g. db.insertInto(...).values(...).returning(...)
// .executeTakeFirstOrThrow()) is a chain of builders that each return `this`
// or a new builder. We shim this with a Proxy that records the last call
// spec and returns canned results for the terminal methods.

interface CallRecord {
  table?: string
  op?: string
  values?: unknown
  where?: unknown[]
  set?: unknown
  returning?: string
}

function makeMockDb(terminalResults: {
  executeTakeFirstOrThrow?: unknown
  executeTakeFirst?: unknown
  execute?: unknown
}) {
  const record: CallRecord = { where: [] }

  const chain: any = {
    insertInto(table: string) {
      record.table = table
      record.op = 'insert'
      return chain
    },
    updateTable(table: string) {
      record.table = table
      record.op = 'update'
      return chain
    },
    selectFrom(table: string) {
      record.table = table
      record.op = 'select'
      return chain
    },
    values(v: unknown) {
      record.values = v
      return chain
    },
    set(v: unknown) {
      record.set = v
      return chain
    },
    where(...args: unknown[]) {
      record.where!.push(args)
      return chain
    },
    returning(col: string) {
      record.returning = col
      return chain
    },
    selectAll() {
      return chain
    },
    async executeTakeFirstOrThrow() {
      return terminalResults.executeTakeFirstOrThrow
    },
    async executeTakeFirst() {
      return terminalResults.executeTakeFirst
    },
    async execute() {
      return terminalResults.execute ?? []
    },
  }

  return { db: chain, record }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createSessionManager.openSession', () => {
  it('inserts into agent_sessions and returns the new row id', async () => {
    const { db, record } = makeMockDb({
      executeTakeFirstOrThrow: { id: 'agent-session-uuid-1' },
    })
    const mgr = createSessionManager(db as any)

    const aid = await mgr.openSession({
      godAdminId: 'god-1',
      systemPromptVersion: 'v1-abc123',
    })

    expect(aid).toBe('agent-session-uuid-1')
    expect(record.table).toBe('agent_sessions')
    expect(record.op).toBe('insert')
    expect(record.returning).toBe('id')
    expect(record.values).toMatchObject({
      god_admin_id: 'god-1',
      system_prompt_version: 'v1-abc123',
    })
    // Defaults (prompt_count, cost_usd, etc.) must NOT be in values —
    // the DB supplies them.
    expect(record.values).not.toHaveProperty('prompt_count')
    expect(record.values).not.toHaveProperty('cost_usd')
  })

  it('passes through model and tokenBudget overrides when provided', async () => {
    const { db, record } = makeMockDb({
      executeTakeFirstOrThrow: { id: 'x' },
    })
    const mgr = createSessionManager(db as any)

    await mgr.openSession({
      godAdminId: 'god-1',
      systemPromptVersion: 'v1',
      model: 'claude-opus-4-6',
      tokenBudget: 150_000,
    })

    expect(record.values).toMatchObject({
      model: 'claude-opus-4-6',
      token_budget: 150_000,
    })
  })
})

describe('createSessionManager.appendMessage', () => {
  it('updates the target row with a jsonb concat', async () => {
    const { db, record } = makeMockDb({ execute: [] })
    const mgr = createSessionManager(db as any)

    const msg: ChatMessage = {
      seq: 0,
      role: 'user',
      content: 'hi',
      createdAt: '2026-04-10T00:00:00.000Z',
    }

    await mgr.appendMessage({ aid: 'agent-1', message: msg })

    expect(record.op).toBe('update')
    expect(record.table).toBe('agent_sessions')
    expect(record.where).toEqual([['id', '=', 'agent-1']])
    // `set` contains the conversation key with a Kysely RawBuilder — we
    // can only verify the key exists without coupling to its internals.
    expect(record.set).toHaveProperty('conversation')
  })
})

describe('createSessionManager.updateMetrics', () => {
  it('no-ops when all deltas are undefined', async () => {
    const { db, record } = makeMockDb({ execute: [] })
    const mgr = createSessionManager(db as any)

    await mgr.updateMetrics({ aid: 'agent-1' })

    // No update should have been issued — table is never set to update.
    expect(record.op).toBeUndefined()
  })

  it('batches multiple delta fields into one update', async () => {
    const { db, record } = makeMockDb({ execute: [] })
    const mgr = createSessionManager(db as any)

    await mgr.updateMetrics({
      aid: 'agent-1',
      inputTokensDelta: 100,
      outputTokensDelta: 50,
      toolCallDelta: 1,
      costUsdDelta: 0.0023,
    })

    expect(record.op).toBe('update')
    expect(record.set).toHaveProperty('total_input_tokens')
    expect(record.set).toHaveProperty('total_output_tokens')
    expect(record.set).toHaveProperty('tool_call_count')
    expect(record.set).toHaveProperty('cost_usd')
  })
})

describe('createSessionManager.closeSession', () => {
  it('sets ended_at and ended_reason only if row is still open', async () => {
    const { db, record } = makeMockDb({ execute: [] })
    const mgr = createSessionManager(db as any)

    await mgr.closeSession({ aid: 'agent-1', reason: 'user_ended' })

    expect(record.op).toBe('update')
    // Two where clauses: id + ended_at IS NULL guard
    expect(record.where).toEqual([
      ['id', '=', 'agent-1'],
      ['ended_at', 'is', null],
    ])
    const setObj = record.set as Record<string, unknown>
    expect(setObj.ended_reason).toBe('user_ended')
    expect(typeof setObj.ended_at).toBe('string')
  })
})

describe('createSessionManager.getReplay', () => {
  it('returns null when row not found', async () => {
    const { db } = makeMockDb({ executeTakeFirst: undefined })
    const mgr = createSessionManager(db as any)

    const result = await mgr.getReplay('nope')
    expect(result).toBeNull()
  })

  it('maps db row to SessionReplayRow shape', async () => {
    const { db } = makeMockDb({
      executeTakeFirst: {
        id: 'agent-1',
        god_admin_id: 'god-1',
        started_at: '2026-04-10T00:00:00.000Z',
        ended_at: null,
        ended_reason: null,
        prompt_count: 3,
        tool_call_count: 5,
        tool_call_rejected_count: 1,
        approval_count: 2,
        approval_denied_count: 0,
        total_input_tokens: 1234,
        total_output_tokens: 567,
        cost_usd: '0.0089',
        conversation: [{ seq: 0, role: 'user', content: 'hi', createdAt: 'x' }],
        compacted_context: null,
        compact_count: 0,
        system_prompt_version: 'v1',
        model: 'claude-opus-4-6',
      },
    })
    const mgr = createSessionManager(db as any)

    const result = await mgr.getReplay('agent-1')
    expect(result).toMatchObject({
      id: 'agent-1',
      godAdminId: 'god-1',
      promptCount: 3,
      toolCallCount: 5,
      costUsd: '0.0089',
      systemPromptVersion: 'v1',
      model: 'claude-opus-4-6',
    })
    expect(result!.conversation).toHaveLength(1)
  })
})
