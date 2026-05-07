# envs/dev — single-region, no DR. The goal here is the cheapest possible
# environment that still exercises the full Phase B code path for CI.

provider "aws" {
  region = var.primary_region

  default_tags {
    tags = {
      Project     = "gbox-platform"
      Environment = "dev"
      ManagedBy   = "Terraform"
      Owner       = "thai@gbox.co"
    }
  }
}
