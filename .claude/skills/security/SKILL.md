---
name: security
description: "Scan code for vulnerabilities, hardcoded secrets, and dependency issues. Combines automated grep patterns with STRIDE/OWASP checklist review. Use before releases, after adding auth/payment features, or when someone says 'security audit'."
argument-hint: "<scope or 'full'> [--fix] [--secrets-only] [--deps-only]"
metadata:
  author: claudex-kit
  version: "1.0.0"
---

# Security audit

Two layers: automated pattern scanning (fast, catches the obvious) then structured checklist review (slower, catches the subtle). Run both unless scoped down with flags.

## Modes

| Flag | What it does |
|------|-------------|
| _(none)_ | Full audit: patterns + checklist + deps |
| `--secrets-only` | Just secret detection — fast, good for pre-commit |
| `--deps-only` | Just dependency audit (`npm audit` etc.) |
| `--fix` | After audit, apply fixes iteratively (Critical → Low) |
| `--fix --iterations N` | Cap fix rounds at N |

## Process

### 1 — Figure out the stack

```
package.json       → Node.js   → npm audit
requirements.txt   → Python    → pip-audit
go.mod             → Go        → govulncheck
Cargo.toml         → Rust      → cargo audit
Gemfile            → Ruby      → bundle audit
pom.xml            → Java      → mvn dependency-check:check
```

### 2 — Secret scan (always first)

Load `references/secret-patterns.md` → Grep each pattern across codebase.

Rules:
- Exclude: `node_modules/`, `dist/`, `vendor/`, `*.test.*`, `*.example`, `*.md`
- Skip placeholders: lines with `YOUR_`, `REPLACE_`, `xxx`, `placeholder`, `process.env.`, `os.getenv(`
- **NEVER print actual secret values** — redact to first 4 + last 2 chars
- Real credential found → recommend immediate rotation

### 3 — Code vulnerability scan

Load `references/vulnerability-patterns.md` → Grep for dangerous patterns (SQLi, XSS, command injection, path traversal, eval, insecure crypto...).

For each match:
- Read 5-10 lines of surrounding context
- Determine: real vulnerability or false positive?
- If real → assign severity + suggest fix

### 4 — Dependency audit

Run the command for the detected stack. Parse output, merge into findings.

### 5 — STRIDE checklist (skip if `--secrets-only` or `--deps-only`)

Load `references/stride-checklist.md` → walk through each category that applies to the scoped code:
- **S**poofing — auth weaknesses
- **T**ampering — input validation, integrity
- **R**epudiation — logging gaps
- **I**nformation Disclosure — data leakage
- **D**enial of Service — rate limits, resource exhaustion
- **E**levation of Privilege — broken access control

### 6 — .env exposure check

```bash
git ls-files --error-unmatch .env .env.local .env.production 2>/dev/null
grep -n "\.env" .gitignore 2>/dev/null
```

Flag if `.env` files are tracked by git or missing from `.gitignore`.

### 7 — Report

```markdown
# Security audit

**Scope:** {files/dirs scanned}
**Date:** {date}

## Summary
| Category | Critical | High | Medium | Low |
|----------|----------|------|--------|-----|
| Secrets  | - | - | - | - |
| Code     | - | - | - | - |
| Deps     | - | - | - | - |
| STRIDE   | - | - | - | - |

## Findings

| # | Severity | Category | Location | Issue | Fix |
|---|----------|----------|----------|-------|-----|
| 1 | Critical | Secret | config.js:42 | Hardcoded AWS key | Move to env var, rotate key |
| 2 | High | SQLi | api/users.ts:15 | String concat in query | Parameterized query |

## Recommendations
1. [prioritized action items]
```

Save to `plans/reports/security-<YYMMDD>-<HHmm>-<slug>.md` using relative path. `mkdir -p plans/reports/` if needed. **Never ask where to save.**

## Fix mode (`--fix`)

After audit, fix findings in severity order:

1. Sort: Critical → High → Medium → Low
2. For each finding:
   - Apply one targeted fix
   - Run guard (tests or lint) to verify no regression
   - If guard passes → commit: `security(fix-N): <description>`
   - If guard fails → stop, report the failure
3. `--iterations N` caps total fix rounds

## Severity

| Level | Meaning | Action |
|-------|---------|--------|
| Critical | Exploitable now — data breach, RCE, auth bypass | Block release |
| High | Exploitable with effort — significant impact | Fix this sprint |
| Medium | Limited exploitability or impact | Next sprint |
| Low | Theoretical, defense-in-depth | Backlog |

## Safety rules

- **NEVER** output real secret values — always redact
- **NEVER** execute found credentials
- **NEVER** modify code in audit-only mode — only report
- Real credential found → recommend immediate rotation

## References
- `references/secret-patterns.md` — regex patterns for secret detection
- `references/vulnerability-patterns.md` — grep patterns for code vulnerabilities
- `references/stride-checklist.md` — STRIDE + OWASP per-category checklist
