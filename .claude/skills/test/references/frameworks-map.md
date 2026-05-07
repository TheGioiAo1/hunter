# Frameworks Map

Maps the framework detected by `detect-tests.cjs` to the tech-stack skill that owns the idiomatic patterns. **Read the referenced `testing-patterns.md` before writing any test.**

## Mapping table

| Detected framework | Stack skill | Reference file | Typical stack |
|--------------------|-------------|----------------|---------------|
| `jest` | `node-backend` OR `frontend-development` | `.claude/skills/node-backend/references/testing-patterns.md` OR `.claude/skills/frontend-development/resources/testing-patterns.md` | NestJS / Express / React |
| `vitest` | `frontend-development` (primary) OR `node-backend` | `.claude/skills/frontend-development/resources/testing-patterns.md` | Vite + React / Vite + Node |
| `mocha` | `node-backend` | `.claude/skills/node-backend/references/testing-patterns.md` | Legacy Node |
| `supertest` (with jest) | `node-backend` | `.claude/skills/node-backend/references/testing-patterns.md` | Express / NestJS HTTP tests |
| `pytest` | `python-backend` | `.claude/skills/python-backend/references/testing-patterns.md` | FastAPI / Flask |
| `unittest` | `python-backend` | `.claude/skills/python-backend/references/testing-patterns.md` | Legacy Python |
| `go test` (stdlib) | `go-backend` | `.claude/skills/go-backend/references/testing-patterns.md` | Any Go |
| `testify` | `go-backend` | `.claude/skills/go-backend/references/testing-patterns.md` | Go + assertions |
| `playwright` | `frontend-development` | `.claude/skills/frontend-development/resources/testing-patterns.md` | E2E any web stack |
| `cypress` | `frontend-development` | `.claude/skills/frontend-development/resources/testing-patterns.md` | Legacy E2E |
| `@testing-library/react` | `frontend-development` | `.claude/skills/frontend-development/resources/testing-patterns.md` | React component |
| `@testing-library/react-native` | `mobile-development` | `.claude/skills/mobile-development/references/testing-patterns.md` | RN component |
| `detox` | `mobile-development` | `.claude/skills/mobile-development/references/testing-patterns.md` | RN E2E |
| `maestro` | `mobile-development` | `.claude/skills/mobile-development/references/testing-patterns.md` | Cross-mobile E2E |
| `flutter_test` | `mobile-development` | `.claude/skills/mobile-development/references/testing-patterns.md` | Flutter widget/unit |
| `integration_test` (Flutter) | `mobile-development` | `.claude/skills/mobile-development/references/testing-patterns.md` | Flutter integration |
| `XCTest` / `XCUITest` | `mobile-development` | `.claude/skills/mobile-development/references/testing-patterns.md` | iOS native |
| `JUnit` (Android) | `mobile-development` | `.claude/skills/mobile-development/references/testing-patterns.md` | Android native |
| `Espresso` / `Compose UI` | `mobile-development` | `.claude/skills/mobile-development/references/testing-patterns.md` | Android native UI |
| `wails + vitest` | `wails` | `.claude/skills/wails/references/testing-patterns.md` | Wails desktop (dual runtime) |
| `phpunit` | `php-backend` | `.claude/skills/php-backend/references/testing-patterns.md` | Laravel / Symfony / plain PHP |
| `pest` | `php-backend` | `.claude/skills/php-backend/references/testing-patterns.md` | Laravel with Pest |
| `phpspec` | `php-backend` | `.claude/skills/php-backend/references/testing-patterns.md` | Spec-style PHP |
| `rspec` | — | — | Not covered — Ruby stack not supported in this kit |

## Disambiguation rules

Some frameworks can belong to multiple stacks. Use these signals:

### `jest` — node-backend vs frontend-development

- Has `nestjs`, `@nestjs/*`, `prisma`, `mongoose`, `express`, `fastify` in deps → **node-backend**
- Has `react`, `react-dom`, `next`, `@testing-library/react` in deps → **frontend-development**
- Has both → test files in `src/server/**` or `apps/api/**` use node-backend patterns; `src/app/**` or `apps/web/**` use frontend patterns

### `vitest` — frontend-development vs node-backend

- Has `react`, `@testing-library/react`, `jsdom` in deps → **frontend-development**
- Has `nestjs`, `express`, etc., no `jsdom` → **node-backend**
- Default: **frontend-development** (vitest is more common on the frontend)

### Wails — detect via `wails.json` + `go.mod`

If `wails.json` exists at repo root AND `frontend/` has vitest/jest, use **wails testing-patterns.md** — it handles the dual-runtime mocking case (Go side + mocked bindings in frontend).

### Monorepos

If `package.json` workspaces show multiple apps (e.g. `apps/api`, `apps/web`), map per-directory:

- `apps/api/**` → node-backend or go-backend (by manifest in that dir)
- `apps/web/**` → frontend-development
- `apps/mobile/**` → mobile-development
- `apps/desktop/**` → wails

The detector's `testDirs` field lists every directory containing tests; check each against the monorepo map.

## When the framework is unknown

If `detect-tests.cjs` returns `framework: null` but `testFileCount > 0`, it means test files exist with no standard config. Options:

1. Inspect a test file — the imports will tell you.
2. Ask the user via `AskUserQuestion`.
3. Fall back to stdlib conventions for the detected language (e.g. plain Go `testing`, plain Python `unittest`).

Don't guess — the wrong idiom produces non-running tests.

## Cross-cutting test types

Some tests don't map neatly to one stack:

- **Contract tests** (Pact, Spring Cloud Contract) → treat as integration tests in the consumer's stack
- **Load/performance** (k6, JMeter, Locust) → out of scope for this skill, point the user to a standalone load-testing setup
- **Visual regression** (Chromatic, Percy, Playwright screenshots) → frontend-development + note in report that visual diffs need human review
- **Mutation testing** (Stryker, mutmut) → optional, only run on explicit `--mutation` flag (not in default flow)

## Updating this map

When a new stack skill lands (e.g. `rust-backend`, `kotlin-backend`), add its row here and point to its `testing-patterns.md`. The `/test` skill auto-picks up additions via the mapping — no SKILL.md change needed.
