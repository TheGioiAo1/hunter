# ---------------------------------------------------------------------------
# Module: cloudflare-zone
#
# Implements spec §10 (Cloudflare-side rules) for a single zone. The rules
# compose as follows:
#
#   Request arrives at cdn.gbox.co/foo.jpg
#       │
#       ▼
#   1. WAF / rate-limit           ← drops bots, rate-limits /img/* to 100 r/s
#       │
#       ▼
#   2. Cache Rule                 ← decides edge/browser TTL + cache key
#       │
#       ▼
#   3. Origin Rule                ← rewrites Host + path to S3 or imgproxy
#       │
#       ▼
#   origin (S3 or imgproxy)
#
# CF applies rules in declared-priority order within each product
# (Origin Rules 1..N, Cache Rules 1..N, etc.). Lower number = higher
# priority = evaluated first.
# ---------------------------------------------------------------------------

# ===========================================================================
# Origin Rules — reroute requests to the right backend based on path.
#
# Spec §10.2:
#   /themes/*                          → theme-library bucket
#   /img/*                             → imgproxy (signed URLs)
#   /shops/*.{jpg,png,webp,...}        → public-media (raw passthrough)
#   *                                  → default (public-media)
# ===========================================================================

# 1. /themes/* → theme-library bucket
resource "cloudflare_ruleset" "origin_rules" {
  zone_id = var.zone_id
  name    = "gbox-origin-routing"
  kind    = "zone"
  phase   = "http_request_origin"

  # Rule A — theme-library bucket routing.
  rules {
    action      = "route"
    description = "Route ${var.theme_library_path_prefix}/* → theme-library S3 bucket"
    enabled     = true
    expression  = "(http.host eq \"${var.cdn_hostname}\") and (starts_with(http.request.uri.path, \"${var.theme_library_path_prefix}/\"))"

    action_parameters {
      host_header = var.s3_theme_library_domain
      origin {
        host = var.s3_theme_library_domain
      }
    }
  }

  # Rule B — imgproxy signed URLs.
  # When imgproxy_host is blank we skip this rule entirely (Stage 1: CF up
  # before ECS). The rule is still declared so prod plan is deterministic.
  dynamic "rules" {
    for_each = var.imgproxy_host != "" ? [1] : []
    content {
      action      = "route"
      description = "Route ${var.imgproxy_signed_url_prefix}/* → imgproxy NLB"
      enabled     = true
      expression  = "(http.host eq \"${var.cdn_hostname}\") and (starts_with(http.request.uri.path, \"${var.imgproxy_signed_url_prefix}/\"))"

      action_parameters {
        host_header = var.imgproxy_host
        origin {
          host = var.imgproxy_host
          port = 8080
        }
      }
    }
  }

  # Rule C — default public-media bucket.
  # Evaluated last → matches anything not caught above.
  rules {
    action      = "route"
    description = "Default → public-media S3 bucket"
    enabled     = true
    expression  = "(http.host eq \"${var.cdn_hostname}\")"

    action_parameters {
      host_header = var.s3_public_media_domain
      origin {
        host = var.s3_public_media_domain
      }
    }
  }
}

# ===========================================================================
# Cache Rules — decide what to cache and for how long.
#
# Spec §10.3:
#   images → 1 year edge, 1 day browser, cache-key drops query string
#   /img/* → 1 year edge, 1 day browser, cache-key = URL path only
#   HTML   → bypass (never cached at edge)
# ===========================================================================

resource "cloudflare_ruleset" "cache_rules" {
  zone_id = var.zone_id
  name    = "gbox-cache-behavior"
  kind    = "zone"
  phase   = "http_request_cache_settings"

  # Rule 1 — /img/* signed imgproxy URLs. Cache by path only (signature
  # is in the path, so query string has no effect on the image).
  #
  # NOTE: TTL literals are inlined here because the Cloudflare provider v4
  # has a validator bug (issue #2988) that doesn't resolve variable refs
  # when checking `default` presence during `terraform validate`. Variables
  # plan+apply fine but fail `validate`. Until v5 is stable we keep literals.
  rules {
    action      = "set_cache_settings"
    description = "${var.imgproxy_signed_url_prefix}/* — 1y edge, 1d browser, key=path"
    enabled     = true
    expression  = "(http.host eq \"${var.cdn_hostname}\") and (starts_with(http.request.uri.path, \"${var.imgproxy_signed_url_prefix}/\"))"

    action_parameters {
      cache = true
      edge_ttl {
        mode    = "override_origin"
        default = 31536000 # 1 year
      }
      browser_ttl {
        mode    = "override_origin"
        default = 86400 # 1 day
      }
      cache_key {
        cache_deception_armor      = true
        ignore_query_strings_order = true
        # Drop query string entirely — signature is in path.
        custom_key {
          query_string {
            exclude = ["*"]
          }
        }
      }
    }
  }

  # Rule 2 — raw media under /shops/*.ext. Same TTL but keep query
  # string in cache key (some paths use ?v=<hash> for busting).
  rules {
    action      = "set_cache_settings"
    description = "/shops/*.{img,video} — 1y edge, 1d browser"
    enabled     = true
    expression  = "(http.host eq \"${var.cdn_hostname}\") and (http.request.uri.path matches \"^/shops/.*\\\\.(jpg|jpeg|png|gif|webp|avif|heic|heif|mp4|webm|m3u8|ts)$\")"

    action_parameters {
      cache = true
      edge_ttl {
        mode    = "override_origin"
        default = 31536000 # 1 year
      }
      browser_ttl {
        mode    = "override_origin"
        default = 86400 # 1 day
      }
    }
  }

  # Rule 3 — theme-library CSS/JS bundles. 1 year cache, these are
  # content-hashed filenames so they never change.
  rules {
    action      = "set_cache_settings"
    description = "${var.theme_library_path_prefix}/* bundles — 1y edge+browser"
    enabled     = true
    expression  = "(http.host eq \"${var.cdn_hostname}\") and (starts_with(http.request.uri.path, \"${var.theme_library_path_prefix}/\")) and (http.request.uri.path matches \"\\\\.(css|js|woff2?|ttf|otf|svg|ico)$\")"

    action_parameters {
      cache = true
      edge_ttl {
        mode    = "override_origin"
        default = 31536000 # 1 year
      }
      browser_ttl {
        mode    = "override_origin"
        default = 31536000 # 1 year (matches edge — fingerprinted filenames)
      }
    }
  }

  # Rule 4 — bypass cache for everything else (e.g. storefront HTML,
  # admin dashboard). These go to origin every time.
  rules {
    action      = "set_cache_settings"
    description = "Default — bypass cache"
    enabled     = true
    expression  = "(http.host eq \"${var.cdn_hostname}\")"

    action_parameters {
      cache = false
    }
  }
}

# ===========================================================================
# Transform Rules — normalize incoming URLs.
#
# Spec §10.5:
#   strip double slashes
#   force lowercase on bucket-path segment
#   add Vary: Accept for future AVIF/WebP negotiation
# ===========================================================================

resource "cloudflare_ruleset" "transform_rules" {
  zone_id = var.zone_id
  name    = "gbox-url-normalize"
  kind    = "zone"
  phase   = "http_request_transform"

  rules {
    action      = "rewrite"
    description = "Strip accidental double slashes in path"
    enabled     = true
    expression  = "(http.host eq \"${var.cdn_hostname}\") and (http.request.uri.path contains \"//\")"

    action_parameters {
      uri {
        path {
          # CF's rewrite engine doesn't support regex replace in free tier;
          # this concats but leaves double slashes intact for the edge to
          # normalize. Workers handle the full normalization in cdn-worker.
          expression = "regex_replace(http.request.uri.path, \"/{2,}\", \"/\")"
        }
      }
    }
  }
}

# ===========================================================================
# Response header transforms — add security headers + Vary.
# ===========================================================================

resource "cloudflare_ruleset" "response_headers" {
  zone_id = var.zone_id
  name    = "gbox-response-headers"
  kind    = "zone"
  phase   = "http_response_headers_transform"

  rules {
    action      = "rewrite"
    description = "Security + cache-negotiation headers for image responses"
    enabled     = true
    expression  = "(http.host eq \"${var.cdn_hostname}\") and (http.response.content_type.media_type in {\"image/jpeg\" \"image/png\" \"image/webp\" \"image/avif\" \"image/gif\"})"

    action_parameters {
      headers {
        name      = "Vary"
        operation = "set"
        value     = "Accept"
      }
      headers {
        name      = "X-Content-Type-Options"
        operation = "set"
        value     = "nosniff"
      }
      headers {
        name      = "Cross-Origin-Resource-Policy"
        operation = "set"
        value     = "cross-origin"
      }
    }
  }
}

# ===========================================================================
# WAF — rate limit on /img/* and bot / bad-UA blocks.
#
# Spec §10.4. Only enabled when var.enable_waf = true (prod).
# ===========================================================================

resource "cloudflare_ruleset" "waf_custom" {
  count = var.enable_waf ? 1 : 0

  zone_id = var.zone_id
  name    = "gbox-waf-custom"
  kind    = "zone"
  phase   = "http_request_firewall_custom"

  # Rule 1 — rate-limit /img/* at 100 req/s/IP.
  rules {
    action      = "block"
    description = "Rate-limit ${var.imgproxy_signed_url_prefix}/* to ${var.rate_limit_img_rps} r/s per IP"
    enabled     = true
    expression  = "(http.host eq \"${var.cdn_hostname}\") and (starts_with(http.request.uri.path, \"${var.imgproxy_signed_url_prefix}/\"))"

    ratelimit {
      characteristics     = ["cf.colo.id", "ip.src"]
      period              = 10
      requests_per_period = var.rate_limit_img_rps * 10 # threshold = rps × period
      mitigation_timeout  = 60
    }
  }

  # Rule 2 — block known scraper UAs. Short list; expand via
  # CF's managed bot list later.
  rules {
    action      = "block"
    description = "Block bad User-Agents (scrapers, known botnets)"
    enabled     = true
    expression  = "(http.user_agent contains \"python-requests\") or (http.user_agent contains \"curl/7.\") or (http.user_agent eq \"\")"
  }
}

# ===========================================================================
# Zone-wide settings (optional conveniences).
# ===========================================================================

# Force HTTPS everywhere on the zone. No reason to allow HTTP in 2026.
resource "cloudflare_zone_settings_override" "settings" {
  zone_id = var.zone_id

  settings {
    always_use_https         = "on"
    automatic_https_rewrites = "on"
    brotli                   = "on"
    http3                    = "on"
    min_tls_version          = "1.2"
    ssl                      = "strict" # origin must present valid cert
    tls_1_3                  = "on"
    websockets               = "off" # not needed for CDN
    security_level           = "medium"
  }
}
