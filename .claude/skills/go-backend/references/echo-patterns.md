# Echo Patterns

## Setup

```go
// cmd/server/main.go
package main

import (
    "myapp/internal/config"
    "myapp/internal/shared/database"
    "myapp/internal/middleware"
    "myapp/internal/domain/users"

    "github.com/labstack/echo/v4"
    echomw "github.com/labstack/echo/v4/middleware"
)

func main() {
    cfg := config.Load()
    db := database.Connect(cfg)

    e := echo.New()

    // Global middleware
    e.Use(echomw.Logger())
    e.Use(echomw.Recover())
    e.Use(echomw.CORSWithConfig(echomw.CORSConfig{
        AllowOrigins: cfg.AllowedOrigins,
        AllowMethods: []string{echo.GET, echo.POST, echo.PUT, echo.DELETE},
    }))
    e.Use(middleware.ErrorHandler())

    // Validator
    e.Validator = middleware.NewValidator()

    // Routes
    api := e.Group("/api/v1")
    users.RegisterRoutes(api, db)

    e.Logger.Fatal(e.Start(":" + cfg.Port))
}
```

## Routing & Groups

```go
// internal/domain/users/routes.go
func RegisterRoutes(g *echo.Group, db *gorm.DB) {
    repo := NewRepository(db)
    svc := NewService(repo)
    h := NewHandler(svc)

    users := g.Group("/users")
    users.GET("", h.List)
    users.GET("/:id", h.GetByID)
    users.POST("", h.Create)
    users.PUT("/:id", h.Update)
    users.DELETE("/:id", h.Delete)

    // Protected routes
    protected := users.Group("")
    protected.Use(middleware.JWTAuth(cfg.JWTSecret))
    protected.GET("/me", h.GetProfile)
    protected.PUT("/me", h.UpdateProfile)

    // Admin routes
    admin := g.Group("/admin/users")
    admin.Use(middleware.JWTAuth(cfg.JWTSecret), middleware.RequireRole("admin"))
    admin.GET("", h.AdminList)
    admin.DELETE("/:id", h.AdminDelete)
}
```

## Handler Pattern

```go
// internal/domain/users/handler.go
type Handler struct {
    service *Service
}

func NewHandler(s *Service) *Handler {
    return &Handler{service: s}
}

func (h *Handler) List(c echo.Context) error {
    var q ListQuery
    if err := c.Bind(&q); err != nil {
        return echo.NewHTTPError(http.StatusBadRequest, "invalid query params")
    }
    q.SetDefaults()

    result, err := h.service.List(c.Request().Context(), q)
    if err != nil {
        return err  // centralized error handler catches this
    }
    return c.JSON(http.StatusOK, result)
}

func (h *Handler) GetByID(c echo.Context) error {
    id, err := strconv.ParseUint(c.Param("id"), 10, 64)
    if err != nil {
        return echo.NewHTTPError(http.StatusBadRequest, "invalid id")
    }

    user, err := h.service.GetByID(c.Request().Context(), uint(id))
    if err != nil {
        return err
    }
    return c.JSON(http.StatusOK, user)
}

func (h *Handler) Create(c echo.Context) error {
    var req CreateRequest
    if err := c.Bind(&req); err != nil {
        return echo.NewHTTPError(http.StatusBadRequest, err.Error())
    }
    if err := c.Validate(&req); err != nil {
        return err  // validator returns formatted error
    }

    user, err := h.service.Create(c.Request().Context(), req)
    if err != nil {
        return err
    }
    return c.JSON(http.StatusCreated, user)
}

func (h *Handler) Update(c echo.Context) error {
    id, err := strconv.ParseUint(c.Param("id"), 10, 64)
    if err != nil {
        return echo.NewHTTPError(http.StatusBadRequest, "invalid id")
    }

    var req UpdateRequest
    if err := c.Bind(&req); err != nil {
        return echo.NewHTTPError(http.StatusBadRequest, err.Error())
    }

    user, err := h.service.Update(c.Request().Context(), uint(id), req)
    if err != nil {
        return err
    }
    return c.JSON(http.StatusOK, user)
}

func (h *Handler) Delete(c echo.Context) error {
    id, err := strconv.ParseUint(c.Param("id"), 10, 64)
    if err != nil {
        return echo.NewHTTPError(http.StatusBadRequest, "invalid id")
    }

    if err := h.service.Delete(c.Request().Context(), uint(id)); err != nil {
        return err
    }
    return c.JSON(http.StatusOK, map[string]bool{"deleted": true})
}
```

## DTOs & Validation

```go
// internal/domain/users/dto.go
type CreateRequest struct {
    Name     string `json:"name" validate:"required,min=2,max=100"`
    Email    string `json:"email" validate:"required,email"`
    Password string `json:"password" validate:"required,min=8"`
    Role     string `json:"role" validate:"omitempty,oneof=user admin"`
}

type UpdateRequest struct {
    Name  *string `json:"name" validate:"omitempty,min=2,max=100"`
    Email *string `json:"email" validate:"omitempty,email"`
    Role  *string `json:"role" validate:"omitempty,oneof=user admin"`
}

type ListQuery struct {
    Page     int    `query:"page"`
    PageSize int    `query:"pageSize"`
    Search   string `query:"search"`
    Role     string `query:"role"`
}

func (q *ListQuery) SetDefaults() {
    if q.Page < 1 { q.Page = 1 }
    if q.PageSize < 1 || q.PageSize > 100 { q.PageSize = 20 }
}

type UserResponse struct {
    ID        uint      `json:"id"`
    Name      string    `json:"name"`
    Email     string    `json:"email"`
    Role      string    `json:"role"`
    CreatedAt time.Time `json:"createdAt"`
}
```

## Custom Validator

```go
// internal/middleware/validator.go
import "github.com/go-playground/validator/v10"

type CustomValidator struct {
    validator *validator.Validate
}

func NewValidator() *CustomValidator {
    return &CustomValidator{validator: validator.New()}
}

func (cv *CustomValidator) Validate(i interface{}) error {
    if err := cv.validator.Struct(i); err != nil {
        // Format validation errors
        var msgs []string
        for _, e := range err.(validator.ValidationErrors) {
            msgs = append(msgs, fmt.Sprintf("%s: %s", e.Field(), e.Tag()))
        }
        return echo.NewHTTPError(http.StatusBadRequest, map[string]any{
            "message": "validation failed",
            "errors":  msgs,
        })
    }
    return nil
}
```

## Error Handling Middleware

```go
// internal/middleware/error_handler.go
type AppError struct {
    Code    int    `json:"-"`
    Message string `json:"message"`
    Detail  string `json:"detail,omitempty"`
}

func (e *AppError) Error() string { return e.Message }

func NewNotFound(msg string) *AppError {
    return &AppError{Code: 404, Message: msg}
}

func NewConflict(msg string) *AppError {
    return &AppError{Code: 409, Message: msg}
}

func NewBadRequest(msg string) *AppError {
    return &AppError{Code: 400, Message: msg}
}

func ErrorHandler() echo.MiddlewareFunc {
    return func(next echo.HandlerFunc) echo.HandlerFunc {
        return func(c echo.Context) error {
            err := next(c)
            if err == nil { return nil }

            // Custom app error
            if appErr, ok := err.(*AppError); ok {
                return c.JSON(appErr.Code, map[string]any{
                    "success": false,
                    "message": appErr.Message,
                    "detail":  appErr.Detail,
                })
            }

            // Echo HTTP error
            if he, ok := err.(*echo.HTTPError); ok {
                return c.JSON(he.Code, map[string]any{
                    "success": false,
                    "message": he.Message,
                })
            }

            // Unknown error
            c.Logger().Error(err)
            return c.JSON(500, map[string]any{
                "success": false,
                "message": "internal server error",
            })
        }
    }
}
```

## JWT Authentication

```go
// internal/middleware/auth.go
import "github.com/golang-jwt/jwt/v5"

type JWTClaims struct {
    UserID uint   `json:"userId"`
    Email  string `json:"email"`
    Role   string `json:"role"`
    jwt.RegisteredClaims
}

func GenerateToken(user User, secret string) (string, error) {
    claims := JWTClaims{
        UserID: user.ID,
        Email:  user.Email,
        Role:   user.Role,
        RegisteredClaims: jwt.RegisteredClaims{
            ExpiresAt: jwt.NewNumericDate(time.Now().Add(24 * time.Hour)),
            IssuedAt:  jwt.NewNumericDate(time.Now()),
        },
    }
    token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
    return token.SignedString([]byte(secret))
}

func JWTAuth(secret string) echo.MiddlewareFunc {
    return func(next echo.HandlerFunc) echo.HandlerFunc {
        return func(c echo.Context) error {
            auth := c.Request().Header.Get("Authorization")
            if !strings.HasPrefix(auth, "Bearer ") {
                return echo.NewHTTPError(401, "missing token")
            }

            tokenStr := strings.TrimPrefix(auth, "Bearer ")
            claims := &JWTClaims{}
            token, err := jwt.ParseWithClaims(tokenStr, claims,
                func(t *jwt.Token) (interface{}, error) {
                    return []byte(secret), nil
                })

            if err != nil || !token.Valid {
                return echo.NewHTTPError(401, "invalid token")
            }

            c.Set("user", claims)
            return next(c)
        }
    }
}

func RequireRole(roles ...string) echo.MiddlewareFunc {
    return func(next echo.HandlerFunc) echo.HandlerFunc {
        return func(c echo.Context) error {
            claims := c.Get("user").(*JWTClaims)
            for _, r := range roles {
                if claims.Role == r { return next(c) }
            }
            return echo.NewHTTPError(403, "forbidden")
        }
    }
}

// Helper: get current user from context
func GetCurrentUser(c echo.Context) *JWTClaims {
    return c.Get("user").(*JWTClaims)
}
```

## Standard Response Helpers

```go
// internal/shared/response/response.go
type Response struct {
    Success bool   `json:"success"`
    Data    any    `json:"data,omitempty"`
    Message string `json:"message,omitempty"`
}

func OK(c echo.Context, data any) error {
    return c.JSON(200, Response{Success: true, Data: data})
}

func Created(c echo.Context, data any) error {
    return c.JSON(201, Response{Success: true, Data: data})
}

func Paginated[T any](c echo.Context, data []T, total int64, page, pageSize int) error {
    return c.JSON(200, map[string]any{
        "success":  true,
        "data":     data,
        "total":    total,
        "page":     page,
        "pageSize": pageSize,
    })
}
```

## Testing

```go
func TestListUsers(t *testing.T) {
    e := echo.New()
    e.Validator = middleware.NewValidator()

    req := httptest.NewRequest(http.MethodGet, "/api/v1/users?page=1&pageSize=10", nil)
    rec := httptest.NewRecorder()
    c := e.NewContext(req, rec)

    // Mock service
    svc := &MockService{
        ListFn: func(ctx context.Context, q ListQuery) (*PaginatedResponse[UserResponse], error) {
            return &PaginatedResponse[UserResponse]{
                Data: []UserResponse{{ID: 1, Name: "Test"}},
                Total: 1, Page: 1, PageSize: 10,
            }, nil
        },
    }
    h := NewHandler(svc)

    assert.NoError(t, h.List(c))
    assert.Equal(t, http.StatusOK, rec.Code)
}
```
