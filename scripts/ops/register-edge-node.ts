/**
 * Gbox Platform — Register Edge Node CLI
 * (Landing Page System Phase 1D)
 *
 * Bootstrap helper invoked from the `ops/edge/README.md` runbook
 * (step 7) when a new edge host joins the fleet. Writes a row to
 * `edge_nodes` so the verification worker knows to accept merchant
 * A records pointing at the new host's public IPv4.
 *
 * Idempotent: re-running against the same hostname updates the
 * existing row rather than inserting a duplicate, so it's safe to
 * re-run after an IP rotation or a region relabel.
 *
 * Usage:
 *
 *   tsx scripts/ops/register-edge-node.ts \
 *     --hostname edge-01.gbox.co \
 *     --ipv4 203.0.113.7 \
 *     [--ipv6 2001:db8::1] \
 *     [--region ap-southeast-1] \
 *     [--status active|draining|offline] \
 *     [--notes "HA pair primary"]
 *
 * Env (as fallback when flags are omitted):
 *
 *   EDGE_HOSTNAME, EDGE_PUBLIC_IP, EDGE_PUBLIC_IPV6, EDGE_REGION,
 *   EDGE_STATUS, EDGE_NOTES
 *
 * Exits 0 on success, 1 on missing args or DB error. The pure
 * helpers (parseArgs, buildInput, asserts) live in
 * `register-edge-node-lib.ts` so unit tests can import them without
 * dragging dotenv + @gbox/db into the test process.
 */

import 'dotenv/config'
import { createDb, destroyDb } from '@gbox/db'
import { upsertEdgeNode } from '@gbox/core/modules/domains/edge-nodes.js'
import type { UpsertEdgeNodeInput } from '@gbox/core/modules/domains/edge-nodes.js'
import { buildInput, parseArgs } from './register-edge-node-lib.js'

// Re-export the pure helpers so callers that already import this
// file (should be none, but safe for forward-compat) keep working.
export {
  parseArgs,
  buildInput,
  assertValidHostname,
  assertValidIpv4,
  assertValidIpv6,
  assertValidStatus,
} from './register-edge-node-lib.js'

async function main(): Promise<number> {
  let input: UpsertEdgeNodeInput
  try {
    const flags = parseArgs(process.argv.slice(2))
    input = buildInput(flags, process.env)
  } catch (err) {
    process.stderr.write(
      `[register-edge-node] ${err instanceof Error ? err.message : String(err)}\n`,
    )
    process.stderr.write(
      'Usage: tsx scripts/ops/register-edge-node.ts --hostname <fqdn> --ipv4 <addr> [--ipv6 <addr>] [--region <name>] [--status active|draining|offline] [--notes "<text>"]\n',
    )
    return 1
  }

  const db = createDb()
  try {
    const node = await upsertEdgeNode(db, input)
    const action =
      node.createdAt.getTime() === node.updatedAt.getTime()
        ? 'registered'
        : 'updated'
    process.stdout.write(
      `[register-edge-node] ${action} ${node.hostname} → ${node.publicIpv4}` +
        (node.region ? ` (${node.region})` : '') +
        ` [status=${node.status}]\n`,
    )
    return 0
  } catch (err) {
    process.stderr.write(
      `[register-edge-node] DB error: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    return 1
  } finally {
    try {
      await destroyDb(db)
    } catch {
      // ignore — exiting anyway
    }
  }
}

// Only run when invoked directly — importing this module from a test
// (should not happen now that helpers live in *-lib.ts, but keep the
// guard for safety) won't trigger the DB connection.
const isDirectInvocation =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  /register-edge-node\.(ts|js|mjs)$/.test(process.argv[1])

if (isDirectInvocation) {
  main().then((code) => process.exit(code))
}
