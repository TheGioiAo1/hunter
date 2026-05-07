/**
 * Gbox Platform — CDN Edge Worker
 *
 * Phase B spec §10.5. One Worker script owns three routes on the
 * `cdn.gbox.co` / `download.gbox.co` zones:
 *
 *   1. `cdn.gbox.co/*` (before origin)
 *      Inject the `User-Agent: Mozilla/5.0 (compatible; GboxEdge/1.0; +https://gbox.co/edge)`
 *      header expected by the S3 bucket policy (§5.4). Without this the
 *      bucket returns 403.
 *
 *   2. `cdn.gbox.co/shops/*` (on non-2xx responses)
 *      Serve a tiny base64 placeholder image so a broken S3 fetch does
 *      not render a broken-image icon on storefronts. 30s TTL so a real
 *      fix propagates quickly.
 *
 *   3. `download.gbox.co/*`
 *      Validate a short-lived JWT passed in `?t=<jwt>`, then call the
 *      backend's internal `/api/_internal/sign-download` endpoint to
 *      fetch a presigned S3 URL, and 302 the browser there. We DO NOT
 *      sign AWS URLs at the edge — keeping IAM credentials off the
 *      Worker.
 *
 * Deployment:
 *   wrangler deploy --env production
 *
 * Secrets (set via `wrangler secret put <name> --env production`):
 *   DOWNLOAD_JWT_SECRET    HS256 signing secret shared with backend
 *   DOWNLOAD_SIGN_URL      `https://api.gbox.co/api/_internal/sign-download`
 *   DOWNLOAD_SIGN_TOKEN    Bearer token so the backend validates the edge call
 *
 * Route rules (in wrangler.toml):
 *   - `cdn.gbox.co/*`       (all requests)
 *   - `download.gbox.co/*`  (all requests)
 */

export interface Env {
  DOWNLOAD_JWT_SECRET: string
  DOWNLOAD_SIGN_URL: string
  DOWNLOAD_SIGN_TOKEN: string
}

const EDGE_USER_AGENT =
  'Mozilla/5.0 (compatible; GboxEdge/1.0; +https://gbox.co/edge)'

// 1×1 transparent PNG. ~200 bytes — small enough to inline, avoids the
// broken-image chrome on storefronts when S3 returns 4xx/5xx.
const PLACEHOLDER_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)

    // ------------------------------------------------------------------
    // Route: download.gbox.co/* — signed-download redirector
    // ------------------------------------------------------------------
    if (url.hostname === 'download.gbox.co') {
      return handleSignedDownload(request, env)
    }

    // ------------------------------------------------------------------
    // Route: cdn.gbox.co/* — edge UA stamping + placeholder fallback
    // ------------------------------------------------------------------
    return handleCdnRequest(request, env, ctx)
  },
} satisfies ExportedHandler<Env>

// ---------------------------------------------------------------------------
// cdn.gbox.co handlers
// ---------------------------------------------------------------------------

async function handleCdnRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  void env

  // Clone the request with a stamped User-Agent. Cloudflare will use the
  // modified request when it forwards to the origin (S3 or imgproxy).
  const stamped = new Request(request, {
    headers: mergeHeaders(request.headers, { 'User-Agent': EDGE_USER_AGENT }),
  })

  const originResponse = await fetch(stamped)

  // Only fall back for shop-scoped image paths. Theme library and videos
  // have their own error handling (HLS players retry segments, theme
  // publishes block on upload).
  const path = new URL(request.url).pathname
  const isShopImagePath = /^\/shops\/[^/]+\/.*\.(jpg|jpeg|png|gif|webp|avif|heic|heif)$/i.test(
    path,
  )

  if (isShopImagePath && !originResponse.ok) {
    ctx.waitUntil(
      logEdgeFallback({
        path,
        originStatus: originResponse.status,
      }),
    )
    return placeholderResponse()
  }

  return originResponse
}

function placeholderResponse(): Response {
  const bytes = Uint8Array.from(atob(PLACEHOLDER_PNG_BASE64), (c) =>
    c.charCodeAt(0),
  )
  return new Response(bytes, {
    status: 200,
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=30',
      'X-Gbox-Edge-Fallback': '1',
    },
  })
}

async function logEdgeFallback(info: {
  path: string
  originStatus: number
}): Promise<void> {
  // We don't have a logging destination on the edge yet — this is a
  // placeholder so the wiring is visible. In P2 this will POST to a
  // Cloudflare Analytics Engine binding OR ship to the backend's
  // `/_internal/log-edge` route.
  void info
}

// ---------------------------------------------------------------------------
// download.gbox.co — JWT-gated signed URL issuer
// ---------------------------------------------------------------------------

async function handleSignedDownload(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method Not Allowed', { status: 405 })
  }

  const url = new URL(request.url)
  const token = url.searchParams.get('t')
  if (!token) {
    return new Response('Missing token', { status: 400 })
  }

  // Verify the JWT (HS256). Shared secret with the backend.
  const claims = await verifyJwt(token, env.DOWNLOAD_JWT_SECRET).catch(() => null)
  if (!claims) {
    return new Response('Invalid token', { status: 401 })
  }

  // Claims shape (issued by backend `/account/orders/:id/download`):
  //   { sub: 'order:<id>', aud: 'download', shop_id, object_key, exp }
  if (claims.aud !== 'download' || !claims.object_key || !claims.shop_id) {
    return new Response('Invalid token claims', { status: 401 })
  }

  // Ask backend for a fresh presigned URL. Backend owns the IAM creds;
  // the edge never sees them.
  const signRes = await fetch(env.DOWNLOAD_SIGN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.DOWNLOAD_SIGN_TOKEN}`,
    },
    body: JSON.stringify({
      shop_id: claims.shop_id,
      object_key: claims.object_key,
      requested_by: claims.sub,
    }),
  })

  if (!signRes.ok) {
    return new Response('Upstream error', { status: 502 })
  }

  const body = (await signRes.json()) as { url?: string }
  if (!body?.url) {
    return new Response('Upstream error', { status: 502 })
  }

  return Response.redirect(body.url, 302)
}

// ---------------------------------------------------------------------------
// JWT HS256 verification — stdlib crypto only, no deps.
// ---------------------------------------------------------------------------

interface JwtClaims {
  sub: string
  aud: string
  exp: number
  shop_id?: string
  object_key?: string
  [k: string]: unknown
}

async function verifyJwt(token: string, secret: string): Promise<JwtClaims> {
  const parts = token.split('.')
  if (parts.length !== 3) throw new Error('jwt: malformed')
  const [headerB64, payloadB64, signatureB64] = parts

  const header = JSON.parse(base64urlDecodeToString(headerB64)) as { alg?: string }
  if (header.alg !== 'HS256') throw new Error('jwt: unsupported alg')

  const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`)
  const sig = base64urlDecodeToBytes(signatureB64)
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  )
  const ok = await crypto.subtle.verify('HMAC', key, sig, data)
  if (!ok) throw new Error('jwt: bad signature')

  const claims = JSON.parse(base64urlDecodeToString(payloadB64)) as JwtClaims
  const nowSec = Math.floor(Date.now() / 1000)
  if (typeof claims.exp !== 'number' || claims.exp < nowSec) {
    throw new Error('jwt: expired')
  }
  return claims
}

function base64urlDecodeToString(input: string): string {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/')
  const pad = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4))
  return atob(padded + pad)
}

function base64urlDecodeToBytes(input: string): Uint8Array {
  const s = base64urlDecodeToString(input)
  const bytes = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i)
  return bytes
}

// ---------------------------------------------------------------------------
// Header merging that preserves multi-value headers (Set-Cookie etc).
// ---------------------------------------------------------------------------

function mergeHeaders(
  base: Headers,
  overrides: Record<string, string>,
): Headers {
  const merged = new Headers(base)
  for (const [key, value] of Object.entries(overrides)) {
    merged.set(key, value)
  }
  return merged
}
