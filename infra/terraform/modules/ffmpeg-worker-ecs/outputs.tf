# ---------------------------------------------------------------------------
# ffmpeg-worker-ecs outputs (STAGE 2 STUB).
# ---------------------------------------------------------------------------

output "cluster_name" {
  description = "ECS cluster hosting the ffmpeg workers. Empty until Stage 2."
  value       = ""
}

output "service_name" {
  description = "ECS service name. Empty until Stage 2."
  value       = ""
}

output "task_security_group_id" {
  description = "Security group assigned to ffmpeg worker tasks."
  value       = ""
}

output "module_status" {
  description = "Returns \"stub-phase-b-stage-2\" until real implementation."
  value       = local.module_status
}
