---
name: devops
description: "Provision cloud infrastructure and CI/CD pipelines — the one-time / occasional setup tasks that make /deploy work. Covers AWS (S3/CloudFront/IAM/OIDC/ECR), Cloudflare (R2/D1/KV/Workers/Pages), Vercel, VPS bootstrap (Docker + Nginx/Caddy + Let's Encrypt), container workflows (Dockerfile / Compose / registries), GitHub Actions workflow generation, and Kubernetes (manifests, Helm, RBAC) for pro setups. Standalone."
license: MIT
argument-hint: "[area] — aws | cloudflare | vercel | vps | docker | compose | ci | k8s"
metadata:
  author: claudex-kit
  version: "1.0.0"
---

# DevOps

Setting up the runway so `/deploy` can actually take off. You do this once (or rarely) per project/environment — create the S3 bucket, mint the IAM role, write the GitHub Actions workflow, install Docker on a fresh VPS, write the K8s manifests. Then `/deploy` uses what you built.

Scope is intentionally broad because the same person setting up AWS today might want K8s next month. Each section below is tight in the main file; deep dives live in `references/`.

## Scope

| Area | Tasks |
|---|---|
| **AWS** | S3 bucket + CloudFront distribution + OAC, IAM roles, OIDC trust for GH Actions, ECR repo, Elastic Beanstalk env, ECS cluster/service/task def |
| **Cloudflare** | R2 bucket, D1 database, KV namespace, Workers project init, Pages project, custom domain bindings |
| **Vercel** | Project create + link, env var upload, domain assignment |
| **VPS bootstrap** | Install Docker + Compose v2, deploy user, SSH deploy key, registry auth, Nginx or Caddy reverse proxy + Let's Encrypt |
| **Docker** | Dockerfile conventions, multi-stage builds, image size optimization, base image choice, layer caching |
| **Docker Compose** | Service layout, env files, volumes, networks, healthchecks, depends_on condition |
| **Container registry** | Docker Hub vs GHCR vs ECR — auth, tagging conventions, retention policy |
| **CI/CD pipelines** | Generate `.github/workflows/deploy-*.yml` per platform, secrets checklist, OIDC setup |
| **Kubernetes** | Manifests (Deployment, Service, Ingress, ConfigMap, Secret), kubectl/Helm basics, RBAC, namespaces, resource requests/limits, probes |

Does NOT cover: shipping a release (→ `/deploy`), local dev env (→ `/setup`), DB schema (→ `/db-design`).

## Operating rules

- **Never commit secrets.** Tokens, keys, `.env` values live in platform secret stores or GH Actions secrets — never in files. Skill pre-checks `.gitignore` before any provisioning step.
- **OIDC over static keys.** For any GH Actions ↔ cloud auth (AWS, GCP, Azure), prefer OIDC federation. Static access keys are a rotation liability.
- **Least privilege.** IAM policies and K8s RBAC start narrow. Grant exactly what the workflow needs, nothing extra. "Admin" or "PowerUser" roles for CI are a red flag.
- **Idempotent where possible.** Re-running a provisioning step should not break things. Check "exists?" before "create" — `aws s3api head-bucket`, `wrangler r2 bucket list`, etc.
- **Document everything in `docs/infrastructure.md`.** Every bucket name, role ARN, domain, workflow file — written down. Next session or teammate should not have to rediscover.
- **No inline deploy.** This skill creates infra and pipelines. It does NOT ship a release. If user asks to "just deploy after", hand off to `/deploy`.

## Process

### 1 — Detect current state

Before provisioning anything:

- Read `docs/infrastructure.md` if it exists → know what's already set up
- Check for config files in repo: `wrangler.toml`, `vercel.json`, `.elasticbeanstalk/config.yml`, `Dockerfile`, `docker-compose.yml`, `.github/workflows/*.yml`, K8s manifests in `k8s/` or `deploy/`
- Ask user which area they want to tackle (use `AskUserQuestion` if ambiguous — don't set up everything at once)

### 2 — Plan resources

List the resources that need creating, in order of dependency. Example for "set up AWS static hosting with CI":

1. S3 bucket (name, region, public-access block)
2. CloudFront distribution (origin = S3, OAC, cache policy)
3. GitHub OIDC identity provider in AWS (once per AWS account)
4. IAM role assumable by the repo's workflows (trust policy)
5. IAM policy granting `s3:PutObject` on the bucket + `cloudfront:CreateInvalidation` on the dist
6. `.github/workflows/deploy.yml` with OIDC auth

Present the list to user before creating anything. If 10+ resources, save the plan to `plans/infra-<slug>.md` first.

### 3 — Execute per area

Load the matching `references/<area>.md` file and follow its commands. Each reference file is self-contained.

| Area | Reference |
|---|---|
| AWS | `references/aws.md` |
| Cloudflare | `references/cloudflare.md` |
| Vercel | `references/vercel.md` |
| VPS bootstrap | `references/vps-bootstrap.md` |
| Docker image | `references/docker.md` |
| Docker Compose | `references/docker-compose.md` |
| Container registry | `references/container-registry.md` |
| CI/CD workflows | `references/ci-cd.md` |
| Kubernetes | `references/kubernetes.md` |

### 4 — Verify

Don't claim "provisioned" until verified:

- **AWS**: `aws s3 ls s3://<bucket>` returns; `aws iam get-role --role-name <role>` shows trust policy
- **Cloudflare**: `wrangler r2 bucket list` / `wrangler d1 list` / `wrangler deployments list`
- **Vercel**: `vercel inspect <project>`
- **VPS**: SSH in, `docker version`, `docker compose version`, test pull from registry
- **CI workflow**: trigger via `gh workflow run <file>` (or push test commit) and watch `gh run watch`
- **K8s**: `kubectl get deployment/service/ingress`, pods actually Running (not CrashLoopBackOff)

### 5 — Document

Append to `docs/infrastructure.md`. Template in `references/infra-doc-template.md`. Minimum:

```markdown
# Infrastructure

## Cloud accounts
- AWS account: <account-id>, region: <region>
- Cloudflare account: <account-id>

## Resources
### AWS
- S3 bucket: <name> — purpose: static site hosting
- CloudFront dist: <id> — domain: <domain>
- IAM role (CI): <arn> — used by `.github/workflows/deploy.yml`

### Cloudflare
- R2 bucket: <name> — purpose: user uploads
- D1 database: <name> / <db-id>

## CI/CD
- `.github/workflows/deploy.yml` — triggers on push to main, deploys to S3
- Secrets required: AWS_DEPLOY_ROLE_ARN, (etc.)
- Vars required: AWS_REGION, S3_BUCKET

## VPS
- Host: <ip-or-domain>
- Deploy user: <user>
- Compose path: /srv/app
- Registry: ghcr.io/<org>/<repo>
- Reverse proxy: Caddy — /etc/caddy/Caddyfile
```

## Anti-patterns

| Smell | Why it's bad |
|---|---|
| Creating an IAM "PowerUserAccess" role for a static-site deploy | Grants way more than `s3:PutObject` + CF invalidation. One leaked OIDC token = nuked account. |
| Putting `CLOUDFLARE_API_TOKEN` in `wrangler.toml` | Commits secret. Always use `wrangler secret put` or CI secret store. |
| Hand-writing the `trust-policy.json` without the `token.actions.githubusercontent.com:sub` condition | Any GitHub repo in the world can then assume the role. Always scope by `repo:<owner>/<name>:*`. |
| Using `:latest` as the only image tag | Rollback needs a specific immutable tag. Always tag with `:<git-sha>` too. |
| `FROM node` (no tag) in Dockerfile | Non-reproducible. Pin to `node:20.12.2-alpine` or similar. |
| `docker compose up` without healthchecks | One broken service starts silently, `depends_on: service_healthy` cannot work. |
| Running K8s pods as root | Escalation path. Set `securityContext.runAsNonRoot: true` + `runAsUser: 1000`. |
| K8s `resources: {}` (no requests/limits) | Node can OOM, scheduler can't pack pods well. Always set at least requests. |
| Letting Dockerfile COPY the entire repo (including `.git`, `node_modules`) | Fat image + leaks history. Use `.dockerignore`. |

## When called by other agents

- `setup` may need to install Docker / wrangler / vercel / aws CLI — use this skill's `vps-bootstrap.md` for Docker install commands; `setup` handles the local machine side
- `deploy` may stop and hand off here if required infra or `.github/workflows/` is missing
- `plan` / `cook` can reference this for the "infra phase" of a new feature that needs new buckets / queues / services

## Handoff

Standalone — no auto-chain. On completion, report:

- Resources provisioned (with names / ARNs / IDs)
- Secrets the user must add to GitHub Actions (values NOT in response — only names)
- Path to updated `docs/infrastructure.md`
- Next step (usually: "`/deploy` is now unblocked, or push to main to trigger CI")

If user intended to ship a release right after provisioning, point them to `/deploy` — do not deploy inline.
