# Gbox Platform — Edge TLS Bootstrap

This directory contains everything needed to turn a fresh Ubuntu host
into a Gbox edge node that terminates TLS for merchant custom domains.
It's the self-hosted replacement for Cloudflare for SaaS (Phase 1D,
Landing Page System).

## What the edge does

1. Terminates TLS for `*.gbox.co` (wildcard cert, DNS-01 via
   Cloudflare API) AND every merchant custom domain (per-domain cert,
   HTTP-01 via the webroot in this repo).
2. Proxies decrypted HTTP to the storefront upstream (default
   `http://127.0.0.1:4321`).
3. Runs the Node worker loop (`scripts/ops/domains-worker-loop.ts`)
   under pm2 — drains pending verifications + drives lego issuance.
4. Runs a daily systemd timer that calls the renewal batch
   (`scripts/ops/domains-renewal-loop.ts`) at 03:00 UTC.

## Prerequisites

- Ubuntu 22.04 LTS (or 24.04) — paths below assume the
  Debian-family layout.
- `nginx` >= 1.18 (for SNI + http2 support).
- Node 20+ with `pnpm` and `pm2` installed globally.
- `lego` binary installed at `/usr/local/bin/lego` (or on PATH).
  See <https://go-acme.github.io/lego/installation/> — the Debian
  package lags, prefer the static binary release.
- A DNS A record for each edge node's hostname registered in the
  `edge_nodes` DB table (`loadActiveEdgeIpv4Set()` reads it).
- The repo checked out at `/srv/gbox-platform` (or adjust the
  systemd unit's `WorkingDirectory`).

## Bootstrap steps

```bash
# 1. Create the system user the worker runs as.
sudo useradd --system --home /var/lib/gbox-edge --shell /usr/sbin/nologin gbox-edge
sudo install -d -o gbox-edge -g gbox-edge /var/lib/gbox-edge

# 2. Create the ACME webroot + lego data dirs.
sudo install -d -o gbox-edge -g www-data -m 0755 /var/www/acme-webroot
sudo install -d -o gbox-edge -g gbox-edge -m 0750 /etc/gbox/lego
sudo install -d -o gbox-edge -g gbox-edge -m 0755 /etc/nginx/gbox-domains
sudo install -d -o gbox-edge -g gbox-edge -m 0755 /var/log/gbox

# 3. Drop the nginx configs in place.
sudo install -m 0644 ops/edge/nginx/gbox-edge.conf /etc/nginx/conf.d/gbox-edge.conf
sudo install -m 0644 ops/edge/nginx/snippets/gbox-ssl-common.conf /etc/nginx/snippets/gbox-ssl-common.conf

# 4. Install the sudoers rule (narrow nginx reload grant).
sudo install -m 0440 -o root -g root ops/edge/sudoers.d/gbox-edge /etc/sudoers.d/gbox-edge
sudo visudo -cf /etc/sudoers.d/gbox-edge   # must print "parsed OK"

# 5. Install the systemd renewal timer.
sudo install -m 0644 ops/edge/systemd/gbox-domains-renewal.service /etc/systemd/system/
sudo install -m 0644 ops/edge/systemd/gbox-domains-renewal.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now gbox-domains-renewal.timer

# 6. Provision the env file (never commit this).
sudo install -d -m 0750 -o gbox-edge -g gbox-edge /etc/gbox
sudo tee /etc/gbox/edge.env >/dev/null <<'ENV'
DATABASE_URL=postgres://gbox_platform:...@db-host:5432/gbox_platform
ACME_ACCOUNT_EMAIL=ops@gbox.co
ACME_ENVIRONMENT=staging          # flip to "production" after the first green run
ACME_LEGO_PATH=/etc/gbox/lego
ACME_LEGO_BINARY=/usr/local/bin/lego
ACME_WEBROOT_PATH=/var/www/acme-webroot
NGINX_DOMAINS_DIR=/etc/nginx/gbox-domains
STOREFRONT_UPSTREAM=http://127.0.0.1:4321
NGINX_NO_SUDO=0
EDGE_PUBLIC_IP=203.0.113.7
ENV
sudo chown gbox-edge:gbox-edge /etc/gbox/edge.env
sudo chmod 0640 /etc/gbox/edge.env

# 7. Register this edge node in the database.
#    Run from wherever you have DB access — the worker on this host
#    reads the row on its next verification tick.
pnpm --filter @gbox/scripts exec tsx scripts/ops/register-edge-node.ts \
  --hostname edge-01.gbox.co --ipv4 203.0.113.7 --region ap-southeast-1

# 8. Start the worker under pm2.
sudo -u gbox-edge pm2 start scripts/ops/domains-worker-loop.ts \
  --name gbox-domains-worker --interpreter tsx --cwd /srv/gbox-platform/gbox-platform
sudo -u gbox-edge pm2 save
sudo env PATH=$PATH:/usr/bin pm2 startup systemd -u gbox-edge --hp /var/lib/gbox-edge

# 9. Reload nginx with the new include.
sudo nginx -t && sudo systemctl reload nginx
```

## Verification smoke test

Once a merchant has added a domain and published their A record,
the worker should flip it to `active` within a minute or two. To
watch it end-to-end:

```bash
# Tail the worker output.
sudo -u gbox-edge pm2 logs gbox-domains-worker

# Confirm lego actually called LE staging.
sudo ls -la /etc/gbox/lego/certificates/

# Check nginx picked up the new server block.
sudo nginx -T | grep -A2 "server_name <merchant-domain>"

# Confirm the cert chain from the outside.
curl -vI https://<merchant-domain>/ 2>&1 | grep -E "(subject:|issuer:|expire date)"
```

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `lego: rate limited` in worker logs | Hit LE issuance rate limit | Wait 1h. Orchestrator auto-applies a 24h cooldown per-domain on rate-limit errors. |
| `A record mismatch` in verifier logs | Merchant's A record resolves to a stale IP | Ask merchant to republish the A record, then click Verify again. |
| `nginx -t` fails after a cert issue | File-system race or stray hand-edit | `ls /etc/nginx/gbox-domains/` and `nginx -t` to find the bad file; the orchestrator never hand-edits so any dirty file is safe to remove. |
| `edge_nodes table empty` warning | Forgot step 7 | Run the register-edge-node script. |
| Renewal timer never fires | `systemctl status gbox-domains-renewal.timer` → inactive | `sudo systemctl enable --now gbox-domains-renewal.timer` |

## Security notes

- **Never** loosen the sudoers rule. The worker only needs
  `nginx -t` and `systemctl reload nginx`; anything more is a
  privilege-escalation waiting to happen.
- **Never** expose `/etc/gbox/lego/` over HTTP. Cert private keys
  live there.
- **Never** run the worker as root in production. Use
  `NGINX_NO_SUDO=1` only for the bootstrap run (where the root user
  already has full nginx control).
- Rotate `ACME_ACCOUNT_EMAIL` credentials if you ever suspect the
  host has been compromised — the account is tied to all issued
  certs for revocation.
