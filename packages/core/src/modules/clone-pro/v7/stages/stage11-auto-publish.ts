/**
 * Clone Pro v7 — Stage 11: auto-publish + theme deploy
 *
 * Sprint 5 Task 5.3. Wraps v6's `runStage11` with two additional
 * post-publish side-effects:
 *
 *   1. Flip `shop_settings(shop_id, key='theme_loader_version')` to 'v2'.
 *      Causes the storefront DbLoader to read theme_files (the v7
 *      generated bundle) instead of theme_assets (legacy v6 themes).
 *   2. Invoke the theme deploy callback (extracts theme.zip on Server 3
 *      via `scripts/deploy-theme-v7.sh`).
 *
 * Both side-effects only run when:
 *   - The v6 publish actually succeeded (gradeLetter != 'F', auto-publish
 *     enabled, shop has a domain).
 *   - `themeZipS3Key` is non-null. Stage 15 may have failed to converge
 *     (visual_verify_score < 7 after 3 retries) but we still publish
 *     products/collections — the seller gets a functional catalog with
 *     a fallback theme.
 *
 * Error containment: deploy or settings-flip failures don't un-publish
 * the catalog. They surface as `warnings[]` (scrubbed via safeMessage)
 * so the orchestrator can include them in the final job result without
 * leaking internal paths.
 *
 * Iron Rule 5: every error path goes through `safeMessage()`. Raw
 * diagnostics go to `console.warn` (worker logs) only.
 */

import { safeMessage } from '../../../support/safe-message.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RunV6PublishInput {
  jobId: string
  shopId: string
  gradeLetter: 'A' | 'B' | 'C' | 'D' | 'F'
}

export interface RunV6PublishResult {
  published: boolean
  reason?: string
}

export type RunV6PublishFn = (input: RunV6PublishInput) => Promise<RunV6PublishResult>

export interface FlipThemeLoaderVersionInput {
  shopId: string
  version: 'v1' | 'v2'
}

export type FlipThemeLoaderVersionFn = (
  input: FlipThemeLoaderVersionInput,
) => Promise<unknown>

export interface DeployThemeInput {
  shopId: string
  themeZipS3Key: string
}

export type DeployThemeFn = (input: DeployThemeInput) => Promise<unknown>

export interface Stage11V7Input {
  jobId: string
  shopId: string
  gradeLetter: 'A' | 'B' | 'C' | 'D' | 'F'
  /** S3 key from Stage 15. NULL when theme generation failed. */
  themeZipS3Key: string | null
  runV6Publish: RunV6PublishFn
  flipThemeLoaderVersion: FlipThemeLoaderVersionFn
  deployTheme: DeployThemeFn
}

export interface Stage11V7Result {
  published: boolean
  reason?: string
  themeDeployed: boolean
  themeLoaderFlipped: boolean
  /** Iron Rule 5: pre-scrubbed seller-safe strings only. */
  warnings: string[]
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export async function runStage11V7(input: Stage11V7Input): Promise<Stage11V7Result> {
  const warnings: string[] = []

  // ---- Phase 1: v6 publish (sets storefront_clone_jobs.status='published') ---
  const publishResult = await input.runV6Publish({
    jobId: input.jobId,
    shopId: input.shopId,
    gradeLetter: input.gradeLetter,
  })

  // If v6 didn't publish (grade F, auto-publish disabled, no domain), bail
  // before flipping the loader. We don't want a shop pointing at theme_files
  // when the catalog was never published.
  if (!publishResult.published) {
    return {
      published: false,
      reason: publishResult.reason,
      themeDeployed: false,
      themeLoaderFlipped: false,
      warnings,
    }
  }

  // If Stage 15 didn't produce a theme.zip (renderer/upload failed), we're
  // still published but can't ship a v7 theme — leave the loader at v1
  // (the shop's pre-clone theme stays active).
  if (!input.themeZipS3Key) {
    return {
      published: true,
      themeDeployed: false,
      themeLoaderFlipped: false,
      warnings,
    }
  }

  // ---- Phase 2: deploy theme.zip via Server-3 callback ----------------------
  let themeDeployed = false
  try {
    await input.deployTheme({
      shopId: input.shopId,
      themeZipS3Key: input.themeZipS3Key,
    })
    themeDeployed = true
  } catch (err) {
    const { safe, diagnostic } = safeMessage(err)
    console.warn(
      `[v7-stage11] deployTheme failed for shop ${input.shopId} job ${input.jobId}: ${diagnostic}`,
    )
    warnings.push(safe)
    // Continue to phase 3 — flipping the loader is independent of
    // whether the bundle landed on Server 3. A retry can re-deploy.
  }

  // ---- Phase 3: flip theme_loader_version → v2 -----------------------------
  let themeLoaderFlipped = false
  try {
    await input.flipThemeLoaderVersion({
      shopId: input.shopId,
      version: 'v2',
    })
    themeLoaderFlipped = true
  } catch (err) {
    const { safe, diagnostic } = safeMessage(err)
    console.warn(
      `[v7-stage11] flipThemeLoaderVersion failed for shop ${input.shopId}: ${diagnostic}`,
    )
    warnings.push(safe)
  }

  return {
    published: true,
    themeDeployed,
    themeLoaderFlipped,
    warnings,
  }
}
