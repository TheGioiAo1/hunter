# Redis Patterns (Go)

## Connection (go-redis)

```go
// internal/shared/redis/redis.go
import "github.com/redis/go-redis/v9"

func NewClient(cfg *config.Config) *redis.Client {
    return redis.NewClient(&redis.Options{
        Addr:         cfg.RedisHost + ":" + cfg.RedisPort,
        Password:     cfg.RedisPassword,
        DB:           0,
        DialTimeout:  5 * time.Second,
        ReadTimeout:  3 * time.Second,
        WriteTimeout: 3 * time.Second,
        PoolSize:     10,
        MinIdleConns: 5,
    })
}

// Health check
func Ping(ctx context.Context, rdb *redis.Client) error {
    return rdb.Ping(ctx).Err()
}
```

## Key Naming Convention

```
{module}:{entity}:{id}
{module}:{entity}:{id}:{sub}

# Examples
user:profile:123
user:session:abc-def
auth:otp:user@email.com
cache:products:list:page-1
rate:limit:ip:192.168.1.1
```

## Cache Service

```go
type CacheService struct {
    rdb *redis.Client
}

func NewCacheService(rdb *redis.Client) *CacheService {
    return &CacheService{rdb: rdb}
}

func (c *CacheService) Get(ctx context.Context, key string, dest any) error {
    val, err := c.rdb.Get(ctx, key).Result()
    if err == redis.Nil {
        return ErrCacheMiss
    }
    if err != nil {
        return fmt.Errorf("cache get %s: %w", key, err)
    }
    return json.Unmarshal([]byte(val), dest)
}

func (c *CacheService) Set(ctx context.Context, key string, value any, ttl time.Duration) error {
    data, err := json.Marshal(value)
    if err != nil {
        return fmt.Errorf("cache marshal: %w", err)
    }
    return c.rdb.Set(ctx, key, data, ttl).Err()
}

func (c *CacheService) Del(ctx context.Context, keys ...string) error {
    return c.rdb.Del(ctx, keys...).Err()
}

func (c *CacheService) DelPattern(ctx context.Context, pattern string) error {
    iter := c.rdb.Scan(ctx, 0, pattern, 100).Iterator()
    var keys []string
    for iter.Next(ctx) {
        keys = append(keys, iter.Val())
    }
    if len(keys) > 0 {
        return c.rdb.Del(ctx, keys...).Err()
    }
    return nil
}

var ErrCacheMiss = errors.New("cache miss")
```

## Cache-Aside Pattern

```go
func (s *Service) GetByID(ctx context.Context, id uint) (*Product, error) {
    cacheKey := fmt.Sprintf("cache:product:%d", id)

    // Check cache
    var product Product
    if err := s.cache.Get(ctx, cacheKey, &product); err == nil {
        return &product, nil  // Cache hit
    }

    // Cache miss — query DB
    dbProduct, err := s.repo.FindByID(ctx, id)
    if err != nil {
        return nil, err
    }
    if dbProduct == nil {
        return nil, NewNotFound("product not found")
    }

    // Store in cache (1 hour)
    s.cache.Set(ctx, cacheKey, dbProduct, time.Hour)
    return dbProduct, nil
}

func (s *Service) Update(ctx context.Context, id uint, dto UpdateProductDTO) (*Product, error) {
    product, err := s.repo.Update(ctx, id, dto)
    if err != nil {
        return nil, err
    }

    // Invalidate cache
    s.cache.Del(ctx, fmt.Sprintf("cache:product:%d", id))
    s.cache.DelPattern(ctx, "cache:products:list:*")

    return product, nil
}
```

## Rate Limiting Middleware

```go
func RateLimit(rdb *redis.Client, limit int, window time.Duration) echo.MiddlewareFunc {
    return func(next echo.HandlerFunc) echo.HandlerFunc {
        return func(c echo.Context) error {
            key := fmt.Sprintf("rate:limit:%s", c.RealIP())
            ctx := c.Request().Context()

            current, err := rdb.Incr(ctx, key).Result()
            if err != nil {
                return next(c)  // Fail open
            }

            if current == 1 {
                rdb.Expire(ctx, key, window)
            }

            // Set rate limit headers
            c.Response().Header().Set("X-RateLimit-Limit", strconv.Itoa(limit))
            c.Response().Header().Set("X-RateLimit-Remaining",
                strconv.Itoa(max(0, limit-int(current))))

            if int(current) > limit {
                return echo.NewHTTPError(429, "too many requests")
            }
            return next(c)
        }
    }
}

// Usage
api.Use(RateLimit(rdb, 100, time.Minute))  // 100 req/min
```

## Pub/Sub

```go
// Publisher
type EventPublisher struct {
    rdb *redis.Client
}

func (p *EventPublisher) Publish(ctx context.Context, channel string, data any) error {
    payload, err := json.Marshal(data)
    if err != nil {
        return err
    }
    return p.rdb.Publish(ctx, channel, payload).Err()
}

// Subscriber
type EventSubscriber struct {
    rdb *redis.Client
}

func (s *EventSubscriber) Subscribe(ctx context.Context, channels ...string) {
    sub := s.rdb.Subscribe(ctx, channels...)
    ch := sub.Channel()

    go func() {
        for msg := range ch {
            switch msg.Channel {
            case "order:created":
                var order Order
                json.Unmarshal([]byte(msg.Payload), &order)
                s.handleOrderCreated(order)
            case "user:registered":
                var user User
                json.Unmarshal([]byte(msg.Payload), &user)
                s.handleUserRegistered(user)
            }
        }
    }()
}
```

## Distributed Lock

```go
func (c *CacheService) AcquireLock(ctx context.Context, key string, ttl time.Duration) (bool, error) {
    return c.rdb.SetNX(ctx, "lock:"+key, "1", ttl).Result()
}

func (c *CacheService) ReleaseLock(ctx context.Context, key string) error {
    return c.rdb.Del(ctx, "lock:"+key).Err()
}

// Usage
func (s *Service) ProcessOrder(ctx context.Context, orderID uint) error {
    lockKey := fmt.Sprintf("order:%d", orderID)
    acquired, err := s.cache.AcquireLock(ctx, lockKey, 30*time.Second)
    if err != nil || !acquired {
        return errors.New("order is being processed")
    }
    defer s.cache.ReleaseLock(ctx, lockKey)

    // ... process order safely
    return nil
}
```

## Session Store

```go
// Simple session with Redis
func SetSession(ctx context.Context, rdb *redis.Client, sessionID string, data map[string]any) error {
    payload, _ := json.Marshal(data)
    return rdb.Set(ctx, "sess:"+sessionID, payload, 24*time.Hour).Err()
}

func GetSession(ctx context.Context, rdb *redis.Client, sessionID string) (map[string]any, error) {
    val, err := rdb.Get(ctx, "sess:"+sessionID).Result()
    if err == redis.Nil {
        return nil, nil
    }
    var data map[string]any
    json.Unmarshal([]byte(val), &data)
    return data, nil
}
```

## TTL Guidelines

| Use case | TTL |
|----------|-----|
| User session | 24h |
| OTP/verification | 5-15 min |
| API response cache | 5-60 min |
| Product catalog | 1-6h |
| Rate limit counter | 1 min |
| Feature flags | 5 min |
| Distributed lock | 10-30s |
