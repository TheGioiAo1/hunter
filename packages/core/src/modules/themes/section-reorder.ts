/**
 * Gbox Platform — Pure section reorder helper (Stage 5.5)
 *
 * The theme visual editor ships a drag-drop section rail, same
 * UX as Shopify's `/admin/themes/:id/editor`. When the user
 * drops a section, the admin front-end sends a single reorder
 * intent to the API:
 *
 *   POST /admin/themes/:id/sections/reorder
 *   { fromId: 'featured_products',
 *     toId:   'hero',
 *     position: 'before' }
 *
 * This module is the pure floor that computes the new order
 * array (or a rejection). The API handler calls it, persists
 * the result, and re-renders the preview — none of that happens
 * here.
 *
 * Two entry points:
 *
 *   reorderSections(order, fromId, toId, position, opts?)
 *     Drop `fromId` immediately before/after `toId`.
 *
 *   moveSectionToIndex(order, fromId, targetIndex, opts?)
 *     Move `fromId` to a specific slot (out-of-range indices
 *     are clamped). Handy for keyboard-based reordering.
 *
 * Locked sections (`opts.locked`, usually `['header', 'footer']`)
 * must never move, and no reorder is allowed to displace them.
 * Duplicate ids in the input are a programming error and
 * surface as a clean `duplicate_ids` rejection.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ReorderPosition = 'before' | 'after'

export interface ReorderSectionsOptions {
  /**
   * Section ids that cannot move AND cannot be displaced. The
   * usual case is `['header', 'footer']`. Omit or pass `[]` for
   * an unconstrained reorder.
   */
  locked?: readonly string[]
}

export type ReorderSectionsErrorCode =
  | 'unknown_from_id'
  | 'unknown_to_id'
  | 'same_id'
  | 'duplicate_ids'
  | 'from_locked'
  | 'to_locked'

export interface ReorderSectionsError {
  code: ReorderSectionsErrorCode
  message: string
}

export type ReorderSectionsResult =
  | { ok: true; order: string[] }
  | { ok: false; error: ReorderSectionsError }

// ---------------------------------------------------------------------------
// reorderSections
// ---------------------------------------------------------------------------

export function reorderSections(
  order: readonly string[],
  fromId: string,
  toId: string,
  position: ReorderPosition,
  opts: ReorderSectionsOptions = {},
): ReorderSectionsResult {
  const dup = findDuplicate(order)
  if (dup) {
    return fail('duplicate_ids', `duplicate section id ${dup} in input order`)
  }

  if (fromId === toId) {
    return fail('same_id', `fromId and toId are both ${fromId}`)
  }

  const fromIdx = order.indexOf(fromId)
  if (fromIdx === -1) {
    return fail('unknown_from_id', `section ${fromId} is not in the order`)
  }
  if (order.indexOf(toId) === -1) {
    return fail('unknown_to_id', `section ${toId} is not in the order`)
  }

  const locked = opts.locked ?? []
  if (locked.includes(fromId)) {
    return fail('from_locked', `section ${fromId} is locked and cannot move`)
  }

  // Remove `fromId`, then locate the anchor in the compacted
  // array (always unique now — we rejected duplicates above).
  const without = order.filter((_, i) => i !== fromIdx)
  const anchorIdx = without.indexOf(toId)
  const insertAt = position === 'before' ? anchorIdx : anchorIdx + 1
  const next = insertAtIndex(without, fromId, insertAt)

  const lockErr = checkLocksUnchanged(order, next, locked)
  if (lockErr) return { ok: false, error: lockErr }

  return { ok: true, order: next }
}

// ---------------------------------------------------------------------------
// moveSectionToIndex
// ---------------------------------------------------------------------------

export function moveSectionToIndex(
  order: readonly string[],
  fromId: string,
  targetIndex: number,
  opts: ReorderSectionsOptions = {},
): ReorderSectionsResult {
  const dup = findDuplicate(order)
  if (dup) {
    return fail('duplicate_ids', `duplicate section id ${dup} in input order`)
  }

  const fromIdx = order.indexOf(fromId)
  if (fromIdx === -1) {
    return fail('unknown_from_id', `section ${fromId} is not in the order`)
  }

  const locked = opts.locked ?? []
  if (locked.includes(fromId)) {
    return fail('from_locked', `section ${fromId} is locked and cannot move`)
  }

  const without = order.filter((_, i) => i !== fromIdx)
  const clamped = clamp(targetIndex, 0, without.length)
  const next = insertAtIndex(without, fromId, clamped)

  const lockErr = checkLocksUnchanged(order, next, locked)
  if (lockErr) return { ok: false, error: lockErr }

  return { ok: true, order: next }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fail(
  code: ReorderSectionsErrorCode,
  message: string,
): ReorderSectionsResult {
  return { ok: false, error: { code, message } }
}

function findDuplicate(order: readonly string[]): string | null {
  const seen = new Set<string>()
  for (const id of order) {
    if (seen.has(id)) return id
    seen.add(id)
  }
  return null
}

function insertAtIndex(
  arr: readonly string[],
  value: string,
  index: number,
): string[] {
  return [...arr.slice(0, index), value, ...arr.slice(index)]
}

function clamp(n: number, lo: number, hi: number): number {
  if (n < lo) return lo
  if (n > hi) return hi
  return n
}

/**
 * Make sure every locked section occupies the SAME index in the
 * output as in the input. Any drift means the move would have
 * displaced a pinned section — a no-op-or-reject outcome that
 * matches Shopify's behaviour of greying out drops onto header
 * and footer.
 */
function checkLocksUnchanged(
  input: readonly string[],
  output: readonly string[],
  locked: readonly string[],
): ReorderSectionsError | null {
  for (const lock of locked) {
    const before = input.indexOf(lock)
    if (before === -1) continue
    const after = output.indexOf(lock)
    if (before !== after) {
      return {
        code: 'to_locked',
        message: `reorder would displace locked section ${lock}`,
      }
    }
  }
  return null
}
