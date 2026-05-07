/**
 * Session manager — lifecycle of `agent_sessions` rows.
 *
 * Responsibilities:
 * 1. Open a session for a given god_admin (writes the row with
 *    system_prompt_version + starting metadata).
 * 2. Append a message to `conversation` JSONB using a jsonb_insert
 *    expression so concurrent writes from the SSE stream don't
 *    clobber each other.
 * 3. Update per-turn metrics (token counts, cost, tool call count).
 * 4. Close a session (sets ended_at + ended_reason).
 * 5. Query a session for replay (select one row; the UI renders).
 *
 * Design notes:
 * - Takes `Kysely<Database>` via constructor injection so tests can
 *   pass a mock without booting a real pool.
 * - Uses ISO strings for timestamps; Kysely's Postgres dialect
 *   converts them on write.
 * - Does NOT own the db connection — callers are responsible for
 *   `destroyDb()` at shutdown.
 */

import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import type { Database } from '@gbox/db'
import type { ChatMessage } from './types.ts'

export interface OpenSessionInput {
  godAdminId: string
  systemPromptVersion: string
  model?: string
  tokenBudget?: number
}

export interface AppendMessageInput {
  aid: string
  message: ChatMessage
}

export interface UpdateMetricsInput {
  aid: string
  inputTokensDelta?: number
  outputTokensDelta?: number
  toolCallDelta?: number
  toolCallRejectedDelta?: number
  approvalDelta?: number
  approvalDeniedDelta?: number
  costUsdDelta?: number
  promptCountDelta?: number
}

export interface CloseSessionInput {
  aid: string
  reason: 'user_ended' | 'killswitch' | 'error' | 'compact_failed' | 'idle_timeout'
}

export interface SessionReplayRow {
  id: string
  godAdminId: string
  startedAt: string
  endedAt: string | null
  endedReason: string | null
  promptCount: number
  toolCallCount: number
  toolCallRejectedCount: number
  approvalCount: number
  approvalDeniedCount: number
  totalInputTokens: number
  totalOutputTokens: number
  costUsd: string
  conversation: ChatMessage[]
  compactedContext: unknown | null
  compactCount: number
  systemPromptVersion: string
  model: string
}

export interface SessionListItem {
  id: string
  godAdminId: string
  startedAt: string
  endedAt: string | null
  endedReason: string | null
  promptCount: number
  toolCallCount: number
  costUsd: string
  firstUserMessage: string | null
}

export interface ListSessionsInput {
  /** If set, only return sessions belonging to this god admin. */
  godAdminId?: string
  /** Max rows to return. Default 50, capped at 200. */
  limit?: number
  /** ISO timestamp — only rows with started_at < cursor. */
  beforeCursor?: string
}

export interface SessionManager {
  openSession(input: OpenSessionInput): Promise<string>
  appendMessage(input: AppendMessageInput): Promise<void>
  updateMetrics(input: UpdateMetricsInput): Promise<void>
  closeSession(input: CloseSessionInput): Promise<void>
  getReplay(aid: string): Promise<SessionReplayRow | null>
  listSessions(input?: ListSessionsInput): Promise<SessionListItem[]>
}

export function createSessionManager(db: Kysely<Database>): SessionManager {
  return {
    async openSession(input) {
      const row = await db
        .insertInto('agent_sessions')
        .values({
          god_admin_id: input.godAdminId,
          system_prompt_version: input.systemPromptVersion,
          // The rest use DB defaults. If the caller provided overrides,
          // pass them through explicitly.
          ...(input.model ? { model: input.model } : {}),
          ...(input.tokenBudget ? { token_budget: input.tokenBudget } : {}),
        })
        .returning('id')
        .executeTakeFirstOrThrow()

      return row.id as string
    },

    async appendMessage({ aid, message }) {
      // jsonb concat: conversation = conversation || '[<new>]'
      // This is atomic at the row level even under concurrent writes.
      const payload = JSON.stringify([message])
      await db
        .updateTable('agent_sessions')
        .where('id', '=', aid)
        .set({
          conversation: sql`conversation || ${payload}::jsonb` as unknown as string,
        })
        .execute()
    },

    async updateMetrics(input) {
      const updates: Record<string, unknown> = {}
      if (input.inputTokensDelta !== undefined) {
        updates.total_input_tokens = sql`total_input_tokens + ${input.inputTokensDelta}`
      }
      if (input.outputTokensDelta !== undefined) {
        updates.total_output_tokens = sql`total_output_tokens + ${input.outputTokensDelta}`
      }
      if (input.toolCallDelta !== undefined) {
        updates.tool_call_count = sql`tool_call_count + ${input.toolCallDelta}`
      }
      if (input.toolCallRejectedDelta !== undefined) {
        updates.tool_call_rejected_count = sql`tool_call_rejected_count + ${input.toolCallRejectedDelta}`
      }
      if (input.approvalDelta !== undefined) {
        updates.approval_count = sql`approval_count + ${input.approvalDelta}`
      }
      if (input.approvalDeniedDelta !== undefined) {
        updates.approval_denied_count = sql`approval_denied_count + ${input.approvalDeniedDelta}`
      }
      if (input.costUsdDelta !== undefined) {
        updates.cost_usd = sql`cost_usd + ${input.costUsdDelta}`
      }
      if (input.promptCountDelta !== undefined) {
        updates.prompt_count = sql`prompt_count + ${input.promptCountDelta}`
      }

      if (Object.keys(updates).length === 0) return

      await db
        .updateTable('agent_sessions')
        .where('id', '=', input.aid)
        .set(updates)
        .execute()
    },

    async closeSession({ aid, reason }) {
      await db
        .updateTable('agent_sessions')
        .where('id', '=', aid)
        .where('ended_at', 'is', null)
        .set({
          ended_at: new Date().toISOString(),
          ended_reason: reason,
        })
        .execute()
    },

    async getReplay(aid) {
      const row = await db
        .selectFrom('agent_sessions')
        .where('id', '=', aid)
        .selectAll()
        .executeTakeFirst()

      if (!row) return null

      return {
        id: row.id as string,
        godAdminId: row.god_admin_id,
        startedAt: row.started_at as unknown as string,
        endedAt: row.ended_at,
        endedReason: row.ended_reason,
        promptCount: row.prompt_count,
        toolCallCount: row.tool_call_count,
        toolCallRejectedCount: row.tool_call_rejected_count,
        approvalCount: row.approval_count,
        approvalDeniedCount: row.approval_denied_count,
        totalInputTokens: row.total_input_tokens,
        totalOutputTokens: row.total_output_tokens,
        costUsd: row.cost_usd,
        conversation: row.conversation as ChatMessage[],
        compactedContext: row.compacted_context,
        compactCount: row.compact_count,
        systemPromptVersion: row.system_prompt_version,
        model: row.model,
      }
    },

    async listSessions(input = {}) {
      const limit = Math.min(Math.max(input.limit ?? 50, 1), 200)
      let q = db.selectFrom('agent_sessions').selectAll()
      if (input.godAdminId) q = q.where('god_admin_id', '=', input.godAdminId)
      if (input.beforeCursor) q = q.where('started_at', '<', input.beforeCursor)
      q = q.orderBy('started_at', 'desc').limit(limit)
      const rows = await q.execute()

      return rows.map((row) => {
        // Extract the first user message (if any) for the list preview.
        // `conversation` is a JSONB array stored by the runtime — we
        // defensively type-check each element before touching it.
        let first: string | null = null
        const conv = row.conversation
        if (Array.isArray(conv)) {
          for (const m of conv) {
            if (
              m &&
              typeof m === 'object' &&
              'role' in m &&
              (m as { role: unknown }).role === 'user' &&
              'content' in m &&
              typeof (m as { content: unknown }).content === 'string'
            ) {
              first = ((m as { content: string }).content).slice(0, 160)
              break
            }
          }
        }
        return {
          id: row.id as string,
          godAdminId: row.god_admin_id,
          startedAt: row.started_at as unknown as string,
          endedAt: row.ended_at,
          endedReason: row.ended_reason,
          promptCount: row.prompt_count,
          toolCallCount: row.tool_call_count,
          costUsd: row.cost_usd,
          firstUserMessage: first,
        }
      })
    },
  }
}
