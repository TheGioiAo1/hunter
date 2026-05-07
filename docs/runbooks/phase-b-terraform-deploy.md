# Phase B — Terraform deploy runbook

Hướng dẫn step-by-step chạy Terraform cho Phase B infrastructure.
Đây là **bản kế nhiệm** của `phase-b-infra-deploy.md` (click-ops). Tất cả
cái gì đó làm manual trên AWS Console thì giờ chạy qua Terraform.

---

## 0. Prerequisites (làm 1 lần duy nhất)

### 0.1 Cài đặt tool

- **Terraform v1.9+** — kiểm tra bằng `terraform --version`
- **AWS CLI v2** — kiểm tra bằng `aws --version`
- **Git** — để pull/push repo

### 0.2 AWS credentials

```powershell
aws configure
# AWS Access Key ID:     <paste from IAM>
# AWS Secret Access Key: <paste from IAM>
# Default region:        ap-southeast-1
# Default output:        json
```

Verify:

```powershell
aws sts get-caller-identity
# Phải thấy "Account": "629720697813"
```

### 0.3 Cloudflare API token

Tạo token tại <https://dash.cloudflare.com/profile/api-tokens>:

1. Click **Create Token** → **Custom token**
2. Permissions (add từng dòng):
   - Zone → DNS → **Edit**
   - Zone → Zone → **Read**
   - Zone → Cache Rules → **Edit**
   - Zone → Origin Rules → **Edit**
   - Zone → Transform Rules → **Edit**
   - Zone → Config Rules → **Edit**
   - Account → Workers Scripts → **Edit**
3. Zone Resources → Include → Specific zone → **gbox.co**
4. Click **Continue → Create Token**
5. Copy token (chỉ hiện 1 lần!)

Set vào PowerShell session (reload mỗi khi mở terminal mới):

```powershell
$env:CLOUDFLARE_API_TOKEN = "paste-token-here"
```

Hoặc set persistent (User scope, không cần reload):

```powershell
[Environment]::SetEnvironmentVariable("CLOUDFLARE_API_TOKEN", "paste-token-here", "User")
# Reload terminal sau bước này
```

Verify:

```powershell
curl.exe -H "Authorization: Bearer $env:CLOUDFLARE_API_TOKEN" `
  https://api.cloudflare.com/client/v4/user/tokens/verify
# Phải thấy "status": "active"
```

---

## 1. Apply lần đầu — env dev (rẻ nhất, test trước)

```powershell
cd "E:\Gbox Platform vibecode\gbox-platform\infra\terraform\envs\dev"

# Download provider plugins, init local state.
terraform init

# Xem plan trước khi apply. KHÔNG có warning/error mới apply.
terraform plan -out=tfplan

# Review output: thấy ~13 resources to create. Nếu thấy destroy/replace
# → STOP, hỏi Claude trước.

# Apply plan đã review.
terraform apply tfplan
```

Apply xong:

1. AWS gửi email confirm SNS subscription tới `thaibeotitamz@gmail.com`
   → click link trong email (nếu không thấy, check spam folder
   "AWS Notifications <no-reply@sns.amazonaws.com>")
2. `terraform output` xem các bucket names, IAM role ARNs.
3. Lưu output vào `docs/.terraform-dev-outputs.txt` (gitignored) để
   reference sau này.

---

## 2. Apply prod (staged rollout)

Prod apply **chia làm 2 stage** để giảm blast-radius:

### Stage 1 — S3 + IAM + Budget (không có Cloudflare)

```powershell
cd "E:\Gbox Platform vibecode\gbox-platform\infra\terraform\envs\prod"

terraform init

# Target apply — chỉ tạo S3 + IAM + Budget, BỎ QUA Cloudflare.
terraform plan `
  -target=module.s3_dr `
  -target=module.iam `
  -target=module.s3_primary `
  -target=module.budget `
  -out=tfplan-stage1

terraform apply tfplan-stage1
```

Verify Stage 1:

```powershell
# Bucket đã tạo?
aws s3 ls | Select-String "gbox-"

# Đúng 8 bucket (4 primary + 4 DR):
# gbox-backups-prod
# gbox-backups-prod-dr
# gbox-private-prod
# gbox-private-prod-dr
# gbox-public-media-prod
# gbox-public-media-prod-dr
# gbox-theme-library-prod
# gbox-theme-library-prod-dr

# CRR đang replicate?
aws s3api get-bucket-replication --bucket gbox-public-media-prod

# IAM role ARN?
terraform output iam_backend_role_arn

# Budget tới chưa?
aws budgets describe-budgets --account-id 629720697813
```

Confirm SNS email → click link.

### Stage 2 — Cloudflare (sau khi S3 stable 24-48h)

```powershell
# Vẫn trong envs/prod/
terraform plan -out=tfplan-stage2

terraform apply tfplan-stage2
```

Verify Stage 2:

```powershell
# Rulesets đã tạo?
terraform output cloudflare_origin_ruleset_id
terraform output cloudflare_cache_ruleset_id
terraform output cloudflare_waf_ruleset_id

# Test routing — phải thấy S3 response với Cloudflare headers:
curl.exe -I https://cdn.gbox.co/healthcheck.txt
# Expect: server: cloudflare, x-cache-status: ...
```

---

## 3. Staging (optional, làm khi cần test full stack)

```powershell
cd "E:\Gbox Platform vibecode\gbox-platform\infra\terraform\envs\staging"

terraform init
terraform plan -out=tfplan
terraform apply tfplan
```

Staging budget cap $60 → nếu vượt là config sai somewhere.

---

## 4. Cập nhật infra sau apply lần đầu

### Thay đổi 1 module

1. Edit file `.tf` trong `modules/<name>/`
2. `cd` vào env cần apply (`envs/prod`, `envs/dev`, `envs/staging`)
3. `terraform plan -out=tfplan` — **đọc kỹ diff** trước
4. Nếu plan báo `destroy`/`replace` tài nguyên có data (bucket,
   SNS topic) → **STOP**, hỏi trước khi apply
5. `terraform apply tfplan`

### Thêm IP Cloudflare mới (quarterly refresh)

1. Get latest: <https://www.cloudflare.com/ips-v4>, <https://www.cloudflare.com/ips-v6>
2. Update default list trong `modules/s3-bucket-set/variables.tf`
3. `cd envs/prod && terraform plan` — expect change trên bucket policy
4. `terraform apply`

### Thêm imgproxy egress CIDRs (sau khi Stage 2 ECS up)

1. Get NAT CIDRs từ `module.imgproxy.nat_cidrs`
2. Update `envs/prod/main.tf`:
   ```hcl
   module "s3_primary" {
     ...
     imgproxy_egress_cidrs = module.imgproxy.nat_cidrs
   }
   ```
3. Plan + apply như trên.

---

## 5. Rollback

### Rollback 1 resource cụ thể

```powershell
terraform plan -destroy -target=<resource> -out=tfplan-rollback
terraform apply tfplan-rollback
```

### Rollback toàn bộ env

```powershell
# Chỉ chạy trên env KHÔNG có data quan trọng (dev, staging).
# Trên prod → hỏi Claude trước.
terraform destroy
```

Dev buckets có `force_destroy = true` → destroy sẽ xoá cả object.
Prod buckets có `force_destroy = false` → phải empty bucket trước:

```powershell
aws s3 rm s3://gbox-public-media-prod --recursive
aws s3 rm s3://gbox-public-media-prod --recursive --include "*" --version-id ...
```

---

## 6. Troubleshooting

### "Error: creating S3 bucket: BucketAlreadyExists"

Tên bucket duplicate global namespace. Bucket naming pattern trong module
là `gbox-<role>-<env><suffix>`. Nếu có ai đã tạo bucket này rồi:

1. Check: `aws s3 ls | grep gbox-`
2. Nếu là bucket cũ, không dùng → rename trong `modules/s3-bucket-set/main.tf`
3. Nếu Thai đã import manually → chạy `terraform import module.s3_primary.aws_s3_bucket.public_media gbox-public-media-prod`

### "Error: getting Cloudflare Ruleset"

Token thiếu quyền. Check:

```powershell
curl.exe -H "Authorization: Bearer $env:CLOUDFLARE_API_TOKEN" `
  "https://api.cloudflare.com/client/v4/zones/$env:CF_ZONE_ID/rulesets"
```

Nếu 403 → tạo token mới theo §0.3.

### "Budget email không nhận được"

1. Check spam folder — AWS Notifications email bị filter rất thường.
2. `aws sns list-subscriptions-by-topic --topic-arn <arn>` xem
   `PendingConfirmation` — nếu vẫn pending thì email xác nhận chưa click.
3. Force resend: `terraform taint module.budget.aws_sns_topic_subscription.email` → `apply`.

### "terraform init" chậm / fail download plugin

Cloudflare block registry.terraform.io đôi khi. Thử:

```powershell
$env:HTTPS_PROXY = "http://proxy-nếu-có:port"
terraform init
```

Hoặc clear cache và retry:

```powershell
Remove-Item -Recurse -Force .terraform
terraform init
```

### State corruption (file .tfstate bị edit tay hoặc mất)

- Nếu còn `.tfstate.backup` → `cp terraform.tfstate.backup terraform.tfstate`
- Nếu mất sạch: `terraform import` từng resource một. Danh sách resource
  lấy từ `terraform state list` của plan cũ.
- Long-term fix: migrate sang S3 backend (xem `versions.tf` comment).

---

## 7. Cost checkpoint

Sau khi apply xong, 1-3 ngày sau vào AWS Cost Explorer check:

- **Dev** target: ≤ $20/mo
- **Staging** target: ≤ $60/mo
- **Prod Stage 1** target: ≤ $50/mo (S3-only)
- **Prod Stage 2 (với ECS)** target: ≤ $200/mo

Nếu vượt:

- S3 vượt → check lifecycle rule đang áp dụng chưa
  (`aws s3api get-bucket-lifecycle-configuration`)
- Data transfer vượt → xem CloudFront / Cloudflare có proxy đúng không
- NAT gateway vượt → VPC setup sai, imgproxy đang gọi S3 qua NAT
  thay vì VPC Endpoint

---

## 8. Next up

Khi Stage 1+2 của Phase B stable rồi:

1. Uncomment + enable `modules/imgproxy-ecs` (thay file stub bằng
   sketch trong comment)
2. Uncomment + enable `modules/ffmpeg-worker-ecs`
3. Thêm `module.imgproxy` vào `envs/prod/main.tf`, wire
   `nat_cidrs` vào `module.s3_primary.imgproxy_egress_cidrs`
4. Apply staged — imgproxy trước, ffmpeg sau (khác nhau về lifecycle)

Khi lên CI/CD:

- Migrate state sang S3 backend (xem comment trong `versions.tf`)
- Setup GitHub Actions với OIDC assume-role (không dùng long-lived keys)
- Terraform plan trên PR, apply on merge to main
