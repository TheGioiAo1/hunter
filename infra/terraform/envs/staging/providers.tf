# envs/staging mirrors envs/prod in structure (so bugs surface here
# before prod) but scales down enough to cost ~$60/mo.

provider "aws" {
  alias  = "primary"
  region = var.primary_region

  default_tags {
    tags = {
      Project     = "gbox-platform"
      Environment = "staging"
      ManagedBy   = "Terraform"
      Owner       = "thai@gbox.co"
    }
  }
}

provider "aws" {
  alias  = "dr"
  region = var.dr_region

  default_tags {
    tags = {
      Project     = "gbox-platform"
      Environment = "staging"
      ManagedBy   = "Terraform"
      Tier        = "dr"
    }
  }
}

provider "aws" {
  region = var.primary_region

  default_tags {
    tags = {
      Project     = "gbox-platform"
      Environment = "staging"
      ManagedBy   = "Terraform"
    }
  }
}

provider "cloudflare" {
  # CLOUDFLARE_API_TOKEN env var
}
