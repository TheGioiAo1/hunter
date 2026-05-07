# Gbox Platform — Shopify-Parity S3 Media Pipeline

**Date:** 2026-04-18
**Owner:** Thai Bui
**Status:** Approved 2026-04-18 — decisions locked, ready for P1 kickoff
**Related:**
- `apps/store-admin/src/lib/object-store.ts` (existing R2 adapter — S3-compatible, scheduled for retirement after full cutover)
- `packages/db` migrations `013_product_images_srcset`, `pod_files` table
- `docs/superpowers/specs/2026-04-08-storefront-masterplan.md` (storefront delivery layer)

---

## 0. Decisions locked (2026-04-18)

The seven open questions originally in §23 were closed by Thai on 2026-04-18. This section is the
source of truth; every later section is consistent with these choices.

| # | Decision | Implication |
|---|---|---|
| 1 | **S3 is the single primary.** All media (new + existing R2 content) syncs to S3. R2 is not kept for the long run. | `ObjectStore` gets an S3 driver; existing R2 objects are mirrored to S3 then R2 is retired (see §21). |
| 2 | **Cloudflare is the CDN in front of S3** (not CloudFront). | No Lambda@Edge. Cloudflare POP in HCMC = lower VN latency. Origin access uses signed S3 URLs from Cloudflare Workers. |
| 3 | **Self-hosted image transform** (not Lambda@Edge, not Cloudflare Image Resizing). | `imgproxy` on ECS Fargate (or our VPS fleet) behind Cloudflare. URL-based transforms, Cloudflare edge cache. See §11. |
| 4 | **Self-hosted `ffmpeg` for video** (not MediaConvert). | BullMQ worker pool in Docker. HLS multi-bitrate + poster + thumbs. See §12. |
| 5 | **Quota tiers: placeholder (Shopify defaults for now).** Thai will tune per plan-tier pricing later. | §15.5 keeps Shopify's numbers (2000 images/product, 100 videos/product, 20 MB/image, 4 GB/video, 1 GB/theme). |
| 6 | **Theme versions: keep N versions.** Align with Shopify: keep every published version forever, purge only draft/unused versions after 90 days. | §13 + §8 lifecycle rules purge draft versions; published versions are never auto-deleted. |
| 7 | **Multi-region from day one.** Every bucket is created with S3 Cross-Region Replication (CRR) to a second region. All future buckets follow the same template. | Primary `ap-southeast-1` (Singapore, closest to VN) → replica `ap-northeast-1` (Tokyo). +~100% storage cost; pays off in DR + faster regional reads. See §4.5 + §9. |

**Open:** none. P1 can kick off.

---

## 1. Why

Gbox today stores **no product media** in object storage:

- `product_images.src` holds plain external URLs (imported from Shopify or seller-provided). If the source site goes down, every product card shows a broken image.
- `srcset_json` column exists (migration 013) but is always NULL — no ingestion pipeline wrote to it.
- Theme assets + POD files already ride on `ObjectStore` backed by **Cloudflare R2** at `cdn.gbox.co`. The adapter is S3-compatible, so swapping to AWS S3 is a config change, not a rewrite.
- No image transformation service. No `srcset`. No `format=webp` negotiation. No lazy loading. No `width`/`height` attributes → poor LCP, massive CLS.
- No storefront HTML edge cache. Every anonymous pageview hits Postgres + renders Astro SSR from scratch → won't survive a Black Friday burst.
- No digital downloads, no invoice storage, no merchant exports — all "buy an ebook" style flows blocked until the private bucket exists.

**Goal:** reach **feature parity with Shopify's media pipeline**, using AWS S3 as the primary object store. Everything Shopify pushes to `cdn.shopify.com` goes to `cdn.gbox.co`, same URL-based transform model, same cache semantics, same private-bucket pattern for digital goods.

**Non-goals:**
- Keeping R2 as a long-term primary. (Per §0 decision 1: full cutover to S3; R2 is mirrored then retired. See §21.)
- Building our own CDN layer — Cloudflare handles edge (§0 decision 2).
- Image editor inside the admin (crop/filter/etc) — Phase 2 item.
- Video editor / trim — Phase 2 item.

---

## 2. Scope

Eight sub-phases, rolled out in four quarterly waves. Each wave is shippable on its own.

| Wave | Phase | Scope |
|---|---|---|
| W1 | P1 | S3 bucket infra (4 buckets × 2 regions CRR), IAM, **Cloudflare zone + origin rules**, ObjectStore S3 adapter |
| W1 | P2 | Product image ingestion + **self-hosted imgproxy** + storefront `<img srcset>` |
| W2 | P3 | Theme assets (per shop) move to S3, versioned + fingerprinted |
| W2 | P4 | Theme Library (platform marketplace) bucket + upload pipeline |
| W3 | P5 | Videos (product + background) + **self-hosted ffmpeg worker pool** (BullMQ) |
| W3 | P6 | Reviews, blog, email, misc (logo/favicon/banner) public assets |
| W4 | P7 | Private pipeline: digital downloads, invoices, exports, POD migration — signed URLs via Cloudflare Worker |
| W4 | P8 | Backups + **Cloudflare edge cache rules** for storefront HTML + observability |

**Cross-phase invariant (from §0 decision 7):** every bucket created in any phase must be provisioned
with CRR to its paired DR region. The CLI helper in §20.0 enforces this — no ad-hoc bucket creation.

---

## 3. Shopify reference model (what we are copying)

### 3.1 Shopify's public CDN (`cdn.shopify.com`)

Every asset served from one canonical domain with this path grammar:

```
https://cdn.shopify.com/s/files/{version}/{shop_id}/{namespace}/{filename}?{transforms}
```

Examples:

| Asset | URL |
|---|---|
| Product image | `/s/files/1/0123/4567/products/shoe-red.jpg` |
| Product image resized | `/s/files/1/0123/4567/products/shoe-red.jpg?v=1708291820&width=800` |
| Collection banner | `/s/files/1/0123/4567/collections/summer.jpg?width=1600` |
| Theme asset | `/s/files/1/0123/4567/t/5/assets/application.css?v=a1b2c3d4` |
| Theme font | `/s/files/1/0123/4567/t/5/assets/Inter.woff2` |
| Shop logo | `/s/files/1/0123/4567/files/logo.png` |
| Product video MP4 | `/s/files/1/0123/4567/videos/c/vp/{hash}/720p.mp4` |
| Product video HLS | `/s/files/1/0123/4567/videos/c/{hash}/master.m3u8` |
| Review photo | `/s/files/1/0123/4567/reviews/{rid}.jpg` |
| Blog image | `/s/files/1/0123/4567/articles/{aid}.jpg?width=1200` |

Key properties:
1. **Shop ID is partitioned** (`0123/4567`) so no single directory grows without bound. S3 key prefix partitioning does the same job for us automatically.
2. **`?v=...` busts cache.** Content-addressed: update image → new `v` → new cache entry. Never overwrite.
3. **Image transforms are query-string driven.** `width`, `format`, `crop`, `quality`, `pad_color` — all happen at request time via an image transform service, result cached at CDN edge.
4. **Response headers:** `Cache-Control: public, max-age=31536000, immutable` + `ETag` + `Vary: Accept` for format negotiation.
5. **Auto-format:** request sends `Accept: image/avif,image/webp,*/*` → server picks best format. URL stays the same; cache key includes `Accept`.

### 3.2 Shopify's private/signed storage

Not served from `cdn.shopify.com` — separate signed URLs, expire in 24h. Used for:

- Digital product downloads (`downloads.shopify.com/...?signature=...&expires=...`)
- Merchant CSV/JSON exports
- Invoice PDFs (via `orders.shopify.com/.../invoice.pdf`)
- Customer service attachments

### 3.3 Shopify's edge HTML cache

- Storefront HTML cached at edge for **anonymous** traffic (no `_shopify_fs` cookie, no cart).
- Cache key = URL path + query (whitelist) + currency/language cookies.
- TTL: 60-300s. Stale-while-revalidate: 60-3600s.
- Bypass: session cookie OR non-empty cart OR logged-in customer.
- A hot product page serves **without touching their Rails app** — it's all edge.

### 3.4 What Shopify does NOT put in S3/CDN

Reminder — these live in DB + Redis:

- Product data (title, description, variants, prices) — MySQL + memcached
- Customer data — MySQL + Redis
- Orders + line items — MySQL (sharded per shop)
- Inventory stock levels — Redis + MySQL
- Shopping carts — Redis (TTL 14d)
- Sessions — Redis
- Search index — Elasticsearch
- Analytics events — Kafka → BigQuery

We mirror this split exactly.

---

## 4. Bucket design

### 4.1 Four buckets (production)

| Bucket | Purpose | Public/Private | Edge | Lifecycle |
|---|---|---|---|---|
| `gbox-public-media-prod` | Shop-uploaded public content: images, videos, theme assets | Private at S3 level, fronted by Cloudflare | Yes (`cdn.gbox.co`) | Intelligent-Tiering after 90d |
| `gbox-theme-library-prod` | Platform-curated theme marketplace (god-admin uploads) | Private at S3, fronted by Cloudflare | Yes (`cdn.gbox.co/themes/*`) | Keep published versions forever; purge drafts after 90d |
| `gbox-private-prod` | Digital downloads, invoices, exports, POD | Private, signed URL only (Cloudflare Worker) | No direct edge | Per-type (see §4.4) |
| `gbox-backups-prod` | DB dumps, theme backups, logs, audits | Private, admin-only | No edge | Glacier lifecycle |

**Why four, not one:**
- Different IAM boundaries (theme-library is platform-admin-only; backups are god-admin-only; private needs signed URLs issued by a Cloudflare Worker; public is fronted by Cloudflare CDN).
- Different lifecycle per bucket — one policy per bucket is simpler than path-prefixed rules.
- Different CORS — public needs permissive CORS for storefront domains; private needs none.
- Auditable — CloudTrail filters by bucket.

**Edge in front (§0 decision 2):** Cloudflare sits in front of `gbox-public-media-prod` and
`gbox-theme-library-prod`. S3 itself blocks public access; only the Cloudflare AWS IP ranges +
imgproxy origin are allowed to `s3:GetObject`. See §10 for the full egress policy.

### 4.2 Staging + dev

Mirror the four buckets with suffixes:

```
gbox-public-media-staging      gbox-public-media-dev
gbox-theme-library-staging     gbox-theme-library-dev
gbox-private-staging           gbox-private-dev
gbox-backups-staging           gbox-backups-dev
```

Dev buckets get lifecycle rule: **delete after 30 days** — don't leak dev test data forever.

### 4.3 Region

**Primary:** `ap-southeast-1` (Singapore). Closest AWS region to Vietnam, lowest latency for SEA traffic.
- 2-3ms from Singapore → HCMC/HN via undersea cable.
- `ap-southeast-3` (Jakarta) is newer but not all services available; stay with `ap-southeast-1` for now.

**Replica region (DR, from §0 decision 7):** `ap-northeast-1` (Tokyo). Rationale:
- Distinct seismic + undersea-cable fault zone from Singapore (real DR separation).
- Latency from Tokyo → HCMC is still acceptable (~80ms) if we ever have to fail over reads.
- All services we need (S3, KMS, SQS, IAM) are GA in Tokyo.

Every bucket in §4.1 is created in **both** regions with CRR from primary → replica. The replica
buckets have suffix `-dr` (e.g. `gbox-public-media-prod-dr`). They are read-only replicas under
normal ops; failover flips CNAME + Cloudflare origin in DR drill.

**Cloudflare plan:** Business or Enterprise (HCMC POP, Argo Smart Routing, Image Resizing disabled
since we self-host imgproxy). The distribution path (§10) works on Pro plan for dev/staging.

### 4.4 Bucket key structure

#### 4.4a `gbox-public-media-prod`

```
shops/{shop_id}/
├── products/{product_id}/
│   ├── {image_id}.{ext}                 # Original, never mutated
│   └── {image_id}.meta.json             # {width, height, format, blurhash, exif_stripped, ingested_at}
│
├── collections/{collection_id}/
│   ├── hero.{ext}                       # Collection banner
│   ├── hero.meta.json
│   └── thumb.{ext}                      # Small icon (optional)
│
├── videos/{video_id}/
│   ├── source.mp4                       # Original upload, kept for re-encode
│   ├── master.m3u8                      # HLS master playlist
│   ├── 1080p/                           # Per-bitrate HLS segments
│   ├── 720p/
│   ├── 480p/
│   ├── poster.jpg                       # Static poster frame
│   └── thumbs/thumb-{0-9}.jpg           # Scrub thumbnails (10 frames)
│
├── reviews/{review_id}/{image_id}.{ext}  # Customer-uploaded review photos
├── articles/{article_id}/{image_id}.{ext}  # Blog content images
├── email/{template_id}/{asset_id}.{ext}    # Email template inline images
│
├── misc/
│   ├── logo.{ext}                       # Store logo
│   ├── favicon.{ext}
│   ├── social-share.{ext}               # Open Graph default image
│   ├── announcement-{id}.{ext}          # Top bar banner images
│   └── popup-{id}.{ext}                 # Marketing popup images
│
└── themes/{theme_id}/{version}/
    ├── assets/
    │   ├── app.{fingerprint}.css        # Fingerprinted, immutable
    │   ├── app.{fingerprint}.js
    │   ├── fonts/{family}-{weight}.woff2
    │   ├── images/{name}.{ext}
    │   └── icons/{name}.svg
    ├── schema.json                       # Theme settings schema snapshot
    └── snapshots/
        └── published-{iso_timestamp}.zip # Pre-publish backup
```

#### 4.4b `gbox-theme-library-prod` (platform marketplace)

```
themes/{theme_slug}/
├── {version}/
│   ├── theme.zip                         # Full theme source for seller activation
│   ├── manifest.json                     # {name, version, author, changelog, preview_urls, ...}
│   ├── screenshots/
│   │   ├── 01-home-desktop.jpg
│   │   ├── 01-home-mobile.jpg
│   │   ├── 02-product-desktop.jpg
│   │   ├── ...
│   ├── preview/
│   │   ├── desktop-hero.jpg              # Theme card thumbnail (1200×750)
│   │   ├── mobile-hero.jpg
│   │   └── palette.jpg                   # Color palette swatch
│   └── demo/
│       ├── assets/                       # Demo site's compiled assets
│       └── data.json                     # Demo content (fake products, etc)
└── latest.json                            # { "version": "1.4.2" } — bumped on publish
```

**Note:** Theme library lives on the **same Cloudflare zone** as public media, routed via a path
rule: `cdn.gbox.co/themes/*` → `gbox-theme-library-prod`, everything else → `gbox-public-media-prod`
(through imgproxy for images). See §10.

#### 4.4c `gbox-private-prod`

```
shops/{shop_id}/
├── downloads/{product_id}/
│   ├── {file_id}                         # File with original name in S3 metadata
│   └── {file_id}.meta.json               # {original_name, mime, size, sha256}
│
├── invoices/{order_id}/
│   ├── invoice-{locale}-{version}.pdf    # Regen on change, version bumped
│   └── receipt-{locale}-{version}.pdf
│
├── exports/{export_id}/
│   └── {timestamp}-{type}.csv.gz         # {type} = products, customers, orders, ...
│
├── pod/{order_id}/{line_item_id}.png     # POD design files (migrate from R2)
│
├── attachments/{ticket_id}/{attachment_id}.{ext}  # Support ticket attachments
│
└── tax-docs/{year}/
    ├── 1099-{issued_date}.pdf
    └── vat-report-{quarter}.pdf

platform/
├── reports/{date}/{report_type}.pdf       # Platform-wide admin reports
└── audits/{date}/{audit_type}.json        # Immutable audit logs
```

#### 4.4d `gbox-backups-prod`

```
db/
├── postgres/{date}/
│   ├── gbox_platform-full.sql.gz         # Daily full dump
│   └── gbox_platform-wal/{hour}/         # WAL archive (PITR)
└── redis/{date}/dump.rdb

themes/
└── {shop_id}/{theme_id}/{timestamp}.zip   # Theme snapshots before publish/restore

logs/
└── {service}/{date}/{pod}.log.gz          # Rotated app logs

audits/
├── payments/{date}/               # Per-order audit (signed PDF)
└── admin-actions/{date}/          # God admin action log
```

### 4.5 Multi-region replication (CRR) — template for every bucket

**Decision (§0 #7):** every bucket in §4.1 is mirrored to a second region from day one. Subsequent
phases that introduce new buckets MUST follow this template — no bucket ships without a replica.

#### 4.5a Region pairing

| Primary | Replica (DR) | Why |
|---|---|---|
| `ap-southeast-1` (Singapore) | `ap-northeast-1` (Tokyo) | Separate fault zone; low enough latency for failover reads. |

#### 4.5b Replica bucket naming

```
gbox-public-media-prod           → gbox-public-media-prod-dr
gbox-theme-library-prod          → gbox-theme-library-prod-dr
gbox-private-prod                → gbox-private-prod-dr
gbox-backups-prod                → gbox-backups-prod-dr
```

Dev + staging tiers replicate too (so failover drills are runnable without prod risk). Cost is
low because dev+staging are small.

#### 4.5c Replication configuration (per bucket)

```json
{
  "Role": "arn:aws:iam::{account_id}:role/GboxS3ReplicationRole",
  "Rules": [
    {
      "ID": "replicate-all-to-dr",
      "Priority": 1,
      "Status": "Enabled",
      "DeleteMarkerReplication": { "Status": "Enabled" },
      "Filter": {},
      "Destination": {
        "Bucket": "arn:aws:s3:::{bucket_name}-dr",
        "StorageClass": "STANDARD_IA",
        "EncryptionConfiguration": {
          "ReplicaKmsKeyID": "arn:aws:kms:ap-northeast-1:{account_id}:key/{dr_kms_key_id}"
        },
        "ReplicationTime":  { "Status": "Enabled", "Time": { "Minutes": 15 } },
        "Metrics":          { "Status": "Enabled", "EventThreshold": { "Minutes": 15 } }
      },
      "SourceSelectionCriteria": {
        "SseKmsEncryptedObjects": { "Status": "Enabled" }
      }
    }
  ]
}
```

Key choices:
- `STANDARD_IA` for the replica — DR copy, cheap-to-store, expensive-to-read (acceptable; only hit on failover).
- **S3 Replication Time Control (RTC)** on: 99.99% of objects replicate within 15 minutes. Costs extra (~$0.015/GB) but gives an SLA we can monitor.
- Delete markers replicate — a delete in primary propagates to DR (still recoverable via versioning, §9).
- Both source + replica KMS-encrypted; `GboxS3ReplicationRole` is granted `kms:Decrypt` in primary and `kms:Encrypt` in DR.

#### 4.5d `GboxS3ReplicationRole` policy

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "SourceReadAcl",
      "Effect": "Allow",
      "Action": [
        "s3:GetReplicationConfiguration",
        "s3:ListBucket",
        "s3:GetObjectVersionForReplication",
        "s3:GetObjectVersionAcl",
        "s3:GetObjectVersionTagging"
      ],
      "Resource": [
        "arn:aws:s3:::gbox-public-media-prod",
        "arn:aws:s3:::gbox-public-media-prod/*",
        "arn:aws:s3:::gbox-theme-library-prod",
        "arn:aws:s3:::gbox-theme-library-prod/*",
        "arn:aws:s3:::gbox-private-prod",
        "arn:aws:s3:::gbox-private-prod/*",
        "arn:aws:s3:::gbox-backups-prod",
        "arn:aws:s3:::gbox-backups-prod/*"
      ]
    },
    {
      "Sid": "ReplicaWrite",
      "Effect": "Allow",
      "Action": [
        "s3:ReplicateObject",
        "s3:ReplicateDelete",
        "s3:ReplicateTags"
      ],
      "Resource": [
        "arn:aws:s3:::gbox-public-media-prod-dr/*",
        "arn:aws:s3:::gbox-theme-library-prod-dr/*",
        "arn:aws:s3:::gbox-private-prod-dr/*",
        "arn:aws:s3:::gbox-backups-prod-dr/*"
      ]
    },
    {
      "Sid": "KmsForReplication",
      "Effect": "Allow",
      "Action": ["kms:Decrypt"],
      "Resource": "arn:aws:kms:ap-southeast-1:{account_id}:key/{primary_kms_key_id}"
    },
    {
      "Sid": "KmsForEncryptAtDr",
      "Effect": "Allow",
      "Action": ["kms:Encrypt"],
      "Resource": "arn:aws:kms:ap-northeast-1:{account_id}:key/{dr_kms_key_id}"
    }
  ]
}
```

#### 4.5e Failover runbook (rehearsed quarterly)

1. Flip Cloudflare origin for `cdn.gbox.co` from `gbox-public-media-prod.s3.ap-southeast-1.amazonaws.com` to the DR bucket.
2. Repoint `ObjectStore` default region env var in all services (`S3_REGION=ap-northeast-1`, `S3_BUCKET_SUFFIX=-dr`).
3. Make DR bucket writable (replication source changes to DR → primary after region recovers).
4. Run smoke tests: upload, thumbnail, HLS playback, signed-URL download.

Steps 1-3 are a runbook at `docs/runbooks/dr-failover-s3.md` (to be written in Phase 8).

---

## 5. IAM — principals, roles, policies

### 5.1 Principals

| Principal | Purpose | Auth method |
|---|---|---|
| `GboxBackendRole` | Store-admin + storefront Express servers | Attached to EC2/ECS task |
| `GboxIngestionWorkerRole` | Image/video ingestion BullMQ workers | Attached to EC2/ECS task |
| `GboxImgproxyRole` | Self-hosted `imgproxy` container(s) — reads from S3, returns transforms | Attached to ECS task |
| `GboxFfmpegWorkerRole` | Self-hosted `ffmpeg` transcode workers (BullMQ) | Attached to ECS task |
| `GboxPlatformAdminUser` | Thai (god admin) manual publishes | IAM user with MFA, Access Key in 1Password |
| `GboxS3ReplicationRole` | CRR from primary → `-dr` buckets | S3 service trust |
| `GboxSignedUrlWorkerRole` *(optional)* | If Cloudflare Worker signs URLs via IAM instead of SDK (only if we run a Lambda-behind-Worker hop) | — |
| `GboxGitHubActionsRole` | CI deploy theme library updates | OIDC federation from GitHub |

Removed vs draft: `GboxLambdaImageTransformRole`, `GboxMediaConvertRole`, `GboxCloudFrontOAI`
(dropped with §0 decisions 2-4). Cloudflare access to S3 is not via IAM role — see §10.

### 5.2 `GboxBackendRole` policy

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ReadWritePublicShopMedia",
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:ListBucket"
      ],
      "Resource": [
        "arn:aws:s3:::gbox-public-media-prod",
        "arn:aws:s3:::gbox-public-media-prod/shops/*"
      ]
    },
    {
      "Sid": "ReadThemeLibrary",
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:ListBucket"],
      "Resource": [
        "arn:aws:s3:::gbox-theme-library-prod",
        "arn:aws:s3:::gbox-theme-library-prod/*"
      ]
    },
    {
      "Sid": "ReadWritePrivateShopFiles",
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject"
      ],
      "Resource": "arn:aws:s3:::gbox-private-prod/shops/*"
    },
    {
      "Sid": "SignPresignedUrls",
      "Effect": "Allow",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::gbox-private-prod/*"
    },
    {
      "Sid": "EnqueueIngestion",
      "Effect": "Allow",
      "Action": ["sqs:SendMessage"],
      "Resource": "arn:aws:sqs:ap-southeast-1:{account_id}:gbox-ingestion-prod"
    }
  ]
}
```

**Critical:** the backend role **cannot read `gbox-backups-prod` or platform/ paths** — that's god-admin-only. Enforced by NOT granting it, not by denial (least-privilege baseline).

### 5.3 `GboxIngestionWorkerRole` policy

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "IngestionReadWrite",
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      "Resource": [
        "arn:aws:s3:::gbox-public-media-prod/*",
        "arn:aws:s3:::gbox-private-prod/shops/*/pod/*"
      ]
    },
    {
      "Sid": "ConsumeIngestionQueue",
      "Effect": "Allow",
      "Action": [
        "sqs:ReceiveMessage",
        "sqs:DeleteMessage",
        "sqs:ChangeMessageVisibility",
        "sqs:GetQueueAttributes"
      ],
      "Resource": "arn:aws:sqs:ap-southeast-1:{account_id}:gbox-ingestion-prod"
    }
  ]
}
```

Ingestion workers no longer create MediaConvert jobs (§0 decision 4). For video, they
enqueue a BullMQ job that the `GboxFfmpegWorkerRole` fleet consumes directly.

### 5.3a `GboxImgproxyRole` policy

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ReadAllPublicMedia",
      "Effect": "Allow",
      "Action": ["s3:GetObject"],
      "Resource": [
        "arn:aws:s3:::gbox-public-media-prod/*",
        "arn:aws:s3:::gbox-theme-library-prod/*"
      ]
    }
  ]
}
```

`imgproxy` only reads; it never writes to S3. Transformed outputs live in Cloudflare's edge cache
and the imgproxy container's local disk LRU (optional tier-2 cache, see §11).

### 5.3b `GboxFfmpegWorkerRole` policy

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ReadSourceWriteDerivatives",
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      "Resource": [
        "arn:aws:s3:::gbox-public-media-prod/shops/*/videos/*"
      ]
    },
    {
      "Sid": "ConsumeTranscodeQueue",
      "Effect": "Allow",
      "Action": [
        "sqs:ReceiveMessage",
        "sqs:DeleteMessage",
        "sqs:ChangeMessageVisibility",
        "sqs:GetQueueAttributes"
      ],
      "Resource": "arn:aws:sqs:ap-southeast-1:{account_id}:gbox-transcode-prod"
    }
  ]
}
```

Workers read `source.mp4`, write HLS renditions + poster + scrub thumbs to the same video prefix.
Nothing MediaConvert-specific needed.

### 5.4 Cloudflare-facing bucket policies

S3 buckets block public access at the account level. Access to the public buckets is granted
narrowly:

1. **For image requests**, Cloudflare routes to `imgproxy` ECS service → imgproxy reads S3 via `GboxImgproxyRole` (IAM).
2. **For non-image public requests** (HLS manifests + segments, theme `.zip`, fonts, CSS, JS), Cloudflare origin-fetches S3 directly. S3 bucket policy allows only the current Cloudflare IP ranges.

**`gbox-public-media-prod` bucket policy:**

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowCloudflareEdgeReads",
      "Effect": "Allow",
      "Principal": "*",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::gbox-public-media-prod/*",
      "Condition": {
        "IpAddress": {
          "aws:SourceIp": [
            "173.245.48.0/20",
            "103.21.244.0/22",
            "103.22.200.0/22",
            "103.31.4.0/22",
            "141.101.64.0/18",
            "108.162.192.0/18",
            "190.93.240.0/20",
            "188.114.96.0/20",
            "197.234.240.0/22",
            "198.41.128.0/17",
            "162.158.0.0/15",
            "104.16.0.0/13",
            "104.24.0.0/14",
            "172.64.0.0/13",
            "131.0.72.0/22",
            "2400:cb00::/32",
            "2606:4700::/32",
            "2803:f800::/32",
            "2405:b500::/32",
            "2405:8100::/32",
            "2a06:98c0::/29",
            "2c0f:f248::/32"
          ]
        },
        "StringEquals": {
          "aws:UserAgent": "Mozilla/5.0 (compatible; GboxEdge/1.0; +https://gbox.co/edge)"
        }
      }
    },
    {
      "Sid": "DenyInsecureTransport",
      "Effect": "Deny",
      "Principal": "*",
      "Action": "s3:*",
      "Resource": [
        "arn:aws:s3:::gbox-public-media-prod",
        "arn:aws:s3:::gbox-public-media-prod/*"
      ],
      "Condition": { "Bool": { "aws:SecureTransport": "false" } }
    }
  ]
}
```

Notes:
- The IP list above is the Cloudflare public egress range as of 2026-04 (`https://www.cloudflare.com/ips-v4`). We **refresh it weekly** via a small Lambda + EventBridge schedule — listed as a P1 chore in §22.
- The custom `User-Agent` header is rewritten by a Cloudflare "Transform Rule" on egress — a belt-and-suspenders check so a bucket left in dev mode can't be read from a random Cloudflare tenant's worker.
- `GboxImgproxyRole` access is granted via IAM, not bucket policy — so imgproxy-over-VPC-endpoint does not need to go through the Cloudflare IP allow list.

Apply the same two statements to `gbox-theme-library-prod`.

**`gbox-private-prod` bucket policy:** no Cloudflare allow. Only `GboxBackendRole` (and
`GboxSignedUrlWorkerRole` if we go that route) can sign presigned URLs. Clients fetch objects
directly from S3 using the signature — Cloudflare is not in this path. Plus `DenyInsecureTransport`.

**`gbox-backups-prod` bucket policy:** `GboxPlatformAdminUser` + `DenyInsecureTransport`. No other principal.

### 5.5 Block Public Access

**Every bucket** — flip all four switches ON at the bucket level:

```
BlockPublicAcls:        true
IgnorePublicAcls:       true
BlockPublicPolicy:      true
RestrictPublicBuckets:  true
```

Public delivery goes through Cloudflare (optionally via imgproxy for images). S3 is never directly
reachable from the internet — the bucket policy (§5.4) only allows the Cloudflare egress IP range
+ our internal ECS IAM principals.

---

## 6. CORS

### 6.1 `gbox-public-media-prod` CORS

```json
[
  {
    "AllowedOrigins": [
      "https://*.gbox.co",
      "https://gbox.co",
      "https://tw3.store",
      "https://*.tw3.store"
    ],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag", "Content-Length", "Content-Type", "x-amz-version-id"],
    "MaxAgeSeconds": 3600
  },
  {
    "AllowedOrigins": [
      "https://*.gbox.co",
      "https://admin.gbox.co"
    ],
    "AllowedMethods": ["PUT", "POST", "DELETE"],
    "AllowedHeaders": ["*"],
    "MaxAgeSeconds": 3600
  }
]
```

**Custom seller domains:** sellers bring their own domains (e.g. `acmeshop.vn`). For those, we DON'T need CORS on image GETs — browsers don't CORS-block `<img src>` loads. The GET rule above is mainly for fetch/XHR. So custom domains work automatically for image rendering.

### 6.2 `gbox-theme-library-prod` CORS

```json
[
  {
    "AllowedOrigins": ["*"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag", "Content-Length"],
    "MaxAgeSeconds": 86400
  }
]
```

Theme screenshots + previews are public-wildcard — anyone (including logged-out theme-library visitors) can load them.

### 6.3 `gbox-private-prod` CORS

None. Signed URLs include everything the browser needs; no XHR needed for downloads.

---

## 7. Encryption

| Bucket | At-rest | KMS key | In-transit |
|---|---|---|---|
| `gbox-public-media-prod` | SSE-S3 (AES-256) | none | TLS enforced (bucket policy) |
| `gbox-theme-library-prod` | SSE-S3 | none | TLS enforced |
| `gbox-private-prod` | **SSE-KMS** | `alias/gbox-private-key` | TLS enforced |
| `gbox-backups-prod` | **SSE-KMS** | `alias/gbox-backups-key` | TLS enforced |

**Why KMS for private + backups:** access to encrypted objects leaves a CloudTrail KMS audit entry even if S3 CloudTrail is noisy. For invoices + tax docs + backups, that audit trail is the only tool we have if an admin's credentials are ever compromised.

**KMS key policy:** grant `kms:Decrypt` to `GboxBackendRole` only for `gbox-private-key`; backups key is god-admin + the backup worker only.

---

## 8. Lifecycle rules

### 8.1 `gbox-public-media-prod`

```json
{
  "Rules": [
    {
      "Id": "AbortIncompleteMultipart",
      "Status": "Enabled",
      "Filter": {},
      "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 7 }
    },
    {
      "Id": "IntelligentTieringHotContent",
      "Status": "Enabled",
      "Filter": { "Prefix": "shops/" },
      "Transitions": [
        { "Days": 90, "StorageClass": "INTELLIGENT_TIERING" }
      ]
    },
    {
      "Id": "DeleteOldVersions",
      "Status": "Enabled",
      "Filter": {},
      "NoncurrentVersionExpiration": { "NoncurrentDays": 30 }
    }
  ]
}
```

S3 Intelligent-Tiering auto-moves cold images to IA/Glacier and moves them back to Standard on access — no manual tiering needed.

### 8.2 `gbox-theme-library-prod`

No lifecycle. Theme files live forever (sellers may rebuild against old versions). Manual delete only.

### 8.3 `gbox-private-prod`

```json
{
  "Rules": [
    {
      "Id": "ExportsCleanup",
      "Status": "Enabled",
      "Filter": { "Prefix": "shops/" },
      "Expiration": { "Days": 90 }
    },
    {
      "Id": "InvoicesKeep7Years",
      "Status": "Enabled",
      "Filter": { "And": { "Prefix": "shops/", "Tags": [{ "Key": "type", "Value": "invoice" }] } },
      "Expiration": { "Days": 2555 }
    },
    {
      "Id": "PODKeepIndefinitely",
      "Status": "Disabled",
      "Filter": { "And": { "Prefix": "shops/", "Tags": [{ "Key": "type", "Value": "pod" }] } }
    }
  ]
}
```

**Note:** lifecycle uses **object tags**, not path prefix, because multiple types share `shops/{id}/`. Uploads must tag objects: `type=invoice|export|download|pod|attachment`.

Exports expire in 90d (sellers can regenerate). Invoices kept 7 years (tax retention). Downloads kept indefinitely (customer may re-download). POD kept indefinitely (fulfillment audit).

### 8.4 `gbox-backups-prod`

```json
{
  "Rules": [
    {
      "Id": "TierToIA",
      "Status": "Enabled",
      "Filter": {},
      "Transitions": [
        { "Days": 30, "StorageClass": "STANDARD_IA" },
        { "Days": 180, "StorageClass": "GLACIER" },
        { "Days": 730, "StorageClass": "DEEP_ARCHIVE" }
      ]
    },
    {
      "Id": "DeleteLogsAfter1Year",
      "Status": "Enabled",
      "Filter": { "Prefix": "logs/" },
      "Expiration": { "Days": 365 }
    }
  ]
}
```

---

## 9. Versioning

| Bucket | Versioning | Notes |
|---|---|---|
| `gbox-public-media-prod` | **Enabled** | Recoverable if seller accidentally overwrites. Required for CRR. |
| `gbox-theme-library-prod` | **Enabled** | Version is in the path, but S3 versioning gives a safety net. Required for CRR. |
| `gbox-private-prod` | **Enabled** | Critical for invoices/tax. Required for CRR. |
| `gbox-backups-prod` | **Enabled** + Object Lock (governance mode, 30d minimum retention) | Object Lock prevents a compromised admin from deleting all backups during a ransomware event. |

**Why versioning is mandatory here:** S3 Cross-Region Replication (§4.5) only works on
version-enabled buckets. Versioning is the baseline for both CRR and undo semantics. Without
versioning we get neither.

**Noncurrent-version lifecycle** (prevents version count from growing unbounded):

```json
{
  "Rules": [{
    "Id": "ExpireNoncurrentAfter90d",
    "Status": "Enabled",
    "Filter": {},
    "NoncurrentVersionExpiration": { "NoncurrentDays": 90 },
    "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 1 }
  }]
}
```

Applied to all four buckets. The "keep forever" rule for published theme versions (§0 decision 6)
is enforced by **never overwriting** the `themes/{theme_slug}/{version}/` prefix — a published
version gets a fresh `{version}` directory, so there is no noncurrent version to expire for
published themes.

---

## 10. Cloudflare CDN — zone, origin rules, Workers

### 10.1 Zone setup — `cdn.gbox.co`

| Setting | Value |
|---|---|
| Plan | Business (minimum — required for custom Page Rules + image caching overrides) or Enterprise (for Argo Smart Routing + guaranteed HCMC POP) |
| DNS | `cdn.gbox.co` proxied (orange cloud) — CNAME flat to the origin rule target (§10.2) |
| SSL | Full (strict) — Cloudflare origin cert required on origin hops (imgproxy + S3 website endpoint) |
| Minimum TLS | 1.2 |
| HTTP/2, HTTP/3 | Enabled |
| Brotli | Enabled |
| IPv6 | Enabled |
| WAF | Managed Ruleset + custom rate-limit rule (2k req/10s per IP on `/shops/*`, 10k/10s global) |
| Bot Fight Mode | On (Business+) |
| Argo Smart Routing | On (Enterprise) — shaves 20-30% off origin fetch latency during POP cold start |
| Image Resizing | **Off** — we self-host imgproxy (§0 decision 3). Explicitly disable so no accidental double-transform. |

### 10.2 Origin routing (Cloudflare Rules — Origin Rules + Configuration Rules)

Cloudflare does the routing job that CloudFront's "cache behaviors" did. Three origin targets:

| Target name | Host | Port | TLS | Purpose |
|---|---|---|---|---|
| `IMGPROXY` | `imgproxy.internal.gbox.co` (Network Load Balancer in front of ECS Fargate) | 443 | Cloudflare Origin CA cert | Image transforms (§11) |
| `S3_PUBLIC` | `gbox-public-media-prod.s3.ap-southeast-1.amazonaws.com` | 443 | AWS-managed | HLS manifests+segments, videos, fonts, CSS, JS — anything non-image |
| `S3_THEME` | `gbox-theme-library-prod.s3.ap-southeast-1.amazonaws.com` | 443 | AWS-managed | Theme marketplace assets |

**Origin Rules** (evaluated in order; first match wins):

| # | When (URL match) | Override host | Notes |
|---|---|---|---|
| 1 | `cdn.gbox.co/themes/*` | `S3_THEME` | Theme library assets |
| 2 | `cdn.gbox.co/shops/*/videos/*` | `S3_PUBLIC` | HLS + MP4 — byte serving direct from S3 (imgproxy is image-only) |
| 3 | `cdn.gbox.co/shops/*/themes/*/assets/*.{css,js,woff2,woff,ttf,svg,map}` | `S3_PUBLIC` | Shop theme text/fonts |
| 4 | `cdn.gbox.co/img/*` | `IMGPROXY` | Signed imgproxy URLs (§11.3 grammar: `/img/{sig}/{options}/{b64_source}`). All image transform requests MUST use this prefix — raw `/shops/*.jpg` bypasses imgproxy and hits S3 directly. |
| 5 | `cdn.gbox.co/*` (default) | `S3_PUBLIC` | Everything else — including raw passthrough `/shops/*.jpg` when callers intentionally skip transforms |

### 10.3 Cache rules

Cloudflare's Cache Rules replace CloudFront's "Cache Policy + Origin Request Policy". One rule per
content class:

| # | Match | Edge TTL | Browser TTL | Cache key |
|---|---|---|---|---|
| 1 | `/themes/*` (all theme library) | 1 year | 1 year | URL path (strip all query) |
| 2 | `/shops/*/themes/*/assets/*` (shop theme fingerprinted) | 1 year | 1 year | URL path (strip all query) |
| 3 | `/img/*` (images via imgproxy) | 1 year | 1 day | URL path only — all transforms are baked into the signed path segment per §11.3 (`/img/{sig}/{options}/{b64_source}`), so query strings are never part of the cache key |
| 4 | `/shops/*/videos/*.m3u8` (HLS manifest) | 30s | 0 | URL path (short TTL — HLS manifests can mutate on encode restart) |
| 5 | `/shops/*/videos/*.ts` (HLS segment) | 1 year | 1 year | URL path |
| 6 | `/shops/*/videos/*.{mp4,webm,mov}` (raw) | 1 month | 1 month | URL path |
| 7 | `/shops/*/videos/poster.*` + `/thumbs/*.jpg` | 1 month | 1 day | URL path |
| 8 | (default) | 1 day | 1 hour | URL path |

`Cache-Control: immutable` is stamped on rules #1, #2, #3 (image), #5, #6 via a Transform Rule
response header rewrite.

### 10.4 Response headers (Cloudflare Transform Rule: "Modify Response Header")

Applied globally on `cdn.gbox.co`:

```
set   Cache-Control: public, max-age=31536000, immutable   (on images + fingerprinted assets only)
set   Strict-Transport-Security: max-age=63072000; includeSubDomains; preload
set   X-Content-Type-Options: nosniff
set   Cross-Origin-Resource-Policy: cross-origin
set   Access-Control-Allow-Origin: *
set   Access-Control-Allow-Methods: GET, HEAD
remove Server
remove x-amz-id-2
remove x-amz-request-id
remove x-amz-meta-*
```

### 10.5 Workers (private signed URLs, egress header injection)

Three Cloudflare Workers (bundled as one Worker script with route rules):

| Worker route | Purpose |
|---|---|
| `download.gbox.co/*` | Issues signed S3 URLs for `gbox-private-prod`. Reads a JWT from the request, validates shop+order+TTL, returns a 302 to the presigned S3 URL. |
| `cdn.gbox.co/*` (on all requests, "before origin") | Injects the `User-Agent: Mozilla/5.0 (compatible; GboxEdge/1.0; +https://gbox.co/edge)` header expected by S3 bucket policy (§5.4). |
| `cdn.gbox.co/shops/*` (on responses that 4xx/5xx from origin) | Returns a generic placeholder image (base64) with 30s TTL so a broken S3 fetch doesn't render a broken icon on storefronts. |

Worker source lives in `apps/cdn-worker/src/index.ts` (monorepo package added in P1). Deploy via
Wrangler + GitHub Actions OIDC — no plain API token in CI.

### 10.6 Purge / invalidation

- Purge by URL prefix: `curl -X POST "https://api.cloudflare.com/client/v4/zones/{zone_id}/purge_cache" -d '{"prefixes":["cdn.gbox.co/shops/{shop_id}/products/{product_id}/"]}'`
- Purge on theme publish: Worker hook in the theme-publish route triggers the prefix purge for that shop's theme directory.
- Purge on product image replace: backend calls `cdnPurge(['shops/...'])` after `s3:PutObject` succeeds.

---

## 11. Image transformation pipeline — self-hosted imgproxy

### 11.1 Architecture choice (locked §0 decision 3)

**Pick:** `imgproxy` (Go binary, MIT license) on AWS ECS Fargate, fronted by an internal NLB, reached
only from Cloudflare.

Why:
- Battle-tested at scale (Basecamp, DEV, thousands of production deploys).
- Single Go binary, no sidecars; container image is ~80 MB.
- Signed URL support (HMAC) prevents abuse — arbitrary resize requests cost us money.
- Native S3 read (no copy to container disk needed).
- Format negotiation via `Accept` header built in.
- Horizontal scale via ECS service autoscaling on CPU.
- No vendor lock-in — can move off AWS to any Docker host (matches our "self-host" mandate).

Rejected:
- **Lambda@Edge** — AWS-only, can't run under Cloudflare (§0 #2).
- **Cloudflare Image Resizing** — §0 #3 explicitly says self-host.
- **Thumbor (Python)** — slower (libvips-free default), larger attack surface (Python deps).
- **Our own Node + sharp service** — reinventing imgproxy. Considered only if imgproxy can't meet a need; so far none identified.

### 11.2 Deployment

**ECS Fargate cluster:** `gbox-imgproxy-prod` in `ap-southeast-1` (replica in `ap-northeast-1` for
DR, scaled to 0 until failover).

| Resource | Prod (primary) | DR |
|---|---|---|
| Task CPU | 1 vCPU | 0.5 vCPU |
| Task memory | 2 GB | 1 GB |
| Min tasks | 2 (HA across AZs) | 0 (scaled up on failover) |
| Max tasks | 20 | 10 |
| Scale-out trigger | CPU > 60% for 60s | — |
| Scale-in trigger | CPU < 20% for 300s | — |
| Health check | `GET /health` on `:8080` | — |

**Image:** pinned `ghcr.io/imgproxy/imgproxy:v3.23.0` (or newer) + Gbox overlay that
injects Vault-sourced HMAC keys on start.

**Network:**
- Tasks in private subnets; outbound NAT to S3 (or VPC Gateway Endpoint for S3 — zero data transfer cost).
- Internal NLB (TLS on 443, Cloudflare Origin CA cert).
- Security group: inbound 443 from Cloudflare IP ranges only (refreshed weekly, §5.4).

**Config (env vars passed to the container):**

```bash
IMGPROXY_USE_S3=true
IMGPROXY_S3_REGION=ap-southeast-1
IMGPROXY_ALLOWED_SOURCES=s3://gbox-public-media-prod/,s3://gbox-theme-library-prod/
IMGPROXY_MAX_SRC_RESOLUTION=50           # Reject originals > 50 MP
IMGPROXY_MAX_SRC_FILE_SIZE=104857600     # 100 MB
IMGPROXY_JPEG_PROGRESSIVE=true
IMGPROXY_PNG_INTERLACED=false
IMGPROXY_ENFORCE_WEBP=true               # Serve WebP whenever Accept allows
IMGPROXY_ENFORCE_AVIF=true               # Serve AVIF whenever Accept allows
IMGPROXY_STRIP_METADATA=true
IMGPROXY_STRIP_COLOR_PROFILE=true
IMGPROXY_AUTO_ROTATE=true
IMGPROXY_KEY=<from AWS Secrets Manager>        # 64-hex HMAC key
IMGPROXY_SALT=<from AWS Secrets Manager>       # 64-hex HMAC salt
IMGPROXY_SIGNATURE_SIZE=32
IMGPROXY_ENABLE_WEBP_DETECTION=true
IMGPROXY_ENABLE_AVIF_DETECTION=true
IMGPROXY_ENABLE_CLIENT_HINTS=true
IMGPROXY_BIND=:8080
IMGPROXY_LOG_FORMAT=json
IMGPROXY_PROMETHEUS_BIND=:8081                 # Scraped by CloudWatch Agent
```

### 11.3 URL grammar

Storefront generates URLs via a helper (§16). Wire format:

```
https://cdn.gbox.co/img/{signature}/{processing_options}/{encoded_source_uri}
```

`processing_options` is a slash-separated list: `rs:fit:800:0/q:85/f:auto`.
`encoded_source_uri` is base64url-encoded `s3://gbox-public-media-prod/shops/abc/products/123/img-42.jpg`.

Public storefront never builds URLs by hand — always via `cdnImage()` (§16.1).

### 11.4 Width normalization (cache hit-rate lever)

Helper rounds requested `w` up to nearest allowed bucket before signing:

```
[64, 128, 256, 384, 512, 768, 1024, 1280, 1600, 2048, 3200, 4096]
```

Request for `w=700` → signed URL uses `rs:fit:768:0`. Cap on cache variants per image is ~12 × 3
formats (jpg/webp/avif) = 36. Cloudflare edge cache stays hot.

### 11.5 Pre-warming

On product image ingestion (§15), the worker issues 5 HEAD requests through Cloudflare at:
`w ∈ {64, 256, 512, 1024, 2048}` × `f=webp`. This seeds Cloudflare edge cache + imgproxy's disk LRU
so the first real visitor gets a warm hit.

### 11.6 Two-tier cache

```
Browser ─▶ Cloudflare edge (1y TTL, per region)
              └─(miss)─▶ imgproxy NLB ─▶ imgproxy container disk LRU (20 GB, 24h)
                              └─(miss)─▶ S3 GetObject
```

Cloudflare carries the bulk of traffic. imgproxy's local LRU absorbs regional cache churn (when
Cloudflare drops an edge cache, a few containers pay the transform cost once, not 12 times).

### 11.7 Signed URLs

imgproxy is configured with a 64-hex HMAC key. Unsigned requests 403. This stops:
- Competitors scraping our images at ad-hoc sizes (the URL pattern is obvious; signing keeps cost in check).
- A malicious site requesting `w=9999/h=9999` to exhaust our CPU.

Signature is generated in backend (`cdnImage()` helper, §16.1). Key is rotated quarterly;
imgproxy supports multiple simultaneous keys to allow seamless rotation.

### 11.8 Non-image content (theme .zip, fonts, HLS .ts)

Does **not** pass through imgproxy. Cloudflare routes these direct to S3 via Origin Rule #1, #3, #5
in §10.2. imgproxy only handles image MIME types.

---

## 12. Video pipeline — self-hosted ffmpeg workers

### 12.1 Architecture (locked §0 decision 4)

**Pick:** BullMQ queue + ECS Fargate workers running `ffmpeg` directly. Outputs HLS multi-bitrate +
poster + scrub thumbs. Writes back to S3 under the same video prefix.

Why:
- No MediaConvert per-minute bill (~$0.0075/min × 3min × 1000 videos = $22/mo baseline, grows fast at scale).
- ffmpeg is the industry reference. We already use BullMQ for other job types; one more queue is free.
- Full control over encode params — can tune quality ladder per device profile without waiting on AWS preset updates.
- Transparent ops: `docker logs` shows encode progress; no opaque MediaConvert job UI.

Trade-offs we accept:
- Must scale ECS service manually-ish (autoscale on queue depth, see §12.5).
- Must keep ffmpeg binary patched — we use the `jrottenberg/ffmpeg:6-ubuntu` image pinned.
- Peak-hour burst capacity needs headroom. Not an issue at current scale; revisit at 10k+ videos/day.

### 12.2 Flow

```
Seller upload (admin UI)
   └─▶ presigned multipart PUT → s3://gbox-public-media-prod/shops/{s}/videos/{v}/source.{ext}
          └─▶ S3 event (ObjectCreated:*) → EventBridge → SQS gbox-transcode-prod
                 └─▶ ffmpeg worker (ECS task) picks up job
                        ├─ Download source to /tmp
                        ├─ ffmpeg: HLS ladder (1080p/720p/480p/240p) + poster + 10 scrub thumbs
                        ├─ Upload outputs to shops/{s}/videos/{v}/ (parallel, ~8 parts)
                        ├─ Delete /tmp workspace
                        └─ UPDATE media_assets SET status='ready', updated_at=now()
```

### 12.3 Worker spec

**Container image:** `ghcr.io/gbox-company/ffmpeg-worker:{git_sha}` built from:

```dockerfile
FROM jrottenberg/ffmpeg:6-ubuntu
RUN apt-get update && apt-get install -y --no-install-recommends \
      nodejs npm ca-certificates curl && \
    rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY dist/ .
COPY package.json pnpm-lock.yaml ./
RUN npm i --omit=dev
CMD ["node", "worker.js"]
```

**ECS Fargate service:** `gbox-ffmpeg-workers-prod`

| Resource | Prod | DR |
|---|---|---|
| Task CPU | 4 vCPU | 2 vCPU |
| Task memory | 8 GB | 4 GB |
| Ephemeral storage | 50 GB (holds source + renditions during encode) | 25 GB |
| Min tasks | 1 | 0 |
| Max tasks | 10 | 5 |
| Scale-out | SQS `ApproximateNumberOfMessagesVisible` > 2 per task for 2 min | — |
| Scale-in | Queue empty for 10 min | — |

**Node worker orchestrates ffmpeg:**

```ts
// Pseudo-code for the worker
import { spawn } from 'node:child_process'
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'

export async function processVideo(job: TranscodeJob) {
  const workDir = await tempDir()
  const srcPath  = `${workDir}/source.mp4`
  await downloadFromS3(job.srcKey, srcPath)

  const ladder = [
    { name: '1080p', height: 1080, bitrate: '5000k', maxrate: '5350k', bufsize: '7500k' },
    { name: '720p',  height: 720,  bitrate: '2500k', maxrate: '2675k', bufsize: '3750k' },
    { name: '480p',  height: 480,  bitrate: '1000k', maxrate: '1070k', bufsize: '1500k' },
    { name: '240p',  height: 240,  bitrate: '400k',  maxrate: '428k',  bufsize: '600k'  },
  ]

  // Single ffmpeg call with multi-output — shares the decode cost once.
  await runFfmpeg([
    '-y',
    '-i', srcPath,
    // 4 HLS renditions
    ...ladder.flatMap((r) => [
      '-map', '0:v:0', '-map', '0:a:0?',
      `-c:v:${r.name}`, 'libx264', '-crf', '23', '-preset', 'veryfast',
      `-b:v:${r.name}`, r.bitrate, `-maxrate:${r.name}`, r.maxrate, `-bufsize:${r.name}`, r.bufsize,
      '-vf', `scale=-2:${r.height}`,
      '-c:a', 'aac', '-b:a', '128k',
      '-hls_time', '6',
      '-hls_playlist_type', 'vod',
      '-hls_segment_filename', `${workDir}/${r.name}/seg_%04d.ts`,
      `${workDir}/${r.name}/playlist.m3u8`,
    ]),
    // Poster at 10% timecode
    '-ss', '10%', '-frames:v', '1', `${workDir}/poster.jpg`,
    // 10 scrub thumbnails evenly spaced
    '-vf', 'fps=10/(duration),scale=320:-2',
    `${workDir}/thumbs/thumb-%02d.jpg`,
  ])

  // Write master.m3u8 pointing at the 4 rendition playlists.
  await writeMasterPlaylist(`${workDir}/master.m3u8`, ladder)

  // Parallel upload, 8-way.
  await uploadDir(workDir, `shops/${job.shopId}/videos/${job.videoId}/`, { concurrency: 8 })

  // Flip DB flag.
  await db
    .updateTable('media_assets')
    .where('id', '=', job.videoId)
    .set({ status: 'ready', encoded_at: sql`now()` })
    .execute()
}
```

(Real implementation lives in `apps/ffmpeg-worker/src/index.ts`, added in P5.)

### 12.4 Limits

- Max source size: 5 GB (multipart upload).
- Max duration: 10 minutes (Shopify Plus allows 60m; we raise later).
- Accepted formats: MP4, MOV, WebM, MKV, AVI.
- Concurrency: one job per task (a 4-vCPU task is ~busy during 1080p encode).
- Timeout: encode killed after 30 min wall clock; failed job retried up to 3 times with DLQ.

### 12.5 Autoscaling + cost control

- CloudWatch alarm on `ApproximateNumberOfMessagesVisible / NumberOfRunningTasks > 2`, triggered 2 min → scale out step +2.
- Alarm on queue empty for 10 min → scale in to min.
- Weekly CloudWatch report on avg per-video cost; triggers re-tune if > $0.05/video.

### 12.6 Playback (unchanged)

Storefront `<video>` uses HLS via `hls.js`:

```html
<video poster="{cdn}/shops/{s}/videos/{v}/poster.jpg" controls preload="none">
  <source src="{cdn}/shops/{s}/videos/{v}/master.m3u8" type="application/vnd.apple.mpegurl">
</video>
```

Cloudflare caches `master.m3u8` (30s TTL) + `*.ts` segments (1y TTL) — see §10.3.

---

## 13. Asset type detail matrix

### 13.1 Product images

| Property | Value |
|---|---|
| Public/private | Public via CDN |
| S3 key | `shops/{shop_id}/products/{product_id}/{image_id}.{ext}` |
| Accepted formats (upload) | JPEG, PNG, WebP, GIF, HEIC, AVIF |
| Max dimensions (original) | 5000 × 5000 |
| Max file size | 20 MB |
| EXIF stripped | Yes (GPS, device info — privacy) |
| ICC preserved | Yes (color accuracy for fashion/art shops) |
| Pre-generated variants | 64, 256, 512, 1024, 2048 (WebP + original format) |
| On-demand variants | 16-4096 width, WebP/AVIF/JPEG, quality 40-95 |
| Storage class | Standard → Intelligent-Tiering after 90d |
| Cache-Control | `public, max-age=31536000, immutable` (because URL includes `?v=hash`) |
| Versioning | Original never overwritten; new image = new `image_id` |

### 13.2 Collection images

Same spec as product images. Key: `shops/{shop_id}/collections/{collection_id}/hero.{ext}`.

### 13.3 Product videos

See §12. Key: `shops/{shop_id}/videos/{video_id}/source.{ext}`.

### 13.4 Theme assets (per shop, from visual editor)

| Property | Value |
|---|---|
| Public/private | Public via CDN |
| S3 key | `shops/{shop_id}/themes/{theme_id}/{version}/assets/{fingerprint}.{ext}` |
| Accepted types | CSS, JS, WOFF2, WOFF, SVG, JPEG, PNG, WebP |
| Fingerprinting | SHA-256 of content, first 12 chars |
| Max file size | 5 MB per asset |
| Pre-compression | Uploaded with `Content-Encoding: gzip` + `.br` variant |
| Cache-Control | `public, max-age=31536000, immutable` |

**Publish flow:** when a seller clicks "Publish theme":
1. Compile theme in a sandbox (current EmDash theme engine).
2. Compute fingerprints for all assets.
3. Upload each asset to `shops/{s}/themes/{t}/{new_version}/assets/...` (never overwrite old version).
4. Update `shop_themes.published_version` DB row.
5. Storefront queries `shop_themes` → rewrites asset URLs to new version path.
6. Old version stays in S3 for 30 days in case of instant rollback.
7. After 30 days, lifecycle deletes `shops/{s}/themes/{t}/{old_version}/`.

### 13.5 Theme library (platform marketplace)

| Property | Value |
|---|---|
| Public/private | Public via CDN |
| S3 key | `themes/{theme_slug}/{version}/...` |
| Upload path | Only god-admin via CI (GitHub Actions OIDC) or platform-admin UI |
| Screenshots | 1200×750 desktop, 400×712 mobile, 12 per theme max |
| Preview images | Theme card hero (1200×750), color palette swatch |
| Demo site | Deployed separately to `demo.gbox.co/{theme_slug}/{version}/`, but static assets can live in S3 |
| Version alias | `themes/{slug}/latest.json` points at current published version — updated atomically on publish |

**Seller activation flow:**
1. Seller clicks "Activate theme Shopify-Modern-v2" on theme library page.
2. Backend reads `themes/{slug}/{version}/theme.zip` from library bucket.
3. Unzip → upload to shop's `shops/{s}/themes/{new_theme_id}/1.0.0/assets/...`.
4. Mark new theme as `draft`. Seller previews, then publishes via normal theme publish flow (§13.4).

**Why not symlink / reference?** Each shop gets its own copy so they can customize without affecting the library master. Matches Shopify's "My Themes" vs "Theme Store" separation.

### 13.6 Reviews (customer-uploaded photos)

| Property | Value |
|---|---|
| Public/private | Private until moderated, then public |
| S3 key | `shops/{shop_id}/reviews/{review_id}/{image_id}.{ext}` |
| Moderation | New uploads get S3 tag `moderation=pending`. A **Cloudflare Worker** on the review path checks the tag (via S3 HeadObject with a tight 60s cache) and returns 404 for `pending` until the moderator flips it to `approved`. Alternative (simpler): backend only writes to `shops/{s}/reviews/` after approval, keeping the public key space clean. |
| Max dimensions | 3000 × 3000 (customers don't need 5000) |
| Max file size | 10 MB |

### 13.7 Blog article images

Same as product images. Key: `shops/{shop_id}/articles/{article_id}/{image_id}.{ext}`.

### 13.8 Email template images

Same as product images but smaller max (hero 600×300 typical). Key: `shops/{shop_id}/email/{template_id}/{asset_id}.{ext}`.

**Note:** Email clients (Gmail, Outlook) cache images for up to 1 year regardless of `Cache-Control`. Use versioned URLs strictly.

### 13.9 Misc (logo, favicon, announcement, popup)

Key: `shops/{shop_id}/misc/{asset_name}.{ext}`.

- Logo: recommended SVG; accept PNG/JPEG/WebP. Max 2 MB.
- Favicon: accept ICO/PNG, 32-512 px.
- Announcement bar image: 1600×64 recommended.
- Popup image: 800×600 recommended.

### 13.10 Digital downloads (private)

| Property | Value |
|---|---|
| Public/private | Private, signed URL only |
| S3 key | `shops/{shop_id}/downloads/{product_id}/{file_id}` |
| File name preservation | Original name in S3 object metadata (`Content-Disposition: attachment; filename="..."`) |
| Max file size | 5 GB (multipart upload) |
| Signed URL TTL | 24 h from issuance |
| Download limits | Tracked in DB (`download_log` table); URL reissued on limit breach |
| Lifecycle | Retained indefinitely (customer may re-download for 1 year post-purchase per license policy) |

**Issuance flow:**
1. Customer completes order with digital product.
2. Backend inserts `download_tokens` row: `{token, order_id, line_item_id, expires_at, download_count_limit: 5}`.
3. Email sent with link: `https://downloads.gbox.co/claim/{token}`.
4. Customer clicks → backend verifies token → generates presigned S3 URL (24h) → 302 redirect.
5. Browser downloads directly from S3. Backend records download in `download_log`.

### 13.11 Invoices + receipts (private)

| Property | Value |
|---|---|
| Public/private | Private, signed URL |
| S3 key | `shops/{shop_id}/invoices/{order_id}/invoice-{locale}-{version}.pdf` |
| Generation | Async worker on order state transition → PDF-generate (Puppeteer / wkhtmltopdf) → upload |
| Versioning | Order edit → new version, old versions kept |
| Lifecycle | 7 years retention (tax) |

### 13.12 Merchant exports (private)

| Property | Value |
|---|---|
| Public/private | Private, signed URL |
| S3 key | `shops/{shop_id}/exports/{export_id}/{timestamp}-{type}.csv.gz` |
| Generation | Async worker on export request → stream from Postgres → gzip → S3 multipart upload |
| Max size | 2 GB (larger splits into parts) |
| Signed URL TTL | 1 hour |
| Lifecycle | 90 days, then delete |

### 13.13 POD files (private, migrate from R2)

| Property | Value |
|---|---|
| Public/private | Private |
| S3 key | `shops/{shop_id}/pod/{order_id}/{line_item_id}.png` |
| Current location | Cloudflare R2 |
| Migration | Parallel dual-write for 30 days → lazy-migrate on read → final `aws s3 sync` cutover |
| Lifecycle | Indefinite (fulfillment audit) |

---

## 14. Database schema additions

### 14.1 Polymorphic `media_assets` table (new)

Replaces the ad-hoc per-type columns in `product_images`. Shopify-style polymorphic media.

```sql
-- Migration 047_media_assets.sql

CREATE TYPE media_owner_type AS ENUM (
  'product',       -- product image
  'collection',    -- collection hero
  'variant',       -- variant-specific image
  'review',        -- customer review photo
  'article',       -- blog article image
  'email',         -- email template image
  'theme',         -- theme asset (per-shop)
  'shop_misc',     -- logo, favicon, banner
  'shop_video'     -- product video
);

CREATE TYPE media_status AS ENUM (
  'uploading',     -- multipart in flight
  'ingesting',     -- queued for processing
  'processing',    -- worker actively running (resize/transcode)
  'ready',         -- live on CDN
  'failed',        -- ingestion failed (see last_error)
  'deleted'        -- soft-deleted (preserve audit, S3 TTL will clean)
);

CREATE TABLE media_assets (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id         UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,

  owner_type      media_owner_type NOT NULL,
  owner_id        UUID NOT NULL,              -- FK not enforced (polymorphic)
  position        INT DEFAULT 0,              -- display order

  s3_bucket       TEXT NOT NULL,              -- 'gbox-public-media-prod'
  s3_key          TEXT NOT NULL,              -- 'shops/abc/products/123/img-1.jpg'
  cdn_url         TEXT NOT NULL,              -- 'https://cdn.gbox.co/shops/abc/...'

  original_name   TEXT,
  mime_type       TEXT NOT NULL,
  size_bytes      BIGINT NOT NULL,
  sha256          TEXT,                        -- dedup + integrity

  -- Image-specific
  width           INT,
  height          INT,
  format          TEXT,                        -- 'jpeg', 'png', 'webp'
  blurhash        TEXT,                        -- 30-char string, ~20 bytes placeholder
  dominant_color  TEXT,                        -- '#a1b2c3' (theme-aware loading)
  has_transparency BOOLEAN,
  exif_stripped   BOOLEAN DEFAULT FALSE,

  -- Video-specific
  duration_ms     INT,
  video_codec     TEXT,
  audio_codec     TEXT,
  hls_master_key  TEXT,                        -- S3 key to master.m3u8

  -- Ingestion
  status          media_status NOT NULL DEFAULT 'uploading',
  ingestion_job_id TEXT,                       -- BullMQ job ID
  last_error      TEXT,
  variants_json   JSONB,                       -- {"256": "...", "512": "...", ...} pre-generated URLs

  -- Audit
  uploaded_by     UUID REFERENCES store_users(id),
  uploaded_from_ip INET,
  virus_scanned   BOOLEAN DEFAULT FALSE,
  virus_scan_at   TIMESTAMPTZ,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ                  -- soft delete
);

CREATE INDEX idx_media_shop_owner ON media_assets (shop_id, owner_type, owner_id);
CREATE INDEX idx_media_status ON media_assets (status) WHERE status != 'ready';
CREATE INDEX idx_media_sha256 ON media_assets (shop_id, sha256) WHERE sha256 IS NOT NULL;
CREATE UNIQUE INDEX idx_media_s3_key ON media_assets (s3_bucket, s3_key);
```

### 14.2 `media_ingestion_jobs` (new)

```sql
CREATE TYPE ingestion_job_type AS ENUM (
  'image_variants',    -- pre-warm 5 Cloudflare-cached variants through imgproxy
  'video_transcode',   -- self-host ffmpeg -> HLS ladder + poster + thumbs
  'virus_scan',
  'blurhash_compute',
  'exif_strip',
  'dominant_color_extract'
);

CREATE TYPE ingestion_job_status AS ENUM (
  'queued', 'running', 'succeeded', 'failed', 'dead'
);

CREATE TABLE media_ingestion_jobs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id        UUID NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
  job_type        ingestion_job_type NOT NULL,
  status          ingestion_job_status NOT NULL DEFAULT 'queued',

  attempts        INT NOT NULL DEFAULT 0,
  max_attempts    INT NOT NULL DEFAULT 5,
  last_error      TEXT,

  queued_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,

  worker_id       TEXT,                        -- which ingestion worker picked it up
  bullmq_job_id   TEXT                         -- link to BullMQ for debugging
);

CREATE INDEX idx_ingestion_status ON media_ingestion_jobs (status, queued_at);
```

### 14.3 `download_tokens` + `download_log` (new)

```sql
CREATE TABLE download_tokens (
  token           TEXT PRIMARY KEY,            -- 64-char hex
  shop_id         UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  order_id        UUID NOT NULL REFERENCES orders(id),
  line_item_id    UUID NOT NULL,
  asset_id        UUID NOT NULL REFERENCES media_assets(id),
  customer_id     UUID NOT NULL REFERENCES customers(id),

  issued_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL,        -- 24h or 1y depending on policy
  download_limit  INT NOT NULL DEFAULT 5,
  download_count  INT NOT NULL DEFAULT 0,
  revoked_at      TIMESTAMPTZ                  -- admin revocation
);

CREATE TABLE download_log (
  id              BIGSERIAL PRIMARY KEY,
  token           TEXT REFERENCES download_tokens(token),
  downloaded_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip_address      INET,
  user_agent      TEXT,
  bytes_served    BIGINT                       -- from S3 response
);
```

### 14.4 Deprecate `product_images` in favor of view

Keep `product_images` as a VIEW backed by `media_assets` for backward compat, but new code writes to `media_assets`:

```sql
CREATE OR REPLACE VIEW product_images AS
SELECT
  m.id,
  m.owner_id       AS product_id,
  m.cdn_url        AS src,
  m.original_name  AS alt,
  m.width,
  m.height,
  m.position,
  m.variants_json  AS srcset_json
FROM media_assets m
WHERE m.owner_type = 'product'
  AND m.status = 'ready'
  AND m.deleted_at IS NULL;
```

Old code keeps working; new features use `media_assets` directly.

---

## 15. Ingestion pipeline

### 15.1 Architecture

```
    ┌──────────────┐       upload      ┌─────────────┐
    │   Browser    │──► (presigned) ──►│    S3       │
    │  (admin UI)  │                   │   bucket    │
    └──────────────┘                   └──────┬──────┘
                                              │ S3 Event
                                              ▼
                                       ┌─────────────┐
                                       │ EventBridge │
                                       └──────┬──────┘
                                              │
                                              ▼
                                       ┌─────────────┐
                                       │     SQS     │
                                       │   queue     │
                                       └──────┬──────┘
                                              │
                    ┌─────────────────────────┼────────────────────┐
                    ▼                         ▼                    ▼
            ┌──────────────┐         ┌──────────────┐     ┌──────────────┐
            │ Image worker │         │ Video worker │     │ Virus worker │
            │  (BullMQ)    │         │ (MediaConv.) │     │  (ClamAV)    │
            └──────┬───────┘         └──────┬───────┘     └──────┬───────┘
                   │                        │                    │
                   ▼                        ▼                    ▼
            ┌──────────────────────────────────────────────────────────┐
            │               media_assets + media_ingestion_jobs        │
            │                        (Postgres)                        │
            └──────────────────────────────────────────────────────────┘
```

### 15.2 Upload flow (direct-to-S3)

**Why direct-to-S3 not via backend proxy:** 20MB image through Node.js Express = 20MB of buffer/stream/heap pressure per upload. Direct-to-S3 with presigned URL offloads the bytes entirely.

1. Browser: user selects image.
2. Browser → backend: `POST /admin/media/presign` with `{filename, mime, size, owner_type, owner_id}`.
3. Backend validates:
   - MIME in allowlist
   - Size < 20MB
   - Seller has quota remaining
4. Backend generates presigned PUT URL expiring in 5 min + creates `media_assets` row (status=uploading, s3_key computed).
5. Backend returns `{presigned_url, asset_id}`.
6. Browser: `PUT {presigned_url}` with file body + `x-amz-meta-asset-id: {asset_id}` header.
7. S3 receives → fires `s3:ObjectCreated:*` event → EventBridge → SQS.
8. Worker reads SQS msg → looks up asset_id → runs ingestion (virus scan, variant pre-gen, blurhash, etc).
9. Worker updates `media_assets.status = 'ready'` + fills `variants_json`.
10. SSE notification to admin UI: `media.ready` → UI updates thumbnail from placeholder to real image.

### 15.3 Worker types (BullMQ queues)

| Queue | Worker | Concurrency | Purpose |
|---|---|---|---|
| `media-virus-scan` | ClamAV worker | 4 per host | Scan before marking ready |
| `media-image-variants` | Sharp worker | 8 per host | Pre-generate 5 sizes |
| `media-video-transcode` | ffmpeg worker (ECS Fargate, §12) | 1 per task (4 vCPU) | Transcode source.mp4 → HLS ladder + poster + thumbs |
| `media-blurhash` | blurhash worker | 4 per host | 30-char placeholder string |
| `media-exif-strip` | Sharp worker | 4 per host | Strip GPS + device info |
| `media-dominant-color` | Sharp worker | 4 per host | Extract dominant color hex |

All queues run in the same PM2 process (`gbox-media-worker`) initially; split out to separate processes if any queue becomes a bottleneck.

### 15.4 Retry policy

BullMQ config per queue:
- `attempts: 5`
- `backoff: { type: 'exponential', delay: 2000 }` (2s, 4s, 8s, 16s, 32s)
- `removeOnComplete: { age: 86400, count: 1000 }`
- `removeOnFail: { age: 2592000 }` (30 days, for debugging)

Dead-letter queue `media-ingestion-dlq` captures items that exhaust attempts. Daily cron alert sends counts to god-admin.

### 15.5 Quota enforcement

```
Free plan:        5 GB storage, 500 images, 10 videos
Basic plan:       50 GB, 5,000 images, 100 videos
Pro plan:         500 GB, 50,000 images, 1,000 videos
Enterprise:       unlimited (fair-use 5 TB soft cap)
```

Enforced at presign time (step 3 above). On quota breach, return 403 with remediation message.

---

## 16. Storefront integration

### 16.1 `cdnImage()` helper

New helper in `packages/core/src/media/cdn.ts`:

```ts
// Signature (no implementation — spec only)
export function cdnImage(
  asset: { cdn_url: string; variants_json?: Record<string, string> },
  opts: {
    width?: number          // target width in CSS pixels
    height?: number
    format?: 'auto' | 'webp' | 'avif' | 'jpeg' | 'png'
    quality?: number         // 40-95
    crop?: 'center' | 'top' | 'bottom' | 'left' | 'right' | 'entropy'
    fit?: 'cover' | 'contain' | 'fill' | 'inside' | 'outside'
    dpr?: 1 | 2 | 3          // device pixel ratio
  }
): string
```

Returns `cdn.gbox.co/shops/.../img.jpg?w=800&f=webp&q=80`.

### 16.2 `<Image>` component (Astro)

Default used across storefront:

```astro
<!-- packages/storefront/src/components/Image.astro -->
<img
  src={cdnImage(asset, { width: 800 })}
  srcset={`
    ${cdnImage(asset, { width: 400 })} 400w,
    ${cdnImage(asset, { width: 800 })} 800w,
    ${cdnImage(asset, { width: 1200 })} 1200w,
    ${cdnImage(asset, { width: 1600 })} 1600w
  `}
  sizes="(max-width: 768px) 100vw, 50vw"
  width={asset.width}
  height={asset.height}
  loading={loading ?? 'lazy'}
  decoding="async"
  alt={asset.alt}
  style={`background-color: ${asset.dominant_color ?? '#eee'}`}
/>
```

### 16.3 `<head>` preconnect hints

Every storefront page:

```html
<link rel="preconnect" href="https://cdn.gbox.co" crossorigin />
<link rel="dns-prefetch" href="https://cdn.gbox.co" />
```

First in-viewport product image also gets:

```html
<link rel="preload" as="image" href={heroImageUrl} imagesrcset="..." imagesizes="..." />
```

### 16.4 Lazy loading

Below-the-fold images get `loading="lazy"`. The first hero image always gets `loading="eager"` and `fetchpriority="high"` (LCP optimization).

### 16.5 Blurhash placeholder

While image loads, render 20-byte blurhash as CSS gradient via inline SVG or canvas decode. Eliminates the gray flash.

---

## 17. Edge cache for storefront HTML

Mirrors Shopify's CDN-level HTML cache. Lives on the **storefront Cloudflare zone**
(`tw3.store`/custom seller domains), not the `cdn.gbox.co` media zone.

### 17.1 Cache rules (Cloudflare Cache Rules on storefront zone)

Storefront zone origin = Astro SSR on our VPS (or ECS). Cache rules:

| Path | Behavior |
|---|---|
| `/products/*` | Cache 300s, SWR 1800s |
| `/collections/*` | Cache 300s |
| `/pages/*` | Cache 3600s |
| `/blogs/*` + `/blogs/*/posts/*` | Cache 3600s |
| `/` (home) | Cache 60s |
| `/cart` | No cache |
| `/checkout/*` | No cache |
| `/account/*` | No cache |
| `/api/*` | No cache |

### 17.2 Cache key

Include:
- URL path
- Query strings: `variant`, `color`, `size`, `page`, `sort`
- Cookies: `currency`, `language`

Exclude:
- `cart_token`, `customer_session_token` — bypass cache if present
- UTM params (`utm_*`) — strip for cache key but pass to origin
- Session cookies

### 17.3 Cache bypass

Backend sends `Cache-Control: private, no-store` when:
- User is authenticated (cookie `customer_session`)
- Cart has items (cookie `cart_items_count > 0`)
- Response contains user-specific data

### 17.4 Cache invalidation

- Product update → publish event to queue → invalidation worker calls Cloudflare Purge API: `POST /zones/{zone_id}/purge_cache` with `{ "prefixes": ["shop.tw3.store/products/{handle}"] }`.
- Collection update → purge prefix `/collections/{handle}`.
- Bulk cache bust (theme republish) → single `{ "purge_everything": true }` (allowed once/min per zone).

Cloudflare Purge API is free and unlimited (unlike CloudFront's $0.005/path above 1000). Batch by
enqueueing purges in a 10s debounce window and sending a single multi-prefix request.

---

## 18. Monitoring + alerts

### 18.1 Metrics (combined CloudWatch + Cloudflare Analytics + Prometheus)

Stack:
- **AWS CloudWatch** — S3, SQS, ECS task metrics (imgproxy + ffmpeg workers), CRR replication lag.
- **Cloudflare Analytics API** — edge cache hit rate, zone-level 4xx/5xx, bandwidth, POP latency. Pulled every minute by a lightweight Node scraper → emitted as CloudWatch custom metrics so the single dashboard `gbox-media-pipeline` sees them all.
- **Prometheus** — imgproxy exposes `:8081/metrics`. Scraped by an in-cluster Prometheus → remote-written to CloudWatch (via YACE or Grafana Agent).

| Metric (source) | Alert threshold |
|---|---|
| Cloudflare `cache_hit_rate` (zone-level) | alarm < 85% for 15 min |
| Cloudflare `5xx_rate` | alarm > 1% for 5 min |
| Cloudflare `4xx_rate` | alarm > 10% for 15 min (excl. 404) |
| Cloudflare `edge_response_time_p99` | alarm > 1500ms |
| Cloudflare `origin_response_time_p99` | alarm > 2500ms |
| imgproxy `imgproxy_request_duration_seconds` (P99) | alarm > 2000ms |
| imgproxy `imgproxy_errors_total` rate | alarm > 5 req/min |
| imgproxy ECS `CPUUtilization` (service avg) | alarm > 80% for 10 min |
| ffmpeg-worker SQS `ApproximateNumberOfMessagesVisible` | alarm > 200 for 10 min |
| ffmpeg-worker SQS `ApproximateAgeOfOldestMessage` | alarm > 900s |
| ffmpeg-worker SQS DLQ `NumberOfMessagesSent` | alarm > 0 / 5 min |
| ffmpeg-worker ECS task `TaskFailedCount` | alarm > 0 |
| S3 `AllRequests` | informational |
| S3 `4xxErrors` | alarm > 1% / 5 min |
| S3 CRR `ReplicationLatency` (Primary→DR, per bucket) | alarm > 900s (breaches 15-min RTC SLA) |
| S3 CRR `BytesPendingReplication` | alarm > 5 GB for 15 min |
| SQS `ingestion-prod` `ApproximateNumberOfMessagesVisible` | alarm > 500 for 10 min |
| SQS `ingestion-prod` DLQ | alarm > 0 |
| BullMQ `active`/`waiting` (custom metric) | alarm `waiting > 1000` |

### 18.2 Structured logs (pino)

Every ingestion event logs:
```json
{
  "level": "info",
  "service": "media-worker",
  "worker": "image-variants",
  "asset_id": "...",
  "shop_id": "...",
  "owner_type": "product",
  "owner_id": "...",
  "duration_ms": 342,
  "output_bytes": 45678,
  "output_format": "webp",
  "input_bytes": 234567
}
```

CloudWatch Logs Insights queries saved for common investigations:
- "Top 10 shops by ingestion volume last 7 days"
- "All failed ingestion jobs with last_error"
- "P99 transform latency per image size bucket"

### 18.3 Cost alarm

Budget alert in AWS Budgets: $300/month. Trigger at 50% + 100%. God admin email.

---

## 19. Cost estimate (1000 shops, 500 products each, 1M pageview/month)

Assumptions:
- 500 products × 5 images × 2 MB = 5 GB per shop → 5 TB total.
- 10 videos × 200 MB = 2 GB per shop → 2 TB total.
- 1M pageviews → ~10M image requests (10 images/page) → 95% Cloudflare edge hit.
- Multi-region (§0 #7): 100% of storage is duplicated in `ap-northeast-1`. Replica is `STANDARD_IA` class.

| Line item | Qty | Unit | Monthly cost |
|---|---|---|---|
| S3 Standard storage, primary (5 TB hot) | 5120 GB | $0.025/GB SG | $128 |
| S3 Intelligent-Tiering, primary (2 TB warm avg) | 2048 GB | $0.0138/GB SG | $28 |
| S3 Standard-IA storage, **DR replica** (7 TB total) | 7168 GB | $0.0138/GB Tokyo | $99 |
| S3 PUT/LIST (primary) | 2.5M | $0.005/1000 | $13 |
| S3 Replication PUT (to DR) | 2M | $0.005/1000 | $10 |
| S3 CRR Replication Time Control (RTC) data transfer | ~3 TB/mo peak (new uploads) | $0.015/GB | $46 |
| S3 GET (origin, post-Cloudflare-cache) | 500K | $0.0004/1000 | $0.20 |
| S3 egress to Cloudflare (SEA) | 500 GB | $0.09/GB | $45 |
| Cloudflare Business plan (zone) | 1 zone | $200/mo flat | $200 |
| Cloudflare Argo Smart Routing (optional Enterprise) | — | $5/GB (first 1TB) | $0 (skip at this scale) |
| imgproxy ECS Fargate (2 baseline tasks × 1vCPU × 2GB × 730h) | 2 tasks | ~$36/task/mo | $72 |
| imgproxy peak burst (avg 3 extra tasks × 100h) | 300 task-hr | $0.05/task-hr | $15 |
| ffmpeg-worker ECS Fargate (avg 1 task × 4vCPU × 8GB × 300h) | 300 task-hr | $0.20/task-hr | $60 |
| SQS (ingestion + transcode queues) | <1M req/mo free tier | — | $0 |
| CloudWatch logs + metrics + dashboard | low volume | — | $15 |
| **Total** | | | **~$731/month** |

The move from "CloudFront+Lambda@Edge+MediaConvert, single region" to "Cloudflare + self-host
imgproxy+ffmpeg, multi-region" shifts cost in three ways:

- **Saved** ~$82/mo: no Lambda@Edge (saved $25), no MediaConvert (saved $22), no CloudFront request charges (saved $10). CF base plan ($200) replaces a big chunk of variable cost with flat.
- **Added** ~$541/mo: Cloudflare flat plan ($200), imgproxy ECS ($87), ffmpeg ECS ($60), **multi-region replication** (+$99 storage + $46 RTC + $10 replication PUTs = $155).
- **Net delta vs draft $272:** about **+$459/mo at 1000 shops**. Per-shop cost is ~$0.73/mo, still well inside merchant plan margins.

Scales: 10k shops ≈ $4,000-4,500/mo (imgproxy + ffmpeg + storage grow linearly; Cloudflare flat).
Shopify Plus charges $2k+/mo/store — margin holds.

**Optimization levers if cost hurts:**
1. Drop RTC on non-critical buckets (save ~$46/mo; replica SLA relaxes to "eventually").
2. Move replica to DEEP_ARCHIVE for infrequent DR drills (save 50% on replica storage; read cost spikes on failover).
3. Run imgproxy + ffmpeg on a reserved EC2 instance (m6g.2xlarge) instead of Fargate (~40% cheaper at 70%+ utilization).
4. Aggressive variant pre-generation + Cloudflare 1-year TTL (already planned).
5. Image-format downgrade on mobile (serve AVIF on 3G; ~30% size reduction).

---

## 20. Initialization — AWS CLI + Cloudflare commands

Thai can run these as a script. Assumes AWS CLI v2 configured with a sufficiently privileged user
and Cloudflare API token in `CF_API_TOKEN`.

### 20.0 Bucket-creation helper (enforces §4.5 replication)

Drop this into `scripts/create-bucket.sh` and use it for EVERY new bucket (prevents anyone
forgetting the DR replica):

```bash
#!/usr/bin/env bash
# Usage: create-bucket.sh <bucket_name> <primary_region> <dr_region> <kms_alias> <object_lock>
set -euo pipefail
BUCKET=$1; PRIMARY=$2; DR=$3; KMS=$4; LOCK=${5:-false}

aws s3api create-bucket --bucket "$BUCKET" --region "$PRIMARY" \
  --create-bucket-configuration LocationConstraint="$PRIMARY" \
  $( [[ $LOCK == true ]] && echo "--object-lock-enabled-for-bucket" )

aws s3api create-bucket --bucket "${BUCKET}-dr" --region "$DR" \
  --create-bucket-configuration LocationConstraint="$DR"

for B in "$BUCKET" "${BUCKET}-dr"; do
  aws s3api put-bucket-versioning --bucket "$B" --versioning-configuration Status=Enabled
  aws s3api put-public-access-block --bucket "$B" \
    --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
  aws s3api put-bucket-encryption --bucket "$B" --server-side-encryption-configuration "{
    \"Rules\": [{\"ApplyServerSideEncryptionByDefault\": {\"SSEAlgorithm\": \"aws:kms\", \"KMSMasterKeyID\": \"alias/$KMS\"}, \"BucketKeyEnabled\": true}]
  }"
done

# Replication rule primary -> dr (template from §4.5c with substitutions)
envsubst < templates/replication.json.tmpl > /tmp/repl.json
aws s3api put-bucket-replication --bucket "$BUCKET" \
  --replication-configuration file:///tmp/repl.json

echo "[ok] $BUCKET (primary=$PRIMARY, replica=${BUCKET}-dr in $DR)"
```

### 20.1 Set vars

```bash
export PRIMARY=ap-southeast-1
export DR=ap-northeast-1
export ACCT=$(aws sts get-caller-identity --query Account --output text)
export PUBLIC_BUCKET=gbox-public-media-prod
export THEME_BUCKET=gbox-theme-library-prod
export PRIVATE_BUCKET=gbox-private-prod
export BACKUP_BUCKET=gbox-backups-prod
export CF_ZONE=cdn.gbox.co
# CF_API_TOKEN provisioned manually in Cloudflare dashboard (scope: Zone:Read, Zone Settings:Edit, Cache Purge:Purge, DNS:Edit)
```

### 20.2 KMS keys (one per bucket family, in each region)

```bash
for REGION in $PRIMARY $DR; do
  for PURPOSE in gbox-public gbox-theme gbox-private gbox-backups; do
    KEY_ID=$(aws kms create-key --region $REGION \
      --description "Gbox $PURPOSE encryption ($REGION)" \
      --query KeyMetadata.KeyId --output text)
    aws kms create-alias --region $REGION \
      --alias-name "alias/${PURPOSE}-${REGION}" \
      --target-key-id "$KEY_ID"
  done
done
```

### 20.3 Create all 4 buckets + DR replicas

```bash
./scripts/create-bucket.sh $PUBLIC_BUCKET  $PRIMARY $DR gbox-public    false
./scripts/create-bucket.sh $THEME_BUCKET   $PRIMARY $DR gbox-theme     false
./scripts/create-bucket.sh $PRIVATE_BUCKET $PRIMARY $DR gbox-private   false
./scripts/create-bucket.sh $BACKUP_BUCKET  $PRIMARY $DR gbox-backups   true
```

(The `true` on backups enables Object Lock at creation time.)

### 20.4 Lifecycle + Object Lock

```bash
aws s3api put-bucket-lifecycle-configuration --bucket $PUBLIC_BUCKET  --lifecycle-configuration file://lifecycle-public.json
aws s3api put-bucket-lifecycle-configuration --bucket $THEME_BUCKET   --lifecycle-configuration file://lifecycle-theme.json
aws s3api put-bucket-lifecycle-configuration --bucket $PRIVATE_BUCKET --lifecycle-configuration file://lifecycle-private.json
aws s3api put-bucket-lifecycle-configuration --bucket $BACKUP_BUCKET  --lifecycle-configuration file://lifecycle-backups.json

# Same lifecycle also applied to DR replicas (cheaper storage classes still tier).
for B in $PUBLIC_BUCKET $THEME_BUCKET $PRIVATE_BUCKET $BACKUP_BUCKET; do
  aws s3api put-bucket-lifecycle-configuration --bucket "${B}-dr" --region $DR --lifecycle-configuration file://lifecycle-${B}.json
done

# Object Lock retention on backups (already enabled at creation)
aws s3api put-object-lock-configuration --bucket $BACKUP_BUCKET --object-lock-configuration '{
  "ObjectLockEnabled": "Enabled",
  "Rule": { "DefaultRetention": { "Mode": "GOVERNANCE", "Days": 30 } }
}'
```

### 20.5 CORS (public + theme only)

```bash
aws s3api put-bucket-cors --bucket $PUBLIC_BUCKET --cors-configuration file://cors-public.json
aws s3api put-bucket-cors --bucket $THEME_BUCKET  --cors-configuration file://cors-theme.json
```

### 20.6 Bucket policies (Cloudflare IP allow + DenyInsecureTransport)

Save §5.4 JSON (policy-public.json, policy-theme.json, policy-private.json, policy-backups.json) with
placeholder substitutions, then:

```bash
aws s3api put-bucket-policy --bucket $PUBLIC_BUCKET  --policy file://policy-public.json
aws s3api put-bucket-policy --bucket $THEME_BUCKET   --policy file://policy-theme.json
aws s3api put-bucket-policy --bucket $PRIVATE_BUCKET --policy file://policy-private.json
aws s3api put-bucket-policy --bucket $BACKUP_BUCKET  --policy file://policy-backups.json
```

### 20.7 IAM roles + users (via CloudFormation or console)

Templates: `docs/infra/s3/iam-*.json` (listed in Appendix A). Create:

- `GboxBackendRole` + instance profile (attach to ECS task defs that run store-admin, storefront).
- `GboxIngestionWorkerRole` + instance profile (attach to ingestion ECS task def).
- `GboxImgproxyRole` + instance profile (attach to imgproxy Fargate task def).
- `GboxFfmpegWorkerRole` + instance profile (attach to ffmpeg-worker Fargate task def).
- `GboxS3ReplicationRole` (S3 service trust).
- `GboxPlatformAdminUser` (IAM user, MFA enabled).
- `GboxGitHubActionsRole` (OIDC federation, trust policy locked to `repo:GBox-Company/*`).

### 20.8 Cloudflare zone setup

```bash
# Create / verify zone
curl -s https://api.cloudflare.com/client/v4/zones \
  -H "Authorization: Bearer $CF_API_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"name":"cdn.gbox.co","account":{"id":"<cf_account_id>"},"type":"full"}'

# Set SSL mode = Full (strict)
curl -s -X PATCH "https://api.cloudflare.com/client/v4/zones/<zone_id>/settings/ssl" \
  -H "Authorization: Bearer $CF_API_TOKEN" --data '{"value":"strict"}'

# Turn on HTTP/3, Brotli, IPv6
for S in http3 brotli ipv6; do
  curl -s -X PATCH "https://api.cloudflare.com/client/v4/zones/<zone_id>/settings/$S" \
    -H "Authorization: Bearer $CF_API_TOKEN" --data '{"value":"on"}'
done

# Disable Image Resizing (we self-host)
curl -s -X PATCH "https://api.cloudflare.com/client/v4/zones/<zone_id>/settings/polish" \
  -H "Authorization: Bearer $CF_API_TOKEN" --data '{"value":"off"}'
```

### 20.9 Cloudflare Origin Rules + Cache Rules

Use Terraform `cloudflare_ruleset` (snippets in `docs/infra/cloudflare/origin-rules.tf`) or the
dashboard UI. Rules enumerated in §10.2 + §10.3. Each rule stores an origin override or cache
decision; order matters.

### 20.10 Cloudflare Origin CA cert (for imgproxy NLB + storefront origin)

```bash
# Mint origin CA cert (15-year default)
curl -s https://api.cloudflare.com/client/v4/certificates \
  -H "Authorization: Bearer $CF_API_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{
    "hostnames": ["imgproxy.internal.gbox.co", "origin.storefront.gbox.co"],
    "request_type": "origin-rsa",
    "requested_validity": 5475,
    "csr": "<paste_csr_pem>"
  }'
# Save the returned cert + private key to AWS Secrets Manager:
aws secretsmanager create-secret \
  --name gbox/cloudflare/origin-ca \
  --secret-string '{"cert":"...","key":"..."}'
```

### 20.11 SQS queues (ingestion + transcode)

```bash
aws sqs create-queue --queue-name gbox-ingestion-prod --attributes "{
  \"VisibilityTimeout\": \"900\",
  \"MessageRetentionPeriod\": \"1209600\",
  \"RedrivePolicy\": \"{\\\"deadLetterTargetArn\\\":\\\"arn:aws:sqs:$PRIMARY:$ACCT:gbox-ingestion-prod-dlq\\\",\\\"maxReceiveCount\\\":\\\"3\\\"}\"
}"

aws sqs create-queue --queue-name gbox-transcode-prod --attributes "{
  \"VisibilityTimeout\": \"1800\",
  \"MessageRetentionPeriod\": \"1209600\",
  \"RedrivePolicy\": \"{\\\"deadLetterTargetArn\\\":\\\"arn:aws:sqs:$PRIMARY:$ACCT:gbox-transcode-prod-dlq\\\",\\\"maxReceiveCount\\\":\\\"3\\\"}\"
}"

# DLQs
aws sqs create-queue --queue-name gbox-ingestion-prod-dlq --attributes MessageRetentionPeriod=1209600
aws sqs create-queue --queue-name gbox-transcode-prod-dlq --attributes MessageRetentionPeriod=1209600
```

### 20.12 S3 event notifications → SQS

```bash
cat > notifications.json <<EOF
{
  "QueueConfigurations": [
    {
      "Id": "source-uploaded-to-videos",
      "QueueArn": "arn:aws:sqs:$PRIMARY:$ACCT:gbox-transcode-prod",
      "Events": ["s3:ObjectCreated:*"],
      "Filter": { "Key": { "FilterRules": [
        { "Name": "prefix", "Value": "shops/" },
        { "Name": "suffix", "Value": "/source.mp4" }
      ] } }
    },
    {
      "Id": "image-uploaded-for-variants",
      "QueueArn": "arn:aws:sqs:$PRIMARY:$ACCT:gbox-ingestion-prod",
      "Events": ["s3:ObjectCreated:*"],
      "Filter": { "Key": { "FilterRules": [
        { "Name": "prefix", "Value": "shops/" }
      ] } }
    }
  ]
}
EOF
aws s3api put-bucket-notification-configuration --bucket $PUBLIC_BUCKET \
  --notification-configuration file://notifications.json
```

### 20.13 ECS Fargate services (imgproxy + ffmpeg-worker)

Use Terraform (`docs/infra/ecs/`) or `docs/infra/cloudformation/`. Outline:

```bash
# Cluster
aws ecs create-cluster --cluster-name gbox-media-prod --region $PRIMARY

# imgproxy task def + service (from docs/infra/ecs/imgproxy.json)
aws ecs register-task-definition --cli-input-json file://docs/infra/ecs/imgproxy-taskdef.json
aws ecs create-service --cluster gbox-media-prod \
  --service-name imgproxy \
  --task-definition gbox-imgproxy:1 \
  --desired-count 2 \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[subnet-xxx,subnet-yyy],securityGroups=[sg-imgproxy],assignPublicIp=DISABLED}" \
  --load-balancers "targetGroupArn=arn:aws:elasticloadbalancing:...:targetgroup/imgproxy/...,containerName=imgproxy,containerPort=8080"

# ffmpeg-worker task def + service
aws ecs register-task-definition --cli-input-json file://docs/infra/ecs/ffmpeg-worker-taskdef.json
aws ecs create-service --cluster gbox-media-prod \
  --service-name ffmpeg-worker \
  --task-definition gbox-ffmpeg-worker:1 \
  --desired-count 1 \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[subnet-xxx,subnet-yyy],securityGroups=[sg-ffmpeg],assignPublicIp=DISABLED}"
```

### 20.14 Verify end-to-end

```bash
# 1. Upload a test image through backend API (signs PUT URL).
# 2. Fetch via Cloudflare:
curl -I "https://cdn.gbox.co/shops/test/misc/hello.jpg?w=800"
#   Expect: 200, Content-Type: image/webp (Accept negotiated), Cf-Cache-Status: MISS (first), HIT (second)

# 3. Upload a test video, wait ~30s, fetch HLS manifest:
curl -I "https://cdn.gbox.co/shops/test/videos/sample/master.m3u8"
#   Expect: 200, Content-Type: application/vnd.apple.mpegurl

# 4. Verify CRR:
aws s3api head-object --bucket "$PUBLIC_BUCKET-dr" --region $DR --key shops/test/misc/hello.jpg
#   Expect: object present, ReplicationStatus: REPLICA
```

### 20.15 Environment variables for backend

Add to `.env.prod`:

```bash
AWS_REGION=ap-southeast-1
AWS_DR_REGION=ap-northeast-1
S3_PUBLIC_BUCKET=gbox-public-media-prod
S3_THEME_LIBRARY_BUCKET=gbox-theme-library-prod
S3_PRIVATE_BUCKET=gbox-private-prod
S3_BACKUPS_BUCKET=gbox-backups-prod
CDN_PUBLIC_BASE_URL=https://cdn.gbox.co
CDN_THEME_LIBRARY_BASE_URL=https://cdn.gbox.co
# imgproxy signing (mirrors IMGPROXY_KEY/SALT on the container)
IMGPROXY_KEY=<from Secrets Manager>
IMGPROXY_SALT=<from Secrets Manager>
# Queues
SQS_INGESTION_QUEUE_URL=https://sqs.ap-southeast-1.amazonaws.com/.../gbox-ingestion-prod
SQS_TRANSCODE_QUEUE_URL=https://sqs.ap-southeast-1.amazonaws.com/.../gbox-transcode-prod
# Cloudflare
CF_ZONE_ID=<zone_id>
CF_API_TOKEN=<purge+read scope>
# Access keys via IAM Role (preferred) OR:
AWS_ACCESS_KEY_ID=AKIA...
AWS_SECRET_ACCESS_KEY=...
```

---

## 21. Migration from R2 → full cutover to S3

Per §0 decision 1: S3 is the single primary. R2 is retired after cutover — we do not keep a
permanent dual-write layer. The migration is a one-way shift; a rollback to R2-primary is a manual
ops action, not a supported runtime mode.

### 21.1 Pre-cutover (P1 weeks 1-2)

- S3 buckets + Cloudflare zone + imgproxy + ffmpeg infra all live (§20).
- `ObjectStore` has **two drivers** compiled in: `R2Driver` (existing) and `S3Driver` (new).
- Driver selection is env-flagged per-service: `OBJECT_STORE_DRIVER=r2|s3|dual`.
- `dual` mode = write S3 first, mirror to R2 on success (best-effort). Reads = S3 first, fall back to R2 on 404.
- Env default in prod: still `r2` during P1. Flip to `dual` once §21.2 bulk sync completes.

### 21.2 Bulk sync (P1 week 2, weekend)

One-shot `rclone sync` from R2 → S3 primary bucket, then trigger CRR to catch up DR replica.

```bash
# Run from a c7g.2xlarge EC2 instance in ap-southeast-1 (zero egress for S3 write).
rclone sync \
  r2://gbox-prod \
  s3://gbox-public-media-prod/ \
  --fast-list \
  --transfers 32 \
  --checkers 64 \
  --s3-upload-concurrency 8 \
  --progress \
  --log-file=sync-$(date +%F).log
```

Estimated time for current R2 dataset (~200 GB of theme + POD): ~30 min inside
ap-southeast-1. Re-run once more after ≤1h to pick up any new writes.

### 21.3 Dual-write window (P1 week 3)

- Flip `OBJECT_STORE_DRIVER=dual` in prod env.
- Every new `put()` writes S3 (authoritative) + R2 (shadow mirror, fire-and-forget).
- Every `get()` tries S3, falls back to R2 on 404 (shouldn't happen post-sync, but belt-and-suspenders).
- Monitor `dual_mode_fallback_total` metric for 7 days. Zero fallbacks = safe to cut over.

### 21.4 Cutover (P1 week 4, Tuesday 2am SGT)

- Flip `OBJECT_STORE_DRIVER=s3` in prod env. R2 no longer read or written.
- Re-run `rclone sync` one last time (capture any drift from the dual-write window).
- Keep R2 bucket read-only for **30 days** as break-glass fallback. After 30 days of clean S3 ops, delete R2 bucket + cancel R2 subscription.
- Remove `R2Driver` import from `ObjectStore` in the PR that follows (dead code removal).

### 21.5 What if we need to fall back to R2?

Emergency runbook (`docs/runbooks/s3-to-r2-rollback.md`, written in P1):

1. `rclone sync s3://gbox-public-media-prod/ r2://gbox-prod` — catch R2 up to latest S3 state.
2. Flip `OBJECT_STORE_DRIVER=r2` in prod env.
3. Restart all services.
4. `cdn.gbox.co` Cloudflare origin rule flipped to `r2.gbox.co` (keep rule as a disabled template).

This is intentionally manual — we do not want silent fallback masking S3 outages that should page the team.

---

## 22. Rollout phases + acceptance criteria

### Phase 1 (week 1-2): Bucket infra + S3 adapter + Cloudflare zone + multi-region CRR

Deliverables:
- All 4 prod buckets + 4 staging buckets created via `scripts/create-bucket.sh` (§20.0)
- **DR replicas `*-dr` in `ap-northeast-1` + CRR rules active** (§4.5)
- IAM roles + policies attached per §5 (`GboxBackendRole`, `GboxIngestionWorkerRole`, `GboxImgproxyRole`, `GboxFfmpegWorkerRole`, `GboxS3ReplicationRole`)
- **Cloudflare zone `cdn.gbox.co`** + Origin Rules + Cache Rules (§10)
- `ObjectStore` gets a new S3 driver alongside R2 driver; env flag `OBJECT_STORE_DRIVER`
- Lambda on weekly EventBridge to refresh Cloudflare IP allow list in S3 bucket policies (§5.4)

Acceptance:
- ✅ `curl -I https://cdn.gbox.co/shops/test/misc/hello.txt` returns 200 with correct headers
- ✅ Backend can put + get from all 4 buckets via IAM role
- ✅ S3 public bucket is NOT directly reachable (`https://s3.../bucket/key` returns 403; only `Cf-Edge-IP` + `User-Agent` match succeed)
- ✅ Object uploaded to primary appears in `-dr` replica within 15 min (RTC SLA)
- ✅ `aws s3api get-bucket-replication` returns `Status: Enabled` for all 4 primary buckets
- ✅ Cloudflare `Cf-Cache-Status: HIT` on second request
- ✅ Unit tests: `object-store.s3.test.ts` covers put/get/delete/presign

### Phase 2 (week 3-5): Product image ingestion + imgproxy

Deliverables:
- Migration 047 (`media_assets`, `media_ingestion_jobs`)
- Admin UI: new `<MediaUpload>` component with direct-to-S3 presigned PUT
- BullMQ workers: virus-scan, image-variants, blurhash, exif-strip, dominant-color
- **imgproxy ECS Fargate service** (primary + DR at min-0) per §11.2
- **`cdnImage()` helper** + Astro `<Image>` component with `srcset` per §16
- `product_images` view over `media_assets`

Acceptance:
- ✅ Merchant uploads image → becomes available on CDN within 30s
- ✅ Storefront `<img>` includes `srcset`, `loading="lazy"`, `width`/`height`, `blurhash` placeholder
- ✅ `cdn.gbox.co/img/<sig>/rs:fit:800:0/f:webp/<src>` returns a WebP at 800px wide
- ✅ Unsigned request to imgproxy URL returns 403
- ✅ Cloudflare cache-hit rate > 90% on second request for same variant
- ✅ EXIF GPS stripped (verify with `exiftool`)
- ✅ ClamAV rejects EICAR test file
- ✅ Quota enforcement: `.../presign` returns 403 when shop over quota
- ✅ Legacy `product_images.src` still reads correctly via the view

### Phase 3 (week 6-7): Theme assets per shop

Deliverables:
- Theme publish flow writes to `shops/{s}/themes/{t}/{version}/...`
- Old R2 theme assets migrated
- Visual editor preview reads from S3

Acceptance:
- ✅ Publish theme → assets available at versioned URL in < 5s
- ✅ Previous version remains accessible (rollback path)
- ✅ Theme asset Cache-Control is `immutable` + 1y TTL

### Phase 4 (week 8-9): Theme Library

Deliverables:
- `gbox-theme-library-prod` bucket populated with 5 seed themes
- God-admin UI: theme library manager (upload theme.zip, screenshots, preview)
- Seller UI: theme library browse + activate
- CI: GitHub Actions role publishes new theme versions

Acceptance:
- ✅ God admin uploads a theme → it appears in the library within 60s
- ✅ Seller activates → gets a private copy in their shop in < 10s
- ✅ Seller's copy is independent (edits don't affect library master)
- ✅ `themes/{slug}/latest.json` is atomically updated on publish

### Phase 5 (week 10-12): Videos (self-hosted ffmpeg)

Deliverables:
- **ffmpeg-worker ECS Fargate service** (primary + DR at min-0) per §12.3
- BullMQ queue `gbox-transcode-prod` + SQS event wiring (S3 → SQS on `source.mp4` upload)
- Upload flow: presigned multipart PUT to `shops/{s}/videos/{v}/source.{ext}`
- Storefront `<video>` with HLS playback + `hls.js` shim

Acceptance:
- ✅ Upload MP4 → HLS master playlist + 4 renditions + poster + 10 thumbs within 5 min
- ✅ `aws sqs get-queue-attributes` shows `ApproximateNumberOfMessagesVisible == 0` between uploads
- ✅ Storefront video plays on Safari + Chrome + Firefox + iOS + Android
- ✅ Adaptive bitrate works (throttle net in devtools, watch resolution drop)
- ✅ Per-video encode cost tracked in CloudWatch (target < $0.05/video)

### Phase 6 (week 13-14): Reviews, blog, email, misc

Deliverables:
- Review moderation flow (pending → approved tag flip)
- Blog article editor with image upload
- Email template asset upload
- Shop misc (logo/favicon/banners)

Acceptance:
- ✅ Customer uploads review photo → pending (not visible on storefront)
- ✅ Admin approves → image tag flips to `approved`, goes live immediately
- ✅ Email sent to test inbox includes CDN image that loads

### Phase 7 (week 15-17): Private pipeline

Deliverables:
- Digital download tokens + signed URL
- Invoice PDF generation + storage
- Merchant exports
- POD migration from R2

Acceptance:
- ✅ Customer buys digital product → receives email with download link
- ✅ Link works exactly 5 times then 403s
- ✅ Admin can regenerate token
- ✅ Invoice PDF generated on order complete, retrievable by customer + admin
- ✅ CSV export of 10k products completes in < 60s, downloaded via signed URL
- ✅ POD files served from S3 private (parity with R2 behavior)

### Phase 8 (week 18-19): Backups + storefront edge cache + monitoring + DR drill

Deliverables:
- Daily Postgres dump → `gbox-backups-prod` (lifecycle: Glacier at 180d, Deep Archive at 730d)
- Theme snapshot on publish → backups bucket
- App log rotation → backups bucket
- **Cloudflare zone for storefront** (`tw3.store` + custom seller domains) with Cache Rules (§17)
- Combined CloudWatch + Cloudflare dashboard (§18)
- **DR failover drill runbook** (§4.5e) — rehearsed once

Acceptance:
- ✅ Backup runs daily at 02:00 ICT, completes in < 30 min
- ✅ Restore from backup smoke-tested (single product recovered)
- ✅ Storefront `/products/X` has `Cf-Cache-Status: HIT` on second anonymous request
- ✅ Dashboard shows live metrics (edge cache hit rate, CRR lag, imgproxy latency, ffmpeg queue depth)
- ✅ All alarms fire correctly in game-day simulation
- ✅ DR drill: flip Cloudflare origin to `-dr` bucket, serve 100 test requests, flip back; RTO < 10 min

---

## 23. Decisions log (resolved 2026-04-18)

Originally "Open questions" — closed by Thai. Canonical source is §0 table; this section keeps the
longer rationale on each decision in case we ever want to revisit.

| # | Question | Decision | Rationale |
|---|---|---|---|
| 1 | R2 vs S3 primary? | **S3 primary, sync everything to S3.** R2 retired after cutover. | Thai already provisioned AWS. Single source of truth simplifies ops. R2 stays on the bench for emergency rollback only. |
| 2 | CloudFront vs Cloudflare? | **Cloudflare.** | HCMC POP, existing DNS already on Cloudflare, unlimited purge API, no Lambda@Edge lock-in. Loss of Lambda@Edge is a non-issue since we self-host imgproxy (decision 3). |
| 3 | Lambda@Edge vs self-host imgproxy? | **Self-host imgproxy** on ECS Fargate. | §0 decision 2 removed Lambda@Edge as an option. imgproxy is the obvious self-host pick — battle-tested, single binary, signed URLs, libvips perf. |
| 4 | MediaConvert vs self-host ffmpeg? | **Self-host ffmpeg** BullMQ workers. | No per-minute bill. Tune the ladder for our device mix. Transparent ops. |
| 5 | Quota tiers — match pricing plans? | **Placeholder (Shopify defaults) for now.** Thai will tune later. | Don't block P1 on pricing spec. §15.5 numbers are sane defaults. |
| 6 | Theme version retention? | **Keep published versions forever** (match Shopify). Purge drafts / unused versions after 90 days. | Rollback path is a core theme feature. Cost is negligible — themes are tiny compared to product media. |
| 7 | Multi-region DR from start? | **Yes — CRR primary → `ap-northeast-1` (Tokyo) on every bucket, from day one.** Every new bucket added in later phases follows the same template (§4.5). | Adding CRR retroactively is painful (must recopy all history). Cost is ~$155/mo at 1000-shop scale — acceptable for DR + faster reads. |

Revisit policy: if any of these need to change, it requires a new spec dated after 2026-04-18 and
Thai sign-off, not an in-place edit here.

---

## 24. Out of scope (future specs)

- Image editor inside admin (crop, rotate, filter) → separate spec
- Video trim / chapters → separate spec
- CDN cache invalidation UI (merchant-triggered purge) → low priority
- Hotlink prevention (Cloudflare Firewall Rule on Referer) → separate spec
- Per-shop CDN custom domain (`cdn.acmeshop.vn`) → separate spec
- **Multi-region active-active** (synchronous writes to both regions) — separate spec. P1 is active-passive (primary writes, replica async).
- Edge-side personalization (variant pricing per geography) → separate spec
- Cloudflare R2 as secondary origin (current R2 is retired in §21; re-introducing it would be a new spec)

---

## Appendix A — Reference JSON files

Save these as actual files in a new folder `docs/infra/` when implementing. Each file is the JSON
shown inline in §4.5, §5-8 with placeholders replaced (`{account_id}`, `{primary_kms_key_id}`,
`{dr_kms_key_id}`, `{zone_id}`, DNS names as deployed).

**S3:**
- `docs/infra/s3/lifecycle-public.json`
- `docs/infra/s3/lifecycle-theme.json`
- `docs/infra/s3/lifecycle-private.json`
- `docs/infra/s3/lifecycle-backups.json`
- `docs/infra/s3/lifecycle-noncurrent-versions.json` *(shared rule applied to all 4 buckets — §9)*
- `docs/infra/s3/replication-public.json` *(one per bucket — §4.5c)*
- `docs/infra/s3/replication-theme.json`
- `docs/infra/s3/replication-private.json`
- `docs/infra/s3/replication-backups.json`
- `docs/infra/s3/cors-public.json`
- `docs/infra/s3/cors-theme.json`
- `docs/infra/s3/policy-public.json`
- `docs/infra/s3/policy-theme.json`
- `docs/infra/s3/policy-private.json`
- `docs/infra/s3/policy-backups.json`

**IAM:**
- `docs/infra/iam/backend-role.json`
- `docs/infra/iam/ingestion-worker-role.json`
- `docs/infra/iam/imgproxy-role.json`            *(replaces old `iam-lambda-transform-role.json`)*
- `docs/infra/iam/ffmpeg-worker-role.json`       *(replaces old MediaConvert role)*
- `docs/infra/iam/s3-replication-role.json`
- `docs/infra/iam/github-actions-role.json`

**Cloudflare (Terraform):**
- `docs/infra/cloudflare/zone.tf`
- `docs/infra/cloudflare/origin-rules.tf`
- `docs/infra/cloudflare/cache-rules.tf`
- `docs/infra/cloudflare/transform-rules.tf`
- `docs/infra/cloudflare/workers.tf`

**ECS task definitions:**
- `docs/infra/ecs/imgproxy-taskdef.json`
- `docs/infra/ecs/ffmpeg-worker-taskdef.json`

**Templates (for scripts/create-bucket.sh):**
- `docs/infra/templates/replication.json.tmpl`

These are intentionally **not** committed in this spec commit — they're template placeholders for
the implementation phase.

---

## Change log

- 2026-04-18: Initial draft (Thai + Claude). Status: Draft — pending owner approval.
- 2026-04-18 (same day, later): Decisions locked by Thai. Status: **Approved**. Major rewrites:
  - §0 added — decision log, source of truth for all 7 previously-open questions.
  - §2 scope table updated — CloudFront→Cloudflare, MediaConvert→self-host ffmpeg.
  - §4.1 bucket table updated to reflect Cloudflare as the edge.
  - **§4.5 new** — multi-region CRR template, region pairing (Singapore↔Tokyo), replica bucket naming, replication config, `GboxS3ReplicationRole` policy, failover runbook outline.
  - §5 IAM principals rewritten: removed `GboxLambdaImageTransformRole`, `GboxMediaConvertRole`, `GboxCloudFrontOAI`; added `GboxImgproxyRole`, `GboxFfmpegWorkerRole`, `GboxS3ReplicationRole`. Added §5.3a, §5.3b policies.
  - §5.4 bucket policies rewritten: Cloudflare IP allow + `User-Agent` guard + `DenyInsecureTransport` (no OAI).
  - §9 versioning — added CRR-required rationale + noncurrent-version lifecycle.
  - §10 rewritten — Cloudflare zone, Origin Rules, Cache Rules, Workers (signed URLs, header injection, fallback placeholder), purge via CF API.
  - §11 rewritten — self-host `imgproxy` on ECS Fargate, deployment + env vars + URL grammar + width normalization + pre-warming + two-tier cache + signed URLs.
  - §12 rewritten — self-host `ffmpeg` BullMQ workers on ECS Fargate, Dockerfile, autoscaling, cost control.
  - §17 — storefront HTML edge cache moved from CloudFront to a separate Cloudflare zone.
  - §18 — metrics revised: Cloudflare Analytics + imgproxy Prometheus + ECS task metrics + CRR lag; removed CloudFront/Lambda@Edge/MediaConvert metrics.
  - §19 cost — revised to ~$731/mo at 1000 shops (was ~$272). Delta +$459/mo: Cloudflare plan flat, imgproxy + ffmpeg ECS, multi-region replication storage + RTC.
  - §20 rewritten — added `create-bucket.sh` helper that enforces CRR, KMS keys per region, ECS + SQS + S3-event init, Cloudflare zone + Origin CA cert provisioning.
  - §21 rewritten — R2 is fully retired; dual-write is a transient window, not a steady state. Rollback is a manual runbook.
  - §22 Phase 1, 2, 5, 8 acceptance criteria updated for Cloudflare + multi-region + imgproxy + ffmpeg-worker.
  - §23 Open Questions → Decisions Log (all resolved).
  - §24 Out-of-scope — removed "multi-region active-passive" (now in scope), added "multi-region active-active" as the remaining future work.
  - Appendix A — reference files list expanded to include CRR, ECS, Cloudflare Terraform.
