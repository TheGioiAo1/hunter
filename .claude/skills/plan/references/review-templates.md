# Review Templates — Red-Team & Validation

Richer templates for the two quality gates inside the `plan` skill. Load this file only when red-team or validation actually runs (hard mode, or explicit `--red-team` / `--validate`). Fast mode plans ignore it entirely.

---

## Part 1 — Red-Team Personas

The inline 3-angle table in `SKILL.md` catches common issues. When a plan touches money, data, or security, use these 4 sharper lenses instead.

### The 4 lenses

| Persona | Mindset | What they hunt |
|---------|---------|----------------|
| **Security Adversary** | Attacker | Auth bypass, injection, data exposure, privilege escalation, supply chain, OWASP top 10 |
| **Failure Mode Analyst** | Murphy's Law | Race conditions, data loss, cascading failures, recovery gaps, deployment risks, rollback holes |
| **Assumption Destroyer** | Skeptic | Unstated dependencies, false "will work" claims, missing error paths, scale assumptions, integration assumptions |
| **Scope & Complexity Critic** | YAGNI enforcer | Over-engineering, premature abstraction, unnecessary complexity, missing MVP cuts, scope creep, gold plating |

### How to run

One lens at a time. Read every phase file through that lens. Don't mix lenses — each produces distinct findings.

Pick lenses based on plan content:
- Plan touches auth / data / permissions → **Security Adversary** (mandatory)
- Plan touches migrations / deployments / distributed systems → **Failure Mode Analyst** (mandatory)
- Plan has >5 phases or introduces new abstractions → **Scope & Complexity Critic** (mandatory)
- Every plan → **Assumption Destroyer** (always runs — fastest to catch stated-but-unverified claims)

### Reviewer prompt template

Feed this to a subagent (or adopt it yourself when self-reviewing):

```
You are reviewing a PLAN DOCUMENT, not code. There is nothing to lint, build, or test.
Focus exclusively on plan quality.

Adopt the {LENS_NAME} persona. Your job: DESTROY this plan.

Rules:
- Be specific: cite exact phase/section where the flaw lives
- Be concrete: describe the failure scenario, not just "could be a problem"
- Rate severity: Critical (blocks success) | High (significant risk) | Medium (notable concern)
- Skip trivial observations (style, naming, formatting)
- No praise. No "overall looks good." Only findings.
- 5-10 findings max. Quality over quantity.

Plan files: <paste paths>
```

### Finding format (per lens)

```markdown
## Finding N: {short title}
- **Severity:** Critical | High | Medium
- **Location:** Phase X, section "{name}"
- **Flaw:** {what's wrong}
- **Failure scenario:** {concrete description of how this fails in the real world}
- **Evidence:** {quote from plan, or missing element name}
- **Suggested fix:** {brief recommendation}
```

### Adjudication — what you actually do with findings

After the reviewer returns:

1. Read every finding
2. For each, decide **Accept** or **Reject**
3. Accept = update the relevant phase file; Reject = note why in the plan
4. Re-run the plan through the lens if Critical findings were accepted (fixes may create new flaws)

```markdown
## Red Team Findings — Session {YYYY-MM-DD}
**Total:** {N} ({accepted} accepted, {rejected} rejected)
**Severity:** {N} Critical, {N} High, {N} Medium

| # | Finding | Severity | Disposition | Applied to |
|---|---------|----------|-------------|------------|
| 1 | {title} | Critical | Accept | Phase 2 |
| 2 | {title} | High | Reject — {reason} | — |
```

Paste this block into `plan.md` under a `## Red Team Review` section.

---

## Part 2 — Validation Question Framework

Validation is NOT red-team. Red-team looks for flaws; validation surfaces **unstated decisions** the user needs to make before implementation.

### When to run

- `hard` mode with risk score ≥3 → auto-run
- `--validate` flag → always run
- Plan has >2 frontmatter fields filled with "TBD" or "TODO" → auto-run
- User passed `--no-validate` → skip regardless

### 5 question categories

Scan the plan text for these keywords to surface questions:

| Category | Keywords to detect | Typical question |
|----------|-------------------|------------------|
| **Architecture** | "approach", "pattern", "design", "database", "API" | "How should X be structured?" |
| **Assumptions** | "assume", "expect", "should", "will", "default" | "The plan assumes X. Is this correct?" |
| **Tradeoffs** | "tradeoff", "vs", "alternative", "either/or" | "X or Y for this flow?" |
| **Risks** | "risk", "might", "could fail", "dependency" | "What's the fallback if X fails?" |
| **Scope** | "phase", "MVP", "future", "nice to have" | "Should X be in v1 or deferred?" |

### Question format rules

- Ask via `AskUserQuestion` tool — never inline text
- Each question: 2-4 concrete options + "Other" (auto-appended by the UI)
- Mark recommended option with "(Recommended)" suffix
- Each question should surface an IMPLICIT decision — don't ask what's already explicit
- Max 5 questions per session — if you need more, the plan isn't ready

### Example questions

**Architecture**
> "How should validation results be persisted?"
> - Save to plan.md frontmatter (Recommended)
> - Create validation-answers.md
> - Don't persist

**Assumptions**
> "The plan assumes API rate limiting isn't needed in v1. Correct?"
> - Yes, not needed for MVP
> - No, add basic rate limiting now (Recommended)
> - Defer to Phase 2

**Tradeoffs**
> "Auth strategy: session+Redis or stateless JWT?"
> - Session + Redis (Recommended — matches existing stack)
> - Stateless JWT (if mobile app joins later)
> - Either, pick during Phase 3

### Validation log format

Append to `plan.md` under `## Validation Log`:

```markdown
## Validation Log — Session {N} ({YYYY-MM-DD})
**Trigger:** {auto-detected — risk score 4 | user flag --validate | TBD fields in frontmatter}
**Questions asked:** {count}

### Q&A

1. **[{Category}]** {full question text}
   - Options presented: {A} | {B} | {C}
   - **Answer:** {user's choice}
   - **Custom input:** {verbatim "Other" text if used}
   - **Rationale:** {why this decision matters for implementation}

2. ...

### Confirmed decisions
- {decision}: {choice} — {brief why}

### Action items
- [ ] Update Phase X requirements
- [ ] Add section Y to plan.md

### Phase impact
| Phase | What updates |
|-------|--------------|
| 2 | Requirements gain rate-limiting acceptance criterion |
| 4 | Architecture updated to session-based auth |
```

### Recording rules

- **Full question text** — exact wording presented, not a summary
- **All options** — every option shown, including "Other"
- **Verbatim custom input** — record the user's free-text answer exactly
- **Rationale** — one sentence explaining why this decision shapes the implementation
- **Session numbering** — increment from the last session, never reuse

### Section mapping — where answers land

When you propagate a decision into phase files, use this mapping:

| Change type | Target section in phase file |
|-------------|------------------------------|
| Requirements | Requirements |
| Architecture | Architecture |
| Scope | Overview + Implementation Steps |
| Risk | Risk Assessment |
| Unknown / novel | Key Insights (add subsection) |

---

## Part 3 — Running red-team then validation

If both are triggered, order matters:

1. **Red-team first** — may restructure phases, remove sections, add constraints
2. **Validation second** — asks questions about the FINAL plan shape, not a draft that's about to change

Running validation first then red-teaming wastes validation answers — they'd apply to a plan version that no longer exists.

If user flags conflict (`--no-red-team --validate`), validate only. If (`--red-team --no-validate`), red-team only. Flags win, no negotiation.
