export {
  verifyDomainDNS,
  addCustomDomain,
  verifyAndProvision,
  removeCustomDomain,
  listShopDomains,
  type SSLProvider,
  type DomainVerificationStatus,
  type DomainVerificationResult,
  type SSLProvisionResult,
} from './ssl-provisioner.js'

// Phase 2B Sprint 2 — Cloudflare-based domain service. Supersedes the
// Let's Encrypt flow exported above for custom-domain add/verify/manage
// operations in the store-admin. The legacy ssl-provisioner exports
// stay in place until migration 036 prunes them.
export {
  addDomain,
  verifyViaCloudflare,
  setPrimary,
  setRedirect,
  removeDomain,
  normalizeDomainInput,
  type AddDomainResult,
  type AddDomainError,
  type VerifyDomainResult,
  type VerifyDomainError,
  type SetPrimaryResult,
  type SetPrimaryError,
  type SetRedirectResult,
  type SetRedirectError,
  type ResolverBundle,
} from './cloudflare-service.js'
