# Provider version constraints — locked at module level so different
# envs can't accidentally load incompatible providers. When upgrading,
# bump here first, then re-run `terraform init -upgrade` at each env.

terraform {
  required_version = ">= 1.9.0, < 2.0.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.50"
    }
  }
}
