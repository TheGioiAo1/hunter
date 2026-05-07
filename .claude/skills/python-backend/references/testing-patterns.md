# Python Backend Testing Patterns (pytest + FastAPI / Flask + SQLAlchemy / Beanie)

## File layout

```
src/
  users/
    service.py
    router.py
tests/
  unit/
    test_service.py
  integration/
    test_router.py
  e2e/
    test_user_flow.py
  conftest.py              # shared fixtures
  factories/
    user.py                # factory_boy factories
```

## Config

```ini
# pyproject.toml
[tool.pytest.ini_options]
pythonpath = ["src"]
asyncio_mode = "auto"
addopts = "-ra --strict-markers --cov=src --cov-report=term-missing"
markers = [
  "integration: requires DB/Redis",
  "slow: >1s tests",
]
```

Run: `pytest`, `pytest -k "test_login"`, `pytest -m "not slow"`.

## Fixtures (conftest.py)

```python
import pytest
import pytest_asyncio
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.orm import sessionmaker
from src.main import app
from src.db import Base

@pytest_asyncio.fixture
async def db_session():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    Session = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with Session() as session:
        yield session
    await engine.dispose()

@pytest_asyncio.fixture
async def client(db_session):
    app.dependency_overrides[get_db] = lambda: db_session
    async with AsyncClient(app=app, base_url="http://test") as ac:
        yield ac
    app.dependency_overrides.clear()
```

## Service unit — AAA pattern

```python
import pytest
from unittest.mock import AsyncMock
from src.users.service import UsersService

@pytest.mark.asyncio
async def test_register_hashes_password():
    # Arrange
    repo = AsyncMock()
    repo.create.return_value = {"id": "1"}
    service = UsersService(repo)

    # Act
    await service.register(email="a@b.com", password="plain")

    # Assert
    args = repo.create.call_args.kwargs
    assert args["password"] != "plain"
    assert args["password"].startswith("$2b$")  # bcrypt
```

## FastAPI integration — TestClient / AsyncClient

```python
@pytest.mark.asyncio
async def test_login_success(client):
    resp = await client.post("/auth/login",
        json={"email": "a@b.com", "password": "correct"})
    assert resp.status_code == 200
    assert "token" in resp.json()

@pytest.mark.asyncio
async def test_login_wrong_password(client):
    resp = await client.post("/auth/login",
        json={"email": "a@b.com", "password": "wrong"})
    assert resp.status_code == 401

@pytest.mark.parametrize("payload,expected", [
    ({}, 422),                                          # empty
    ({"email": "not-an-email"}, 422),                   # invalid format
    ({"email": "a@b.com"}, 422),                        # missing password
])
@pytest.mark.asyncio
async def test_login_validation(client, payload, expected):
    resp = await client.post("/auth/login", json=payload)
    assert resp.status_code == expected
```

## Dependency override (DI)

```python
# Override auth dependency to return a fake user
app.dependency_overrides[get_current_user] = lambda: User(id="u1", role="admin")
```

## Beanie (MongoDB) testing

```python
from mongomock_motor import AsyncMongoMockClient
from beanie import init_beanie

@pytest_asyncio.fixture(autouse=True)
async def init_db():
    client = AsyncMongoMockClient()
    await init_beanie(database=client["test"], document_models=[User])
    yield
    # mongomock is in-memory, no cleanup needed
```

## SQLAlchemy mock vs in-memory

Prefer **in-memory SQLite** for repository layer tests — mocking ORM queries is fragile. Reserve mocks for the service layer above repositories.

```python
# Test repository with real SQLite
async def test_user_repo_find_by_email(db_session):
    user = User(email="a@b.com", password="hash")
    db_session.add(user); await db_session.commit()
    repo = UserRepository(db_session)
    result = await repo.find_by_email("a@b.com")
    assert result.id == user.id
```

## factory_boy factories

```python
# tests/factories/user.py
import factory
from src.users.models import User

class UserFactory(factory.Factory):
    class Meta:
        model = User
    id = factory.Sequence(lambda n: f"u{n}")
    email = factory.Faker("email")
    password = factory.LazyAttribute(lambda _: bcrypt.hashpw(b"pw", bcrypt.gensalt()))
    role = "user"

# usage
user = UserFactory(role="admin")
```

## Mocking external calls

```python
from unittest.mock import patch

@pytest.mark.asyncio
async def test_send_email_calls_sendgrid():
    with patch("src.notifications.sendgrid.send_mail", new=AsyncMock()) as mock:
        await notify_user("a@b.com", "hello")
        mock.assert_awaited_once()
```

Or use `respx` for httpx mocking:

```python
import respx
@respx.mock
@pytest.mark.asyncio
async def test_external_api():
    respx.get("https://api.stripe.com/v1/charges").respond(200, json={"id": "ch_1"})
    result = await charge_card(100)
    assert result["id"] == "ch_1"
```

## Redis

```python
import fakeredis.aioredis
@pytest_asyncio.fixture
async def redis():
    client = fakeredis.aioredis.FakeRedis()
    yield client
    await client.flushall()
```

## Error path coverage

Per endpoint / service, always test:
- Happy path (200/201)
- Pydantic validation error (422)
- Auth failure (401)
- Forbidden by role (403)
- Not found (404)
- Conflict / duplicate (409)
- DB integrity error propagation

## Async gotchas

- `pytest.mark.asyncio` or set `asyncio_mode = "auto"`
- `AsyncMock` for coroutines, `MagicMock` for sync
- `await` every coroutine — no dangling task warnings
- Don't mix event loops — one per test

## Coverage priorities

1. **Critical path**: auth, payments, permissions, migrations → 90%+
2. **Business logic** (services) → 80%+
3. **Routers** → happy + auth + validation paths
4. **Schemas / models** → skip (covered via integration)
5. **Migrations** → smoke test only

## Common pitfalls

- Shared DB state between tests → transaction rollback fixture or truncate
- `datetime.now()` → freeze with `freezegun.freeze_time("2025-01-01")`
- `uuid.uuid4()` → monkeypatch or inject generator
- Module-level imports failing → use `pytest.importorskip` for optional deps
- Flask: remember to wrap requests in `app.test_client()` or use `pytest-flask`
