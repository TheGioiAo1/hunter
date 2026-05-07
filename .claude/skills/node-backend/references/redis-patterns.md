# Redis Patterns

## Connection (ioredis)

```typescript
// src/shared/redis/redis.module.ts
import Redis from 'ioredis'

@Global()
@Module({
  providers: [{
    provide: 'REDIS_CLIENT',
    useFactory: () => new Redis({
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379'),
      password: process.env.REDIS_PASSWORD,
      retryStrategy: (times) => Math.min(times * 50, 2000),
    }),
  }],
  exports: ['REDIS_CLIENT'],
})
export class RedisModule {}
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

## Caching Service

```typescript
@Injectable()
export class CacheService {
  constructor(@Inject('REDIS_CLIENT') private redis: Redis) {}

  async get<T>(key: string): Promise<T | null> {
    const data = await this.redis.get(key)
    return data ? JSON.parse(data) : null
  }

  async set(key: string, value: any, ttlSeconds = 3600): Promise<void> {
    await this.redis.set(key, JSON.stringify(value), 'EX', ttlSeconds)
  }

  async del(key: string): Promise<void> {
    await this.redis.del(key)
  }

  async delPattern(pattern: string): Promise<void> {
    const keys = await this.redis.keys(pattern)
    if (keys.length > 0) await this.redis.del(...keys)
  }
}
```

## Cache-Aside Pattern

```typescript
@Injectable()
export class ProductsService {
  constructor(
    private prisma: PrismaService,
    private cache: CacheService,
  ) {}

  async findOne(id: bigint) {
    const cacheKey = `cache:product:${id}`

    // Check cache first
    const cached = await this.cache.get<Product>(cacheKey)
    if (cached) return cached

    // Cache miss — query DB
    const product = await this.prisma.product.findUnique({ where: { id } })
    if (!product) throw new NotFoundException()

    // Store in cache (TTL 1 hour)
    await this.cache.set(cacheKey, product, 3600)
    return product
  }

  async update(id: bigint, dto: UpdateProductDto) {
    const product = await this.prisma.product.update({
      where: { id },
      data: dto,
    })

    // Invalidate cache
    await this.cache.del(`cache:product:${id}`)
    await this.cache.delPattern('cache:products:list:*')

    return product
  }
}
```

## Cache Interceptor

```typescript
@Injectable()
export class CacheInterceptor implements NestInterceptor {
  constructor(private cache: CacheService) {}

  async intercept(context: ExecutionContext, next: CallHandler) {
    const request = context.switchToHttp().getRequest()
    const cacheKey = `cache:${request.url}`

    const cached = await this.cache.get(cacheKey)
    if (cached) return of(cached)

    return next.handle().pipe(
      tap(data => this.cache.set(cacheKey, data, 300)),  // 5 min
    )
  }
}

// Usage: @UseInterceptors(CacheInterceptor)
```

## Rate Limiting

```typescript
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(@Inject('REDIS_CLIENT') private redis: Redis) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest()
    const key = `rate:limit:${request.ip}`
    const limit = 100  // requests per window
    const window = 60  // seconds

    const current = await this.redis.incr(key)
    if (current === 1) await this.redis.expire(key, window)

    if (current > limit) {
      throw new HttpException('Too Many Requests', 429)
    }
    return true
  }
}
```

## Pub/Sub

```typescript
// Publisher
@Injectable()
export class EventPublisher {
  constructor(@Inject('REDIS_CLIENT') private redis: Redis) {}

  async publish(channel: string, data: any): Promise<void> {
    await this.redis.publish(channel, JSON.stringify(data))
  }
}

// Subscriber (separate connection required)
@Injectable()
export class EventSubscriber implements OnModuleInit {
  private subscriber: Redis

  constructor(@Inject('REDIS_CLIENT') private redis: Redis) {
    this.subscriber = redis.duplicate()
  }

  async onModuleInit() {
    await this.subscriber.subscribe('order:created', 'user:registered')
    this.subscriber.on('message', (channel, message) => {
      const data = JSON.parse(message)
      this.handleEvent(channel, data)
    })
  }

  private handleEvent(channel: string, data: any) {
    switch (channel) {
      case 'order:created': /* handle */ break
      case 'user:registered': /* handle */ break
    }
  }
}
```

## Session Store

```typescript
// main.ts with express-session + connect-redis
import RedisStore from 'connect-redis'
import session from 'express-session'
import Redis from 'ioredis'

const redis = new Redis()
app.use(session({
  store: new RedisStore({ client: redis, prefix: 'sess:' }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 },  // 1 day
}))
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
