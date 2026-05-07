# envs/dev tfvars. Same account as prod (MVP budget constraint — one AWS
# account, separated by bucket/role name). When we get a second account
# later, flip aws_account_id + AWS_PROFILE here.

aws_account_id     = "629720697813"
primary_region     = "ap-southeast-1"
monthly_budget_usd = 20
budget_alert_email = "thaibeotitamz@gmail.com"
