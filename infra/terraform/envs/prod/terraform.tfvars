# ---------------------------------------------------------------------------
# envs/prod — committed tfvars.
#
# ⚠️ What's IN this file:
#   - Account IDs, Zone IDs (public-ish identifiers; not secrets)
#   - Budget cap, alert email
#   - Region names
#
# ⚠️ What is NOT in this file:
#   - AWS credentials         → ~/.aws/credentials or AWS_* env vars
#   - Cloudflare API token    → $CLOUDFLARE_API_TOKEN env var
#   - Any password / secret   → AWS Secrets Manager (managed separately)
#
# Thai's emergency overrides can live in `terraform.tfvars.local`
# (gitignored). Terraform auto-loads *.tfvars.local on top of this file.
# ---------------------------------------------------------------------------

# --- AWS ---------------------------------------------------------------------

aws_account_id = "629720697813"
primary_region = "ap-southeast-1"
dr_region      = "ap-northeast-1"

# --- Budget ------------------------------------------------------------------

monthly_budget_usd = 200
budget_alert_email = "thaibeotitamz@gmail.com"

# --- Cloudflare --------------------------------------------------------------

cloudflare_account_id = "196d4c6494c99fab466f05f9daa77ec5"
cloudflare_zone_id    = "8c9f8789175c7621786c1cacfe5f030a"
cdn_hostname          = "cdn.gbox.co"

# --- Storefront CORS ---------------------------------------------------------

cors_allowed_origins = [
  "https://gbox.co",
  "https://*.gbox.co",
  "https://tw3.store",
  "https://*.tw3.store",
]
