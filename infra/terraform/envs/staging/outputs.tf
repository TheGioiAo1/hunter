output "s3_primary_buckets" {
  description = "Staging primary bucket names."
  value       = module.s3_primary.bucket_ids
}

output "s3_dr_buckets" {
  description = "Staging DR bucket names."
  value       = module.s3_dr.bucket_ids
}

output "s3_primary_arns" {
  value = module.s3_primary.bucket_arns
}

output "s3_primary_regional_domains" {
  value = module.s3_primary.regional_domains
}

output "iam_backend_role_arn" {
  value = module.iam.backend_role_arn
}

output "iam_imgproxy_role_arn" {
  value = module.iam.imgproxy_role_arn
}

output "iam_ffmpeg_role_arn" {
  value = module.iam.ffmpeg_role_arn
}

output "budget_sns_topic_arn" {
  value = module.budget.sns_topic_arn
}

# cloudflare_origin_ruleset_id — disabled alongside module "cloudflare"
# in main.tf while staging is on the shared prod zone. Uncomment once
# the dedicated staging zone is provisioned.
#
# output "cloudflare_origin_ruleset_id" {
#   value = module.cloudflare.origin_ruleset_id
# }
