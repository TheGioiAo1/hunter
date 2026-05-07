#!/usr/bin/env node
/**
 * health-probe.ts — GET a _health endpoint with retries + timeout.
 *
 * Used by blue-green-swap.ts after swinging nginx upstream: we
 * hammer the new slot until it returns 200 or we run out of retries.
 *
 * CLI:
 *   npx tsx scripts/deploy/health-probe.ts \
 *     --url=http://127.0.0.1:4321/_health \
 *     --retries=10 --interval-ms=2000 --timeout-ms=3000
 *
 * Exit 0 on first success; non-zero if no success before exhausting
 * retries or exceeding the overall budget.
 */

import { emitReport } from './lib/runner.ts'

interface Args {
  url: string
  retries: number
  intervalMs: number
  timeoutMs: number
}

function parseArgs(argv: string[]): Args {
  const out: Args = { url: '', retries: 10, intervalMs: 2000, timeoutMs: 3000 }
  for (const a of argv) {
    if (a.startsWith('--url=')) out.url = a.slice('--url='.length)
    else if (a.startsWith('--retries=')) out.retries = parseInt(a.slice('--retries='.length), 10)
    else if (a.startsWith('--interval-ms=')) out.intervalMs = parseInt(a.slice('--interval-ms='.length), 10)
    else if (a.startsWith('--timeout-ms=')) out.timeoutMs = parseInt(a.slice('--timeout-ms='.length), 10)
  }
  if (!out.url) throw new Error('--url is required')
  if (out.retries < 1) throw new Error('--retries must be >= 1')
  return out
}

export async function probeOnce(url: string, timeoutMs: number): Promise<{
  ok: boolean
  status?: number
  error?: string
}> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: controller.signal })
    return { ok: res.ok, status: res.status }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  } finally {
    clearTimeout(timer)
  }
}

export async function probeWithRetries(args: Args): Promise<{
  ok: boolean
  attempts: number
  lastStatus?: number
  lastError?: string
}> {
  let lastStatus: number | undefined
  let lastError: string | undefined
  for (let i = 1; i <= args.retries; i++) {
    const r = await probeOnce(args.url, args.timeoutMs)
    lastStatus = r.status
    lastError = r.error
    if (r.ok) return { ok: true, attempts: i, lastStatus }
    if (i < args.retries) {
      await new Promise((res) => setTimeout(res, args.intervalMs))
    }
  }
  return { ok: false, attempts: args.retries, lastStatus, lastError }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const result = await probeWithRetries(args)
  emitReport({ script: 'health-probe', url: args.url, ...result })
  process.exit(result.ok ? 0 : 1)
}

// Only run main() when invoked directly.
const isDirect = process.argv[1]?.endsWith('health-probe.ts')
if (isDirect) {
  void main().catch((err) => {
    emitReport({ script: 'health-probe', ok: false, error: (err as Error).message })
    process.exit(2)
  })
}
