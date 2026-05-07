/**
 * Gbox Platform — Form Field HTML Helpers (Phase 2 Step 2.9)
 *
 * Drop-in HTML fragments for form fields with consistent styling,
 * full a11y wiring (label → input via `for`/`id`, error → input via
 * `aria-describedby`, and `aria-invalid="true"` when errored), and a
 * red inline error message that sits directly below the control.
 *
 * Pair with `@gbox/core/modules/forms/validate.ts`: feed its
 * `errors` map into these helpers and the form reflects server-side
 * validation instantly.
 *
 * Philosophy: clone Shopify (per-field error with icon + aria) +
 * power-ful hơn Shopify (a single shared helper drives god-admin and
 * seller-admin so error styling stays in lock-step across both).
 *
 * Usage
 * -----
 * ```ts
 * const result = validate(req.body, schema)
 * const errors = result.ok ? {} : result.errors
 * const html = formHtml([
 *   field({ name: 'email', label: 'Email', type: 'email',
 *           value: req.body.email, errors, required: true }),
 *   field({ name: 'password', label: 'Password', type: 'password',
 *           errors, required: true, help: 'At least 8 characters' }),
 *   submitButton('Sign in'),
 * ])
 * ```
 */

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function errorIdFor(name: string): string {
  return `${name}-error`
}

function helpIdFor(name: string): string {
  return `${name}-help`
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type InputType =
  | 'text'
  | 'email'
  | 'password'
  | 'number'
  | 'tel'
  | 'url'
  | 'search'
  | 'date'
  | 'time'
  | 'datetime-local'
  | 'color'
  | 'hidden'

export interface FieldOptions {
  /** Input name attribute — must be unique within the form. */
  name: string
  /** Visible label text. */
  label: string
  /** Input type. Defaults to `text`. */
  type?: InputType
  /** Current value. Stringified. */
  value?: string | number | null | undefined
  /** Placeholder text. */
  placeholder?: string
  /** Inline help text displayed under the input when there's no error. */
  help?: string
  /** Field errors map from validate(); reads `errors[name]`. */
  errors?: Record<string, string>
  /** Mark as required — adds `aria-required` and a visual asterisk. */
  required?: boolean
  /** Disable the field. */
  disabled?: boolean
  /** Readonly (shown but not editable). */
  readonly?: boolean
  /** Autocomplete token (e.g., 'email', 'current-password'). */
  autocomplete?: string
  /** HTML inputmode for mobile keyboards. */
  inputmode?: string
  /** Pattern for client-side HTML5 validation. */
  pattern?: string
  /** Min length for text. */
  minlength?: number
  /** Max length for text. */
  maxlength?: number
  /** Min for number/date. */
  min?: string | number
  /** Max for number/date. */
  max?: string | number
  /** Step for number. */
  step?: string | number
}

export interface TextareaOptions extends Omit<FieldOptions, 'type'> {
  rows?: number
  cols?: number
}

export interface SelectOption {
  value: string
  label: string
  disabled?: boolean
}

export interface SelectOptions extends Omit<FieldOptions, 'type' | 'value'> {
  options: SelectOption[]
  value?: string | null
}

export interface CheckboxOptions {
  name: string
  label: string
  checked?: boolean
  value?: string
  disabled?: boolean
  help?: string
  errors?: Record<string, string>
}

// ---------------------------------------------------------------------------
// field() — text / email / password / number / etc.
// ---------------------------------------------------------------------------

export function field(opts: FieldOptions): string {
  const {
    name,
    label,
    type = 'text',
    value,
    placeholder,
    help,
    errors,
    required: isRequired,
    disabled,
    readonly,
    autocomplete,
    inputmode,
    pattern,
    minlength,
    maxlength,
    min,
    max,
    step,
  } = opts

  const error = errors?.[name]
  const hasError = typeof error === 'string' && error.length > 0
  const describedBy: string[] = []
  if (hasError) describedBy.push(errorIdFor(name))
  if (help && !hasError) describedBy.push(helpIdFor(name))

  const attrs: string[] = [
    `id="${esc(name)}"`,
    `name="${esc(name)}"`,
    `type="${esc(type)}"`,
    `class="gbox-field-input${hasError ? ' gbox-field-input-error' : ''}"`,
  ]
  if (value !== undefined && value !== null && value !== '') {
    attrs.push(`value="${esc(String(value))}"`)
  }
  if (placeholder) attrs.push(`placeholder="${esc(placeholder)}"`)
  if (isRequired) {
    attrs.push('required')
    attrs.push('aria-required="true"')
  }
  if (disabled) attrs.push('disabled')
  if (readonly) attrs.push('readonly')
  if (autocomplete) attrs.push(`autocomplete="${esc(autocomplete)}"`)
  if (inputmode) attrs.push(`inputmode="${esc(inputmode)}"`)
  if (pattern) attrs.push(`pattern="${esc(pattern)}"`)
  if (minlength !== undefined) attrs.push(`minlength="${minlength}"`)
  if (maxlength !== undefined) attrs.push(`maxlength="${maxlength}"`)
  if (min !== undefined) attrs.push(`min="${esc(String(min))}"`)
  if (max !== undefined) attrs.push(`max="${esc(String(max))}"`)
  if (step !== undefined) attrs.push(`step="${esc(String(step))}"`)
  if (hasError) attrs.push('aria-invalid="true"')
  if (describedBy.length > 0) {
    attrs.push(`aria-describedby="${describedBy.join(' ')}"`)
  }

  return renderWrapper({
    name,
    label,
    required: !!isRequired,
    control: `<input ${attrs.join(' ')} />`,
    error,
    help,
    hasError,
  })
}

// ---------------------------------------------------------------------------
// textarea()
// ---------------------------------------------------------------------------

export function textarea(opts: TextareaOptions): string {
  const {
    name,
    label,
    value,
    placeholder,
    help,
    errors,
    required: isRequired,
    disabled,
    readonly,
    rows = 4,
    cols,
    minlength,
    maxlength,
  } = opts

  const error = errors?.[name]
  const hasError = typeof error === 'string' && error.length > 0
  const describedBy: string[] = []
  if (hasError) describedBy.push(errorIdFor(name))
  if (help && !hasError) describedBy.push(helpIdFor(name))

  const attrs: string[] = [
    `id="${esc(name)}"`,
    `name="${esc(name)}"`,
    `class="gbox-field-input gbox-field-textarea${hasError ? ' gbox-field-input-error' : ''}"`,
    `rows="${rows}"`,
  ]
  if (cols !== undefined) attrs.push(`cols="${cols}"`)
  if (placeholder) attrs.push(`placeholder="${esc(placeholder)}"`)
  if (isRequired) {
    attrs.push('required')
    attrs.push('aria-required="true"')
  }
  if (disabled) attrs.push('disabled')
  if (readonly) attrs.push('readonly')
  if (minlength !== undefined) attrs.push(`minlength="${minlength}"`)
  if (maxlength !== undefined) attrs.push(`maxlength="${maxlength}"`)
  if (hasError) attrs.push('aria-invalid="true"')
  if (describedBy.length > 0) {
    attrs.push(`aria-describedby="${describedBy.join(' ')}"`)
  }

  const body =
    value !== undefined && value !== null ? esc(String(value)) : ''
  const control = `<textarea ${attrs.join(' ')}>${body}</textarea>`

  return renderWrapper({
    name,
    label,
    required: !!isRequired,
    control,
    error,
    help,
    hasError,
  })
}

// ---------------------------------------------------------------------------
// select()
// ---------------------------------------------------------------------------

export function select(opts: SelectOptions): string {
  const {
    name,
    label,
    value,
    options,
    help,
    errors,
    required: isRequired,
    disabled,
  } = opts

  const error = errors?.[name]
  const hasError = typeof error === 'string' && error.length > 0
  const describedBy: string[] = []
  if (hasError) describedBy.push(errorIdFor(name))
  if (help && !hasError) describedBy.push(helpIdFor(name))

  const attrs: string[] = [
    `id="${esc(name)}"`,
    `name="${esc(name)}"`,
    `class="gbox-field-input gbox-field-select${hasError ? ' gbox-field-input-error' : ''}"`,
  ]
  if (isRequired) {
    attrs.push('required')
    attrs.push('aria-required="true"')
  }
  if (disabled) attrs.push('disabled')
  if (hasError) attrs.push('aria-invalid="true"')
  if (describedBy.length > 0) {
    attrs.push(`aria-describedby="${describedBy.join(' ')}"`)
  }

  const optionsHtml = options
    .map(o => {
      const selected = value !== undefined && value !== null && value === o.value
      return `<option value="${esc(o.value)}"${selected ? ' selected' : ''}${o.disabled ? ' disabled' : ''}>${esc(o.label)}</option>`
    })
    .join('')

  const control = `<select ${attrs.join(' ')}>${optionsHtml}</select>`

  return renderWrapper({
    name,
    label,
    required: !!isRequired,
    control,
    error,
    help,
    hasError,
  })
}

// ---------------------------------------------------------------------------
// checkbox()
// ---------------------------------------------------------------------------

export function checkbox(opts: CheckboxOptions): string {
  const {
    name,
    label,
    checked,
    value = 'on',
    disabled,
    help,
    errors,
  } = opts

  const error = errors?.[name]
  const hasError = typeof error === 'string' && error.length > 0
  const describedBy: string[] = []
  if (hasError) describedBy.push(errorIdFor(name))
  if (help && !hasError) describedBy.push(helpIdFor(name))

  const attrs: string[] = [
    `id="${esc(name)}"`,
    `name="${esc(name)}"`,
    `type="checkbox"`,
    `value="${esc(value)}"`,
    `class="gbox-field-checkbox${hasError ? ' gbox-field-input-error' : ''}"`,
  ]
  if (checked) attrs.push('checked')
  if (disabled) attrs.push('disabled')
  if (hasError) attrs.push('aria-invalid="true"')
  if (describedBy.length > 0) {
    attrs.push(`aria-describedby="${describedBy.join(' ')}"`)
  }

  let html = `<div class="gbox-field${hasError ? ' gbox-field-errored' : ''}">`
  html += `<label class="gbox-field-checkbox-row">`
  html += `<input ${attrs.join(' ')} />`
  html += `<span class="gbox-field-checkbox-label">${esc(label)}</span>`
  html += `</label>`
  if (hasError) {
    html += `<p id="${esc(errorIdFor(name))}" class="gbox-field-error" role="alert">${esc(error!)}</p>`
  } else if (help) {
    html += `<p id="${esc(helpIdFor(name))}" class="gbox-field-help">${esc(help)}</p>`
  }
  html += `</div>`
  return html
}

// ---------------------------------------------------------------------------
// Shared wrapper
// ---------------------------------------------------------------------------

interface WrapperOpts {
  name: string
  label: string
  required: boolean
  control: string
  error: string | undefined
  help: string | undefined
  hasError: boolean
}

function renderWrapper(opts: WrapperOpts): string {
  const { name, label, required: isRequired, control, error, help, hasError } = opts
  const reqMark = isRequired
    ? ' <span class="gbox-field-required" aria-hidden="true">*</span>'
    : ''

  let html = `<div class="gbox-field${hasError ? ' gbox-field-errored' : ''}">`
  html += `<label for="${esc(name)}" class="gbox-field-label">${esc(label)}${reqMark}</label>`
  html += control
  if (hasError) {
    html += `<p id="${esc(errorIdFor(name))}" class="gbox-field-error" role="alert">${esc(error!)}</p>`
  } else if (help) {
    html += `<p id="${esc(helpIdFor(name))}" class="gbox-field-help">${esc(help)}</p>`
  }
  html += `</div>`
  return html
}

// ---------------------------------------------------------------------------
// Error summary (focus target at top of form)
// ---------------------------------------------------------------------------

/**
 * Summary box listing all field errors at the top of a form. WCAG
 * best practice — a single scroll-into-view summary that links to
 * each invalid field. Links set `href="#fieldName"` which focuses
 * the control when clicked.
 */
export function errorSummary(
  errors: Record<string, string>,
  heading = 'There was a problem with your submission',
): string {
  const keys = Object.keys(errors)
  if (keys.length === 0) return ''
  const items = keys
    .map(
      k =>
        `<li><a href="#${esc(k)}" class="gbox-error-summary-link">${esc(errors[k])}</a></li>`,
    )
    .join('')
  return `
    <div class="gbox-error-summary" role="alert" tabindex="-1">
      <strong class="gbox-error-summary-heading">${esc(heading)}</strong>
      <ul class="gbox-error-summary-list">${items}</ul>
    </div>
  `.trim()
}

// ---------------------------------------------------------------------------
// Submit button helper
// ---------------------------------------------------------------------------

export interface SubmitButtonOptions {
  label: string
  kind?: 'primary' | 'secondary' | 'danger'
  disabled?: boolean
  name?: string
  value?: string
}

export function submitButton(opts: SubmitButtonOptions | string): string {
  const o: SubmitButtonOptions =
    typeof opts === 'string' ? { label: opts } : opts
  const kind = o.kind ?? 'primary'
  const attrs: string[] = [
    `type="submit"`,
    `class="gbox-field-submit gbox-field-submit-${kind}"`,
  ]
  if (o.disabled) attrs.push('disabled')
  if (o.name) attrs.push(`name="${esc(o.name)}"`)
  if (o.value !== undefined) attrs.push(`value="${esc(o.value)}"`)
  return `<button ${attrs.join(' ')}>${esc(o.label)}</button>`
}

// ---------------------------------------------------------------------------
// CSS
// ---------------------------------------------------------------------------

export function formFieldCss(): string {
  return `
    .gbox-field {
      margin-bottom: 16px;
    }
    .gbox-field-label {
      display: block;
      font-size: 13px;
      font-weight: 500;
      margin-bottom: 6px;
      color: var(--god-text, #111);
    }
    .gbox-field-required {
      color: var(--god-danger, #ef4444);
      margin-left: 2px;
    }
    .gbox-field-input {
      width: 100%;
      padding: 9px 12px;
      font-size: 14px;
      line-height: 1.4;
      border: 1px solid var(--god-border, #d1d5db);
      border-radius: 6px;
      background: var(--god-bg, #fff);
      color: var(--god-text, #111);
      box-sizing: border-box;
      transition: border-color 0.15s, box-shadow 0.15s;
    }
    .gbox-field-input::placeholder {
      color: var(--god-text-muted, #9ca3af);
    }
    .gbox-field-input:hover:not(:disabled):not(:focus) {
      border-color: var(--god-text-muted, #9ca3af);
    }
    .gbox-field-input:focus {
      outline: none;
      border-color: var(--god-accent, #3b82f6);
      box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.15);
    }
    .gbox-field-input:disabled {
      background: var(--god-bg-muted, #f3f4f6);
      cursor: not-allowed;
      opacity: 0.7;
    }
    .gbox-field-input-error {
      border-color: var(--god-danger, #ef4444) !important;
    }
    .gbox-field-input-error:focus {
      box-shadow: 0 0 0 3px rgba(239, 68, 68, 0.15);
    }
    .gbox-field-textarea {
      resize: vertical;
      min-height: 80px;
      font-family: inherit;
    }
    .gbox-field-select {
      appearance: none;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%236b7280' stroke-width='2'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E");
      background-repeat: no-repeat;
      background-position: right 12px center;
      padding-right: 34px;
    }
    .gbox-field-checkbox-row {
      display: flex;
      align-items: center;
      gap: 8px;
      cursor: pointer;
    }
    .gbox-field-checkbox {
      width: 16px;
      height: 16px;
      margin: 0;
      cursor: pointer;
      accent-color: var(--god-accent, #3b82f6);
    }
    .gbox-field-checkbox-label {
      font-size: 14px;
      color: var(--god-text, #111);
    }
    .gbox-field-error {
      margin: 6px 0 0 0;
      font-size: 12px;
      color: var(--god-danger, #ef4444);
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .gbox-field-error::before {
      content: "⚠";
      font-size: 13px;
    }
    .gbox-field-help {
      margin: 6px 0 0 0;
      font-size: 12px;
      color: var(--god-text-muted, #6b7280);
    }
    .gbox-error-summary {
      margin-bottom: 16px;
      padding: 12px 16px;
      background: rgba(239, 68, 68, 0.08);
      border-left: 4px solid var(--god-danger, #ef4444);
      border-radius: 4px;
      color: var(--god-text, #111);
    }
    .gbox-error-summary:focus {
      outline: 2px solid var(--god-danger, #ef4444);
      outline-offset: 2px;
    }
    .gbox-error-summary-heading {
      display: block;
      font-size: 14px;
      font-weight: 600;
      margin-bottom: 6px;
      color: var(--god-danger, #ef4444);
    }
    .gbox-error-summary-list {
      margin: 0;
      padding-left: 18px;
      font-size: 13px;
    }
    .gbox-error-summary-link {
      color: var(--god-danger, #ef4444);
      text-decoration: underline;
    }
    .gbox-field-submit {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 10px 18px;
      font-size: 14px;
      font-weight: 600;
      border: 1px solid transparent;
      border-radius: 6px;
      cursor: pointer;
      transition: background-color 0.15s, border-color 0.15s, transform 0.05s;
    }
    .gbox-field-submit:disabled {
      cursor: not-allowed;
      opacity: 0.5;
    }
    .gbox-field-submit:active:not(:disabled) {
      transform: translateY(1px);
    }
    .gbox-field-submit-primary {
      background: var(--god-accent, #3b82f6);
      color: #fff;
    }
    .gbox-field-submit-primary:hover:not(:disabled) {
      background: var(--god-accent-hover, #2563eb);
    }
    .gbox-field-submit-secondary {
      background: transparent;
      color: var(--god-text, #111);
      border-color: var(--god-border, #d1d5db);
    }
    .gbox-field-submit-secondary:hover:not(:disabled) {
      background: var(--god-bg-muted, #f3f4f6);
    }
    .gbox-field-submit-danger {
      background: var(--god-danger, #ef4444);
      color: #fff;
    }
    .gbox-field-submit-danger:hover:not(:disabled) {
      background: #dc2626;
    }
  `
}
