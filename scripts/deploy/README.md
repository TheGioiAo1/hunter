# Gbox Platform — 3-Server LAN Deploy

Phase 0 B bootstrap scripts for the internal test LAN.
Run from any control box (owner's Windows/git-bash or server 1 itself).

## Topology

| # | Host          | User     | Role              | Listens                                                        |
|---|---------------|----------|-------------------|----------------------------------------------------------------|
| 1 | 192.168.1.13  | botesty  | DB + Admin + NGX  | PG 5432, Redis 6379, nginx 80, PM2: api/accounts/god/store/checkout |
| 2 | 192.168.1.30  | unbutu2  | REST API          | gbox-api on 4321 (Shopify-compat /api/2026-04/*)               |
| 3 | 192.168.1.19  | unbutu1  | Public storefront | gbox-storefront on 4321 (Astro SSR)                            |

Nginx on server 1 is the single entry point — route map in `nginx-server1.conf.template`.

## Setup (one time)

1. Create `~/.gbox-deploy.env` on the control box:

   ```bash
   cat > ~/.gbox-deploy.env <<'ENV'
   export GBOX_S1_HOST=192.168.1.13
   export GBOX_S1_USER=botesty
   export GBOX_S1_SUDO_PW='<server 1 sudo password>'
   export GBOX_S2_HOST=192.168.1.30
   export GBOX_S2_USER=unbutu2
   export GBOX_S2_SUDO_PW='<server 2 sudo password>'
   export GBOX_S3_HOST=192.168.1.19
   export GBOX_S3_USER=unbutu1
   export GBOX_S3_SUDO_PW='<server 3 sudo password>'
   export GBOX_REPO_URL=https://github.com/GBox-Company/gbox-platform.git
   export GBOX_REPO_DIR=~/gbox-platform
   export GBOX_BRANCH=master
   ENV
   chmod 600 ~/.gbox-deploy.env
   ```

2. Make sure SSH keys are in place on all 3 servers (scripts don't type passwords interactively). Test with:

   ```bash
   ssh botesty@192.168.1.13  'whoami && node -v && pm2 -v'
   ssh unbutu2@192.168.1.30  'whoami && node -v && pm2 -v'
   ssh unbutu1@192.168.1.19  'whoami && node -v && pm2 -v'
   ```

3. **Sudo mode — pick one:**

   **(a) Password sudo (default).** Fill `GBOX_S*_SUDO_PW` in the env file. The bootstrap forwards each password as a per-invocation env var to the matching remote script, where a small `sudo_run` helper pipes it into `sudo -S`. The password goes via stdin, so it does NOT land on sudo's argv — but it IS visible in `ps aux` on the remote for the ~100ms window while `bash -lc '...'` is the current process. Acceptable for a LAN test deploy; not acceptable for public infrastructure.

   **(b) Passwordless sudo (recommended for prod).** Leave the `GBOX_S*_SUDO_PW` vars empty. On each server, add a NOPASSWD line for the deploy user scoped to the exact commands we run:

   ```
   # /etc/sudoers.d/gbox-deploy (chmod 0440)
   botesty ALL=(root) NOPASSWD: /bin/chown, /bin/mkdir, /usr/bin/install, /usr/sbin/nginx, /bin/systemctl reload nginx, /bin/cp, /bin/mv
   ```

   The `sudo_run` helper will then fall through to plain `sudo` with no prompt.

## Common commands

```bash
# First-time install across all 3 servers
bash scripts/bootstrap-3-servers.sh --init

# Incremental update (git reset --hard + npm ci + pm2 reload)
bash scripts/bootstrap-3-servers.sh --update

# Regenerate nginx config on server 1 and reload
bash scripts/bootstrap-3-servers.sh --nginx

# Curl every endpoint and print pass/fail
bash scripts/bootstrap-3-servers.sh --health

# Everything (init + nginx + health)
bash scripts/bootstrap-3-servers.sh --all

# Print what would run without executing
bash scripts/bootstrap-3-servers.sh --dry-run --update
```

## Troubleshooting (known tech debt from MEMORY.md)

1. **`readable-stream/package.json` is 0 bytes** — every `npm ci` nukes it. The scripts auto-fix via `rm -rf node_modules/readable-stream && npm install readable-stream --no-save`. If you see "readable-stream" errors, re-run the update script.
2. **Root-owned files under `packages/core/src/modules/{cache,logging,monitoring,performance}`** — `sudo chown -R $USER:$USER` is baked into every setup/update script.
3. **PM2 auto-start on boot** — already enabled on all 3 servers with `pm2 save` + `sudo pm2 startup systemd ...`. Do not re-run unless you explicitly want to reset.
4. **`workspace:*` refs in package.json break `npm install`** — already scrubbed from the repo. If a new PR reintroduces them, npm ci will fail fast.
5. **Nginx backup files in `sites-enabled/` cause "duplicate upstream" errors** — `apply-nginx.sh` sweeps stray backups to `/tmp/` before reload. Never leave `.bak` files in that directory.
6. **Control box can't reach Postgres directly** — smoke tests that touch the DB must run from server 2 against `gbox_platform` (not `gbox_test`). See `smoke_test_runbook.md` in MEMORY.

## Security

- SSH + sudo credentials live in `~/.gbox-deploy.env` on the owner's control box, NEVER in git.
- The bootstrap script refuses to run if that file is missing and prints the exact template.
- `git reset --hard origin/$BRANCH` is intentional — owner wants clean deploys with no stash.

## Files

- `../bootstrap-3-servers.sh` — master orchestrator (flag-based)
- `server{1,2,3}-setup.sh` — first-time install per server
- `server{1,2,3}-update.sh` — incremental redeploy per server
- `nginx-server1.conf.template` — final nginx config (no variables, literal LAN IPs)
- `apply-nginx.sh` — backup + install + `nginx -t` + reload on server 1
- `health-check.sh` — curl every endpoint, exit 1 on any failure
