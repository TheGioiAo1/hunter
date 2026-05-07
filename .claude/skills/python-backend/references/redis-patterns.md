# Redis Patterns (Python)

## Async Connection (redis-py v4.2+)

```python
# app/database/redis.py
import redis.asyncio as aioredis
from app.config import settings

redis_client: aioredis.Redis | None = None

async def init_redis():
    global redis_client
    redis_client = aioredis.from_url(
        settings.REDIS_URL,
        encoding="utf-8",
        decode_responses=True,
    )

async def close_redis():
    if redis_client:
        await redis_client.close()

def get_redis() -> aioredis.Redis:
    return redis_client
```

## Sync Connection (Flask)

```python
import redis

redis_client = redis.Redis(
    host="localhost",
    port=6379,
    password=None,
    db=0,
    decode_responses=True,
)
```

## Key Naming Convention

```
{module}:{entity}:{id}
{module}:{entity}:{id}:{sub}

# Examples
user:profile:123
cache:products:list:page-1
rate:limit:ip:192.168.1.1
session:abc-def-ghi
```

## Cache Service (Async)

```python
import json
from typing import TypeVar, Type
from pydantic import BaseModel

T = TypeVar("T", bound=BaseModel)

class CacheService:
    def __init__(self, redis: aioredis.Redis):
        self.redis = redis

    async def get(self, key: str, model: Type[T] | None = None) -> T | dict | None:
        data = await self.redis.get(key)
        if not data:
            return None
        parsed = json.loads(data)
        return model.model_validate(parsed) if model else parsed

    async def set(self, key: str, value, ttl: int = 3600):
        if isinstance(value, BaseModel):
            data = value.model_dump_json()
        else:
            data = json.dumps(value, default=str)
        await self.redis.set(key, data, ex=ttl)

    async def delete(self, key: str):
        await self.redis.delete(key)

    async def delete_pattern(self, pattern: str):
        keys = []
        async for key in self.redis.scan_iter(match=pattern):
            keys.append(key)
        if keys:
            await self.redis.delete(*keys)
```

## Cache-Aside Pattern

```python
class ProductService:
    def __init__(self, session: AsyncSession, cache: CacheService):
        self.session = session
        self.cache = cache

    async def get_by_id(self, product_id: int) -> ProductResponse:
        cache_key = f"cache:product:{product_id}"

        # Check cache
        cached = await self.cache.get(cache_key, ProductResponse)
        if cached:
            return cached

        # Cache miss — query DB
        product = await self.session.get(Product, product_id)
        if not product:
            raise NotFoundException("Product not found")

        response = ProductResponse.model_validate(product)
        await self.cache.set(cache_key, response, ttl=3600)
        return response

    async def update(self, product_id: int, data: UpdateProductSchema):
        product = await self._update_in_db(product_id, data)

        # Invalidate cache
        await self.cache.delete(f"cache:product:{product_id}")
        await self.cache.delete_pattern("cache:products:list:*")

        return product
```

## Rate Limiting (FastAPI)

```python
from fastapi import Request, HTTPException

async def rate_limit(
    request: Request,
    redis: aioredis.Redis = Depends(get_redis),
    limit: int = 100,
    window: int = 60,
):
    key = f"rate:limit:{request.client.host}"
    current = await redis.incr(key)
    if current == 1:
        await redis.expire(key, window)
    if current > limit:
        raise HTTPException(status_code=429, detail="Too many requests")

# Use as dependency
@router.get("/data", dependencies=[Depends(rate_limit)])
async def get_data():
    ...
```

## Rate Limiting (Flask decorator)

```python
from functools import wraps
from flask import request, jsonify

def rate_limit(limit: int = 100, window: int = 60):
    def decorator(f):
        @wraps(f)
        def wrapper(*args, **kwargs):
            key = f"rate:limit:{request.remote_addr}"
            current = redis_client.incr(key)
            if current == 1:
                redis_client.expire(key, window)
            if current > limit:
                return jsonify(detail="Too many requests"), 429
            return f(*args, **kwargs)
        return wrapper
    return decorator

@app.route("/data")
@rate_limit(limit=100, window=60)
def get_data():
    ...
```

## Pub/Sub (Async)

```python
# Publisher
async def publish_event(channel: str, data: dict):
    redis = get_redis()
    await redis.publish(channel, json.dumps(data, default=str))

# Subscriber (background task)
async def event_listener():
    redis = get_redis()
    pubsub = redis.pubsub()
    await pubsub.subscribe("order:created", "user:registered")

    async for message in pubsub.listen():
        if message["type"] == "message":
            channel = message["channel"]
            data = json.loads(message["data"])
            await handle_event(channel, data)
```

## Session Store (FastAPI)

```python
import uuid

async def create_session(redis: aioredis.Redis, user_data: dict) -> str:
    session_id = str(uuid.uuid4())
    await redis.set(
        f"session:{session_id}",
        json.dumps(user_data, default=str),
        ex=86400,  # 24h
    )
    return session_id

async def get_session(redis: aioredis.Redis, session_id: str) -> dict | None:
    data = await redis.get(f"session:{session_id}")
    return json.loads(data) if data else None

async def destroy_session(redis: aioredis.Redis, session_id: str):
    await redis.delete(f"session:{session_id}")
```

## Distributed Lock

```python
async def acquire_lock(redis: aioredis.Redis, key: str, ttl: int = 30) -> bool:
    return await redis.set(f"lock:{key}", "1", ex=ttl, nx=True)

async def release_lock(redis: aioredis.Redis, key: str):
    await redis.delete(f"lock:{key}")

# Usage
async def process_order(order_id: int):
    redis = get_redis()
    if not await acquire_lock(redis, f"order:{order_id}"):
        raise ConflictException("Order is being processed")
    try:
        # ... process safely
        pass
    finally:
        await release_lock(redis, f"order:{order_id}")
```

## TTL Guidelines

| Use case | TTL |
|----------|-----|
| User session | 24h |
| OTP / verification | 5-15 min |
| API response cache | 5-60 min |
| Product catalog | 1-6h |
| Rate limit counter | 1 min |
| Feature flags | 5 min |
| Distributed lock | 10-30s |
