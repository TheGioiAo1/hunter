# Docker image (Dockerfile conventions)

What goes into a production-grade Dockerfile. Read this before writing one from scratch or reviewing an existing one.

## Core rules

1. **Pin versions.** `FROM node:20.12.2-alpine`, not `FROM node` or `FROM node:20`. Major reproducibility win.
2. **Multi-stage.** Build dependencies in one stage, copy only artifacts to the final stage. Final image should have no compilers, no dev deps.
3. **Non-root user.** `USER` directive before `CMD`. Alpine: create a user explicitly; Debian-slim: use `1000` or `node` / `nobody`.
4. **`.dockerignore` exists** and at minimum ignores `.git`, `node_modules`, `.env*`, `dist`, `build`, `*.log`, `.DS_Store`.
5. **Order layers for cache.** Install deps before copying source. Rebuild only breaks deps layer when `package.json` / `yarn.lock` changes.
6. **No secrets in image.** Never `COPY .env`, never `ARG TOKEN=...`. Use `--secret` mount for BuildKit or runtime env vars.
7. **Healthcheck** when the process doesn't exit on failure. Let the orchestrator know.

## Template: Node.js / TypeScript

```Dockerfile
# syntax=docker/dockerfile:1.7
ARG NODE_VERSION=20.12.2

# --- deps ---
FROM node:${NODE_VERSION}-alpine AS deps
WORKDIR /app
COPY package.json yarn.lock ./
RUN --mount=type=cache,target=/usr/local/share/.cache/yarn \
    yarn install --frozen-lockfile

# --- build ---
FROM node:${NODE_VERSION}-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN yarn build
# Prune dev deps for runtime copy
RUN yarn install --production --frozen-lockfile --ignore-scripts --prefer-offline

# --- runtime ---
FROM node:${NODE_VERSION}-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Create non-root user
RUN addgroup -g 1001 -S app && adduser -u 1001 -S app -G app
COPY --from=build --chown=app:app /app/dist ./dist
COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/package.json ./package.json
USER app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1
CMD ["node", "dist/main.js"]
```

## Template: Python (Poetry)

```Dockerfile
# syntax=docker/dockerfile:1.7
ARG PYTHON_VERSION=3.12-slim

FROM python:${PYTHON_VERSION} AS build
WORKDIR /app
ENV POETRY_VERSION=1.8.3 \
    POETRY_HOME=/opt/poetry \
    POETRY_VIRTUALENVS_CREATE=false
RUN pip install --no-cache-dir "poetry==${POETRY_VERSION}"
COPY pyproject.toml poetry.lock ./
RUN poetry install --only main --no-root
COPY . .

FROM python:${PYTHON_VERSION} AS runtime
WORKDIR /app
RUN useradd -u 1001 -m app
COPY --from=build /usr/local/lib/python3.12/site-packages /usr/local/lib/python3.12/site-packages
COPY --from=build /app /app
USER app
EXPOSE 8000
CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
```

## Template: Go (static binary)

Produces a scratch image, often < 20 MB.

```Dockerfile
# syntax=docker/dockerfile:1.7
FROM golang:1.22-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /out/app ./cmd/app

FROM gcr.io/distroless/static-debian12 AS runtime
COPY --from=build /out/app /app
USER nonroot:nonroot
EXPOSE 8080
ENTRYPOINT ["/app"]
```

## `.dockerignore`

```
# VCS
.git
.gitignore

# Local env
.env
.env.*
!.env.example

# Deps (will be reinstalled inside container)
node_modules
.venv
__pycache__
*.pyc

# Build output
dist
build
out
.next
.nuxt
coverage

# IDE / OS
.vscode
.idea
.DS_Store
Thumbs.db

# Logs
*.log
npm-debug.log*
yarn-debug.log*
yarn-error.log*
```

## Image size reduction checklist

- [ ] Multi-stage: compile artifacts in one stage, copy to slim runtime
- [ ] Base image: `alpine`, `slim`, or `distroless` for runtime — not full `ubuntu`
- [ ] Prune dev deps before copying to runtime (`yarn install --production`)
- [ ] No package manager cache: `--no-cache` (apk), `--no-cache-dir` (pip), `--mount=type=cache` (BuildKit) for yarn/npm
- [ ] `.dockerignore` excludes `node_modules`, `.git`, build output
- [ ] Single `RUN` chain for `apt install` + `rm -rf /var/lib/apt/lists/*` — one layer
- [ ] Don't install tools you only needed at build (curl, git) into the runtime stage
- [ ] `docker images | grep <name>` — check size, aim: < 200 MB for Node, < 150 MB for Python, < 50 MB for Go

## Secrets at build time (BuildKit)

```Dockerfile
# syntax=docker/dockerfile:1.7
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc \
    npm ci
```

Build with:

```bash
DOCKER_BUILDKIT=1 docker build \
  --secret id=npmrc,src=$HOME/.npmrc \
  -t <img> .
```

Secret file is available during that one RUN, not baked into the image.

## Multi-arch builds (amd64 + arm64)

```bash
docker buildx create --use --name multi
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  --tag <registry>/<name>:<tag> \
  --push \
  .
```

Required for Apple Silicon dev + x86 server. Use `--push` (not `--load`) with multi-platform.

## Scanning + signing

- **Scan:** `docker scout cves <img>` or `trivy image <img>` — catch known CVEs
- **SBOM:** `docker buildx build --sbom=true ...` generates SPDX SBOM
- **Sign:** `cosign sign <registry>/<name>:<tag>` (Sigstore) for supply chain trust

## Common gotchas

- Alpine uses `musl` libc — some Node native modules (bcrypt, sharp) break. Switch to `-slim` Debian variant if issues.
- `ADD` vs `COPY`: always use `COPY`. `ADD` has magic behavior (tar extract, URL fetch) that surprises people.
- Building on M1/M2 Mac, deploying to x86 server → image silently runs slowly or fails. Use `buildx --platform linux/amd64`.
- `CMD ["sh", "-c", "node dist/main.js"]` = shell form, PID 1 is sh, signals don't propagate to Node. Use exec form: `CMD ["node", "dist/main.js"]`.
- `ENV NODE_OPTIONS=--max-old-space-size=2048` for Node apps in containers with known memory caps — otherwise Node thinks it has host memory.
