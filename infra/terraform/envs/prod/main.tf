# ---------------------------------------------------------------------------
# envs/prod — production infrastructure for gbox.co.
#
# Module call graph:
#
#       ┌───────────────────────────┐
#       │  module.s3_primary        │ ← ap-southeast-1
#       │  (public/theme/priv/bkp)  │
#       └─────┬─────────────────────┘
#             │ bucket_arns
#             ▼
#   ┌──────────────────────┐        ┌─────────────────────────┐
#   │  module.iam          │───────▶│  module.s3_primary      │
#   │  (4 roles)           │  role  │  .replication_role_arn  │
#   │                      │───────▶│  (cycle-broken via      │
#   │                      │        │   explicit ordering)    │
#   └──────────────────────┘        └─────────────────────────┘
#             ▲
#             │ bucket_arns (DR)
#       ┌─────┴─────────────────────┐
#       │  module.s3_dr             │ ← ap-northeast-1 (suffix -dr)
#       └───────────────────────────┘
#
#       ┌───────────────────────────┐
#       │  module.budget            │ (standalone — global AWS Budgets
#       │                           │  is region-less, we just pick
#       │                           │  primary for the SNS topic)
#       └───────────────────────────┘
#
# Order of apply is managed by Terraform's implicit dependency resolution:
# s3_dr is created first (no deps), then iam (depends on bucket ARNs),
# then s3_primary (needs replication_role_arn from iam + dr bucket ARNs).
# Budget is independent and can apply in parallel.
# ---------------------------------------------------------------------------

locals {
  # Shared tag set. Modules further merge their own tags on top.
  common_tags = {
    Project     = "gbox-platform"
    Environment = "prod"
    ManagedBy   = "Terraform"
    CostCenter  = "phase-b-media"
  }

  # Secrets Manager ARN prefix — scoped to gbox/prod/* so the IAM role
  # can't read staging or dev secrets even if something goes sideways.
  secrets_arn_prefix = "arn:aws:secretsmanager:${var.primary_region}:${var.aws_account_id}:secret:gbox/prod/*"
}

# ---------------------------------------------------------------------------
# 1. S3 buckets — DR region first (no deps, nothing depends on its ARNs
#    beyond iam + s3_primary, and those are later in the graph).
# ---------------------------------------------------------------------------

module "s3_dr" {
  source = "../../modules/s3-bucket-set"

  providers = {
    aws = aws.dr
  }

  env    = "prod"
  suffix = "-dr"
  region = var.dr_region

  # DR buckets receive CRR writes only — no direct CORS, no CF egress.
  # Everything else defaults to the module's safe defaults.
  cors_allowed_origins = var.cors_allowed_origins
  enable_replication   = false # DR is the destination, not source

  tags = merge(local.common_tags, {
    Tier = "dr"
  })
}

# ---------------------------------------------------------------------------
# 2. IAM roles — needs primary+DR bucket ARNs for policy scoping.
#
# NOTE: We reference s3_primary.bucket_arns BEFORE s3_primary is declared.
# This is intentional — Terraform resolves module references lazily and
# s3_primary depends on iam.replication_role_arn, which breaks the cycle.
# The DAG Terraform actually executes:
#
#     s3_dr  →  iam  →  s3_primary
#
# ...because s3_primary's replication block depends on iam's output and
# iam's policy depends on s3_primary's ARN. Terraform figures out that
# ARNs can be known at plan time (they're deterministic from bucket name)
# so the cycle is only apparent, not real.
# ---------------------------------------------------------------------------

module "iam" {
  source = "../../modules/iam-roles"

  providers = {
    aws = aws.primary
  }

  env = "prod"

  primary_bucket_arns = module.s3_primary.bucket_arns
  dr_bucket_arns      = module.s3_dr.bucket_arns

  secrets_manager_arn_prefix = local.secrets_arn_prefix

  tags = local.common_tags
}

# ---------------------------------------------------------------------------
# 3. S3 buckets — primary region. This is where the action is.
#    Pulls replication role ARN from iam module above.
# ---------------------------------------------------------------------------

module "s3_primary" {
  source = "../../modules/s3-bucket-set"

  providers = {
    aws = aws.primary
  }

  env    = "prod"
  suffix = "" # primary = no suffix
  region = var.primary_region

  cors_allowed_origins = var.cors_allowed_origins

  # CRR on — point to DR bucket ARNs using the replication role from iam.
  enable_replication       = true
  replication_role_arn     = module.iam.replication_role_arn
  replication_destinations = module.s3_dr.bucket_arns

  # Cloudflare IPv4/IPv6 ranges are baked into the module's defaults.
  # Override here if we ever move to a custom egress allowlist.
  # imgproxy_egress_cidrs gets wired in Stage 2 (after imgproxy-ecs
  # module stands up a VPC + subnets and outputs its NAT CIDRs).
  imgproxy_egress_cidrs = []

  # Retention tuned for prod — legal minimum 7 years for invoices.
  private_invoices_ttl_years = 7
  private_pod_ttl_years      = 2
  private_exports_ttl_days   = 90
  backups_glacier_days       = 30
  backups_deep_archive_days  = 180

  tags = local.common_tags
}

# ---------------------------------------------------------------------------
# 4. Budget + SNS alerts.
#
# Independent of S3/IAM — runs in parallel. Email subscription triggers
# a confirmation mail from AWS (no-reply@sns.amazonaws.com) on first
# apply; Thai MUST click the link or no alerts will be delivered.
# ---------------------------------------------------------------------------

module "budget" {
  source = "../../modules/budget-alerts"

  providers = {
    aws = aws.primary
  }

  env             = "prod"
  monthly_cap_usd = var.monthly_budget_usd
  alert_email     = var.budget_alert_email

  tags = local.common_tags
}

# ---------------------------------------------------------------------------
# 5. Cloudflare zone — Origin + Cache + Transform + WAF rules for cdn.gbox.co.
#
# Apply order caveat: the Cloudflare provider talks to a different API
# (not AWS) so it can proceed in parallel with the S3/IAM/Budget modules.
# The only runtime coupling is that S3 regional domain names need to exist
# before CF can use them as origin hosts — Terraform handles that through
# the module output reference below.
#
# Stage 1 note: imgproxy_host is intentionally "" here. The imgproxy NLB
# doesn't exist yet, so the CF Origin Rule that would route /img/*
# self-skips (see the `dynamic "rules"` block in the module). When
# Stage 2 lands, flip imgproxy_host = module.imgproxy.nlb_dns_name.
# ---------------------------------------------------------------------------

module "cloudflare" {
  source = "../../modules/cloudflare-zone"

  zone_id    = var.cloudflare_zone_id
  account_id = var.cloudflare_account_id

  cdn_hostname = var.cdn_hostname

  # Origin hosts come from the S3 module outputs — keeps the coupling
  # explicit and prevents drift if bucket names ever change.
  s3_public_media_domain  = module.s3_primary.regional_domains.public_media
  s3_theme_library_domain = module.s3_primary.regional_domains.theme_library

  # Stage 2 wire-in point — leave blank until imgproxy module exists.
  imgproxy_host = ""

  # Prod = full WAF. Rate limit 100 r/s/IP on /img/*.
  enable_waf         = true
  rate_limit_img_rps = 100
}
