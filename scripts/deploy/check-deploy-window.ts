#!/usr/bin/env node
/**
 * check-deploy-window.ts
 *
 * Exits 0 if the current clock is inside a deploy window, non-zero
 * if not. Used as a pre-flight in blue-green-swap.ts and as a CI
 * gate. Accepts optional --at=<iso> for deterministic tests.
 *
 * Report line (stdout, last non-empty line):
 *   {"script":"check-deploy-window","ok":true/false,"daily":bool,
 *    "sunday":bool,"at":"<iso>","reason":"..."}
 */

import { emitReport } from './lib/runner.ts'
import { insideDailyWindow, insideSundayWindow } from './lib/windows.ts'

function parseAtFlag(argv: string[]): Date {
  const found = argv.find((a) => a.startsWith('--at='))
  if (!found) return new Date()
  const iso = found.slice('--at='.length)
  const d = new Date(iso)
  if (isNaN(d.getTime())) {
    throw new Error(`invalid --at value: ${iso}`)
  }
  return d
}

async function main(): Promise<void> {
  const at = parseAtFlag(process.argv.slice(2))
  const daily = insideDailyWindow(at)
  const sunday = insideSundayWindow(at)
  const ok = daily || sunday

  emitReport({
    script: 'check-deploy-window',
    ok,
    daily,
    sunday,
    at: at.toISOString(),
    reason: ok
      ? daily
        ? 'inside daily maintenance window (03:00-04:00 GMT+7)'
        : 'inside Sunday maintenance window (02:00-05:00 GMT+7)'
      : 'outside maintenance windows — customer-facing deploys refused',
  })

  process.exit(ok ? 0 : 1)
}

void main().catch((err) => {
  emitReport({
    script: 'check-deploy-window',
    ok: false,
    error: (err as Error).message,
  })
  process.exit(2)
})
