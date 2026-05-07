---
name: go-backend
description: "Build Go backends with Echo + GORM + Redis. Use for REST APIs, handlers, middleware, database queries, caching, authentication, project structure."
argument-hint: "[feature or pattern]"
metadata:
  author: claudex-kit
  version: "1.0.0"
---

# Go Backend — Echo + GORM + Redis

## When to use

- Create handlers, middleware, routes with Echo
- Write GORM models + queries (PostgreSQL / MySQL / SQLite)
- Implement authentication (JWT middleware)
- Caching with Redis (go-redis)
- Validation (go-playground/validator)
- Error handling, logging, project structure

## Project Structure

```
cmd/
  server/
    main.go                   # Entry point, wire dependencies
internal/
  config/
    config.go                 # Env loading (viper / envconfig)
  domain/
    {feature}/
      handler.go              # HTTP handlers (route + validate)
      service.go              # Business logic
      repository.go           # DB queries (GORM)
      model.go                # GORM model + migration
      dto.go                  # Request/Response structs + validation tags
      routes.go               # Register routes for this feature
  middleware/
    auth.go                   # JWT middleware
    logger.go                 # Request logging
    error_handler.go          # Centralized error handling
    cors.go                   # CORS config
  shared/
    database/
      database.go             # GORM connection + auto-migrate
    redis/
      redis.go                # Redis client init
    response/
      response.go             # Standard JSON response helpers
    validator/
      validator.go            # Custom validator setup
pkg/                          # Reusable packages (optional)
```

## Architecture Rules

### Handler (Controller)

- Route prefix: `/api/v1/{plural}` or `/admin/{plural}`
- Methods: `List`, `GetByID`, `Create`, `Update`, `Delete`
- Handler **only** parses request + validates + calls service + returns response
- **NO** business logic in handler

### Service

- Service = the **only** place for business logic
- Receives repository interface, no direct dependency on GORM
- Returns domain errors, handler converts to HTTP status

### Repository

- Encapsulates all GORM queries
- Returns model or error
- Interface-based for easy testing (mock)

### HTTP Methods & Status Codes

| Method | Route | Action | Status |
|--------|-------|--------|--------|
| GET | `/{feature}` | List (paginated) | 200 |
| GET | `/{feature}/:id` | Get one | 200 / 404 |
| POST | `/{feature}` | Create | 201 |
| PUT | `/{feature}/:id` | Update | 200 / 404 |
| DELETE | `/{feature}/:id` | Remove | 200 / 404 |

### Pagination Response

```go
type PaginatedResponse[T any] struct {
    Data     []T   `json:"data"`
    Total    int64 `json:"total"`
    Page     int   `json:"page"`
    PageSize int   `json:"pageSize"`
}
```

### DTO Pattern

- Use struct tags: `json:"field"` + `validate:"required,min=3"`
- `CreateRequest`: required fields
- `UpdateRequest`: all optional (pointer fields)
- `ListQuery`: page, pageSize (defaults), filters

### Naming

- Files: snake_case (`user_handler.go`)
- Packages: lowercase, short (`domain`, `middleware`, `shared`)
- Structs: PascalCase (`UserHandler`, `CreateUserRequest`)
- Interfaces: PascalCase, typically suffix `-er` or prefix `I` (`UserRepository`)

### Error Handling

- Custom error types with HTTP status mapping
- Centralized error handler middleware
- Wrap errors with context: `fmt.Errorf("find user: %w", err)`
- Never expose internal errors to client

## Database

- **PostgreSQL / MySQL** → GORM (`gorm.io/gorm`)
- Auto-migrate in dev, manual migration for prod

Details: `references/gorm-patterns.md`

## Redis

- Client: go-redis (`github.com/redis/go-redis/v9`)
- Keys: `{module}:{entity}:{id}`
- TTL: always set expiration
- Pub/Sub for real-time events

Details: `references/redis-patterns.md`

## Authentication

- JWT middleware voi Echo
- Claims struct + token generation/validation
- Route groups: public vs protected vs admin

Details: `references/echo-patterns.md`

## References

Load when details needed:

| File | Content |
|------|----------|
| `references/echo-patterns.md` | Routing, middleware, groups, validation, error handling, JWT auth |
| `references/gorm-patterns.md` | Models, CRUD, relations, transactions, migrations, scopes, hooks |
| `references/redis-patterns.md` | Caching, pub/sub, rate limiting, session, distributed lock |
