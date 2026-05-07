# Database Patterns (Python)

## SQLAlchemy (Async — PostgreSQL / MySQL / SQLite)

### Session Setup

```python
# app/database/session.py
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession
from app.config import settings

engine = create_async_engine(settings.DATABASE_URL, echo=settings.DEBUG)
async_session = async_sessionmaker(engine, expire_on_commit=False)

async def init_db():
    async with engine.begin() as conn:
        # Only for dev — use Alembic in production
        # await conn.run_sync(Base.metadata.create_all)
        pass

async def close_db():
    await engine.dispose()

# Dependency for FastAPI
async def get_session() -> AsyncSession:
    async with async_session() as session:
        yield session
```

### Model Definition

```python
# app/models/user.py
from datetime import datetime
from sqlalchemy import String, Boolean, DateTime, BigInteger, func
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship

class Base(DeclarativeBase):
    pass

class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

class User(TimestampMixin, Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(100))
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    password: Mapped[str] = mapped_column(String(255))
    role: Mapped[str] = mapped_column(String(20), default="user")
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)

    # Relations
    posts: Mapped[list["Post"]] = relationship(back_populates="author", lazy="selectin")

    def to_dict(self):
        return {
            "id": self.id,
            "name": self.name,
            "email": self.email,
            "role": self.role,
            "is_active": self.is_active,
            "created_at": self.created_at.isoformat() if self.created_at else None,
        }
```

### Relations

```python
# One-to-Many
class Post(TimestampMixin, Base):
    __tablename__ = "posts"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    title: Mapped[str] = mapped_column(String(255))
    author_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("users.id"))

    author: Mapped["User"] = relationship(back_populates="posts")
    tags: Mapped[list["Tag"]] = relationship(secondary="post_tags", back_populates="posts")

# Many-to-Many
post_tags = Table(
    "post_tags", Base.metadata,
    Column("post_id", BigInteger, ForeignKey("posts.id"), primary_key=True),
    Column("tag_id", BigInteger, ForeignKey("tags.id"), primary_key=True),
)

class Tag(Base):
    __tablename__ = "tags"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    name: Mapped[str] = mapped_column(String(50), unique=True)
    posts: Mapped[list["Post"]] = relationship(secondary="post_tags", back_populates="tags")
```

### Common Queries (Async)

```python
from sqlalchemy import select, func, update, delete

# Find by ID
user = await session.get(User, user_id)

# Find with filter
stmt = select(User).where(User.email == email)
result = await session.execute(stmt)
user = result.scalar_one_or_none()

# List with pagination
stmt = (
    select(User)
    .where(User.deleted_at.is_(None))
    .order_by(User.created_at.desc())
    .offset((page - 1) * page_size)
    .limit(page_size)
)
result = await session.execute(stmt)
users = result.scalars().all()

# Count
stmt = select(func.count()).select_from(User).where(User.deleted_at.is_(None))
total = (await session.execute(stmt)).scalar()

# Bulk update
stmt = update(User).where(User.role == "guest").values(role="user")
await session.execute(stmt)
await session.commit()

# Eager load relations
stmt = select(User).options(selectinload(User.posts)).where(User.id == user_id)
```

### Transactions

```python
async with async_session() as session:
    async with session.begin():
        # Everything inside auto-commits on success, auto-rollbacks on exception
        session.add(order)
        await session.flush()  # Get order.id before commit

        for item in items:
            item.order_id = order.id
            session.add(item)
    # Committed here
```

### Alembic Migrations

```bash
# Init
alembic init alembic

# Generate migration
alembic revision --autogenerate -m "create users table"

# Apply
alembic upgrade head

# Rollback
alembic downgrade -1

# Show history
alembic history
```

```python
# alembic/env.py — async config
from app.database.session import engine
from app.models import Base  # import all models

target_metadata = Base.metadata

def do_run_migrations(connection):
    context.configure(connection=connection, target_metadata=target_metadata)
    with context.begin_transaction():
        context.run_migrations()

async def run_async_migrations():
    async with engine.connect() as connection:
        await connection.run_sync(do_run_migrations)
    await engine.dispose()
```

---

## Tortoise ORM (Async — PostgreSQL / MySQL / SQLite)

### Setup

```python
from tortoise import Tortoise

TORTOISE_ORM = {
    "connections": {"default": "postgres://user:pass@localhost:5432/mydb"},
    "apps": {
        "models": {
            "models": ["app.models", "aerich.models"],
            "default_connection": "default",
        },
    },
}

# FastAPI integration
from tortoise.contrib.fastapi import register_tortoise

register_tortoise(
    app,
    config=TORTOISE_ORM,
    generate_schemas=True,  # dev only
    add_exception_handlers=True,
)
```

### Model

```python
from tortoise import fields
from tortoise.models import Model

class User(Model):
    id = fields.BigIntField(pk=True)
    name = fields.CharField(max_length=100)
    email = fields.CharField(max_length=255, unique=True)
    password = fields.CharField(max_length=255)
    role = fields.CharField(max_length=20, default="user")
    is_active = fields.BooleanField(default=True)
    created_at = fields.DatetimeField(auto_now_add=True)
    updated_at = fields.DatetimeField(auto_now=True)
    deleted_at = fields.DatetimeField(null=True)

    posts: fields.ReverseRelation["Post"]

    class Meta:
        table = "users"
        ordering = ["-created_at"]

    class PydanticMeta:
        exclude = ["password"]
```

### Queries

```python
# CRUD
user = await User.create(name="John", email="john@example.com", password=hashed)
user = await User.get_or_none(id=user_id)
user = await User.get(id=user_id)  # raises DoesNotExist
await user.save()
await user.delete()

# Filter
users = await User.filter(role="admin", is_active=True).all()
count = await User.filter(role="admin").count()

# Pagination
users = await User.all().offset(0).limit(20).order_by("-created_at")

# Relations
posts = await Post.filter(author_id=user_id).prefetch_related("tags")

# Aggregate
from tortoise.functions import Count, Avg
stats = await User.annotate(post_count=Count("posts")).filter(post_count__gte=5)
```

### Migrations (Aerich)

```bash
pip install aerich
aerich init -t app.config.TORTOISE_ORM
aerich init-db
aerich migrate --name "add_user_avatar"
aerich upgrade
aerich downgrade
```

---

## Beanie (Async MongoDB ODM — Pydantic-native)

### Setup

```python
from beanie import init_beanie
from motor.motor_asyncio import AsyncIOMotorClient
from app.models import User, Post

async def init_db():
    client = AsyncIOMotorClient("mongodb://localhost:27017")
    await init_beanie(
        database=client.mydb,
        document_models=[User, Post],
    )
```

### Model

```python
from beanie import Document, Indexed
from pydantic import EmailStr, Field
from datetime import datetime

class User(Document):
    name: str
    email: Indexed(EmailStr, unique=True)
    password: str
    role: str = "user"
    is_active: bool = True
    tags: list[str] = []
    metadata: dict = {}
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)
    deleted_at: datetime | None = None

    class Settings:
        name = "users"  # collection name
        indexes = [
            [("name", 1), ("email", 1)],  # compound index
        ]
```

### Queries

```python
# Create
user = User(name="John", email="john@example.com", password=hashed)
await user.insert()

# Find
user = await User.get(user_id)           # by _id (ObjectId)
user = await User.find_one(User.email == "john@example.com")

# List with filter
users = await User.find(
    User.role == "admin",
    User.deleted_at == None,
).sort(-User.created_at).skip(0).limit(20).to_list()

count = await User.find(User.role == "admin").count()

# Update
user.name = "Jane"
await user.save()

# Or atomic update
await User.find_one(User.id == user_id).update({"$set": {"name": "Jane"}})

# Bulk update
await User.find(User.role == "guest").update({"$set": {"role": "user"}})

# Delete
await user.delete()

# Aggregation
pipeline = [
    {"$match": {"deleted_at": None}},
    {"$group": {"_id": "$role", "count": {"$sum": 1}}},
    {"$sort": {"count": -1}},
]
results = await User.aggregate(pipeline).to_list()
```

---

## Motor (Low-level Async MongoDB)

```python
from motor.motor_asyncio import AsyncIOMotorClient

client = AsyncIOMotorClient("mongodb://localhost:27017")
db = client.mydb
users_col = db.users

# Insert
result = await users_col.insert_one({"name": "John", "email": "john@example.com"})
user_id = result.inserted_id

# Find
user = await users_col.find_one({"_id": user_id})
cursor = users_col.find({"role": "admin"}).sort("created_at", -1).skip(0).limit(20)
users = await cursor.to_list(length=20)

# Update
await users_col.update_one({"_id": user_id}, {"$set": {"name": "Jane"}})

# Delete
await users_col.delete_one({"_id": user_id})

# Count
count = await users_col.count_documents({"role": "admin"})

# Aggregate
pipeline = [{"$group": {"_id": "$role", "count": {"$sum": 1}}}]
results = await users_col.aggregate(pipeline).to_list(length=100)
```
