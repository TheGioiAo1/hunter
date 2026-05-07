/**
 * plan.todos — an in-memory todo store scoped per agent session.
 *
 * Tier 1. The agent uses this to track intra-session plan steps
 * (mirrors the TodoWrite tool in Claude Code). Storage is a Map
 * injected via deps so the sidecar can swap persistence strategies
 * later (e.g. persist to agent_sessions.compacted_context).
 */

import type { ToolDef, ToolResult } from '../types.ts'

export type TodoStatus = 'pending' | 'in_progress' | 'completed'

export interface TodoItem {
  content: string
  activeForm: string
  status: TodoStatus
}

export interface PlanTodosInput {
  action: 'list' | 'set'
  todos?: TodoItem[]
}

export interface PlanTodosDeps {
  /**
   * Map keyed by agent session id. The sidecar injects a scoped
   * closure that pre-fills the current session id — this tool never
   * needs to know the aid directly.
   */
  store: {
    get(): TodoItem[]
    set(items: TodoItem[]): void
  }
}

function parseTodoItem(raw: unknown, idx: number): TodoItem {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`plan.todos: todos[${idx}] must be an object`)
  }
  const r = raw as Record<string, unknown>
  if (typeof r.content !== 'string') {
    throw new Error(`plan.todos: todos[${idx}].content must be a string`)
  }
  if (typeof r.activeForm !== 'string') {
    throw new Error(`plan.todos: todos[${idx}].activeForm must be a string`)
  }
  if (r.status !== 'pending' && r.status !== 'in_progress' && r.status !== 'completed') {
    throw new Error(`plan.todos: todos[${idx}].status must be pending|in_progress|completed`)
  }
  return { content: r.content, activeForm: r.activeForm, status: r.status as TodoStatus }
}

function parseInput(raw: unknown): PlanTodosInput {
  if (!raw || typeof raw !== 'object') throw new Error('plan.todos: input must be an object')
  const r = raw as Record<string, unknown>
  if (r.action !== 'list' && r.action !== 'set') {
    throw new Error('plan.todos: action must be list|set')
  }
  const out: PlanTodosInput = { action: r.action }
  if (r.action === 'set') {
    if (!Array.isArray(r.todos)) {
      throw new Error('plan.todos: action=set requires todos array')
    }
    out.todos = r.todos.map(parseTodoItem)
    // Exactly one in_progress at a time (matches TodoWrite convention).
    const inProgressCount = out.todos.filter((t) => t.status === 'in_progress').length
    if (inProgressCount > 1) {
      throw new Error('plan.todos: at most one todo may be in_progress')
    }
  }
  return out
}

async function run(input: PlanTodosInput, deps: PlanTodosDeps): Promise<ToolResult> {
  if (input.action === 'list') {
    return { kind: 'ok', data: { todos: deps.store.get() } }
  }
  deps.store.set(input.todos!)
  return { kind: 'ok', data: { todos: input.todos!, updated: true } }
}

export const planTodosTool: ToolDef<PlanTodosInput, PlanTodosDeps> = {
  name: 'plan.todos',
  tier: 1,
  description: 'List or replace the session todo list. At most one item may be in_progress.',
  parseInput,
  run,
}
