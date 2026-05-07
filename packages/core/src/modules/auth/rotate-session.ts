/**
 * Gbox Platform — Session Rotation Helper (Phase 7.3)
 *
 * Iron Rule #1 from CLAUDE.md says "Session tokens: 64-char hex,
 * rotated on privilege change". This module is the single chokepoint
 * that performs the rotation safely. Call it whenever:
 *
 *   - A user's role changes (promotion / demotion).
 *   - A user is added to or removed from a shop.
 *   - A user changes their password (Iron Rule defence-in-depth:
 *     reset all old sessions even if the password change is
 *     legitimate).
 *   - A user enables / disables 2FA.
 *   - The platform admin team takes over an account ("act as user").
 *
 * Why a separate helper instead of inline `delete + create`?
 *
 *   1. Atomicity guarantees. The helper enforces "create before
 *      delete" so a transient failure on the delete leg doesn't
 *      leave the user logged out and confused. Tests pin the call
 *      order so it can't drift.
 *
 *   2. Failure surface. If create fails, the old session is
 *      preserved and the caller sees the error → they show "couldn't
 *      update your role, try again" instead of dropping the user on
 *      the login page.
 *
 *   3. Inject-able dependencies. The actual session create/delete
 *      calls live in `./session.ts`, but this helper takes them via
 *      a small `RotateSessionDeps` interface so it can be unit
 *      tested without spinning up Postgres or Redis.
 *
 * Production wire-up:
 *
 *   import { createSession, deleteSession } from './session.js'
 *   import { rotateSession } from './rotate-session.js'
 *
 *   const result = await rotateSession(
 *     { oldToken, userId, meta: { ipAddress, userAgent } },
 *     {
 *       createSession: (uid, m) => createSession(db, uid, m),
 *       deleteSession: (t) => deleteSession(db, t),
 *     },
 *   )
 *
 *   // Set new cookie with result.token, log result.partialFailure
 *   // (if any) to your audit sink.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionMeta {
  ipAddress?: string
  userAgent?: string
}

export interface RotateSessionDeps {
  /** Inject `(uid, meta) => createSession(db, uid, meta)` from session.ts. */
  createSession: (
    userId: string,
    meta: SessionMeta,
  ) => Promise<{ token: string; expiresAt: Date }>
  /** Inject `(token) => deleteSession(db, token)` from session.ts. */
  deleteSession: (token: string) => Promise<void>
}

export interface RotateSessionInput {
  /**
   * The current session token. Pass an empty string for "this user
   * has no prior session" (e.g. a brand-new login). The helper will
   * skip the delete step in that case.
   */
  oldToken: string
  userId: string
  meta: SessionMeta
}

export interface RotateSessionResult {
  token: string
  expiresAt: Date
  /**
   * Set when the new session was created successfully but the old
   * session could not be deleted. The new token is still safe to
   * use; the old session will be reaped by `cleanExpiredSessions`
   * (which runs as a cron). Callers should log this to their audit
   * sink so we can spot patterns.
   */
  partialFailure?: {
    stage: 'delete_old'
    message: string
  }
}

// ---------------------------------------------------------------------------
// rotateSession
// ---------------------------------------------------------------------------

/**
 * Issues a new session token for `userId`, then best-effort revokes
 * the old one. Always creates BEFORE deleting so a partial failure
 * never logs the user out.
 *
 * Throws if the create step fails — the caller's old session is
 * preserved and they should retry. Never throws on a delete-only
 * failure: the new session is the source of truth and the stale
 * old row is harmless until the cleanup cron runs.
 */
export async function rotateSession(
  input: RotateSessionInput,
  deps: RotateSessionDeps,
): Promise<RotateSessionResult> {
  // Step 1: create the new session. If this throws, the caller's
  // old session is untouched.
  const fresh = await deps.createSession(input.userId, input.meta)

  // Step 2: revoke the old session. Skip when there's no prior
  // token (brand-new login). Catch errors so a flaky delete never
  // takes down a successful rotation.
  if (input.oldToken && input.oldToken.length > 0) {
    try {
      await deps.deleteSession(input.oldToken)
    } catch (err) {
      return {
        token: fresh.token,
        expiresAt: fresh.expiresAt,
        partialFailure: {
          stage: 'delete_old',
          message: err instanceof Error ? err.message : String(err),
        },
      }
    }
  }

  return {
    token: fresh.token,
    expiresAt: fresh.expiresAt,
  }
}
