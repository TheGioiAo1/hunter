# Phase B — CDN / Media Pipeline Infra Deploy

Spec: `docs/superpowers/specs/2026-04-18-shopify-parity-s3-media-pipeline.md`.

Phase B shipped the **code** for the S3 + imgproxy + Cloudflare Worker
pipeline. This runbook is the manual infra shopping list that still needs
to be executed by hand against AWS + Cloudflare before any of that code
takes effect in production. Everything here is Thai-only (credentials,
DNS, billing).

## TL;DR — what this repo already ships

| Layer | Status | Location |
|---|---|---|
| `S3Store` driver (put/get/delete/has/signedUrl/signedPutUrl) | ✅ code-ready | `packages/core/src/modules/storage/s3-store.ts` |
| Multi-bucket factory (`getPublicMediaStore`, etc.) | ✅ code-ready | `packages/core/src/modules/storage/index.ts` |
| imgproxy HMAC signer + width buckets + pre-warm helpers | ✅ code-ready | `packages/core/src/modules/media/imgproxy.ts` |
| `cdnImage()` / `cdnSrcSet()` / `cdnThemeLibraryAsset()` | ✅ code-ready | `packages/core/src/modules/media/cdn.ts` |
| `imageUrl()` dispatcher with `GBOX_IMAGE_CDN=imgproxy` path | ✅ code-ready | `packages/core/src/modules/content/image-url.ts` |
| BullMQ queues (`transcode`, `media-ingest`) | ✅ code-ready | `packages/core/src/modules/queue/queues.ts` |
| CF Edge Worker (UA stamp + JWT download signer + placeholder) | ✅ code-ready | `apps/cdn-worker/src/index.ts` |
| 60 unit tests passing (4 live-S3 tests skipped without creds) | ✅ green | run: `npx vitest run packages/core/src/modules/{storage,media}` |
| AWS S3 buckets (8 — prod primary + DR) | ⏳ MANUAL — step 1 | — |
| IAM roles | ⏳ MANUAL — step 2 | — |
| imgproxy on ECS Fargate | ⏳ MANUAL — step 3 | — |
| ffmpeg-worker on ECS Fargate | ⏳ MANUAL — step 4 | — |
| Cloudflare zone `cdn.gbox.co` (Origin Rules, Cache Rules, WAF) | ⏳ MANUAL — step 5 | — |
| HMAC keys (`IMGPROXY_KEY` / `IMGPROXY_SALT`) on all servers | ⏳ MANUAL — step 6 | — |
| `wrangler deploy` for `apps/cdn-worker` + secrets | ⏳ MANUAL — step 7 | — |
| Backend `/api/_internal/sign-download` endpoint | ⏳ TODO (next phase) | — |

## Prereqs

- AWS account with Billing + IAM admin on Thai's root (or a delegated admin user with IAM permissions).
- Cloudflare account with the `gbox.co` zone attached and at least Business plan (Enterprise preferred for Argo + guaranteed HCMC POP — see spec §10.1).
- `aws` CLI v2 installed and configured (`aws configure` with a bootstrap access key that has IAM permissions — will be deleted after step 2).
- `wrangler` CLI v3+ installed (`npm i -g wrangler` or use the one pinned in `apps/cdn-worker/package.json`).
- SSH access to the 3 test servers (192.168.1.13 / .30 / .19) — see `memory/server_credentials.md`.

---

## Step 1 — Create S3 buckets

Spec §4.1. Eight buckets for production (4 primary + 4 DR). Staging + dev
mirror (8 more) come later — we only need prod to flip the CDN.

### 1.1 Primary region `ap-southeast-1` (Singapore)

```bash
REGION=ap-southeast-1
for name in gbox-public-media-prod gbox-theme-library-prod \
            gbox-private-prod gbox-backups-prod; do
  aws s3api create-bucket \
    --bucket "$name" \
    --region "$REGION" \
    --create-bucket-configuration LocationConstraint="$REGION"

  aws s3api put-public-access-block \
    --bucket "$name" \
    --public-access-block-configuration \
      BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true

  aws s3api put-bucket-versioning \
    --bucket "$name" \
    --versioning-configuration Status=Enabled
done
```

### 1.2 DR region `ap-northeast-1` (Tokyo)

```bash
REGION=ap-northeast-1
for name in gbox-public-media-prod-dr gbox-theme-library-prod-dr \
            gbox-private-prod-dr gbox-backups-prod-dr; do
  aws s3api create-bucket \
    --bucket "$name" \
    --region "$REGION" \
    --create-bucket-configuration LocationConstraint="$REGION"

  aws s3api put-public-access-block \
    --bucket "$name" \
    --public-access-block-configuration \
      BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true

  aws s3api put-bucket-versioning \
    --bucket "$name" \
    --versioning-configuration Status=Enabled
done
```

### 1.3 Cross-region replication (CRR)

Spec §4.5. Set up CRR from each primary → its DR twin. Easiest via Console
(S3 → bucket → Management → Replication → Create rule):

- Source: `gbox-public-media-prod` (whole bucket, all objects)
- Destination: `gbox-public-media-prod-dr`
- IAM role: `GboxS3ReplicationRole` (created in step 2.4)
- Options: Replicate existing objects: ON; Replicate delete markers: OFF
  (keeps DR immutable after accidental prod deletes).
- Repeat for the other 3 pairs.

### 1.4 Bucket policy — Cloudflare + imgproxy egress only

Spec §5.4. Apply to `gbox-public-media-prod` + `gbox-theme-library-prod`
only (private + backups get signed URLs from the backend; no public egress).

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowCloudflareAndImgproxy",
      "Effect": "Allow",
      "Principal": "*",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::gbox-public-media-prod/*",
      "Condition": {
        "StringEquals": {
          "aws:UserAgent": "Mozilla/5.0 (compatible; GboxEdge/1.0; +https://gbox.co/edge)"
        },
        "IpAddress": {
          "aws:SourceIp": [
            "_cloudflare_ip_ranges_see_https://www.cloudflare.com/ips-v4_",
            "_imgproxy_NLB_private_subnets_"
          ]
        }
      }
    }
  ]
}
```

The Cloudflare IP list is refreshed weekly — automate with a Lambda if you
care, or accept a ±weekly manual update. The UA string matches what the
Worker stamps on every request (see `apps/cdn-worker/src/index.ts:43-44`).

### 1.5 CORS

Public media only:

```json
[
  {
    "AllowedOrigins": ["https://*.gbox.co", "https://gbox.co", "https://*.tw3.store"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag", "Content-Length", "Content-Type"],
    "MaxAgeSeconds": 3600
  }
]
```

Theme library + private + backups → no CORS (access is server-side).

### 1.6 Lifecycle

Spec §4.1.

- `gbox-public-media-prod` → Intelligent-Tiering after 90 days
- `gbox-theme-library-prod` → keep published versions forever; purge `drafts/*` after 90 days
- `gbox-private-prod` → per-type: invoices 7y, exports 90d, POD 2y (see spec §4.4c)
- `gbox-backups-prod` → Glacier after 30d, Deep Archive after 180d

---

## Step 2 — IAM roles

Spec §6. Each compute workload gets its own role; no shared credentials.

### 2.1 `GboxBackendRole`

Attached to EC2/ECS running the Node API. Permissions:
- `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject`, `s3:ListBucket` on all 4 prod buckets
- `s3:GetObject` on `-dr` buckets (DR read during failover)
- KMS decrypt on the SSE-KMS keys if you enable KMS (not required for MVP)

### 2.2 `GboxImgproxyRole`

Attached to the imgproxy ECS task. Permissions:
- `s3:GetObject`, `s3:ListBucket` on `gbox-public-media-prod` + `gbox-theme-library-prod`

### 2.3 `GboxFfmpegWorkerRole`

Attached to the ffmpeg transcode ECS task. Permissions:
- `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject`, `s3:ListBucket` on `gbox-public-media-prod` (videos subdir only — scope with a resource ARN pattern)

### 2.4 `GboxS3ReplicationRole`

Attached to S3's CRR service. AWS has a wizard for this under
"Replication rule → Create role". Accept the wizard-generated policy.

### 2.5 Delete the bootstrap access key

Once roles are live, delete the `aws configure` access key used in step 1.
Nothing should hold hardcoded AWS creds outside of local dev machines.

---

## Step 3 — imgproxy on ECS Fargate

Spec §11.2. Private NLB in front of 2+ Fargate tasks.

### 3.1 Task definition

- Image: `ghcr.io/imgproxy/imgproxy:v3.23.0`
- CPU/memory: 1 vCPU / 2 GB (prod); 0.5 vCPU / 1 GB (DR, scale-to-0)
- Role: `GboxImgproxyRole`
- Env (pull IMGPROXY_KEY/SALT from AWS Secrets Manager — **never** hardcode):

```bash
IMGPROXY_USE_S3=true
IMGPROXY_S3_REGION=ap-southeast-1
IMGPROXY_ALLOWED_SOURCES=s3://gbox-public-media-prod/,s3://gbox-theme-library-prod/
IMGPROXY_MAX_SRC_RESOLUTION=50
IMGPROXY_MAX_SRC_FILE_SIZE=104857600
IMGPROXY_JPEG_PROGRESSIVE=true
IMGPROXY_ENFORCE_WEBP=true
IMGPROXY_ENFORCE_AVIF=true
IMGPROXY_STRIP_METADATA=true
IMGPROXY_STRIP_COLOR_PROFILE=true
IMGPROXY_AUTO_ROTATE=true
IMGPROXY_KEY=<from_secrets_manager>      # 64-hex
IMGPROXY_SALT=<from_secrets_manager>     # 64-hex (must match step 6)
IMGPROXY_SIGNATURE_SIZE=32
IMGPROXY_ENABLE_WEBP_DETECTION=true
IMGPROXY_ENABLE_AVIF_DETECTION=true
IMGPROXY_ENABLE_CLIENT_HINTS=true
IMGPROXY_BIND=:8080
IMGPROXY_LOG_FORMAT=json
IMGPROXY_PROMETHEUS_BIND=:8081
```

### 3.2 NLB

- Internal (no public IP), port 443
- TLS cert: Cloudflare Origin CA cert for `imgproxy.internal.gbox.co`
- Target group: imgproxy ECS service, port 8080
- Health check: `GET /health`, 200 = healthy

### 3.3 Security group

Inbound: 443 from Cloudflare IPv4 + IPv6 ranges only. (Refresh weekly from
`https://www.cloudflare.com/ips-v4`; a cron on the bastion that syncs this
is the right long-term move.)

### 3.4 Autoscaling

- Min 2 tasks (HA across 2 AZs)
- Max 20 tasks
- Scale out: CPU > 60% for 60s
- Scale in: CPU < 20% for 300s

### 3.5 DNS

- `imgproxy.internal.gbox.co` → NLB DNS name (Cloudflare grey-cloud record
  since the NLB is internal-only; the Worker resolves it via Cloudflare's
  Origin Rules, not a public DNS).

---

## Step 4 — ffmpeg-worker on ECS Fargate

Spec §12. Transcode `source.mp4` → HLS ladder (1080p/720p/480p/240p) +
poster frame + scrub thumbs.

### 4.1 Task definition

- Image: build from `docker/ffmpeg-worker/Dockerfile` (TODO — scaffolding
  lives in spec §12, not yet in repo). Pin `jrottenberg/ffmpeg:6.0-ubuntu`
  base until we publish our own.
- CPU/memory: 4 vCPU / 8 GB (transcode is CPU-heavy)
- Role: `GboxFfmpegWorkerRole`
- Entry: Node script that subscribes to the `transcode` BullMQ queue
  (already wired in `packages/core/src/modules/queue/queues.ts`)

### 4.2 Queue wiring

The backend already enqueues jobs via `enqueueTranscode({shopId, videoId,
srcKey, bucket})` with idempotent jobId `video:<shopId>:<videoId>`. The
worker just needs to consume — 1 concurrent task per Fargate container,
retry policy `{attempts: 2, backoff: {type: 'exponential', delay: 300_000}}`
already set server-side.

### 4.3 Output

Per spec §4.4a:
```
shops/{shop_id}/videos/{video_id}/master.m3u8
                                  /1080p/*.ts
                                  /720p/*.ts
                                  /480p/*.ts
                                  /240p/*.ts
                                  /poster.jpg
                                  /thumbs/thumb-0.jpg … thumb-9.jpg
```

### 4.4 Autoscaling

- Min 0 tasks (queue-based; spin up on depth)
- Max 10 tasks
- Scale trigger: BullMQ queue depth > 5 for 60s → add 1 task

---

## Step 5 — Cloudflare zone `cdn.gbox.co`

Spec §10.

### 5.1 DNS

- `cdn.gbox.co` → CNAME-flat to the Origin Rule target (set after 5.2 below);
  orange cloud ON.
- `download.gbox.co` → CNAME to `cdn.gbox.co` (or direct to the Worker
  route); orange cloud ON.

### 5.2 Origin Rules (Rules → Origin Rules)

Evaluated in order, first match wins:

| # | Match | Override Host |
|---|---|---|
| 1 | `cdn.gbox.co/themes/*` | `gbox-theme-library-prod.s3.ap-southeast-1.amazonaws.com` |
| 2 | `cdn.gbox.co/shops/*/videos/*` | `gbox-public-media-prod.s3.ap-southeast-1.amazonaws.com` |
| 3 | `cdn.gbox.co/shops/*/themes/*/assets/*.{css,js,woff2,woff,ttf,svg,map}` | `gbox-public-media-prod.s3.ap-southeast-1.amazonaws.com` |
| 4 | `cdn.gbox.co/img/*` | `imgproxy.internal.gbox.co` |
| 5 | `cdn.gbox.co/*` (default) | `gbox-public-media-prod.s3.ap-southeast-1.amazonaws.com` |

### 5.3 Cache Rules (Caching → Cache Rules)

See spec §10.3. Priorities 1-8; use the table there verbatim.

### 5.4 Transform Rules → Modify Response Header

Strip the AWS fingerprint headers + stamp the security headers per spec
§10.4. Copy-paste from spec section 10.4.

### 5.5 WAF

- Managed Ruleset: Cloudflare Managed Ruleset + OWASP Core Ruleset
- Custom rate-limit rule: 2,000 req / 10s per IP on `cdn.gbox.co/shops/*`
- Bot Fight Mode: ON

### 5.6 SSL

- Full (strict). Install Cloudflare Origin CA cert on the imgproxy NLB
  (already covered in step 3.2).

---

## Step 6 — Generate + distribute HMAC keys

The imgproxy container and the backend `signImgproxyUrl()` helper both
need the same 32-byte key + 32-byte salt. Rotate quarterly.

### 6.1 Generate

```bash
openssl rand -hex 32    # → IMGPROXY_KEY    (64 hex chars = 32 bytes)
openssl rand -hex 32    # → IMGPROXY_SALT   (64 hex chars = 32 bytes)
```

### 6.2 Distribute

- **AWS Secrets Manager:** store as two secrets, name them
  `gbox/prod/imgproxy/key` and `gbox/prod/imgproxy/salt`. Grant
  `secretsmanager:GetSecretValue` to `GboxImgproxyRole` and
  `GboxBackendRole`.
- **All 3 test servers** (192.168.1.13 / .30 / .19): add to
  `/home/<user>/gbox-platform/.env`:
  ```
  IMGPROXY_KEY=<hex from above>
  IMGPROXY_SALT=<hex from above>
  IMGPROXY_SIGNATURE_SIZE=32
  GBOX_IMAGE_CDN=imgproxy
  CDN_PUBLIC_BASE_URL=https://cdn.gbox.co
  ```
  Then `pm2 restart all --update-env` so Node picks them up.
- **Never** commit these to git. `.env` is gitignored; `.env.example`
  documents the variable name only.

### 6.3 Rotation

imgproxy supports multiple keys via `IMGPROXY_KEY=<hex1>,<hex2>`. Rotation
procedure:
1. Generate new key+salt.
2. Add them as secondary on imgproxy (keeps old URLs valid).
3. Update backend `.env` to use new pair; restart Node.
4. Wait 1 day (old signed URLs all expire).
5. Remove old pair from imgproxy.

---

## Step 7 — Deploy the Cloudflare Worker

```bash
cd apps/cdn-worker
npm install
wrangler secret put DOWNLOAD_JWT_SECRET --env production
  # paste 64-hex generated via `openssl rand -hex 32`; must match
  # DOWNLOAD_JWT_SECRET in platform backend .env
wrangler secret put DOWNLOAD_SIGN_URL --env production
  # value: https://api.gbox.co/api/_internal/sign-download
wrangler secret put DOWNLOAD_SIGN_TOKEN --env production
  # paste 64-hex generated via `openssl rand -hex 32`; must match
  # DOWNLOAD_SIGN_TOKEN in platform backend .env

wrangler deploy --env production
```

Staging:

```bash
wrangler deploy --env staging
# routes: cdn-staging.gbox.co/*
```

Verify routes:

```bash
curl -I https://cdn.gbox.co/test.png
# expect: X-Gbox-Edge-Fallback: 1  (until real objects exist)
```

---

## Step 8 — Backend `/api/_internal/sign-download` endpoint

**NOT IN PHASE B SCOPE — this is the bridge the Worker calls to request
an AWS-presigned GET URL.**

Shape:

```http
POST /api/_internal/sign-download
Authorization: Bearer <DOWNLOAD_SIGN_TOKEN>   # must match Worker secret
Content-Type: application/json

{
  "shop_id": "shop_abc",
  "object_key": "shops/shop_abc/downloads/prod_123/file_xyz",
  "requested_by": "order:ord_456"
}

→ 200 { "url": "https://gbox-private-prod.s3...signed..." }
```

Implementation path in this repo: new route file at
`packages/api/src/routes/internal/sign-download.ts`, handler uses
`getPrivateStore().signedUrl(key, { expiresIn: 300 })` which is already
implemented in `S3Store`. Validate the Bearer token against
`process.env.DOWNLOAD_SIGN_TOKEN`, re-check shop_id authorization against
`orders` + `product_digital_downloads` tables (don't trust claim), emit
`signed_download_issued` event to audit log.

File this as a separate PR against `packages/api` — out of scope for
Phase B's storage layer.

---

## Smoke test after all steps

```bash
# 1. Upload a test image to public-media bucket
aws s3 cp test.jpg s3://gbox-public-media-prod/shops/smoke/test.jpg

# 2. Request it via imgproxy
curl -I "https://cdn.gbox.co/img/<sig>/rs:fill:800:0/g:no/q:82/dpr:2/f:webp/<b64_s3_uri>"
# expect: 200, Cache-Control: immutable, X-Imgproxy-*
# (build the URL with packages/core/src/modules/media/imgproxy.ts
#  signImgproxyUrl() to verify signing matches)

# 3. Check Worker UA stamp on the raw S3 path
curl -I "https://cdn.gbox.co/shops/smoke/test.jpg"
# expect: 200 from S3 (only works because Worker stamped the UA)

# 4. Hit a nonexistent path — placeholder kicks in
curl -I "https://cdn.gbox.co/shops/smoke/nonexistent.jpg"
# expect: 200 with X-Gbox-Edge-Fallback: 1

# 5. Transcode a test video (after ffmpeg-worker is live)
# Enqueue via backend API; observe /shops/smoke/videos/vid_x/master.m3u8
```

---

## Rollback

If imgproxy or the CF Worker misbehaves in prod:

1. Quick kill: flip `GBOX_IMAGE_CDN=passthrough` in backend `.env`
   + `pm2 restart gbox-api`. Images now serve raw S3 URLs (ugly but live).
2. Worker-level: `wrangler rollback` to the last known-good deployment.
3. Origin-level: disable Cloudflare Origin Rule #4 (imgproxy route) — all
   `/img/*` requests fall through to `S3_PUBLIC` and return 404 (until
   passthrough is re-enabled at app level).

Storage driver is non-destructive — `S3Store` only reads/writes to the
bucket you scope it to, so rolling back the backend never risks bucket
state.

---

## What's still missing (tracked for Phase C)

- Backend `/api/_internal/sign-download` endpoint (step 8 above)
- ffmpeg-worker Dockerfile + entry script (step 4.1)
- Lambda to auto-refresh Cloudflare IP allowlist on S3 bucket policies (step 1.4)
- imgproxy Prometheus scrape → CloudWatch dashboard
- CloudTrail → S3 for audit of every bucket op
- Pre-warm worker (issues 5 HEADs per image to seed CF edge cache)
- EventBridge → SQS → BullMQ ingestion pipeline (spec §15) — currently
  only the queue definitions exist; the S3 event bridge is not wired yet.
