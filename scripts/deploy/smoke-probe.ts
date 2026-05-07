#!/usr/bin/env node
/**
 * smoke-probe.ts — run a handful of GETs against customer-visible
 * endpoints after a deploy swap. Fails fast on the first 5xx.
 *
 * CLI:
 *   npx tsx scripts/deploy/smoke-probe.ts \
 *     --target=storefront \
 *     --base=https://gbox.co
 *
 * Targets map to a scripted list of paths:
 *   storefront → /, /products, /products/sample-product, /cart
 *   api        → /_health, /api/2026-04/shop, /api/2026-04/products
 *   god-admin  → /_health, /god-admin/login
 *   accounts   → /_health, /accounts/login
 *   store-admin→ /_health, /stores (302 to accounts/login when unauth —
 *                still <500 so the probe passes, and it asserts the
 *                unauth-bounce redirect wiring is live)
 *
 * store-admin has NO public login page — seller auth is owned entirely
 * by `accounts.gbox.co`. `/admin/login`, `/login`, `/admin` are legacy
 * URL typo targets that 302 to accounts. The canonical post-auth entry
 * is `/stores`, so the probe targets that (expected 302 → accounts).
 *
 * Exit 0 on every probe returning <500; non-zero otherwise.
 */

import { emitReport } from './lib/runner.ts'

const TARGET_PATHS: Record<string, string[]> = {
  storefront: ['/', '/products', '/cart'],
  api: ['/_health', '/api/2026-04/shop', '/api/2026-04/products'],
  'god-admin': ['/_health', '/god-admin/login'],
  accounts: ['/_health', '/accounts/login'],
  'store-admin': ['/_health', '/stores'],
}

interface Args {
  target: string
  base: string
  timeoutMs: number
}

function parseArgs(argv: string[]): Args {
  const out: Args = { target: '', base: '', timeoutMs: 5000 }
  for (const a of argv) {
    if (a.startsWith('--target=')) out.target = a.slice('--target='.length)
    else if (a.startsWith('--base=')) out.base = a.slice('--base='.length)
    else if (a.startsWith('--timeout-ms=')) out.timeoutMs = parseInt(a.slice('--timeout-ms='.length), 10)
  }
  if (!out.target) throw new Error('--target is required')
  if (!out.base) throw new Error('--base is required')
  if (!TARGET_PATHS[out.target]) {
    throw new Error(`unknown target: ${out.target}. Allowed: ${Object.keys(TARGET_PATHS).join(', ')}`)
  }
  return out
}

export interface ProbeLine {
  path: string
  ok: boolean
  status?: number
  error?: string
  durationMs: number
}

export async function probeTarget(
  target: string,
  base: string,
  timeoutMs: number,
): Promise<ProbeLine[]> {
  const paths = TARGET_PATHS[target] ?? []
  const out: ProbeLine[] = []
  for (const path of paths) {
    const url = base.replace(/\/$/, '') + path
    const t0 = Date.now()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(url, { signal: controller.signal, redirect: 'manual' })
      const ok = res.status < 500
      out.push({ path, ok, status: res.status, durationMs: Date.now() - t0 })
      if (!ok) return out // fail fast
    } catch (err) {
      out.push({ path, ok: false, error: (err as Error).message, durationMs: Date.now() - t0 })
      return out
    } finally {
      clearTimeout(timer)
    }
  }
  return out
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const lines = await probeTarget(args.target, args.base, args.timeoutMs)
  const ok = lines.every((l) => l.ok)
  emitReport({ script: 'smoke-probe', target: args.target, base: args.base, ok, lines })
  process.exit(ok ? 0 : 1)
}

const isDirect = process.argv[1]?.endsWith('smoke-probe.ts')
if (isDirect) {
  void main().catch((err) => {
    emitReport({ script: 'smoke-probe', ok: false, error: (err as Error).message })
    process.exit(2)
  })
}
