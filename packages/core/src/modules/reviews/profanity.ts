/**
 * Gbox Platform — Profanity Lexicon + Filter (Phase 10 PR3)
 *
 * Pure, stateless, zero-dep helper. Ships a small built-in list for
 * English + Vietnamese + a handful of cross-lingual blockers (slurs),
 * and lets the caller extend it per-shop via `extraTerms`.
 *
 * Scope choice: we deliberately ship a minimal list. The goal is to
 * catch the 80th-percentile drive-by spam + abuse — not every variant
 * a determined bad actor can type. Sellers who need aggressive
 * moderation layer a third-party service on top.
 *
 * Contract:
 *
 *   countProfanityHits(text, extraTerms?) → number
 *     Lowercases + word-boundary-matches each term. Returns total hits.
 *     Extra terms are matched the same way (no regex characters in them;
 *     they're escaped at compile time).
 *
 *   maskProfanity(text, extraTerms?) → string
 *     Replaces hits with the same-length repeat of '*'. Keeps the text
 *     length identical so the admin list preview doesn't shift.
 *
 *   normaliseExtraTerms(raw) → string[]
 *     Accepts a JSON blob from the DB or a form submission and returns
 *     a deduped / lower-cased / non-empty array.
 */

// -----------------------------------------------------------------------------
// Built-in lexicons
// -----------------------------------------------------------------------------

/**
 * Small English list — common insults + sexual slurs + racist slurs. Not
 * exhaustive on purpose. Each entry is a raw word; the matcher wraps it
 * in `\b...\b` at runtime so "bass" doesn't hit on "ass".
 */
const EN: readonly string[] = [
  'fuck',
  'fucking',
  'fucker',
  'shit',
  'bullshit',
  'bitch',
  'bastard',
  'asshole',
  'cunt',
  'dick',
  'pussy',
  'cock',
  'whore',
  'slut',
  'piss',
  'crap',
  'damn',
  'motherfucker',
  'retard',
  'retarded',
  'faggot',
  'nigger',
  'nigga',
  'tranny',
  'chink',
  'spic',
  'kike',
  // Common storefront-spam keywords that masquerade as reviews.
  'scam',
  'fraud',
  'thief',
]

/**
 * Vietnamese — handled without diacritics so common evasions still
 * trigger. Matcher normalises the input to remove diacritics before
 * comparing, so we can store the dia-less root here and the caller
 * catches both "đụ" and "du".
 */
const VI: readonly string[] = [
  'du', // đụ
  'dit', // địt
  'lon', // lồn
  'buoi', // buồi
  'cac', // cặc
  'cu', // cu
  'deo', // đéo
  'dm', // rút gọn "địt mẹ"
  'dmm',
  'dcm',
  'vcl',
  'vl',
  'ngu',
  'oc cho', // óc chó
  'khung', // khùng
]

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/**
 * Strip diacritics (é → e, đ → d, ơ → o, ư → u, Vietnamese circumflex /
 * breve marks, etc.). We use NFD normalisation + mark-stripping for the
 * Latin chunk, then hand-roll the d/D → đ/Đ case that NFD doesn't catch.
 */
function stripDiacritics(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
}

/** Escape any regex metachars in a user-supplied term. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Normalise extra-term input. Accepts a `string[]` or a JSON-string-of-
 * array (as stored in the DB jsonb column). Returns a deduped list of
 * lower-cased non-empty entries, capped at 200 items so a runaway
 * setting doesn't blow up the regex.
 */
export function normaliseExtraTerms(raw: unknown): string[] {
  let arr: unknown[] = []
  if (Array.isArray(raw)) arr = raw
  else if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) arr = parsed
    } catch {
      // Fall through — treat as comma-separated text.
      arr = raw.split(',')
    }
  }
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of arr) {
    if (typeof item !== 'string') continue
    const trimmed = stripDiacritics(item.trim().toLowerCase())
    if (!trimmed) continue
    if (seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
    if (out.length >= 200) break
  }
  return out
}

/**
 * Build a single alternation regex covering every term. Uses word
 * boundaries (`\b`). `extraTerms` are assumed already lower-cased +
 * de-diacritised by `normaliseExtraTerms`.
 */
function compileRegex(extraTerms: string[]): RegExp {
  const all = [...EN, ...VI, ...extraTerms].map(escapeRegex)
  return new RegExp(`\\b(?:${all.join('|')})\\b`, 'gi')
}

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

/** Count profanity hits in `text`. Returns 0 for non-string input. */
export function countProfanityHits(
  text: unknown,
  extraTerms: string[] = [],
): number {
  if (typeof text !== 'string' || text.length === 0) return 0
  const re = compileRegex(extraTerms)
  const haystack = stripDiacritics(text.toLowerCase())
  const matches = haystack.match(re)
  return matches ? matches.length : 0
}

/**
 * Replace every profanity hit with `*` of the same length. The output
 * is the same length as the input so the admin list preview layout
 * doesn't shift.
 */
export function maskProfanity(
  text: unknown,
  extraTerms: string[] = [],
): string {
  if (typeof text !== 'string' || text.length === 0) return ''
  const re = compileRegex(extraTerms)
  // We match against the de-diacritised version to find positions, then
  // cut the *original* string at those ranges. stripDiacritics is a
  // 1:1 char mapping so the indices align.
  const haystack = stripDiacritics(text.toLowerCase())
  const out = text.split('')
  re.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(haystack)) !== null) {
    const start = m.index
    const end = start + m[0].length
    for (let i = start; i < end; i++) out[i] = '*'
    if (m.index === re.lastIndex) re.lastIndex++ // guard against zero-width
  }
  return out.join('')
}

/** Convenience — true if any profanity is present. */
export function containsProfanity(
  text: unknown,
  extraTerms: string[] = [],
): boolean {
  return countProfanityHits(text, extraTerms) > 0
}

/**
 * Escape hatch for tests / migrations that need to peek at the built-in
 * lists. Returns copies so callers can't mutate.
 */
export function _builtInLists(): { en: string[]; vi: string[] } {
  return { en: [...EN], vi: [...VI] }
}
