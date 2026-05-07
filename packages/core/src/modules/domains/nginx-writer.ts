/**
 * Gbox Platform — Nginx Config Writer
 * (Landing Page System Phase 1D)
 *
 * Generates per-domain Nginx `server {}` blocks that terminate TLS
 * for merchant custom domains. Each block lives in its own file under
 * `/etc/nginx/gbox-domains/<domain>.conf` so reloading nginx only
 * touches the delta — adding a new merchant domain is a single file
 * write + `nginx -s reload` away.
 *
 * Design constraints that shaped this module:
 *
 *   1. Template is a pure string builder. All user-provided values
 *      (domain name, cert path) go through `assertSafeDomain()` /
 *      `assertSafePath()` BEFORE they reach the template so we
 *      cannot inject `;`, newlines, or path traversal into nginx
 *      config. Defence in depth — the domain service's own
 *      validator already rejects weird hostnames but this is the
 *      last line of defence before `nginx -t`.
 *
 *   2. File I/O is injectable (`writeFileImpl`, `mkdirImpl`, etc.)
 *      so tests can assert on the exact file path + contents
 *      without touching disk.
 *
 *   3. Write-then-rename. We write to `<file>.tmp` and atomically
 *      rename so a crashed writer can't leave nginx staring at a
 *      half-written config that fails `nginx -t`.
 *
 *   4. The upstream target (where storefront traffic actually goes)
 *      is injected via config. In production this is `http://127.0.0.1:4321`
 *      (Astro SSR storefront on the same host) but in test environments
 *      it can be a socket path or a private-IP address on another box.
 */

import { promises as fs } from 'node:fs'
import * as path from 'node:path'

// ---------------------------------------------------------------------------
// Config + types
// ---------------------------------------------------------------------------

export interface NginxWriterConfig {
  /**
   * Root directory Nginx includes via `include /etc/nginx/gbox-domains/*.conf;`.
   * Defaults to `/etc/nginx/gbox-domains`. The writer creates it on
   * first use if it doesn't exist.
   */
  domainsDir?: string
  /**
   * Upstream URL the per-domain server block should proxy to. This
   * is where the storefront app listens — e.g. `http://127.0.0.1:4321`
   * on the edge host, or `http://192.168.1.19:4321` if storefront
   * runs on a different box.
   */
  storefrontUpstream: string
  /**
   * Template the shop slug is derived from when setting the
   * `X-Gbox-Shop-Id` header. Pure informational — the storefront's
   * own Host-header middleware does the real routing.
   */
  edgeNodeHostname?: string
  /** Inject for tests. */
  writeFileImpl?: typeof fs.writeFile
  renameImpl?: typeof fs.rename
  mkdirImpl?: typeof fs.mkdir
  unlinkImpl?: typeof fs.unlink
}

export interface DomainServerBlockInput {
  /** Primary hostname the server_name should match. */
  domain: string
  /** Optional extra SANs (typically `www.<domain>`). */
  aliases?: string[]
  /** Absolute path to the fullchain cert lego wrote. */
  certPath: string
  /** Absolute path to the private key. */
  certKeyPath: string
  /** Optional chain/issuer file — some templates include it. */
  chainPath?: string
  /**
   * Shop id the edge stamps onto `X-Gbox-Shop-Id`. The storefront
   * uses it as a tie-break when the Host-header LRU cache misses.
   * Leave undefined to omit the header.
   */
  shopId?: string
  /**
   * Set to true to emit the canonical-redirect snippet that 301s
   * non-primary aliases to the primary domain (Shopify behaviour).
   */
  canonicalRedirect?: boolean
  /**
   * The canonical host the redirect should point at. Only used when
   * `canonicalRedirect` is true AND the incoming host differs.
   */
  canonicalHost?: string
}

// ---------------------------------------------------------------------------
// Safety helpers
// ---------------------------------------------------------------------------

const SAFE_DOMAIN_RE =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/

/**
 * Reject anything that isn't a lowercase RFC-1123 hostname. The
 * service layer already validates on write but we re-validate here
 * because this string ends up in an nginx config and any quoting
 * bug above us becomes config injection.
 */
export function assertSafeDomain(domain: string): void {
  if (typeof domain !== 'string' || !SAFE_DOMAIN_RE.test(domain)) {
    throw new Error(`nginx-writer: unsafe domain rejected: ${JSON.stringify(domain)}`)
  }
  if (domain.length > 253) {
    throw new Error(`nginx-writer: domain exceeds 253 chars: ${domain}`)
  }
}

/**
 * Reject path strings that contain newlines, `..`, quotes, or
 * semicolons. Cert paths are generated internally but we still
 * validate so a buggy upstream can't corrupt nginx config.
 */
export function assertSafePath(p: string, label: string): void {
  if (typeof p !== 'string' || p.length === 0) {
    throw new Error(`nginx-writer: ${label} is empty`)
  }
  if (/[\n\r;"'`$\\]/.test(p)) {
    throw new Error(`nginx-writer: ${label} contains unsafe characters: ${JSON.stringify(p)}`)
  }
  if (p.includes('..')) {
    throw new Error(`nginx-writer: ${label} contains parent traversal: ${p}`)
  }
  if (!p.startsWith('/')) {
    throw new Error(`nginx-writer: ${label} must be an absolute path: ${p}`)
  }
}

/**
 * Same rules as path but a bit looser — upstream URLs look like
 * `http://127.0.0.1:4321`. No newlines, no quoting, must parse as
 * a URL with http/https scheme.
 */
export function assertSafeUpstream(upstream: string): void {
  if (typeof upstream !== 'string' || upstream.length === 0) {
    throw new Error('nginx-writer: storefrontUpstream is empty')
  }
  if (/[\n\r;"'`\\]/.test(upstream)) {
    throw new Error('nginx-writer: storefrontUpstream contains unsafe characters')
  }
  try {
    const url = new URL(upstream)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(`nginx-writer: storefrontUpstream must be http(s): ${upstream}`)
    }
  } catch (err) {
    throw new Error(
      `nginx-writer: storefrontUpstream is not a valid URL: ${upstream} (${err instanceof Error ? err.message : err})`,
    )
  }
}

// ---------------------------------------------------------------------------
// Template
// ---------------------------------------------------------------------------

/**
 * Render the nginx server {} block for a single merchant domain.
 * Pure function — no I/O, no config side-effects. Returns a string
 * the caller can write to disk or diff against an existing config.
 *
 * Shape of the generated block:
 *
 *   - listen 443 ssl http2
 *   - server_name <domain> [<aliases>...]
 *   - ssl_certificate / ssl_certificate_key / includes common SSL
 *     settings snippet (snippets/gbox-ssl-common.conf) which pins
 *     protocols, ciphers, HSTS (production-only), OCSP stapling.
 *   - proxy_pass to storefront upstream with Host preserved + a
 *     set of X-Forwarded-* headers so the upstream sees the real
 *     merchant hostname on `req.headers.host` + `X-Forwarded-Host`.
 *
 *   - Optional canonical redirect (301 to primary) for alias rows.
 *
 *   - A matching listen 80 block that ONLY serves `/.well-known/acme-challenge/`
 *     and redirects everything else to HTTPS. This keeps HTTP-01
 *     renewal working on every domain without extra plumbing.
 */
export function renderDomainServerBlock(
  config: NginxWriterConfig,
  input: DomainServerBlockInput,
): string {
  assertSafeDomain(input.domain)
  for (const alias of input.aliases ?? []) {
    assertSafeDomain(alias)
  }
  assertSafePath(input.certPath, 'certPath')
  assertSafePath(input.certKeyPath, 'certKeyPath')
  if (input.chainPath) assertSafePath(input.chainPath, 'chainPath')
  assertSafeUpstream(config.storefrontUpstream)

  if (input.canonicalRedirect && input.canonicalHost) {
    assertSafeDomain(input.canonicalHost)
  }

  const allHosts = [input.domain, ...(input.aliases ?? [])]
  const serverNames = allHosts.join(' ')

  // The `set $gbox_shop_id` line is emitted only when shopId is
  // provided — keeps the block clean for rows that don't need it.
  const shopIdLine = input.shopId
    ? `    set $gbox_shop_id "${escapeNginxString(input.shopId)}";\n` +
      `    proxy_set_header X-Gbox-Shop-Id $gbox_shop_id;\n`
    : ''

  const canonicalRedirectBlock =
    input.canonicalRedirect && input.canonicalHost
      ? `
    # Shopify-style canonical host redirect — any alias that isn't
    # the primary 301s to the primary so SEO canonical is stable.
    if ($host != "${input.canonicalHost}") {
      return 301 https://${input.canonicalHost}$request_uri;
    }
`
      : ''

  const managedBanner = `# Managed by Gbox edge (nginx-writer). DO NOT EDIT BY HAND.
# Regenerated on every cert issue / renewal. Manual edits will be lost.
# Domain: ${input.domain}
`

  const http80Block = `
server {
    listen 80;
    listen [::]:80;
    server_name ${serverNames};

    # ACME HTTP-01 challenge — MUST be reachable before the redirect
    # so Let's Encrypt can complete issuance + renewal.
    location ^~ /.well-known/acme-challenge/ {
        default_type "text/plain";
        root /var/www/acme-webroot;
        try_files $uri =404;
    }

    # Everything else redirects to HTTPS.
    location / {
        return 301 https://$host$request_uri;
    }
}
`

  const https443Block = `
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name ${serverNames};

    ssl_certificate     ${input.certPath};
    ssl_certificate_key ${input.certKeyPath};
    include snippets/gbox-ssl-common.conf;
${canonicalRedirectBlock}
    location / {
${shopIdLine}        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_read_timeout 60s;
        proxy_send_timeout 60s;
        client_max_body_size 50m;

        proxy_pass ${config.storefrontUpstream};
    }
}
`

  return managedBanner + http80Block + https443Block
}

/**
 * Minimal nginx-safe string escaper for quoted strings we emit.
 * Not a full shell escape — the validators above already reject
 * dangerous characters. This just handles the few chars that are
 * still legal in a shop id but could confuse nginx's quoted string
 * parser (double-quote, backslash).
 */
function escapeNginxString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

// ---------------------------------------------------------------------------
// Filesystem operations
// ---------------------------------------------------------------------------

/**
 * Path on disk for a given domain's generated config file. Wildcard
 * domains (we never write these per-merchant, but the wildcard
 * config ships through the same writer for uniformity) use `_.` as
 * the star replacement so the file name is valid on every FS.
 */
export function configFilePath(domainsDir: string, domain: string): string {
  const safe = domain.replace(/^\*\./, '_.')
  return path.posix.join(domainsDir.replace(/\\/g, '/'), `${safe}.conf`)
}

export interface WriteBlockResult {
  /** Final path the config was written to. */
  path: string
  /** True if an existing file was replaced. */
  replaced: boolean
}

/**
 * Atomically write a rendered server block to
 * `<domainsDir>/<domain>.conf`. Uses write-to-temp + rename so a
 * partial write never leaves nginx staring at invalid syntax.
 */
export async function writeDomainServerBlock(
  config: NginxWriterConfig,
  input: DomainServerBlockInput,
): Promise<WriteBlockResult> {
  const writeFileImpl = config.writeFileImpl ?? fs.writeFile
  const renameImpl = config.renameImpl ?? fs.rename
  const mkdirImpl = config.mkdirImpl ?? fs.mkdir
  const domainsDir = config.domainsDir ?? '/etc/nginx/gbox-domains'

  const body = renderDomainServerBlock(config, input)
  const finalPath = configFilePath(domainsDir, input.domain)
  const tmpPath = `${finalPath}.tmp`

  await mkdirImpl(domainsDir, { recursive: true } as any)

  // writeFileImpl / renameImpl are typed against node's fs.promises,
  // which accepts the paths as-is.
  await writeFileImpl(tmpPath, body, { encoding: 'utf8', mode: 0o644 } as any)

  let replaced = false
  try {
    // If a config with this name exists we treat this as a replace.
    // We don't need to read it — the rename below is atomic.
    await fs.stat(finalPath)
    replaced = true
  } catch {
    replaced = false
  }
  await renameImpl(tmpPath, finalPath)

  return { path: finalPath, replaced }
}

/**
 * Remove a merchant's config file (called on domain removal). Safe
 * to call if the file doesn't exist — returns `{ removed: false }`
 * instead of throwing.
 */
export async function removeDomainServerBlock(
  config: NginxWriterConfig,
  domain: string,
): Promise<{ path: string; removed: boolean }> {
  assertSafeDomain(domain)
  const unlinkImpl = config.unlinkImpl ?? fs.unlink
  const domainsDir = config.domainsDir ?? '/etc/nginx/gbox-domains'
  const finalPath = configFilePath(domainsDir, domain)
  try {
    await unlinkImpl(finalPath)
    return { path: finalPath, removed: true }
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      return { path: finalPath, removed: false }
    }
    throw err
  }
}
