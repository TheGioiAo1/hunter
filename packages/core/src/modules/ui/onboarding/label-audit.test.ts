/**
 * Lint-level invariant — no forbidden pre-rename label in onboarding
 * source (Phase F Task F6, 2026-04-18).
 *
 * Thai's owner-locked decision on 2026-04-18: every seller-visible
 * string on the onboarding surface says "Theme Library". The older
 * "Design Library" phrasing lives only in internal plumbing
 * (`/design-library` route, `design_library_entries` table). To prevent
 * drift, this test greps the two render modules (+ any future CSS
 * siblings) and fails the build if the forbidden literal appears even
 * in comments.
 *
 * Why comments matter: a developer copying the comment into an adjacent
 * string literal (or converting a JSDoc into user-visible copy) is the
 * exact kind of accidental regression this guard exists to catch. The
 * stricter rule (literal banned even in prose) costs nothing — we
 * rephrase the explanation to reference "the forbidden literal" or
 * "the older label" rather than naming it.
 *
 * Scope
 * -----
 *
 *   welcome.ts + library-preview.ts — the two render modules directly
 *   targeted by the welcome page. Future sibling CSS files will be
 *   picked up automatically via the glob below.
 *
 * Not in scope
 * ------------
 *
 *   Test files (welcome.test.ts, library-preview.test.ts, this file) —
 *   they assert the literal is NOT emitted, which is unavoidable in
 *   test source. The filter below excludes `.test.ts`.
 *
 *   The design-library page itself (apps/store-admin/src/pages/
 *   design-library.ts) — the plan keeps that page's default copy as-is
 *   and swaps only when visited via `?from=onboarding`. That branch is
 *   covered by design-library.test.ts.
 *
 *   The sidebar nav label in seller-layout.ts — that's admin-wide copy,
 *   not onboarding-specific. Out of scope for this audit per the plan.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const FORBIDDEN_LITERAL = 'Design Library'

function moduleDir(): string {
  // Resolve the directory this test file lives in. Done at call time so
  // the code stays portable — no hard-coded absolute paths.
  const here = fileURLToPath(new URL('.', import.meta.url))
  return here
}

function listRenderSources(): readonly string[] {
  const dir = moduleDir()
  return readdirSync(dir)
    .filter((name) => {
      if (name.endsWith('.test.ts')) return false
      if (name.endsWith('.d.ts')) return false
      return name.endsWith('.ts') || name.endsWith('.css')
    })
    .map((name) => join(dir, name))
}

describe('onboarding UI label audit (Phase F Task F6)', () => {
  it('lists the two expected render sources (guards the glob itself)', () => {
    const sources = listRenderSources().map((p) =>
      p.split(/[\\/]/).pop()!,
    )
    // If this list shrinks unexpectedly the grep below becomes a no-op
    // and regressions sneak in — so we lock the expected file set.
    expect(sources).toEqual(
      expect.arrayContaining(['welcome.ts', 'library-preview.ts']),
    )
  })

  it('never uses the forbidden pre-rename literal in any render source', () => {
    const offenders: Array<{ file: string; line: number; text: string }> = []

    for (const absPath of listRenderSources()) {
      const content = readFileSync(absPath, 'utf8')
      const lines = content.split(/\r?\n/)
      lines.forEach((text, idx) => {
        if (text.includes(FORBIDDEN_LITERAL)) {
          offenders.push({
            file: absPath.split(/[\\/]/).slice(-2).join('/'),
            line: idx + 1,
            text: text.trim(),
          })
        }
      })
    }

    // Assert with a human-readable diff if the guard catches something.
    expect(offenders, `
Forbidden literal "${FORBIDDEN_LITERAL}" found in onboarding render
source. Per Thai's 2026-04-18 rename, seller-facing copy on this
surface must say "Theme Library" — even in comments, because nearby
string-literal drift is exactly what this audit prevents. Rephrase the
offending lines to reference "the older label" or "the forbidden
literal" rather than naming it.
Offenders:
${offenders.map((o) => `  ${o.file}:${o.line}  ${o.text}`).join('\n')}
`).toEqual([])
  })
})
