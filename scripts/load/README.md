# Gbox Platform — k6 Load Tests (Phase 8.4)

Three k6 scripts that lock down the perf SLOs for the storefront +
checkout funnel + asset pipeline. Each script is fully self-contained
— no shared modules, no fixture loaders — so they run from a vanilla
k6 install:

```sh
# Install k6 (one of):
brew install k6                    # macOS
choco install k6                   # Windows
sudo apt-get install k6            # Debian/Ubuntu (after k6 apt repo)

# Run a smoke test:
k6 run scripts/load/storefront-browse.js
```

## What lives here

| Script | What it exercises | Tightest SLO |
|---|---|---|
| `storefront-browse.js` | `/`, `/collections/<h>`, `/products/<h>` | p95 home < 200ms |
| `checkout-flow.js`     | product → cart → checkout begin → render | 0 5xx, p95 begin < 400ms |
| `assets-cdn.js`        | `/assets/*` cache + revalidate + 404 no-store | revalidate hit rate > 95% |
| `target-100k.js`       | Realistic 50:1 browse-to-checkout mix calibrated to 100,000 orders/month | Browse p95 < 300ms + checkout p95 < 500ms + 0 checkout errors (Phase 3E) |
| `target-scale.js`      | Same 50:1 shape as `target-100k.js` but tier-aware — retargets at 100k / 1M / 10M orders/month via `TIER=` | Same SLOs at every tier (Phase 3F) |

### Scaling tiers (`target-scale.js`)

| `TIER` | Orders/month | Flash browse VUs | Flash checkout VUs | Safe to run from |
|---|---|---|---|---|
| `100k` (default) | 100,000 | ~965 | ~20 | Dev laptop |
| `1m`  | 1,000,000 | ~9,645 | ~193 | LAN-attached server |
| `10m` | 10,000,000 | ~96,450 | ~1,930 | Distributed k6 runner only |

The VU counts come from `packages/core/src/modules/scaling/tiers.ts`
(single source of truth — the load script mirrors the math so it can
run from a vanilla k6 install with no imports). Every tier uses the
same 2% conversion rate and 50:1 browse:checkout ratio so the results
are directly comparable.

**Do not run `TIER=10m PROFILE=flash` from a single machine.** A single
k6 process hits file-descriptor / ephemeral-port limits long before it
can emit ~100,000 concurrent browse VUs. The 10m tier is the stack's
_design target_, not a push-button smoke test — run it against a k6
Operator cluster or skip it and rely on 1m + capacity math.

For the end-to-end "can this build hit the scaling target" gate, use
the runner script which chains all four scripts together and prints
a unified PASS / FAIL summary:

```sh
# Smoke (safe from a laptop, ~3 minutes total, default tier = 100k)
./scripts/load/run-100k-target.sh

# Peak-hour simulation against the test box (still 100k tier)
./scripts/load/run-100k-target.sh peak http://192.168.1.13:4326 demo.gbox.co

# 1M-orders/month baseline — run from server, not laptop
TIER=1m ./scripts/load/run-100k-target.sh baseline http://192.168.1.13:4326 demo.gbox.co

# Flash-sale / TikTok burst at the 1M tier (~9600 concurrent browse VUs)
TIER=1m \
PRODUCT_HANDLES=tee-black,tee-white,hoodie-grey \
COLLECTION_HANDLES=all,sale,new-arrivals \
VARIANT_IDS=v1,v2,v3 \
./scripts/load/run-100k-target.sh flash http://192.168.1.13:4326 demo.gbox.co
```

Exit code is 0 only if every k6 run passed its thresholds — wire
it straight into a deploy gate the same way the individual smoke
scripts already are.

Pure k6 JavaScript. No vitest, no TypeScript — k6's runtime is its own
JS VM (goja), so importing platform code would just bloat the script.

## Scenarios

Each script ships several pre-baked scenarios. Pick one with
`-e SCENARIO=<name>`:

| Scenario | Use it for | Profile |
|---|---|---|
| `smoke`   | Sanity check, runs on a laptop | 1–2 VUs, 20–30s |
| `average` | Daily perf baseline (browse) | 50 VUs, 5min |
| `peak`    | Realistic high-traffic merchant (checkout) | 30 VUs, 5min |
| `stress`  | Find the breaking point (browse) | 0 → 500 VUs over 10min |
| `spike`   | Flash sale / TikTok burst (checkout) | 5 → 200 VUs in 30s |
| `soak`    | Slow-leak hunting (browse) | 100 VUs, 30min |
| `cdn`     | CDN edge exercise (assets) | 100 VUs, 4min |

## Configuration via env vars

All three scripts read the same env vars so they can hit any environment:

| Env var | Default | Notes |
|---|---|---|
| `BASE_URL` | `http://localhost:4326` | Storefront origin or CDN URL |
| `SHOP_HOST` | `demo.gbox.co` | Sent as `X-Forwarded-Host` + `Host` for tenant routing |
| `PRODUCT_HANDLES` | `sample-product` | Comma-separated, picked at random per iteration |
| `COLLECTION_HANDLES` | `all` | Browse script only |
| `VARIANT_IDS` | `v1` | Checkout script only |
| `ASSETS` | `theme.css,theme.js,fonts/inter.woff2,logo.svg,gbox-dawn/assets/cart.js` | Assets script only |

Example — point a stress run at the test box (192.168.1.13) with the
real Gbox Dawn handles:

```sh
k6 run \
  -e SCENARIO=stress \
  -e BASE_URL=http://192.168.1.13:4326 \
  -e SHOP_HOST=demo.gbox.co \
  -e PRODUCT_HANDLES=tee-black,tee-white,hoodie-grey \
  -e COLLECTION_HANDLES=all,sale,new-arrivals \
  scripts/load/storefront-browse.js
```

## SLOs (locked into `thresholds`)

These are enforced — k6 exits non-zero if any threshold is breached,
so the scripts plug straight into a CI gate.

### Storefront browse

- p95 across all routes < 300ms
- p99 across all routes < 800ms
- p95 home < 200ms (Phase 8.1 cache should make this trivial)
- p95 collection < 400ms
- p95 product < 500ms
- < 1% requests fail
- < 1% checks fail

### Checkout flow

- p99 across all steps < 1s
- 0 5xx (zero tolerance — checkout 5xx = revenue incident)
- p95 cart-add < 250ms
- p95 checkout-begin < 400ms
- p95 checkout-render < 500ms
- at least 1 funnel completes per scenario

### Assets / CDN

- p95 200 < 100ms (origin) / < 25ms (behind CDN)
- p95 304 < 30ms / < 10ms behind CDN
- revalidate hit rate > 95% (proves Phase 8.3 ETag plumbing works)
- < 0.1% requests fail

## Running against the test box

The test box at `192.168.1.13` is documented in
`memory/infra_topology.md`. Smoke is safe from anywhere; anything
heavier should be run **on the same LAN** (loopback or wired) so the
metrics aren't dominated by laptop wifi.

```sh
# Smoke from a laptop — fine over wifi
k6 run -e BASE_URL=http://192.168.1.13:4326 scripts/load/storefront-browse.js

# Stress / peak / spike — SSH into server 2 first
ssh gbox@192.168.1.14
k6 run -e SCENARIO=peak \
       -e BASE_URL=http://192.168.1.13:4326 \
       scripts/load/checkout-flow.js
```

## CI gating

The smoke variant of every script is meant to plug into the
deploy pipeline as a hard gate (Phase 6.5 already does this for
HTTP probes; this is the perf-budget equivalent):

```sh
k6 run --quiet -e SCENARIO=smoke scripts/load/storefront-browse.js && \
k6 run --quiet -e SCENARIO=smoke scripts/load/checkout-flow.js && \
k6 run --quiet -e SCENARIO=smoke scripts/load/assets-cdn.js
```

Any threshold breach → non-zero exit → deploy aborts.

## Adding new scripts

Convention:

1. One file per perf-isolated path. Don't bundle browse + checkout
   into one script — you can't pick the SLOs apart in the summary.
2. SLOs go in the `thresholds` block, not in `check()` calls. k6
   enforces them and prints a clear FAIL row in the summary.
3. Custom metric names use `snake_case` so they don't collide with
   k6's built-in `http_req_*` namespace.
4. Every script exposes the same `BASE_URL` / `SHOP_HOST` env vars so
   the runbook stays uniform.
5. No external imports (`import 'k6/...'` only). k6's goja runtime is
   not Node.
