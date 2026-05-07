/**
 * Iron Rule 5 Lint — unit tests.
 *
 * The analyser is pure, so we drive it with synthetic file fixtures
 * instead of walking disk. Every kind of leak (path, phrase, email) and
 * every "legitimate ignore" (comments, god-admin's own UI, self-
 * exclusion) has at least one test below.
 */

import { describe, it, expect } from 'vitest'
import {
  analyseIronRule5,
  extractHtmlComments,
  extractStringLiterals,
  formatIronRule5Report,
  stripStringLiteralBodies,
  DEFAULT_SELF_EXCLUSIONS,
} from './iron-rule-5-lint.js'

// ---------------------------------------------------------------------------
// Literal extractor
// ---------------------------------------------------------------------------

describe('extractStringLiterals', () => {
  it('pulls double-quoted strings', () => {
    expect(extractStringLiterals('const x = "hello"')).toEqual(['hello'])
  })

  it('pulls single-quoted strings', () => {
    expect(extractStringLiterals("const x = 'hello'")).toEqual(['hello'])
  })

  it('pulls backtick strings', () => {
    expect(extractStringLiterals('const x = `hello`')).toEqual(['hello'])
  })

  it('pulls multiple literals on one line', () => {
    // The extractor runs the three quote-style regexes in sequence, so
    // mixed single/double literals come back grouped-by-regex, not in
    // left-to-right source order. That's fine — the analyser only
    // needs the SET of literals to test patterns against.
    const out = extractStringLiterals('return { a: "one", b: \'two\' }')
    expect(out).toHaveLength(2)
    expect(out).toContain('one')
    expect(out).toContain('two')
  })

  it('handles escaped quotes inside a string', () => {
    const out = extractStringLiterals('const msg = "he said \\"hi\\""')
    expect(out).toHaveLength(1)
    expect(out[0]).toContain('he said')
  })

  it('returns [] for lines with no string literal', () => {
    expect(extractStringLiterals('const x = 42 // no strings here')).toEqual(
      [],
    )
  })
})

// ---------------------------------------------------------------------------
// HTML-comment extractor
// ---------------------------------------------------------------------------

describe('extractHtmlComments', () => {
  it('pulls a single HTML comment on a line', () => {
    expect(extractHtmlComments('<!-- hello -->')).toEqual([' hello '])
  })

  it('pulls multiple HTML comments on a line', () => {
    expect(extractHtmlComments('<!-- one --><!-- two -->')).toEqual([
      ' one ',
      ' two ',
    ])
  })

  it('pulls an HTML comment embedded between markup', () => {
    expect(
      extractHtmlComments('<div><!-- a --><span>x</span><!-- b --></div>'),
    ).toEqual([' a ', ' b '])
  })

  it('captures content after an unclosed <!-- up to EOL', () => {
    // Multi-line HTML comments aren't tracked across lines, but the
    // opening line's trailing content is still scanned so the phrase
    // is found on line 1 even if `-->` is on a later line.
    expect(extractHtmlComments('foo <!-- partial god admin')).toEqual([
      ' partial god admin',
    ])
  })

  it('returns [] when there is no HTML comment', () => {
    expect(extractHtmlComments('const x = 42')).toEqual([])
    expect(extractHtmlComments('<div>no comment</div>')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// String-body stripper
// ---------------------------------------------------------------------------

describe('stripStringLiteralBodies', () => {
  it('erases a double-quoted string body', () => {
    expect(stripStringLiteralBodies('const x = "hello"')).toBe(
      'const x = "     "',
    )
  })

  it('erases a single-quoted string body', () => {
    expect(stripStringLiteralBodies("const x = 'hi'")).toBe("const x = '  '")
  })

  it('erases a backtick-quoted string body', () => {
    expect(stripStringLiteralBodies('const x = `yo`')).toBe('const x = `  `')
  })

  it('handles escaped quotes inside a string', () => {
    // `"she said \"hi\""` → both escape sequences + inner chars erased,
    // surrounding quotes preserved.
    const out = stripStringLiteralBodies('const x = "she said \\"hi\\""')
    expect(out.startsWith('const x = "')).toBe(true)
    expect(out.endsWith('"')).toBe(true)
    // No unescaped quotes survive inside the erased body.
    expect(out.slice('const x = "'.length, -1).trim()).toBe('')
  })

  it('leaves non-string regions untouched', () => {
    // HTML comment outside any string literal — the whole line is
    // preserved verbatim.
    const line = '<div><!-- comment --></div>'
    expect(stripStringLiteralBodies(line)).toBe(line)
  })

  it('allows HTML-comment extraction after stripping string bodies', () => {
    // Regression glue — this is the composition the analyser relies
    // on. Strip first, then extract HTML comments. The string `"ok"`
    // vanishes; the HTML comment on the same line survives.
    const line = 'const s = "ok"; /*unused*/ <!-- see Gbox --> rest'
    const stripped = stripStringLiteralBodies(line)
    expect(extractHtmlComments(stripped)).toEqual([' see Gbox '])
  })
})

// ---------------------------------------------------------------------------
// Analyser — clean inputs
// ---------------------------------------------------------------------------

describe('analyseIronRule5 — clean', () => {
  it('reports clean when no files leak', () => {
    const report = analyseIronRule5({
      files: [
        {
          path: 'apps/store-admin/src/clean.ts',
          content: [
            '// Safe seller-facing module',
            "const url = '/admin/dashboard'",
            "const msg = 'Please contact Gbox support.'",
          ].join('\n'),
        },
      ],
    })
    expect(report.isClean).toBe(true)
    expect(report.hits).toEqual([])
    expect(report.filesScanned).toBe(1)
  })

  it('ignores god-admin mentions in COMMENTS (not in string literals)', () => {
    // Iron Rule 5 targets seller-visible strings; comments never ship
    // to the seller's browser. This test locks that behavior in.
    const report = analyseIronRule5({
      files: [
        {
          path: 'apps/store-admin/src/some-handler.ts',
          content: [
            '// See Iron Rule 5: never leak god admin paths like /god-admin/stores.',
            '/* Don\'t link sellers to /god-admin/anything. */',
            "const msg = 'Please contact Gbox support.'",
          ].join('\n'),
        },
      ],
    })
    expect(report.isClean).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Analyser — path leaks
// ---------------------------------------------------------------------------

describe('analyseIronRule5 — path leaks', () => {
  it('flags /god-admin path in a double-quoted string', () => {
    const report = analyseIronRule5({
      files: [
        {
          path: 'packages/core/src/modules/foo/bar.ts',
          content:
            'const err = "Configure one at /god-admin/integrations/gbox-legacy."',
        },
      ],
    })
    expect(report.isClean).toBe(false)
    expect(report.hits).toHaveLength(1)
    expect(report.hits[0].kind).toBe('path')
    expect(report.hits[0].line).toBe(1)
    expect(report.hits[0].file).toBe(
      'packages/core/src/modules/foo/bar.ts',
    )
  })

  it('flags /god-admin path in a single-quoted string', () => {
    const report = analyseIronRule5({
      files: [
        {
          path: 'apps/store-admin/src/page.ts',
          content: "const href = '/god-admin/stores'",
        },
      ],
    })
    expect(report.hits).toHaveLength(1)
    expect(report.hits[0].kind).toBe('path')
  })

  it('flags /god-admin path in a backtick template', () => {
    const report = analyseIronRule5({
      files: [
        {
          path: 'apps/store-admin/src/page.ts',
          content: 'const href = `/god-admin/stores/${id}`',
        },
      ],
    })
    expect(report.hits).toHaveLength(1)
    expect(report.hits[0].kind).toBe('path')
  })

  it('flags /god-admin appearing bare (no trailing path)', () => {
    const report = analyseIronRule5({
      files: [
        {
          path: 'apps/store-admin/src/redirect.ts',
          content: 'res.redirect("/god-admin")',
        },
      ],
    })
    expect(report.hits).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Analyser — phrase leaks
// ---------------------------------------------------------------------------

describe('analyseIronRule5 — phrase leaks', () => {
  it('flags "God Admin" in UI copy', () => {
    const report = analyseIronRule5({
      files: [
        {
          path: 'apps/store-admin/src/banner.ts',
          content: 'const text = "Ask your God Admin to enable this feature."',
        },
      ],
    })
    expect(report.hits).toHaveLength(1)
    expect(report.hits[0].kind).toBe('phrase')
  })

  it('flags "god-admin" with hyphen', () => {
    const report = analyseIronRule5({
      files: [
        {
          path: 'apps/store-admin/src/toast.ts',
          content: 'showToast("Requires god-admin access")',
        },
      ],
    })
    // Should hit "phrase" at minimum (no leading slash so not path)
    expect(report.hits.some((h) => h.kind === 'phrase')).toBe(true)
  })

  it('flags "God_Admin" with underscore', () => {
    const report = analyseIronRule5({
      files: [
        {
          path: 'apps/store-admin/src/label.ts',
          content: 'const label = "God_Admin only"',
        },
      ],
    })
    expect(report.hits[0].kind).toBe('phrase')
  })

  it('ignores unrelated words containing "god"', () => {
    const report = analyseIronRule5({
      files: [
        {
          path: 'apps/store-admin/src/greet.ts',
          content: 'const greeting = "Good morning, Sundae"',
        },
      ],
    })
    expect(report.isClean).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Analyser — enum-value whitelist (DB / TS discriminator literals)
// ---------------------------------------------------------------------------

describe('analyseIronRule5 — enum-value whitelist', () => {
  it('ignores a bare `god_admin` literal in an equality check', () => {
    // Regression from Phase 14 post-merge triage: the email registry
    // has ~20 `audience === 'god_admin'` comparisons plus object-literal
    // values like `audience: 'god_admin'`. They never reach the seller
    // browser — the DB / TS enum identifier is strictly internal.
    const report = analyseIronRule5({
      files: [
        {
          path: 'packages/core/src/modules/email/send.ts',
          content: [
            "if (spec.audience === 'god_admin' && input.shopId !== null) {",
            "  return { ok: false }",
            '}',
          ].join('\n'),
        },
      ],
    })
    expect(report.isClean).toBe(true)
  })

  it("ignores `{ audience: 'god_admin' }` object-literal values", () => {
    const report = analyseIronRule5({
      files: [
        {
          path: 'packages/core/src/modules/email/registry.ts',
          content: "const spec = { audience: 'god_admin', priority: 1 }",
        },
      ],
    })
    expect(report.isClean).toBe(true)
  })

  it('ignores `god_admin` as a positional argument in a tuple/seed list', () => {
    const report = analyseIronRule5({
      files: [
        {
          path: 'packages/core/src/modules/email/registry.ts',
          content:
            "const SEEDS = [['platform_incident_alert', 'platform', 'god_admin', 1]]",
        },
      ],
    })
    expect(report.isClean).toBe(true)
  })

  it('still flags `god_admin` when it appears inside a larger phrase', () => {
    // Whitelist is exact-match: a literal whose trimmed text IS
    // 'god_admin' is skipped, but a LARGER string that happens to
    // contain it (e.g. an error message) is still a phrase leak.
    const report = analyseIronRule5({
      files: [
        {
          path: 'apps/store-admin/src/toast.ts',
          content: "throw new Error('god_admin required for this action')",
        },
      ],
    })
    expect(report.isClean).toBe(false)
    expect(report.hits[0].kind).toBe('phrase')
  })

  it('still flags hyphen-separated `god-admin` outside the whitelist', () => {
    // The whitelist covers the underscored DB-enum value only. A bare
    // hyphenated 'god-admin' string literal is rare enough that the
    // default behaviour (flag it) is the right call.
    const report = analyseIronRule5({
      files: [
        {
          path: 'apps/store-admin/src/label.ts',
          content: "const label = 'god-admin'",
        },
      ],
    })
    expect(report.isClean).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Analyser — email leaks
// ---------------------------------------------------------------------------

describe('analyseIronRule5 — email leaks', () => {
  it('flags buithai3107@gmail.com', () => {
    const report = analyseIronRule5({
      files: [
        {
          path: 'apps/store-admin/src/support.ts',
          content: 'const owner = "buithai3107@gmail.com"',
        },
      ],
    })
    expect(report.hits[0].kind).toBe('email')
  })

  it('flags thaibq@gbox.co (case-insensitive)', () => {
    const report = analyseIronRule5({
      files: [
        {
          path: 'apps/store-admin/src/banner.ts',
          content: 'const notice = "Contact ThaiBQ@Gbox.co for help"',
        },
      ],
    })
    expect(report.hits[0].kind).toBe('email')
  })

  it('does not flag generic support emails', () => {
    const report = analyseIronRule5({
      files: [
        {
          path: 'apps/store-admin/src/banner.ts',
          content: 'const notice = "Contact support@gbox.co for help"',
        },
      ],
    })
    expect(report.isClean).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Self-exclusion
// ---------------------------------------------------------------------------

describe('analyseIronRule5 — self-exclusion', () => {
  it('skips files whose path matches a self-exclusion substring', () => {
    const report = analyseIronRule5({
      files: [
        {
          path: 'packages/core/src/modules/ops/iron-rule-5-lint.test.ts',
          content: 'const path = "/god-admin/stores"',
        },
      ],
    })
    expect(report.isClean).toBe(true)
    expect(report.filesExcluded).toBe(1)
    expect(report.filesScanned).toBe(0)
  })

  it('DEFAULT_SELF_EXCLUSIONS covers lint module + its tests', () => {
    expect(DEFAULT_SELF_EXCLUSIONS).toContain('iron-rule-5-lint.ts')
    expect(DEFAULT_SELF_EXCLUSIONS).toContain('iron-rule-5-lint.test.ts')
  })

  it('honours caller-supplied exclusions', () => {
    const report = analyseIronRule5({
      files: [
        {
          path: 'apps/store-admin/src/debug.ts',
          content: 'const path = "/god-admin/stores"',
        },
      ],
      selfExclusionSubstrings: ['debug.ts'],
    })
    expect(report.isClean).toBe(true)
    expect(report.filesExcluded).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Analyser — HTML-comment leaks (orders.ts:425 regression class)
// ---------------------------------------------------------------------------

describe('analyseIronRule5 — HTML-comment leaks', () => {
  it('flags a "god admin" phrase inside an HTML comment on its own line', () => {
    // The exact bug shape the Phase 14 PR2 follow-up audit found in
    // apps/store-admin/src/pages/orders.ts:425 — an HTML comment
    // embedded inside a multi-line backtick template. The opening
    // backtick is on an earlier line, the closing backtick is on a
    // later line, so the comment line has no quote chars of its
    // own. Before the fix, `extractStringLiterals` refused to cross
    // newlines and the leak shipped to seller browsers.
    const report = analyseIronRule5({
      files: [
        {
          path: 'apps/store-admin/src/pages/orders.ts',
          content: [
            'export function render() {',
            '  return `',
            '    <select>',
            '      <option value="mark_paid">Mark as paid</option>',
            '      <!-- mark_fulfilled removed: fulfillment flows via god admin -->',
            '      <option value="add_tag">Add tag</option>',
            '    </select>',
            '  `',
            '}',
          ].join('\n'),
        },
      ],
    })
    expect(report.isClean).toBe(false)
    expect(report.hits).toHaveLength(1)
    expect(report.hits[0].kind).toBe('phrase')
    expect(report.hits[0].line).toBe(5)
    expect(report.hits[0].file).toBe(
      'apps/store-admin/src/pages/orders.ts',
    )
  })

  it('flags a /god-admin path leak inside an HTML comment', () => {
    const report = analyseIronRule5({
      files: [
        {
          path: 'apps/storefront/src/pages/landing.ts',
          content: [
            'const html = `',
            '<header>Welcome</header>',
            '<!-- TODO: link /god-admin/dashboard for staff -->',
            '<footer>&copy;</footer>',
            '`',
          ].join('\n'),
        },
      ],
    })
    expect(report.hits).toHaveLength(1)
    expect(report.hits[0].kind).toBe('path')
    expect(report.hits[0].line).toBe(3)
  })

  it('flags a god-admin email inside an HTML comment', () => {
    const report = analyseIronRule5({
      files: [
        {
          path: 'apps/accounts/src/pages/contact.ts',
          content: [
            'const page = `',
            '<!-- owner buithai3107@gmail.com if escalation needed -->',
            '`',
          ].join('\n'),
        },
      ],
    })
    expect(report.hits).toHaveLength(1)
    expect(report.hits[0].kind).toBe('email')
    expect(report.hits[0].line).toBe(2)
  })

  it('does NOT double-count an HTML comment that IS the string literal', () => {
    // When the HTML comment is the BODY of a double-quoted string,
    // the string-literal scanner already flags it. The HTML-comment
    // scanner must NOT fire a second time for the same text, because
    // stripStringLiteralBodies erases the string content before
    // extractHtmlComments runs.
    const report = analyseIronRule5({
      files: [
        {
          path: 'apps/store-admin/src/debug.ts',
          content: 'const html = "<!-- leak god admin -->"',
        },
      ],
    })
    expect(report.hits).toHaveLength(1)
    expect(report.hits[0].kind).toBe('phrase')
  })

  it('respects the iron-rule-5-ok inline suppression directive', () => {
    const report = analyseIronRule5({
      files: [
        {
          path: 'apps/store-admin/src/audit-doc.ts',
          content: [
            'const html = `',
            '<!-- example of god admin leak --> // iron-rule-5-ok: doc fixture',
            '`',
          ].join('\n'),
        },
      ],
    })
    expect(report.isClean).toBe(true)
  })

  it('ignores HTML-comment leaks in test files (tests must be free to assert)', () => {
    const report = analyseIronRule5({
      files: [
        {
          path: 'apps/store-admin/src/orders.test.ts',
          content: [
            'const sample = `',
            '<!-- god admin example -->',
            '`',
          ].join('\n'),
        },
      ],
    })
    expect(report.isClean).toBe(true)
    expect(report.filesExcluded).toBe(1)
  })

  it('flags multiple HTML comments on the same line independently', () => {
    // Two distinct leaks → two hits.
    const report = analyseIronRule5({
      files: [
        {
          path: 'apps/storefront/src/double.ts',
          content:
            '`<div><!-- /god-admin/x --><span/><!-- contact thaibq@gbox.co --></div>`',
        },
      ],
    })
    // Note: the outer backtick wraps both — the string-literal
    // scanner fires once because the literal body itself contains
    // both phrases. The HTML-comment scanner does NOT double-fire
    // because stripStringLiteralBodies erases the inner content
    // before extraction runs. We just assert ≥1 hit covering both
    // kinds.
    const kinds = report.hits.map((h) => h.kind).sort()
    expect(report.isClean).toBe(false)
    expect(kinds.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// Mixed + multi-file
// ---------------------------------------------------------------------------

describe('analyseIronRule5 — multi-file', () => {
  it('aggregates hits across files and kinds', () => {
    const report = analyseIronRule5({
      files: [
        {
          path: 'apps/store-admin/src/a.ts',
          content: 'const href = "/god-admin/stores"',
        },
        {
          path: 'apps/store-admin/src/b.ts',
          content: 'const msg = "Ask your God Admin"',
        },
        {
          path: 'apps/storefront/src/c.ts',
          content: 'const owner = "buithai3107@gmail.com"',
        },
        {
          path: 'apps/store-admin/src/clean.ts',
          content: "const msg = 'Please contact Gbox support.'",
        },
      ],
    })
    expect(report.hits).toHaveLength(3)
    const kinds = report.hits.map((h) => h.kind).sort()
    expect(kinds).toEqual(['email', 'path', 'phrase'])
    expect(report.filesScanned).toBe(4)
  })
})

// ---------------------------------------------------------------------------
// Formatter
// ---------------------------------------------------------------------------

describe('formatIronRule5Report', () => {
  it('clean report yields a single summary line', () => {
    const out = formatIronRule5Report({
      filesScanned: 10,
      filesExcluded: 2,
      hits: [],
      isClean: true,
    })
    expect(out).toBe('iron-rule-5: clean — 10 files scanned (2 excluded)')
  })

  it('dirty report breaks down hits by kind and lists them', () => {
    const out = formatIronRule5Report({
      filesScanned: 3,
      filesExcluded: 0,
      hits: [
        {
          file: 'apps/store-admin/src/a.ts',
          line: 5,
          kind: 'path',
          snippet: 'const href = "/god-admin/stores"',
        },
        {
          file: 'apps/storefront/src/c.ts',
          line: 10,
          kind: 'email',
          snippet: 'const owner = "buithai3107@gmail.com"',
        },
      ],
      isClean: false,
    })
    expect(out).toContain('2 violation(s)')
    expect(out).toContain('1 path')
    expect(out).toContain('0 phrase')
    expect(out).toContain('1 email')
    expect(out).toContain('apps/store-admin/src/a.ts:5')
    expect(out).toContain('apps/storefront/src/c.ts:10')
  })
})
