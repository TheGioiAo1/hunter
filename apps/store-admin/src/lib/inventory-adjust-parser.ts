/**
 * inventory-adjust-parser.ts
 * Parse adjust input strings (+5, -3, =100) into a target quantity.
 *
 * Supported ops:
 *   +N  — add N to current (current required)
 *   -N  — subtract N from current (current required)
 *   =N  — set absolute value (current optional)
 *
 * Boundary rules:
 *   - N must be a non-negative integer
 *   - Result must be >= 0 (no negative inventory)
 *   - Result must be <= 999999
 */

const MAX_QTY = 999_999

export interface AdjustResult {
  targetQty: number
}

/**
 * Parse an adjust input string and compute target quantity.
 *
 * @param input  - User input: "+5", "-3", "=100"
 * @param current - Current on-hand qty. Required for + and - ops.
 * @throws {SyntaxError} when input does not match expected format
 * @throws {RangeError} when result would go below 0 or above MAX_QTY
 */
export function parseAdjust(input: string, current?: number): AdjustResult {
  const trimmed = (input ?? '').trim()

  const match = trimmed.match(/^([+\-=])(\d+)$/)
  if (!match) {
    throw new SyntaxError(`Invalid format. Use +N, -N, or =N`)
  }

  const op = match[1] as '+' | '-' | '='
  const n = parseInt(match[2], 10)

  let targetQty: number

  if (op === '=') {
    targetQty = n
  } else {
    if (current === undefined || current === null) {
      throw new SyntaxError(`Current quantity required for ${op} operation`)
    }
    targetQty = op === '+' ? current + n : current - n
  }

  if (targetQty < 0) {
    throw new RangeError(`Cannot go below 0`)
  }
  if (targetQty > MAX_QTY) {
    throw new RangeError(`Max ${MAX_QTY}`)
  }

  return { targetQty }
}
