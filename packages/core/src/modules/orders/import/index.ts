/**
 * Orders Import — Orchestrator
 *
 * Detects the platform from CSV headers and routes to the right parser.
 * Falls back to generic CSV with auto-detected column mapping.
 */

import type { ParseResult, ImportPlatformParser } from './types.js'
export type { NormalizedOrder, NormalizedLineItem, NormalizedAddress, ParseResult, ParseError, ColumnMapping, ValidationResult } from './types.js'
export { validateOrders, MAPPABLE_FIELDS } from './types.js'
export { parseCsvText, autoDetectMapping, applyMapping } from './csv-parser.js'

import { shopifyParser } from './shopify-parser.js'
import { amazonParser } from './amazon-parser.js'
import { tiktokParser } from './tiktok-parser.js'
import { etsyParser } from './etsy-parser.js'
import { ebayParser } from './ebay-parser.js'
import { parseCsvText, autoDetectMapping, applyMapping } from './csv-parser.js'

// Registry of all platform parsers
const PLATFORM_PARSERS: ImportPlatformParser[] = [
  shopifyParser,
  amazonParser,
  tiktokParser,
  etsyParser,
  ebayParser,
]

export { PLATFORM_PARSERS }

/**
 * Detect which platform the CSV comes from by analyzing headers.
 * Returns the parser or null if no match (use generic CSV).
 */
export function detectPlatform(headers: string[]): ImportPlatformParser | null {
  for (const parser of PLATFORM_PARSERS) {
    if (parser.detect(headers)) return parser
  }
  return null
}

/**
 * Full import pipeline: parse CSV text → detect platform → normalize orders.
 *
 * @param csvText - Raw CSV/TSV text content
 * @param forcePlatform - Override auto-detection with a specific platform
 * @returns ParseResult with normalized orders and errors
 */
export function importFromCsv(
  csvText: string,
  forcePlatform?: string,
): ParseResult {
  const { headers, rows } = parseCsvText(csvText)

  if (headers.length === 0 || rows.length === 0) {
    return { orders: [], errors: [{ row: 0, message: 'File is empty or has no data rows' }], totalRows: 0, platform: 'csv' }
  }

  // Find parser
  let parser: ImportPlatformParser | null = null
  if (forcePlatform) {
    parser = PLATFORM_PARSERS.find(p => p.platform === forcePlatform) || null
  } else {
    parser = detectPlatform(headers)
  }

  if (parser) {
    return parser.parse(headers, rows)
  }

  // Fallback: generic CSV with auto-detected mapping
  const mapping = autoDetectMapping(headers)
  return applyMapping(headers, rows, mapping, 'csv')
}
