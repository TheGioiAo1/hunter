# ---------------------------------------------------------------------------
# Module: budget-alerts
#
# AWS Budgets + SNS email subscription. Sends an email to Thai every
# time actual or forecast spend crosses one of the configured thresholds.
#
# Why SNS (and not AWS Chatbot or native Budgets email):
#   - Budgets has a native "subscribers" field but caps at 10 recipients
#     and no deduplication. SNS is more flexible for future Slack hook.
#   - SNS topic policy lets Budgets publish without extra IAM setup.
#
# Cost: AWS Budgets free tier = 2 budgets/month free, then $0.02/day/budget.
# 3 thresholds × 1 budget × $0.02 = $0.02/day = $0.60/month. Negligible.
# ---------------------------------------------------------------------------

locals {
  common_tags = merge(var.tags, {
    Environment = var.env
    ManagedBy   = "Terraform"
    Module      = "budget-alerts"
  })
}

# ---------------------------------------------------------------------------
# SNS topic — Budgets publishes notifications here; SNS forwards to email.
# ---------------------------------------------------------------------------

resource "aws_sns_topic" "budget_alerts" {
  name         = "gbox-${var.env}-budget-alerts"
  display_name = "Gbox ${title(var.env)} Budget Alerts"

  tags = local.common_tags
}

# Let AWS Budgets service publish to this topic. Without this, Budgets
# tries to Publish and gets AccessDenied.
data "aws_iam_policy_document" "budget_sns_publish" {
  statement {
    sid    = "AllowBudgetsPublish"
    effect = "Allow"
    principals {
      type        = "Service"
      identifiers = ["budgets.amazonaws.com"]
    }
    actions   = ["SNS:Publish"]
    resources = [aws_sns_topic.budget_alerts.arn]
  }
}

resource "aws_sns_topic_policy" "budget_alerts" {
  arn    = aws_sns_topic.budget_alerts.arn
  policy = data.aws_iam_policy_document.budget_sns_publish.json
}

# Email subscription — Thai gets an email asking him to confirm the
# subscription (AWS sends a confirmation link). Until confirmed, no
# alerts are delivered. Check spam folder.
resource "aws_sns_topic_subscription" "email" {
  topic_arn = aws_sns_topic.budget_alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

# ---------------------------------------------------------------------------
# The budget itself
# ---------------------------------------------------------------------------

resource "aws_budgets_budget" "monthly" {
  name         = "gbox-${var.env}-monthly-cap"
  budget_type  = "COST"
  limit_amount = tostring(var.monthly_cap_usd)
  limit_unit   = "USD"

  # Month resets at 00:00 UTC on the 1st. "MONTHLY" budgets align to
  # calendar month — which is what the AWS bill uses, so alerts match
  # the invoice.
  time_unit = "MONTHLY"

  # Scope this budget to services we actually use in Phase B. Keeps
  # unrelated spend (RDS, old EC2 instances) out of the alert radar.
  # Comment out cost_filter if you want a catch-all cap instead.
  cost_filter {
    name = "Service"
    values = [
      "Amazon Simple Storage Service",
      "Amazon Elastic Container Service",
      "AWS Fargate",
      "Amazon Elastic Load Balancing",
      "AWS Secrets Manager",
      "AmazonCloudWatch",
      "Amazon Route 53",
    ]
  }

  # Tier 1 — warning: 80% of cap forecast. Enough runway to react.
  notification {
    comparison_operator       = "GREATER_THAN"
    threshold                 = 80
    threshold_type            = "PERCENTAGE"
    notification_type         = "FORECASTED"
    subscriber_sns_topic_arns = [aws_sns_topic.budget_alerts.arn]
  }

  # Tier 2 — actual spend hits 80%.
  notification {
    comparison_operator       = "GREATER_THAN"
    threshold                 = 80
    threshold_type            = "PERCENTAGE"
    notification_type         = "ACTUAL"
    subscriber_sns_topic_arns = [aws_sns_topic.budget_alerts.arn]
  }

  # Tier 3 — actual spend hits 100% (budget exceeded).
  notification {
    comparison_operator       = "GREATER_THAN"
    threshold                 = 100
    threshold_type            = "PERCENTAGE"
    notification_type         = "ACTUAL"
    subscriber_sns_topic_arns = [aws_sns_topic.budget_alerts.arn]
  }

  # Tier 4 — emergency: spend projected to hit 120%. If we're seeing
  # this, something bugged out (runaway ECS scale-out, egress loop).
  notification {
    comparison_operator       = "GREATER_THAN"
    threshold                 = 120
    threshold_type            = "PERCENTAGE"
    notification_type         = "FORECASTED"
    subscriber_sns_topic_arns = [aws_sns_topic.budget_alerts.arn]
  }

  tags = local.common_tags
}
