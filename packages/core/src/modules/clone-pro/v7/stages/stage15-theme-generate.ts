/**
 * Clone Pro v7 — Stage 15: theme generate
 *
 * Wires the four Sprint 4 building blocks together:
 *   1. component-builder.selectComponents(tokens)  → manifest
 *   2. token-applier.applyTokens(tokens)           → CSS + Liquid vars
 *   3. theme-renderer.renderTheme()                → ThemeBundle
 *   4. theme-renderer.bundleTheme()                → upload theme.zip
 *
 * Then persists results:
 *   - Deactivates the previously active theme for the shop (caller
 *     supplies the SQL via `deactivatePreviousActive`).
 *   - Persists one row per file in the bundle into `theme_files` with
 *     theme_id + version + is_active=true (via `persistThemeFiles`).
 *
 * DI-based: caller wires upload/persist callbacks. No direct S3 / DB
 * imports → unit-testable without AWS / Postgres.
 *
 * Iron rule 5: every error path returns `success: false` + a
 * seller-safe warning that's been through `safeMessage`. Raw
 * diagnostics go to `console.warn` server-side only.
 */

import { renderTheme, bundleTheme, type S3UploadFn } from '../theme-engine/theme-renderer.js'
import type { DesignTokens } from '../theme-engine/token-schema.js'
import type { ComponentManifest } from '../theme-engine/component-builder.js'
import { safeMessage } from '../../../support/safe-message.js'

export interface PersistThemeFilesInput {
  shopId: string
  themeId: string
  version: number
  isActive: boolean
  files: Array<{ path: string; content: string }>
}

export type PersistThemeFilesFn = (input: PersistThemeFilesInput) => Promise<unknown>

export type DeactivatePreviousActiveFn = (input: { shopId: string }) => Promise<number>

export interface Stage15Input {
  jobId: string
  shopId: string
  tokens: DesignTokens
  /** S3 upload (typically wraps @aws-sdk/client-s3 PutObjectCommand). */
  upload: S3UploadFn
  /** Persists `theme_files` rows. Caller decides FK + tx semantics. */
  persistThemeFiles: PersistThemeFilesFn
  /** Flips previous active theme.is_active=false. Returns row count. */
  deactivatePreviousActive: DeactivatePreviousActiveFn
  /** Stage 16 retry sets version=2,3. Default 1. */
  version?: number
  /** Stage 16 may pass score<7 feedback for the retry. */
  previousFeedback?: string[]
}

export interface Stage15Result {
  success: boolean
  theme_id: string
  version: number
  /** S3 key of the uploaded zip. Null when upload failed. */
  theme_zip_key: string | null
  manifest: ComponentManifest | null
  feedback_applied: string[]
  /** Iron rule 5: pre-scrubbed messages. Raw diagnostic in server logs only. */
  warnings: string[]
}

export async function generateTheme(input: Stage15Input): Promise<Stage15Result> {
  const warnings: string[] = []

  // ---- Phase 1: render -------------------------------------------------
  let bundle
  try {
    bundle = await renderTheme({
      tokens: input.tokens,
      version: input.version,
      previousFeedback: input.previousFeedback,
    })
  } catch (err) {
    const { safe, diagnostic } = safeMessage(err)
    console.warn(`[v7-stage15] render failed for shop ${input.shopId} job ${input.jobId}: ${diagnostic}`)
    warnings.push(safe)
    return {
      success: false,
      theme_id: '',
      version: input.version ?? 1,
      theme_zip_key: null,
      manifest: null,
      feedback_applied: input.previousFeedback ?? [],
      warnings,
    }
  }

  // ---- Phase 2: bundle + upload ---------------------------------------
  let themeZipKey: string
  try {
    themeZipKey = await bundleTheme({
      bundle,
      shopId: input.shopId,
      upload: input.upload,
    })
  } catch (err) {
    // bundleTheme already wraps via safeMessage. Pull the safe text out
    // of the rethrown Error and continue without persisting (no zip ⇒
    // can't ship a usable theme).
    const { diagnostic } = safeMessage(err)
    console.warn(`[v7-stage15] bundle/upload failed for shop ${input.shopId}: ${diagnostic}`)
    warnings.push((err as Error).message)
    return {
      success: false,
      theme_id: bundle.theme_id,
      version: bundle.version,
      theme_zip_key: null,
      manifest: bundle.manifest,
      feedback_applied: bundle.feedback_applied,
      warnings,
    }
  }

  // ---- Phase 3: deactivate previous + persist new --------------------
  // Order matters: deactivate FIRST so the partial unique index
  // idx_theme_files_one_active_per_shop never sees two active themes.
  try {
    await input.deactivatePreviousActive({ shopId: input.shopId })
  } catch (err) {
    const { safe, diagnostic } = safeMessage(err)
    console.warn(`[v7-stage15] deactivatePreviousActive failed for shop ${input.shopId}: ${diagnostic}`)
    warnings.push(safe)
    // Continue — Stage 15 still attempts to persist. The DB unique
    // index will reject if there's actually a conflict (rare race).
  }

  try {
    const filesArray = Object.entries(bundle.files).map(([path, content]) => ({ path, content }))
    await input.persistThemeFiles({
      shopId: input.shopId,
      themeId: bundle.theme_id,
      version: bundle.version,
      isActive: true,
      files: filesArray,
    })
  } catch (err) {
    const { safe, diagnostic } = safeMessage(err)
    console.warn(`[v7-stage15] persistThemeFiles failed for shop ${input.shopId}: ${diagnostic}`)
    warnings.push(safe)
    return {
      success: false,
      theme_id: bundle.theme_id,
      version: bundle.version,
      theme_zip_key: themeZipKey,
      manifest: bundle.manifest,
      feedback_applied: bundle.feedback_applied,
      warnings,
    }
  }

  return {
    success: true,
    theme_id: bundle.theme_id,
    version: bundle.version,
    theme_zip_key: themeZipKey,
    manifest: bundle.manifest,
    feedback_applied: bundle.feedback_applied,
    warnings,
  }
}
