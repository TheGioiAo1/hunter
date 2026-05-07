/**
 * Tests for the form-field HTML helpers (Phase 2 Step 2.9).
 */

import { describe, it, expect } from 'vitest'
import {
  field,
  textarea,
  select,
  checkbox,
  errorSummary,
  submitButton,
  formFieldCss,
} from './form-field.js'

// ---------------------------------------------------------------------------
// field()
// ---------------------------------------------------------------------------

describe('field', () => {
  it('renders a labeled text input by default', () => {
    const html = field({ name: 'email', label: 'Email' })
    expect(html).toContain('<label for="email"')
    expect(html).toContain('Email')
    expect(html).toContain('type="text"')
    expect(html).toContain('id="email"')
    expect(html).toContain('name="email"')
  })

  it('honors custom type', () => {
    const html = field({ name: 'pw', label: 'Password', type: 'password' })
    expect(html).toContain('type="password"')
  })

  it('renders the provided value', () => {
    const html = field({ name: 'x', label: 'X', value: 'alice' })
    expect(html).toContain('value="alice"')
  })

  it('escapes the value to prevent XSS', () => {
    const html = field({ name: 'x', label: 'X', value: '<img onerror=1>' })
    expect(html).not.toContain('<img onerror=1>')
    expect(html).toContain('&lt;img')
  })

  it('escapes the label', () => {
    const html = field({ name: 'x', label: '<script>alert(1)</script>' })
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('adds required + aria-required when required', () => {
    const html = field({ name: 'x', label: 'X', required: true })
    expect(html).toContain(' required')
    expect(html).toContain('aria-required="true"')
    expect(html).toContain('gbox-field-required')
    expect(html).toContain('*')
  })

  it('adds placeholder when provided', () => {
    const html = field({ name: 'x', label: 'X', placeholder: 'Type here...' })
    expect(html).toContain('placeholder="Type here...')
  })

  it('does not include placeholder attribute when absent', () => {
    const html = field({ name: 'x', label: 'X' })
    expect(html).not.toContain('placeholder=')
  })

  it('renders error message with aria-invalid and aria-describedby', () => {
    const html = field({
      name: 'email',
      label: 'Email',
      errors: { email: 'Enter a valid email address' },
    })
    expect(html).toContain('aria-invalid="true"')
    expect(html).toContain('aria-describedby="email-error"')
    expect(html).toContain('id="email-error"')
    expect(html).toContain('role="alert"')
    expect(html).toContain('Enter a valid email address')
    expect(html).toContain('gbox-field-errored')
    expect(html).toContain('gbox-field-input-error')
  })

  it('escapes error messages', () => {
    const html = field({
      name: 'x',
      label: 'X',
      errors: { x: '<img src=x>' },
    })
    expect(html).not.toContain('<img src=x>')
    expect(html).toContain('&lt;img')
  })

  it('shows help text when no error', () => {
    const html = field({
      name: 'pw',
      label: 'Password',
      help: 'At least 8 characters',
    })
    expect(html).toContain('At least 8 characters')
    expect(html).toContain('aria-describedby="pw-help"')
    expect(html).toContain('id="pw-help"')
    expect(html).toContain('gbox-field-help')
  })

  it('hides help text when there is an error (error takes precedence)', () => {
    const html = field({
      name: 'pw',
      label: 'Password',
      help: 'At least 8 characters',
      errors: { pw: 'Too short' },
    })
    expect(html).not.toContain('At least 8 characters')
    expect(html).toContain('Too short')
    expect(html).toContain('aria-describedby="pw-error"')
  })

  it('does not add aria-invalid when the error is an empty string', () => {
    const html = field({ name: 'x', label: 'X', errors: { x: '' } })
    expect(html).not.toContain('aria-invalid')
  })

  it('ignores errors for other fields', () => {
    const html = field({
      name: 'email',
      label: 'Email',
      errors: { password: 'Wrong' },
    })
    expect(html).not.toContain('aria-invalid')
    expect(html).not.toContain('Wrong')
  })

  it('includes autocomplete and inputmode attributes', () => {
    const html = field({
      name: 'email',
      label: 'Email',
      autocomplete: 'email',
      inputmode: 'email',
    })
    expect(html).toContain('autocomplete="email"')
    expect(html).toContain('inputmode="email"')
  })

  it('honors min/max/step for number inputs', () => {
    const html = field({
      name: 'age',
      label: 'Age',
      type: 'number',
      min: 0,
      max: 150,
      step: 1,
    })
    expect(html).toContain('min="0"')
    expect(html).toContain('max="150"')
    expect(html).toContain('step="1"')
  })

  it('honors minlength/maxlength', () => {
    const html = field({
      name: 'x',
      label: 'X',
      minlength: 3,
      maxlength: 50,
    })
    expect(html).toContain('minlength="3"')
    expect(html).toContain('maxlength="50"')
  })

  it('adds disabled attribute', () => {
    const html = field({ name: 'x', label: 'X', disabled: true })
    expect(html).toContain(' disabled')
  })
})

// ---------------------------------------------------------------------------
// textarea()
// ---------------------------------------------------------------------------

describe('textarea', () => {
  it('renders a textarea with label + default rows', () => {
    const html = textarea({ name: 'bio', label: 'Bio' })
    expect(html).toContain('<textarea')
    expect(html).toContain('name="bio"')
    expect(html).toContain('rows="4"')
    expect(html).toContain('<label for="bio"')
  })

  it('honors custom rows', () => {
    const html = textarea({ name: 'x', label: 'X', rows: 10 })
    expect(html).toContain('rows="10"')
  })

  it('renders the value inside the textarea body (escaped)', () => {
    const html = textarea({ name: 'x', label: 'X', value: '<script>' })
    expect(html).toContain('>&lt;script&gt;</textarea>')
  })

  it('shows error + aria-invalid', () => {
    const html = textarea({
      name: 'bio',
      label: 'Bio',
      errors: { bio: 'Too short' },
    })
    expect(html).toContain('aria-invalid="true"')
    expect(html).toContain('Too short')
  })
})

// ---------------------------------------------------------------------------
// select()
// ---------------------------------------------------------------------------

describe('select', () => {
  it('renders options with the matching one selected', () => {
    const html = select({
      name: 'color',
      label: 'Color',
      value: 'red',
      options: [
        { value: 'red', label: 'Red' },
        { value: 'blue', label: 'Blue' },
      ],
    })
    expect(html).toContain('<select')
    expect(html).toContain('<option value="red" selected>Red</option>')
    expect(html).toContain('<option value="blue">Blue</option>')
  })

  it('honors disabled options', () => {
    const html = select({
      name: 'c',
      label: 'C',
      options: [{ value: 'a', label: 'A', disabled: true }],
    })
    expect(html).toContain('disabled>A</option>')
  })

  it('escapes option labels', () => {
    const html = select({
      name: 'c',
      label: 'C',
      options: [{ value: 'a', label: '<bad>' }],
    })
    expect(html).toContain('&lt;bad&gt;')
    expect(html).not.toContain('<bad>')
  })

  it('shows error on the select itself', () => {
    const html = select({
      name: 'c',
      label: 'C',
      options: [{ value: 'a', label: 'A' }],
      errors: { c: 'Pick one' },
    })
    expect(html).toContain('aria-invalid="true"')
    expect(html).toContain('Pick one')
  })
})

// ---------------------------------------------------------------------------
// checkbox()
// ---------------------------------------------------------------------------

describe('checkbox', () => {
  it('renders an unchecked checkbox with label', () => {
    const html = checkbox({ name: 'tos', label: 'I agree to the terms' })
    expect(html).toContain('type="checkbox"')
    expect(html).toContain('name="tos"')
    expect(html).toContain('I agree to the terms')
    expect(html).not.toContain(' checked')
  })

  it('renders checked when true', () => {
    const html = checkbox({ name: 'x', label: 'X', checked: true })
    expect(html).toContain(' checked')
  })

  it('shows error + aria-invalid', () => {
    const html = checkbox({
      name: 'tos',
      label: 'Accept',
      errors: { tos: 'Required' },
    })
    expect(html).toContain('aria-invalid="true"')
    expect(html).toContain('Required')
  })
})

// ---------------------------------------------------------------------------
// errorSummary()
// ---------------------------------------------------------------------------

describe('errorSummary', () => {
  it('returns empty string when no errors', () => {
    expect(errorSummary({})).toBe('')
  })

  it('lists all errors with jump links', () => {
    const html = errorSummary({
      email: 'Invalid email',
      password: 'Too short',
    })
    expect(html).toContain('role="alert"')
    expect(html).toContain('tabindex="-1"')
    expect(html).toContain('href="#email"')
    expect(html).toContain('href="#password"')
    expect(html).toContain('Invalid email')
    expect(html).toContain('Too short')
  })

  it('uses default heading', () => {
    const html = errorSummary({ x: 'Bad' })
    expect(html).toContain('There was a problem')
  })

  it('honors custom heading', () => {
    const html = errorSummary({ x: 'Bad' }, 'Fix these fields')
    expect(html).toContain('Fix these fields')
  })

  it('escapes error messages', () => {
    const html = errorSummary({ x: '<script>alert(1)</script>' })
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;')
  })
})

// ---------------------------------------------------------------------------
// submitButton()
// ---------------------------------------------------------------------------

describe('submitButton', () => {
  it('accepts a string shorthand', () => {
    const html = submitButton('Save')
    expect(html).toContain('<button')
    expect(html).toContain('type="submit"')
    expect(html).toContain('Save')
    expect(html).toContain('gbox-field-submit-primary')
  })

  it('honors kind', () => {
    expect(submitButton({ label: 'Delete', kind: 'danger' })).toContain(
      'gbox-field-submit-danger',
    )
    expect(submitButton({ label: 'Cancel', kind: 'secondary' })).toContain(
      'gbox-field-submit-secondary',
    )
  })

  it('supports disabled', () => {
    expect(submitButton({ label: 'X', disabled: true })).toContain(' disabled')
  })

  it('escapes the label', () => {
    const html = submitButton({ label: '<img src=x>' })
    expect(html).not.toContain('<img src=x>')
    expect(html).toContain('&lt;img')
  })
})

// ---------------------------------------------------------------------------
// formFieldCss()
// ---------------------------------------------------------------------------

describe('formFieldCss', () => {
  it('defines the core classes', () => {
    const css = formFieldCss()
    expect(css).toContain('.gbox-field-label')
    expect(css).toContain('.gbox-field-input')
    expect(css).toContain('.gbox-field-error')
    expect(css).toContain('.gbox-field-help')
    expect(css).toContain('.gbox-error-summary')
    expect(css).toContain('.gbox-field-submit')
  })

  it('highlights error state with the danger color', () => {
    const css = formFieldCss()
    expect(css).toContain('.gbox-field-input-error')
    expect(css).toContain('var(--god-danger')
  })
})
