# ---------------------------------------------------------------------------
# Module: ffmpeg-worker-ecs (STAGE 2 STUB)
#
# Intentionally resource-less for now. The full sketch below lives here
# so Thai (or future-you) can copy-paste the blocks when we flip the
# switch. Key design:
#
#   - capacity_provider_strategy: 100% FARGATE_SPOT (no on-demand fallback).
#     If Spot runs out of capacity we pay in wait-time, not money.
#
#   - Scale target: BullMQ queue depth (via custom CloudWatch metric
#     published by the worker itself). Scale to 0 when depth = 0.
#
#   - SIGTERM grace period: 120s. ffmpeg needs to write partial HLS
#     segments to S3 + delete half-uploaded keys before exit.
#
# Sketch:
#
#   resource "aws_ecs_cluster" "ffmpeg" {
#     name = "gbox-${var.env}-ffmpeg"
#     setting { name = "containerInsights" value = "enabled" }
#     tags = local.common_tags
#   }
#
#   resource "aws_ecs_cluster_capacity_providers" "ffmpeg" {
#     cluster_name       = aws_ecs_cluster.ffmpeg.name
#     capacity_providers = ["FARGATE_SPOT"]
#     default_capacity_provider_strategy {
#       capacity_provider = "FARGATE_SPOT"
#       weight            = 100
#       base              = 0
#     }
#   }
#
#   resource "aws_cloudwatch_log_group" "ffmpeg" {
#     name              = "/aws/ecs/gbox-${var.env}-ffmpeg"
#     retention_in_days = 30
#     tags              = local.common_tags
#   }
#
#   resource "aws_security_group" "ffmpeg_task" {
#     name        = "gbox-${var.env}-ffmpeg-task-sg"
#     description = "ffmpeg worker — egress only (Redis, S3, ECR)"
#     vpc_id      = var.vpc_id
#     egress {
#       from_port   = 0
#       to_port     = 0
#       protocol    = "-1"
#       cidr_blocks = ["0.0.0.0/0"]
#     }
#   }
#
#   resource "aws_ecs_task_definition" "ffmpeg" {
#     family                   = "gbox-${var.env}-ffmpeg"
#     network_mode             = "awsvpc"
#     requires_compatibilities = ["FARGATE"]
#     cpu                      = var.task_cpu
#     memory                   = var.task_memory
#     task_role_arn            = var.task_role_arn
#     execution_role_arn       = var.execution_role_arn
#     container_definitions = jsonencode([
#       {
#         name      = "ffmpeg-worker"
#         image     = var.ffmpeg_image
#         essential = true
#         stopTimeout = 120     # grace for ffmpeg cleanup
#         environment = [
#           { name = "NODE_ENV",         value = var.env },
#           { name = "S3_BUCKET",        value = "gbox-public-media-${var.env}" },
#           { name = "S3_REGION",        value = data.aws_region.current.name },
#         ]
#         secrets = [
#           { name = "REDIS_URL", valueFrom = "${var.redis_url_secret_arn}:REDIS_URL::" },
#         ]
#         logConfiguration = {
#           logDriver = "awslogs"
#           options = {
#             awslogs-group         = aws_cloudwatch_log_group.ffmpeg.name
#             awslogs-region        = data.aws_region.current.name
#             awslogs-stream-prefix = "ffmpeg"
#           }
#         }
#       }
#     ])
#   }
#
#   resource "aws_ecs_service" "ffmpeg" {
#     name            = "gbox-${var.env}-ffmpeg"
#     cluster         = aws_ecs_cluster.ffmpeg.id
#     task_definition = aws_ecs_task_definition.ffmpeg.arn
#     desired_count   = 0   # starts at zero, autoscaler brings it up
#
#     capacity_provider_strategy {
#       capacity_provider = "FARGATE_SPOT"
#       weight            = 100
#       base              = 0
#     }
#
#     network_configuration {
#       subnets          = var.subnet_ids
#       security_groups  = [aws_security_group.ffmpeg_task.id]
#       assign_public_ip = false
#     }
#
#     lifecycle {
#       ignore_changes = [desired_count]  # autoscaler owns this
#     }
#   }
#
#   resource "aws_appautoscaling_target" "ffmpeg" {
#     max_capacity       = var.autoscaling_max
#     min_capacity       = var.autoscaling_min
#     resource_id        = "service/${aws_ecs_cluster.ffmpeg.name}/${aws_ecs_service.ffmpeg.name}"
#     scalable_dimension = "ecs:service:DesiredCount"
#     service_namespace  = "ecs"
#   }
#
#   resource "aws_appautoscaling_policy" "ffmpeg_queue_depth" {
#     name               = "gbox-${var.env}-ffmpeg-queue-depth"
#     policy_type        = "TargetTrackingScaling"
#     resource_id        = aws_appautoscaling_target.ffmpeg.resource_id
#     scalable_dimension = aws_appautoscaling_target.ffmpeg.scalable_dimension
#     service_namespace  = aws_appautoscaling_target.ffmpeg.service_namespace
#     target_tracking_scaling_policy_configuration {
#       customized_metric_specification {
#         metric_name = "BullMqQueueDepth"
#         namespace   = "Gbox/Transcode"
#         statistic   = "Average"
#         dimensions {
#           name  = "Queue"
#           value = "video-transcode"
#         }
#         dimensions {
#           name  = "Environment"
#           value = var.env
#         }
#       }
#       target_value       = var.queue_depth_scaling_threshold
#       scale_in_cooldown  = 300
#       scale_out_cooldown = 30
#     }
#   }
# ---------------------------------------------------------------------------

locals {
  module_status = "stub-phase-b-stage-2"
}
