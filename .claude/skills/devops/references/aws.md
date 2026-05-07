# AWS provisioning

Commands assume `aws` CLI is installed + configured (`aws configure` or `AWS_PROFILE`). For CI use OIDC, not static keys.

## Common building blocks

### 1. S3 bucket (static hosting origin)

```bash
# Create bucket (name must be globally unique)
aws s3api create-bucket \
  --bucket <bucket> \
  --region <region> \
  --create-bucket-configuration LocationConstraint=<region>

# Block all public access (CloudFront will read via OAC, not public)
aws s3api put-public-access-block \
  --bucket <bucket> \
  --public-access-block-configuration \
    BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true

# Enable versioning (cheap rollback / accidental-delete protection)
aws s3api put-bucket-versioning \
  --bucket <bucket> \
  --versioning-configuration Status=Enabled
```

### 2. CloudFront distribution (CDN in front of S3)

Prefer Origin Access Control (OAC) over legacy OAI.

Create a distribution JSON skeleton (`cloudfront-config.json`) with:
- `Origins[0].DomainName` = `<bucket>.s3.<region>.amazonaws.com`
- `Origins[0].S3OriginConfig.OriginAccessIdentity` = empty (use OAC below)
- `OriginAccessControlId` = (created separately via `aws cloudfront create-origin-access-control`)
- `DefaultCacheBehavior.ViewerProtocolPolicy` = `redirect-to-https`
- `DefaultRootObject` = `index.html`

```bash
# 1. Create OAC
aws cloudfront create-origin-access-control \
  --origin-access-control-config Name=<name>,SigningProtocol=sigv4,SigningBehavior=always,OriginAccessControlOriginType=s3

# 2. Create distribution referencing the OAC id
aws cloudfront create-distribution --distribution-config file://cloudfront-config.json

# 3. Add bucket policy allowing the distribution to read
#    Policy doc: principal = cloudfront.amazonaws.com, condition on AWS:SourceArn = dist ARN
aws s3api put-bucket-policy --bucket <bucket> --policy file://bucket-policy.json
```

Invalidate after deploy: `aws cloudfront create-invalidation --distribution-id <id> --paths "/*"`.

### 3. GitHub OIDC identity provider (once per AWS account)

```bash
aws iam create-open-id-connect-provider \
  --url https://token.actions.githubusercontent.com \
  --client-id-list sts.amazonaws.com \
  --thumbprint-list 6938fd4d98bab03faadb97b34396831e3780aea1
```

### 4. IAM role for GitHub Actions to assume (OIDC)

Trust policy (`trust-policy.json`) — **must** scope by repo, otherwise any repo can assume:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Federated": "arn:aws:iam::<account-id>:oidc-provider/token.actions.githubusercontent.com" },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
      "StringLike":   { "token.actions.githubusercontent.com:sub": "repo:<owner>/<repo>:*" }
    }
  }]
}
```

```bash
aws iam create-role \
  --role-name gh-actions-deploy \
  --assume-role-policy-document file://trust-policy.json

# Attach a NARROW inline policy (example for S3 + CloudFront invalidation)
aws iam put-role-policy \
  --role-name gh-actions-deploy \
  --policy-name deploy-permissions \
  --policy-document file://deploy-policy.json
```

Example `deploy-policy.json` (least privilege — no `s3:*`, only what's needed):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:DeleteObject", "s3:ListBucket"],
      "Resource": ["arn:aws:s3:::<bucket>", "arn:aws:s3:::<bucket>/*"]
    },
    {
      "Effect": "Allow",
      "Action": ["cloudfront:CreateInvalidation"],
      "Resource": "arn:aws:cloudfront::<account-id>:distribution/<dist-id>"
    }
  ]
}
```

### 5. ECR (container registry for ECS / self-hosted K8s)

```bash
aws ecr create-repository --repository-name <name> --image-scanning-configuration scanOnPush=true

# Set lifecycle policy — keep last 20 images, expire untagged > 7 days
aws ecr put-lifecycle-policy \
  --repository-name <name> \
  --lifecycle-policy-text file://ecr-lifecycle.json
```

Auth for local push: `aws ecr get-login-password | docker login --username AWS --password-stdin <account-id>.dkr.ecr.<region>.amazonaws.com`

### 6. Elastic Beanstalk (managed app env)

```bash
# Init (once per project)
eb init <app-name> --platform "<platform>" --region <region>
# Create env
eb create <env-name> --instance-type t3.small --min-instances 1 --max-instances 3
```

Config lives in `.elasticbeanstalk/config.yml` + `.ebextensions/*.config`. Commit both.

### 7. ECS (container service)

Resources needed: cluster → task definition → service → ALB target group + listener. Easier to manage via CloudFormation / CDK / Terraform than raw CLI once more than one service exists.

Quick CLI version:

```bash
aws ecs create-cluster --cluster-name <name>
aws ecs register-task-definition --cli-input-json file://task-def.json
aws ecs create-service \
  --cluster <name> \
  --service-name <svc> \
  --task-definition <family>:<rev> \
  --desired-count 2 \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[...],securityGroups=[...]}"
```

## Secrets management

- **Parameter Store** (free tier, string values): `aws ssm put-parameter --type SecureString`
- **Secrets Manager** (rotations, KMS): `aws secretsmanager create-secret`
- ECS task can read both via `secrets:` in task def — no env-var leakage

Never echo values in responses. Reference by name only.

## Common gotchas

- Bucket names are **global**. If `<bucket>` is taken, pick another. Add account-id or env suffix.
- CloudFront distributions take 10–30 min to deploy. `aws cloudfront wait distribution-deployed --id <id>`.
- S3 PUT + CloudFront cache = stale files for ~24h unless invalidated.
- OIDC role with `sub: repo:*` (no repo name) = any GitHub user can assume it. Always scope.
- Default `create-bucket` in us-east-1 does NOT accept `LocationConstraint` — omit that flag for us-east-1.
