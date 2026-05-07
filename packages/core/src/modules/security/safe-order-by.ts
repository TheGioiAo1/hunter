/**
 * Security Module — Safe ORDER BY helper
 *
 * Query strings like `?sort=price` or `?sort=-created_at` are passed
 * straight from the client to `ORDER BY` in many APIs. If the list of
 * allowed columns is not strictly enforced, this is classic SQL
 * injection via identifier interpolation.
 *
 * This helper accepts:
 *   - `input`: the raw sort string from the request (may be null/undefined)
 *   - `allowed`: a map from client-facing names to DB column names
 *   - `defaultColumn`: used when input is missing or invalid
 *
 * Syntax:
 *   - `?sort=price`         → ORDER BY price ASC
 *   - `?sort=-created_at`   → ORDER BY created_at DESC
 *   - `?sort=price,-title`  → ORDER BY price ASC, title DESC  (multi)
 *
 * Usage with Kysely:
 *
 *   const sort = safeOrderBy(req.query.sort, {
 *     price: 'price',
 *     name: 'title',
 *     created: 'created_at',
 *   }, { column: 'created_at', direction: 'desc' })
 *
 *   let q = db.selectFrom('products').selectAll()
 *   for (const { column, direction } of sort) {
 *     q = q.orderBy(column as any, direction)
 *   }
 */

export interface OrderBySpec {
  column: string
  direction: 'asc' | 'desc'
}

export interface SafeOrderByOptions {
  /** Max number of sort columns permitted (default 3). */
  maxColumns?: number
}

/**
 * Parse and validate a sort string. Returns a list of (column, direction)
 * tuples that are guaranteed to be in the `allowed` map.
 */
export function safeOrderBy(
  input: unknown,
  allowed: Record<string, string>,
  fallback: OrderBySpec,
  opts: SafeOrderByOptions = {},
): OrderBySpec[] {
  const maxColumns = opts.maxColumns ?? 3

  if (!input || typeof input !== 'string') return [fallback]

  const parts = input
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .slice(0, maxColumns)

  const result: OrderBySpec[] = []
  const seen = new Set<string>()

  for (const part of parts) {
    let direction: 'asc' | 'desc' = 'asc'
    let key = part

    if (part.startsWith('-')) {
      direction = 'desc'
      key = part.slice(1)
    } else if (part.startsWith('+')) {
      key = part.slice(1)
    }

    // Client-facing key must be alphanumeric/underscore — refuse anything
    // weirder than that even if it happens to be in the allow-list.
    if (!/^[a-zA-Z0-9_]+$/.test(key)) continue

    const mappedColumn = allowed[key]
    if (!mappedColumn) continue

    if (seen.has(mappedColumn)) continue
    seen.add(mappedColumn)

    result.push({ column: mappedColumn, direction })
  }

  return result.length > 0 ? result : [fallback]
}
