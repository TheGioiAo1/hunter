# Docker Compose

Compose v2 (`docker compose`, not hyphenated `docker-compose`). Target file: `docker-compose.yml` (+ optional `docker-compose.override.yml` for local dev).

## Core rules

1. **No version key.** Compose v2 ignores `version: '3.x'` — remove it, saves a lint warning.
2. **Named volumes over bind mounts** for data. Bind mounts bind host paths; portable compose uses named volumes.
3. **Explicit networks** when multi-service. Default network works but naming is clearer for debugging.
4. **Healthchecks + `depends_on: condition: service_healthy`** so startup order actually waits.
5. **`.env` file, not committed.** Reference vars with `${VAR}`. Commit `.env.example`.
6. **`restart: unless-stopped`** for production services. `always` is too aggressive (won't stop on manual `docker stop`), `no` is silent failure.
7. **Resource limits** even on single-host. One runaway service can OOM the box.

## Template: web app + Postgres + Redis

```yaml
services:
  app:
    image: ghcr.io/<owner>/<repo>:${IMAGE_TAG:-latest}
    restart: unless-stopped
    env_file: .env
    environment:
      DATABASE_URL: postgres://app:${POSTGRES_PASSWORD}@db:5432/app
      REDIS_URL: redis://cache:6379
    depends_on:
      db:
        condition: service_healthy
      cache:
        condition: service_healthy
    ports:
      - "127.0.0.1:3000:3000"    # bind to localhost — expose via reverse proxy
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:3000/health"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s
    deploy:
      resources:
        limits:
          cpus: '1.0'
          memory: 512M
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "5"

  db:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: app
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: app
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./backups:/backups     # for pg_dump output
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U app"]
      interval: 10s
      timeout: 3s
      retries: 5

  cache:
    image: redis:7-alpine
    restart: unless-stopped
    command: ["redis-server", "--appendonly", "yes", "--maxmemory", "256mb", "--maxmemory-policy", "allkeys-lru"]
    volumes:
      - redisdata:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 3s
      retries: 5

volumes:
  pgdata:
  redisdata:

networks:
  default:
    name: app-net
```

## Env var sourcing

Compose reads `.env` in the same dir as the compose file (by default). Override per-env:

```bash
# Prod file
docker compose --env-file .env.production up -d

# Override compose file (merged on top of base)
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

`${VAR}` substitution happens at compose file parse time — not inside containers. For in-container env vars, use `environment:` or `env_file:`.

## Local dev override pattern

`docker-compose.override.yml` (auto-merged on `docker compose up`, **don't commit** if it includes host-specific paths):

```yaml
services:
  app:
    build: .                      # build locally instead of pulling
    volumes:
      - .:/app
      - /app/node_modules         # preserve container's node_modules
    command: ["yarn", "dev"]      # hot reload
    environment:
      NODE_ENV: development
```

CI / prod: `docker compose -f docker-compose.yml up -d` (ignore override).

## Secrets (Compose v2 supports)

```yaml
services:
  app:
    image: <img>
    secrets:
      - db_password

secrets:
  db_password:
    file: ./secrets/db_password.txt     # gitignored
    # OR
    # external: true                    # Docker Swarm managed
```

Inside container: `/run/secrets/db_password` file. Not in env.

## Useful commands

```bash
# Start + background
docker compose up -d

# Rebuild (e.g. after Dockerfile change)
docker compose up -d --build

# Pull new images, recreate only changed
docker compose pull && docker compose up -d

# Logs (follow, last 100 lines)
docker compose logs -f --tail=100 <service>

# Shell into a running container
docker compose exec <service> sh

# Run a one-off command (fresh container, removed after)
docker compose run --rm <service> <command>

# Stop + remove (volumes stay)
docker compose down

# Nuke volumes too (⚠ data loss)
docker compose down -v

# Service status + ports
docker compose ps
```

## Backups — db dump example

Cron on the host:

```bash
0 3 * * * docker compose -f /srv/app/docker-compose.yml exec -T db \
  pg_dump -U app app | gzip > /srv/backups/app-$(date +\%F).sql.gz
```

`-T` disables TTY allocation (needed for cron). `-f` for explicit path.

## Common gotchas

- `depends_on` without `condition: service_healthy` only waits for *start*, not *ready*. A postgres container is "started" in milliseconds; "ready" takes seconds.
- `ports: "3000:3000"` binds to `0.0.0.0` — exposed to the internet on a VPS. Always prefer `127.0.0.1:3000:3000` + reverse proxy unless you know why.
- Named volumes persist across `down` (not `down -v`). Don't `-v` in prod muscle memory.
- `version: '3.x'` legacy key: still parsed by v2, but emits deprecation warning. Delete it.
- Environment variables in `environment:` take precedence over `env_file:`. Know your override order.
- `restart: always` + broken container = infinite restart loop eating CPU. Prefer `unless-stopped` with a healthcheck.
- `docker compose up` (no `-d`) streams logs but Ctrl+C stops the stack. In SSH session → don't; always `-d`.
