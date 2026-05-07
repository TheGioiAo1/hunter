/**
 * Gbox Platform — i18n Interpolation
 *
 * Decision #1 Step 1.2b — Pure string substitution helper for the
 * `t()` lookup. Replaces every `{{ name }}` (Liquid-style) token in
 * a translation string with the matching key from `vars`.
 *
 * Why a hand-rolled regex instead of `liquidjs.parseAndRender(value, vars)`?
 *   1. Translation values are trusted (admin-edited, never user input
 *      from the storefront), so we don't need full Liquid sandboxing.
 *   2. liquidjs's parser is async; the `t` filter has to be sync-friendly
 *      to plug into the LiquidJS filter API without a microtask hop on
 *      every key.
 *   3. Theme strings interpolate at most ~3 vars on average; a regex
 *      runs ~10x faster than spinning up a Liquid template per call.
 *
 * Behavior matches Shopify:
 *   - Whitespace inside the braces is tolerated: `{{name}}` and `{{ name }}`
 *     are both valid.
 *   - Missing keys leave the token literal in the output. This is the
 *     Shopify default and makes missing-translation bugs obvious in dev.
 *   - Numeric values are coerced via `String(value)`.
 *   - `null` / `undefined` cause the token to be left literal too —
 *     they are NOT rendered as the strings "null" / "undefined".
 *   - HTML escaping is NOT done here. The Liquid output filter (the
 *     thing that prints `{{ ... }}`) handles escaping at the template
 *     level. Translations are plain text from the engine's POV.
 */

import type { InterpolationVars } from './types.js'

/**
 * Token regex: matches `{{ name }}` with arbitrary inner whitespace.
 * The captured group is the variable name (no leading/trailing space).
 *
 *   \{\{      — literal `{{`
 *   \s*       — leading whitespace
 *   ([\w.-]+) — capture: word chars, dots, dashes (no spaces in names)
 *   \s*       — trailing whitespace
 *   \}\}      — literal `}}`
 *
 * Dots are allowed so a translation could reference `user.first_name`
 * style nested vars (the engine flattens them with dot notation before
 * passing to interpolate()).
 */
const TOKEN_RE = /\{\{\s*([\w.-]+)\s*\}\}/g

export function interpolate(template: string, vars?: InterpolationVars): string {
  if (!vars) return template
  if (template.indexOf('{{') === -1) return template // fast path: no tokens

  return template.replace(TOKEN_RE, (match, name: string) => {
    const value = vars[name]
    if (value === null || value === undefined) return match // leave literal
    return String(value)
  })
}
