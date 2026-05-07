/**
 * Design Library — DESIGN.md parser (Phase D1).
 *
 * Pulls the brand `title` and optional `summary` out of the upstream
 * DESIGN.md payload. Kept OUT of the sync-seed CLI so both the CLI
 * and the D2 clone-extractor path can share the same heuristic — a
 * seed sync and a fresh clone produce the same-shaped card.
 *
 * Heuristic (matches the upstream awesome-design-md format):
 *
 *   1. Title = text of the first H1 line (`# …`).
 *      - Strip leading "Design System Inspiration of " prefix
 *        (upstream awesome-design-md template wraps every title).
 *      - Strip trailing "— Design System" / "— Design Guide" suffix
 *        (contributor-authored files use this shape instead).
 *      - Fall back to a prettified slug if no H1 is found.
 *   2. Summary = first plain paragraph AFTER the H1.
 *      - If the H1 is followed immediately by a section heading
 *        (`## 1. Visual Theme & Atmosphere`), fall THROUGH that
 *        heading and use that section's first paragraph instead.
 *        That's the shape upstream actually ships — H1 + H2 with
 *        no lead paragraph between them.
 *      - Skip blank lines and metadata lines (images, blockquotes,
 *        hrules, tables, list items).
 *      - Cap at 280 chars; append "…" if truncated.
 */

/**
 * Extract a short title + lead paragraph summary from a DESIGN.md
 * body. Returns `title = slug` (prettified) when no H1 exists so the
 * gallery card always has something to render.
 */
export function extractTitleAndSummary(
  md: string,
  slug: string,
): { title: string; summary: string | null } {
  // Strip BOM if present, normalise line endings.
  const text = md.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')

  const h1Match = /^#\s+(.+?)\s*$/m.exec(text)
  // Prettify the slug fallback here (not lazily at the return) so the
  // trimmers can operate on the raw H1 text alone and we don't skip
  // prettification when there IS no H1 but the (lowercase) slug still
  // reads as a valid title.
  const rawTitle = h1Match ? h1Match[1] : prettifySlug(slug)

  // Strip upstream's "Design System Inspiration of <Brand>" prefix
  // (present on every awesome-design-md title at 80bbbc2), then also
  // strip the older "— Design System" / "— Design Guide" suffix that
  // early contributors used. We keep both so the heuristic survives a
  // mirror refresh even if the template changes again.
  const title = rawTitle
    .replace(/^design system inspiration (?:of|for)\s+/i, '')
    .replace(/\s+[—–-]\s+design system\s*$/i, '')
    .replace(/\s+[—–-]\s+design guide\s*$/i, '')
    .trim()

  // Pull the first non-empty paragraph. Scan the WHOLE body after the
  // H1 — `#` headings are skipped (not stopped) so an H1+H2 pair with
  // no lead paragraph still gets a summary from the first section's
  // body. A blank line ends the summary once text has been captured.
  //
  // Metadata lines (images, blockquotes, hrules, tables, list items)
  // are SOFT skips — we keep looking for the first real paragraph,
  // but once we've captured text a metadata line ends the summary.
  let summary: string | null = null
  if (h1Match) {
    const afterH1 = text.slice(h1Match.index + h1Match[0].length)
    const lines = afterH1.split('\n')
    const buf: string[] = []
    for (const raw of lines) {
      const line = raw.trim()
      if (!line) {
        if (buf.length > 0) break
        continue
      }
      if (line.startsWith('#')) {
        // Heading (any level) — skip and keep scanning the body.
        // Upstream ships H1 → H2 with no lead paragraph between them,
        // so the H2's first paragraph is what reads as the summary.
        if (buf.length > 0) break
        continue
      }
      if (
        line.startsWith('![') ||
        line.startsWith('> ') ||
        line.startsWith('---') ||
        line.startsWith('|') ||
        line.startsWith('- ') ||
        line.startsWith('* ')
      ) {
        if (buf.length > 0) break
        continue
      }
      // Strip bold wrappers like `**Key Characteristics:**` that
      // sometimes precede the real paragraph.
      if (/^\*\*.*\*\*:?\s*$/.test(line)) {
        if (buf.length > 0) break
        continue
      }
      buf.push(line)
      // Cap at ~240 chars of input so the final summary stays
      // readable. The 280-char ellipsis cap below handles final trim.
      if (buf.join(' ').length > 240) break
    }
    const joined = buf.join(' ').trim()
    if (joined) {
      // Strip inline markdown (backtick code, link text) lightly so
      // the card shows "#ffffff" not "`#ffffff`" and "Rausch Red" not
      // "[Rausch Red](…)".
      const clean = stripInlineMd(joined)
      summary = clean.length > 280 ? clean.slice(0, 277) + '…' : clean
    }
  }

  return { title: title || prettifySlug(slug), summary }
}

/**
 * Convert a slug like 'mistral.ai' to a display-friendly 'Mistral.ai'.
 * Only capitalises the first letter — TLD-like suffixes (`.ai`, `.app`)
 * stay lowercase so brand names render the way their owners write them.
 */
export function prettifySlug(slug: string): string {
  if (!slug) return slug
  return slug.charAt(0).toUpperCase() + slug.slice(1)
}

/**
 * Collapse inline markdown in a summary paragraph so the card surface
 * reads as prose, not a mini code listing. Keeps the text substance
 * identical — only backticks, link-text brackets, and bold/italic
 * wrappers are stripped.
 */
function stripInlineMd(s: string): string {
  return s
    // Code: `foo` → foo
    .replace(/`([^`]+)`/g, '$1')
    // Markdown links: [text](url) → text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    // Bold / italic wrappers at token boundaries.
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|\s)\*([^*]+)\*/g, '$1$2')
    .replace(/(^|\s)_([^_]+)_/g, '$1$2')
    .trim()
}
