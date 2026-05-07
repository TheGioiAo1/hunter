# Gbox Platform — Infrastructure as Code

Terraform modules for the AWS + Cloudflare infrastructure described in
`docs/superpowers/specs/2026-04-18-shopify-parity-s3-media-pipeline.md`
and the deploy runbook at `docs/runbooks/phase-b-infra-deploy.md`.

## What this folder owns

| Resource class | Module | Status |
|---|---|---|
| S3 buckets (public-media, theme-library, private, backups + DR twins) | `modules/s3-bucket-set/` | ✅ |
| IAM roles (Backend, Imgproxy, FfmpegWorker, S3Replication) | `modules/iam-roles/` | ✅ |
| AWS Budgets + SNS email alerts | `modules/budget-alerts/` | ✅ |
| Cloudflare zone config (Origin + Cache + Transform + WAF rules) | `modules/cloudflare-zone/` | ⏳ |
| imgproxy on ECS Fargate + NLB + autoscaling | `modules/imgproxy-ecs/` | ⏳ |
| ffmpeg-worker on ECS Fargate Spot (scale-to-0) | `modules/ffmpeg-worker-ecs/` | ⏳ |

## Environments

| Env | Scope | AWS region | Cost target |
|---|---|---|---|
| `dev` | S3 buckets only (no ECS, no Cloudflare zone) — local dev machines point at these | `ap-southeast-1` | ~$5/mo |
| `staging` | Full infra, minimum scale (imgproxy min=1, ffmpeg-worker absent) | `ap-southeast-1` | ~$60/mo |
| `prod` | Full infra per spec | `ap-southeast-1` primary + `ap-northeast-1` DR | ~$150-190/mo (cap: $200) |

## Prerequisites (one-time, on Thai's machine)

### 1. AWS CLI configured

```powershell
aws configure
# Access Key ID / Secret: from IAM user 'gbox-terraform-bootstrap'
# Region: ap-southeast-1
# Output: json
```

Verify:
```powershell
aws sts get-caller-identity
# Expect: Account = 629720697813
```

### 2. Cloudflare API token in shell env

```powershell
# Session-only (recommended — re-set each session):
$env:CLOUDFLARE_API_TOKEN = "paste_token_here"

# Verify:
curl.exe -H "Authorization: Bearer $env:CLOUDFLARE_API_TOKEN" `
  https://api.cloudflare.com/client/v4/user/tokens/verify
# Expect: "status": "active"
```

### 3. Terraform installed

Either `winget install HashiCorp.Terraform` or download the binary from
<https://developer.hashicorp.com/terraform/install> into `C:\terraform\`
and add to PATH. Verify:

```powershell
terraform --version
# Expect: Terraform v1.9.x or later
```

## Execution order (first-time bring-up)

Always run from the env folder, not the repo root.

```powershell
cd E:\Gbox Platform vibecode\gbox-platform\infra\terraform\envs\prod

# One-time: download providers (AWS, Cloudflare, random, etc.)
terraform init

# Dry-run: see what WILL be created. No AWS/CF changes yet.
terraform plan

# Apply: actually create the resources. Prompts for 'yes' confirmation.
terraform apply

# To destroy (dev/staging only — NEVER on prod without a plan):
terraform destroy
```

### Recommended staged rollout

Phase B infra has ~60 resources. To reduce blast radius, bring them up
in 3 stages using `-target`:

```powershell
# Stage 1 — just storage + IAM + budgets (cheapest, safest)
terraform apply \
  -target=module.s3 \
  -target=module.iam \
  -target=module.budget

# Stage 2 — Cloudflare zone config (no $ cost, but can break DNS)
terraform apply \
  -target=module.cloudflare

# Stage 3 — ECS compute (costs money; needs imgproxy-ecr-image pushed first)
terraform apply
```

After stage 3, `terraform plan` should show `No changes.`

## State file handling

For MVP we use **local state** (`terraform.tfstate` in each env folder).
That file is `.gitignore`d — if Thai's laptop dies without a backup,
Terraform loses track of the resources it created and they need to be
imported back manually.

To upgrade to remote state (S3 + DynamoDB locking):
1. Create the state bucket + lock table by hand (one-time):
   ```bash
   aws s3api create-bucket --bucket gbox-terraform-state --region ap-southeast-1 \
     --create-bucket-configuration LocationConstraint=ap-southeast-1
   aws s3api put-bucket-versioning --bucket gbox-terraform-state \
     --versioning-configuration Status=Enabled
   aws dynamodb create-table --table-name gbox-terraform-locks \
     --attribute-definitions AttributeName=LockID,AttributeType=S \
     --key-schema AttributeName=LockID,KeyType=HASH \
     --billing-mode PAY_PER_REQUEST --region ap-southeast-1
   ```
2. Add `backend.tf` in each env pointing at that bucket/table.
3. Run `terraform init -migrate-state` — it uploads the local file.

Left as a Phase C follow-up; MVP ships with local state.

## Rollback

### Full teardown (staging/dev only)
```powershell
cd envs/staging
terraform destroy
```

### Selective rollback (revert one resource type)
Edit the `main.tf` in the env folder — comment out the `module "xxx"`
block, then `terraform apply`. Terraform will destroy only that module's
resources.

### Emergency — decouple Cloudflare from AWS
If AWS is on fire and you need traffic to go to a static placeholder:
1. In Cloudflare dashboard, flip the Origin Rule for `cdn.gbox.co/*`
   to point at a static error page host.
2. OR: at backend `.env` level, set `GBOX_IMAGE_CDN=passthrough`. Images
   still serve (from S3 direct — slower but live).

## Safety checklist before `terraform apply`

- [ ] `terraform plan` output reviewed — line count under ~100 changes
- [ ] No `# forces replacement` notes on IAM roles (replacement = temporary
      permission outage)
- [ ] No `destroy` operations on production buckets (versioning ON, but
      lifecycle + replication take days to rebuild)
- [ ] Budget alerts module applied BEFORE ECS modules (so you get
      warnings if ECS overspends)
- [ ] Thai watching the terminal — `apply` can take 10-15 min, NLB + ECS
      tasks are the slowest

## Troubleshooting

### `Error: NoCredentialProviders`
AWS CLI not configured. Run `aws sts get-caller-identity` — if that fails,
re-run `aws configure`.

### `Error: could not validate Cloudflare API token`
`CLOUDFLARE_API_TOKEN` env var missing or expired. Re-export the token
and try again.

### `Error: bucket already exists`
Someone (or a previous Terraform run) created the bucket. Import it:
```powershell
terraform import module.s3.aws_s3_bucket.public_media gbox-public-media-prod
```

### `terraform plan` hangs
Usually a network issue pulling providers. Check proxy / VPN. Retry with
`terraform init -upgrade`.

## Module-level docs

Each module has its own README with variable reference and usage example.
See `modules/<name>/README.md`.
