/**
 * Gbox Platform — Forms module
 *
 * Phase 2 Step 2.9: form validation library.
 * Pair with `@gbox/core/modules/ui/form-field` for the HTML helpers.
 */

export {
  type Validator,
  type FormSchema,
  type FieldErrors,
  type ValidationResult,
  validate,
  required,
  email,
  minLength,
  maxLength,
  pattern,
  numeric,
  min,
  max,
  integer,
  url,
  slug,
  oneOf,
  matches,
  matchesField,
  custom,
} from './validate.js'
