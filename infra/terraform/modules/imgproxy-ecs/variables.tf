# ---------------------------------------------------------------------------
# Module: imgproxy-ecs (STAGE 2 STUB)
#
# Full implementation lands in Stage 2 of Phase B rollout — once S3 + CF
# prove out and we have real traffic to size the cluster against. This
# file currently declares the INPUTS the full module will accept so
# envs/prod can reference `module "imgproxy"` without blowing up.
#
# Apply the full resources once we're ready to move image transforms off
# of the dev Worker (current placeholder) onto dedicated Fargate tasks.
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
  description = "Existing VPC ID to place ECS tasks + NLB in. Create the VPC via a separate module (networking) or pass the default VPC for dev."
  type        = string
  default     = ""
}

variable "subnet_ids" {
  description = "Private subnet IDs for Fargate tasks. NAT gateway in each subnet so tasks can pull from ECR."
  type        = list(string)
  default     = []
}

variable "public_subnet_ids" {
  description = "Public subnet IDs for the NLB in front of imgproxy. Need >= 2 AZs for HA."
  type        = list(string)
  default     = []
}

variable "task_role_arn" {
  description = "IAM role ARN for the imgproxy task — output of modules/iam-roles.imgproxy_role_arn."
  type        = string
}

variable "execution_role_arn" {
  description = "Fargate execution role ARN — output of modules/iam-roles.imgproxy_execution_role_arn."
  type        = string
}

variable "imgproxy_image" {
  description = "Container image for imgproxy. Pinned to a release tag (never :latest)."
  type        = string
  default     = "public.ecr.aws/darthsim/imgproxy:v3.26"
}

variable "task_cpu" {
  description = "Fargate task CPU units. 256 = 0.25 vCPU, 512 = 0.5 vCPU, 1024 = 1 vCPU. imgproxy is CPU-bound on libvips transforms."
  type        = number
  default     = 512
}

variable "task_memory" {
  description = "Fargate task memory in MB. 1024 MB handles ~2-3 MP source images comfortably."
  type        = number
  default     = 1024
}

variable "desired_count" {
  description = "Steady-state task count. autoscaling_min/max ignore this after first deploy."
  type        = number
  default     = 2
}

variable "autoscaling_min" {
  description = "Minimum task count. Prod → 2 (HA across AZs). Staging/dev → 1."
  type        = number
  default     = 2
}

variable "autoscaling_max" {
  description = "Maximum task count. Bound by Fargate vCPU quota + cost. 20 tasks × 0.5 vCPU = 10 vCPU burst ≈ $30/day at 100% utilization."
  type        = number
  default     = 20
}

variable "secrets_manager_arn" {
  description = "Secret holding IMGPROXY_KEY and IMGPROXY_SALT. Injected into the task as environment variables via ECS `secrets`."
  type        = string
  default     = ""
}

variable "tags" {
  description = "Tags applied to cluster, service, NLB."
  type        = map(string)
  default     = {}
}
