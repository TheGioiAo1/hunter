---
name: python-backend
description: "Build Python backends with FastAPI or Flask. Use for REST APIs, Pydantic models, SQLAlchemy, Tortoise ORM, MongoDB (Motor/Beanie), Redis, authentication, project structure."
argument-hint: "[feature or pattern]"
metadata:
  author: claudex-kit
  version: "1.0.0"
---

# Python Backend — FastAPI + Flask

## When to use

- Create REST APIs with FastAPI or Flask
- Define request/response models with Pydantic
- Database queries with SQLAlchemy (PostgreSQL/MySQL) or Tortoise ORM
- MongoDB with Motor (async) or Beanie (ODM)
- Caching with Redis (redis-py / aioredis)
- Authentication (JWT, OAuth2)
- Background tasks, middleware, error handling

## Framework Selection

| Criteria | FastAPI | Flask |
|----------|---------|-------|
| Performance | High (async, Starlette) | Moderate (sync, WSGI) |
| API docs | Auto OpenAPI/Swagger | Manual (flask-restx) |
| Validation | Built-in (Pydantic) | Manual (marshmallow) |
| Async | Native | Via flask[async] or Quart |
| Learning curve | Moderate | Easy |
| Best for | Modern APIs, microservices | Simple apps, prototypes, legacy |

**Default choice:** FastAPI for new projects, Flask when integrating with legacy systems.

## Project Structure (FastAPI)

```
app/
├── main.py                     # FastAPI app instance, startup/shutdown
├── config.py                   # Settings via pydantic-settings
├── dependencies.py             # Shared dependencies (get_db, get_current_user)
├── routers/
│   ├── __init__.py
│   ├── users.py                # /api/v1/users
│   ├── auth.py                 # /api/v1/auth
│   └── products.py             # /api/v1/products
├── models/                     # ORM models (SQLAlchemy / Tortoise / Beanie)
│   ├── __init__.py
│   ├── user.py
│   └── product.py
├── schemas/                    # Pydantic schemas (request/response)
│   ├── __init__.py
│   ├── user.py
│   └── product.py
├── services/                   # Business logic
│   ├── __init__.py
│   ├── user_service.py
│   └── product_service.py
├── middleware/
│   ├── __init__.py
│   └── error_handler.py
├── utils/
│   ├── __init__.py
│   ├── security.py             # JWT, password hashing
│   └── pagination.py
├── database/
│   ├── __init__.py
│   └── session.py              # DB engine + session factory
├── alembic/                    # Migrations (SQLAlchemy)
│   ├── versions/
│   └── env.py
├── alembic.ini
├── requirements.txt
└── .env
```

## Project Structure (Flask)

```
app/
├── __init__.py                 # Flask app factory (create_app)
├── config.py                   # Config classes (Dev, Prod, Test)
├── extensions.py               # db, migrate, jwt, cache init
├── blueprints/
│   ├── __init__.py
│   ├── users/
│   │   ├── __init__.py
│   │   ├── routes.py
│   │   ├── services.py
│   │   └── schemas.py
│   └── auth/
│       ├── __init__.py
│       ├── routes.py
│       └── services.py
├── models/
│   ├── __init__.py
│   └── user.py
├── utils/
│   └── pagination.py
├── migrations/                 # Flask-Migrate (Alembic wrapper)
├── requirements.txt
└── .env
```

## Architecture Rules

### Router / Blueprint (Controller)

- Route prefix: `/api/v1/{plural}`
- Methods: `list`, `get_by_id`, `create`, `update`, `delete`
- Router **only** validates + calls service + returns response
- **NO** business logic in router

### Service

- Service = the **only** place for business logic
- Receives DB session / repository, returns domain objects or raises exceptions
- Custom exceptions → router converts to HTTP response

### Pydantic Schemas

- `CreateSchema`: required fields with validation
- `UpdateSchema`: all `Optional` fields
- `ResponseSchema`: what the API returns (exclude sensitive fields)
- `ListQuerySchema`: page, page_size, filters

### Naming

- Files: snake_case (`user_service.py`)
- Classes: PascalCase (`UserService`, `CreateUserSchema`)
- Routes: kebab-case or snake_case (`/api/v1/users`, `/api/v1/farm-configs`)
- Variables/functions: snake_case (`get_user_by_id`)

## Database Selection

| Database | ORM / ODM | Best for |
|----------|-----------|----------|
| PostgreSQL | SQLAlchemy + Alembic | Relational data, ACID, complex queries |
| PostgreSQL | Tortoise ORM | Async-first, simpler API |
| MySQL | SQLAlchemy + Alembic | Legacy systems, wide hosting support |
| MongoDB | Motor (async driver) | Low-level, full control |
| MongoDB | Beanie (async ODM) | Pydantic-native, validation built-in |
| SQLite | SQLAlchemy | Prototyping, embedded, testing |

## Redis

- Async: `redis.asyncio` (built into redis-py v4.2+)
- Sync: `redis.Redis`
- Keys: `{module}:{entity}:{id}`
- TTL: always set expiration

Details: `references/redis-patterns.md`

## Authentication

- FastAPI: OAuth2PasswordBearer + JWT (python-jose / PyJWT)
- Flask: Flask-JWT-Extended
- Password hashing: passlib[bcrypt]

Details: `references/fastapi-patterns.md` (auth section)

## References

Load when details needed:

| File | Content |
|------|---------|
| `references/fastapi-patterns.md` | App setup, routers, dependencies, middleware, auth, background tasks, WebSocket |
| `references/flask-patterns.md` | App factory, blueprints, extensions, error handling, auth, middleware |
| `references/pydantic-patterns.md` | Models, validators, settings, serialization, nested models, custom types |
| `references/database-patterns.md` | SQLAlchemy, Tortoise ORM, Beanie/Motor, Alembic migrations, async sessions |
| `references/redis-patterns.md` | Caching, pub/sub, rate limiting, session store (async + sync) |
