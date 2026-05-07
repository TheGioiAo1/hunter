---
name: db-design
description: "Design or extend database schemas following per-library conventions (Prisma, Mongoose, Sequelize, TypeORM, Drizzle, raw SQL). Enforces migration safety — always run the ORM's migrate command, never hand-write migration files. Use when designing new tables/collections, adding columns, changing relations, or writing DDL."
argument-hint: "[schema change request]"
metadata:
  author: claudex-kit
  version: "1.0.0"
---

# Database design

You design and apply schema changes across any ORM. The non-negotiable rule: **migrations always go through the tool's CLI. Never hand-write migration files.** That single rule prevents most data-loss incidents caused by out-of-sync state between schema file, migration history, and live DB.

## Process

### 1 — Detect stack

Invoke `/db-analyze` (or run the same detection inline) to identify ORM + DB. You need to know **exactly** which tool's migrate command to run before touching anything.

Record:
- ORM (Prisma / Mongoose / Sequelize / TypeORM / Drizzle / raw SQL)
- DB engine (Postgres / MySQL / SQLite / MongoDB)
- Schema file path(s)
- Migration directory path (if applicable)

If detection is ambiguous → ask user, don't guess.

### 2 — Gather requirements (mandatory)

Before designing, ask these if unclear. Don't assume:

| Missing | Question |
|---|---|
| Entities | "What entities are involved?" |
| Query patterns | "What are the top 3 queries this table serves?" |
| Uniqueness | "Any fields that must be unique? (email, slug, composite key)" |
| Relations | "How does this relate to existing tables?" |
| Cardinality | "Estimated row count? 1K, 1M, or 100M+?" |
| Retention | "Soft delete? Hard delete? TTL?" |

Hold off on DDL until answers are clear. Propose design → wait for approval → only then execute.

### 3 — Apply stack conventions

Skip the sections that don't apply. Stack detected in Step 1 determines which rules to follow.

**Universal naming rule (applies to every stack below):**

| DB | Table / collection | Column / field | Why |
|---|---|---|---|
| Postgres / MySQL / SQLite | `snake_case` plural (`users`, `order_items`) | `snake_case` (`created_at`, `user_id`) | Postgres folds unquoted identifiers to lowercase (`CreatedAt` → `createdat` — underscore lost → merged word). MySQL case-folding varies by OS. SQLite case-insensitive for matching. Snake_case is the only form that survives round-trips cleanly. |
| MongoDB | `camelCase` plural (`users`, `orderItems`, `auditLogs`) | `camelCase` (`createdAt`, `userId`) | MongoDB / BSON native convention. Most Mongo docs, drivers, and community examples use camelCase. Matches JS/TS object-property style naturally. |

- **Two bridging strategies** (pick per ORM, see sections below):
  1. **No bridge** — schema/model name = DB name directly (Prisma v6, Drizzle, raw SQL). Simplest, no mapping layer.
  2. **Naming strategy / explicit map** — class stays idiomatic TS/JS, ORM auto-translates (TypeORM `SnakeNamingStrategy`, Sequelize `underscored: true`).
- Never ship a DB object in a casing that doesn't match its engine's convention (e.g. `userName` in Postgres, `user_name` in MongoDB, `User` singular for any table/collection).

#### Prisma v6 (Postgres/MySQL/SQLite)

**Always use Prisma v6+** (check `package.json` — upgrade if older). Prisma v6 features (`omit`, `relationJoins`, typed SQL) are assumed throughout.

- Schema file: `prisma/schema.prisma` — single source of truth
- **Naming — no mapping layer:**
  - Model name = DB table name, in `snake_case_plural`: `model users { ... }`, `model order_items { ... }`
  - Field name = DB column name, in `snake_case`: `created_at DateTime`, `user_id BigInt`
  - **DO NOT use `@map` or `@@map`** — keep schema and DB names identical. The `@@map` indirection is redundant once Prisma name = DB name.
- Client calls follow the model name: `prisma.users.findMany()`, `prisma.order_items.create(...)`. Generated types are `users`, `order_items` (not `User`/`OrderItem`). Accept the trade-off for schema simplicity.
- Every model MUST have a primary key and `created_at` / `updated_at` unless explicitly stateless
- PK: `@default(uuid())` or `@default(autoincrement())` — never client-generated IDs
- Relations: define both sides (e.g. `posts posts[]` on one side, `author users @relation(fields: [user_id], references: [id])` on the other)
- Indexes via `@@index([field])` or `@unique` — add for every FK and every frequently filtered column
- Prefer v6 features: `omit: { password: true }` for hiding sensitive fields, `relationJoins` for JOIN-based eager loading, `$queryRawTyped` for typed raw SQL

**Migration workflow — MANDATORY:**

```bash
# 1. Edit schema.prisma (add/modify models)
# 2. Run migrate dev — this generates migration SQL AND applies it
npx prisma migrate dev --name "<descriptive_snake_case>"
# 3. Regenerate client
npx prisma generate
```

**NEVER:**
- ❌ Write files in `prisma/migrations/` by hand
- ❌ Edit an existing migration after it's been applied
- ❌ Run `prisma db push` in projects that use migrate (push skips history → drift)
- ❌ Delete a migration folder to "start over" — use `prisma migrate resolve` or reset in dev

**If migration conflicts with existing data:**
- Dev: `npx prisma migrate reset` (destroys data — confirm first)
- Prod drift: `npx prisma migrate resolve --applied <migration_name>` after manual SQL reconciliation
- Never blindly delete `_prisma_migrations` rows

#### Mongoose (MongoDB via NestJS or plain)

- Schema files: `src/**/*.schema.ts` with `@Schema({ timestamps: true, collection: 'camelCasePlural' })` — e.g. `orderItems`, `auditLogs`, never `OrderItems` (PascalCase) or `order_items` (snake_case)
- Fields via `@Prop({ required, unique, index, default, enum })`
- Field names **in MongoDB documents** are `camelCase`. TS class property name = DB field name directly — no `name` override needed. Example: `@Prop() createdAt: Date` stores as `createdAt` in the doc.
- `timestamps: true` gives you `createdAt`/`updatedAt` in camelCase out of the box — default is correct, don't override.
- Compound indexes: `UserSchema.index({ email: 1, tenantId: 1 }, { unique: true })` at bottom of file
- Use `.lean()` for read-only queries (10x faster)
- Populate explicitly for relations, never nested references blindly
- Soft delete via `deletedAt: Date | null` — document the convention, don't install plugin unless asked

**"Migration" workflow:**

MongoDB is schemaless — there's no migrate command. Changes are applied by:
1. Edit `.schema.ts` — Mongoose enforces at write time
2. For existing documents needing backfill: write a one-off script in `scripts/migrations/YYMMDD-<name>.ts` that runs via `ts-node`, reads + updates docs in batches
3. Never assume existing docs match new required fields — add `default` or make optional, then backfill

**NEVER:**
- ❌ Add `required: true` to a field on a collection with existing docs without a backfill script
- ❌ Rename a field in schema and expect old docs to map — write a migration script

#### Sequelize (Postgres/MySQL/SQLite)

- Models in `models/*.ts` via `sequelize.define(...)` or class extending `Model`
- **Naming:** set `tableName: 'snake_case_plural'` and `underscored: true` (auto-maps camelCase attrs → snake_case columns). Disable `freezeTableName` pluralization defaults if they produce non-snake_case output.
- Use `sequelize-cli` for migrations:

```bash
# Generate skeleton
npx sequelize-cli migration:generate --name add-user-table
# Edit the generated file's up() and down()
# Apply
npx sequelize-cli db:migrate
# Revert last
npx sequelize-cli db:migrate:undo
```

- Always fill BOTH `up()` and `down()` — irreversible migrations are a trap
- Never `sync({ force: true })` outside local dev — wipes data
- Never `sync({ alter: true })` in prod — unpredictable DDL

**NEVER:**
- ❌ Skip `down()` because "we won't roll back"
- ❌ Edit a migration after it's been run in any environment

#### TypeORM (Postgres/MySQL/SQLite)

- Entities in `src/**/*.entity.ts` with `@Entity()`, `@Column()`, `@ManyToOne()`, etc.
- **Naming:** `@Entity('snake_case_plural')` always (don't rely on the default). For columns, either set a `SnakeNamingStrategy` in the DataSource (applies everywhere) OR use `@Column({ name: 'snake_case' })` on every multi-word field. Prefer the naming strategy — less boilerplate.

```bash
# Generate based on entity diff (preferred)
npx typeorm migration:generate src/migrations/<Name> -d src/data-source.ts
# Apply
npx typeorm migration:run -d src/data-source.ts
# Revert
npx typeorm migration:revert -d src/data-source.ts
```

- Use `migration:generate` (diffs entities vs DB) — not `migration:create` (empty skeleton)
- Never enable `synchronize: true` in prod — dev only

#### Drizzle (Postgres/MySQL/SQLite)

- Schema in `src/db/schema.ts` using `pgTable()` / `mysqlTable()` / `sqliteTable()`
- **Naming:** first arg of `pgTable('snake_case_plural', ...)` is the DB table name — always snake_case. For columns, pass the snake_case name as the first arg: `createdAt: timestamp('created_at')`. TS property can stay camelCase, DB stays snake_case.
- Migration via `drizzle-kit`:

```bash
# Generate migration SQL from schema diff
npx drizzle-kit generate
# Apply
npx drizzle-kit migrate
```

- Keep `drizzle.config.ts` pointing to the right schema file
- Never edit generated SQL in `drizzle/` folder after it's applied

#### Raw SQL (no ORM)

- Migrations in `migrations/` with `NNNN_<name>.up.sql` + `NNNN_<name>.down.sql` (sequential numbering)
- Use a runner: `sqitch`, `dbmate`, `migrate` (golang-migrate), or `flyway`
- Each migration must be idempotent where possible (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`)
- **Naming (all DB objects):** table names + column names + index names + constraint names all `snake_case`. Example: `CREATE TABLE order_items (id BIGSERIAL PRIMARY KEY, user_id BIGINT, created_at TIMESTAMPTZ); CREATE INDEX idx_order_items_user_id ON order_items(user_id);`
- Migration **file names:** snake_case, DDL only (no mixed DDL + DML)
- Never run ad-hoc DDL against prod via `psql` — go through the runner so history is tracked

### 4 — Universal DDL checklist

Before shipping any schema change, verify:

- [ ] DB-level names match the engine's convention: `snake_case` for SQL (tables plural, columns singular, indexes `idx_<table>_<col>`, FKs `fk_<table>_<ref>`); `camelCase` for MongoDB (collections plural, fields singular)
- [ ] Primary key defined (UUID or bigint, not int32 for anything that grows)
- [ ] Foreign keys have indexes (ORMs don't always auto-index FKs — Prisma does, TypeORM partial, raw SQL never)
- [ ] `createdAt` / `updatedAt` present (or documented reason they're not)
- [ ] Nullable vs required matches business rule (not default guess)
- [ ] Unique constraints on natural keys (email, slug, etc.)
- [ ] Default values set where safe (booleans, timestamps, enums)
- [ ] Cascade behavior on FK decided (`ON DELETE CASCADE` vs `RESTRICT` vs `SET NULL`)
- [ ] Index added for every column used in `WHERE` / `ORDER BY` / `JOIN` on hot paths
- [ ] Soft-delete convention consistent with existing tables (don't mix hard + soft delete randomly)
- [ ] Migration file reviewed before applying — don't just trust the diff

### 5 — Apply the migration

Once design is approved:

1. Edit schema file(s) per stack conventions.
2. Run the stack's migrate command (listed in Step 3). **Never hand-write the migration file.**
3. Inspect the generated migration file — if the generated SQL looks wrong (e.g. drops + recreates instead of alter), fix the schema cause, regenerate.
4. Apply in dev first. Verify with a smoke query.
5. Commit schema file + generated migration file together. One commit, both changes.

## Anti-patterns (do not do)

| Smell | Why it's bad |
|---|---|
| "Let me just edit the migration SQL to fix it" | Loses diff fidelity. Next generation will re-diff from broken state. |
| "I'll skip migrate and just ALTER TABLE via psql" | Out-of-band change = drift = next migration explodes. |
| "The migration errored, I'll rename the file and try again" | Migration history now lies. Future resets/deploys fail silently. |
| "I added `required: true` in Mongoose and redeployed" | Existing docs without that field now fail validation on read/update. |
| "Sequelize `sync({ alter: true })` is easier than migrations" | Fine in local dev. In shared envs → unpredictable DDL, data loss risk. |
| "I'll write the Prisma migration file myself for precise control" | Prisma re-generates on next `migrate dev` and will conflict. Use raw SQL blocks *inside* the generated file if needed. |

## When called by other agents

`brainstorm`, `plan`, `cook` may invoke this skill when the task touches the data layer. Always return:
- Proposed schema diff (in stack syntax)
- Migration command the agent will run
- Risk flags (data backfill needed, breaking change, irreversible)

Don't run the migration inside a subagent — return the plan, let the main agent execute so the user sees the command and output.
