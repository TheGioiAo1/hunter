---
name: deploy
description: "Ship already-built code to production — AWS, Cloudflare (Pages/Workers), Vercel, VPS+Docker. Direct-mode (CLI from local) or CI-mode (push to main, let existing GH Actions run). Assumes infra + CI pipelines already exist — if not, run /devops first. Strict on secrets — never echoed, never committed."
license: MIT
argument-hint: "[platform] [--ci | --direct] [env]"
metadata:
  author: claudex-kit
  version: "1.0.0"
---

# Deploy

You ship already-built code to already-provisioned infra. Two paths:

1. **Direct** — run the platform CLI from the local machine (`wrangler deploy`, `vercel --prod`, `ssh && docker compose up -d`). Fast, good for solo/small projects.
2. **CI-driven** — `git push origin main`, let an existing GitHub Actions workflow do the actual deploy. Better for teams, required when secrets live in CI env not local machine.

The skill picks based on what's already configured. If nothing is configured, ask once and remember in `docs/deployment.md`.

## Scope

Covers: shipping to AWS (S3+CloudFront, Elastic Beanstalk, ECS, Amplify), Cloudflare (Pages, Workers), Vercel, VPS via SSH+Docker.

Does NOT cover:
- **Creating cloud resources** (S3 buckets, R2 buckets, IAM roles, VPS Docker install, etc.) → `/devops`
- **Setting up CI/CD workflows** (generating `.github/workflows/*.yml`, wiring secrets) → `/devops`
- Infrastructure provisioning (Terraform/Pulumi), DNS setup, SSL cert issuance, database schema migrations (→ `/db-design`)

If no infra exists or no CI workflow is present and user wants CI mode → stop, point to `/devops`, don't try to provision inline.

## Operating rules

- **Never echo secrets.** API tokens, SSH keys, `.env` values never appear in command output, response, or committed files. If a step needs a secret, reference the env var name, not the value.
- **Never commit `.env`.** Before any deploy command, verify `.env*` is in `.gitignore`. If not, stop and fix first.
- **One deploy = one verified URL.** After deploy, curl the production endpoint and report HTTP status. A "successful" deploy without a working URL is not successful.
- **Write down what you did.** After any new or changed deploy path, update `docs/deployment.md`. Next session should not have to re-detect.
- **Respect user's existing CI.** If `.github/workflows/deploy*.yml` already exists, default to updating it, not replacing.

## Process

### 1 — Detect target

Check in this order, stop at first match:

1. `docs/deployment.md` exists → read platform + config from it
2. Config files in repo:

   | File | Platform |
   |---|---|
   | `wrangler.toml` / `wrangler.jsonc` | Cloudflare Workers / Pages |
   | `vercel.json` or `.vercel/` | Vercel |
   | `Dockerfile` + `docker-compose.yml` | VPS+Docker |
   | `amplify.yml` / `buildspec.yml` | AWS Amplify / CodeBuild |
   | `.ebextensions/` / `Dockerrun.aws.json` | AWS Elastic Beanstalk / ECS |
   | `.github/workflows/deploy*.yml` | CI-driven deploy (read it for platform) |

3. Project type heuristic (only if no config found):

   | Project | Suggest |
   |---|---|
   | Static site / SPA | Cloudflare Pages → Vercel |
   | Next.js / Nuxt with SSR | Vercel → Cloudflare Pages (with `@cloudflare/next-on-pages`) |
   | Worker / edge function | Cloudflare Workers |
   | Node/Python API | VPS+Docker → AWS ECS |
   | Full Docker stack | VPS+Docker |
   | Large AWS-resident system | AWS (ECS/Beanstalk/Amplify depending on shape) |

4. If still ambiguous → `AskUserQuestion` with top 2–3 suggestions.

### 2 — Decide mode: direct vs CI

- `.github/workflows/deploy*.yml` exists → **CI mode** — `git push origin main`, watch the run via `gh run watch`
- User passes `--direct` → skip CI, run platform CLI locally
- Neither file exists and user wants CI → stop, point to `/devops` to set up the workflow first
- Neither and user wants direct → proceed with CLI

### 3 — Pre-deploy safety checks

Always run these before any deploy command:

- [ ] `git status` clean or user explicitly confirmed dirty deploy
- [ ] `.env*` in `.gitignore` (grep `.gitignore`, if missing → stop + fix)
- [ ] No secrets in tracked files — quick `git grep -nE '(AKIA|AIza|sk_live|pk_live|xox[baprs]-|ghp_|ghs_|-----BEGIN .+ PRIVATE KEY)'` → if hits, stop
- [ ] Build passes locally — run the project's build command (`yarn build`, `pnpm build`, whatever's in `package.json`). Broken build never gets deployed.
- [ ] Correct branch — deploy from `main`/`master` unless user confirmed preview env
- [ ] Env vars required by platform are set (Cloudflare: `CLOUDFLARE_API_TOKEN`; Vercel: `VERCEL_TOKEN`; AWS: `AWS_ACCESS_KEY_ID`+`AWS_SECRET_ACCESS_KEY`; VPS: SSH key loaded in agent)

### 4 — Execute per platform

Direct-mode commands. For CI mode, the equivalent steps go into the workflow yml — see §CI templates below.

#### Cloudflare Pages

```bash
# Install wrangler if missing
npm i -g wrangler
# Auth (one-time)
wrangler login
# Deploy static build output
wrangler pages deploy ./dist --project-name <project> --branch main
```

- Output `dist/` path depends on framework — check `package.json` build script
- For Next.js SSR use `@cloudflare/next-on-pages` then `wrangler pages deploy .vercel/output/static`
- Custom domain: `wrangler pages deployment tail` to watch, then add domain in dashboard (or `wrangler pages domain add`)

#### Cloudflare Workers

```bash
# wrangler.toml must exist with name + main + compatibility_date
wrangler deploy
```

- Secrets: `wrangler secret put <KEY>` (interactive) or `--env production` for env-scoped
- Never put secrets in `wrangler.toml` — only non-secret vars
- Verify: `curl https://<name>.<account>.workers.dev/health`

#### Vercel

```bash
npm i -g vercel
vercel link   # one-time, links local dir to Vercel project
vercel --prod # deploys current commit to production
```

- Env vars: `vercel env add <KEY> production` (prompts for value — never pass via CLI arg)
- Framework auto-detected from `package.json`
- Preview deploys: `vercel` without `--prod`

#### AWS

Pick one submode based on existing config:

- **S3 + CloudFront (static)** — `aws s3 sync ./dist s3://<bucket>/ --delete && aws cloudfront create-invalidation --distribution-id <id> --paths "/*"`
- **Elastic Beanstalk** — `eb deploy <env-name>` (requires `.elasticbeanstalk/config.yml`)
- **ECS** — build+push image to ECR, then `aws ecs update-service --cluster <c> --service <s> --force-new-deployment`
- **Amplify** — `amplify publish` (if project was init'd with `amplify init`)

Always use AWS CLI profiles, never hardcode keys. `AWS_PROFILE=<profile> aws …`.

#### VPS + Docker

```bash
# 1. Build + tag image
docker build -t <registry>/<name>:<tag> .
# 2. Push to registry (Docker Hub / GHCR / ECR)
docker push <registry>/<name>:<tag>
# 3. SSH + pull + up
ssh <user>@<host> "cd <deploy-path> && \
  docker compose pull && \
  docker compose up -d && \
  docker compose ps"
# 4. Health check
curl -fsS https://<domain>/health || curl -fsS http://<host>:<port>/health
```

- Tag convention: `:<git-short-sha>` + optionally `:latest`. Never deploy `:latest` without a sha tag too — rollback needs a specific tag.
- Rollback: SSH → edit compose image tag back to previous sha → `docker compose up -d`
- `docker compose` (v2) preferred over legacy `docker-compose`

### 5 — Verify

After any deploy (direct or CI-triggered):

- Curl the production URL, expect 2xx: `curl -fsS -o /dev/null -w "%{http_code}\n" <url>`
- Check platform-specific log stream for errors in the last 2 minutes:
  - CF: `wrangler tail`
  - Vercel: `vercel logs --prod`
  - AWS ECS: `aws logs tail /ecs/<service> --since 2m`
  - VPS: `ssh <host> "docker compose logs --since 2m <service>"`
- If any 5xx / error spike → initiate rollback (don't "wait and see")

### 6 — Update docs

After success, create or update `docs/deployment.md`:

```markdown
# Deployment

## Platform
<Cloudflare Pages | Workers | Vercel | AWS (submode) | VPS+Docker>

## Mode
<direct | ci>

## Production URL
https://<url>

## Deploy command (direct mode)
<command>

## CI workflow (ci mode)
.github/workflows/deploy.yml — triggers on push to main

## Environment variables
- PLATFORM_KEY_NAME — purpose (stored in: local .env / CI secrets / platform dashboard)
- (never list values here)

## Custom domain
<steps if applicable>

## Rollback
<platform-specific steps — exact commands>

## Last verified
YYYY-MM-DD <url> returned 200
```

## CI workflow setup

Writing `.github/workflows/deploy*.yml` is a **one-time infra task** → `/devops`. This skill assumes the workflow already exists. Once set up, deploy via `git push origin main` + `gh run watch` to monitor.

## Anti-patterns

| Smell | Why it's bad |
|---|---|
| "Just add the env var to `wrangler.toml` quickly" | Commits a secret to git. Use `wrangler secret put` instead. |
| Deploying `:latest` without a sha tag | Rollback requires a specific immutable tag. `latest` drifts. |
| `vercel env add` piping the value via `echo` | Value ends up in shell history + CI logs. Use interactive prompt only. |
| Editing `.github/workflows/deploy.yml` on prod branch without testing | YML syntax errors break CI silently until next push. PR the change, test on feature branch. |
| Skipping the curl verify step | "Deploy succeeded" from CLI doesn't mean the site serves 200 — runtime errors happen. |
| Reusing an SSH key across team members for VPS deploy | One leak = everyone compromised. CI uses its own deploy key. |
| Using `AWS_ACCESS_KEY_ID` in GitHub Actions when OIDC is available | Rotating static keys is pain. OIDC is role-assumed per-run. |

## Rollback (memorize these)

- **Cloudflare Pages**: Dashboard → Deployments → previous → "Rollback" — or `wrangler pages deployment list` + `wrangler rollback <id>`
- **Cloudflare Workers**: `wrangler rollback [--message "<reason>"]`
- **Vercel**: `vercel rollback <deployment-url>` or dashboard → Deployments → "Promote to Production"
- **AWS S3+CloudFront**: `aws s3 sync` from a backup prefix (take one before each deploy) + invalidate
- **AWS ECS**: `aws ecs update-service --task-definition <previous-arn>`
- **VPS+Docker**: SSH, change compose `image:` to previous sha, `docker compose up -d`

Record rollback command in `docs/deployment.md` per platform — user should not have to google it under pressure.

## When called by other agents

- `cook` / `plan` may reference deploy in final phase — point to this skill, don't inline deploy steps in the plan
- `setup` may pre-install platform CLIs (wrangler, vercel, aws) — this skill verifies presence, installs only if missing
- `devops` provisions cloud resources + generates CI workflows — deploy runs after devops is done

## Handoff

Deploy is standalone. On completion, report:

- Platform + mode used
- Production URL + verified HTTP status
- Path to updated `docs/deployment.md`
- Any follow-ups (custom domain pending, env var still placeholder, rollback plan gap)

No automatic chain into other skills.
