# Module: s3-bucket-set
# Creates the 4 bucket roles (public-media, theme-library, private,
# backups) for a single environment + region. Call the module twice to
# get primary + DR buckets.

variable "env" {
  description = "Environment short name (dev | staging | prod)."
  type        = string
  validation {
    condition     = contains(["dev", "staging", "prod"], var.env)
    error_message = "env must be one of: dev, staging, prod."
  }
}

variable "suffix" {
  description = <<EOT
Suffix appended to every bucket name. Use empty string for primary
region, '-dr' for DR replica. Lets us create both sides of a CRR pair
without duplicating the module definition.
EOT
  type        = string
  default     = ""
}

variable "region" {
  description = "AWS region for these buckets (e.g. ap-southeast-1)."
  type        = string
}

variable "cors_allowed_origins" {
  description = <<EOT
Origins allowed to make CORS requests against public-media. Typically:
  ["https://*.gbox.co", "https://gbox.co", "https://*.tw3.store"]
EOT
  type        = list(string)
  default     = ["https://*.gbox.co", "https://gbox.co"]
}

variable "cloudflare_user_agent" {
  description = <<EOT
Exact User-Agent string the Cloudflare Worker stamps on every request
(see apps/cdn-worker/src/index.ts:43). Bucket policy requires this UA
as an additional egress gate on top of the Cloudflare IP allowlist.
EOT
  type        = string
  default     = "Mozilla/5.0 (compatible; GboxEdge/1.0; +https://gbox.co/edge)"
}

variable "cloudflare_ipv4_cidrs" {
  description = <<EOT
Cloudflare's published IPv4 ranges (https://www.cloudflare.com/ips-v4).
Refresh quarterly — stale IPs cause legit edge requests to 403. A Lambda
auto-refresher is on the Phase C backlog.
EOT
  type        = list(string)
  default = [
    "173.245.48.0/20",
    "103.21.244.0/22",
    "103.22.200.0/22",
    "103.31.4.0/22",
    "141.101.64.0/18",
    "108.162.192.0/18",
    "190.93.240.0/20",
    "188.114.96.0/20",
    "197.234.240.0/22",
    "198.41.128.0/17",
    "162.158.0.0/15",
    "104.16.0.0/13",
    "104.24.0.0/14",
    "172.64.0.0/13",
    "131.0.72.0/22",
  ]
}

variable "cloudflare_ipv6_cidrs" {
  description = "Cloudflare's published IPv6 ranges (https://www.cloudflare.com/ips-v6)."
  type        = list(string)
  default = [
    "2400:cb00::/32",
    "2606:4700::/32",
    "2803:f800::/32",
    "2405:b500::/32",
    "2405:8100::/32",
    "2a06:98c0::/29",
    "2c0f:f248::/32",
  ]
}

variable "imgproxy_egress_cidrs" {
  description = <<EOT
Private CIDR blocks of the subnets where imgproxy ECS tasks run. Only
these + the Cloudflare ranges can GetObject from public-media. Leave
empty until ECS is provisioned — the imgproxy module outputs its
NAT-ed CIDRs which you then wire back in.
EOT
  type        = list(string)
  default     = []
}

variable "public_media_lifecycle_days" {
  description = "Days before public-media objects transition to Intelligent-Tiering."
  type        = number
  default     = 90
}

variable "theme_library_drafts_ttl_days" {
  description = "Days before theme-library drafts/* objects are deleted. Published themes are kept forever."
  type        = number
  default     = 90
}

variable "backups_glacier_days" {
  description = "Days before backups transition to Glacier."
  type        = number
  default     = 30
}

variable "backups_deep_archive_days" {
  description = "Days before backups transition to Deep Archive (must be > glacier_days)."
  type        = number
  default     = 180
}

variable "private_invoices_ttl_years" {
  description = "Years to retain invoice PDFs (spec §4.4c — legal minimum: 7 years)."
  type        = number
  default     = 7
}

variable "private_exports_ttl_days" {
  description = "Days to retain merchant export files (CSV, backups) — spec §4.4c."
  type        = number
  default     = 90
}

variable "private_pod_ttl_years" {
  description = "Years to retain proof-of-delivery files — spec §4.4c."
  type        = number
  default     = 2
}

variable "enable_replication" {
  description = <<EOT
Whether this bucket set is the PRIMARY side of a CRR pair. When true,
outputs include replication role ARN + destination bucket IDs so the
caller can wire up aws_s3_bucket_replication_configuration. Set false
on the DR side.
EOT
  type        = bool
  default     = false
}

variable "replication_role_arn" {
  description = <<EOT
ARN of the IAM role S3 assumes when replicating to the DR bucket set.
Passed in from modules/iam-roles. Required when enable_replication = true.
EOT
  type        = string
  default     = ""
}

variable "replication_destinations" {
  description = <<EOT
Map of bucket-role → DR bucket ARN. Expected keys: public_media,
theme_library, private, backups. Pass the outputs of the DR
s3-bucket-set module call.
EOT
  type = object({
    public_media  = optional(string, "")
    theme_library = optional(string, "")
    private       = optional(string, "")
    backups       = optional(string, "")
  })
  default = {}
}

variable "tags" {
  description = "Tags applied to every bucket in this set."
  type        = map(string)
  default     = {}
}
