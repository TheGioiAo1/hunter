# GORM Patterns

## Connection

```go
// internal/shared/database/database.go
import (
    "gorm.io/driver/postgres"
    "gorm.io/gorm"
    "gorm.io/gorm/logger"
)

func Connect(cfg *config.Config) *gorm.DB {
    dsn := fmt.Sprintf(
        "host=%s port=%s user=%s password=%s dbname=%s sslmode=disable",
        cfg.DBHost, cfg.DBPort, cfg.DBUser, cfg.DBPassword, cfg.DBName,
    )

    db, err := gorm.Open(postgres.Open(dsn), &gorm.Config{
        Logger: logger.Default.LogMode(logger.Info),
        NamingStrategy: schema.NamingStrategy{
            TablePrefix:   "",
            SingularTable: false,  // users, not user
        },
    })
    if err != nil {
        log.Fatal("failed to connect database:", err)
    }

    // Connection pool
    sqlDB, _ := db.DB()
    sqlDB.SetMaxIdleConns(10)
    sqlDB.SetMaxOpenConns(100)
    sqlDB.SetConnMaxLifetime(time.Hour)

    return db
}

// Auto-migrate (dev only)
func Migrate(db *gorm.DB) {
    db.AutoMigrate(&User{}, &Post{}, &Comment{})
}
```

## Model Definition

```go
// internal/domain/users/model.go
type User struct {
    ID        uint           `gorm:"primarykey" json:"id"`
    Name      string         `gorm:"size:100;not null" json:"name"`
    Email     string         `gorm:"uniqueIndex;size:255;not null" json:"email"`
    Password  string         `gorm:"size:255;not null" json:"-"`
    Role      string         `gorm:"size:20;default:user" json:"role"`
    AvatarURL *string        `gorm:"size:500" json:"avatarUrl,omitempty"`
    IsActive  bool           `gorm:"default:true" json:"isActive"`
    CreatedAt time.Time      `json:"createdAt"`
    UpdatedAt time.Time      `json:"updatedAt"`
    DeletedAt gorm.DeletedAt `gorm:"index" json:"-"`  // Soft delete

    // Relations
    Posts    []Post    `gorm:"foreignKey:AuthorID" json:"posts,omitempty"`
    Profile  *Profile  `gorm:"foreignKey:UserID" json:"profile,omitempty"`
}

func (User) TableName() string { return "users" }

// Hooks
func (u *User) BeforeCreate(tx *gorm.DB) error {
    hashed, err := bcrypt.GenerateFromPassword([]byte(u.Password), bcrypt.DefaultCost)
    if err != nil { return err }
    u.Password = string(hashed)
    return nil
}
```

## Repository Pattern

```go
// internal/domain/users/repository.go
type Repository interface {
    FindAll(ctx context.Context, q ListQuery) ([]User, int64, error)
    FindByID(ctx context.Context, id uint) (*User, error)
    FindByEmail(ctx context.Context, email string) (*User, error)
    Create(ctx context.Context, user *User) error
    Update(ctx context.Context, user *User) error
    Delete(ctx context.Context, id uint) error
}

type repository struct {
    db *gorm.DB
}

func NewRepository(db *gorm.DB) Repository {
    return &repository{db: db}
}

func (r *repository) FindAll(ctx context.Context, q ListQuery) ([]User, int64, error) {
    var users []User
    var total int64

    tx := r.db.WithContext(ctx).Model(&User{})

    // Filters
    if q.Search != "" {
        tx = tx.Where("name ILIKE ? OR email ILIKE ?",
            "%"+q.Search+"%", "%"+q.Search+"%")
    }
    if q.Role != "" {
        tx = tx.Where("role = ?", q.Role)
    }

    // Count + Fetch in parallel concept (sequential in Go)
    if err := tx.Count(&total).Error; err != nil {
        return nil, 0, fmt.Errorf("count users: %w", err)
    }

    offset := (q.Page - 1) * q.PageSize
    if err := tx.Order("created_at DESC").
        Offset(offset).Limit(q.PageSize).
        Find(&users).Error; err != nil {
        return nil, 0, fmt.Errorf("find users: %w", err)
    }

    return users, total, nil
}

func (r *repository) FindByID(ctx context.Context, id uint) (*User, error) {
    var user User
    if err := r.db.WithContext(ctx).First(&user, id).Error; err != nil {
        if errors.Is(err, gorm.ErrRecordNotFound) {
            return nil, nil
        }
        return nil, fmt.Errorf("find user %d: %w", id, err)
    }
    return &user, nil
}

func (r *repository) FindByEmail(ctx context.Context, email string) (*User, error) {
    var user User
    if err := r.db.WithContext(ctx).Where("email = ?", email).First(&user).Error; err != nil {
        if errors.Is(err, gorm.ErrRecordNotFound) {
            return nil, nil
        }
        return nil, fmt.Errorf("find user by email: %w", err)
    }
    return &user, nil
}

func (r *repository) Create(ctx context.Context, user *User) error {
    if err := r.db.WithContext(ctx).Create(user).Error; err != nil {
        if isDuplicateKeyError(err) {
            return NewConflict("email already exists")
        }
        return fmt.Errorf("create user: %w", err)
    }
    return nil
}

func (r *repository) Update(ctx context.Context, user *User) error {
    if err := r.db.WithContext(ctx).Save(user).Error; err != nil {
        return fmt.Errorf("update user: %w", err)
    }
    return nil
}

func (r *repository) Delete(ctx context.Context, id uint) error {
    result := r.db.WithContext(ctx).Delete(&User{}, id)
    if result.Error != nil {
        return fmt.Errorf("delete user %d: %w", id, result.Error)
    }
    if result.RowsAffected == 0 {
        return NewNotFound("user not found")
    }
    return nil
}

// Detect duplicate key (Postgres error code 23505)
func isDuplicateKeyError(err error) bool {
    return strings.Contains(err.Error(), "23505") ||
        strings.Contains(err.Error(), "duplicate key")
}
```

## Service Pattern

```go
// internal/domain/users/service.go
type Service struct {
    repo Repository
}

func NewService(repo Repository) *Service {
    return &Service{repo: repo}
}

func (s *Service) List(ctx context.Context, q ListQuery) (*PaginatedResponse[UserResponse], error) {
    users, total, err := s.repo.FindAll(ctx, q)
    if err != nil {
        return nil, fmt.Errorf("list users: %w", err)
    }

    responses := make([]UserResponse, len(users))
    for i, u := range users {
        responses[i] = toUserResponse(u)
    }

    return &PaginatedResponse[UserResponse]{
        Data: responses, Total: total,
        Page: q.Page, PageSize: q.PageSize,
    }, nil
}

func (s *Service) GetByID(ctx context.Context, id uint) (*UserResponse, error) {
    user, err := s.repo.FindByID(ctx, id)
    if err != nil {
        return nil, err
    }
    if user == nil {
        return nil, NewNotFound("user not found")
    }
    resp := toUserResponse(*user)
    return &resp, nil
}

func toUserResponse(u User) UserResponse {
    return UserResponse{
        ID: u.ID, Name: u.Name, Email: u.Email,
        Role: u.Role, CreatedAt: u.CreatedAt,
    }
}
```

## Relations

```go
// Has One
type Profile struct {
    ID     uint   `gorm:"primarykey"`
    UserID uint   `gorm:"uniqueIndex"`
    Bio    string `gorm:"size:500"`
    User   User
}

// Has Many
type Post struct {
    ID       uint   `gorm:"primarykey"`
    Title    string `gorm:"size:255;not null"`
    AuthorID uint   `gorm:"index"`
    Author   User   `gorm:"foreignKey:AuthorID"`
}

// Many to Many
type Tag struct {
    ID    uint   `gorm:"primarykey"`
    Name  string `gorm:"uniqueIndex;size:50"`
    Posts []Post `gorm:"many2many:post_tags;"`
}

// Preload relations
db.Preload("Posts", func(db *gorm.DB) *gorm.DB {
    return db.Where("published = ?", true).Order("created_at DESC").Limit(10)
}).First(&user, id)

// Nested preload
db.Preload("Posts.Tags").Preload("Profile").First(&user, id)

// Joins (more efficient for single relations)
db.Joins("Profile").First(&user, id)
```

## Scopes (Reusable Query Logic)

```go
// Pagination scope
func Paginate(page, pageSize int) func(db *gorm.DB) *gorm.DB {
    return func(db *gorm.DB) *gorm.DB {
        offset := (page - 1) * pageSize
        return db.Offset(offset).Limit(pageSize)
    }
}

// Active scope
func Active(db *gorm.DB) *gorm.DB {
    return db.Where("is_active = ?", true)
}

// Search scope
func Search(field, keyword string) func(db *gorm.DB) *gorm.DB {
    return func(db *gorm.DB) *gorm.DB {
        if keyword == "" { return db }
        return db.Where(field+" ILIKE ?", "%"+keyword+"%")
    }
}

// Usage
db.Scopes(Active, Paginate(1, 20), Search("name", "john")).Find(&users)
```

## Transactions

```go
// Simple transaction
err := db.Transaction(func(tx *gorm.DB) error {
    order := Order{UserID: userID, Total: total}
    if err := tx.Create(&order).Error; err != nil {
        return err
    }

    for _, item := range items {
        item.OrderID = order.ID
        if err := tx.Create(&item).Error; err != nil {
            return err  // auto rollback
        }
    }

    // Decrement stock
    if err := tx.Model(&Product{}).
        Where("id IN ?", productIDs).
        UpdateColumn("stock", gorm.Expr("stock - ?", 1)).Error; err != nil {
        return err
    }

    return nil  // auto commit
})

// Manual transaction (more control)
tx := db.Begin()
defer func() {
    if r := recover(); r != nil {
        tx.Rollback()
    }
}()

if err := tx.Create(&order).Error; err != nil {
    tx.Rollback()
    return err
}
// ... more operations
tx.Commit()
```

## Bulk Operations

```go
// Bulk create
users := []User{{Name: "A"}, {Name: "B"}, {Name: "C"}}
db.CreateInBatches(users, 100)  // batch size 100

// Bulk update
db.Model(&User{}).Where("role = ?", "guest").Updates(map[string]any{
    "role": "user",
    "updated_at": time.Now(),
})

// Bulk delete
db.Where("id IN ?", ids).Delete(&User{})

// Upsert
db.Clauses(clause.OnConflict{
    Columns:   []clause.Column{{Name: "email"}},
    DoUpdates: clause.AssignmentColumns([]string{"name", "updated_at"}),
}).Create(&users)
```

## Raw SQL

```go
// Raw query
var results []struct {
    Role  string
    Count int64
}
db.Raw("SELECT role, COUNT(*) as count FROM users GROUP BY role").Scan(&results)

// Raw exec
db.Exec("UPDATE users SET role = ? WHERE created_at < ?", "veteran", cutoffDate)
```

## Migration (Production)

```bash
# Install migrate CLI
go install -tags 'postgres' github.com/golang-migrate/migrate/v4/cmd/migrate@latest

# Create migration
migrate create -ext sql -dir migrations -seq add_user_avatar

# Apply
migrate -path migrations -database "postgres://user:pass@localhost:5432/db?sslmode=disable" up

# Rollback
migrate -path migrations -database "..." down 1
```

```sql
-- migrations/000001_create_users.up.sql
CREATE TABLE users (
    id BIGSERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    email VARCHAR(255) NOT NULL UNIQUE,
    password VARCHAR(255) NOT NULL,
    role VARCHAR(20) DEFAULT 'user',
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);
CREATE INDEX idx_users_deleted_at ON users(deleted_at);

-- migrations/000001_create_users.down.sql
DROP TABLE IF EXISTS users;
```

## Performance Tips

- `db.Session(&gorm.Session{PrepareStmt: true})` — prepared statements, ~20% faster
- `.Select("id, name, email")` — only fetch needed fields
- `.Joins()` instead of `.Preload()` when only 1 relation needed
- Index frequently queried fields: `gorm:"index"`
- `CreateInBatches` for bulk insert
- Use `map[string]any` with `Updates()` to only update fields with values
- `gorm.Expr()` for atomic operations: `stock - 1`, `views + 1`
