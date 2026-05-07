# Pydantic Patterns (v2)

## Basic Schemas

```python
# app/schemas/user.py
from datetime import datetime
from pydantic import BaseModel, EmailStr, Field, ConfigDict

class CreateUserSchema(BaseModel):
    name: str = Field(..., min_length=2, max_length=100)
    email: EmailStr
    password: str = Field(..., min_length=8)
    role: str | None = Field(None, pattern="^(user|admin)$")

class UpdateUserSchema(BaseModel):
    name: str | None = Field(None, min_length=2, max_length=100)
    email: EmailStr | None = None
    role: str | None = Field(None, pattern="^(user|admin)$")

class UserResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    email: str
    role: str
    created_at: datetime

class UserListResponse(BaseModel):
    data: list[UserResponse]
    total: int
    page: int
    page_size: int
```

## Custom Validators

```python
from pydantic import field_validator, model_validator

class CreateUserSchema(BaseModel):
    name: str
    email: EmailStr
    password: str
    password_confirm: str

    @field_validator("name")
    @classmethod
    def name_must_not_contain_special(cls, v: str) -> str:
        if not v.replace(" ", "").isalnum():
            raise ValueError("Name must be alphanumeric")
        return v.strip()

    @field_validator("password")
    @classmethod
    def password_strength(cls, v: str) -> str:
        if len(v) < 8:
            raise ValueError("Password must be at least 8 characters")
        if not any(c.isupper() for c in v):
            raise ValueError("Password must contain uppercase letter")
        if not any(c.isdigit() for c in v):
            raise ValueError("Password must contain a digit")
        return v

    @model_validator(mode="after")
    def passwords_match(self):
        if self.password != self.password_confirm:
            raise ValueError("Passwords do not match")
        return self
```

## Settings (pydantic-settings)

```python
from pydantic_settings import BaseSettings, SettingsConfigDict

class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
    )

    app_name: str = "MyApp"
    debug: bool = False
    database_url: str
    redis_url: str = "redis://localhost:6379/0"
    jwt_secret: str
    allowed_origins: list[str] = ["http://localhost:3000"]

    # Nested: prefix env vars with SMTP_
    smtp_host: str = "smtp.gmail.com"
    smtp_port: int = 587
    smtp_user: str = ""
    smtp_password: str = ""
```

## Nested Models

```python
class Address(BaseModel):
    street: str
    city: str
    country: str = "VN"
    zip_code: str | None = None

class UserProfile(BaseModel):
    bio: str | None = None
    avatar_url: str | None = None
    address: Address | None = None
    social_links: dict[str, str] = {}

class UserFullResponse(UserResponse):
    profile: UserProfile | None = None
```

## Serialization

```python
# From ORM object
user_response = UserResponse.model_validate(user_orm_object)

# To dict
data = user_response.model_dump()
data_no_none = user_response.model_dump(exclude_none=True)
data_subset = user_response.model_dump(include={"id", "name", "email"})
data_exclude = user_response.model_dump(exclude={"password"})

# To JSON string
json_str = user_response.model_dump_json()

# From dict
user = CreateUserSchema.model_validate({"name": "John", "email": "john@example.com", ...})

# From JSON string
user = CreateUserSchema.model_validate_json(json_string)
```

## Pagination Schema

```python
from typing import Generic, TypeVar
from pydantic import BaseModel

T = TypeVar("T")

class PaginatedResponse(BaseModel, Generic[T]):
    data: list[T]
    total: int
    page: int
    page_size: int

    @property
    def total_pages(self) -> int:
        return (self.total + self.page_size - 1) // self.page_size

    @property
    def has_next(self) -> bool:
        return self.page < self.total_pages

# Usage: PaginatedResponse[UserResponse]
```

## Common Field Types

```python
from pydantic import (
    Field, EmailStr, HttpUrl, IPvAnyAddress,
    PositiveInt, NonNegativeInt, constr, conint, confloat,
)
from datetime import datetime, date
from enum import Enum
from uuid import UUID

class Status(str, Enum):
    active = "active"
    inactive = "inactive"
    banned = "banned"

class ProductSchema(BaseModel):
    id: UUID
    name: str = Field(..., min_length=1, max_length=255)
    slug: constr(pattern=r"^[a-z0-9-]+$")
    price: confloat(gt=0)
    stock: NonNegativeInt = 0
    status: Status = Status.active
    tags: list[str] = []
    website: HttpUrl | None = None
    published_at: datetime | None = None
```
