# ---------------------------------------------------------------------------
# Pin Terraform + every provider used by envs/prod.
#
# Rationale for the version bounds:
#
#   - terraform >= 1.9.0  : we use the `optional()` modifier on object-type
#     variables (see modules/s3-bucket-set/variables.tf) which only stopped
#     being experimental in 1.3, and several type-system fixes landed in 1.9.
#     < 2.0.0  so we don't silently opt into a future major release.
#
#   - aws ~> 5.50         : pinned to the 5.x line. 5.50 shipped the
#     aws_s3_bucket_replication_configuration `delete_marker_replication`
#     block tweak we use. 6.x may ship in late 2026 with breaking changes.
#
#   - cloudflare ~> 4.40  : v4 is the current GA. v5 (not released at time
#     of writing) is flagged as a breaking rewrite. Lock to 4.x.
#
#   - random ~> 3.6       : tiny provider, only used to generate the SNS
#     topic policy statement SIDs where we want stable-but-unique names.
# ---------------------------------------------------------------------------

terraform {
  required_version = ">= 1.9.0, < 2.0.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.50"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.40"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # ---------------------------------------------------------------------------
  # State backend.
  #
  # MVP: local state file (.terraform/terraform.tfstate) — gitignored. This
  # is FINE for a single-operator (Thai) setup. Known downside: if the
  # laptop dies, we lose the state → `terraform import` everything back.
  #
  # When we add a second operator or CI, flip to S3 backend:
  #
  #   backend "s3" {
  #     bucket         = "gbox-terraform-state"     # pre-create, versioned
  #     key            = "envs/prod/terraform.tfstate"
  #     region         = "ap-southeast-1"
  #     dynamodb_table = "gbox-terraform-locks"     # pre-create, PK=LockID
  #     encrypt        = true
  #   }
  #
  # Migration path: `terraform init -migrate-state` does the lift.
  # ---------------------------------------------------------------------------
}
