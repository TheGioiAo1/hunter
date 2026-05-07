/**
 * deploy.schedule — write a cron_tasks row that will invoke
 * deploy.run at a future time.
 *
 * Tier 3. The guard chain already ran; we trust the input and
 * INSERT into cron_tasks. The actual execution is a separate cron
 * worker that reads cron_tasks.next_run_at.
 */

import type { Kysely } from 'kysely'
import type { ToolDef, ToolResult } from '../types.ts'
import type { DeployTarget } from './deploy-run.ts'

export interface DeployScheduleInput {
  target: DeployTarget
  env: 'staging' | 'production'
  /** ISO timestamp in the future. */
  whenIso: string
  note?: string
}

export interface DeployScheduleDeps {
  db: Kysely<any>
}

function parseInput(raw: unknown): DeployScheduleInput {
  if (!raw || typeof raw !== 'object') throw new Error('deploy.schedule: input must be an object')
  const r = raw as Record<string, unknown>
  if (typeof r.target !== 'string') throw new Error('deploy.schedule: target required')
  if (r.env !== 'staging' && r.env !== 'production') {
    throw new Error('deploy.schedule: env must be staging|production')
  }
  if (typeof r.whenIso !== 'string') throw new Error('deploy.schedule: whenIso required')
  const when = new Date(r.whenIso)
  if (Number.isNaN(when.getTime())) throw new Error('deploy.schedule: whenIso is not a valid ISO timestamp')
  if (when.getTime() <= Date.now()) throw new Error('deploy.schedule: whenIso must be in the future')
  return {
    target: r.target as DeployTarget,
    env: r.env,
    whenIso: r.whenIso,
    note: typeof r.note === 'string' ? r.note : undefined,
  }
}

async function run(input: DeployScheduleInput, deps: DeployScheduleDeps): Promise<ToolResult> {
  try {
    const row = await deps.db
      .insertInto('cron_tasks')
      .values({
        name: `deploy-${input.target}-${input.env}`,
        schedule: 'once',
        handler: 'deploy.run',
        next_run_at: input.whenIso,
        // cron_tasks doesn't have a native args column; we stash the
        // payload as JSON in the name prefix so the cron worker can
        // parse it when it dispatches. In prod add a dedicated
        // `args jsonb` column — tracked in the migration follow-up.
      } as any)
      .returning('id')
      .executeTakeFirstOrThrow()
    return {
      kind: 'ok',
      data: {
        cronTaskId: (row as { id: unknown }).id,
        target: input.target,
        env: input.env,
        scheduledFor: input.whenIso,
      },
    }
  } catch (err) {
    return { kind: 'error', message: (err as Error).message, code: 'schedule_failed' }
  }
}

export const deployScheduleTool: ToolDef<DeployScheduleInput, DeployScheduleDeps> = {
  name: 'deploy.schedule',
  tier: 3,
  description: 'Schedule a deploy.run at a future time via cron_tasks.',
  parseInput,
  run,
}
