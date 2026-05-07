# FastAPI Patterns

## App Setup

```python
# app/main.py
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.database.session import init_db, close_db
from app.routers import users, auth, products
from app.middleware.error_handler import register_error_handlers

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup
    await init_db()
    yield
    # Shutdown
    await close_db()

app = FastAPI(
    title=settings.APP_NAME,
    version="1.0.0",
    lifespan=lifespan,
)

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Error handlers
register_error_handlers(app)

# Routers
app.include_router(auth.router, prefix="/api/v1/auth", tags=["auth"])
app.include_router(users.router, prefix="/api/v1/users", tags=["users"])
app.include_router(products.router, prefix="/api/v1/products", tags=["products"])
```

## Config (pydantic-settings)

```python
# app/config.py
from pydantic_settings import BaseSettings

class Settings(BaseSettings):
    APP_NAME: str = "MyApp"
    DEBUG: bool = False

    DATABASE_URL: str = "postgresql+asyncpg://user:pass@localhost:5432/mydb"
    REDIS_URL: str = "redis://localhost:6379/0"

    JWT_SECRET: str = "change-me"
    JWT_ALGORITHM: str = "HS256"
    JWT_EXPIRE_MINUTES: int = 1440  # 24h

    ALLOWED_ORIGINS: list[str] = ["http://localhost:3000"]

    class Config:
        env_file = ".env"

settings = Settings()
```

## Router Pattern

```python
# app/routers/users.py
from fastapi import APIRouter, Depends, Query, status
from app.schemas.user import (
    CreateUserSchema, UpdateUserSchema, UserResponse, UserListResponse
)
from app.services.user_service import UserService
from app.dependencies import get_user_service, get_current_user

router = APIRouter()

@router.get("", response_model=UserListResponse)
async def list_users(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    search: str | None = None,
    service: UserService = Depends(get_user_service),
):
    return await service.list(page=page, page_size=page_size, search=search)


@router.get("/{user_id}", response_model=UserResponse)
async def get_user(
    user_id: int,
    service: UserService = Depends(get_user_service),
):
    return await service.get_by_id(user_id)


@router.post("", response_model=UserResponse, status_code=status.HTTP_201_CREATED)
async def create_user(
    data: CreateUserSchema,
    service: UserService = Depends(get_user_service),
):
    return await service.create(data)


@router.patch("/{user_id}", response_model=UserResponse)
async def update_user(
    user_id: int,
    data: UpdateUserSchema,
    service: UserService = Depends(get_user_service),
    current_user=Depends(get_current_user),
):
    return await service.update(user_id, data)


@router.delete("/{user_id}")
async def delete_user(
    user_id: int,
    service: UserService = Depends(get_user_service),
    current_user=Depends(get_current_user),
):
    await service.delete(user_id)
    return {"deleted": True}
```

## Dependencies (Dependency Injection)

```python
# app/dependencies.py
from fastapi import Depends
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy.ext.asyncio import AsyncSession

from app.database.session import get_session
from app.services.user_service import UserService
from app.utils.security import decode_token

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/v1/auth/login")

async def get_user_service(
    session: AsyncSession = Depends(get_session),
) -> UserService:
    return UserService(session)

async def get_current_user(token: str = Depends(oauth2_scheme)):
    payload = decode_token(token)
    if not payload:
        raise HTTPException(status_code=401, detail="Invalid token")
    return payload
```

## Service Pattern

```python
# app/services/user_service.py
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession
from fastapi import HTTPException

from app.models.user import User
from app.schemas.user import CreateUserSchema, UpdateUserSchema
from app.utils.security import hash_password

class UserService:
    def __init__(self, session: AsyncSession):
        self.session = session

    async def list(self, page: int, page_size: int, search: str | None = None):
        query = select(User).where(User.deleted_at.is_(None))
        count_query = select(func.count()).select_from(User).where(User.deleted_at.is_(None))

        if search:
            query = query.where(User.name.ilike(f"%{search}%"))
            count_query = count_query.where(User.name.ilike(f"%{search}%"))

        total = (await self.session.execute(count_query)).scalar()
        result = await self.session.execute(
            query.order_by(User.created_at.desc())
            .offset((page - 1) * page_size)
            .limit(page_size)
        )
        users = result.scalars().all()

        return {"data": users, "total": total, "page": page, "page_size": page_size}

    async def get_by_id(self, user_id: int) -> User:
        user = await self.session.get(User, user_id)
        if not user or user.deleted_at:
            raise HTTPException(status_code=404, detail="User not found")
        return user

    async def create(self, data: CreateUserSchema) -> User:
        user = User(
            name=data.name,
            email=data.email,
            password=hash_password(data.password),
            role=data.role or "user",
        )
        self.session.add(user)
        try:
            await self.session.commit()
            await self.session.refresh(user)
        except IntegrityError:
            await self.session.rollback()
            raise HTTPException(status_code=409, detail="Email already exists")
        return user

    async def update(self, user_id: int, data: UpdateUserSchema) -> User:
        user = await self.get_by_id(user_id)
        update_data = data.model_dump(exclude_unset=True)
        for field, value in update_data.items():
            setattr(user, field, value)
        await self.session.commit()
        await self.session.refresh(user)
        return user

    async def delete(self, user_id: int):
        user = await self.get_by_id(user_id)
        user.deleted_at = datetime.utcnow()
        await self.session.commit()
```

## Error Handling

```python
# app/middleware/error_handler.py
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

class AppException(Exception):
    def __init__(self, status_code: int, detail: str):
        self.status_code = status_code
        self.detail = detail

class NotFoundException(AppException):
    def __init__(self, detail: str = "Not found"):
        super().__init__(404, detail)

class ConflictException(AppException):
    def __init__(self, detail: str = "Conflict"):
        super().__init__(409, detail)

def register_error_handlers(app: FastAPI):
    @app.exception_handler(AppException)
    async def app_exception_handler(request: Request, exc: AppException):
        return JSONResponse(
            status_code=exc.status_code,
            content={"success": False, "detail": exc.detail},
        )

    @app.exception_handler(Exception)
    async def general_exception_handler(request: Request, exc: Exception):
        return JSONResponse(
            status_code=500,
            content={"success": False, "detail": "Internal server error"},
        )
```

## Authentication (JWT)

```python
# app/utils/security.py
from datetime import datetime, timedelta
from jose import jwt, JWTError
from passlib.context import CryptContext
from app.config import settings

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

def hash_password(password: str) -> str:
    return pwd_context.hash(password)

def verify_password(plain: str, hashed: str) -> bool:
    return pwd_context.verify(plain, hashed)

def create_access_token(data: dict) -> str:
    to_encode = data.copy()
    to_encode["exp"] = datetime.utcnow() + timedelta(minutes=settings.JWT_EXPIRE_MINUTES)
    return jwt.encode(to_encode, settings.JWT_SECRET, algorithm=settings.JWT_ALGORITHM)

def decode_token(token: str) -> dict | None:
    try:
        return jwt.decode(token, settings.JWT_SECRET, algorithms=[settings.JWT_ALGORITHM])
    except JWTError:
        return None
```

```python
# app/routers/auth.py
from fastapi import APIRouter, Depends, HTTPException
from fastapi.security import OAuth2PasswordRequestForm

router = APIRouter()

@router.post("/login")
async def login(
    form: OAuth2PasswordRequestForm = Depends(),
    service: UserService = Depends(get_user_service),
):
    user = await service.get_by_email(form.username)
    if not user or not verify_password(form.password, user.password):
        raise HTTPException(status_code=401, detail="Invalid credentials")
    token = create_access_token({"sub": str(user.id), "email": user.email, "role": user.role})
    return {"access_token": token, "token_type": "bearer"}
```

## Background Tasks

```python
from fastapi import BackgroundTasks

@router.post("/send-email")
async def send_email(
    data: EmailSchema,
    background_tasks: BackgroundTasks,
):
    background_tasks.add_task(send_email_task, data.to, data.subject, data.body)
    return {"message": "Email queued"}

# For heavy tasks, use Celery or ARQ instead of BackgroundTasks
```

## WebSocket

```python
from fastapi import WebSocket, WebSocketDisconnect

class ConnectionManager:
    def __init__(self):
        self.active: list[WebSocket] = []

    async def connect(self, ws: WebSocket):
        await ws.accept()
        self.active.append(ws)

    def disconnect(self, ws: WebSocket):
        self.active.remove(ws)

    async def broadcast(self, message: str):
        for conn in self.active:
            await conn.send_text(message)

manager = ConnectionManager()

@router.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await manager.connect(ws)
    try:
        while True:
            data = await ws.receive_text()
            await manager.broadcast(data)
    except WebSocketDisconnect:
        manager.disconnect(ws)
```

## Middleware

```python
from fastapi import Request
import time

@app.middleware("http")
async def add_process_time_header(request: Request, call_next):
    start = time.time()
    response = await call_next(request)
    response.headers["X-Process-Time"] = str(time.time() - start)
    return response
```
