/**
 * ops.current-window — report which deployment window we're currently
 * inside, using agent-guard's deployment-safety classifier.
 *
 * Tier 1 (read-only). Consumers use this to display "Next window
 * opens in 3h 12m" in the chat UI without running a real deploy.
 */

import { insideDailyWindow, insideSundayWindow } from '@gbox/agent-guard'
import type { ToolDef, ToolResult } from '../types.ts'

export interface OpsCurrentWindowInput {
  /** Override clock for deterministic tests. */
  atIso?: string
}

export type OpsCurrentWindowDeps = Record<string, never>

function parseInput(raw: unknown): OpsCurrentWindowInput {
  if (raw !== null && raw !== undefined && typeof raw !== 'object') {
    throw new Error('ops.current-window: input must be an object or omitted')
  }
  const r = (raw ?? {}) as Record<string, unknown>
  if (r.atIso !== undefined && typeof r.atIso !== 'string') {
    throw new Error('ops.current-window: atIso must be an ISO string')
  }
  return { atIso: r.atIso as string | undefined }
}

async function run(input: OpsCurrentWindowInput): Promise<ToolResult> {
  const at = input.atIso ? new Date(input.atIso) : new Date()
  const daily = insideDailyWindow(at)
  const sunday = insideSundayWindow(at)
  return {
    kind: 'ok',
    data: {
      now: at.toISOString(),
      daily,
      sunday,
      anyWindow: daily || sunday,
      description: daily
        ? 'inside daily maintenance window (03:00–04:00 GMT+7)'
        : sunday
          ? 'inside Sunday maintenance window (02:00–05:00 GMT+7)'
          : 'outside maintenance windows — customer-facing deploys refused',
    },
  }
}

export const opsCurrentWindowTool: ToolDef<OpsCurrentWindowInput, OpsCurrentWindowDeps> = {
  name: 'ops.current-window',
  tier: 1,
  description: 'Report whether we are currently inside a maintenance window (GMT+7).',
  parseInput,
  run,
}
