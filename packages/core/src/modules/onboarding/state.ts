/**
 * Gbox Platform — Onboarding State Machine Helpers (Phase A / Task A3).
 *
 * Thin DB-facing wrapper around the four-state machine on `shops`:
 *
 *     pending → cloning  → completed   (Tab 1 URL clone or Tab 2 library clone)
 *     pending → skipped  → completed   (skip → banner dismiss)
 *     cloning ↻ pending                (clone job fails — rollback)
 *
 * Every mutator enforces the legal-predecessor guard in SQL WHERE
 * clauses. That's the trust boundary: even if a handler calls the
 * wrong mutator, the DB UPDATE either hits zero rows (silent no-op)
 * or updates the exact right row. Never clobbers a state.
 *
 * Plan: `docs/superpowers/plans/2026-04-18-store-onboarding-wizard.md`
 * Migration: 050_shops_onboarding_state.ts
 *
 * The Kysely type parameter is kept loose (`Kysely<any>`) so callers
 * that hold a typed `Database` still work, and unit tests can pass a
 * recording fake without having to implement every method on the
 * query-builder interface.
 */

import type { Kysely } from 'kysely'
import type {
  ShopOnboardingState,
  ShopOnboardingChoice,
} from '@gbox/db/schema/tables.js'

// ---------------------------------------------------------------------------
// View shape — the minimum set of shop columns this module needs to reason
// about state. Handlers typically hold a fuller `Shop` row from
// `@gbox/core/modules/shops/service.ts`, which is assignable to this shape.
// ---------------------------------------------------------------------------

export interface ShopOnboardingView {
  id: string
  onboarding_state: ShopOnboardingState
  onboarding_clone_job_id: string | null
}

// ---------------------------------------------------------------------------
// Pure predicates — no DB, safe to call in hot paths (middleware, layouts).
// ---------------------------------------------------------------------------

/**
 * True when the shop is in its initial 'pending' state — the wizard
 * should be the default landing screen and the optional gating
 * middleware should redirect bare dashboard hits back into the wizard.
 */
export function isOnboardingPending(shop: ShopOnboardingView): boolean {
  return shop.onboarding_state === 'pending'
}

/**
 * True when the dashboard should render the Resume-setup banner.
 *
 * Only 'skipped' qualifies: 'pending' is already handled by the gate
 * middleware (redirect, not banner); 'cloning' hides the banner
 * because the clone-pro progress page is the active surface;
 * 'completed' is terminal.
 */
export function shouldShowOnboardingBanner(shop: ShopOnboardingView): boolean {
  return shop.onboarding_state === 'skipped'
}

// ---------------------------------------------------------------------------
// Mutators — each guards on legal-predecessor states in SQL WHERE.
// ---------------------------------------------------------------------------

/**
 * Transition pending → skipped.
 *
 * Called from POST /admin/store/:slug/onboarding/skip.
 *
 * Idempotent by construction: the WHERE onboarding_state = 'pending'
 * guard means a double-submit (seller mashes the button, or a CSRF
 * retry) is a no-op on the second call.
 */
export async function markOnboardingSkipped(
  db: Kysely<any>,
  shopId: string,
): Promise<void> {
  await db
    .updateTable('shops')
    .set({
      onboarding_state: 'skipped',
      onboarding_choice: 'skipped',
    })
    .where('id', '=', shopId)
    .where('onboarding_state', '=', 'pending')
    .execute()
}

/**
 * Transition cloning|skipped → completed.
 *
 * Called from:
 *   - the clone-pro runner after a terminal-success transition
 *     (Task E3) — `choice = 'clone_from_url'` or `'clone_from_library'`
 *   - POST /admin/store/:slug/onboarding/dismiss-banner — `choice = 'dismissed'`
 *
 * The `in` guard prevents accidentally completing a shop that's still
 * pending (which would skip the wizard silently). Completed-from-
 * completed is a no-op too.
 */
export async function markOnboardingCompleted(
  db: Kysely<any>,
  shopId: string,
  choice: ShopOnboardingChoice,
): Promise<void> {
  await db
    .updateTable('shops')
    .set({
      onboarding_state: 'completed',
      onboarding_completed_at: new Date().toISOString(),
      onboarding_choice: choice,
    })
    .where('id', '=', shopId)
    .where('onboarding_state', 'in', ['cloning', 'skipped'])
    .execute()
}

/**
 * Transition pending → cloning.
 *
 * Called from POST /admin/store/:slug/onboarding/clone/start (Task C2)
 * inside the same transaction that INSERTs the storefront_clone_jobs
 * row, so `cloneJobId` is the freshly-minted job UUID.
 *
 * The pending guard prevents double-starting a clone: if the seller
 * re-POSTs the form while the first clone is running, the UPDATE
 * touches zero rows and the duplicate INSERT is caught by the
 * partial-unique domain index (migration 045). Either way the shop
 * only points at one live job at a time.
 */
export async function markOnboardingCloning(
  db: Kysely<any>,
  shopId: string,
  cloneJobId: string,
): Promise<void> {
  await db
    .updateTable('shops')
    .set({
      onboarding_state: 'cloning',
      onboarding_clone_job_id: cloneJobId,
    })
    .where('id', '=', shopId)
    .where('onboarding_state', '=', 'pending')
    .execute()
}

/**
 * Transition cloning → pending (job failed or was discarded).
 *
 * Clears `onboarding_clone_job_id` so the wizard's resume-mid-clone
 * branch doesn't try to reopen a dead job — the seller lands back on
 * the welcome page and can retry with a different URL or switch to
 * the Theme Library tab.
 *
 * Only legal from 'cloning' — calling this on a completed or skipped
 * shop would be a bug (silent no-op protects us).
 */
export async function rollbackOnboardingToPending(
  db: Kysely<any>,
  shopId: string,
): Promise<void> {
  await db
    .updateTable('shops')
    .set({
      onboarding_state: 'pending',
      onboarding_clone_job_id: null,
    })
    .where('id', '=', shopId)
    .where('onboarding_state', '=', 'cloning')
    .execute()
}

/**
 * Look up the in-flight clone job id for a shop.
 *
 * Used by the wizard welcome handler (Task B1) when the seller
 * revisits `/onboarding/first-run` while `onboarding_state='cloning'`
 * — we redirect them straight to the clone-pro progress page.
 *
 * Returns null if no row exists or the column is NULL.
 */
export async function getOnboardingCloneJobId(
  db: Kysely<any>,
  shopId: string,
): Promise<string | null> {
  const row = await db
    .selectFrom('shops')
    .select(['onboarding_clone_job_id'])
    .where('id', '=', shopId)
    .executeTakeFirst()
  return (row?.onboarding_clone_job_id as string | null | undefined) ?? null
}

// ---------------------------------------------------------------------------
// Phase E Task E3 — clone-pro runner hooks.
//
// The generic `markOnboardingCompleted` / `rollbackOnboardingToPending`
// above are called from interactive handlers (dismiss-banner, skip,
// etc.) where the seller IS the cloning shop. The clone-pro runner
// operates async against a job id that may or may not belong to the
// wizard flow — and when two jobs race (replace=1 retry), a late
// callback for the losing job must not touch a shop that's now bound
// to the winner. We solve it with narrower helpers that guard on
// BOTH the state AND `onboarding_clone_job_id`:
//
//   - `completeOnboardingFromCloneJob(db, shopId, jobId)` — fires on
//     the runner's terminal-success branch. Zero-row no-op when the
//     shop isn't cloning-for-THIS-job, so the runner can call it
//     unconditionally.
//   - `rollbackCloningForJob(db, shopId, jobId)` — fires on the
//     terminal-failure branch. Same guard, same safety.
//
// Both helpers always set `onboarding_choice = 'clone_from_url'` for
// completion because the only way to reach this helper path is via a
// Tab-1 clone-pro job spawned from the wizard (`Phase C Task C2`).
// Library clones (Tab 2) land on a separate completion hook that
// stamps `'clone_from_library'`.
// ---------------------------------------------------------------------------

/**
 * Transition cloning → completed for a specific wizard-origin job.
 *
 * Guards on `onboarding_state='cloning'` AND the clone_job_id matches
 * the terminal job, so a late callback for a job that's already been
 * replaced/rolled back is a silent no-op. Caller should invoke this
 * right after writing `succeeded`/`succeeded_partial` onto the clone
 * job row — if the shop was never bound to this job (regular
 * post-wizard re-clone), nothing happens.
 */
export async function completeOnboardingFromCloneJob(
  db: Kysely<any>,
  shopId: string,
  cloneJobId: string,
): Promise<void> {
  await db
    .updateTable('shops')
    .set({
      onboarding_state: 'completed',
      onboarding_completed_at: new Date().toISOString(),
      onboarding_choice: 'clone_from_url',
    })
    .where('id', '=', shopId)
    .where('onboarding_state', '=', 'cloning')
    .where('onboarding_clone_job_id', '=', cloneJobId)
    .execute()
}

/**
 * Transition cloning → pending for a specific wizard-origin job that
 * failed or was discarded.
 *
 * Same guarded-by-job-id semantics as the completion hook: a late
 * failure callback for a replaced job won't clobber a shop that's
 * already cloning-for-another-job or that the seller manually
 * skipped/completed.
 *
 * Clears `onboarding_clone_job_id` so the wizard's resume-mid-clone
 * branch doesn't try to reopen the dead job id; the seller lands on
 * the welcome page and can retry.
 */
export async function rollbackCloningForJob(
  db: Kysely<any>,
  shopId: string,
  cloneJobId: string,
): Promise<void> {
  await db
    .updateTable('shops')
    .set({
      onboarding_state: 'pending',
      onboarding_clone_job_id: null,
    })
    .where('id', '=', shopId)
    .where('onboarding_state', '=', 'cloning')
    .where('onboarding_clone_job_id', '=', cloneJobId)
    .execute()
}
