# CI/CD pipelines

GitHub Actions workflow templates per deploy target. Copy, adapt, commit to `.github/workflows/`.

## Core rules

1. **OIDC over static keys** when the cloud supports it (AWS, GCP, Azure). No long-lived secrets in repo.
2. **Pin action versions** (`@v4`, not `@main`) — supply chain attack surface.
3. **Least-privilege secrets.** Scope tokens to one repo + minimum permissions.
4. **Matrix only when needed.** Don't parallelize trivial jobs — each runner is ~20s overhead.
5. **`concurrency` group** to cancel in-flight runs on push (prevent duplicate deploys).
6. **One workflow per target** (deploy-prod.yml, deploy-staging.yml) — easier to reason about than branching inside a single file.

## Workflow skeleton

```yaml
name: Deploy
on:
  push:
    branches: [main]
  workflow_dispatch:      # manual trigger button in Actions tab

concurrency:
  group: deploy-${{ github.ref }}
  cancel-in-progress: true

permissions:
  contents: read
  id-token: write         # required for OIDC
  packages: write         # required for GHCR push

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: production   # enables env secrets + approval gates
    steps:
      - uses: actions/checkout@v4
      # ...
```

## Cloudflare Pages (wrangler)

```yaml
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: yarn
      - run: yarn install --frozen-lockfile
      - run: yarn build
      - uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          command: pages deploy ./dist --project-name=<name>
```

Token scope: Pages:Edit + Account Read. See `cloudflare.md` for token creation.

## Cloudflare Workers

```yaml
      - uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          command: deploy
```

Secrets (runtime env) set via `wrangler secret put` once, not per deploy.

## Vercel

```yaml
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm i -g vercel
      - name: Pull Vercel env
        run: vercel pull --yes --environment=production --token=${{ secrets.VERCEL_TOKEN }}
      - name: Build
        run: vercel build --prod --token=${{ secrets.VERCEL_TOKEN }}
      - name: Deploy
        run: vercel deploy --prebuilt --prod --token=${{ secrets.VERCEL_TOKEN }}
```

Needs `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID` in secrets. See `vercel.md`.

Note: if using Vercel's GH integration (auto-deploy on push), this workflow is redundant — pick one.

## AWS S3 + CloudFront (OIDC)

```yaml
permissions:
  id-token: write
  contents: read

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::<account-id>:role/GitHubActionsDeploy
          aws-region: ap-southeast-1
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: yarn }
      - run: yarn install --frozen-lockfile
      - run: yarn build
      - name: Sync to S3
        run: aws s3 sync ./dist s3://<bucket>/ --delete
      - name: Invalidate CloudFront
        run: |
          aws cloudfront create-invalidation \
            --distribution-id ${{ secrets.CF_DIST_ID }} \
            --paths "/*"
```

IAM role trust policy + least-priv deploy policy: see `aws.md`. No `AWS_ACCESS_KEY_ID` secret needed.

## AWS ECS (Docker image)

```yaml
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::<id>:role/GitHubActionsDeploy
          aws-region: ap-southeast-1
      - uses: aws-actions/amazon-ecr-login@v2
        id: ecr
      - name: Build + push
        env:
          REG: ${{ steps.ecr.outputs.registry }}
        run: |
          IMG=$REG/<repo>:${{ github.sha }}
          docker build -t $IMG .
          docker push $IMG
          echo "IMAGE=$IMG" >> $GITHUB_ENV
      - name: Update ECS service
        run: |
          aws ecs update-service \
            --cluster <cluster> --service <service> \
            --force-new-deployment
```

For full blue/green, use `aws-actions/amazon-ecs-deploy-task-definition@v2` + render task def.

## VPS (SSH + docker compose)

```yaml
jobs:
  build:
    runs-on: ubuntu-latest
    permissions: { packages: write, contents: read }
    steps:
      - uses: actions/checkout@v4
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - uses: docker/setup-buildx-action@v3
      - uses: docker/build-push-action@v5
        with:
          push: true
          tags: |
            ghcr.io/${{ github.repository }}:latest
            ghcr.io/${{ github.repository }}:sha-${{ github.sha }}
          cache-from: type=gha
          cache-to: type=gha,mode=max

  deploy:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - uses: appleboy/ssh-action@v1.0.3
        with:
          host: ${{ secrets.VPS_HOST }}
          username: ${{ secrets.VPS_USER }}
          key: ${{ secrets.VPS_SSH_KEY }}
          script: |
            cd /srv/app
            echo "${{ secrets.GITHUB_TOKEN }}" | docker login ghcr.io -u ${{ github.actor }} --password-stdin
            docker compose pull
            docker compose up -d
            docker system prune -af
```

Secrets: `VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY` (private key content, not path). SSH key must be in `~/.ssh/authorized_keys` on VPS.

## Build + test gate (pre-deploy)

Every deploy workflow should `needs:` a build/test job. Don't ship red code:

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: yarn }
      - run: yarn install --frozen-lockfile
      - run: yarn lint
      - run: yarn test --coverage
      - run: yarn build

  deploy:
    needs: test     # won't run if test fails
    # ...
```

## Environment protection rules (manual approval)

Dashboard → Settings → Environments → `production` → Required reviewers + wait timer. Workflow references via `environment: production` — Actions UI shows approval button before the job runs.

Use for production deploys where human sign-off is required.

## Reusable workflows (DRY across repos)

```yaml
# .github/workflows/_deploy-cloudflare.yml (in shared repo <org>/.github-workflows)
on:
  workflow_call:
    inputs:
      project:
        required: true
        type: string
    secrets:
      CF_API_TOKEN: { required: true }
jobs:
  deploy:
    # ...

# Caller:
jobs:
  deploy:
    uses: <org>/.github-workflows/.github/workflows/_deploy-cloudflare.yml@main
    with:
      project: my-site
    secrets:
      CF_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
```

Central workflow updates propagate to all callers. Good for orgs with 10+ repos deploying similarly.

## Dependabot for actions

`.github/dependabot.yml`:

```yaml
version: 2
updates:
  - package-ecosystem: github-actions
    directory: /
    schedule: { interval: weekly }
```

Keeps action versions current. Plus `npm` / `pip` / `docker` ecosystems for app deps.

## Common gotchas

- `GITHUB_TOKEN` has repo-scoped default perms — if pushing to GHCR, explicitly add `permissions: packages: write`
- OIDC role trust policy with `StringEquals repo:<owner>/<repo>:ref:refs/heads/main` is too strict (blocks PR runs). Use `StringLike ...:*` or enumerate refs
- `concurrency: cancel-in-progress: true` with a deploy job can cancel mid-deploy → partial state. Only cancel on feature branches, not on `main` deploy
- Reusable workflow called from a fork won't have access to secrets by default — GH blocks it for safety
- Storing prod secrets in `secrets` (repo-wide) leaks them to PR workflows from forks if `pull_request_target` is used. Prefer `environment`-scoped secrets (only released to jobs referencing that environment)
- `docker/build-push-action@v5` with `cache-from: type=gha` eats free cache (10 GB/repo). Prune or pin a `scope` per workflow
- Deploy succeeds but the site is stale → CloudFront / CF / Vercel edge cache. Always invalidate or wait out TTL
