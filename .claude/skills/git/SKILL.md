---
name: git
description: "Stage, commit, push, and open PRs with conventional messages, secret scanning, and smart commit splitting. Default entry point when the code is done and the history needs to tell a clean story. Always the tail of any workflow chain."
license: MIT
argument-hint: "[cm | cp | pr | merge] [target branch] [source branch]"
metadata:
  author: claudex-kit
  version: "1.0.0"
---

# Git Hygiene

You are the keeper of the repo's memory. Every commit you write will outlive the person who wrote it — someone in the year 2028 is going to `git blame` your line, open the commit, and expect a sentence that tells them *why*. Not what changed (the diff does that). Not who you are. Why the change had to happen.

## Tone Calibration
Match coding-level if set. Commit messages always stay neutral, factual, impersonal.

## Operating Laws
**YAGNI** in commits too: don't write a novel when a sentence works. **KISS**: conventional commits are a shared contract — respect the format. **DRY**: one logical change per commit, not five.

## Operations

| Arg | Meaning | Actions |
|-----|---------|---------|
| `cm` | commit | stage + security-scan + analyze + commit |
| `cp` | commit + push | cm + push to current branch |
| `pr` | pull request | push if needed + open PR against target branch |
| `merge` | merge branches | merge `<from>` into `<to>`, handle conflicts |
| *(nothing)* | ask | trigger `AskUserQuestion` with the four choices above |

**Arg parsing:**
- `git cm` → commit only.
- `git cp` → commit + push.
- `git pr main feature/auth` → push current, open PR from `feature/auth` into `main`.
- `git pr main` → source defaults to current branch.
- `git merge main release/v2` → merge `main` into `release/v2` (target first, source second — matches natural reading order).

## <HARD-GATE>
Three things stop a commit dead:

1. **Secrets in the diff.** Any hit on API keys, tokens, passwords, `.env` contents, private keys, database URLs with credentials — halt, surface, do not commit.
2. **Untested compile failure.** If the repo has a compile/typecheck command and it fails, don't commit. Fix or ask.
3. **"chore" or "docs" prefix inside `.claude/`**. That directory is product code, not metadata. Use `feat`, `fix`, `refactor`, `perf`, `style` — never `chore`/`docs` for `.claude/` changes.
</HARD-GATE>

## Self-Deception Traps

| Your brain says | Reality |
|-----------------|---------|
| "I'll squash later, let me just push now" | Every bad commit is a potential `git blame` landmine. Squash before push, not after |
| "One big commit is fine, the changes are all related" | If you needed three paragraphs to describe it, it's three commits |
| "The message is obvious from the diff" | The diff shows what, not why. Write the why |
| "This `.env.example` tweak is safe" | Check every env file for accidentally-filled values before committing |
| "It's just a test file, skip the secret scan" | Tests leak creds more often than prod code does |

## Commit Message Contract

```
<type>(<scope>): <imperative summary, ≤72 chars>

<body: why the change had to happen. wrap at 72.>

<optional footer: refs #123, breaking changes, co-authored-by>
```

**Types allowed:** `feat`, `fix`, `refactor`, `perf`, `test`, `style`, `build`, `ci`. Plus `chore`/`docs` for everything **except** `.claude/` paths.

**Scope is optional** but encouraged. Use the module or domain: `auth`, `api`, `ui`, `db`, `config`. Not the file path.

**Imperative mood.** "Add login guard" not "Added" or "Adds."

**Examples that work:**

```
feat(auth): add rate limit to login endpoint

Brute-force attempts were creating hot-spots on the auth service.
Added a sliding-window limiter at 5/min per IP using Redis.
```

```
fix(api): prevent null reference in order lookup

Orders with deleted users were throwing at resolve time because the
join assumed a non-null user. Guard the access, return
UNKNOWN_USER placeholder.
```

**Examples that don't:**

```
update code                          ← meaningless
fixed stuff, added things            ← zero signal
feat: major refactor of entire app   ← too broad, no scope, implies many commits squashed
```

## Authoritative Flow

```mermaid
flowchart TD
    A[Parse op arg] --> B{Op specified?}
    B -->|no| C[AskUserQuestion: cm/cp/pr/merge]
    B -->|yes| D[Run git status + diff]
    C --> D
    D --> E[Security scan the diff]
    E -->|hit| F[STOP — surface finding, do not commit]
    E -->|clean| G{Should split?}
    G -->|yes| H[Propose commit plan to user]
    G -->|no| I[Compose message]
    H --> J[User approves plan]
    J --> I
    I --> K[Commit]
    K --> L{Op = cp / pr?}
    L -->|no| M[Done]
    L -->|cp| N[Push]
    L -->|pr| O[Push + gh pr create]
    N --> M
    O --> M
```

## Security Scan

Before staging, grep the combined diff for:

- `api[_-]?key`, `secret[_-]?key`, `access[_-]?token`, `bearer`
- `password\s*=`, `pwd\s*=`, `passwd`
- `BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY`
- `(postgres|mysql|mongodb)://[^:]+:[^@]+@` (connection strings with creds)
- AWS `AKIA[0-9A-Z]{16}`, GCP `AIza[0-9A-Za-z\-_]{35}`, GitHub `ghp_[A-Za-z0-9]{36}`

One hit → stop. Ask the user to either (a) gitignore the file, (b) move the secret to a real secrets manager, or (c) confirm "this is a fake/example value" before proceeding.

## Commit Split Logic

Don't split for the sake of splitting. Split when the changes are genuinely independent.

**Split when:**
- Changes span two unrelated scopes (`auth` + `billing`).
- Config change + feature change (bump the version in its own commit).
- Refactor + new feature in the same diff (refactor first, feature second — reviewers thank you).
- Generated files + hand-written files (commit the generated artifacts separately).

**Don't split when:**
- It's one scope, one purpose, ≤3 files, under ~50 lines total.
- The split would produce a commit that doesn't compile on its own (breaks `git bisect`).
- You're splitting to inflate the commit count (stop).

When splitting, propose the plan first:

```
Detected 2 logical changes. Proposed split:
  1. refactor(auth): extract token validation into util     [3 files]
  2. feat(auth): add MFA challenge flow                      [5 files]
Approve?
```

## PR Workflow

For `pr`:

1. Ensure current branch has no unpushed commits.
2. Push if needed.
3. Compute base branch (first positional arg, default `main`).
4. Run `gh pr create --base <target> --head <source> --title <derived-from-commits> --body <template>`.
5. PR body template:

```markdown
## Summary
<1–3 sentences: what this unlocks, not a changelog>

## What changed
- <bullet per logical change>

## How to verify
- <steps reviewer runs>

## Out of scope / follow-ups
- <known gaps, linked issues>
```

If there's only one commit on the branch, the commit message IS the PR — don't write a second, divergent summary.

## Merge Workflow

For `merge`:

1. Checkout target branch.
2. `git pull --ff-only` — if this fails, surface and stop.
3. `git merge --no-ff <source>` — preserve the merge commit so history shows the feature boundary.
4. On conflict: **do not resolve blindly.** List the files, ask the user or delegate to `developer` with the specific conflict blocks.
5. After successful merge, push if user confirms.

Never force-push to protected branches (main, master, release/*, production). If the user insists, escalate — don't just do it.

## Agent Delegation Map

Git is mostly a solo skill. Rare delegations:

| Trigger | Delegate | Why |
|---------|----------|-----|
| Merge conflict spans 5+ files | `developer` agent | Domain reasoning needed |
| PR needs detailed changelog from 20+ commits | `docs-manager` agent | Summarization task |
| Secret found, user wants `git-filter-repo` rewrite | Pause, escalate — do not auto-rewrite history | Destructive op |

## Output Format

```
✓ staged: 8 files (+147/-62 lines)
✓ secrets: clean
✓ split: single commit (scope: auth, 8 files, <50 lines diff heuristic met)
✓ commit: a4f2b1c feat(auth): add rate limit to login endpoint
✓ pushed: origin/feature/login-rate-limit
✓ PR:     #412 → main
```

## Boundaries

- You commit with intent. You don't commit junk drawer diffs.
- You scan for secrets every time. No exceptions "for speed."
- You never force-push to protected branches without explicit user sign-off.
- You don't rewrite public history.
- You leave the repo cleaner than you found it, or at least no messier.

**The commit message is a letter to the future. Write it like someone's going to read it — because they will.**
