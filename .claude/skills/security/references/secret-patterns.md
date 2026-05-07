# Secret detection patterns

Grep patterns for hardcoded secrets. Use with Grep tool.

## High confidence (structured format, low false positive)

| Service | Pattern |
|---------|---------|
| AWS access key | `AKIA[0-9A-Z]{16}` |
| GitHub PAT (classic) | `gh[pousr]_[A-Za-z0-9_]{36,255}` |
| GitHub PAT (fine-grained) | `github_pat_[A-Za-z0-9_]{22,}` |
| Stripe live | `sk_live_[0-9a-zA-Z]{24,}` |
| Stripe restricted | `rk_live_[0-9a-zA-Z]{24,}` |
| Slack token | `xox[baprs]-[0-9a-zA-Z-]{10,}` |
| Google Cloud API | `AIza[0-9A-Za-z_-]{35}` |
| Anthropic key | `sk-ant-[A-Za-z0-9_-]{40,}` |
| Private key (PEM) | `-----BEGIN (RSA\|EC\|DSA\|OPENSSH )?PRIVATE KEY-----` |
| JWT in code | `eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}` |

## Medium confidence (verify context before flagging)

| Type | Pattern |
|------|---------|
| Generic API key | `(?i)(api[_-]?key\|apikey\|api[_-]?secret)\s*[:=]\s*['"][A-Za-z0-9/+=]{16,}['"]` |
| Database URL with creds | `(?i)(postgres\|mysql\|mongodb\|redis)://[^:]+:[^@]+@` |
| Password in code | `(?i)(password\|passwd\|pwd)\s*[:=]\s*['"][^'"]{8,}['"]` |
| Generic secret | `(?i)(secret\|token\|credential)\s*[:=]\s*['"][A-Za-z0-9/+=]{16,}['"]` |

## Exclude from results

**Files:** `*.example`, `*.test.*`, `*.spec.*`, `*.md`, `*.txt`
**Dirs:** `node_modules/`, `dist/`, `vendor/`, `__pycache__/`
**Content:** lines containing `TODO`, `FIXME`, `YOUR_`, `REPLACE_`, `xxx`, `placeholder`
**Env reads:** `= process.env.`, `= os.getenv(`, `= os.environ[` — these are safe, reading from env not hardcoding
