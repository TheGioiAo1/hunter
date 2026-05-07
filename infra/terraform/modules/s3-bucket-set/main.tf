# ---------------------------------------------------------------------------
# Module: s3-bucket-set
#
# Creates 4 S3 buckets per environment — public-media, theme-library,
# private, backups — plus every attached resource (public-access-block,
# versioning, CORS, lifecycle, bucket policy, replication config).
#
# Why one module for all four instead of four separate modules:
#   1. They share policy + CORS defaults per env,
#   2. The CRR configuration spans the set (primary → DR twin),
#   3. The caller names every bucket consistently with `gbox-<role>-<env><suffix>`.
#
# Shape of resulting bucket names (with suffix = "" for primary,
# "-dr" for DR):
#   gbox-public-media-prod
#   gbox-theme-library-prod-dr
#   gbox-private-staging
#   gbox-backups-dev
# ---------------------------------------------------------------------------

locals {
  name_suffix = var.suffix == "" ? var.env : "${var.env}${var.suffix}"

  bucket_names = {
    public_media  = "gbox-public-media-${local.name_suffix}"
    theme_library = "gbox-theme-library-${local.name_suffix}"
    private       = "gbox-private-${local.name_suffix}"
    backups       = "gbox-backups-${local.name_suffix}"
  }

  common_tags = merge(var.tags, {
    Environment = var.env
    ManagedBy   = "Terraform"
    Module      = "s3-bucket-set"
    Region      = var.region
  })
}

# ---------------------------------------------------------------------------
# Bucket creation
# ---------------------------------------------------------------------------

resource "aws_s3_bucket" "public_media" {
  bucket = local.bucket_names.public_media

  # Prevent accidental deletion of prod data. Override explicitly with
  # `terraform apply -var force_destroy=true` if you really mean it.
  force_destroy = var.env != "prod"

  tags = merge(local.common_tags, {
    Role = "public-media"
  })
}

resource "aws_s3_bucket" "theme_library" {
  bucket        = local.bucket_names.theme_library
  force_destroy = var.env != "prod"

  tags = merge(local.common_tags, {
    Role = "theme-library"
  })
}

resource "aws_s3_bucket" "private" {
  bucket        = local.bucket_names.private
  force_destroy = var.env != "prod"

  tags = merge(local.common_tags, {
    Role = "private"
  })
}

resource "aws_s3_bucket" "backups" {
  bucket        = local.bucket_names.backups
  force_destroy = var.env != "prod"

  tags = merge(local.common_tags, {
    Role = "backups"
  })
}

# ---------------------------------------------------------------------------
# Public access block — tightens the default S3 guardrails.
#
# S3 has 4 independent switches:
#   block_public_acls       → reject PUT-Object ACLs that make objects public
#   block_public_policy     → reject PutBucketPolicy if policy is "public"
#   ignore_public_acls      → silently ignore any existing public ACLs
#   restrict_public_buckets → if policy is public, treat bucket as private
#                             (only account root & policy principals can access)
#
# For public_media + theme_library: the bucket policy uses Principal: "*"
# with aws:UserAgent + aws:SourceIp conditions to gate Cloudflare/imgproxy
# egress. S3 classifies this as a "public" policy (it doesn't reason about
# the conditions), so block_public_policy = true would reject the
# PutBucketPolicy call with AccessDenied. Same for restrict_public_buckets.
#
# We keep block_public_acls + ignore_public_acls = true on all 4 buckets so
# ACL-based exposure is still impossible even if someone accidentally PUTs
# an object with public-read ACL.
#
# private + backups keep all 4 = true (they never get a public-ish policy).
# ---------------------------------------------------------------------------

resource "aws_s3_bucket_public_access_block" "public_media" {
  bucket                  = aws_s3_bucket.public_media.id
  block_public_acls       = true
  block_public_policy     = false # policy uses Principal:* + UA/IP conditions
  ignore_public_acls      = true
  restrict_public_buckets = false # see comment above
}

resource "aws_s3_bucket_public_access_block" "theme_library" {
  bucket                  = aws_s3_bucket.theme_library.id
  block_public_acls       = true
  block_public_policy     = false # policy uses Principal:* + UA/IP conditions
  ignore_public_acls      = true
  restrict_public_buckets = false # see comment above
}

resource "aws_s3_bucket_public_access_block" "private" {
  bucket                  = aws_s3_bucket.private.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_public_access_block" "backups" {
  bucket                  = aws_s3_bucket.backups.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# ---------------------------------------------------------------------------
# Versioning — ON everywhere. Cheap insurance against accidental deletes,
# lifecycle rules eventually prune old versions.
# ---------------------------------------------------------------------------

resource "aws_s3_bucket_versioning" "public_media" {
  bucket = aws_s3_bucket.public_media.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_versioning" "theme_library" {
  bucket = aws_s3_bucket.theme_library.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_versioning" "private" {
  bucket = aws_s3_bucket.private.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_versioning" "backups" {
  bucket = aws_s3_bucket.backups.id
  versioning_configuration {
    status = "Enabled"
  }
}

# ---------------------------------------------------------------------------
# Server-side encryption — AES-256 SSE-S3 everywhere. KMS is overkill for
# MVP (costs $1/key/mo + GetObject fees) and not required for PCI/SOC2
# at our stage.
# ---------------------------------------------------------------------------

resource "aws_s3_bucket_server_side_encryption_configuration" "public_media" {
  bucket = aws_s3_bucket.public_media.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "theme_library" {
  bucket = aws_s3_bucket.theme_library.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "private" {
  bucket = aws_s3_bucket.private.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "backups" {
  bucket = aws_s3_bucket.backups.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# ---------------------------------------------------------------------------
# CORS — public-media only. Storefronts fetch images from this bucket
# directly through the Cloudflare front; CORS is the browser-side
# permission gate.
# ---------------------------------------------------------------------------

resource "aws_s3_bucket_cors_configuration" "public_media" {
  bucket = aws_s3_bucket.public_media.id

  cors_rule {
    allowed_origins = var.cors_allowed_origins
    allowed_methods = ["GET", "HEAD"]
    allowed_headers = ["*"]
    expose_headers  = ["ETag", "Content-Length", "Content-Type"]
    max_age_seconds = 3600
  }
}

# ---------------------------------------------------------------------------
# Bucket policy — public-media + theme-library allow GetObject from
# Cloudflare OR imgproxy only. Private + backups have no policy (access
# is purely via IAM roles / presigned URLs).
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "public_media" {
  # Allow Cloudflare Worker + imgproxy to fetch objects.
  statement {
    sid    = "AllowCloudflareAndImgproxy"
    effect = "Allow"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.public_media.arn}/*"]

    # Gate 1: User-Agent must match the Worker's stamped UA.
    condition {
      test     = "StringEquals"
      variable = "aws:UserAgent"
      values   = [var.cloudflare_user_agent]
    }

    # Gate 2: Source IP must be in the Cloudflare CIDR list OR the
    # imgproxy private CIDR list. Without either gate, public HTTP
    # requests are denied despite UA spoof.
    condition {
      test     = "IpAddress"
      variable = "aws:SourceIp"
      values = concat(
        var.cloudflare_ipv4_cidrs,
        var.cloudflare_ipv6_cidrs,
        var.imgproxy_egress_cidrs,
      )
    }
  }
}

resource "aws_s3_bucket_policy" "public_media" {
  bucket = aws_s3_bucket.public_media.id
  policy = data.aws_iam_policy_document.public_media.json

  # Depend on PAB so the policy isn't rejected during the apply window
  # where BlockPublicPolicy briefly flips on an empty bucket.
  depends_on = [aws_s3_bucket_public_access_block.public_media]
}

data "aws_iam_policy_document" "theme_library" {
  statement {
    sid    = "AllowCloudflareAndImgproxy"
    effect = "Allow"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.theme_library.arn}/*"]

    condition {
      test     = "StringEquals"
      variable = "aws:UserAgent"
      values   = [var.cloudflare_user_agent]
    }

    condition {
      test     = "IpAddress"
      variable = "aws:SourceIp"
      values = concat(
        var.cloudflare_ipv4_cidrs,
        var.cloudflare_ipv6_cidrs,
        var.imgproxy_egress_cidrs,
      )
    }
  }
}

resource "aws_s3_bucket_policy" "theme_library" {
  bucket     = aws_s3_bucket.theme_library.id
  policy     = data.aws_iam_policy_document.theme_library.json
  depends_on = [aws_s3_bucket_public_access_block.theme_library]
}

# ---------------------------------------------------------------------------
# Lifecycle rules
# ---------------------------------------------------------------------------

resource "aws_s3_bucket_lifecycle_configuration" "public_media" {
  bucket = aws_s3_bucket.public_media.id

  rule {
    id     = "transition-to-intelligent-tiering"
    status = "Enabled"

    # Filter block is required in v2 of the API even when we want to
    # apply to all objects. Empty prefix = all.
    filter {}

    transition {
      days          = var.public_media_lifecycle_days
      storage_class = "INTELLIGENT_TIERING"
    }

    noncurrent_version_expiration {
      noncurrent_days = 30
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "theme_library" {
  bucket = aws_s3_bucket.theme_library.id

  rule {
    id     = "expire-drafts"
    status = "Enabled"

    filter {
      prefix = "drafts/"
    }

    expiration {
      days = var.theme_library_drafts_ttl_days
    }
  }

  rule {
    id     = "prune-old-versions"
    status = "Enabled"
    filter {}

    noncurrent_version_expiration {
      noncurrent_days = 90
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "private" {
  bucket = aws_s3_bucket.private.id

  # Per-type retention per spec §4.4c. Each rule matches its prefix and
  # applies its own expiration.
  rule {
    id     = "invoices-7y"
    status = "Enabled"

    filter {
      prefix = "invoices/"
    }

    expiration {
      days = var.private_invoices_ttl_years * 365
    }
  }

  rule {
    id     = "exports-90d"
    status = "Enabled"

    filter {
      prefix = "exports/"
    }

    expiration {
      days = var.private_exports_ttl_days
    }
  }

  rule {
    id     = "pod-2y"
    status = "Enabled"

    filter {
      prefix = "pod/"
    }

    expiration {
      days = var.private_pod_ttl_years * 365
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "backups" {
  bucket = aws_s3_bucket.backups.id

  rule {
    id     = "glacier-then-deep-archive"
    status = "Enabled"
    filter {}

    transition {
      days          = var.backups_glacier_days
      storage_class = "GLACIER"
    }

    transition {
      days          = var.backups_deep_archive_days
      storage_class = "DEEP_ARCHIVE"
    }
  }
}

# ---------------------------------------------------------------------------
# Cross-region replication (CRR) — only on the primary set.
# The caller passes the DR bucket ARNs via `replication_destinations`.
# ---------------------------------------------------------------------------

resource "aws_s3_bucket_replication_configuration" "public_media" {
  # NOTE: count depends only on the static boolean `enable_replication`,
  # not on the destination ARN value — because that ARN comes from another
  # module and is unknown at plan time. If the caller sets enable_replication
  # = true they MUST also pass a non-empty `replication_destinations`;
  # otherwise apply fails at the AWS API layer with a clearer error.
  count = var.enable_replication ? 1 : 0

  # Versioning must be on both sides — already enforced above and
  # implicitly on the DR side since the same module governs it.
  depends_on = [aws_s3_bucket_versioning.public_media]

  bucket = aws_s3_bucket.public_media.id
  role   = var.replication_role_arn

  rule {
    id     = "replicate-all"
    status = "Enabled"

    # Empty filter = replicate every object.
    filter {}

    # Don't replicate delete markers — keeps DR immutable after a bad
    # delete on primary. Spec §4.5.
    delete_marker_replication {
      status = "Disabled"
    }

    # AWS PutBucketReplication requires source_selection_criteria when
    # delete_marker_replication is set explicitly. Only replica_modifications
    # is used — sse_kms_encrypted_objects would require ReplicaKmsKeyID even
    # at Disabled status, and our buckets are AES256 (not KMS).
    source_selection_criteria {
      replica_modifications {
        status = "Disabled"
      }
    }

    destination {
      bucket        = var.replication_destinations.public_media
      storage_class = "STANDARD"
    }
  }
}

resource "aws_s3_bucket_replication_configuration" "theme_library" {
  count = var.enable_replication ? 1 : 0

  depends_on = [aws_s3_bucket_versioning.theme_library]
  bucket     = aws_s3_bucket.theme_library.id
  role       = var.replication_role_arn

  rule {
    id     = "replicate-all"
    status = "Enabled"
    filter {}

    delete_marker_replication {
      status = "Disabled"
    }

    # AWS PutBucketReplication requires source_selection_criteria when
    # delete_marker_replication is set explicitly. Only replica_modifications
    # is used — sse_kms_encrypted_objects would require ReplicaKmsKeyID even
    # at Disabled status, and our buckets are AES256 (not KMS).
    source_selection_criteria {
      replica_modifications {
        status = "Disabled"
      }
    }

    destination {
      bucket        = var.replication_destinations.theme_library
      storage_class = "STANDARD"
    }
  }
}

resource "aws_s3_bucket_replication_configuration" "private" {
  count = var.enable_replication ? 1 : 0

  depends_on = [aws_s3_bucket_versioning.private]
  bucket     = aws_s3_bucket.private.id
  role       = var.replication_role_arn

  rule {
    id     = "replicate-all"
    status = "Enabled"
    filter {}

    delete_marker_replication {
      status = "Disabled"
    }

    # AWS PutBucketReplication requires source_selection_criteria when
    # delete_marker_replication is set explicitly. Only replica_modifications
    # is used — sse_kms_encrypted_objects would require ReplicaKmsKeyID even
    # at Disabled status, and our buckets are AES256 (not KMS).
    source_selection_criteria {
      replica_modifications {
        status = "Disabled"
      }
    }

    destination {
      bucket        = var.replication_destinations.private
      storage_class = "STANDARD"
    }
  }
}

resource "aws_s3_bucket_replication_configuration" "backups" {
  count = var.enable_replication ? 1 : 0

  depends_on = [aws_s3_bucket_versioning.backups]
  bucket     = aws_s3_bucket.backups.id
  role       = var.replication_role_arn

  rule {
    id     = "replicate-all"
    status = "Enabled"
    filter {}

    delete_marker_replication {
      status = "Disabled"
    }

    # AWS PutBucketReplication requires source_selection_criteria when
    # delete_marker_replication is set explicitly. Only replica_modifications
    # is used — sse_kms_encrypted_objects would require ReplicaKmsKeyID even
    # at Disabled status, and our buckets are AES256 (not KMS).
    source_selection_criteria {
      replica_modifications {
        status = "Disabled"
      }
    }

    destination {
      bucket        = var.replication_destinations.backups
      storage_class = "GLACIER_IR"
    }
  }
}
