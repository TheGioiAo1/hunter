/**
 * Gbox Platform — Iron Rule 5 Lint (Phase 12.5 follow-up)
 *
 * CLAUDE.md Iron Rule 5 says sellers must NEVER see "god admin" mentions
 * or `/god-admin/*` paths — not in UI copy, errors, toasts, email
 * templates, redirect URLs, or any string their browser can observe. The
 * two P3 hits the Phase 12.5 audit turned up (gbox-legacy client error
 * message + error-page.ts default hrefs) were both "landmine" cases:
 * they would only leak the day a future refactor forgot to sanitise.
 *
 * This helper turns "don't forget to sanitise" into a CI gate. It scans
 * the set of seller-facing files a caller passes in and flags every
 * string literal that contains one of three signal patterns:
 *
 *   - kind: "path"   — string literal contains `/god-admin` (with or
 *                      without trailing path). The textbook case:
 *                      error messages or redirect targets that point
 *                      at the admin surface.
 *
 *   - kind: "phrase" — string literal contains the words "god admin"
 *                      (any case, hyphen or underscore or space
 *                      between them). UI copy like "Go to God Admin"
 *                      or Vietnamese "God Admin chưa cấu hình".
 *
 *   - kind: "email"  — string literal contains the seeded god-admin
 *                      emails (`buithai3107@gmail.com`,
 *                      `thaibq@gbox.co`). Hardcoding these in seller
 *                      surfaces would leak the platform owner's
 *                      identity; routing them through a placeholder
 *                      ("contact Gbox support") is the right shape.
 *
 * The helper deliberately scans ONLY string literals — single-, double-,
 * or backtick-quoted — AFTER stripping block comments (`/* ... *\/`,
 * JSDoc) and line comments (`//...`). Comments aren't shipped to the
 * seller's browser and every second comment under `packages/core`
 * legitimately documents the rule itself. A strict "any occurrence
 * anywhere" scan would produce thousands of false positives and get
 * disabled by the first frustrated engineer, which is the opposite of
 * what we want.
 *
 * Two further escape hatches for the rare true-negative strings that
 * look like leaks but aren't (god-admin's own TOTP issuer, the PM2
 * process name for the god-admin logger, the god-admin level label):
 *
 *   - Any source line containing the directive `iron-rule-5-ok`
 *     (typically in a trailing `// iron-rule-5-ok: <reason>` comment)
 *     is skipped entirely. Self-documenting + co-located with the
 *     exception.
 *
 *   - Test files (`*.test.ts`, `*.spec.ts`, plus the `.js/.jsx/.tsx`
 *     variants) are excluded from the scan altogether. Tests need to
 *     reference the forbidden strings to ASSERT that they don't leak,
 *     so a Rule-5 lint that flags the Rule-5 tests is a Rule-5 own-goal.
 *
 * The helper is pure — caller injects the file list, helper returns a
 * structured report. Mirrors `migration-ledger.ts` / `smoke-probes.ts`
 * so it can be unit-tested without touching disk and re-used by
 * `scripts/ops/release-check.ts` without duplicating the scan logic.
 *
 * Caller responsibility — pick the file set. The release-check wrapper
 * passes seller-facing roots (`apps/store-admin`, `apps/storefront`,
 * `apps/checkout`, `apps/accounts`, `apps/supporter`) plus
 * `packages/core/src/modules`. It deliberately does NOT pass
 * `apps/god-admin` — that IS the god-admin surface, it's allowed to
 * say "God Admin" in its own login page headline.
 */

export interface FileInput {
  /** Repo-relative path, used in report output. */
  readonly path: string
  /** Full text of the file. */
  readonly content: string
}

export interface Rule5Inputs {
  /** Files to scan. Caller decides what's in scope. */
  readonly files: readonly FileInput[]

  /**
   * Files whose path (relative, as supplied) contains any of these
   * substrings are scanned but their hits are NOT reported. Used for
   * two things:
   *
   *   - the lint helper's own source + its test fixtures (this file,
   *     iron-rule-5-lint.test.ts) — obviously contains the forbidden
   *     strings as test data.
   *
   *   - files that explicitly document Iron Rule 5 in user-visible
   *     comments AND have been manually audited (rare).
   *
   * Defaults to `DEFAULT_SELF_EXCLUSIONS` — just the two lint files.
   */
  readonly selfExclusionSubstrings?: readonly string[]
}

export interface Rule5Hit {
  readonly file: string
  /** 1-indexed line number. */
  readonly line: number
  readonly kind: 'path' | 'phrase' | 'email'
  /** Trimmed preview (max 120 chars) of the offending line. */
  readonly snippet: string
}

export interface Rule5Report {
  readonly filesScanned: number
  readonly filesExcluded: number
  readonly hits: readonly Rule5Hit[]
  readonly isClean: boolean
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/**
 * Files whose names contain one of these substrings are scanned but
 * their hits suppressed. Keeps the lint helper from flagging itself.
 */
export const DEFAULT_SELF_EXCLUSIONS: readonly string[] = [
  'iron-rule-5-lint.ts',
  'iron-rule-5-lint.test.ts',
]

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

/**
 * Path leak pattern — case-insensitive `/god-admin` anywhere in a
 * string literal. `\b` on the right so we don't flag words like
 * `/god-admin-something-else-entirely` any less (still a hit, as it
 * should be), but the boundary on the left means leading slash is
 * required — a bare mention of `god-admin` without slash is caught by
 * the phrase pattern instead.
 */
const PATH_PATTERN = /\/god-admin(?:\/[A-Za-z0-9_\-\/.]*)?/i

/**
 * Phrase pattern — the words "god" and "admin" in that order, separated
 * by at most one space / hyphen / underscore. Case-insensitive. This
 * catches "God Admin", "god-admin", "God_Admin", "godadmin", etc.
 */
const PHRASE_PATTERN = /\bgod[\s_-]?admin\b/i

/**
 * Enum-value whitelist — string literals whose trimmed text is an exact
 * match for one of these identifiers are treated as safe DB/TS enum
 * values rather than user-visible phrases. The audit still flags any
 * LARGER string that happens to contain the enum value (e.g.
 * `'god_admin required'` in an error message) — only the bare
 * identifier is exempt.
 *
 * At the time this whitelist was introduced (Phase 14 post-merge
 * triage, 2026-04-22) the only entry is the `audience` enum value for
 * `email_template_registry`, which surfaces in ~20 equality checks +
 * registry metadata rows + seed-script argument lists.
 *
 * If a future enum picks a different literal, add it here. Never widen
 * to a wildcard — the point is to stay exhaustive.
 */
const ENUM_VALUE_WHITELIST: ReadonlySet<string> = new Set([
  'god_admin',
])

/**
 * Email pattern — the two seeded god-admin emails.
 */
const EMAIL_PATTERN = /(?:buithai3107@gmail\.com|thaibq@gbox\.co)/i

// ---------------------------------------------------------------------------
// Comment stripping
// ---------------------------------------------------------------------------

/**
 * Replace every block comment (`/* ... *\/`) with whitespace of the
 * same length, preserving newlines so downstream line numbers stay
 * accurate. Multi-line aware.
 *
 * Exported for unit testing.
 */
export function stripBlockComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, (match) =>
    match.replace(/[^\n]/g, ' '),
  )
}

/**
 * Cut a single line at the first `//` that appears OUTSIDE any string
 * literal, preserving the prefix. A state machine tracks whether the
 * cursor is inside a `'`-, `"`-, or `` ` ``-quoted string, honouring
 * backslash escapes.
 *
 * Exported for unit testing.
 */
export function stripLineComment(line: string): string {
  type State = 'outside' | 'single' | 'double' | 'backtick'
  let state: State = 'outside'
  let i = 0
  while (i < line.length) {
    const ch = line[i]
    const next = i + 1 < line.length ? line[i + 1] : ''
    if (state === 'outside') {
      if (ch === '/' && next === '/') return line.slice(0, i)
      if (ch === "'") state = 'single'
      else if (ch === '"') state = 'double'
      else if (ch === '`') state = 'backtick'
      i += 1
      continue
    }
    // Inside a string — walk until the matching unescaped closer.
    if (ch === '\\') {
      i += 2 // skip escaped character
      continue
    }
    const closer =
      state === 'single' ? "'" : state === 'double' ? '"' : '`'
    if (ch === closer) state = 'outside'
    i += 1
  }
  return line
}

// ---------------------------------------------------------------------------
// String-literal extraction
// ---------------------------------------------------------------------------

/**
 * Return every single-, double-, or backtick-quoted string literal on a
 * single line. Naive — does not cross lines, does not fully unescape,
 * does not understand nested template expressions. That's fine: the
 * Iron Rule 5 targets (paths, phrases, emails) are plain ASCII that
 * survive any reasonable quoting, and the scanner runs on source —
 * template strings with embedded expressions still have their literal
 * parts preserved between the interpolation markers.
 *
 * Exported for direct unit testing of the tokenizer.
 */
export function extractStringLiterals(line: string): string[] {
  const literals: string[] = []
  const patterns: RegExp[] = [
    /'((?:[^'\\\n]|\\.)*)'/g,
    /"((?:[^"\\\n]|\\.)*)"/g,
    /`((?:[^`\\\n]|\\.)*)`/g,
  ]
  for (const rx of patterns) {
    let m: RegExpExecArray | null
    while ((m = rx.exec(line)) !== null) {
      literals.push(m[1])
    }
  }
  return literals
}

// ---------------------------------------------------------------------------
// HTML-comment extraction
// ---------------------------------------------------------------------------

/**
 * Return every HTML comment body (`<!-- ... -->`) found on a single
 * line. Unclosed comments — where `<!--` has no matching `-->` on the
 * same line — are captured up to end-of-line so we still scan their
 * content. Multi-line HTML comments that continue onto later lines
 * aren't tracked across the line boundary; that's a known narrow
 * limitation, but it's strictly better than the previous behaviour
 * (no HTML-comment scanning at all).
 *
 * WHY this exists — Phase 14 PR2 regression (orders.ts:425):
 *   an HTML comment `<!-- ... god admin ... -->` sitting inside a
 *   multi-line backtick template leaked through the existing scanner
 *   because `extractStringLiterals` refuses to cross newlines: the
 *   backtick opens many lines above, closes many lines below, and
 *   the comment line itself has no quote chars at all. HTML comments
 *   only ever appear inside seller-visible template output (never in
 *   regular TS / JS code — developers use `//` and `/* *\/` there),
 *   so scanning them by default is the right move.
 *
 * Exported for direct unit testing.
 */
export function extractHtmlComments(line: string): string[] {
  const out: string[] = []
  let i = 0
  while (i < line.length) {
    const open = line.indexOf('<!--', i)
    if (open === -1) break
    const close = line.indexOf('-->', open + 4)
    if (close === -1) {
      out.push(line.slice(open + 4))
      break
    }
    out.push(line.slice(open + 4, close))
    i = close + 3
  }
  return out
}

/**
 * Replace the body of every single-, double-, or backtick-quoted
 * string literal on a line with spaces, keeping overall length and
 * the quote delimiters intact. Honours backslash escapes.
 *
 * Used so HTML-comment extraction can run on "code only" — i.e. the
 * line with string contents erased. Without this, `const x = "<!-- god
 * admin -->"` would produce TWO hits (one from the string-literal
 * scanner, one from the HTML-comment scanner). With it, HTML-comment
 * scanning sees only the parts of the line that are structurally
 * OUTSIDE any string literal — which is exactly the case we care
 * about (HTML comments inside multi-line template literals, where
 * the single line has no quote chars of its own).
 *
 * Exported for direct unit testing.
 */
export function stripStringLiteralBodies(line: string): string {
  type State = 'outside' | 'single' | 'double' | 'backtick'
  let state: State = 'outside'
  const chars = [...line]
  let i = 0
  while (i < chars.length) {
    const ch = chars[i]
    if (state === 'outside') {
      if (ch === "'") state = 'single'
      else if (ch === '"') state = 'double'
      else if (ch === '`') state = 'backtick'
      i += 1
      continue
    }
    // Inside a string literal.
    if (ch === '\\') {
      // Erase the escape sequence so `\"` doesn't confuse downstream scans.
      chars[i] = ' '
      if (i + 1 < chars.length) chars[i + 1] = ' '
      i += 2
      continue
    }
    const closer =
      state === 'single' ? "'" : state === 'double' ? '"' : '`'
    if (ch === closer) {
      state = 'outside'
      i += 1
      continue
    }
    chars[i] = ' '
    i += 1
  }
  return chars.join('')
}

// ---------------------------------------------------------------------------
// File predicates
// ---------------------------------------------------------------------------

/** Regex that matches test file names — `.test.ts`, `.spec.ts`, `.test.tsx`… */
const TEST_FILE_RE = /\.(?:test|spec)\.[jt]sx?$/

/** Inline suppression directive — put `// iron-rule-5-ok: <reason>` on a line to skip it. */
const INLINE_SUPPRESS_RE = /iron-rule-5-ok/

// ---------------------------------------------------------------------------
// Analyser
// ---------------------------------------------------------------------------

function trimSnippet(line: string, max = 120): string {
  const s = line.trim()
  return s.length > max ? s.slice(0, max) + '…' : s
}

/**
 * Scan every supplied file. Returns a structured report listing every
 * string-literal match, categorised by kind.
 */
export function analyseIronRule5(inputs: Rule5Inputs): Rule5Report {
  const exclusions = inputs.selfExclusionSubstrings ?? DEFAULT_SELF_EXCLUSIONS
  const hits: Rule5Hit[] = []
  let scanned = 0
  let excluded = 0

  for (const file of inputs.files) {
    // 1. Tests — allowed to reference Iron Rule 5 strings directly.
    if (TEST_FILE_RE.test(file.path)) {
      excluded += 1
      continue
    }
    // 2. Self-exclusion + caller's custom list.
    if (exclusions.some((s) => file.path.includes(s))) {
      excluded += 1
      continue
    }
    scanned += 1

    // Strip block comments once (multi-line aware), then scan line by line
    // with line-comment stripping applied per-line.
    const sansBlock = stripBlockComments(file.content)
    const lines = sansBlock.split('\n')
    const originalLines = file.content.split('\n')

    for (let i = 0; i < lines.length; i++) {
      const rawLine = originalLines[i] ?? lines[i]
      // 3. Inline suppression — co-located `// iron-rule-5-ok: <reason>`.
      if (INLINE_SUPPRESS_RE.test(rawLine)) continue

      const codeOnly = stripLineComment(lines[i])
      const literals = extractStringLiterals(codeOnly)

      // Scan for HTML comments that live STRUCTURALLY OUTSIDE any
      // string literal on this line — i.e. HTML comments inside a
      // multi-line template literal whose opening backtick lives on
      // a previous line. We strip string bodies first so a literal
      // like `"<!-- -->"` is NOT double-scanned (the string-literal
      // pass below already covers it).
      const codeSansStringBodies = stripStringLiteralBodies(codeOnly)
      const htmlComments = extractHtmlComments(codeSansStringBodies)

      if (literals.length === 0 && htmlComments.length === 0) continue

      for (const lit of literals) {
        // Exact-match enum-value whitelist — skip bare identifiers
        // like `'god_admin'` that are used as DB / TS enum values. A
        // LARGER string containing the same substring still gets
        // flagged by the phrase pattern below.
        if (ENUM_VALUE_WHITELIST.has(lit.trim())) continue

        if (PATH_PATTERN.test(lit)) {
          hits.push({
            file: file.path,
            line: i + 1,
            kind: 'path',
            snippet: trimSnippet(rawLine),
          })
        } else if (PHRASE_PATTERN.test(lit)) {
          hits.push({
            file: file.path,
            line: i + 1,
            kind: 'phrase',
            snippet: trimSnippet(rawLine),
          })
        } else if (EMAIL_PATTERN.test(lit)) {
          hits.push({
            file: file.path,
            line: i + 1,
            kind: 'email',
            snippet: trimSnippet(rawLine),
          })
        }
      }

      // HTML comments are never legitimate carriers of Iron Rule 5
      // phrases — no enum-whitelist bypass applies.
      for (const cmt of htmlComments) {
        if (PATH_PATTERN.test(cmt)) {
          hits.push({
            file: file.path,
            line: i + 1,
            kind: 'path',
            snippet: trimSnippet(rawLine),
          })
        } else if (PHRASE_PATTERN.test(cmt)) {
          hits.push({
            file: file.path,
            line: i + 1,
            kind: 'phrase',
            snippet: trimSnippet(rawLine),
          })
        } else if (EMAIL_PATTERN.test(cmt)) {
          hits.push({
            file: file.path,
            line: i + 1,
            kind: 'email',
            snippet: trimSnippet(rawLine),
          })
        }
      }
    }
  }

  return {
    filesScanned: scanned,
    filesExcluded: excluded,
    hits,
    isClean: hits.length === 0,
  }
}

// ---------------------------------------------------------------------------
// Formatter
// ---------------------------------------------------------------------------

/**
 * Format a report as a human-readable multi-line block for CLI output.
 * Clean report → single summary line. Dirty → summary + per-hit rows.
 */
export function formatIronRule5Report(report: Rule5Report): string {
  if (report.isClean) {
    return `iron-rule-5: clean — ${report.filesScanned} files scanned (${report.filesExcluded} excluded)`
  }

  const byKind: Record<Rule5Hit['kind'], number> = {
    path: 0,
    phrase: 0,
    email: 0,
  }
  for (const h of report.hits) byKind[h.kind] += 1

  const lines: string[] = []
  lines.push(
    `iron-rule-5: ${report.hits.length} violation(s) — ` +
      `${byKind.path} path, ${byKind.phrase} phrase, ${byKind.email} email ` +
      `(${report.filesScanned} scanned, ${report.filesExcluded} excluded)`,
  )
  for (const hit of report.hits) {
    lines.push(`  [${hit.kind}]  ${hit.file}:${hit.line}  ${hit.snippet}`)
  }
  return lines.join('\n')
}
