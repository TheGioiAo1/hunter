# ---------------------------------------------------------------------------
# envs/prod variables.
#
# Almost all of these come from terraform.tfvars in the same directory.
# Variables here just declare shape + validation. The point of keeping
# them separate from the module-level variables is that this layer is
# the only place we name an absolute account/region/zone — modules stay
# portable.
# ---------------------------------------------------------------------------

# --- AWS ---------------------------------------------------------------------

variable "aws_account_id" {
  description = <<EOT
12-digit AWS account number. Used to build ARNs for Secrets Manager and
to sanity-check the provider is pointing at the right account before
apply. If `aws sts get-caller-identity` returns a different account,
Terraform should fail loudly rather than apply against the wrong tenant.
EOT
  type        = string
  validation {
    condition     = can(regex("^[0-9]{12}$", var.aws_account_id))
    error_message = "aws_account_id must be a 12-digit number."
  }
}

variable "primary_region" {
  description = "AWS primary region (user traffic). Spec §4.2 locks this to ap-southeast-1."
  type        = string
  default     = "ap-southeast-1"
}

variable "dr_region" {
  description = "AWS DR region. Spec §4.2 locks this to ap-northeast-1 — cross-continent protects against ap-se-1 outage AND latency-biases away from Singapore to reduce cost of double-writes."
  type        = string
  default     = "ap-northeast-1"
}

# --- Budget ------------------------------------------------------------------

variable "monthly_budget_usd" {
  description = <<EOT
Hard monthly cap in USD. Alerts fire at 80% forecast, 80% actual, 100%
actual, 120% forecast. If we cross 100% that's an invoice event — go
read CloudWatch Billing dashboard and find the runaway service.
EOT
  type        = number
  default     = 200
  validation {
    condition     = var.monthly_budget_usd > 0 && var.monthly_budget_usd <= 10000
    error_message = "monthly_budget_usd must be 1..10000 (guard against typo-inflation)."
  }
}

variable "budget_alert_email" {
  description = "Email receiving budget alert notifications. AWS sends a confirmation email on first apply — CLICK THE LINK or alerts won't fire."
  type        = string
  validation {
    condition     = can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.budget_alert_email))
    error_message = "budget_alert_email must be a valid email address."
  }
}

# --- Cloudflare --------------------------------------------------------------

variable "cloudflare_account_id" {
  description = "Cloudflare Account ID — visible in the dash sidebar. Used for Workers, Pages, and Zero Trust resources."
  type        = string
  validation {
    condition     = can(regex("^[a-f0-9]{32}$", var.cloudflare_account_id))
    error_message = "cloudflare_account_id must be 32 hex characters."
  }
}

variable "cloudflare_zone_id" {
  description = "Cloudflare Zone ID for gbox.co. Different from Account ID — visible under 'API' on the zone overview page."
  type        = string
  validation {
    condition     = can(regex("^[a-f0-9]{32}$", var.cloudflare_zone_id))
    error_message = "cloudflare_zone_id must be 32 hex characters."
  }
}

variable "cdn_hostname" {
  description = "Hostname Cloudflare serves assets under. Must have a DNS record (orange cloud on)."
  type        = string
  default     = "cdn.gbox.co"
}

# --- CORS / storefront -------------------------------------------------------

variable "cors_allowed_origins" {
  description = <<EOT
Origins allowed to fetch public-media via browser fetch(). Storefronts
under gbox.co + tw3.store. Admin dashboard doesn't need CORS because
S3 reads go through the server, not the browser.
EOT
  type        = list(string)
  default = [
    "https://gbox.co",
    "https://*.gbox.co",
    "https://tw3.store",
    "https://*.tw3.store",
  ]
}
