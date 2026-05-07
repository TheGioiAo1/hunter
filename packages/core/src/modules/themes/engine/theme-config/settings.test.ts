/**
 * Gbox Platform — Theme settings parser + resolver tests
 *
 * Decision #1 Step 1.15a. Covers `parseThemeSettingsSchema`,
 * `parseThemeSettingsData`, and `resolveThemeSettings` against
 * Shopify's three settings_data formats and the documented silent-
 * fallback behavior.
 *
 * Coverage:
 *   1. Schema parser accepts a top-level array
 *   2. Schema parser throws on invalid JSON
 *   3. Schema parser throws on non-array top level
 *   4. Schema parser is permissive on missing `settings` / `name`
 *   5. Schema parser preserves pass-through fields (icon, theme_info metadata)
 *   6. Data parser accepts an object
 *   7. Data parser throws on invalid JSON
 *   8. Data parser throws on non-object top level
 *   9. Resolver returns schema defaults when data is missing
 *  10. Resolver Format A — `current` is preset name string
 *  11. Resolver Format B — `current` is inline object
 *  12. Resolver Format C — no `current`, only `presets`
 *  13. Resolver warns + falls back when current preset name is missing
 *  14. Resolver skips the `theme_info` section
 *  15. Resolver skips `header` / `paragraph` separators
 *  16. Resolver honors explicit null override
 *  17. Resolver applies type fallback when no default + no override
 *  18. Resolver ignores stale override keys (no schema entry)
 *  19. Resolver preserves multiple sections in one drop
 *  20. ThemeSettingsParseError is recognizable via instanceof
 */

import { describe, expect, it } from 'vitest'
import {
  parseThemeSettingsData,
  parseThemeSettingsSchema,
  resolveThemeSettings,
  ThemeSettingsParseError,
  THEME_INFO_SECTION_NAME,
  type ThemeSettingsSchema,
} from './settings.js'

describe('parseThemeSettingsSchema', () => {
  it('parses a top-level array of sections', () => {
    const src = JSON.stringify([
      { name: 'theme_info', theme_name: 'Acme' },
      {
        name: 'Colors',
        settings: [
          { type: 'color', id: 'primary', default: '#000' },
          { type: 'color', id: 'secondary', default: '#fff' },
        ],
      },
    ])
    const schema = parseThemeSettingsSchema(src)
    expect(schema).toHaveLength(2)
    expect(schema[0].name).toBe('theme_info')
    expect(schema[1].name).toBe('Colors')
    expect(schema[1].settings).toHaveLength(2)
  })

  it('throws on invalid JSON', () => {
    expect(() => parseThemeSettingsSchema('not json {')).toThrow(
      ThemeSettingsParseError,
    )
  })

  it('throws on non-array top level', () => {
    expect(() => parseThemeSettingsSchema('{"foo":1}')).toThrow(
      ThemeSettingsParseError,
    )
  })

  it('is permissive on missing settings + name', () => {
    const schema = parseThemeSettingsSchema(
      JSON.stringify([{ icon: 'wrench' }]),
    )
    expect(schema).toHaveLength(1)
    expect(schema[0].name).toBe('')
    expect(schema[0].settings).toEqual([])
  })

  it('preserves pass-through fields', () => {
    const schema = parseThemeSettingsSchema(
      JSON.stringify([
        { name: 'theme_info', theme_name: 'Acme', theme_version: '1.0.0' },
      ]),
    )
    expect(schema[0].theme_name).toBe('Acme')
    expect(schema[0].theme_version).toBe('1.0.0')
  })

  it('error has the standard ThemeSettingsParseError name', () => {
    try {
      parseThemeSettingsSchema('garbage')
    } catch (err) {
      expect(err).toBeInstanceOf(ThemeSettingsParseError)
      expect((err as Error).name).toBe('ThemeSettingsParseError')
      return
    }
    throw new Error('expected throw')
  })
})

describe('parseThemeSettingsData', () => {
  it('parses an object with current + presets', () => {
    const data = parseThemeSettingsData(
      JSON.stringify({
        current: 'Default',
        presets: { Default: { primary: '#abc' } },
      }),
    )
    expect(data.current).toBe('Default')
    expect(data.presets?.Default.primary).toBe('#abc')
  })

  it('throws on invalid JSON', () => {
    expect(() => parseThemeSettingsData('{')).toThrow(ThemeSettingsParseError)
  })

  it('throws on non-object top level', () => {
    expect(() => parseThemeSettingsData('[]')).toThrow(ThemeSettingsParseError)
    expect(() => parseThemeSettingsData('"foo"')).toThrow(
      ThemeSettingsParseError,
    )
  })
})

describe('resolveThemeSettings', () => {
  const baseSchema: ThemeSettingsSchema = [
    { name: THEME_INFO_SECTION_NAME, settings: [], theme_name: 'Acme' },
    {
      name: 'Colors',
      settings: [
        { type: 'color', id: 'primary', default: '#000' },
        { type: 'color', id: 'secondary', default: '#fff' },
        { type: 'header', content: 'Layout' },
        { type: 'paragraph', content: 'Choose a font' },
        { type: 'text', id: 'tagline', default: 'Welcome' },
      ],
    },
  ]

  it('returns schema defaults when no data is supplied', () => {
    const { settings, warnings } = resolveThemeSettings(baseSchema)
    expect(settings).toEqual({
      primary: '#000',
      secondary: '#fff',
      tagline: 'Welcome',
    })
    expect(warnings).toEqual([])
  })

  it('Format A — current is a preset name string', () => {
    const { settings, warnings } = resolveThemeSettings(baseSchema, {
      current: 'Default',
      presets: {
        Default: { primary: '#111', secondary: '#222' },
      },
    })
    expect(settings.primary).toBe('#111')
    expect(settings.secondary).toBe('#222')
    expect(settings.tagline).toBe('Welcome') // schema default
    expect(warnings).toEqual([])
  })

  it('Format B — current is an inline object', () => {
    const { settings } = resolveThemeSettings(baseSchema, {
      current: { primary: '#aaa', tagline: 'Hello' },
      presets: { Default: { primary: '#bbb' } },
    })
    // current object wins over the preset
    expect(settings.primary).toBe('#aaa')
    expect(settings.tagline).toBe('Hello')
    expect(settings.secondary).toBe('#fff') // schema default
  })

  it('Format C — no current, only presets', () => {
    const { settings, warnings } = resolveThemeSettings(baseSchema, {
      presets: { Default: { primary: '#999' } },
    })
    // no current → no overrides → schema defaults
    expect(settings.primary).toBe('#000')
    expect(warnings).toEqual([])
  })

  it('warns + falls back when current preset name is missing', () => {
    const { settings, warnings } = resolveThemeSettings(baseSchema, {
      current: 'Nonexistent',
      presets: { Default: { primary: '#xxx' } },
    })
    expect(settings.primary).toBe('#000') // fall back to schema default
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('Nonexistent')
    expect(warnings[0]).toContain('not found')
  })

  it('skips the theme_info section', () => {
    const { settings } = resolveThemeSettings(baseSchema)
    // No theme_name / theme_info fields should leak into the drop.
    expect(settings.theme_name).toBeUndefined()
  })

  it('skips header + paragraph separators', () => {
    const { settings } = resolveThemeSettings(baseSchema)
    expect('content' in settings).toBe(false)
  })

  it('honors explicit null override', () => {
    const { settings } = resolveThemeSettings(baseSchema, {
      current: { primary: null },
    })
    expect(settings.primary).toBeNull()
  })

  it('applies type fallback when no default + no override', () => {
    const schema: ThemeSettingsSchema = [
      {
        name: 'Misc',
        settings: [
          { type: 'checkbox', id: 'enabled' },
          { type: 'text', id: 'untitled' },
        ],
      },
    ]
    const { settings } = resolveThemeSettings(schema)
    // checkbox fallback is false; text fallback is empty string
    expect(settings.enabled).toBe(false)
    expect(settings.untitled).toBe('')
  })

  it('ignores stale override keys (no schema entry)', () => {
    const { settings } = resolveThemeSettings(baseSchema, {
      current: { primary: '#aaa', removed_setting: 'oops' },
    })
    expect(settings.primary).toBe('#aaa')
    expect('removed_setting' in settings).toBe(false)
  })

  it('preserves multiple sections in a single drop', () => {
    const schema: ThemeSettingsSchema = [
      {
        name: 'Section A',
        settings: [{ type: 'text', id: 'a_field', default: 'A' }],
      },
      {
        name: 'Section B',
        settings: [{ type: 'text', id: 'b_field', default: 'B' }],
      },
    ]
    const { settings } = resolveThemeSettings(schema)
    expect(settings).toEqual({ a_field: 'A', b_field: 'B' })
  })
})
