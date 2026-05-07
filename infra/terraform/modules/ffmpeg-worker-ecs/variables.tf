# ---------------------------------------------------------------------------
# Module: ffmpeg-worker-ecs (STAGE 2 STUB)
#
# Launches one Fargate SPOT service that polls BullMQ for transcode jobs
# and runs ffmpeg over the S3 primary bucket. Scale-to-zero when the
# queue is empty (CloudWatch metric → Auto Scaling).
#
# Why Fargate Spot:
#   - 70% cheaper than on-demand, and transcoding is batch — task kills
#     just re-queue the BullMQ job.
#   - We tolerate 2-min shutdown SIGTERM because ffmpeg can resume from
#     checkpoint (spec §12.2).
# ---------------------------------------------------------------------------

variable "env" {
  description = "Environment short name (dev | staging | prod)."
  type        = string
  validation {
    condition     = contains(["dev", "staging", "prod"], var.env)
    error_message = "env must be one of: dev, staging, prod."
  }
}

variable "vpc_id" {
  description = "VPC to launch workers in. Needs NAT egress for ECR + Redis + S3."
  type        = string
  default     = ""
}

variable "subnet_ids" {
  description = "Private subnets. No inbound traffic — workers poll outbound only."
  type        = list(string)
  default     = []
}

variable "task_role_arn" {
  description = "Task IAM role — modules/iam-roles.ffmpeg_role_arn. Scoped to /videos/* prefix."
  type        = string
}

variable "execution_role_arn" {
  description = "Fargate execution role — modules/iam-roles.ffmpeg_execution_role_arn."
  type        = string
}

variable "ffmpeg_image" {
  description = "Container image with ffmpeg + BullMQ worker baked in. Built from apps/ffmpeg-worker Dockerfile. Default placeholder; replace with your ECR URI."
  type        = string
  default     = "629720697813.dkr.ecr.ap-southeast-1.amazonaws.com/gbox-ffmpeg-worker:latest"
}

variable "redis_url_secret_arn" {
  description = "Secrets Manager ARN storing REDIS_URL (BullMQ connection string)."
  type        = string
  default     = ""
}

variable "task_cpu" {
  description = "Fargate CPU units. 2048 = 2 vCPU — enough for 1080p H.264 → HLS in real-time on libx264 fast preset."
  type        = number
  default     = 2048
}

variable "task_memory" {
  description = "Fargate memory (MB). 4096 MB for 1080p workflow — ffmpeg holds a few seconds of decoded frames."
  type        = number
  default     = 4096
}

variable "autoscaling_min" {
  description = "Minimum worker count. 0 → scale-to-zero when idle (saves ~$40/month per worker)."
  type        = number
  default     = 0
}

variable "autoscaling_max" {
  description = "Maximum worker count. Higher = faster tail latency on big uploads, but chews Fargate Spot quota."
  type        = number
  default     = 10
}

variable "queue_depth_scaling_threshold" {
  description = "BullMQ queue depth that triggers scale-out. Each worker processes ~1 job/min for typical 60s clips → set threshold to (target_minutes_of_backlog × worker_count)."
  type        = number
  default     = 5
}

variable "tags" {
  description = "Tags applied to cluster, service, task definition."
  type        = map(string)
  default     = {}
}
