# ---------------------------------------------------------------------------
# envs/dev — cheapest possible rig for CI + local integration tests.
#
# What's in:
#   - 4 S3 buckets (primary only, no DR)
#   - IAM roles (needed by backend tests that assume roles)
#   - Budget alert at $20/mo (saves Thai from a runaway pytest loop)
#
# What's out:
#   - Cloudflare (dev traffic goes to S3 regional endpoint directly, via
#     ENV override CDN_BASE_URL=https://gbox-public-media-dev.s3...)
#   - DR region + CRR (saves ~$5/mo + removes 30-second replication lag
#     that confuses integration tests)
#   - imgproxy/ffmpeg ECS (dev uses Worker placeholder for now)
#
# force_destroy = true on all buckets (module default for env != prod) so
# `terraform destroy` nukes them without manual object cleanup.
# ---------------------------------------------------------------------------

locals {
  common_tags = {
    Project     = "gbox-platform"
    Environment = "dev"
    ManagedBy   = "Terraform"
    CostCenter  = "phase-b-media"
  }

  secrets_arn_prefix = "arn:aws:secretsmanager:${var.primary_region}:${var.aws_account_id}:secret:gbox/dev/*"
}

module "s3_primary" {
  source = "../../modules/s3-bucket-set"

  env    = "dev"
  region = var.primary_region

  # Dev traffic doesn't go through Cloudflare — open CORS more widely
  # so the Astro dev server on localhost can fetch directly.
  cors_allowed_origins = [
    "http://localhost:*",
    "http://127.0.0.1:*",
    "https://*.gbox.co",
  ]

  # Dev should expire old stuff aggressively to stay under $20.
  public_media_lifecycle_days = 30
  backups_glacier_days        = 7
  backups_deep_archive_days   = 30
  private_exports_ttl_days    = 14

  # No CRR in dev.
  enable_replication = false

  tags = local.common_tags
}

module "iam" {
  source = "../../modules/iam-roles"

  env = "dev"

  primary_bucket_arns = module.s3_primary.bucket_arns
  # dr_bucket_arns default = empty (no DR in dev)

  secrets_manager_arn_prefix = local.secrets_arn_prefix

  tags = local.common_tags
}

module "budget" {
  source = "../../modules/budget-alerts"

  env             = "dev"
  monthly_cap_usd = var.monthly_budget_usd
  alert_email     = var.budget_alert_email

  tags = local.common_tags
}
