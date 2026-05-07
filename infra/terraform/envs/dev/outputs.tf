output "s3_buckets" {
  description = "Dev bucket names. Use for ENV override on local Node API."
  value       = module.s3_primary.bucket_ids
}

output "s3_arns" {
  description = "Dev bucket ARNs."
  value       = module.s3_primary.bucket_arns
}

output "s3_regional_domains" {
  description = "Regional endpoints — useful for CDN_BASE_URL override when running Astro locally."
  value       = module.s3_primary.regional_domains
}

output "iam_backend_role_arn" {
  description = "Backend role — attach to local Node API via aws sts assume-role for integration tests."
  value       = module.iam.backend_role_arn
}

output "iam_imgproxy_role_arn" {
  description = "Imgproxy role — referenced in local imgproxy Docker run scripts."
  value       = module.iam.imgproxy_role_arn
}

output "budget_sns_topic_arn" {
  description = "SNS topic dev budgets publish to."
  value       = module.budget.sns_topic_arn
}
