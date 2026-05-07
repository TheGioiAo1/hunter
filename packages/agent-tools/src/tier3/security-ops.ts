/**
 * Security-operations tools (tier 3).
 *
 * user.admin       — enable/disable a user account
 * session.revoke   — revoke an active web session by id
 * token.rotate     — rotate a secret for a specific user
 * backup.now       — trigger an out-of-band DB backup
 *
 * All four mutate the platform DB. They require approval from the
 * god admin (enforced at the guard layer). This file bundles them
 * together because each implementation is ~40 lines and they share
 * the same Kysely dependency.
 */

import type { Kysely } from 'kysely'
import { randomBytes } from 'node:crypto'
import type { ToolDef, ToolResult } from '../types.ts'

export interface SecurityOpsDeps {
  db: Kysely<any>
  /** Injected backup runner — in prod wraps pg_dump; tests pass a fake. */
  backupRunner?: () => Promise<{ path: string; bytes: number }>
}

// ---------------------------------------------------------------------------
// user.admin
// ---------------------------------------------------------------------------

export interface UserAdminInput {
  userId: string
  action: 'disable' | 'enable'
  reason?: string
}

export const userAdminTool: ToolDef<UserAdminInput, SecurityOpsDeps> = {
  name: 'user.admin',
  tier: 3,
  description: 'Disable or enable a user account.',
  parseInput(raw) {
    if (!raw || typeof raw !== 'object') throw new Error('user.admin: input must be an object')
    const r = raw as Record<string, unknown>
    if (typeof r.userId !== 'string') throw new Error('user.admin: userId must be a string')
    if (r.action !== 'disable' && r.action !== 'enable') {
      throw new Error('user.admin: action must be disable|enable')
    }
    return {
      userId: r.userId,
      action: r.action,
      reason: typeof r.reason === 'string' ? r.reason : undefined,
    }
  },
  async run(input, deps): Promise<ToolResult> {
    try {
      const result = await deps.db
        .updateTable('users')
        .where('id', '=', input.userId)
        .set({
          disabled_at: input.action === 'disable' ? new Date().toISOString() : null,
        } as any)
        .execute()
      return {
        kind: 'ok',
        data: { userId: input.userId, action: input.action, rowsAffected: result.length },
      }
    } catch (err) {
      return { kind: 'error', message: (err as Error).message, code: 'user_admin_failed' }
    }
  },
}

// ---------------------------------------------------------------------------
// session.revoke
// ---------------------------------------------------------------------------

export interface SessionRevokeInput {
  sessionId: string
}

export const sessionRevokeTool: ToolDef<SessionRevokeInput, SecurityOpsDeps> = {
  name: 'session.revoke',
  tier: 3,
  description: 'Revoke an active user session by id.',
  parseInput(raw) {
    if (!raw || typeof raw !== 'object') throw new Error('session.revoke: input must be an object')
    const r = raw as Record<string, unknown>
    if (typeof r.sessionId !== 'string') throw new Error('session.revoke: sessionId must be a string')
    return { sessionId: r.sessionId }
  },
  async run(input, deps): Promise<ToolResult> {
    try {
      await deps.db
        .deleteFrom('sessions')
        .where('id', '=', input.sessionId)
        .execute()
      return { kind: 'ok', data: { sessionId: input.sessionId, revoked: true } }
    } catch (err) {
      return { kind: 'error', message: (err as Error).message, code: 'session_revoke_failed' }
    }
  },
}

// ---------------------------------------------------------------------------
// token.rotate
// ---------------------------------------------------------------------------

export interface TokenRotateInput {
  userId: string
}

export const tokenRotateTool: ToolDef<TokenRotateInput, SecurityOpsDeps> = {
  name: 'token.rotate',
  tier: 3,
  description: 'Rotate the API token for a user. Returns a fresh 64-hex token that the god admin must hand to the user out-of-band.',
  parseInput(raw) {
    if (!raw || typeof raw !== 'object') throw new Error('token.rotate: input must be an object')
    const r = raw as Record<string, unknown>
    if (typeof r.userId !== 'string') throw new Error('token.rotate: userId must be a string')
    return { userId: r.userId }
  },
  async run(input, deps): Promise<ToolResult> {
    try {
      const newToken = randomBytes(32).toString('hex')
      await deps.db
        .updateTable('users')
        .where('id', '=', input.userId)
        .set({
          api_token: newToken,
          api_token_rotated_at: new Date().toISOString(),
        } as any)
        .execute()
      return {
        kind: 'ok',
        data: { userId: input.userId, newTokenPreview: newToken.slice(0, 8) + '…' + newToken.slice(-4) },
      }
    } catch (err) {
      return { kind: 'error', message: (err as Error).message, code: 'token_rotate_failed' }
    }
  },
}

// ---------------------------------------------------------------------------
// backup.now
// ---------------------------------------------------------------------------

export const backupNowTool: ToolDef<Record<string, never>, SecurityOpsDeps> = {
  name: 'backup.now',
  tier: 3,
  description: 'Trigger an out-of-band Postgres backup (pg_dump). Returns the resulting file path + size.',
  parseInput(raw) {
    if (raw && typeof raw === 'object' && Object.keys(raw).length > 0) {
      throw new Error('backup.now: takes no arguments')
    }
    return {}
  },
  async run(_input, deps): Promise<ToolResult> {
    if (!deps.backupRunner) {
      return {
        kind: 'error',
        message: 'backup.now: no backupRunner injected (sidecar wiring missing)',
        code: 'not_configured',
      }
    }
    try {
      const result = await deps.backupRunner()
      return { kind: 'ok', data: result }
    } catch (err) {
      return { kind: 'error', message: (err as Error).message, code: 'backup_failed' }
    }
  },
}
