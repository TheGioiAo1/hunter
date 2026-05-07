/**
 * Design Library — DESIGN.md serializer for clone-pro output (Phase D2).
 *
 * Converts an `ExtractedDesign` (produced by
 * `packages/core/src/modules/clone-pro/design-extractor.ts`) into a
 * DESIGN.md-shaped markdown string suitable for insertion into
 * `design_library_entries` as `source='clone'`.
 *
 * Why a markdown artifact?
 * -----------------------
 * Phase D1 landed the gallery UI backed by DESIGN.md payloads from
 * the upstream awesome-design-md mirror. For D4 to render seed cards
 * and "My Clones" cards with the SAME shape, clone rows must carry a
 * compatible markdown body:
 *
 *   - The D1 parser in `parse-design-md.ts` must be able to pull a
 *     title + lead-paragraph summary out of the clone body.
 *   - The eventual preview renderer (D3) can quote sections of the
 *     markdown verbatim without needing two code paths.
 *
 * Shape (mirrors the upstream template at 80bbbc2):
 *
 *   # <Brand / Hostname>
 *
 *   A **<style>** design cloned from <host> with an <N>-color
 *   palette anchored by `<primary>`. <sentence about sections>.
 *
 *   ## 1. Visual Theme
 *   …
 *
 *   ## 2. Colors
 *   - Primary: `#…`
 *   …
 *
 *   ## 3. Typography
 *   - Body: <family>, <weight>, <size>/<line-height>
 *   …
 *
 *   ## 4. Layout
 *   - Max width: <px>
 *   …
 *
 *   ## 5. Sections Detected
 *   1. Hero
 *   2. Feature grid
 *   …
 *
 *   ---
 *   <footer line with timestamp + clone-pro attribution>
 *
 * The serializer is intentionally deterministic (no AI, no network)
 * so a round-trip `serialize → parse` is repeatable in tests and the
 * gallery card is identical between the `ExtractedDesign` at clone
 * time and any later rehydration path.
 *
 * Narrative prose (the free-form "Clay's website is a warm, playful
 * celebration of color…") is NOT produced here — that belongs to D5
 * where an AI pass enriches the body using the real source HTML.
 */

import type { ExtractedDesign } from '../clone-pro/types.js'
import { extractTitleAndSummary } from './parse-design-md.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SerializeCloneDesignInput {
  /** Extracted design tokens from the clone-pro pipeline. */
  readonly design: ExtractedDesign
  /** Original source URL the clone was pulled from. */
  readonly sourceUrl: string
  /**
   * Timestamp the clone completed. Defaults to `new Date()` — injected
   * in tests so golden snapshots stay stable.
   */
  readonly clonedAt?: Date
  /**
   * Optional override for the title when the hostname reads badly
   * (e.g. a cloudfront URL). Pipeline hook usually omits.
   */
  readonly displayTitle?: string
}

export interface SerializeCloneDesignResult {
  /** The full DESIGN.md body, ready to persist as `design_md`. */
  readonly designMd: string
  /** The H1 value (already stripped of upstream prefixes). */
  readonly title: string
  /** Best-effort 1-sentence summary for gallery cards. */
  readonly summary: string
}

// ---------------------------------------------------------------------------
// Serializer
// ---------------------------------------------------------------------------

/**
 * Build a DESIGN.md body + parsed title/summary from an ExtractedDesign.
 *
 * The returned `title` and `summary` are what the D1 parser would
 * extract from `designMd`, computed eagerly so the caller doesn't
 * have to re-parse its own output to populate the `title` / `summary`
 * columns on `design_library_entries`.
 */
export function serializeCloneDesign(
  input: SerializeCloneDesignInput,
): SerializeCloneDesignResult {
  const { design, sourceUrl } = input
  const clonedAt = input.clonedAt ?? new Date()
  const host = safeHostname(sourceUrl)
  // `|| 'Clone'` is a last-resort fallback — the clone-pro pipeline
  // validates URLs at submit time so host should always be populated,
  // but we don't want an empty `# ` heading to slip into the DB if a
  // future caller bypasses that validation.
  const title = ((input.displayTitle ?? prettyHost(host)).trim()) || 'Clone'

  const palette = design.palette
  const paletteEntries = nonEmptyColorEntries(palette)
  const primary = palette.primary || '#000000'
  const sectionCount = design.sections.length
  const style = design.style

  // Lead paragraph with emphasis markdown — this is what the D1 parser
  // pulls as the summary when reading this body back out of the DB.
  // The returned `summary` field is the parser's stripped version so
  // `result.summary` is suitable for dropping straight into the
  // `design_library_entries.summary` column.
  //
  // Keep it under 240 chars so the 280-char ellipsis in the parser
  // never trips on this auto-generated shape.
  const leadParagraph = [
    `A **${style}** design cloned from ${host}`,
    ` with a ${paletteEntries.length}-color palette anchored by \`${primary}\``,
    '.',
    sectionCount > 0
      ? ` ${sectionCount} section${sectionCount === 1 ? '' : 's'} detected.`
      : '',
  ]
    .join('')
    .trim()

  const lines: string[] = []
  lines.push(`# ${title}`, '')
  lines.push(leadParagraph, '')

  // ── 1. Visual Theme ─────────────────────────────────────────────
  lines.push('## 1. Visual Theme', '')
  lines.push(
    `Classification: **${style}**. Source: \`${sourceUrl}\`.`,
    '',
  )
  const layoutFlagLines: string[] = []
  if (design.layout.hasHero) {
    layoutFlagLines.push('- Hero section present above the fold')
  }
  if (design.layout.hasStickyHeader) {
    layoutFlagLines.push('- Sticky header pattern')
  }
  if (design.layout.hasAnnouncement) {
    layoutFlagLines.push('- Announcement bar at the top')
  }
  if (design.layout.hasMegaMenu) {
    layoutFlagLines.push('- Mega-menu navigation')
  }
  if (layoutFlagLines.length === 0) {
    // Defensive — if the layout flags are all false, still leave a line
    // so section 1 always has at least one bullet in the body.
    layoutFlagLines.push('- (No layout flags detected)')
  }
  lines.push(...layoutFlagLines)
  lines.push('')

  // ── 2. Colors ───────────────────────────────────────────────────
  lines.push('## 2. Colors', '')
  if (paletteEntries.length === 0) {
    lines.push('- (No colors detected)')
  } else {
    for (const [label, hex] of paletteEntries) {
      lines.push(`- ${label}: \`${hex}\``)
    }
  }
  lines.push('')

  // ── 3. Typography ───────────────────────────────────────────────
  lines.push('## 3. Typography', '')
  const t = design.typography
  lines.push(
    `- Body: \`${t.bodyFamily}\`, weight ${t.bodyWeight}, ${t.baseSize}/${t.lineHeight}`,
  )
  lines.push(
    `- Heading: \`${t.headingFamily}\`, weight ${t.headingWeight}`,
  )
  if (t.googleFontsUrls.length > 0) {
    lines.push(`- Google Fonts URLs: ${t.googleFontsUrls.length}`)
  }
  lines.push('')

  // ── 4. Layout ───────────────────────────────────────────────────
  lines.push('## 4. Layout', '')
  const l = design.layout
  lines.push(`- Max content width: \`${l.maxWidth}\``)
  lines.push(`- Container padding: \`${l.containerPadding}\``)
  lines.push(`- Section gap: \`${l.sectionGap}\``)
  lines.push(`- Grid columns: ${l.gridColumns}`)
  lines.push(`- Footer columns: ${l.footerColumns}`)
  lines.push('')

  // ── 5. Sections Detected ────────────────────────────────────────
  lines.push('## 5. Sections Detected', '')
  if (sectionCount === 0) {
    lines.push('_None detected — rule-based parser + AI fallback both returned empty._')
  } else {
    design.sections.forEach((s, i) => {
      const extras: string[] = []
      if (s.estimatedHeight && s.estimatedHeight !== 'auto') {
        extras.push(`h≈${s.estimatedHeight}`)
      }
      if (s.aiDescription) extras.push(s.aiDescription)
      const tail = extras.length > 0 ? ` — ${extras.join('; ')}` : ''
      lines.push(`${i + 1}. ${s.type}${tail}`)
    })
  }
  lines.push('')

  // ── Footer attribution ──────────────────────────────────────────
  lines.push('---')
  lines.push(
    `_Generated by gbox-platform clone-pro on ${toIsoDay(clonedAt)} from \`${sourceUrl}\`._`,
  )

  const designMd = lines.join('\n') + '\n'

  // Round-trip the body through the D1 parser so the returned title +
  // summary are EXACTLY what the gallery card will render after this
  // row is read back out of the DB. Also de-duplicates the inline-md
  // stripping (backticks, bold wrappers) — the parser already does it.
  const parsed = extractTitleAndSummary(designMd, host || 'clone')

  return {
    designMd,
    title: parsed.title || title,
    // Parser should always find the lead paragraph we wrote above; the
    // `?? leadParagraph` fallback only triggers if a future parser edit
    // breaks that invariant, in which case we want a usable summary in
    // the row rather than a null that'd force the card to render "".
    summary: parsed.summary ?? leadParagraph,
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse the hostname out of a sourceUrl in a way that doesn't throw
 * if the input is malformed. The pipeline already validates URLs at
 * job-submit time so this is just a belt-and-braces fallback.
 */
function safeHostname(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname.replace(/^www\./i, '') || rawUrl
  } catch {
    // Strip protocol + path manually if URL() rejects.
    return rawUrl
      .replace(/^[a-z]+:\/\//i, '')
      .replace(/[/?#].*$/, '')
      .replace(/^www\./i, '')
      .toLowerCase()
  }
}

/**
 * Render a hostname as a display title. `airbnb.com` → `Airbnb.com`.
 * Keep the TLD lowercase so branding ("Mistral.ai") stays natural.
 */
function prettyHost(host: string): string {
  if (!host) return host
  return host.charAt(0).toUpperCase() + host.slice(1)
}

/**
 * Filter + label palette entries. The ExtractedDesign shape is wide
 * (11 possible colors) but most real sites surface only 4-6. Skip
 * empty slots so the DESIGN.md doesn't list `Warning: ``` blanks.
 */
function nonEmptyColorEntries(
  palette: ExtractedDesign['palette'],
): Array<[string, string]> {
  const order: Array<[keyof ExtractedDesign['palette'], string]> = [
    ['primary', 'Primary'],
    ['secondary', 'Secondary'],
    ['accent', 'Accent'],
    ['background', 'Background'],
    ['surface', 'Surface'],
    ['text', 'Text'],
    ['textMuted', 'Text muted'],
    ['border', 'Border'],
    ['success', 'Success'],
    ['warning', 'Warning'],
    ['error', 'Error'],
  ]
  const out: Array<[string, string]> = []
  for (const [key, label] of order) {
    const value = palette[key]
    if (typeof value === 'string' && value.trim()) {
      out.push([label, value.trim()])
    }
  }
  return out
}

/** ISO-8601 day (UTC). Used for the attribution footer — stable in tests. */
function toIsoDay(d: Date): string {
  return d.toISOString().slice(0, 10)
}
