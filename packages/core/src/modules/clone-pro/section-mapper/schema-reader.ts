/**
 * Clone Pro v4 — Section Schema Reader
 *
 * Parses the `{% schema %} ... {% endschema %}` JSON block out of a Gbox
 * Dawn section's Liquid source. The parsed schema is consumed by the
 * catalog so detectors know which settings they're allowed to populate.
 *
 * Why a custom parser and not a Liquid lib? We only need the schema
 * block — which is always plain JSON bracketed by a known pair of tags.
 * Pulling in a full Liquid parser for this would be silly.
 *
 * What about `t:sections.foo.name` i18n keys? They're left as-is; the
 * catalog only consumes structural fields (`type`, `id`, `default`,
 * `min`/`max`), never the human labels. Keeping the strings raw means
 * locale changes don't require regenerating the catalog.
 */

import type { SectionSchema, SectionSetting, SettingType } from './types.js'

// Known Shopify setting types we explicitly accept. Anything else becomes
// 'text' — the safest fallback so detectors don't choke on exotic types
// like `color_background` in a future Dawn upgrade.
const KNOWN_SETTING_TYPES = new Set<SettingType>([
  'text',
  'textarea',
  'number',
  'range',
  'checkbox',
  'url',
  'color',
  'image_picker',
  'collection',
  'product',
  'page',
  'blog',
  'select',
  'radio',
  'font_picker',
  'richtext',
  'html',
  'link_list',
])

const SCHEMA_OPEN_RE = /\{%\s*schema\s*%\}/i
const SCHEMA_CLOSE_RE = /\{%\s*endschema\s*%\}/i

/**
 * Extract the schema object from a section's Liquid source.
 *
 * Throws if the schema block is missing or the JSON between the tags is
 * malformed — both are programmer errors during catalog generation, not
 * user-facing conditions. A missing schema means the caller passed a
 * non-section file (or we shipped a broken section); crashing loud keeps
 * the error visible in CI.
 */
export function parseSectionSchema(liquidSource: string): SectionSchema {
  const openMatch = liquidSource.match(SCHEMA_OPEN_RE)
  if (!openMatch || openMatch.index == null) {
    throw new Error('[section-mapper] Missing {% schema %} opening tag')
  }
  const closeMatch = liquidSource.slice(openMatch.index).match(SCHEMA_CLOSE_RE)
  if (!closeMatch || closeMatch.index == null) {
    throw new Error('[section-mapper] Missing {% endschema %} closing tag')
  }
  const jsonStart = openMatch.index + openMatch[0].length
  const jsonEnd = openMatch.index + closeMatch.index
  const jsonText = liquidSource.slice(jsonStart, jsonEnd).trim()

  let raw: unknown
  try {
    raw = JSON.parse(jsonText)
  } catch (err) {
    throw new Error(
      `[section-mapper] schema JSON is not valid JSON: ${(err as Error).message}`,
    )
  }

  return normalizeSchema(raw)
}

// ---------------------------------------------------------------------------
// Normalisation — validate shape + coerce defaults into TS types
// ---------------------------------------------------------------------------

function normalizeSchema(raw: unknown): SectionSchema {
  if (!raw || typeof raw !== 'object') {
    throw new Error('[section-mapper] schema must be a JSON object')
  }
  const obj = raw as Record<string, unknown>

  const name = typeof obj.name === 'string' ? obj.name : 'Unnamed Section'
  const settingsRaw = Array.isArray(obj.settings) ? obj.settings : []
  const settings: SectionSetting[] = []
  for (const s of settingsRaw) {
    if (!s || typeof s !== 'object') continue
    const normalized = normalizeSetting(s as Record<string, unknown>)
    if (normalized) settings.push(normalized)
  }

  const presetsRaw = Array.isArray(obj.presets) ? obj.presets : []
  const presets: { name: string; category?: string }[] = []
  for (const p of presetsRaw) {
    if (!p || typeof p !== 'object') continue
    const po = p as Record<string, unknown>
    if (typeof po.name !== 'string') continue
    presets.push({
      name: po.name,
      category: typeof po.category === 'string' ? po.category : undefined,
    })
  }

  return {
    name,
    settings,
    presets: presets.length > 0 ? presets : undefined,
  }
}

function normalizeSetting(raw: Record<string, unknown>): SectionSetting | null {
  const id = typeof raw.id === 'string' ? raw.id : null
  if (!id) return null // a setting without an id is unusable

  const rawType = typeof raw.type === 'string' ? raw.type : 'text'
  const type: SettingType = (KNOWN_SETTING_TYPES.has(rawType as SettingType)
    ? (rawType as SettingType)
    : 'text')

  const out: SectionSetting = {
    id,
    type,
    label: typeof raw.label === 'string' ? raw.label : undefined,
    default: coerceDefault(raw.default, type),
    min: typeof raw.min === 'number' ? raw.min : undefined,
    max: typeof raw.max === 'number' ? raw.max : undefined,
    step: typeof raw.step === 'number' ? raw.step : undefined,
  }
  return out
}

function coerceDefault(
  value: unknown,
  type: SettingType,
): string | number | boolean | undefined {
  if (value == null) return undefined
  switch (type) {
    case 'number':
    case 'range':
      if (typeof value === 'number') return value
      if (typeof value === 'string' && value.trim() !== '') {
        const n = Number(value)
        return Number.isFinite(n) ? n : undefined
      }
      return undefined
    case 'checkbox':
      if (typeof value === 'boolean') return value
      if (typeof value === 'string') return value === 'true'
      return undefined
    default:
      if (typeof value === 'string') return value
      if (typeof value === 'number' || typeof value === 'boolean') return String(value)
      return undefined
  }
}
