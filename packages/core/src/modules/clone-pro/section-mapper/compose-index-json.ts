/**
 * Clone Pro v4 — homepage index.json composer.
 *
 * Input:  a homepage HTML string + source URL (for URL resolution).
 * Output: a valid Shopify `templates/index.json` — keyed by section id,
 *         with an explicit `order` array that matches the detected
 *         sections' source DOM ordering.
 *
 * Pipeline:
 *
 *   1. Load the HTML with cheerio (decodeEntities: false to keep
 *      special chars intact — same pattern used across clone-pro).
 *   2. Run all four composable-section detectors in a fixed order so
 *      their inputs are deterministic.
 *   3. Sort detected sections by `.position` (DOM order).
 *   4. Fill in schema defaults for any setting the detector didn't
 *      populate — the Shopify renderer handles missing keys gracefully,
 *      but merchant editors see the defaults as placeholder text which
 *      is more friendly than blank fields.
 *   5. Emit the JSON.
 *
 * Fallback behaviour: if NO section was detected (exotic homepage),
 * we still emit a baseline index.json with a hero + newsletter so the
 * merchant has something to start editing from. This is the same
 * content the seed ships with — a deliberate "sensible default."
 */

import * as cheerio from 'cheerio'
import { getSectionCatalog, getSectionDef } from './catalog.js'
import {
  detectFeaturedCollection,
  detectHero,
  detectImageWithText,
  detectNewsletter,
  type DetectorContext,
  type DetectorFn,
} from './detectors/index.js'
import type {
  DetectedSection,
  IndexJson,
  IndexJsonSection,
  SectionDef,
} from './types.js'

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ComposeIndexJsonInput {
  readonly homepageHtml: string
  readonly baseUrl?: string
  /** If true, fill in schema defaults for missing settings. Default: true. */
  readonly fillDefaults?: boolean
}

export interface ComposeIndexJsonResult {
  readonly indexJson: IndexJson
  readonly detected: readonly DetectedSection[]
  /** Sections we fell back to the seed defaults for (no detection match). */
  readonly fellBackToDefaults: boolean
}

export function composeIndexJson(
  input: ComposeIndexJsonInput,
): ComposeIndexJsonResult {
  const $ = cheerio.load(input.homepageHtml, { decodeEntities: false } as any)

  const ctx: DetectorContext = { $, baseUrl: input.baseUrl }

  const detectors: readonly DetectorFn[] = [
    detectHero,
    detectFeaturedCollection,
    detectImageWithText,
    detectNewsletter,
  ]

  const detected: DetectedSection[] = []
  for (const fn of detectors) {
    const hit = fn(ctx)
    if (hit) detected.push(hit)
  }

  if (detected.length === 0) {
    // Exotic homepage — fall back to the seed defaults.
    return {
      indexJson: buildFallbackIndexJson(),
      detected: [],
      fellBackToDefaults: true,
    }
  }

  // Preserve DOM order.
  const ordered = [...detected].sort((a, b) => a.position - b.position)

  const fillDefaults = input.fillDefaults !== false
  const sections: Record<string, IndexJsonSection> = {}
  const order: string[] = []

  for (const det of ordered) {
    const def = getSectionDef(det.id)
    const merged = fillDefaults
      ? mergeWithDefaults(def, det.settings)
      : det.settings
    sections[det.id] = { type: det.id, settings: merged }
    order.push(det.id)
  }

  return {
    indexJson: { sections, order },
    detected: ordered,
    fellBackToDefaults: false,
  }
}

// ---------------------------------------------------------------------------
// Default-fill helpers
// ---------------------------------------------------------------------------

function mergeWithDefaults(
  def: SectionDef,
  detected: Readonly<Record<string, string | number | boolean>>,
): Readonly<Record<string, string | number | boolean>> {
  const out: Record<string, string | number | boolean> = {}
  for (const setting of def.schema.settings) {
    if (setting.id in detected) {
      out[setting.id] = detected[setting.id]
    } else if (setting.default !== undefined) {
      out[setting.id] = setting.default
    }
  }
  // Pass through any detected settings we don't know about (e.g. a
  // detector produced an extra field). Shopify ignores unknown keys,
  // but we keep them for observability.
  for (const key of Object.keys(detected)) {
    if (!(key in out)) out[key] = detected[key]
  }
  return out
}

// ---------------------------------------------------------------------------
// Fallback
// ---------------------------------------------------------------------------

/**
 * Build a baseline index.json using just schema defaults for hero +
 * featured-collection + image-with-text + newsletter. Used when no
 * detector fires — gives merchants a non-empty homepage to edit.
 */
function buildFallbackIndexJson(): IndexJson {
  const catalog = getSectionCatalog()
  const sections: Record<string, IndexJsonSection> = {}
  const order: string[] = []
  for (const id of ['hero', 'featured-collection', 'image-with-text', 'newsletter'] as const) {
    const def = catalog[id]
    const settings: Record<string, string | number | boolean> = {}
    for (const s of def.schema.settings) {
      if (s.default !== undefined) settings[s.id] = s.default
    }
    sections[id] = { type: id, settings }
    order.push(id)
  }
  return { sections, order }
}
