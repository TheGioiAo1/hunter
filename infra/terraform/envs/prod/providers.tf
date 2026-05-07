# ---------------------------------------------------------------------------
# Provider instances for envs/prod.
#
# AWS is declared twice (primary + DR) using provider aliases — Terraform
# then uses `provider = aws.primary` / `provider = aws.dr` inside resource
# blocks to target the right region. This is the canonical pattern for
# multi-region modules and it's what lets us stand up S3 Cross-Region
# Replication cleanly from a single state file.
#
# Cloudflare is single-tenant (one account, one zone) so no alias needed.
# ---------------------------------------------------------------------------

# Primary region — where real traffic hits.
provider "aws" {
  alias  = "primary"
  region = var.primary_region

  default_tags {
    tags = {
      Project     = "gbox-platform"
      Environment = "prod"
      ManagedBy   = "Terraform"
      Owner       = "thai@gbox.co"
    }
  }
}

# DR region — cold standby for S3. Separate alias so every resource that
# belongs in ap-northeast-1 has to opt in explicitly.
provider "aws" {
  alias  = "dr"
  region = var.dr_region

  default_tags {
    tags = {
      Project     = "gbox-platform"
      Environment = "prod"
      ManagedBy   = "Terraform"
      Owner       = "thai@gbox.co"
      Tier        = "dr"
    }
  }
}

# The unaliased `aws` provider — required because Terraform needs a
# default when the resource block doesn't specify `provider = aws.x`.
# We keep it identical to `primary` so forgotten aliases still land in
# ap-southeast-1 (safe default).
provider "aws" {
  region = var.primary_region

  default_tags {
    tags = {
      Project     = "gbox-platform"
      Environment = "prod"
      ManagedBy   = "Terraform"
      Owner       = "thai@gbox.co"
    }
  }
}

# Cloudflare — token sourced from the CLOUDFLARE_API_TOKEN env var.
# DO NOT set `api_token = "..."` in code. The provider automatically
# reads CLOUDFLARE_API_TOKEN, which means the secret never touches the
# repo or the state file's sensitive-outputs section.
#
# Token scope required (create at https://dash.cloudflare.com/profile/api-tokens):
#   - Zone → DNS        → Edit        (for DNS records)
#   - Zone → Zone       → Read        (for zone metadata)
#   - Zone → Cache Rules → Edit       (for Cache Rules)
#   - Zone → Origin Rules → Edit      (for Origin Rules rerouting to S3)
#   - Zone → Transform Rules → Edit   (for URL rewrites)
#   - Zone → Config Rules → Edit      (for security-level per-path)
#   - Account → Workers Scripts → Edit (for cdn-worker deploy)
#   Zone Resources: Include → Specific → gbox.co
provider "cloudflare" {
  # api_token is read from $CLOUDFLARE_API_TOKEN automatically.
  # Optionally override via TF_VAR_cloudflare_api_token if you prefer
  # tfvars-driven config — but keep it out of version control.
}
