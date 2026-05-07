# Flask Patterns

## App Factory

```python
# app/__init__.py
from flask import Flask
from app.config import config_by_name
from app.extensions import db, migrate, jwt, cache

def create_app(config_name: str = "dev") -> Flask:
    app = Flask(__name__)
    app.config.from_object(config_by_name[config_name])

    # Init extensions
    db.init_app(app)
    migrate.init_app(app, db)
    jwt.init_app(app)
    cache.init_app(app)

    # Register blueprints
    from app.blueprints.auth import auth_bp
    from app.blueprints.users import users_bp
    app.register_blueprint(auth_bp, url_prefix="/api/v1/auth")
    app.register_blueprint(users_bp, url_prefix="/api/v1/users")

    # Error handlers
    register_error_handlers(app)

    return app
```

## Config

```python
# app/config.py
import os

class BaseConfig:
    SECRET_KEY = os.getenv("SECRET_KEY", "change-me")
    SQLALCHEMY_TRACK_MODIFICATIONS = False
    JWT_SECRET_KEY = os.getenv("JWT_SECRET", "change-me")
    JWT_ACCESS_TOKEN_EXPIRES = 86400  # 24h

class DevConfig(BaseConfig):
    DEBUG = True
    SQLALCHEMY_DATABASE_URI = os.getenv(
        "DATABASE_URL", "postgresql://user:pass@localhost:5432/mydb"
    )
    CACHE_TYPE = "redis"
    CACHE_REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379/0")

class ProdConfig(BaseConfig):
    DEBUG = False
    SQLALCHEMY_DATABASE_URI = os.getenv("DATABASE_URL")

class TestConfig(BaseConfig):
    TESTING = True
    SQLALCHEMY_DATABASE_URI = "sqlite:///:memory:"

config_by_name = {"dev": DevConfig, "prod": ProdConfig, "test": TestConfig}
```

## Extensions

```python
# app/extensions.py
from flask_sqlalchemy import SQLAlchemy
from flask_migrate import Migrate
from flask_jwt_extended import JWTManager
from flask_caching import Cache

db = SQLAlchemy()
migrate = Migrate()
jwt = JWTManager()
cache = Cache()
```

## Blueprint Pattern

```python
# app/blueprints/users/__init__.py
from flask import Blueprint
users_bp = Blueprint("users", __name__)
from app.blueprints.users import routes  # noqa: import routes to register them

# app/blueprints/users/routes.py
from flask import request, jsonify
from flask_jwt_extended import jwt_required, get_jwt_identity
from app.blueprints.users import users_bp
from app.blueprints.users.services import UserService

@users_bp.route("", methods=["GET"])
def list_users():
    page = request.args.get("page", 1, type=int)
    page_size = request.args.get("page_size", 20, type=int)
    search = request.args.get("search")
    result = UserService.list(page=page, page_size=page_size, search=search)
    return jsonify(result)

@users_bp.route("/<int:user_id>", methods=["GET"])
def get_user(user_id: int):
    user = UserService.get_by_id(user_id)
    return jsonify(user.to_dict())

@users_bp.route("", methods=["POST"])
def create_user():
    data = request.get_json()
    # Validate with marshmallow or manual
    user = UserService.create(data)
    return jsonify(user.to_dict()), 201

@users_bp.route("/<int:user_id>", methods=["PATCH"])
@jwt_required()
def update_user(user_id: int):
    data = request.get_json()
    user = UserService.update(user_id, data)
    return jsonify(user.to_dict())

@users_bp.route("/<int:user_id>", methods=["DELETE"])
@jwt_required()
def delete_user(user_id: int):
    UserService.delete(user_id)
    return jsonify({"deleted": True})
```

## Service Pattern

```python
# app/blueprints/users/services.py
from flask import abort
from sqlalchemy.exc import IntegrityError
from app.extensions import db
from app.models.user import User

class UserService:
    @staticmethod
    def list(page: int, page_size: int, search: str | None = None):
        query = User.query.filter(User.deleted_at.is_(None))
        if search:
            query = query.filter(User.name.ilike(f"%{search}%"))

        total = query.count()
        users = (
            query.order_by(User.created_at.desc())
            .offset((page - 1) * page_size)
            .limit(page_size)
            .all()
        )
        return {
            "data": [u.to_dict() for u in users],
            "total": total,
            "page": page,
            "page_size": page_size,
        }

    @staticmethod
    def get_by_id(user_id: int) -> User:
        user = db.session.get(User, user_id)
        if not user or user.deleted_at:
            abort(404, description="User not found")
        return user

    @staticmethod
    def create(data: dict) -> User:
        user = User(**data)
        user.password = hash_password(data["password"])
        db.session.add(user)
        try:
            db.session.commit()
        except IntegrityError:
            db.session.rollback()
            abort(409, description="Email already exists")
        return user

    @staticmethod
    def update(user_id: int, data: dict) -> User:
        user = UserService.get_by_id(user_id)
        for key, value in data.items():
            if hasattr(user, key) and value is not None:
                setattr(user, key, value)
        db.session.commit()
        return user

    @staticmethod
    def delete(user_id: int):
        user = UserService.get_by_id(user_id)
        user.deleted_at = datetime.utcnow()
        db.session.commit()
```

## Error Handling

```python
def register_error_handlers(app):
    @app.errorhandler(400)
    def bad_request(e):
        return jsonify(success=False, detail=str(e.description)), 400

    @app.errorhandler(404)
    def not_found(e):
        return jsonify(success=False, detail=str(e.description)), 404

    @app.errorhandler(409)
    def conflict(e):
        return jsonify(success=False, detail=str(e.description)), 409

    @app.errorhandler(500)
    def internal_error(e):
        return jsonify(success=False, detail="Internal server error"), 500
```

## Authentication (Flask-JWT-Extended)

```python
# app/blueprints/auth/routes.py
from flask_jwt_extended import create_access_token, jwt_required, get_jwt_identity

@auth_bp.route("/login", methods=["POST"])
def login():
    data = request.get_json()
    user = User.query.filter_by(email=data["email"]).first()
    if not user or not verify_password(data["password"], user.password):
        abort(401, description="Invalid credentials")

    token = create_access_token(
        identity=str(user.id),
        additional_claims={"email": user.email, "role": user.role},
    )
    return jsonify(access_token=token)

@auth_bp.route("/me", methods=["GET"])
@jwt_required()
def get_me():
    user_id = get_jwt_identity()
    user = db.session.get(User, int(user_id))
    return jsonify(user.to_dict())
```

## Caching

```python
from app.extensions import cache

@users_bp.route("/<int:user_id>")
@cache.cached(timeout=300, key_prefix="user")
def get_user(user_id):
    ...

# Manual cache
cache.set(f"user:{user_id}", user_data, timeout=3600)
cached = cache.get(f"user:{user_id}")
cache.delete(f"user:{user_id}")
```

## Running

```bash
# Development
flask --app app:create_app run --reload --port 5000

# Production (Gunicorn)
gunicorn "app:create_app('prod')" -w 4 -b 0.0.0.0:5000

# Migrations
flask db init          # first time
flask db migrate -m "add user table"
flask db upgrade
flask db downgrade
```
