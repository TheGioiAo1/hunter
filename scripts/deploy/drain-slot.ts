#!/usr/bin/env node
/**
 * drain-slot.ts — pre-swap "quiet period" for a PM2 process.
 *
 * In the current single-slot PM2 topology (server 1/2/3 each run one
 * copy per app), a "drain" is really just: "stop accepting new traffic
 * for a few seconds so in-flight requests finish, then let the caller
 * do `pm2 reload`". We do NOT actually pull the process out of nginx
 * here — the next-generation blue/green layout will add a second slot
 * plus an nginx upstream-rewrite step, and this script will be the
 * hook point for that. For now it just sleeps the configured quiet
 * window and emits a structured JSON report.
 *
 * The sleep is important: without it, `pm2 reload` kills workers that
 * still have open checkout/auth requests in flight, which the owner's
 * runbook flagged as the #1 cause of user-visible deploy 502s.
 *
 * CLI:
 *   npx tsx scripts/deploy/drain-slot.ts \
 *     --pm2-name=gbox-storefront \
 *     --quiet-seconds=8
 *
 * Exit 0 always unless the args are bad.
 */

import { emitReport } from './lib/runner.ts'

interface Args {
  pm2Name: string
  quietSeconds: number
}

function parseArgs(argv: string[]): Args {
  const out: Args = { pm2Name: '', quietSeconds: 5 }
  for (const a of argv) {
    if (a.startsWith('--pm2-name=')) out.pm2Name = a.slice('--pm2-name='.length)
    else if (a.startsWith('--quiet-seconds=')) {
      out.quietSeconds = parseInt(a.slice('--quiet-seconds='.length), 10)
    }
  }
  if (!out.pm2Name) throw new Error('--pm2-name is required')
  if (!Number.isFinite(out.quietSeconds) || out.quietSeconds < 0) {
    throw new Error('--quiet-seconds must be a non-negative integer')
  }
  return out
}

export async function drainSlot(args: Args, sleep = defaultSleep): Promise<{
  ok: true
  pm2Name: string
  quietSeconds: number
  slept: boolean
}> {
  if (args.quietSeconds > 0) {
    await sleep(args.quietSeconds * 1000)
  }
  return {
    ok: true,
    pm2Name: args.pm2Name,
    quietSeconds: args.quietSeconds,
    slept: args.quietSeconds > 0,
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const result = await drainSlot(args)
  emitReport({ script: 'drain-slot', ...result })
  process.exit(0)
}

const isDirect = process.argv[1]?.endsWith('drain-slot.ts')
if (isDirect) {
  void main().catch((err) => {
    emitReport({ script: 'drain-slot', ok: false, error: (err as Error).message })
    process.exit(2)
  })
}
