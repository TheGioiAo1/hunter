/**
 * Phase 7 Step 7.4 — sanitize wiring smoke tests.
 *
 * The sanitize module (`sanitize.ts`) has 27 unit tests covering
 * its own behaviour. That only protects us if the persist + theme
 * code paths ACTUALLY CALL it. This file is the drift alarm — it
 * reads each call-site source and regex-matches the integration.
 *
 * If a refactor drops the import or stops piping `body_html` /
 * `description` through `sanitizeClonedHtml`, these tests fail at
 * the source level. We keep the coverage lightweight (regex, not
 * a full fixture test) because persist-pages.test.ts / persist-
 * blog.test.ts don't exist yet — the runtime tests would need a
 * full Kysely + content-service stub that's out of scope for this
 * commit.
 *
 * Regression-hunt summary of what each file MUST contain:
 *   persist-pages.ts    → imports sanitizeClonedHtml, calls it on
 *                         body_html in both insert + update paths.
 *   persist-blog.ts     → imports sanitizeClonedHtml, calls it on
 *                         body_html AND excerpt.
 *   persist-collections → imports sanitizeClonedHtml, calls it on
 *                         description in both insert + update paths.
 *   persist-theme.ts    → imports sanitizeClonedCss, calls it when
 *                         the asset key ends with '.css'.
 */

import { describe, it, expect } from 'vitest'

async function readSource(relativePath: string): Promise<string> {
  const fs = await import('node:fs/promises')
  return fs.readFile(new URL(relativePath, import.meta.url), 'utf8')
}

describe('Phase 7.4 — sanitize wiring', () => {
  it('persist-pages.ts imports sanitizeClonedHtml from sanitize.js', async () => {
    const src = await readSource('./persist/persist-pages.ts')
    expect(src).toMatch(
      /import\s*\{\s*sanitizeClonedHtml\s*\}\s*from\s*['"][^'"]*sanitize\.js['"]/,
    )
  })

  it('persist-pages.ts pipes page.body_html through sanitizeClonedHtml', async () => {
    const src = await readSource('./persist/persist-pages.ts')
    // Insert path AND update path — at least two distinct calls.
    const matches = src.match(/sanitizeClonedHtml\s*\(\s*page\.body_html/g)
    expect(matches).not.toBeNull()
    expect(matches!.length).toBeGreaterThanOrEqual(2)
  })

  it('persist-blog.ts imports sanitizeClonedHtml', async () => {
    const src = await readSource('./persist/persist-blog.ts')
    expect(src).toMatch(
      /import\s*\{\s*sanitizeClonedHtml\s*\}\s*from\s*['"][^'"]*sanitize\.js['"]/,
    )
  })

  it('persist-blog.ts sanitizes post.body_html AND post.excerpt', async () => {
    const src = await readSource('./persist/persist-blog.ts')
    expect(src).toMatch(/sanitizeClonedHtml\s*\(\s*post\.body_html/)
    expect(src).toMatch(/sanitizeClonedHtml\s*\(\s*post\.excerpt/)
  })

  it('persist-collections.ts imports sanitizeClonedHtml', async () => {
    const src = await readSource('./persist/persist-collections.ts')
    expect(src).toMatch(
      /import\s*\{\s*sanitizeClonedHtml\s*\}\s*from\s*['"][^'"]*sanitize\.js['"]/,
    )
  })

  it('persist-collections.ts sanitizes coll.description in insert + update', async () => {
    const src = await readSource('./persist/persist-collections.ts')
    const matches = src.match(/sanitizeClonedHtml\s*\(\s*coll\.description/g)
    expect(matches).not.toBeNull()
    expect(matches!.length).toBeGreaterThanOrEqual(2)
  })

  it('persist-theme.ts imports sanitizeClonedCss', async () => {
    const src = await readSource('./theme-gen/persist-theme.ts')
    expect(src).toMatch(
      /import\s*\{\s*sanitizeClonedCss\s*\}\s*from\s*['"][^'"]*sanitize\.js['"]/,
    )
  })

  it('persist-theme.ts sanitizes CSS-suffixed asset keys', async () => {
    const src = await readSource('./theme-gen/persist-theme.ts')
    // Must both branch on the key suffix AND apply sanitizeClonedCss.
    // The exact expression shape is flexible, but both pieces must
    // appear near each other.
    expect(src).toMatch(/\.endsWith\s*\(\s*['"]\.css['"]\s*\)/)
    expect(src).toMatch(/sanitizeClonedCss\s*\(/)
  })
})
