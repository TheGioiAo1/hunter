# ---------------------------------------------------------------------------
# Module: cloudflare-zone
#
# Configures the CF zone that fronts gbox.co with the rules required by
# spec §10 (Origin Rules, Cache Rules, Transform Rules, WAF).
# ---------------------------------------------------------------------------

variable "zone_id" {
  description = "Cloudflare Zone ID for the domain (e.g. gbox.co's 32-char hex). Find under 'API' on the zone overview page."
  type        = string
  validation {
    condition     = can(regex("^[a-f0-9]{32}$", var.zone_id))
    error_message = "zone_id must be 32 hex characters."
  }
}

variable "account_id" {
  description = "Cloudflare Account ID (shown in dashboard sidebar)."
  type        = string
  validation {
    condition     = can(regex("^[a-f0-9]{32}$", var.account_id))
    error_message = "account_id must be 32 hex characters."
  }
}

variable "cdn_hostname" {
  description = "Hostname under which Cloudflare serves assets (e.g. cdn.gbox.co). Must have a DNS record with proxy enabled."
  type        = string
  default     = "cdn.gbox.co"
}

variable "s3_public_media_domain" {
  description = <<EOT
Regional S3 endpoint for the public-media bucket. Shape:
  gbox-public-media-<env>.s3.<region>.amazonaws.com
Emitted as module.s3_primary.regional_domains.public_media.
EOT
  type        = string
}

variable "s3_theme_library_domain" {
  description = "Regional S3 endpoint for the theme-library bucket."
  type        = string
}

variable "imgproxy_host" {
  description = <<EOT
Hostname imgproxy is reachable at — typically the NLB DNS name emitted by
modules/imgproxy-ecs. Set to an empty string during Stage 1 rollout
(before ECS is up) — the imgproxy routing rule skips itself when blank.
EOT
  type        = string
  default     = ""
}

variable "imgproxy_signed_url_prefix" {
  description = "Path prefix under which signed imgproxy URLs live (spec §11.3). Example: /img"
  type        = string
  default     = "/img"
}

variable "theme_library_path_prefix" {
  description = "Path prefix that routes to the theme-library bucket (spec §4.4b). Example: /themes"
  type        = string
  default     = "/themes"
}

variable "enable_waf" {
  description = <<EOT
Whether to create the prod-grade WAF custom rules. Spec §10.4 calls for:
  - rate-limit on /img/* to 100 req/s/IP
  - block known bad User-Agents
  - Bot Fight Mode on

Prod: true. Dev: false. Saves CF rule quota on non-prod.
EOT
  type        = bool
  default     = true
}

variable "rate_limit_img_rps" {
  description = "Requests/sec/IP ceiling on imgproxy-signed paths. 100 r/s handles a page with ~30 images reloaded aggressively."
  type        = number
  default     = 100
}

variable "cache_ttl_image_browser" {
  description = <<EOT
Browser Cache TTL for images (seconds). 1 day = 86400.
RESERVED — currently ignored. The Cloudflare provider v4 has a validator
bug (issue #2988) that blocks variable refs inside edge_ttl/browser_ttl
blocks. Values are inlined as literals in main.tf until we upgrade to
provider v5. Keep this variable declared so callers don't break when the
fix lands.
EOT
  type        = number
  default     = 86400
}

variable "cache_ttl_image_edge" {
  description = <<EOT
Edge Cache TTL for images (seconds). 1 year = 31536000.
RESERVED — see note on `cache_ttl_image_browser`.
EOT
  type        = number
  default     = 31536000
}
