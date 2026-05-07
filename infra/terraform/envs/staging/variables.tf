variable "aws_account_id" {
  description = "12-digit AWS account."
  type        = string
  validation {
    condition     = can(regex("^[0-9]{12}$", var.aws_account_id))
    error_message = "aws_account_id must be 12 digits."
  }
}

variable "primary_region" {
  description = "Primary AWS region."
  type        = string
  default     = "ap-southeast-1"
}

variable "dr_region" {
  description = "DR AWS region."
  type        = string
  default     = "ap-northeast-1"
}

variable "monthly_budget_usd" {
  description = "Staging budget cap — $60/mo covers full stack at 1/5th prod scale."
  type        = number
  default     = 60
}

variable "budget_alert_email" {
  description = "Email receiving staging budget alerts."
  type        = string
  validation {
    condition     = can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.budget_alert_email))
    error_message = "budget_alert_email must be valid."
  }
}

variable "cloudflare_account_id" {
  description = "CF account ID."
  type        = string
  validation {
    condition     = can(regex("^[a-f0-9]{32}$", var.cloudflare_account_id))
    error_message = "cloudflare_account_id must be 32 hex chars."
  }
}

variable "cloudflare_zone_id" {
  description = "CF zone ID for staging. Often the same zone as prod if using staging.gbox.co subdomain."
  type        = string
  validation {
    condition     = can(regex("^[a-f0-9]{32}$", var.cloudflare_zone_id))
    error_message = "cloudflare_zone_id must be 32 hex chars."
  }
}

variable "cdn_hostname" {
  description = "Staging CDN hostname. Use a distinct subdomain like staging-cdn.gbox.co to keep routing isolated."
  type        = string
  default     = "staging-cdn.gbox.co"
}
