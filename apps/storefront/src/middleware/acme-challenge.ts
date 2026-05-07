/**
 * Gbox Storefront — ACME HTTP-01 challenge middleware.
 *
 * Belt-and-braces backup for nginx serving `/.well-known/acme-challenge/`
 * from `/var/www/acme-webroot`. Production should always be terminating
 * the request at nginx (see `infra/nginx/custom-domain-catchall.conf` —
 * the `location ^~ /.well-known/acme-challenge/` block). But there are
 * two reasons we still keep this middleware in front of the storefront:
 *
 *   1. Dev environments without nginx still need to serve challenges
 *      so a developer can `lego` against a local-tunnel test domain.
 *   2. If someone forgets to redeploy the nginx config after a host
 *      bootstrap, this catches the request and serves the file from
 *      the same `/var/www/acme-webroot` path nginx would have used —
 *      lego's certificate request still succeeds, only slightly
 *      slower because Express is in the path.
 *
 * The middleware is read-only filesystem access — it never falls
 * through to a render or a DB lookup. If the file isn't on disk we
 * return 404 fast so the request doesn't accidentally hit the
 * storefront's resolve-shop pipeline (which would 404 with a "Store
 * not found" page that the ACME validator doesn't understand).
 *
 * Order in app.ts: install BEFORE resolve-shop. The path is reserved
 * by RFC 8555; no shop ever needs it for routing, so we can short-
 * circuit before the rest of the storefront pipeline runs.
 */

import type { NextFunction, Request, Response } from 'express'
import { promises as fs } from 'node:fs'
import { join, normalize, resolve as resolvePath, sep } from 'node:path'

const DEFAULT_WEBROOT = '/var/www/acme-webroot'

export interface AcmeChallengeMiddlewareOptions {
  /**
   * Override the webroot location. Defaults to the same
   * `/var/www/acme-webroot` lego uses (see acme-client.ts
   * DEFAULT_WEBROOT). Pass an absolute path; relative paths are
   * resolved against `process.cwd()` (mostly useful for tests).
   */
  webrootPath?: string
  /**
   * Inject `fs.readFile` for tests. Default: real fs.
   */
  readFileImpl?: (path: string) => Promise<Buffer>
}

const CHALLENGE_PATH_PREFIX = '/.well-known/acme-challenge/'

/**
 * Path traversal guard — refuse any token that contains `/`, `\`,
 * `..`, or null bytes. lego only ever generates URL-safe base64
 * tokens, so anything else is an attacker probing.
 */
function isSafeToken(token: string): boolean {
  if (!token) return false
  if (token.length > 200) return false // hard cap; real tokens ~43 chars
  if (token.includes('/') || token.includes('\\')) return false
  if (token.includes('..')) return false
  if (token.includes('\0')) return false
  // Only base64url charset + dot (lego writes <token>.<thumbprint>).
  return /^[A-Za-z0-9_\-.]+$/.test(token)
}

export function buildAcmeChallengeMiddleware(
  options: AcmeChallengeMiddlewareOptions = {},
): (req: Request, res: Response, next: NextFunction) => void {
  const webroot = resolvePath(options.webrootPath ?? DEFAULT_WEBROOT)
  const readFileImpl = options.readFileImpl ?? ((p: string) => fs.readFile(p))

  return function acmeChallengeMiddleware(req, res, next) {
    if (!req.path.startsWith(CHALLENGE_PATH_PREFIX)) {
      return next()
    }

    const token = req.path.slice(CHALLENGE_PATH_PREFIX.length)
    if (!isSafeToken(token)) {
      res.status(400).type('text/plain').send('bad challenge token')
      return
    }

    // Build the file path safely. resolvePath + normalize both prevent
    // the token from ever escaping the webroot directory even if the
    // safe-token regex were ever loosened.
    const filePath = resolvePath(
      join(webroot, '.well-known', 'acme-challenge', token),
    )
    const normalisedRoot = normalize(webroot) + sep
    if (!filePath.startsWith(normalisedRoot)) {
      // Defence in depth: anything that resolves outside the webroot
      // is treated as a probe and 400'd.
      res.status(400).type('text/plain').send('bad path')
      return
    }

    readFileImpl(filePath)
      .then((bytes) => {
        // Lego writes the key authorisation as a single line. Strip a
        // trailing newline if lego ever adds one — RFC 8555 §8.3 says
        // the body MUST be the exact key authorisation, no surrounding
        // whitespace.
        const body = bytes.toString('utf8').trim()
        res
          .status(200)
          .setHeader('Content-Type', 'text/plain; charset=utf-8')
          .setHeader('Cache-Control', 'no-store')
          .send(body)
      })
      .catch((err) => {
        const code = (err as NodeJS.ErrnoException).code
        if (code === 'ENOENT') {
          // Token not on disk — could be a spent challenge, a probe,
          // or nginx already served the live one. 404 plain text.
          res.status(404).type('text/plain').send('not found')
          return
        }
        // Anything else is a server error (permissions, IO).
        res.status(500).type('text/plain').send('internal error')
      })
  }
}

// Internal helpers exported only for tests.
export const __test = { isSafeToken, CHALLENGE_PATH_PREFIX, DEFAULT_WEBROOT }
