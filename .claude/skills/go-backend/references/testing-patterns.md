# Go Backend Testing Patterns (stdlib testing + testify + httptest + Echo/Gin + GORM)

## File layout

```
internal/
  users/
    service.go
    service_test.go          # unit — colocated, same package for whitebox
    service_external_test.go # blackbox — `package users_test`
    handler.go
    handler_test.go
test/
  integration/
    auth_flow_test.go        # build tag: //go:build integration
  e2e/
    api_e2e_test.go          # build tag: //go:build e2e
  fixtures/
    user.go
```

## Naming & conventions

- Files end with `_test.go`
- Functions: `TestFoo(t *testing.T)`, benchmarks `BenchmarkFoo`, examples `ExampleFoo`
- Table-driven tests are idiomatic — named subtests via `t.Run(name, ...)`
- Build tags to separate fast/slow: `//go:build integration`

Run: `go test ./...`, `go test -run TestLogin ./internal/auth`, `go test -tags=integration ./test/...`, `go test -cover`.

## Table-driven pattern (canonical)

```go
func TestValidateEmail(t *testing.T) {
    cases := []struct {
        name    string
        input   string
        wantErr bool
    }{
        {"valid", "a@b.com", false},
        {"empty", "", true},
        {"missing @", "abc", true},
        {"too long", strings.Repeat("a", 255) + "@b.com", true},
        {"unicode", "ñ@b.com", false},
    }
    for _, tc := range cases {
        t.Run(tc.name, func(t *testing.T) {
            err := ValidateEmail(tc.input)
            if (err != nil) != tc.wantErr {
                t.Errorf("ValidateEmail(%q) err = %v, wantErr %v", tc.input, err, tc.wantErr)
            }
        })
    }
}
```

## testify/assert + require

```go
import (
    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"
)

func TestRegisterHashesPassword(t *testing.T) {
    repo := &mockUserRepo{}
    svc := NewUsersService(repo)

    user, err := svc.Register(ctx, "a@b.com", "plain")

    require.NoError(t, err)         // require fails fast
    assert.NotEqual(t, "plain", user.Password)
    assert.True(t, strings.HasPrefix(user.Password, "$2a$"))
}
```

Use `require` when subsequent assertions depend on the result. Use `assert` for independent checks.

## Mocking — handwritten > gomock

Go favors small interfaces. Handwritten fakes are usually clearer:

```go
type mockUserRepo struct {
    findByEmail func(ctx context.Context, email string) (*User, error)
    create      func(ctx context.Context, u *User) error
}

func (m *mockUserRepo) FindByEmail(ctx context.Context, email string) (*User, error) {
    return m.findByEmail(ctx, email)
}
func (m *mockUserRepo) Create(ctx context.Context, u *User) error {
    return m.create(ctx, u)
}
```

For large interfaces, use `mockery` or `go generate`:

```go
//go:generate mockery --name=UserRepo --output=./mocks
```

## HTTP handlers — httptest

```go
func TestLoginHandler_WrongPassword(t *testing.T) {
    e := echo.New()
    req := httptest.NewRequest(http.MethodPost, "/auth/login",
        strings.NewReader(`{"email":"a@b.com","password":"wrong"}`))
    req.Header.Set("Content-Type", "application/json")
    rec := httptest.NewRecorder()
    c := e.NewContext(req, rec)

    svc := &mockAuthSvc{
        login: func(ctx context.Context, email, pw string) (string, error) {
            return "", ErrInvalidCredentials
        },
    }
    h := NewAuthHandler(svc)

    require.NoError(t, h.Login(c))
    assert.Equal(t, http.StatusUnauthorized, rec.Code)
}
```

## Integration — real DB via build tags

```go
//go:build integration

package auth_test

func TestLoginFlow_Integration(t *testing.T) {
    db := setupTestDB(t)           // docker-compose postgres or testcontainers
    t.Cleanup(func() { db.Exec("TRUNCATE users CASCADE") })
    // ... run real flow
}
```

For DB:
- **testcontainers-go** — spin up real Postgres/MySQL per test, best fidelity
- **dockertest** — similar, lighter
- **in-memory SQLite with GORM** — fastest but may mask dialect-specific bugs

## GORM testing

```go
func setupTestDB(t *testing.T) *gorm.DB {
    t.Helper()
    db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
    require.NoError(t, err)
    require.NoError(t, db.AutoMigrate(&User{}))
    return db
}

// Transaction rollback pattern
func withTx(t *testing.T, db *gorm.DB, fn func(tx *gorm.DB)) {
    tx := db.Begin()
    t.Cleanup(func() { tx.Rollback() })
    fn(tx)
}
```

## Parallelism

```go
func TestFoo(t *testing.T) {
    t.Parallel()                   // allow concurrent with sibling tests
    for _, tc := range cases {
        tc := tc                   // capture loop var (pre-Go 1.22)
        t.Run(tc.name, func(t *testing.T) {
            t.Parallel()
            // ...
        })
    }
}
```

Tests that share global state or DB rows MUST NOT call `t.Parallel()`.

## Context & timeouts

```go
func TestWithTimeout(t *testing.T) {
    ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
    defer cancel()
    err := svc.LongCall(ctx)
    require.ErrorIs(t, err, context.DeadlineExceeded)
}
```

## Golden files

```go
got := renderReport(data)
golden := filepath.Join("testdata", "report.golden")
if *update {                       // `go test -update`
    os.WriteFile(golden, got, 0644)
}
want, _ := os.ReadFile(golden)
if !bytes.Equal(got, want) {
    t.Errorf("mismatch:\n%s", cmp.Diff(string(want), string(got)))
}
```

## Error path coverage

Per handler / service:
- Happy path
- Invalid JSON body (400)
- Validation (e.g. empty email) (400/422)
- Auth missing / invalid (401)
- Forbidden role (403)
- Not found (404)
- Conflict (409)
- Upstream DB error → 500 propagation
- Context cancellation

## Coverage priorities

1. **Critical path**: auth, billing, permissions, migrations → 90%+ lines
2. **Business logic** (services / domain) → 80%+
3. **Handlers** → happy + 2-3 errors, don't chase 100%
4. **Simple DTOs / structs** → skip
5. **main.go / wiring** → skip

## Common pitfalls

- Forgetting `t.Parallel()` capture of loop var in pre-1.22 Go
- `time.Now()` — inject a clock interface, don't call directly
- `math/rand` — seed deterministically or inject
- Leaking goroutines — use `goleak.VerifyNone(t)`
- Port conflicts in integration tests — let httptest pick (`:0`)
- Not calling `t.Cleanup` / `defer` for resource teardown
- Comparing with `==` on structs containing slices/maps → use `reflect.DeepEqual` or `cmp.Diff`
