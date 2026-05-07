/**
 * Gbox Platform — Edge Node Registry
 * (Landing Page System Phase 1D)
 *
 * Thin read/write layer over the `edge_nodes` table. This is the
 * source of truth for "which public IPs does Gbox's Nginx edge run
 * on right now?" — the verification worker joins against it to
 * assert a merchant's A record actually points at us before firing
 * a Let's Encrypt order.
 *
 * Why a DB table instead of an env var list?
 *
 *   1. HA pair rotations don't require a redeploy — add the new
 *      node's row, flip the old one to `draining`, and the
 *      verification worker picks up the change on its next tick.
 *   2. The god-admin "SSL fleet" dashboard can render the list
 *      directly without a separate config parser.
 *   3. Historical rows (`offline` status) stay around for audit —
 *      useful when debugging "why did this merchant's cert stop
 *      renewing three weeks ago?"
 *
 * The Node process still reads its own bind IP from env at boot
 * (`EDGE_PUBLIC_IP`) — this table is the platform's view, the env
 * var is the local process's view. They should agree but we don't
 * enforce that here; the god-admin dashboard surfaces any drift.
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type EdgeNodeStatus = 'active' | 'draining' | 'offline'

export interface EdgeNode {
  id: string
  hostname: string
  publicIpv4: string
  publicIpv6: string | null
  region: string | null
  status: EdgeNodeStatus
  notes: string | null
  createdAt: Date
  updatedAt: Date
}

// ---------------------------------------------------------------------------
// Row → EdgeNode mapper
// ---------------------------------------------------------------------------

interface EdgeNodeRow {
  id: string
  hostname: string
  public_ipv4: string
  public_ipv6: string | null
  region: string | null
  status: string
  notes: string | null
  created_at: Date | string | null
  updated_at: Date | string | null
}

function toDate(value: Date | string | null | undefined): Date {
  if (value == null) return new Date(0)
  if (value instanceof Date) return value
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? new Date(0) : parsed
}

function mapRow(row: EdgeNodeRow): EdgeNode {
  return {
    id: row.id,
    hostname: row.hostname,
    publicIpv4: row.public_ipv4,
    publicIpv6: row.public_ipv6,
    region: row.region,
    status: (row.status as EdgeNodeStatus) ?? 'active',
    notes: row.notes,
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  }
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * Every active edge node. Used by the storefront + god-admin health
 * page. Returns rows sorted by hostname so the UI order is stable
 * across refreshes.
 */
export async function listActiveEdgeNodes(
  db: Kysely<Database>,
): Promise<EdgeNode[]> {
  const rows = await db
    .selectFrom('edge_nodes')
    .selectAll()
    .where('status', '=', 'active')
    .orderBy('hostname', 'asc')
    .execute()
  return rows.map((r) => mapRow(r as unknown as EdgeNodeRow))
}

/**
 * Active IPv4 addresses only. The verification worker calls this
 * every tick and compares against `dns.resolve4(<merchant domain>)`
 * — any IP in this set counts as "pointing at us".
 *
 * Returned as a `Set<string>` so the caller's inner loop can do
 * O(1) membership checks. Callers should cache the result for the
 * duration of a batch.
 */
export async function loadActiveEdgeIpv4Set(
  db: Kysely<Database>,
): Promise<Set<string>> {
  const rows = await db
    .selectFrom('edge_nodes')
    .select(['public_ipv4'])
    .where('status', '=', 'active')
    .execute()
  return new Set(rows.map((r) => r.public_ipv4))
}

/**
 * Upsert helper used by the god-admin "register edge node" flow and
 * by the bootstrap script. Keyed on hostname so re-running the
 * bootstrap against the same host updates the IP instead of
 * inserting a duplicate.
 */
export interface UpsertEdgeNodeInput {
  hostname: string
  publicIpv4: string
  publicIpv6?: string | null
  region?: string | null
  status?: EdgeNodeStatus
  notes?: string | null
}

export async function upsertEdgeNode(
  db: Kysely<Database>,
  input: UpsertEdgeNodeInput,
): Promise<EdgeNode> {
  const existing = await db
    .selectFrom('edge_nodes')
    .selectAll()
    .where('hostname', '=', input.hostname)
    .executeTakeFirst()

  const now = new Date()

  if (existing) {
    await db
      .updateTable('edge_nodes')
      .set({
        public_ipv4: input.publicIpv4,
        public_ipv6: input.publicIpv6 ?? null,
        region: input.region ?? null,
        status: input.status ?? 'active',
        notes: input.notes ?? null,
        updated_at: now,
      } as any)
      .where('hostname', '=', input.hostname)
      .execute()
  } else {
    await db
      .insertInto('edge_nodes')
      .values({
        hostname: input.hostname,
        public_ipv4: input.publicIpv4,
        public_ipv6: input.publicIpv6 ?? null,
        region: input.region ?? null,
        status: input.status ?? 'active',
        notes: input.notes ?? null,
        created_at: now,
        updated_at: now,
      } as any)
      .execute()
  }

  const row = await db
    .selectFrom('edge_nodes')
    .selectAll()
    .where('hostname', '=', input.hostname)
    .executeTakeFirstOrThrow()
  return mapRow(row as unknown as EdgeNodeRow)
}

/**
 * Flip a node to a new status (active → draining → offline). Used
 * by the god-admin "retire edge node" flow so traffic-in-flight can
 * drain before the row is removed.
 */
export async function setEdgeNodeStatus(
  db: Kysely<Database>,
  hostname: string,
  status: EdgeNodeStatus,
): Promise<EdgeNode | null> {
  const existing = await db
    .selectFrom('edge_nodes')
    .selectAll()
    .where('hostname', '=', hostname)
    .executeTakeFirst()
  if (!existing) return null

  await db
    .updateTable('edge_nodes')
    .set({ status, updated_at: new Date() } as any)
    .where('hostname', '=', hostname)
    .execute()

  const row = await db
    .selectFrom('edge_nodes')
    .selectAll()
    .where('hostname', '=', hostname)
    .executeTakeFirstOrThrow()
  return mapRow(row as unknown as EdgeNodeRow)
}
