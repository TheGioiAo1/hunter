---
name: db-analyze
description: "Analyze database structure and data models for any stack. Auto-detects ORM/DB type (Prisma, TypeORM, Sequelize, Mongoose, GORM, SQLAlchemy, Drizzle, etc.), reads the relevant schema files, and produces a structured summary. Use when brainstorming, reviewing, or planning anything that touches the data layer."
argument-hint: "[optional: specific table or model to focus on]"
metadata:
  author: claudex-kit
  version: "1.0.0"
---

# Database analysis

You analyze a project's data layer — schema, models, relationships, constraints — without assuming any specific stack. Your job is to detect what's being used, read the right files, and produce a clear summary that other agents (brainstormer, planner, reviewer) can consume.

## Process

### 1 — Detect stack

Run these in parallel to fingerprint the project:

```
Glob("package.json")              → Node.js ecosystem
Glob("go.mod")                    → Go
Glob("pyproject.toml")            → Python
Glob("Gemfile")                   → Ruby
Glob("pom.xml")                   → Java
Glob("*.csproj")                  → .NET
Glob("docker-compose.{yml,yaml}") → check for DB services
```

Then narrow down the ORM / DB layer:

| Signal file | Stack | Read what |
|-------------|-------|-----------|
| `prisma/schema.prisma` | Prisma (Node) | The schema file — it has everything |
| `src/**/*.entity.ts` | TypeORM (Node) | All entity files |
| `src/**/*.model.ts` or `models/*.ts` | Sequelize (Node) | All model files |
| `drizzle/schema.ts` or `src/db/schema.ts` | Drizzle (Node) | Schema definition file |
| `src/**/*.schema.ts` + `@Schema()` decorator | Mongoose/NestJS (Node) | All schema files |
| `models/*.js` + `mongoose.model` | Mongoose plain (Node) | All model files |
| `**/models.py` or `**/model.py` | Django / SQLAlchemy (Python) | Model files |
| `alembic/versions/*.py` | SQLAlchemy + Alembic (Python) | Latest migration + models |
| `**/*_model.go` or `**/*_entity.go` | GORM / Ent (Go) | Model/entity files |
| `db/migrate/*.rb` | ActiveRecord (Ruby) | Schema.rb + latest migrations |
| `**/Entity/*.java` or `**/entity/*.kt` | JPA/Hibernate (Java/Kotlin) | Entity classes |
| `**/Models/*.cs` | Entity Framework (.NET) | Model classes + DbContext |

**Fallback when no ORM detected:**
- Check `docker-compose` for DB image (postgres, mysql, mongo, redis)
- Look for raw SQL in `migrations/`, `sql/`, `db/` folders
- Look for `.sql` files anywhere in the project
- If nothing found → report "no data layer detected"

### 2 — Read schema

Based on detection, read the relevant files. Prioritize:
1. **Schema definition files** (schema.prisma, models.py, entity files) — single source of truth
2. **Migration files** (only latest 2-3) — shows recent changes
3. **DB config** (connection strings, pool settings) — only if relevant to the question

**Do NOT:**
- Read all migration history — latest 2-3 is enough
- Query live database unless explicitly asked
- Assume schema.prisma exists in every Node project

### 3 — Produce summary

Output a structured summary in this format:

```markdown
## Data layer

**Stack:** [detected ORM/DB, e.g. "Prisma + PostgreSQL" or "Mongoose + MongoDB"]
**Source:** [files read, e.g. "prisma/schema.prisma"]

### Models

| Model | Key fields | Relations |
|-------|-----------|-----------|
| User | id, email, name, createdAt | has many Transaction, has many Budget |
| Transaction | id, amount, date, note | belongs to User, belongs to Category |

### Observations
- [anything notable: missing indexes, circular relations, denormalized fields, no soft delete, etc.]
- [only flag real issues, not style preferences]
```

If `$ARGUMENTS` specifies a model/table → zoom into that one with full field list, types, constraints, and all relations.

## When called by other agents

Brainstormer, planner, or reviewer may call this skill to understand the data layer. Keep the summary concise — they need structure overview, not a full audit. If they need deeper analysis, they'll ask follow-up.

## When live data is needed

If the question requires actual data (row counts, data distribution, checking for orphans):
1. Check if MCP postgres/mongo server is connected → use it
2. Else fall back to `Bash` with `psql`, `mongosh`, or equivalent CLI
3. Never ask the user for connection strings — check `.env`, `docker-compose.yml`, or ORM config files for credentials
