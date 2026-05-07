/**
 * Gbox Storefront — Theme preview middleware (Stage 3F.2)
 *
 * Lets a merchant open a DRAFT theme on the live storefront without
 * publishing it. The admin dashboard mints a short-lived HMAC token
 * via `signPreviewToken` and shares the URL
 *
 *     https://brand.gbox.co/?preview_theme_id=<id>&preview_token=<token>
 *
 * This middleware reads those two query parameters and, if the token
 * verifies AND is scoped to the current shop AND refers to the same
 * theme id as the query param, stamps `req.gboxPreviewThemeId` so
 * the storefront handler's `getHandlerOptions` can swap in the
 * unpublished theme's engine bundle.
 *
 * What it does NOT do:
 *
 *   • It does NOT itself load the theme — that is the job of
 *     `getHandlerOptions`, which is shop- and deploy-specific. This
 *     keeps the middleware a thin verification layer that stays
 *     useful regardless of how themes are cached in production.
 *   • It does NOT rewrite the URL. The `preview_theme_id` /
 *     `preview_token` query params survive into the router, which
 *     is fine — the canonical-url helper (`@gbox/core/modules/seo`)
 *     already strips them before emitting `<link rel="canonical">`.
 *   • It does NOT reject the request when verification fails —
 *     preview links are MOSTLY legitimate but we don't want an old
 *     / tampered token to leave the visitor staring at a 400. A
 *     broken preview URL silently falls through to the published
 *     theme, which is exactly what Shopify does.
 *
 * Crawler hardening:
 *
 *   A verified preview request sets
 *
 *     X-Robots-Tag: noindex, nofollow
 *
 *   on the response so Google / Bing never cache the draft. This
 *   stacks with the `robots.txt` entry that already disallows
 *   `preview_theme_id` query strings (`apps/storefront/src/middleware/seo-routes.ts`),
 *   but belt-and-braces is the right posture for unpublished content.
 *
 * Disable switch:
 *
 *   If `secret` is empty (or not a string), the middleware installs
 *   a no-op function. This keeps `buildApp` simple — the entrypoint
 *   just forwards `process.env.THEME_PREVIEW_SECRET` and the feature
 *   switches off cleanly on deployments that haven't configured it
 *   yet (or deliberately want it off).
 */

import type { NextFunction, Request, Response } from 'express'
import { verifyPreviewToken } from '@gbox/core/modules/themes/preview-token.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ThemePreviewMiddlewareOptions {
  /**
   * HMAC secret used to verify preview tokens. MUST match the
   * secret the admin dashboard signs with. Pass an empty string to
   * disable preview entirely.
   */
  secret: string
  /**
   * Override the query parameter names. Defaults match what the
   * admin dashboard + runbook documentation use. Only exposed for
   * tests and future-proofing.
   */
  themeIdParam?: string
  tokenParam?: string
}

// Augment the Express Request type so downstream code
// (storefront handler, logging, tests) can read the stamped field
// without `any` casts. Kept in the same file as the factory so no
// other module has to know about the declaration.
declare module 'express-serve-static-core' {
  interface Request {
    /**
     * Stamped by the theme-preview middleware when a valid preview
     * token for this shop + theme has been presented on the URL.
     * `undefined` means "render the published theme as normal".
     */
    gboxPreviewThemeId?: string
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function buildThemePreviewMiddleware(
  options: ThemePreviewMiddlewareOptions,
): (req: Request, res: Response, next: NextFunction) => void {
  const secret = typeof options.secret === 'string' ? options.secret : ''
  const themeIdParam = options.themeIdParam ?? 'preview_theme_id'
  const tokenParam = options.tokenParam ?? 'preview_token'

  // With no secret the whole feature is off — return a pass-through
  // so Express doesn't pay the cost of parsing query strings we'll
  // never look at.
  if (secret.length === 0) {
    return function themePreviewDisabled(_req, _res, next) {
      next()
    }
  }

  return function themePreviewMiddleware(req, res, next) {
    try {
      const query = req.query as Record<string, unknown> | undefined
      if (!query) return next()

      const themeId = stringParam(query[themeIdParam])
      const token = stringParam(query[tokenParam])
      if (!themeId || !token) return next()

      const shopId =
        typeof req.gboxShopId === 'string' && req.gboxShopId.length > 0
          ? req.gboxShopId
          : null
      if (!shopId) return next()

      const result = verifyPreviewToken(secret, token)
      if (!result.ok) {
        req.gboxCtx?.logger?.warn?.(
          { reason: result.reason, themeId },
          'theme-preview: token rejected',
        )
        return next()
      }

      // Cross-check EVERY claim against the request context. The
      // token itself is HMAC-sealed, but we still refuse to honour
      // a token whose shop / theme don't line up — the admin might
      // have generated a link for a different shop and we must not
      // let it flip the current storefront's theme.
      if (result.payload.shopId !== shopId) {
        req.gboxCtx?.logger?.warn?.(
          { tokenShop: result.payload.shopId, requestShop: shopId },
          'theme-preview: token shop mismatch',
        )
        return next()
      }
      if (result.payload.themeId !== themeId) {
        req.gboxCtx?.logger?.warn?.(
          {
            tokenTheme: result.payload.themeId,
            queryTheme: themeId,
          },
          'theme-preview: token theme mismatch',
        )
        return next()
      }

      // All four checks passed — record the preview theme and
      // harden the response against crawlers.
      req.gboxPreviewThemeId = themeId
      res.set('X-Robots-Tag', 'noindex, nofollow')
      req.gboxCtx?.logger?.info?.(
        {
          themeId,
          adminId: result.payload.adminId,
        },
        'theme-preview: active',
      )
      return next()
    } catch (err) {
      // Belt-and-braces — the verifier should never throw, but if
      // it does we MUST NOT crash the storefront. Render the
      // published theme as if no preview params were present.
      req.gboxCtx?.logger?.warn?.(
        { err },
        'theme-preview: unexpected failure — ignoring',
      )
      return next()
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Express query parser produces `string | string[] | ParsedQs |
 * ParsedQs[] | undefined`. Preview params must be plain strings;
 * anything else is treated as "not present" so an attacker can't
 * sneak an array in via `?preview_token=a&preview_token=b` to
 * confuse the verifier.
 */
function stringParam(value: unknown): string | null {
  if (typeof value !== 'string') return null
  if (value.length === 0) return null
  return value
}
