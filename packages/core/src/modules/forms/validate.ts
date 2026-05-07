/**
 * Gbox Platform — Form Validation (Phase 2 Step 2.9)
 *
 * Pure validator library + schema-driven `validate()` that returns a
 * field-error map ready to feed into the `field()` HTML helper. No
 * runtime dependency, no framework coupling — works equally well as:
 *
 *   - Server-side POST handler that re-renders the form with errors
 *   - Client-side onblur/onsubmit pre-flight
 *   - Programmatic validation inside a service-layer test
 *
 * Philosophy
 * ----------
 * Clone Shopify: all Shopify admin forms show per-field inline errors
 * with accessible `aria-invalid` + `aria-describedby` wiring and a
 * summary list at the top that focus-jumps to the first bad field.
 *
 * Power-ful hơn Shopify nhờ Claude: one schema drives BOTH sides of
 * the boundary (server re-render AND client pre-flight) so the
 * error messages are guaranteed to match — no "client says OK, server
 * says nope" ping-pong.
 *
 * Usage
 * -----
 * ```ts
 * const schema: FormSchema = {
 *   email:    [required(), email()],
 *   password: [required(), minLength(8)],
 *   age:      [numeric(), min(13)],
 * }
 *
 * const result = validate(formData, schema)
 * if (!result.ok) {
 *   return render(formHtml({ errors: result.errors, values: formData }))
 * }
 * ```
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A single validator. Returns `null` on success, or an error message
 * string. Value is unknown because it comes from req.body which is
 * untyped.
 */
export type Validator = (value: unknown, field: string) => string | null

/**
 * Schema maps field name → list of validators run in order. First
 * failure wins (we don't pile up messages per field).
 */
export type FormSchema = Record<string, Validator[]>

/**
 * Field error map — value is a human-readable message ready for
 * direct rendering via the `field()` helper. Missing key means
 * that field passed validation.
 */
export type FieldErrors = Record<string, string>

/**
 * Success: normalized data (strings trimmed, numbers coerced, etc.)
 * Failure: field → message map.
 */
export type ValidationResult<T = Record<string, unknown>> =
  | { ok: true; data: T }
  | { ok: false; errors: FieldErrors }

// ---------------------------------------------------------------------------
// Core validator factory
// ---------------------------------------------------------------------------

/**
 * Run all validators for every field in the schema. Each validator
 * gets the raw field value and the field name (in case the message
 * wants to echo it). Returns on first error per field — downstream
 * UI only needs one message per row.
 */
export function validate<T = Record<string, unknown>>(
  data: Record<string, unknown>,
  schema: FormSchema,
): ValidationResult<T> {
  const errors: FieldErrors = {}
  for (const field of Object.keys(schema)) {
    const value = data[field]
    for (const v of schema[field]) {
      const msg = v(value, field)
      if (msg !== null) {
        errors[field] = msg
        break // first-error-wins
      }
    }
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors }
  return { ok: true, data: data as T }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true
  if (typeof value === 'string' && value.trim() === '') return true
  if (Array.isArray(value) && value.length === 0) return true
  return false
}

function asString(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  return String(value)
}

function prettyField(field: string): string {
  // Convert snake_case / camelCase → Title Case for error messages.
  return field
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^./, c => c.toUpperCase())
}

// ---------------------------------------------------------------------------
// Built-in validators (all exported as factories so callers can
// customize the message — "first failure wins" inside validate())
// ---------------------------------------------------------------------------

/** Field must be present and non-empty (after trim for strings). */
export function required(message?: string): Validator {
  return (value, field) => {
    if (isEmpty(value)) return message ?? `${prettyField(field)} is required`
    return null
  }
}

/** Simple RFC-ish email sanity check; NOT a full RFC 5322 validator. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
export function email(message = 'Enter a valid email address'): Validator {
  return value => {
    if (isEmpty(value)) return null // use required() to enforce presence
    const str = asString(value).trim()
    if (!EMAIL_RE.test(str)) return message
    return null
  }
}

/** String length >= min (after trim). */
export function minLength(n: number, message?: string): Validator {
  return (value, field) => {
    if (isEmpty(value)) return null
    const str = asString(value).trim()
    if (str.length < n) {
      return (
        message ??
        `${prettyField(field)} must be at least ${n} character${n === 1 ? '' : 's'}`
      )
    }
    return null
  }
}

/** String length <= max. */
export function maxLength(n: number, message?: string): Validator {
  return (value, field) => {
    if (isEmpty(value)) return null
    const str = asString(value)
    if (str.length > n) {
      return (
        message ??
        `${prettyField(field)} must be at most ${n} character${n === 1 ? '' : 's'}`
      )
    }
    return null
  }
}

/** Regex match. Must pass the flag-less regex literal — we add no flags. */
export function pattern(
  re: RegExp,
  message = 'Invalid format',
): Validator {
  return value => {
    if (isEmpty(value)) return null
    const str = asString(value)
    if (!re.test(str)) return message
    return null
  }
}

/** Value must parse as a finite number. Does NOT require presence. */
export function numeric(message = 'Must be a number'): Validator {
  return value => {
    if (isEmpty(value)) return null
    const str = asString(value).trim()
    const n = Number(str)
    if (!Number.isFinite(n)) return message
    return null
  }
}

/** Numeric lower bound (inclusive). Implies numeric(). */
export function min(bound: number, message?: string): Validator {
  return (value, field) => {
    if (isEmpty(value)) return null
    const n = Number(asString(value).trim())
    if (!Number.isFinite(n)) return `Must be a number`
    if (n < bound) {
      return message ?? `${prettyField(field)} must be at least ${bound}`
    }
    return null
  }
}

/** Numeric upper bound (inclusive). */
export function max(bound: number, message?: string): Validator {
  return (value, field) => {
    if (isEmpty(value)) return null
    const n = Number(asString(value).trim())
    if (!Number.isFinite(n)) return `Must be a number`
    if (n > bound) {
      return message ?? `${prettyField(field)} must be at most ${bound}`
    }
    return null
  }
}

/** Integer check (no decimal part). */
export function integer(message = 'Must be a whole number'): Validator {
  return value => {
    if (isEmpty(value)) return null
    const n = Number(asString(value).trim())
    if (!Number.isInteger(n)) return message
    return null
  }
}

/** URL parseable via the URL constructor. */
export function url(message = 'Enter a valid URL'): Validator {
  return value => {
    if (isEmpty(value)) return null
    try {
      // eslint-disable-next-line no-new
      new URL(asString(value).trim())
      return null
    } catch {
      return message
    }
  }
}

/** Lowercase-ASCII slug (e.g., "my-slug-42"). */
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/
export function slug(
  message = 'Only lowercase letters, numbers, and hyphens',
): Validator {
  return value => {
    if (isEmpty(value)) return null
    if (!SLUG_RE.test(asString(value))) return message
    return null
  }
}

/** Value must be one of the allowed options (enum-style select). */
export function oneOf(
  options: readonly string[],
  message?: string,
): Validator {
  return (value, field) => {
    if (isEmpty(value)) return null
    if (!options.includes(asString(value))) {
      return (
        message ??
        `${prettyField(field)} must be one of: ${options.join(', ')}`
      )
    }
    return null
  }
}

/** Two-field match (e.g., password confirmation). */
export function matches(
  otherField: string,
  message?: string,
): Validator {
  // Note: this factory doesn't have access to sibling field values —
  // wrap it in a closure capturing the form data at call time.
  // For schema-driven `validate()`, use `matchesData` below instead.
  return () => message ?? `Must match ${prettyField(otherField)}`
}

/**
 * Factory that captures sibling data so `validate()` can check two
 * fields against each other. Usage:
 *
 * ```ts
 * const schema = {
 *   password:         [required(), minLength(8)],
 *   password_confirm: [required(), matchesField('password', formData)],
 * }
 * ```
 */
export function matchesField(
  otherField: string,
  data: Record<string, unknown>,
  message?: string,
): Validator {
  return (value, field) => {
    if (isEmpty(value)) return null
    if (asString(value) !== asString(data[otherField])) {
      return (
        message ?? `${prettyField(field)} must match ${prettyField(otherField)}`
      )
    }
    return null
  }
}

/** Custom validator. Keeps call sites readable when embedding logic. */
export function custom(
  fn: (value: unknown, field: string) => boolean,
  message = 'Invalid value',
): Validator {
  return (value, field) => (fn(value, field) ? null : message)
}
