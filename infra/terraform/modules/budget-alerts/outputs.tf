output "sns_topic_arn" {
  description = "ARN of the SNS topic budgets publish to. Future integrations (Slack, PagerDuty) can subscribe here."
  value       = aws_sns_topic.budget_alerts.arn
}

output "budget_name" {
  description = "Name of the Budget resource (for console deep-link)."
  value       = aws_budgets_budget.monthly.name
}
