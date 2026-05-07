# Cloudflare provisioning

Uses `wrangler` (install via `npm i -g wrangler`). Auth once: `wrangler login` (browser-based OAuth) or set `CLOUDFLARE_API_TOKEN` env var with scoped token.

## API token scopes for CI

When creating the token in dashboard → My Profile → API Tokens → Create Custom Token:

- Account → Workers Scripts: Edit
- Account → Cloudflare Pages: Edit
- Account → Workers R2 Storage: Edit (if using R2)
- Account → D1: Edit (if using D1)
- Zone → Zone Settings: Read + Zone → DNS: Edit (only if using custom domain)

Scope to specific account + zones — no wildcard accounts.

## R2 (S3-compatible object storage)

```bash
# Create bucket
wrangler r2 bucket create <name>

# List
wrangler r2 bucket list

# Bind to a Worker (in wrangler.toml):
# [[r2_buckets]]
# binding = "UPLOADS"
# bucket_name = "<name>"

# Public access (if needed) — create r2.dev domain binding via dashboard,
# or put a Worker in front for access control.
```

S3 API compatibility: create API token (R2 → Manage API Tokens), get `access_key_id` + `secret_access_key`, use endpoint `https://<account-id>.r2.cloudflarestorage.com`. Standard AWS S3 SDKs work.

## D1 (SQLite at the edge)

```bash
# Create DB
wrangler d1 create <name>
# Output: database_id — paste into wrangler.toml:
# [[d1_databases]]
# binding = "DB"
# database_name = "<name>"
# database_id = "<id>"

# Execute SQL (migrations)
wrangler d1 execute <name> --remote --file=./schema.sql
# Or interactive:
wrangler d1 execute <name> --remote --command="SELECT name FROM sqlite_master;"

# Migrations directory (recommended)
wrangler d1 migrations create <name> <migration-name>
wrangler d1 migrations apply <name> --remote
```

## KV (key-value store)

```bash
wrangler kv namespace create <NAMESPACE>
# Outputs id — paste into wrangler.toml:
# [[kv_namespaces]]
# binding = "CACHE"
# id = "<id>"

# Put/get
wrangler kv key put --binding=CACHE "key" "value"
wrangler kv key get --binding=CACHE "key"
```

## Workers project

```bash
# Init new worker
wrangler init <project> --type=javascript  # or typescript
cd <project>

# wrangler.toml minimum:
# name = "<project>"
# main = "src/index.ts"
# compatibility_date = "2026-04-01"
# [env.production]
# vars = { NODE_ENV = "production" }

# Secrets (runtime, not committed)
wrangler secret put <KEY>
# (prompts for value)

# Deploy
wrangler deploy
# Preview deploy
wrangler versions upload && wrangler versions deploy
```

Custom domain: `wrangler route add` or dashboard → Worker → Triggers → Add Custom Domain.

## Pages project

Two ways to create:

**A. Git-connected (dashboard)** — Pages → Create → Connect to Git → pick repo → set build command + output dir. Each push auto-builds.

**B. Direct upload (wrangler)** — no git integration, you control when to deploy:

```bash
# Create project (empty)
wrangler pages project create <name> --production-branch=main

# Deploy a build output
wrangler pages deploy ./dist --project-name=<name>
```

`wrangler.toml` for Pages (optional, for functions):

```toml
name = "<pages-project>"
compatibility_date = "2026-04-01"
pages_build_output_dir = "./dist"

[[pages_functions]]
# Functions in functions/ dir are auto-picked up
```

Env vars: `wrangler pages project set <name> --environment production` then add vars via dashboard (or during `deploy` via `--env-file`).

## Custom domain

- Dashboard → Workers / Pages → project → Custom Domains → Set up a custom domain
- Requires the apex or subdomain zone already on Cloudflare
- SSL auto-provisioned

## Common gotchas

- `wrangler dev` runs locally but uses remote bindings unless `--local` flag passed. Easy to burn R2 ops on localhost testing.
- D1 is eventually consistent on writes across regions. Don't design for strong consistency at read-after-write scale.
- KV is NOT a database. Reads are fast, writes propagate in up to 60s.
- Workers have a 10ms CPU time limit on free tier (50ms on paid). Long-running tasks → use Queues or Durable Objects.
- Cloudflare API token leak: rotate immediately in dashboard. No auto-rotation.
