# Module: iam-roles
# Creates the four IAM roles referenced throughout the Phase B
# infrastructure (spec §6):
#
#   - GboxBackendRole        → attached to EC2/ECS running Node API
#   - GboxImgproxyRole       → attached to imgproxy ECS tasks
#   - GboxFfmpegWorkerRole   → attached to ffmpeg-worker ECS tasks
#   - GboxS3ReplicationRole  → assumed by S3 CRR service
#
# Each role only grants the minimum S3 + Secrets Manager + CloudWatch
# permissions it actually needs. The caller (env/prod) passes bucket
# ARNs as input so policies are scoped to the real resource names.

variable "env" {
  description = "Environment short name (dev | staging | prod). Appended to role names to keep envs isolated."
  type        = string
  validation {
    condition     = contains(["dev", "staging", "prod"], var.env)
    error_message = "env must be one of: dev, staging, prod."
  }
}

variable "primary_bucket_arns" {
  description = <<EOT
Map of role → bucket ARN for the PRIMARY region. Exactly the output
shape of modules/s3-bucket-set/outputs.tf `bucket_arns`.
EOT
  type = object({
    public_media  = string
    theme_library = string
    private       = string
    backups       = string
  })
}

variable "dr_bucket_arns" {
  description = <<EOT
Map of role → bucket ARN for the DR region. Backend role gets read-only
access to these for failover; replication role gets write access.
EOT
  type = object({
    public_media  = optional(string, "")
    theme_library = optional(string, "")
    private       = optional(string, "")
    backups       = optional(string, "")
  })
  default = {}
}

variable "secrets_manager_arn_prefix" {
  description = <<EOT
ARN prefix for Secrets Manager secrets this env can read. Typical
value: arn:aws:secretsmanager:ap-southeast-1:629720697813:secret:gbox/prod/*
Backend + Imgproxy roles both need this to fetch IMGPROXY_KEY / SALT.
EOT
  type        = string
}

variable "tags" {
  description = "Tags applied to every IAM role + policy."
  type        = map(string)
  default     = {}
}
