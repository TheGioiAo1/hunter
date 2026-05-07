/**
 * Gbox Platform — Nginx Config Generator (Phase 3.F)
 *
 * Generates per-domain nginx server blocks for custom domains with
 * Let's Encrypt SSL certificates. The output is a single nginx config
 * file that gets included from the main nginx.conf via:
 *
 *   include /etc/nginx/conf.d/gbox-custom-domains.conf;
 *
 * The reconcile-ssl cron (or a deploy script) calls this after cert
 * issuance to regenerate and reload nginx.
 *
 * Pure function — no I/O. The caller writes the file and reloads nginx.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CustomDomainConfig {
  readonly domain: string
  readonly shopId: string
  /** True if a cert exists at /etc/letsencrypt/live/<domain>/ */
  readonly hasSslCert: boolean
}

export interface NginxConfigOptions {
  /** Upstream name for storefront backend. Default: 'gbox_storefront' */
  readonly upstream?: string
  /** Port the storefront listens on. Default: 4326 */
  readonly storefrontPort?: number
  /** Let's Encrypt base path. Default: '/etc/letsencrypt/live' */
  readonly certBasePath?: string
  /** Admin email for Let's Encrypt. Default: 'admin@gbox.co' */
  readonly adminEmail?: string
}

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------

/**
 * Generate nginx server blocks for a list of custom domains.
 * Returns the full config file content as a string.
 */
export function generateNginxConfig(
  domains: readonly CustomDomainConfig[],
  opts: NginxConfigOptions = {},
): string {
  const upstream = opts.upstream ?? 'gbox_storefront'
  const storefrontPort = opts.storefrontPort ?? 4326
  const certBase = opts.certBasePath ?? '/etc/letsencrypt/live'

  const lines: string[] = [
    '# Gbox Platform — Custom Domain Server Blocks',
    '# Auto-generated. Do not edit manually.',
    `# Generated at: ${new Date().toISOString()}`,
    `# Domains: ${domains.length}`,
    '',
    `upstream ${upstream} {`,
    `    server 127.0.0.1:${storefrontPort};`,
    `    keepalive 16;`,
    `}`,
    '',
  ]

  for (const d of domains) {
    if (d.hasSslCert) {
      // HTTPS server block with SSL
      lines.push(
        `# ${d.domain} (shop: ${d.shopId.slice(0, 8)})`,
        `server {`,
        `    listen 443 ssl http2;`,
        `    listen [::]:443 ssl http2;`,
        `    server_name ${d.domain};`,
        ``,
        `    ssl_certificate     ${certBase}/${d.domain}/fullchain.pem;`,
        `    ssl_certificate_key ${certBase}/${d.domain}/privkey.pem;`,
        `    ssl_protocols       TLSv1.2 TLSv1.3;`,
        `    ssl_ciphers         HIGH:!aNULL:!MD5;`,
        `    ssl_prefer_server_ciphers on;`,
        `    ssl_session_cache   shared:SSL:10m;`,
        `    ssl_session_timeout 10m;`,
        ``,
        `    # HSTS (1 year)`,
        `    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;`,
        ``,
        `    location / {`,
        `        proxy_pass http://${upstream};`,
        `        proxy_http_version 1.1;`,
        `        proxy_set_header Host $host;`,
        `        proxy_set_header X-Real-IP $remote_addr;`,
        `        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`,
        `        proxy_set_header X-Forwarded-Proto $scheme;`,
        `        proxy_set_header Connection "";`,
        `    }`,
        `}`,
        ``,
        `# HTTP → HTTPS redirect`,
        `server {`,
        `    listen 80;`,
        `    listen [::]:80;`,
        `    server_name ${d.domain};`,
        `    return 301 https://$host$request_uri;`,
        `}`,
        ``,
      )
    } else {
      // HTTP-only (for ACME challenge + future cert issuance)
      lines.push(
        `# ${d.domain} (shop: ${d.shopId.slice(0, 8)}, no SSL yet)`,
        `server {`,
        `    listen 80;`,
        `    listen [::]:80;`,
        `    server_name ${d.domain};`,
        ``,
        `    # ACME challenge path for Let's Encrypt`,
        `    location /.well-known/acme-challenge/ {`,
        `        root /var/www/certbot;`,
        `    }`,
        ``,
        `    location / {`,
        `        proxy_pass http://${upstream};`,
        `        proxy_http_version 1.1;`,
        `        proxy_set_header Host $host;`,
        `        proxy_set_header X-Real-IP $remote_addr;`,
        `        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`,
        `        proxy_set_header X-Forwarded-Proto $scheme;`,
        `        proxy_set_header Connection "";`,
        `    }`,
        `}`,
        ``,
      )
    }
  }

  return lines.join('\n')
}
