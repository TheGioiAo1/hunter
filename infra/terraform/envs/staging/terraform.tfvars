# Staging overrides. Same AWS account, same CF account/zone as prod (for
# MVP single-tenant). When we split to a dedicated staging CF zone later,
# flip cloudflare_zone_id to the new one.

aws_account_id     = "629720697813"
primary_region     = "ap-southeast-1"
dr_region          = "ap-northeast-1"
monthly_budget_usd = 60
budget_alert_email = "thaibeotitamz@gmail.com"

cloudflare_account_id = "196d4c6494c99fab466f05f9daa77ec5"
cloudflare_zone_id    = "8c9f8789175c7621786c1cacfe5f030a"
cdn_hostname          = "staging-cdn.gbox.co"
