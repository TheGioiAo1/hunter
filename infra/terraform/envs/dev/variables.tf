variable "aws_account_id" {
  description = "12-digit AWS account. Sanity-check against sts:GetCallerIdentity before apply."
  type        = string
  validation {
    condition     = can(regex("^[0-9]{12}$", var.aws_account_id))
    error_message = "aws_account_id must be 12 digits."
  }
}

variable "primary_region" {
  description = "AWS region for dev. Same as prod to keep cost model consistent."
  type        = string
  default     = "ap-southeast-1"
}

variable "monthly_budget_usd" {
  description = "Dev budget cap. $20/mo covers ~4 GB stored + token traffic."
  type        = number
  default     = 20
}

variable "budget_alert_email" {
  description = "Email receiving dev budget alerts. Can be same as prod."
  type        = string
  validation {
    condition     = can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.budget_alert_email))
    error_message = "budget_alert_email must be a valid email."
  }
}
