/**
 * Clone Pro v7 — ThemeZipS3KeyResolver
 *
 * Worker-side handle that bridges the temporal mismatch between
 * Stage 11 (auto-publish, runs INSIDE `runCloneProV7`) and Stage 15
 * (theme generate, runs AFTER `runCloneProV7` returns):
 *
 *   1. Worker creates `const resolver = new ThemeZipS3KeyResolver()`.
 *   2. Worker passes `resolver.asResolverFn()` into `buildV7Deps` —
 *      this hands the orchestrator a `(input) => string | null`
 *      compatible with `BuildV7DepsOptions.themeZipS3KeyResolver`.
 *   3. `runCloneProV7` calls Stage 11 INSIDE its 12-stage pipeline.
 *      At this point the resolver returns `null`, so Stage 11 publishes
 *      the catalog WITHOUT deploying a v7 theme (graceful fallback).
 *   4. Worker runs Stage 13/14/15 outside the orchestrator. Stage 15
 *      produces a `theme_zip_key`. Worker calls `resolver.resolve(key)`.
 *   5. Worker re-invokes the publish path (or runs the deploy directly
 *      via `defaultDeployTheme`) using the now-resolved key.
 *
 * Race-free by design: `get()` reads the live private field, so any
 * resolver function obtained via `asResolverFn()` reflects the latest
 * state at call time. No snapshotting.
 *
 * Iron Rule 5: this module never composes seller-facing strings. Pure
 * mutable holder; observability is done at the worker boundary.
 */

export class ThemeZipS3KeyResolver {
  private value: string | null = null

  /**
   * Set the S3 key for the rendered theme.zip. Last write wins —
   * Stage 16 retry can overwrite Stage 15's first-pass key when the
   * retry produces a new bundle.
   */
  resolve(key: string): void {
    this.value = key
  }

  /** Read the current key (or null if not yet resolved). */
  get(): string | null {
    return this.value
  }

  /**
   * Reset back to the unresolved state. Not used in production —
   * exposed so tests can re-use a single resolver across cases without
   * leaking state between describe-blocks.
   */
  reset(): void {
    this.value = null
  }

  /**
   * Adapter that returns a `BuildV7DepsOptions.themeZipS3KeyResolver`-
   * shaped function. The function reads `this.value` at CALL time, not
   * at adapter-creation time — so the worker can:
   *
   *   const r = new ThemeZipS3KeyResolver()
   *   const deps = buildV7Deps(db, { themeZipS3KeyResolver: r.asResolverFn() })
   *   // ... run pipeline + Stage 15 ...
   *   r.resolve(themeBundle.theme_zip_key)
   *   // ... subsequent deps.autoPublish() invocations see the key.
   *
   * The fn ignores its `jobId/shopId` args by design — one resolver
   * instance per job, single-shot lifetime.
   */
  asResolverFn(): (input: { jobId: string; shopId: string }) => string | null {
    return () => this.value
  }
}
