# Module outputs — caller env (envs/prod, envs/staging) consumes these to
# wire up IAM policies, imgproxy config, and the Cloudflare origin rules.

output "bucket_ids" {
  description = "Map of role → bucket name (same as bucket id in AWS)."
  value = {
    public_media  = aws_s3_bucket.public_media.id
    theme_library = aws_s3_bucket.theme_library.id
    private       = aws_s3_bucket.private.id
    backups       = aws_s3_bucket.backups.id
  }
}

output "bucket_arns" {
  description = "Map of role → bucket ARN. IAM policies reference these + /* for object-level grants."
  value = {
    public_media  = aws_s3_bucket.public_media.arn
    theme_library = aws_s3_bucket.theme_library.arn
    private       = aws_s3_bucket.private.arn
    backups       = aws_s3_bucket.backups.arn
  }
}

output "regional_domains" {
  description = <<EOT
Regional S3 endpoints — Cloudflare Origin Rules use these as override
hosts. Example: gbox-public-media-prod.s3.ap-southeast-1.amazonaws.com
EOT
  value = {
    public_media  = aws_s3_bucket.public_media.bucket_regional_domain_name
    theme_library = aws_s3_bucket.theme_library.bucket_regional_domain_name
    private       = aws_s3_bucket.private.bucket_regional_domain_name
    backups       = aws_s3_bucket.backups.bucket_regional_domain_name
  }
}

output "website_domains" {
  description = "S3 website-style endpoints. Rarely used (we front with Cloudflare) but handy for direct debugging."
  value = {
    public_media  = aws_s3_bucket.public_media.bucket_domain_name
    theme_library = aws_s3_bucket.theme_library.bucket_domain_name
    private       = aws_s3_bucket.private.bucket_domain_name
    backups       = aws_s3_bucket.backups.bucket_domain_name
  }
}

output "env" {
  description = "Environment this module was instantiated for (dev | staging | prod). Echoed back for caller convenience."
  value       = var.env
}

output "region" {
  description = "AWS region these buckets live in."
  value       = var.region
}
