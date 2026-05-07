# ---------------------------------------------------------------------------
# Module: imgproxy-ecs (STAGE 2 STUB)
#
# This file is intentionally near-empty. It reserves the module namespace
# so envs/prod can do `module "imgproxy" { source = ... }` and pass in
# the real inputs today — the module just declares no resources until we
# flip the switch.
#
# When you're ready to light it up, replace this file with the full
# implementation sketched below:
#
#   resource "aws_ecs_cluster" "imgproxy" {
#     name = "gbox-${var.env}-imgproxy"
#     setting {
#       name  = "containerInsights"
#       value = "enabled"
#     }
#     tags = local.common_tags
#   }
#
#   resource "aws_cloudwatch_log_group" "imgproxy" {
#     name              = "/aws/ecs/gbox-${var.env}-imgproxy"
#     retention_in_days = 14
#     tags              = local.common_tags
#   }
#
#   resource "aws_lb" "nlb" {
#     name               = "gbox-${var.env}-imgproxy-nlb"
#     load_balancer_type = "network"
#     subnets            = var.public_subnet_ids
#     tags               = local.common_tags
#   }
#
#   resource "aws_lb_target_group" "imgproxy" {
#     name        = "gbox-${var.env}-imgproxy-tg"
#     port        = 8080
#     protocol    = "TCP"
#     vpc_id      = var.vpc_id
#     target_type = "ip"
#     health_check {
#       protocol = "HTTP"
#       path     = "/health"
#       port     = "8080"
#     }
#   }
#
#   resource "aws_lb_listener" "imgproxy" {
#     load_balancer_arn = aws_lb.nlb.arn
#     port              = 80
#     protocol          = "TCP"
#     default_action {
#       type             = "forward"
#       target_group_arn = aws_lb_target_group.imgproxy.arn
#     }
#   }
#
#   resource "aws_security_group" "imgproxy_task" {
#     name        = "gbox-${var.env}-imgproxy-task-sg"
#     description = "imgproxy ECS task SG — allow 8080 from NLB subnets"
#     vpc_id      = var.vpc_id
#     ingress {
#       from_port   = 8080
#       to_port     = 8080
#       protocol    = "tcp"
#       cidr_blocks = [for s in var.public_subnet_ids : data.aws_subnet.pub[s].cidr_block]
#     }
#     egress {
#       from_port   = 0
#       to_port     = 0
#       protocol    = "-1"
#       cidr_blocks = ["0.0.0.0/0"]
#     }
#   }
#
#   resource "aws_ecs_task_definition" "imgproxy" {
#     family                   = "gbox-${var.env}-imgproxy"
#     network_mode             = "awsvpc"
#     requires_compatibilities = ["FARGATE"]
#     cpu                      = var.task_cpu
#     memory                   = var.task_memory
#     task_role_arn            = var.task_role_arn
#     execution_role_arn       = var.execution_role_arn
#     container_definitions    = jsonencode([
#       {
#         name      = "imgproxy"
#         image     = var.imgproxy_image
#         essential = true
#         portMappings = [{ containerPort = 8080, hostPort = 8080, protocol = "tcp" }]
#         environment = [
#           { name = "IMGPROXY_BIND",              value = ":8080" },
#           { name = "IMGPROXY_MAX_SRC_RESOLUTION", value = "50" },
#           { name = "IMGPROXY_USE_S3",            value = "true" },
#         ]
#         secrets = [
#           { name = "IMGPROXY_KEY",  valueFrom = "${var.secrets_manager_arn}:IMGPROXY_KEY::" },
#           { name = "IMGPROXY_SALT", valueFrom = "${var.secrets_manager_arn}:IMGPROXY_SALT::" },
#         ]
#         logConfiguration = {
#           logDriver = "awslogs"
#           options = {
#             awslogs-group  = aws_cloudwatch_log_group.imgproxy.name
#             awslogs-region = data.aws_region.current.name
#             awslogs-stream-prefix = "imgproxy"
#           }
#         }
#       }
#     ])
#   }
#
#   resource "aws_ecs_service" "imgproxy" {
#     name            = "gbox-${var.env}-imgproxy"
#     cluster         = aws_ecs_cluster.imgproxy.id
#     task_definition = aws_ecs_task_definition.imgproxy.arn
#     desired_count   = var.desired_count
#     launch_type     = "FARGATE"
#     network_configuration {
#       subnets          = var.subnet_ids
#       security_groups  = [aws_security_group.imgproxy_task.id]
#       assign_public_ip = false
#     }
#     load_balancer {
#       target_group_arn = aws_lb_target_group.imgproxy.arn
#       container_name   = "imgproxy"
#       container_port   = 8080
#     }
#   }
#
#   resource "aws_appautoscaling_target" "imgproxy" {
#     max_capacity       = var.autoscaling_max
#     min_capacity       = var.autoscaling_min
#     resource_id        = "service/${aws_ecs_cluster.imgproxy.name}/${aws_ecs_service.imgproxy.name}"
#     scalable_dimension = "ecs:service:DesiredCount"
#     service_namespace  = "ecs"
#   }
#
#   resource "aws_appautoscaling_policy" "imgproxy_cpu" {
#     name               = "gbox-${var.env}-imgproxy-cpu"
#     policy_type        = "TargetTrackingScaling"
#     resource_id        = aws_appautoscaling_target.imgproxy.resource_id
#     scalable_dimension = aws_appautoscaling_target.imgproxy.scalable_dimension
#     service_namespace  = aws_appautoscaling_target.imgproxy.service_namespace
#     target_tracking_scaling_policy_configuration {
#       predefined_metric_specification {
#         predefined_metric_type = "ECSServiceAverageCPUUtilization"
#       }
#       target_value       = 60.0
#       scale_in_cooldown  = 300
#       scale_out_cooldown = 60
#     }
#   }
# ---------------------------------------------------------------------------

locals {
  # Keep local block non-empty so future additions don't have to reshape.
  module_status = "stub-phase-b-stage-2"
}
