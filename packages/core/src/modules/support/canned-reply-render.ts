/**
 * Canned reply variable interpolation.
 *
 * Template language is deliberately narrow:
 *
 *   "Hi {{seller.display_name}}, about ticket {{ticket.subject}}..."
 *
 * Only `{{object.path}}` tokens are resolved (via a lookup into a
 * context bag). No conditionals, no loops, no function calls, no
 * escape sequences other than the raw `{{` / `}}` pairs. This keeps
 * the attack surface tiny — no eval, no templating library, no
 * sandbox to escape.
 *
 * Unknown tokens are left unsubstituted (and surfaced via `warnings`)
 * so the agent spots the typo before sending.
 */

export interface CannedReplyContext {
  seller?: {
    display_name?: string | null
    first_name?: string | null
    last_name?: string | null
    email?: string | null
  }
  shop?: {
    name?: string | null
    slug?: string | null
  }
  ticket?: {
    subject?: string | null
    id?: string | null
    category?: string | null
    priority?: string | null
  }
  agent?: {
    display_name?: string | null
  }
}

export interface RenderResult {
  body: string
  warnings: string[]
}

const TOKEN_RE = /\{\{\s*([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\s*\}\}/gi

export function renderCannedReply(
  template: string,
  ctx: CannedReplyContext,
): RenderResult {
  const warnings: string[] = []
  const body = template.replace(TOKEN_RE, (whole, rawObj, rawKey) => {
    // Token names are normalised to lowercase so `{{Seller.Display_Name}}`
    // and `{{seller.display_name}}` both resolve to the same bag entry —
    // context keys are always declared lowercase in `CannedReplyContext`.
    const obj = String(rawObj).toLowerCase()
    const key = String(rawKey).toLowerCase()
    const bag = (ctx as Record<string, Record<string, unknown> | undefined>)[obj]
    if (!bag) {
      warnings.push(`unknown object '${obj}' in '${whole}'`)
      return whole
    }
    const val = bag[key]
    if (val === null || val === undefined) {
      warnings.push(`missing value '${obj}.${key}' in '${whole}'`)
      return whole
    }
    return String(val)
  })
  return { body, warnings }
}
