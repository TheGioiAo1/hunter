# Shared Phases (All Modes)

These phases run after planning is done and `/cook` takes over. Cook handles most of the execution — this reference adds bootstrap-specific guidance on top.

## Implementation

Handled by `/cook`. Bootstrap notes:
- Follow the plan in `./plans` phase by phase
- `ui-ux-pro-max` skill for frontend per `./docs/design-guidelines.md`
- `frontend-design` skill for UI implementation from screenshots/mockups
- `theme-implement` skill for integrating external UI templates/artifacts
- Type checking and compile after every phase. No exceptions.

## Testing

Handled by `/cook`. Bootstrap notes:
- Real tests with real assertions. NO fake data, mocks that prove nothing, or temporary hacks to make green.
- `tester` subagent runs tests → reports to main agent
- Failures: `debugger` subagent investigates → fix → repeat until all pass
- A test suite that passes because it doesn't test anything is worse than no tests

## Code Review

Handled by `/cook`. Bootstrap notes:
- `code-reviewer` subagent reviews code
- Critical issues: fix → retest → repeat
- Report summary when all tests pass and code reviewed

## Documentation

After code review passes. `docs-manager` subagent creates/updates:
- `./docs/README.md` (≤300 lines)
- `./docs/codebase-summary.md`
- `./docs/project-overview-pdr.md`
- `./docs/code-standards.md`
- `./docs/system-architecture.md`

`project-manager` subagent creates `./docs/project-roadmap.md` and marks plan/phase status complete.

## Onboarding

Walk the user through getting started:
- One question at a time. Wait for the answer.
- Example: "You need a Stripe API key — go to dashboard.stripe.com, create one, paste it here."
- If user wants config changes, repeat until they're happy.

## Final Report

1. Summary of all changes — brief, scannable
2. How to get started + suggested next steps
3. Ask about commit/push:
   - If yes: `git-manager` subagent handles it
   - `--fast` mode: auto-commit (no push) without asking

**Report rules:** Sacrifice grammar for concision. List unresolved questions at end.
