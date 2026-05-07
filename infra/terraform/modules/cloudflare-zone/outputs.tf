output "origin_ruleset_id" {
  description = "Ruleset ID for the Origin-phase rules. Handy for API-based updates."
  value       = cloudflare_ruleset.origin_rules.id
}

output "cache_ruleset_id" {
  description = "Ruleset ID for the Cache-phase rules."
  value       = cloudflare_ruleset.cache_rules.id
}

output "transform_ruleset_id" {
  description = "Ruleset ID for URL transform rules."
  value       = cloudflare_ruleset.transform_rules.id
}

output "response_headers_ruleset_id" {
  description = "Ruleset ID for response-header mutation rules."
  value       = cloudflare_ruleset.response_headers.id
}

output "waf_ruleset_id" {
  description = "Ruleset ID for the WAF custom rules. Null when enable_waf = false."
  value       = var.enable_waf ? cloudflare_ruleset.waf_custom[0].id : null
}

output "cdn_hostname" {
  description = "The hostname CF is now configured to serve — echo back for runbooks."
  value       = var.cdn_hostname
}
