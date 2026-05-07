# ---------------------------------------------------------------------------
# imgproxy-ecs outputs (STAGE 2 STUB).
#
# Placeholders for the NLB DNS name and ECS service name — consumers
# (envs/prod, cloudflare-zone) can reference these without null checks
# once Stage 2 drops in the real resources. Until then every output is
# empty string / null.
# ---------------------------------------------------------------------------

output "nlb_dns_name" {
  description = "DNS name of the imgproxy NLB. Feed into module.cloudflare.imgproxy_host. Empty string until Stage 2."
  value       = ""
}

output "cluster_name" {
  description = "ECS cluster name hosting the imgproxy service. Empty until Stage 2."
  value       = ""
}

output "service_name" {
  description = "ECS service name. Empty until Stage 2."
  value       = ""
}

output "task_security_group_id" {
  description = "Security group assigned to imgproxy tasks. Empty until Stage 2."
  value       = ""
}

output "nat_cidrs" {
  description = "NAT gateway CIDRs for tasks. Wire these back into modules/s3-bucket-set.imgproxy_egress_cidrs once Stage 2 is live."
  value       = []
}

output "module_status" {
  description = "Returns \"stub-phase-b-stage-2\" until the real implementation replaces main.tf."
  value       = local.module_status
}
