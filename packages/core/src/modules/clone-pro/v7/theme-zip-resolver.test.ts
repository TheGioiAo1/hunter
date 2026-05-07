/**
 * Clone Pro v7 — ThemeZipS3KeyResolver tests (Task 4 / worker-e2e plumbing).
 *
 * The resolver is a tiny mutable holder that lets the worker hand a
 * lazy reference to `buildV7Deps` BEFORE Stage 15 has produced a
 * theme.zip. Stage 11 (auto-publish) calls `resolver.get()` at publish
 * time; if Stage 15 has by then called `resolver.resolve(key)`, the
 * theme is deployed.
 *
 * Without this indirection, the worker would have to either:
 *   • build deps AFTER Stage 15 (but then Stage 11 lives inside the
 *     orchestrator's 12-stage pipeline that runs BEFORE Stage 15), or
 *   • re-build deps mid-flight (verbose, error-prone).
 *
 * The class also exposes `asResolverFn()` so it adapts cleanly to
 * `BuildV7DepsOptions.themeZipS3KeyResolver: (input) => string | null`
 * — that lets the orchestrator stay function-typed while the worker
 * gets a class with explicit lifecycle.
 */
import { describe, it, expect } from 'vitest'
import { ThemeZipS3KeyResolver } from './theme-zip-resolver.js'

describe('ThemeZipS3KeyResolver', () => {
  it('starts in an unresolved state — get() returns null', () => {
    const r = new ThemeZipS3KeyResolver()
    expect(r.get()).toBeNull()
  })

  it('resolve(key) flips the value; get() then returns the same key', () => {
    const r = new ThemeZipS3KeyResolver()
    r.resolve('themes/shop-1/v1.zip')
    expect(r.get()).toBe('themes/shop-1/v1.zip')
  })

  it('resolve() can be called multiple times — last write wins', () => {
    const r = new ThemeZipS3KeyResolver()
    r.resolve('themes/shop-1/v1.zip')
    r.resolve('themes/shop-1/v2.zip')
    expect(r.get()).toBe('themes/shop-1/v2.zip')
  })

  it('asResolverFn() returns a function compatible with buildV7Deps', () => {
    const r = new ThemeZipS3KeyResolver()
    const fn = r.asResolverFn()
    expect(typeof fn).toBe('function')
    // Before resolve: returns null regardless of jobId/shopId.
    expect(fn({ jobId: 'job-x', shopId: 'shop-x' })).toBeNull()
    r.resolve('themes/shop-x/v1.zip')
    // After resolve: returns the key.
    expect(fn({ jobId: 'job-x', shopId: 'shop-x' })).toBe('themes/shop-x/v1.zip')
  })

  it('asResolverFn() captures the LIVE state — resolves AFTER fn was created propagate', () => {
    const r = new ThemeZipS3KeyResolver()
    const fn = r.asResolverFn() // captured first
    expect(fn({ jobId: 'a', shopId: 'b' })).toBeNull()
    r.resolve('themes/b/v1.zip') // resolved later
    // Race-free: the closure reads the live class state, not a snapshot.
    expect(fn({ jobId: 'a', shopId: 'b' })).toBe('themes/b/v1.zip')
  })

  it('reset() clears the resolved value (defensive — not used in prod but useful for tests)', () => {
    const r = new ThemeZipS3KeyResolver()
    r.resolve('themes/shop-1/v1.zip')
    r.reset()
    expect(r.get()).toBeNull()
  })
})
