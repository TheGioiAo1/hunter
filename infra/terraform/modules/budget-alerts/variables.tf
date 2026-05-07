variable "env" {
  description = "Environment short name (dev | staging | prod)."
  type        = string
  validation {
    condition     = contains(["dev", "staging", "prod"], var.env)
    error_message = "env must be one of: dev, staging, prod."
  }
}

variable "monthly_cap_usd" {
  description = <<EOT
Monthly budget cap in USD. Alerts fire at 80% forecast, 80% actual,
100% actual, 120% forecast. Set to your maximum acceptable bill.
Suggested: dev $20, staging $50, prod $200 (per Thai's Phase B plan).
EOT
  type        = number
  validation {
    condition     = var.monthly_cap_usd > 0 && var.monthly_cap_usd <= 10000
    error_message = "monthly_cap_usd must be between 1 and 10000. Guardrail against typo-inflated caps."
  }
}

variable "alert_email" {
  description = <<EOT
Email that receives budget alerts. AWS sends a confirmation email on
first apply — must be clicked to activate the subscription. Check spam
folder for AWS Notifications <no-reply@sns.amazonaws.com>.
EOT
  type        = string
  validation {
    condition     = can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.alert_email))
    error_message = "alert_email must be a valid email address."
  }
}

variable "tags" {
  description = "Tags applied to the SNS topic + Budget."
  type        = map(string)
  default     = {}
}
