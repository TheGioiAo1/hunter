output "backend_role_arn" {
  description = "ARN to attach to the Gbox API EC2 instance or ECS task."
  value       = aws_iam_role.backend.arn
}

output "backend_role_name" {
  description = "Role name (for IAM console links, CLI assume-role commands)."
  value       = aws_iam_role.backend.name
}

output "backend_instance_profile_name" {
  description = "Instance profile name — pass to aws_instance.iam_instance_profile when launching EC2."
  value       = aws_iam_instance_profile.backend.name
}

output "imgproxy_role_arn" {
  description = "ARN for imgproxy ECS task role (container-scope permissions)."
  value       = aws_iam_role.imgproxy.arn
}

output "imgproxy_execution_role_arn" {
  description = "ARN for imgproxy ECS execution role (ECR pull + log writes)."
  value       = aws_iam_role.imgproxy_execution.arn
}

output "ffmpeg_role_arn" {
  description = "ARN for ffmpeg-worker ECS task role."
  value       = aws_iam_role.ffmpeg.arn
}

output "ffmpeg_execution_role_arn" {
  description = "ARN for ffmpeg-worker ECS execution role."
  value       = aws_iam_role.ffmpeg_execution.arn
}

output "replication_role_arn" {
  description = "ARN that S3 assumes when replicating primary → DR. Feed back into modules/s3-bucket-set via var.replication_role_arn."
  value       = aws_iam_role.replication.arn
}
