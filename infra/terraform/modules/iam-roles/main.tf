# ---------------------------------------------------------------------------
# Module: iam-roles
#
# Principle: every compute workload gets its own role, every role gets
# the minimum permissions. No shared admin role, no wildcard S3 grants.
# ---------------------------------------------------------------------------

locals {
  role_prefix = "Gbox${title(var.env)}" # e.g. GboxProd, GboxStaging
  common_tags = merge(var.tags, {
    Environment = var.env
    ManagedBy   = "Terraform"
    Module      = "iam-roles"
  })

  # Convenience: primary + DR bucket ARNs merged, with empty strings
  # stripped (DR may not exist in dev env).
  all_bucket_arns_primary = [
    var.primary_bucket_arns.public_media,
    var.primary_bucket_arns.theme_library,
    var.primary_bucket_arns.private,
    var.primary_bucket_arns.backups,
  ]

  all_bucket_arns_dr = compact([
    var.dr_bucket_arns.public_media,
    var.dr_bucket_arns.theme_library,
    var.dr_bucket_arns.private,
    var.dr_bucket_arns.backups,
  ])

  # "...ARN/*" — S3 actions like GetObject act on objects, not buckets
  object_arns_primary = [for a in local.all_bucket_arns_primary : "${a}/*"]
  object_arns_dr      = [for a in local.all_bucket_arns_dr : "${a}/*"]
}

# ===========================================================================
# 1. GboxBackendRole — attached to EC2/ECS running Node API
# ===========================================================================

data "aws_iam_policy_document" "backend_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com", "ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "backend" {
  name               = "${local.role_prefix}BackendRole"
  assume_role_policy = data.aws_iam_policy_document.backend_assume.json
  description        = "Gbox backend Node API - R/W on primary buckets, R on DR, Secrets Manager read."
  tags               = merge(local.common_tags, { Role = "backend" })
}

data "aws_iam_policy_document" "backend" {
  # Full CRUD on primary prod buckets.
  statement {
    sid    = "PrimaryBucketsRW"
    effect = "Allow"
    actions = [
      "s3:GetObject",
      "s3:PutObject",
      "s3:DeleteObject",
      "s3:GetObjectTagging",
      "s3:PutObjectTagging",
    ]
    resources = local.object_arns_primary
  }

  # List for each bucket (needed by signedUrl + has() calls).
  statement {
    sid    = "PrimaryBucketsList"
    effect = "Allow"
    actions = [
      "s3:ListBucket",
      "s3:GetBucketLocation",
    ]
    resources = local.all_bucket_arns_primary
  }

  # Read-only on DR buckets — exercised during failover drills. Kept
  # even when DR is empty so the role doesn't need re-creation.
  dynamic "statement" {
    for_each = length(local.object_arns_dr) > 0 ? [1] : []
    content {
      sid    = "DRBucketsRead"
      effect = "Allow"
      actions = [
        "s3:GetObject",
        "s3:ListBucket",
      ]
      resources = concat(local.all_bucket_arns_dr, local.object_arns_dr)
    }
  }

  # Secrets Manager — fetch IMGPROXY_KEY / SALT / DOWNLOAD_JWT_SECRET.
  statement {
    sid       = "SecretsRead"
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"]
    resources = [var.secrets_manager_arn_prefix]
  }

  # CloudWatch Logs — write log stream from the backend pino logger.
  statement {
    sid    = "CloudWatchLogs"
    effect = "Allow"
    actions = [
      "logs:CreateLogGroup",
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "backend" {
  name   = "${local.role_prefix}BackendPolicy"
  role   = aws_iam_role.backend.id
  policy = data.aws_iam_policy_document.backend.json
}

# Instance profile — only needed if role is attached to EC2 (not ECS).
resource "aws_iam_instance_profile" "backend" {
  name = "${local.role_prefix}BackendInstanceProfile"
  role = aws_iam_role.backend.name
}

# ===========================================================================
# 2. GboxImgproxyRole — attached to imgproxy ECS tasks
# ===========================================================================

data "aws_iam_policy_document" "imgproxy_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "imgproxy" {
  name               = "${local.role_prefix}ImgproxyRole"
  assume_role_policy = data.aws_iam_policy_document.imgproxy_assume.json
  description        = "imgproxy ECS tasks - read-only on public-media + theme-library."
  tags               = merge(local.common_tags, { Role = "imgproxy" })
}

data "aws_iam_policy_document" "imgproxy" {
  # imgproxy only reads source images. It never writes.
  statement {
    sid    = "ReadPublicMediaAndThemes"
    effect = "Allow"
    actions = [
      "s3:GetObject",
      "s3:GetObjectTagging",
    ]
    resources = [
      "${var.primary_bucket_arns.public_media}/*",
      "${var.primary_bucket_arns.theme_library}/*",
    ]
  }

  statement {
    sid    = "ListPublicMediaAndThemes"
    effect = "Allow"
    actions = [
      "s3:ListBucket",
      "s3:GetBucketLocation",
    ]
    resources = [
      var.primary_bucket_arns.public_media,
      var.primary_bucket_arns.theme_library,
    ]
  }

  # Secrets Manager — IMGPROXY_KEY / SALT.
  statement {
    sid       = "SecretsRead"
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [var.secrets_manager_arn_prefix]
  }

  statement {
    sid    = "CloudWatchLogs"
    effect = "Allow"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "imgproxy" {
  name   = "${local.role_prefix}ImgproxyPolicy"
  role   = aws_iam_role.imgproxy.id
  policy = data.aws_iam_policy_document.imgproxy.json
}

# ECS execution role — pulls container image from ECR, pushes logs to
# CloudWatch on behalf of the task. Separate from the task role so
# task code can't accidentally use pull-image perms.
resource "aws_iam_role" "imgproxy_execution" {
  name               = "${local.role_prefix}ImgproxyExecutionRole"
  assume_role_policy = data.aws_iam_policy_document.imgproxy_assume.json
  description        = "Fargate execution role for imgproxy - ECR pull + CloudWatch logs."
  tags               = merge(local.common_tags, { Role = "imgproxy-exec" })
}

resource "aws_iam_role_policy_attachment" "imgproxy_execution" {
  role       = aws_iam_role.imgproxy_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# ===========================================================================
# 3. GboxFfmpegWorkerRole — attached to transcode ECS tasks
# ===========================================================================

resource "aws_iam_role" "ffmpeg" {
  name               = "${local.role_prefix}FfmpegWorkerRole"
  assume_role_policy = data.aws_iam_policy_document.imgproxy_assume.json # same trust policy
  description        = "ffmpeg-worker ECS tasks - R/W on public-media/videos/* prefix only."
  tags               = merge(local.common_tags, { Role = "ffmpeg" })
}

data "aws_iam_policy_document" "ffmpeg" {
  # Scoped to /videos/* prefix so a compromised worker can't touch
  # product images. PutObject for HLS segments + poster + thumbs,
  # GetObject for the source, DeleteObject for cleanup on failed jobs.
  statement {
    sid    = "VideosPrefixRW"
    effect = "Allow"
    actions = [
      "s3:GetObject",
      "s3:PutObject",
      "s3:DeleteObject",
    ]
    # S3 resource patterns use Unix-style globs via policy variables.
    # shops/*/videos/* covers every shop's video directory.
    resources = [
      "${var.primary_bucket_arns.public_media}/shops/*/videos/*",
    ]
  }

  statement {
    sid    = "ListVideosPrefix"
    effect = "Allow"
    actions = [
      "s3:ListBucket",
    ]
    resources = [var.primary_bucket_arns.public_media]
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["shops/*/videos/*"]
    }
  }

  # BullMQ workers pull job payloads from Redis — Redis creds live in
  # Secrets Manager, not IAM, but they still need secretsmanager:Get.
  statement {
    sid       = "SecretsRead"
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [var.secrets_manager_arn_prefix]
  }

  statement {
    sid    = "CloudWatchLogs"
    effect = "Allow"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "ffmpeg" {
  name   = "${local.role_prefix}FfmpegPolicy"
  role   = aws_iam_role.ffmpeg.id
  policy = data.aws_iam_policy_document.ffmpeg.json
}

resource "aws_iam_role" "ffmpeg_execution" {
  name               = "${local.role_prefix}FfmpegExecutionRole"
  assume_role_policy = data.aws_iam_policy_document.imgproxy_assume.json
  description        = "Fargate execution role for ffmpeg - ECR pull + CloudWatch logs."
  tags               = merge(local.common_tags, { Role = "ffmpeg-exec" })
}

resource "aws_iam_role_policy_attachment" "ffmpeg_execution" {
  role       = aws_iam_role.ffmpeg_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# ===========================================================================
# 4. GboxS3ReplicationRole — assumed by S3 CRR service
# ===========================================================================

data "aws_iam_policy_document" "replication_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["s3.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "replication" {
  name               = "${local.role_prefix}S3ReplicationRole"
  assume_role_policy = data.aws_iam_policy_document.replication_assume.json
  description        = "S3 Cross-Region Replication - reads primary, writes DR."
  tags               = merge(local.common_tags, { Role = "replication" })
}

data "aws_iam_policy_document" "replication" {
  # Read from primary: object + version metadata required for replication.
  statement {
    sid    = "ReplicationSource"
    effect = "Allow"
    actions = [
      "s3:GetObjectVersionForReplication",
      "s3:GetObjectVersionAcl",
      "s3:GetObjectVersionTagging",
      "s3:ListBucket",
      "s3:GetReplicationConfiguration",
    ]
    resources = concat(
      local.all_bucket_arns_primary,
      local.object_arns_primary,
    )
  }

  # Write to DR. Only fires when dr_bucket_arns is populated.
  dynamic "statement" {
    for_each = length(local.object_arns_dr) > 0 ? [1] : []
    content {
      sid    = "ReplicationDestination"
      effect = "Allow"
      actions = [
        "s3:ReplicateObject",
        "s3:ReplicateDelete",
        "s3:ReplicateTags",
      ]
      resources = local.object_arns_dr
    }
  }
}

resource "aws_iam_role_policy" "replication" {
  name   = "${local.role_prefix}S3ReplicationPolicy"
  role   = aws_iam_role.replication.id
  policy = data.aws_iam_policy_document.replication.json
}
