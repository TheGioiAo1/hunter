---
name: node-backend
description: "Build Node.js backends with NestJS + Prisma + Mongoose + Redis. Use for REST APIs, modules, services, DTOs, guards, interceptors, database queries, caching, authentication."
argument-hint: "[feature or pattern]"
metadata:
  author: claudex-kit
  version: "1.0.0"
---

# Node Backend — NestJS + Prisma + Mongoose + Redis

## When to use

- Create NestJS modules, services, controllers
- Write Prisma queries (PostgreSQL) or Mongoose schemas (MongoDB)
- Implement authentication (JWT, Guards)
- Caching with Redis
- Validation (DTOs, Pipes)
- Error handling, interceptors, middleware

## NestJS Architecture

### Module Structure

Each feature = 1 module:

```
src/modules/{feature}/
├── {feature}.module.ts
├── {feature}.service.ts           # Business logic + DB queries
├── {feature}-admin.controller.ts  # admin/{feature}
├── {feature}-api.controller.ts    # api/{feature} (optional)
├── dto/
│   ├── index.ts                   # Barrel export
│   ├── create-{feature}.dto.ts
│   ├── update-{feature}.dto.ts
│   └── query-{feature}.dto.ts
└── index.ts                       # Barrel export module + service
```

### Controller Pattern

- Route prefix: `admin/{plural}` or `api/{plural}` (kebab-case)
- Methods: `findAll`, `findOne`, `create`, `update`, `remove`
- Bulk: `POST/PATCH/DELETE {prefix}/bulk`
- Soft delete restore: `PATCH :id/restore`
- Guards at class level: `@UseGuards(JwtAuthGuard)`
- User context: `@CurrentUser('id') userId: bigint`

### Service Pattern

- Service = the **only** place for business logic + DB queries
- Controller **only** routes + validates, NO logic inside
- NestJS exceptions: `NotFoundException`, `ConflictException`, `UnauthorizedException`
- Prisma error `P2002` → `ConflictException`

### HTTP Methods & Status Codes

| Method | Route | Action | Status |
|--------|-------|--------|--------|
| GET | `/{feature}` | List (paginated) | 200 |
| GET | `/{feature}/:id` | Get one | 200 / 404 |
| POST | `/{feature}` | Create | 201 |
| PATCH | `/{feature}/:id` | Update | 200 / 404 |
| DELETE | `/{feature}/:id` | Remove | 200 / 404 |

### Pagination Response

```typescript
{ data: T[], total: number, current: number, pageSize: number }
```

### DTO Pattern

- `class-validator` decorators, each field has validation
- `CreateDto`: required fields
- `UpdateDto`: all `@IsOptional()`
- `QueryDto`: page, pageSize (defaults), filters all `@IsOptional()`
- Barrel export via `dto/index.ts`

### Naming

- Files: kebab-case (`users-admin.controller.ts`)
- Classes: PascalCase (`UsersAdminController`)
- DTOs: PascalCase + Dto suffix (`CreateUserDto`)
- Routes: kebab-case plural (`admin/farm-configs`)

### Shared Modules (`src/shared/`)

- `authentication/` — Guards, Decorators (@CurrentUser, @Public)
- `prisma/` — PrismaService (global)
- Import once in AppModule

## Database

### Choosing ORM

- **PostgreSQL** → Prisma (`prisma/schema.prisma`)
- **MongoDB** → Mongoose (`@nestjs/mongoose`)

Details: `references/prisma-patterns.md`, `references/mongoose-patterns.md`

## Redis

- Connection: ioredis with retry strategy
- Keys: `{module}:{entity}:{id}`
- TTL: always set expiration
- Pub/Sub for real-time events

Details: `references/redis-patterns.md`

## Authentication

- JWT + Passport strategy
- Guards: `JwtAuthGuard`, `AdminGuard`, `ApiKeyGuard`
- Decorators: `@CurrentUser()`, `@Public()`

Details: `references/nestjs-patterns.md`

## References

Load when details needed:

| File | Content |
|------|----------|
| `references/nestjs-patterns.md` | Guards, interceptors, pipes, middleware, execution pipeline, auth patterns |
| `references/prisma-patterns.md` | Schema conventions, queries, transactions, error handling, migrations |
| `references/mongoose-patterns.md` | Schema decorators, indexes, lean queries, population, aggregation |
| `references/redis-patterns.md` | Caching strategies, pub/sub, session store, rate limiting |
