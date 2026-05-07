# Container registry

Where to push images: Docker Hub, GitHub Container Registry (GHCR), AWS ECR. Pick based on where the deploy target lives + who needs pull access.

## Quick comparison

| Registry | Best for | Auth | Private free? |
|----------|----------|------|---------------|
| **GHCR** (`ghcr.io`) | Repo-coupled images, OSS + private | GH token / OIDC | Yes (unlimited private, public unlimited) |
| **Docker Hub** | Public images, broadest pull reach | Username + token | 1 private repo free; paid for more |
| **AWS ECR** | ECS / EKS / EB / Lambda on AWS | AWS IAM (12h token) | Yes (500 MB/mo free storage) |
| **Cloudflare R2** via OCI | Niche, not a real OCI registry yet | n/a | — |
| **Self-hosted** (`registry:2`) | Air-gapped / on-prem | Basic auth + TLS | Free (you run it) |

Default recommendation: **GHCR** if code is on GitHub — images live next to the repo, same auth model, unlimited private tier.

## GHCR (GitHub Container Registry)

### Login

```bash
# Personal token (classic, scope: write:packages, read:packages)
echo "$GHCR_PAT" | docker login ghcr.io -u <github-user> --password-stdin

# From GH Actions — use GITHUB_TOKEN, no PAT needed
# In workflow:
# - uses: docker/login-action@v3
#   with:
#     registry: ghcr.io
#     username: ${{ github.actor }}
#     password: ${{ secrets.GITHUB_TOKEN }}
```

### Push

```bash
docker tag myapp:local ghcr.io/<owner>/<repo>:${GIT_SHA}
docker tag myapp:local ghcr.io/<owner>/<repo>:latest
docker push ghcr.io/<owner>/<repo>:${GIT_SHA}
docker push ghcr.io/<owner>/<repo>:latest
```

### Visibility

New packages default to **private** inherited from repo. Make public via: `https://github.com/users/<owner>/packages/container/<name>/settings` → Change visibility.

Link package to repo (important — shows in repo sidebar, inherits permissions):
```
Package settings → "Manage Actions access" → Add Repository → pick repo → Role: Write
```

### Retention

Default: keep all versions. For busy repos, set up a retention workflow:

```yaml
# .github/workflows/ghcr-retention.yml
on:
  schedule: [{cron: '0 3 * * 0'}]  # weekly
jobs:
  cleanup:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/delete-package-versions@v5
        with:
          package-name: <repo>
          package-type: container
          min-versions-to-keep: 10
          delete-only-untagged-versions: true
```

## Docker Hub

### Login

```bash
# Use access token, not account password (account password required 2FA, tokens don't)
# Create token: hub.docker.com → Account Settings → Security → New Access Token
echo "$DOCKERHUB_TOKEN" | docker login -u <user> --password-stdin
```

### Push

```bash
docker tag myapp:local <user>/<repo>:${GIT_SHA}
docker push <user>/<repo>:${GIT_SHA}
```

No org prefix for personal account; for org: `<org>/<repo>`.

### Rate limits

Anonymous pulls: 100/6h per IP. Authenticated: 200/6h free, higher on paid. For CI that pulls a lot, always `docker login` even for public images to get the authenticated quota.

## AWS ECR

### Create repo

```bash
aws ecr create-repository \
  --repository-name <name> \
  --image-scanning-configuration scanOnPush=true \
  --image-tag-mutability IMMUTABLE
```

`IMMUTABLE` prevents tag overwrites — better for audit, forces unique tags per deploy. Use `MUTABLE` only if you need `:latest` semantics.

### Login (12h token)

```bash
aws ecr get-login-password --region <region> | \
  docker login --username AWS --password-stdin <account-id>.dkr.ecr.<region>.amazonaws.com
```

In CI, do this every job — token expires fast.

### Push

```bash
REPO=<account-id>.dkr.ecr.<region>.amazonaws.com/<name>
docker tag myapp:local $REPO:${GIT_SHA}
docker push $REPO:${GIT_SHA}
```

### Lifecycle policy (auto-cleanup)

```bash
cat > policy.json <<'EOF'
{
  "rules": [
    {
      "rulePriority": 1,
      "description": "Keep last 30 images",
      "selection": {
        "tagStatus": "any",
        "countType": "imageCountMoreThan",
        "countNumber": 30
      },
      "action": { "type": "expire" }
    }
  ]
}
EOF

aws ecr put-lifecycle-policy \
  --repository-name <name> \
  --lifecycle-policy-text file://policy.json
```

### Cross-account pull

Grant another AWS account pull access:

```bash
aws ecr set-repository-policy --repository-name <name> --policy-text '{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "AWS": "arn:aws:iam::<other-account>:root" },
    "Action": ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"]
  }]
}'
```

## Tagging conventions

**Always tag with a mutable AND immutable reference:**

```bash
GIT_SHA=$(git rev-parse --short HEAD)
VERSION=$(cat package.json | jq -r .version)

# Immutable — exact build, never reused
docker tag app ghcr.io/<o>/<r>:sha-${GIT_SHA}
docker tag app ghcr.io/<o>/<r>:v${VERSION}

# Mutable — what "current" points at; for humans + rolling deploys
docker tag app ghcr.io/<o>/<r>:latest
docker tag app ghcr.io/<o>/<r>:main
```

Deploy target should pin to immutable (`sha-abc123` or `v1.2.3`), not `:latest`. `:latest` is for humans inspecting the registry.

**Bad patterns:**
- Only tagging `:latest` → can't roll back to a specific build
- Re-using version tags (`:v1.2.3` rebuilt without bumping) → breaks cache + audit
- Tagging with branch name only (`:main`) → no way to reference a specific commit

## Image signing (Cosign / Sigstore)

Optional but growing standard. Sign on push, verify on deploy:

```bash
# Install
brew install cosign

# Generate key (once)
cosign generate-key-pair
# Creates cosign.key (gitignore!) + cosign.pub

# Sign after push
cosign sign --key cosign.key ghcr.io/<o>/<r>@sha256:<digest>

# Verify (in deploy script)
cosign verify --key cosign.pub ghcr.io/<o>/<r>:sha-abc123
```

Or keyless via OIDC (GH Actions):
```bash
cosign sign ghcr.io/<o>/<r>@sha256:<digest>  # prompts OIDC flow, no key file
```

## Vulnerability scanning

- **GHCR**: built-in Dependabot alerts on packages
- **Docker Hub**: built-in Snyk scan on push (public only, free tier limited)
- **ECR**: `scanOnPush=true` uses Amazon Inspector / Clair
- **Any**: run `trivy image <ref>` in CI, fail pipeline on HIGH/CRITICAL

```yaml
# In CI, after docker build:
- run: trivy image --exit-code 1 --severity HIGH,CRITICAL <ref>
```

## Self-hosted registry (quick reference)

```yaml
# docker-compose.yml for private registry
services:
  registry:
    image: registry:2
    restart: unless-stopped
    environment:
      REGISTRY_STORAGE_FILESYSTEM_ROOTDIRECTORY: /data
      REGISTRY_AUTH: htpasswd
      REGISTRY_AUTH_HTPASSWD_REALM: Registry
      REGISTRY_AUTH_HTPASSWD_PATH: /auth/htpasswd
    volumes:
      - regdata:/data
      - ./auth:/auth:ro
    ports:
      - "127.0.0.1:5000:5000"   # front with Caddy/Nginx for TLS
volumes:
  regdata:
```

Create auth file:
```bash
docker run --rm --entrypoint htpasswd httpd:2 -Bbn <user> <pass> > auth/htpasswd
```

Front with Caddy for TLS (`registry.example.com { reverse_proxy localhost:5000 }`) — Docker clients refuse plain HTTP unless explicitly allowed in `daemon.json`.

## Common gotchas

- GHCR image set to private + forgetting to link it to the repo → CI in another repo can't pull even with token
- ECR token expires in 12h → re-login every job in CI; don't cache across days
- Docker Hub anon rate limit hits CI around the 100th pull → always `docker login` even for public base images
- Pushing `:latest` only means "no rollback target" → always push an immutable tag too
- `IMMUTABLE` tag mutability on ECR + `:latest` + rebuilds → second push fails. Either use `MUTABLE` or drop `:latest` on ECR (tag immutably only)
- Cross-region pull in AWS — latency + data egress. Put ECR in same region as ECS/EKS
- Forgetting to gitignore `cosign.key` → private signing key in repo, attacker can sign malicious images
