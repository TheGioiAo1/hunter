/**
 * Gbox Platform — loadThemeSettings tests
 *
 * Decision #1 Step 1.15b. Covers the convenience loader that wires
 * a TemplateLoader to the parser + resolver. Specifically the
 * matrix from the file header:
 *
 *   schema | data    | result
 *   -------|---------|------------------------------
 *   missing| any     | empty drop, warning
 *   present| missing | schema defaults, no warning
 *   present| broken  | schema defaults, warning
 *   present| present | resolved drop, possibly warnings
 *
 * Plus: a broken schema re-throws ThemeSettingsParseError.
 */

import { describe, expect, it } from 'vitest'
import type { LoadResult, LogicalPath, TemplateLoader } from '../loader.js'
import {
  loadThemeSettings,
  SETTINGS_DATA_PATH,
  SETTINGS_SCHEMA_PATH,
} from './settings-loader.js'
import { ThemeSettingsParseError } from './settings.js'

class MapLoader implements TemplateLoader {
  readonly name = 'map-loader'
  constructor(private readonly files: Record<string, string>) {}
  async load(p: LogicalPath): Promise<string | null> {
    return this.files[p] ?? null
  }
  async loadWithMeta(p: LogicalPath): Promise<LoadResult | null> {
    const src = this.files[p]
    return src === undefined ? null : { source: src }
  }
  async exists(p: LogicalPath): Promise<boolean> {
    return p in this.files
  }
  async list(prefix = ''): Promise<LogicalPath[]> {
    return Object.keys(this.files).filter((k) => k.startsWith(prefix))
  }
}

const SAMPLE_SCHEMA = JSON.stringify([
  { name: 'theme_info', theme_name: 'Test' },
  {
    name: 'Colors',
    settings: [
      { type: 'color', id: 'primary', default: '#abc' },
      { type: 'text', id: 'tagline', default: 'Hello' },
    ],
  },
])

describe('loadThemeSettings', () => {
  it('schema missing → empty drop with warning', async () => {
    const loader = new MapLoader({})
    const result = await loadThemeSettings(loader)
    expect(result.settings).toEqual({})
    expect(result.schema).toBeNull()
    expect(result.data).toBeNull()
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain(SETTINGS_SCHEMA_PATH)
  })

  it('schema present, data missing → schema defaults, no warning', async () => {
    const loader = new MapLoader({
      [SETTINGS_SCHEMA_PATH]: SAMPLE_SCHEMA,
    })
    const result = await loadThemeSettings(loader)
    expect(result.settings).toEqual({ primary: '#abc', tagline: 'Hello' })
    expect(result.schema).not.toBeNull()
    expect(result.data).toBeNull()
    expect(result.warnings).toEqual([])
  })

  it('schema present, data broken → schema defaults with warning', async () => {
    const loader = new MapLoader({
      [SETTINGS_SCHEMA_PATH]: SAMPLE_SCHEMA,
      [SETTINGS_DATA_PATH]: '{ broken json',
    })
    const result = await loadThemeSettings(loader)
    expect(result.settings).toEqual({ primary: '#abc', tagline: 'Hello' })
    expect(result.data).toBeNull()
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain(SETTINGS_DATA_PATH)
    expect(result.warnings[0]).toContain('falling back')
  })

  it('schema present, data present → resolved drop', async () => {
    const loader = new MapLoader({
      [SETTINGS_SCHEMA_PATH]: SAMPLE_SCHEMA,
      [SETTINGS_DATA_PATH]: JSON.stringify({
        current: { primary: '#000', tagline: 'Welcome' },
      }),
    })
    const result = await loadThemeSettings(loader)
    expect(result.settings).toEqual({ primary: '#000', tagline: 'Welcome' })
    expect(result.data).not.toBeNull()
    expect(result.warnings).toEqual([])
  })

  it('throws when schema is malformed (hard error)', async () => {
    const loader = new MapLoader({
      [SETTINGS_SCHEMA_PATH]: '{ not even json',
    })
    await expect(loadThemeSettings(loader)).rejects.toBeInstanceOf(
      ThemeSettingsParseError,
    )
  })

  it('forwards resolver warnings into the result', async () => {
    const loader = new MapLoader({
      [SETTINGS_SCHEMA_PATH]: SAMPLE_SCHEMA,
      [SETTINGS_DATA_PATH]: JSON.stringify({
        current: 'NoSuchPreset',
        presets: {},
      }),
    })
    const result = await loadThemeSettings(loader)
    // Falls back to schema defaults.
    expect(result.settings).toEqual({ primary: '#abc', tagline: 'Hello' })
    // Warning forwarded from resolveThemeSettings.
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain('NoSuchPreset')
  })
})
