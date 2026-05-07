# STRIDE + OWASP checklist

Walk through each section that applies to the code being audited. Not every item applies to every project — skip what's clearly irrelevant.

## STRIDE

### Spoofing (authentication)
- [ ] Endpoints require auth unless intentionally public
- [ ] Passwords hashed with bcrypt/argon2 — not MD5/SHA1
- [ ] JWT tokens have `exp`, validated server-side
- [ ] Cookies use `Secure`, `HttpOnly`, `SameSite` flags
- [ ] OAuth/OIDC flows include `state` parameter
- [ ] Default credentials removed from all services
- [ ] MFA available for sensitive operations

### Tampering (integrity)
- [ ] Input validated on all user-supplied data (type, length, format)
- [ ] Parameterized queries — no string concatenation for SQL/NoSQL
- [ ] CSRF tokens on all state-changing forms
- [ ] File uploads validated: type (magic bytes), size, content
- [ ] Deserialization of untrusted data avoided or sandboxed
- [ ] HTTP methods restricted per endpoint (no GET for mutations)

### Repudiation (logging)
- [ ] Auth events logged: login, logout, failures
- [ ] Authorization failures logged with user/resource context
- [ ] Data modifications logged with actor + timestamp
- [ ] Logs contain no sensitive data (passwords, tokens, PII)
- [ ] Log integrity protected — append-only or centralized sink
- [ ] Retention meets compliance requirements (90+ days)

### Information disclosure
- [ ] Error messages don't leak stack traces in production
- [ ] API responses exclude internal IDs, system paths, version strings
- [ ] Sensitive data encrypted at rest (AES-256 or equivalent)
- [ ] All transport uses TLS 1.2+ — no plaintext for sensitive endpoints
- [ ] No hardcoded secrets in source (see `secret-patterns.md`)
- [ ] `.env` files in `.gitignore`
- [ ] API responses filtered to minimum necessary fields

### Denial of service
- [ ] Rate limiting on auth and sensitive endpoints
- [ ] Request body size limits at server/gateway level
- [ ] Pagination enforced on list endpoints — no unbounded queries
- [ ] Timeouts on all external API and database calls
- [ ] Connection pools sized and cleaned up
- [ ] Regex reviewed for catastrophic backtracking (ReDoS)
- [ ] Background jobs have concurrency limits and dead-letter queues

### Elevation of privilege
- [ ] RBAC enforced server-side, not client-side
- [ ] Horizontal access checks: user A can't access user B's resources (IDOR)
- [ ] Admin endpoints have separate, stricter auth middleware
- [ ] Privilege escalation paths require re-authentication
- [ ] Service accounts use least privilege
- [ ] Third-party integrations scoped to minimum permissions

## OWASP Top 10 quick reference

| # | Category | Look for |
|---|----------|----------|
| A01 | Broken access control | Missing auth, IDOR, CORS misconfig, path traversal |
| A02 | Cryptographic failures | Weak hashing, plaintext storage, missing TLS, weak ciphers |
| A03 | Injection | SQL, NoSQL, OS command, template injection via unsanitized input |
| A04 | Insecure design | Missing threat model, business logic flaws, no abuse-case testing |
| A05 | Security misconfiguration | Default creds, verbose errors, unnecessary features/ports |
| A06 | Vulnerable components | Outdated deps, known CVEs, unpatched libraries |
| A07 | Auth failures | Brute force, credential stuffing, session fixation, weak tokens |
| A08 | Data integrity failures | Unsigned updates, unverified deserialization, CI/CD compromise |
| A09 | Logging failures | Missing security event logs, no alerting, blind spots |
| A10 | SSRF | Unvalidated user-supplied URLs, internal service access via fetch/curl |
