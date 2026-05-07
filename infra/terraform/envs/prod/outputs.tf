# ---------------------------------------------------------------------------
# Outputs for envs/prod.
#
# These surface the values that the Node API, deployment scripts, or
# future ops runbooks need. They also make `terraform output -json`
# into a readable machine-consumable inventory.
#
# Nothing sensitive is exposed here — IAM role ARNs are not secrets
# (they're visible in the AWS console) and bucket names are public
# by nature once objects are served through Cloudflare.
# ---------------------------------------------------------------------------

output "s3_primary_buckets" {
  description = "Primary region bucket names (ap-southeast-1)."
  value       = module.s3_primary.bucket_ids
}

output "s3_primary_arns" {
  description = "Primary region bucket ARNs — feed into ENV vars S3_PUBLIC_MEDIA_BUCKET, etc."
  value       = module.s3_primary.bucket_arns
}

output "s3_primary_regional_domains" {
  description = "Primary S3 regional endpoints. Cloudflare Origin Rules override host to these."
  value       = module.s3_primary.regional_domains
}

output "s3_dr_buckets" {
  description = "DR region bucket names (ap-northeast-1). Objects land here via CRR."
  value       = module.s3_dr.bucket_ids
}

output "iam_backend_role_arn" {
  description = "ARN for the backend Node API — assign to EC2 instance profile OR ECS task role."
  value       = module.iam.backend_role_arn
}

output "iam_backend_instance_profile" {
  description = "Instance profile name for attaching to aws_instance.iam_instance_profile."
  value       = module.iam.backend_instance_profile_name
}

output "iam_imgproxy_role_arn" {
  description = "ARN for imgproxy ECS task role."
  value       = module.iam.imgproxy_role_arn
}

output "iam_imgproxy_execution_role_arn" {
  description = "ARN for imgproxy ECS execution role (ECR pull + log writes)."
  value       = module.iam.imgproxy_execution_role_arn
}

output "iam_ffmpeg_role_arn" {
  description = "ARN for ffmpeg-worker ECS task role."
  value       = module.iam.ffmpeg_role_arn
}

output "iam_ffmpeg_execution_role_arn" {
  description = "ARN for ffmpeg-worker ECS execution role."
  value       = module.iam.ffmpeg_execution_role_arn
}

output "budget_sns_topic_arn" {
  description = "SNS topic that AWS Budgets publishes to. Subscribe additional protocols (Slack webhook, PagerDuty) here later."
  value       = module.budget.sns_topic_arn
}

output "budget_name" {
  description = "Name of the AWS Budget — use to deep-link into console."
  value       = module.budget.budget_name
}

output "cloudflare_origin_ruleset_id" {
  description = "Origin-phase ruleset ID — handy for manually tweaking priority via CF API."
  value       = module.cloudflare.origin_ruleset_id
}

output "cloudflare_cache_ruleset_id" {
  description = "Cache-phase ruleset ID."
  value       = module.cloudflare.cache_ruleset_id
}

output "cloudflare_waf_ruleset_id" {
  description = "WAF ruleset ID. Null in envs where enable_waf = false."
  value       = module.cloudflare.waf_ruleset_id
}

# ---------------------------------------------------------------------------
# Computed helper outputs — convenient one-liners for runbooks.
# ---------------------------------------------------------------------------

output "env_vars_for_backend" {
  description = <<EOT
Drop-in ENV block for the Node API's .env.production. Copy these into
the secrets manager or ECS task definition. Missing: IMGPROXY_KEY,
IMGPROXY_SALT, REDIS_URL — those are managed outside Terraform.
EOT
  value = {
    AWS_REGION              = var.primary_region
    AWS_DR_REGION           = var.dr_region
    S3_PUBLIC_MEDIA_BUCKET  = module.s3_primary.bucket_ids.public_media
    S3_THEME_LIBRARY_BUCKET = module.s3_primary.bucket_ids.theme_library
    S3_PRIVATE_BUCKET       = module.s3_primary.bucket_ids.private
    S3_BACKUPS_BUCKET       = module.s3_primary.bucket_ids.backups
    S3_PUBLIC_MEDIA_DR      = module.s3_dr.bucket_ids.public_media
    CDN_BASE_URL            = "https://${var.cdn_hostname}"
    SECRETS_MANAGER_PREFIX  = local.secrets_arn_prefix
  }
}
