# ---------------------------------------------------------------------------
# envs/staging — identical topology to prod, 1/5 the scale.
#
# Why the same topology and not a simpler one? Because the whole point
# of staging is to catch problems that hide in prod-only code paths:
# CRR consistency, Cloudflare Cache Rules, WAF rate limits. If we
# short-cut staging we just discover those bugs in prod.
#
# Differences from prod:
#   - monthly_budget_usd = $60 (vs $200)
#   - public_media_lifecycle_days = 45 (vs 90)     — aggressive tier-down
#   - rate_limit_img_rps = 30 (vs 100)             — smaller load
#   - enable_waf = true (same as prod — we want rules exercised)
# ---------------------------------------------------------------------------

locals {
  common_tags = {
    Project     = "gbox-platform"
    Environment = "staging"
    ManagedBy   = "Terraform"
    CostCenter  = "phase-b-media"
  }

  secrets_arn_prefix = "arn:aws:secretsmanager:${var.primary_region}:${var.aws_account_id}:secret:gbox/staging/*"
}

module "s3_dr" {
  source = "../../modules/s3-bucket-set"

  providers = {
    aws = aws.dr
  }

  env                = "staging"
  suffix             = "-dr"
  region             = var.dr_region
  enable_replication = false

  tags = merge(local.common_tags, {
    Tier = "dr"
  })
}

module "iam" {
  source = "../../modules/iam-roles"

  providers = {
    aws = aws.primary
  }

  env = "staging"

  primary_bucket_arns = module.s3_primary.bucket_arns
  dr_bucket_arns      = module.s3_dr.bucket_arns

  secrets_manager_arn_prefix = local.secrets_arn_prefix

  tags = local.common_tags
}

module "s3_primary" {
  source = "../../modules/s3-bucket-set"

  providers = {
    aws = aws.primary
  }

  env    = "staging"
  region = var.primary_region

  cors_allowed_origins = [
    "https://staging.gbox.co",
    "https://*.staging.gbox.co",
    "https://staging.tw3.store",
  ]

  enable_replication       = true
  replication_role_arn     = module.iam.replication_role_arn
  replication_destinations = module.s3_dr.bucket_arns

  # Tighter retention than prod — staging isn't meant to hold long tails.
  public_media_lifecycle_days = 45
  backups_glacier_days        = 14
  # AWS requires DEEP_ARCHIVE transition days to be ≥ 90 days *after* GLACIER.
  # With GLACIER at day 14, the earliest valid DEEP_ARCHIVE is day 104.
  # We use 120 for a small safety margin while still being well under prod's 180.
  backups_deep_archive_days = 120
  private_exports_ttl_days  = 30
  # Legal retention still applies — staging invoices are tests, but the
  # logic should be exercised.
  private_invoices_ttl_years = 1

  imgproxy_egress_cidrs = []

  tags = local.common_tags
}

module "budget" {
  source = "../../modules/budget-alerts"

  providers = {
    aws = aws.primary
  }

  env             = "staging"
  monthly_cap_usd = var.monthly_budget_usd
  alert_email     = var.budget_alert_email

  tags = local.common_tags
}

# ---------------------------------------------------------------------------
# module "cloudflare" — INTENTIONALLY DISABLED for staging MVP apply.
#
# Background: the Cloudflare zone `gbox.co` is single-tenant — prod already
# owns every phase ruleset we'd need to register here (cache, headers,
# transform, rate-limit, WAF). Cloudflare allows one ruleset per phase per
# zone, so applying this module produces "phase already in use" errors on
# every rule kind.
#
# The commented-out block below is the real config. It stays in-file so
# we can flip it back on once we provision a dedicated staging zone
# (staging.gbox.co or gbox.dev) — at that point, swap the zone_id in
# terraform.tfvars and uncomment.
#
# Until then: AWS-only staging apply (8 buckets + 6 IAM roles + budget).
# Tracked in: docs/superpowers/specs/... staging-cf-zone-split.
# See memory: staging_tf_blocker.md
# ---------------------------------------------------------------------------
# module "cloudflare" {
#   source = "../../modules/cloudflare-zone"
#
#   zone_id    = var.cloudflare_zone_id
#   account_id = var.cloudflare_account_id
#
#   cdn_hostname = var.cdn_hostname
#
#   s3_public_media_domain  = module.s3_primary.regional_domains.public_media
#   s3_theme_library_domain = module.s3_primary.regional_domains.theme_library
#
#   imgproxy_host = "" # Stage 2
#
#   enable_waf         = true
#   rate_limit_img_rps = 30 # lower than prod to catch rate-limit regressions
# }
