/**
 * @deprecated 2026-04-26 — Online Store › Design hub retired.
 *
 * The seller-facing "Design" tab has been split into two purpose-built
 * surfaces:
 *
 *   - Theme management   → /admin/store/:slug/online-store/themes
 *                          (handled by ./theme-clone.ts → getThemesPage)
 *   - Website cloning    → /admin/store/:slug/clone-pro
 *                          (handled by ./clone-pro/index.ts)
 *
 * All four legacy routes (page, clone-start POST, job snapshot, SSE
 * events) now redirect to their /clone-pro/* equivalents — see
 * server.ts. This file stays in tree only so that any stale import
 * trips a build-time error pointing at this note instead of silently
 * resolving an empty module. No handler is exported.
 *
 * Removal target: Phase 24 (after one full release where the redirects
 * have been observed in logs and we are confident no external bookmark
 * still hits the old paths).
 */

export {}
