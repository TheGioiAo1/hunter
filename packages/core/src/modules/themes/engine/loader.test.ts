/**
 * Gbox Platform — TemplateLoader interface unit tests
 *
 * Decision #1 Step 1.3 — Tests for the path normalizer + path-builder
 * helpers. The interface itself has no runtime; it's tested indirectly
 * by the loader implementation tests.
 */

import { describe, it, expect } from 'vitest'
import { normalizeLogicalPath, themePath } from './index.js'

describe('normalizeLogicalPath()', () => {
  it('passes through a simple POSIX path', () => {
    expect(normalizeLogicalPath('sections/header.liquid')).toBe(
      'sections/header.liquid',
    )
  })

  it('strips a leading slash', () => {
    expect(normalizeLogicalPath('/layout/theme.liquid')).toBe('layout/theme.liquid')
  })

  it('collapses repeated slashes', () => {
    expect(normalizeLogicalPath('snippets//foo//bar.liquid')).toBe(
      'snippets/foo/bar.liquid',
    )
  })

  it('converts Windows backslashes to forward slashes', () => {
    expect(normalizeLogicalPath('templates\\products\\widget.liquid')).toBe(
      'templates/products/widget.liquid',
    )
  })

  it('rejects "..\" segment as path traversal', () => {
    expect(() => normalizeLogicalPath('snippets/../etc/passwd')).toThrow(/traversal/)
  })

  it('rejects ".\" segment', () => {
    expect(() => normalizeLogicalPath('./snippets/foo.liquid')).toThrow(/traversal/)
  })

  it('rejects mixed traversal hidden behind backslashes', () => {
    expect(() => normalizeLogicalPath('snippets\\..\\..\\secret')).toThrow(/traversal/)
  })

  it('allows filenames that START with .. but have other chars', () => {
    // `..foo.liquid` is a legitimate (if weird) filename — only the
    // segment `..` exactly is dangerous.
    expect(normalizeLogicalPath('snippets/..foo.liquid')).toBe(
      'snippets/..foo.liquid',
    )
  })

  it('allows filenames that contain dots', () => {
    expect(normalizeLogicalPath('locales/en.default.json')).toBe(
      'locales/en.default.json',
    )
  })

  it('throws on empty string', () => {
    expect(() => normalizeLogicalPath('')).toThrow(/empty/)
  })

  it('throws on non-string input', () => {
    expect(() => normalizeLogicalPath(null as any)).toThrow(/must be a string/)
    expect(() => normalizeLogicalPath(123 as any)).toThrow(/must be a string/)
  })
})

describe('themePath helpers', () => {
  it('layout()', () => {
    expect(themePath.layout('theme')).toBe('layout/theme.liquid')
  })
  it('template()', () => {
    expect(themePath.template('product')).toBe('templates/product.liquid')
  })
  it('templateJson()', () => {
    expect(themePath.templateJson('index')).toBe('templates/index.json')
  })
  it('customerTemplate()', () => {
    expect(themePath.customerTemplate('login')).toBe('templates/customers/login.liquid')
  })
  it('section()', () => {
    expect(themePath.section('header')).toBe('sections/header.liquid')
  })
  it('snippet()', () => {
    expect(themePath.snippet('product-card')).toBe('snippets/product-card.liquid')
  })
  it('locale()', () => {
    expect(themePath.locale('en.default')).toBe('locales/en.default.json')
  })
  it('configData()', () => {
    expect(themePath.configData()).toBe('config/settings_data.json')
  })
  it('configSchema()', () => {
    expect(themePath.configSchema()).toBe('config/settings_schema.json')
  })
})
