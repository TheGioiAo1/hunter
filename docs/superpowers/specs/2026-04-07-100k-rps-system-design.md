# Gbox Platform — Thiet Ke He Thong Chiu Tai 100,000 RPS

> **Muc tieu:** 100,000 request/giay (RPS) across all data flows
> **Ngay:** 2026-04-07
> **Trang thai:** Ke hoach chi tiet, chua trien khai

---

## 1. PHAN TICH HIEN TRANG (Current State Analysis)

### 1.1 Kien Truc Hien Tai

```
                    [Internet]
                        |
                    [Nginx :80]
                        |
            +-----------+-----------+
            |           |           |
     [Platform API] [Accounts] [God Admin] [Store Admin]
      :4321          :4323      :4324       :4325
      (1 process)   (1 process) (1 process) (1 process)
            |           |           |           |
            +-----+-----+-----------+-----------+
                  |
          [PostgreSQL :5432]
          (max_connections=100)
          (pool_size=20 per app)
```

### 1.2 Bottleneck Map — Tai Sao KHONG Chiu Duoc 100K RPS

| Bottleneck | Hien Tai | Gioi Han Thuc Te | Ly Do |
|------------|----------|-------------------|-------|
| **Node.js single process** | 1 process/server | ~2,000-5,000 RPS | Event loop chi co 1 thread. CPU-bound tasks (crypto, JSON parse) block het |
| **PostgreSQL pool** | 20 connections/app | ~800-1,500 queries/s | Moi query trung binh 10-50ms. 20 conn x 50 query/s = 1,000 QPS max |
| **PostgreSQL total** | max_connections=100 | ~5,000 QPS | Default PostgreSQL, khong co PgBouncer |
| **In-memory rate limit** | Per-process Map | Vo nghia khi scale | Moi process dem rieng, user bypass bang cach hit process khac |
| **In-memory checkout** | Per-process Map | Mat data khi restart | Server crash = mat het checkout session |
| **In-memory CSRF** | Per-process Map | Khong share duoc | User tao CSRF o process 1, submit o process 2 → fail |
| **In-memory OTP** | Per-process Map | Khong share duoc | OTP verify fail across processes |
| **Nginx single upstream** | proxy_pass :4321 | ~10,000 RPS | Khong co load balancing, khong upstream pool |
| **Khong co cache layer** | Query DB moi request | N/A | Moi GET request hit DB truc tiep |
| **Khong co CDN** | Nginx serve static | ~5,000 RPS static | Static files qua Nginx → Node → cham |
| **Khong co compression (Express)** | Gzip chi o Nginx | Bandwidth waste | Response 50KB thay vi 10KB |
| **Sync crypto** | createHash, randomBytes | Block event loop | 10,000 hash/s thi 10ms/hash = 100ms block |
| **N+1 queries** | Loop + await | O(N) queries | Fulfillment N items = 2N queries |
| **Console.log** | 100+ cho | Sync I/O block | Moi console.log block ~0.1ms, 100K RPS = 10s block/s |

### 1.3 Uoc Tinh Throughput Hien Tai

```
Node.js (1 process, mixed workload):     ~1,500 RPS
PostgreSQL (20 pool, no cache):           ~1,000 QPS
Nginx (single upstream, no cache):        ~8,000 RPS
---
ACTUAL SYSTEM THROUGHPUT:                 ~1,000 RPS (bottleneck: DB)
```

**Ket luan:** He thong hien tai chiu duoc ~1,000 RPS. Can tang **100x** de dat 100,000 RPS.

---

## 2. KIEN TRUC MUC TIEU (Target Architecture)

### 2.1 Tong Quan

```
                         [Cloudflare CDN]
                         (Cache static, DDoS protection, edge cache API)
                              |
                    [Nginx Load Balancer]
                    (upstream pool, keepalive, cache)
                              |
            +---------+-------+-------+---------+
            |         |       |       |         |
      [Platform   [Platform  ...  [Platform  [Platform
       API x1]     API x2]        API xN]    API xN+1]
       :4321       :4322          :432N
            |         |       |       |         |
            +----+----+---+---+----+--+---------+
                 |         |        |
          [PgBouncer]  [Redis     [Redis
           :6432        Cluster]   Sentinel]
              |          :6379     :26379
        [PostgreSQL     (Cache,    (HA failover)
         Primary]       Sessions,
          :5432         Rate Limit,
              |         Checkout,
        [PostgreSQL     Pub/Sub)
         Replica x2]
          :5433,:5434
```

### 2.2 Request Flow (100K RPS)

```
Request → Cloudflare (50% cached = 50K RPS never hits server)
       → Nginx LB (remaining 50K RPS)
       → Round-robin to N Node processes
       → Redis check (session, rate limit, cache)
       → PostgreSQL (only cache-miss queries)
       → Response → Nginx → Cloudflare → Client
```

**Phan bo tai muc tieu:**

| Layer | Xu ly | RPS |
|-------|-------|-----|
| Cloudflare CDN | Static assets, cached API | 50,000 |
| Nginx cache | Cached HTML pages | 15,000 |
| Redis cache | Session, rate limit, hot data | 25,000 |
| PostgreSQL | Only write + cache miss | 10,000 |
| **Tong** | | **100,000** |

---

## 3. KE HOACH TRIEN KHAI CHI TIET

### PHASE 1: Redis Foundation (Uu tien CAO NHAT)

**Ly do:** Moi bottleneck lon nhat deu lien quan den in-memory state khong scale duoc. Redis giai quyet 5 van de cung luc: session sharing, rate limiting, checkout persistence, CSRF, va cache.

#### Step 1.1: Cai Dat Redis

```bash
# Tren server 192.168.1.13
sudo apt install redis-server -y
sudo systemctl enable redis-server

# Config: /etc/redis/redis.conf
maxmemory 512mb
maxmemory-policy allkeys-lru
save 60 1000          # RDB snapshot moi 60s neu 1000 key thay doi
appendonly yes         # AOF persistence
tcp-keepalive 300
```

**Ly do chon Redis:**
- Latency: 0.1-0.5ms/operation (vs PostgreSQL 5-50ms)
- Throughput: 100,000+ operations/s single instance
- Data structures: String (cache), Hash (sessions), Sorted Set (rate limit), List (queue)
- TTL built-in: Automatic expiry, khong can cleanup timer
- Pub/Sub: Cross-process communication

#### Step 1.2: Tao Redis Client Module

**File:** `packages/core/src/modules/cache/redis.ts`

```typescript
import { createClient, type RedisClientType } from 'redis'

let client: RedisClientType | null = null

export async function getRedis(): Promise<RedisClientType> {
  if (!client) {
    client = createClient({
      url: process.env.REDIS_URL || 'redis://localhost:6379',
      socket: {
        reconnectStrategy: (retries) => Math.min(retries * 100, 5000),
        connectTimeout: 5000,
        keepAlive: 30000,
      },
    })
    client.on('error', (err) => console.error('[Redis]', err))
    await client.connect()
  }
  return client
}

// Cache helpers with automatic serialization
export async function cacheGet<T>(key: string): Promise<T | null> {
  const redis = await getRedis()
  const val = await redis.get(key)
  return val ? JSON.parse(val) : null
}

export async function cacheSet(key: string, value: any, ttlSeconds: number): Promise<void> {
  const redis = await getRedis()
  await redis.set(key, JSON.stringify(value), { EX: ttlSeconds })
}

export async function cacheDel(key: string): Promise<void> {
  const redis = await getRedis()
  await redis.del(key)
}

export async function cacheDelPattern(pattern: string): Promise<void> {
  const redis = await getRedis()
  const keys = await redis.keys(pattern)
  if (keys.length > 0) await redis.del(keys)
}
```

#### Step 1.3: Migrate Rate Limiting to Redis

**Tai sao:** In-memory rate limit chi hoat dong voi 1 process. 100K RPS can nhieu process.

**File:** `packages/core/src/modules/security/rate-limit.ts` (cap nhat)

```typescript
import RedisStore from 'rate-limit-redis'
import { getRedis } from '../cache/redis.js'

export function createRateLimiter(config: RateLimitConfig) {
  return rateLimit({
    windowMs: config.windowMs,
    max: config.max,
    standardHeaders: true,
    legacyHeaders: false,
    // Redis store thay cho MemoryStore
    store: new RedisStore({
      sendCommand: async (...args: string[]) => {
        const redis = await getRedis()
        return redis.sendCommand(args)
      },
      prefix: 'rl:',
    }),
    keyGenerator: config.keyGenerator || ((req) => req.ip || '127.0.0.1'),
  })
}
```

**Hieu qua:** Rate limit chinh xac across tat ca processes. 1 user bi limit = bi limit tren MOI process.

#### Step 1.4: Migrate Session Validation to Redis Cache

**Tai sao:** Moi request deu validate session (query DB). 100K RPS = 100K queries/s chi de check session.

```typescript
// packages/core/src/modules/auth/session.ts — cap nhat validateSession

export async function validateSession(db: Kysely<Database>, token: string) {
  const tokenHash = hashToken(token)
  const cacheKey = `session:${tokenHash}`

  // Check Redis first (0.1ms vs 10ms DB)
  const cached = await cacheGet<SessionData>(cacheKey)
  if (cached) {
    if (new Date(cached.expires_at) < new Date()) {
      await cacheDel(cacheKey)
      return { valid: false }
    }
    return { valid: true, session: cached }
  }

  // Cache miss → query DB
  const session = await db.selectFrom('sessions')
    .innerJoin('users', 'users.id', 'sessions.user_id')
    .select([...])
    .where('sessions.token_hash', '=', tokenHash)
    .executeTakeFirst()

  if (!session) return { valid: false }

  // Cache for 5 minutes (reduces DB load 99%)
  await cacheSet(cacheKey, session, 300)
  return { valid: true, session }
}
```

**Hieu qua:** 99% session lookups tu Redis (0.1ms) thay vi PostgreSQL (10ms). Giam 99% session queries.

#### Step 1.5: Migrate Checkout Sessions to Redis

**Tai sao:** In-memory Map mat data khi restart. Redis co persistence.

```typescript
// packages/core/src/modules/checkout/service.ts — thay Map bang Redis

const CHECKOUT_TTL = 3600 // 1 hour

export async function createCheckout(db, shopId, items, email?) {
  const id = `chk_${Date.now().toString(36)}_${randomId()}`
  const session: CheckoutSession = { id, shop_id: shopId, ... }

  await cacheSet(`checkout:${id}`, session, CHECKOUT_TTL)
  return session
}

export async function getCheckout(checkoutId: string) {
  return cacheGet<CheckoutSession>(`checkout:${checkoutId}`)
}

export async function updateCheckout(checkoutId: string, updates: Partial<CheckoutSession>) {
  const session = await getCheckout(checkoutId)
  if (!session) throw new Error('Checkout not found')
  const updated = { ...session, ...updates, updated_at: new Date().toISOString() }
  await cacheSet(`checkout:${checkoutId}`, updated, CHECKOUT_TTL)
  return updated
}
```

**Hieu qua:** Checkout sessions survive restart, share across processes, auto-expire after 1 hour.

#### Step 1.6: API Response Caching

**Tai sao:** GET endpoints nhu listProducts, getProduct doc DB moi lan. Nhung data products chi thay doi khi admin update.

```typescript
// Cache strategy per endpoint type:

// Products list: cache 60s (invalidate on create/update/delete)
app.get('/api/store/:slug/products', async (req, res) => {
  const cacheKey = `api:products:${shopId}:${page}:${limit}:${sort}`
  const cached = await cacheGet(cacheKey)
  if (cached) return res.json(cached)

  const result = await listProducts(db, shopId, ...)
  await cacheSet(cacheKey, result, 60) // 60s TTL
  res.json(result)
})

// Single product: cache 300s
app.get('/api/store/:slug/products/:id', async (req, res) => {
  const cacheKey = `api:product:${id}`
  const cached = await cacheGet(cacheKey)
  if (cached) return res.json(cached)

  const product = await getProduct(db, id, shopId)
  await cacheSet(cacheKey, product, 300)
  res.json(product)
})

// Cache invalidation on write:
app.post('/api/store/:slug/products', async (req, res) => {
  const product = await createProduct(db, shopId, req.body)
  await cacheDelPattern(`api:products:${shopId}:*`) // Invalidate list cache
  res.json(product)
})
```

**Cache Strategy Table:**

| Endpoint | TTL | Invalidation Trigger | Ly Do |
|----------|-----|---------------------|-------|
| GET /products (list) | 60s | Product create/update/delete | List thay doi thuong xuyen |
| GET /products/:id | 300s | Product update/delete | Single product it thay doi |
| GET /collections | 300s | Collection create/update/delete | It thay doi |
| GET /orders (list) | 30s | Order create/update | Orders thay doi nhieu hon |
| GET /customers (list) | 60s | Customer create/update | Vua phai |
| GET /discounts | 120s | Discount create/update | It thay doi |
| Dashboard stats | 300s | Any order/transaction | Expensive queries, cache lau |
| Store settings | 600s | Settings update | Rat it thay doi |

**Hieu qua uoc tinh:** 70-80% GET requests served tu cache. DB load giam 4-5x.

---

### PHASE 2: PostgreSQL Optimization

**Ly do:** Sau khi co Redis cache, DB chi nhan ~20-30% total reads + 100% writes. Can toi uu de xu ly 10,000-15,000 QPS.

#### Step 2.1: PgBouncer Connection Pooling

**Tai sao:**
- pg.Pool max=20 per app. 4 apps = 80 connections.
- PM2 cluster 8 processes/app = 32 processes x 20 = 640 connections!
- PostgreSQL default max_connections=100 → **KHONG DU**
- PgBouncer multiplex nhieu app connections qua it DB connections

```bash
# Cai dat PgBouncer
sudo apt install pgbouncer -y

# /etc/pgbouncer/pgbouncer.ini
[databases]
gbox_platform = host=127.0.0.1 port=5432 dbname=gbox_platform

[pgbouncer]
listen_addr = 127.0.0.1
listen_port = 6432
auth_type = md5
auth_file = /etc/pgbouncer/userlist.txt

# QUAN TRONG: Transaction pooling mode
pool_mode = transaction
max_client_conn = 1000      # Cho phep 1000 app connections
default_pool_size = 50      # Chi dung 50 DB connections thuc
min_pool_size = 10
reserve_pool_size = 10
reserve_pool_timeout = 3
server_idle_timeout = 300
```

**App config thay doi:**
```
# .env
DATABASE_URL=postgresql://gbox:GboxPlatform2026@localhost:6432/gbox_platform
# Port 6432 (PgBouncer) thay vi 5432 (PostgreSQL truc tiep)
```

**Hieu qua:**
- 32 processes x 20 connections = 640 app connections → PgBouncer → chi 50 DB connections
- Connection overhead giam 12x
- Query throughput tang 2-3x do connection reuse hieu qua hon

#### Step 2.2: PostgreSQL Tuning

```ini
# /etc/postgresql/16/main/postgresql.conf

# Memory
shared_buffers = 2GB              # 25% RAM (gia su server 8GB)
effective_cache_size = 6GB        # 75% RAM
work_mem = 16MB                   # Per-operation sort/hash memory
maintenance_work_mem = 512MB      # Vacuum, index creation

# WAL & Checkpoint
wal_buffers = 64MB
checkpoint_completion_target = 0.9
max_wal_size = 2GB

# Connections (PgBouncer handles pooling)
max_connections = 200             # Tang tu 100

# Query Planner
random_page_cost = 1.1            # SSD storage
effective_io_concurrency = 200    # SSD concurrent reads

# Parallel Query
max_parallel_workers_per_gather = 4
max_parallel_workers = 8

# Logging (production)
log_min_duration_statement = 500  # Log slow queries > 500ms
log_checkpoints = on
```

**Ly do tung setting:**
- `shared_buffers=2GB`: PostgreSQL dung buffer nay de cache data pages. 25% RAM la best practice.
- `work_mem=16MB`: Tang tu default 4MB. Complex queries (JOIN, ORDER BY) dung memory thay vi disk sort.
- `random_page_cost=1.1`: Server dung SSD, random read nhanh gan sequential. Default 4.0 cho HDD.
- `max_parallel_workers=8`: Cho phep parallel query scan cho large tables.

#### Step 2.3: Them Missing Indexes

```sql
-- Tai sao: Cac query thuong gap khong co index phu hop

-- Orders by date range (analytics queries)
CREATE INDEX idx_orders_shop_created
  ON orders(shop_id, created_at DESC);
-- Ly do: Dashboard queries filter by shop_id + date range. Composite index
-- cho phep index-only scan thay vi sequential scan.

-- Products by status + type (common filter)
CREATE INDEX idx_products_shop_status_type
  ON products(shop_id, status, product_type);
-- Ly do: Admin list products thuong filter by status (active/draft) + type.

-- Customers search (email + name)
CREATE INDEX idx_customers_shop_email_trgm
  ON customers USING gin(email gin_trgm_ops)
  WHERE shop_id IS NOT NULL;
-- Ly do: LIKE '%search%' queries can trigram index. GIN(trgm) ho tro
-- partial string matching O(1) thay vi O(N) sequential scan.

-- Transactions by order (join optimization)
CREATE INDEX idx_transactions_order_status
  ON transactions(order_id, status);
-- Ly do: getOrder() luon JOIN transactions. Composite index covering ca
-- WHERE va SELECT columns.

-- Audit logs by time (pagination)
CREATE INDEX idx_audit_logs_shop_time
  ON audit_logs(shop_id, created_at DESC);
-- Ly do: Audit log pagination query by shop + time. DESC index cho
-- "newest first" khong can sort.

-- Inventory low stock alerts
CREATE INDEX idx_variants_low_stock
  ON product_variants(shop_id, inventory_quantity)
  WHERE inventory_quantity < 10;
-- Ly do: Partial index chi index rows co stock < 10. Nho hon full index,
-- nhanh hon cho low-stock alerts dashboard.
```

#### Step 2.4: Fix N+1 Queries

```typescript
// TRUOC (N+1 — 2N queries cho N line items):
for (const liId of line_item_ids) {
  const li = await db.selectFrom('order_line_items')
    .where('id', '=', liId).executeTakeFirst()
  if (li) {
    await db.insertInto('fulfillment_line_items')
      .values({ fulfillment_id, line_item_id: liId, quantity: li.quantity })
      .execute()
  }
}

// SAU (2 queries total):
const items = await db.selectFrom('order_line_items')
  .select(['id', 'quantity'])
  .where('id', 'in', line_item_ids)
  .execute()

if (items.length > 0) {
  await db.insertInto('fulfillment_line_items')
    .values(items.map(li => ({
      fulfillment_id,
      line_item_id: li.id,
      quantity: li.quantity,
    })))
    .execute()
}
```

**Hieu qua:** 10 line items: 20 queries → 2 queries (giam 90%). 100 line items: 200 → 2 (giam 99%).

#### Step 2.5: Read Replicas

**Tai sao:** 100K RPS, 80% la reads. Tach read traffic sang replica giam load primary 80%.

```typescript
// packages/db/src/index.ts — Primary + Replica

export function createDb(config: DatabaseConfig = {}): Kysely<Database> {
  const pool = new pg.Pool({
    connectionString: config.connectionString ?? process.env.DATABASE_URL,
    max: config.max ?? 20,
  })
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) })
}

// Read replica for SELECT queries
export function createReadDb(config: DatabaseConfig = {}): Kysely<Database> {
  const pool = new pg.Pool({
    connectionString: config.connectionString ?? process.env.DATABASE_READ_URL,
    max: config.max ?? 30, // More connections for reads
  })
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) })
}

// Usage in server.ts:
const db = createDb()        // Writes → Primary
const readDb = createReadDb() // Reads → Replica
```

**PostgreSQL Streaming Replication:**
```bash
# Primary: /etc/postgresql/16/main/postgresql.conf
wal_level = replica
max_wal_senders = 5
wal_keep_size = 1GB

# Replica setup
pg_basebackup -h primary-ip -D /var/lib/postgresql/16/main -U replicator -P -R
```

**Replication lag:** < 100ms (acceptable cho most reads, khong dung cho critical writes)

---

### PHASE 3: Horizontal Scaling (Node.js Cluster)

**Ly do:** 1 Node process = 1 CPU core = ~2,000-5,000 RPS. Server 8 cores = can 8 processes.

#### Step 3.1: PM2 Cluster Mode

```javascript
// ecosystem.config.cjs
module.exports = {
  apps: [
    {
      name: 'gbox-api',
      script: 'start.mjs',
      instances: 'max',         // = so CPU cores (8)
      exec_mode: 'cluster',     // PM2 cluster mode
      max_memory_restart: '1G',
      env: {
        PORT: 4321,
        NODE_ENV: 'production',
      },
      // Graceful shutdown
      kill_timeout: 10000,
      listen_timeout: 5000,
      // Auto-restart on crash
      max_restarts: 10,
      restart_delay: 1000,
    },
    {
      name: 'gbox-accounts',
      script: 'apps/accounts/src/server.ts',
      interpreter: './node_modules/.bin/tsx',
      instances: 2,              // Accounts traffic thap hon
      exec_mode: 'cluster',
      max_memory_restart: '512M',
      env: { PORT: 4323 },
    },
    {
      name: 'gbox-god-admin',
      script: 'apps/god-admin/src/server.ts',
      interpreter: './node_modules/.bin/tsx',
      instances: 1,              // Chi 1 god admin, traffic thap
      max_memory_restart: '512M',
      env: { PORT: 4324 },
    },
    {
      name: 'gbox-store-admin',
      script: 'apps/store-admin/src/server.ts',
      interpreter: './node_modules/.bin/tsx',
      instances: 4,              // Nhieu merchants dung dong thoi
      exec_mode: 'cluster',
      max_memory_restart: '512M',
      env: { PORT: 4325 },
    },
  ],
}
```

**Ly do instances:**
- Platform API: `max` (8 cores) — nhan 80% traffic (API + storefront)
- Store Admin: 4 — merchants dung thuong xuyen
- Accounts: 2 — chi login/signup, traffic thap
- God Admin: 1 — chi 1 nguoi dung (Thai)

**Throughput sau PM2 cluster:**
```
Platform API: 8 processes x 3,000 RPS = 24,000 RPS (truoc: 3,000)
Store Admin:  4 processes x 2,000 RPS = 8,000 RPS  (truoc: 2,000)
Accounts:     2 processes x 2,000 RPS = 4,000 RPS  (truoc: 2,000)
God Admin:    1 process  x 2,000 RPS = 2,000 RPS  (truoc: 2,000)
```

#### Step 3.2: Nginx Load Balancer Upgrade

```nginx
# /etc/nginx/sites-available/gbox-platform

# Connection pool to backend
upstream gbox_api {
    least_conn;                    # Gui request den process it load nhat
    keepalive 64;                  # Giu 64 connections mo san

    server 127.0.0.1:4321 max_fails=3 fail_timeout=30s;
    # PM2 cluster mode: tat ca processes listen tren cung port 4321
    # OS kernel distributes connections via SO_REUSEPORT
}

upstream gbox_accounts {
    least_conn;
    keepalive 16;
    server 127.0.0.1:4323;
}

upstream gbox_store_admin {
    least_conn;
    keepalive 32;
    server 127.0.0.1:4325;
}

upstream gbox_god_admin {
    server 127.0.0.1:4324;
}

server {
    listen 80;
    server_name gbox.co *.gbox.co;

    # --- Performance Tuning ---

    # Worker connections
    # Dat trong /etc/nginx/nginx.conf:
    # worker_processes auto;
    # worker_connections 4096;
    # multi_accept on;

    # Buffers
    proxy_buffering on;
    proxy_buffer_size 8k;
    proxy_buffers 16 16k;
    proxy_busy_buffers_size 32k;

    # Timeouts
    proxy_connect_timeout 5s;
    proxy_read_timeout 30s;
    proxy_send_timeout 10s;

    # Keepalive to upstream
    proxy_http_version 1.1;
    proxy_set_header Connection "";

    # --- Caching ---

    # API response cache (GET only)
    proxy_cache_path /var/cache/nginx/api levels=1:2
        keys_zone=api_cache:50m max_size=1g inactive=60s;

    # Static file cache
    proxy_cache_path /var/cache/nginx/static levels=1:2
        keys_zone=static_cache:20m max_size=2g inactive=7d;

    # --- Routes ---

    # Static assets (aggressive cache)
    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$ {
        proxy_pass http://gbox_api;
        proxy_cache static_cache;
        proxy_cache_valid 200 7d;
        proxy_cache_valid 404 1m;
        add_header Cache-Control "public, max-age=604800, immutable";
        add_header X-Cache-Status $upstream_cache_status;
    }

    # API GET requests (short cache)
    location ~ ^/api/.+$ {
        proxy_pass http://gbox_api;

        # Chi cache GET requests
        proxy_cache api_cache;
        proxy_cache_methods GET;
        proxy_cache_valid 200 30s;
        proxy_cache_key "$request_method$request_uri$cookie_gbox_session";
        proxy_cache_bypass $request_method;  # POST/PUT/DELETE bypass cache

        # Headers
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        add_header X-Cache-Status $upstream_cache_status;
    }

    # Webhooks (no cache, no buffering)
    location /api/webhooks/ {
        proxy_pass http://gbox_api;
        proxy_buffering off;
        proxy_request_buffering off;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    # Accounts portal
    location /accounts/ {
        proxy_pass http://gbox_accounts;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    # Store Admin
    location /admin/ {
        proxy_pass http://gbox_store_admin;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    # God Admin
    location /god-admin/ {
        proxy_pass http://gbox_god_admin;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    # Health check (no proxy, direct response)
    location = /health {
        access_log off;
        return 200 'OK';
        add_header Content-Type text/plain;
    }

    # Rate limiting at Nginx level (backup)
    limit_req_zone $binary_remote_addr zone=api_limit:10m rate=100r/s;
    limit_req_zone $binary_remote_addr zone=auth_limit:5m rate=5r/s;

    client_max_body_size 50M;
}
```

**Nginx tuning (/etc/nginx/nginx.conf):**
```nginx
worker_processes auto;          # = CPU cores
worker_rlimit_nofile 65535;     # Max open files per worker

events {
    worker_connections 4096;    # Tang tu default 768
    multi_accept on;            # Accept nhieu connections cung luc
    use epoll;                  # Linux epoll (hieu qua nhat)
}

http {
    sendfile on;
    tcp_nopush on;
    tcp_nodelay on;
    keepalive_timeout 65;
    keepalive_requests 1000;
    types_hash_max_size 2048;

    # Open file cache
    open_file_cache max=10000 inactive=5m;
    open_file_cache_valid 2m;
    open_file_cache_min_uses 1;
}
```

---

### PHASE 4: Application-Level Optimization

#### Step 4.1: Async Crypto

**Tai sao:** `createHash()` va `randomBytes()` la synchronous, block event loop. 100K RPS = hang ngan hash/s.

```typescript
import { randomBytes, createHash } from 'crypto'
import { promisify } from 'util'

const randomBytesAsync = promisify(randomBytes)

// Session token generation — async
export async function generateToken(): Promise<string> {
  const bytes = await randomBytesAsync(32)
  return bytes.toString('hex')
}

// SHA-256 hash — van dung sync vi nhanh (~0.01ms cho 64 bytes)
// Nhung bcrypt PHAI dung async version (da co)
```

**Ly do:** `randomBytes(32)` sync = ~0.05ms (ok). Nhung `bcrypt.hash()` = ~100ms (PHAI async). Kiem tra tat ca bcrypt calls dung `await bcrypt.hash()` khong dung `bcrypt.hashSync()`.

#### Step 4.2: Structured Logging (Replace console.log)

**Tai sao:** `console.log` la synchronous I/O. 100K RPS x console.log = block event loop.

```typescript
// packages/core/src/modules/logging/logger.ts
import pino from 'pino'

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: process.env.NODE_ENV === 'production'
    ? { target: 'pino/file', options: { destination: '/var/log/gbox/api.log' } }
    : { target: 'pino-pretty' },
  // Async logging — khong block event loop
  // pino tu dong buffer va flush async
})

// Usage:
logger.info({ shopId, productId }, 'Product created')
logger.error({ err, orderId }, 'Payment failed')
```

**Pino vs console.log:**
- Pino: async, JSON output, 5x nhanh hon console.log
- console.log: sync, block event loop, khong structured

#### Step 4.3: Response Compression

```typescript
// server.ts — them compression middleware
import compression from 'compression'

// Dat TRUOC route handlers, SAU security headers
app.use(compression({
  level: 6,              // Balance giua speed va ratio
  threshold: 1024,       // Chi compress > 1KB
  filter: (req, res) => {
    if (req.path.startsWith('/api/webhooks')) return false // Webhooks khong compress
    return compression.filter(req, res)
  },
}))
```

**Hieu qua:** JSON response 50KB → 8KB (giam 84%). Bandwidth giam 5x, client parse nhanh hon.

#### Step 4.4: Connection Keep-Alive

```typescript
// server.ts — enable HTTP keep-alive
const server = app.listen(PORT, () => {
  console.log(`Listening on ${PORT}`)
})

server.keepAliveTimeout = 65000    // > Nginx keepalive_timeout (65s)
server.headersTimeout = 70000      // > keepAliveTimeout
server.maxHeadersCount = 100
server.timeout = 30000             // 30s request timeout
```

**Ly do:** Keep-alive reuse TCP connections. Khong co keep-alive, moi request = TCP handshake moi (3-way handshake = ~1ms LAN, ~50ms WAN).

---

### PHASE 5: CDN & Edge Caching

#### Step 5.1: Cloudflare Configuration

**Tai sao:** CDN serve static content tu edge servers (gan user nhat). Giam 50-70% traffic den origin server.

```
Cloudflare Settings:
├── SSL/TLS: Full (Strict)
├── Caching:
│   ├── Browser Cache TTL: Respect Existing Headers
│   ├── Edge Cache TTL: 2h for static, 30s for API
│   └── Cache Level: Standard
├── Page Rules:
│   ├── *.gbox.co/api/webhooks/* → Cache Level: Bypass
│   ├── *.gbox.co/api/store/*/products* → Cache Level: Cache Everything, Edge TTL: 60s
│   ├── *.gbox.co/accounts/* → Cache Level: Bypass
│   └── *.gbox.co/admin/* → Cache Level: Bypass
├── Security:
│   ├── WAF: On (Managed Ruleset)
│   ├── Bot Management: On
│   ├── DDoS: Automatic
│   └── Rate Limiting: 1000 req/10s per IP
└── Performance:
    ├── Auto Minify: JS, CSS, HTML
    ├── Brotli: On
    ├── Early Hints: On
    └── HTTP/3: On
```

**API Response Headers cho caching:**
```typescript
// Storefront product API (public, cacheable)
res.set('Cache-Control', 'public, max-age=60, s-maxage=120, stale-while-revalidate=300')

// Admin API (private, no cache)
res.set('Cache-Control', 'private, no-store')

// Static assets
res.set('Cache-Control', 'public, max-age=604800, immutable')
```

**Hieu qua:** Cloudflare co 300+ edge servers. User o Vietnam → serve tu Singapore/HK. Latency giam tu 200ms → 20ms cho cached content.

---

### PHASE 6: Monitoring & Auto-Scaling

#### Step 6.1: Health Checks & Metrics

```typescript
// server.ts — enhanced health check
app.get('/health', async (req, res) => {
  const start = Date.now()

  // Check all dependencies
  const checks = await Promise.allSettled([
    db.selectFrom('shops').select('id').limit(1).execute(),  // DB
    getRedis().then(r => r.ping()),                           // Redis
  ])

  const dbOk = checks[0].status === 'fulfilled'
  const redisOk = checks[1].status === 'fulfilled'
  const latency = Date.now() - start

  const status = dbOk && redisOk ? 'healthy' : 'degraded'

  res.status(status === 'healthy' ? 200 : 503).json({
    status,
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    latency_ms: latency,
    checks: {
      database: dbOk ? 'ok' : 'fail',
      redis: redisOk ? 'ok' : 'fail',
    },
    timestamp: new Date().toISOString(),
  })
})

// Metrics endpoint cho Prometheus
app.get('/metrics', (req, res) => {
  res.set('Content-Type', 'text/plain')
  res.send(`
# HELP gbox_requests_total Total requests
# TYPE gbox_requests_total counter
gbox_requests_total{method="GET"} ${metrics.get_count}
gbox_requests_total{method="POST"} ${metrics.post_count}

# HELP gbox_response_time_ms Response time
# TYPE gbox_response_time_ms histogram
gbox_response_time_ms{quantile="0.5"} ${metrics.p50}
gbox_response_time_ms{quantile="0.95"} ${metrics.p95}
gbox_response_time_ms{quantile="0.99"} ${metrics.p99}

# HELP gbox_db_pool_active Active DB connections
# TYPE gbox_db_pool_active gauge
gbox_db_pool_active ${metrics.db_active}

# HELP gbox_redis_connected Redis connection status
# TYPE gbox_redis_connected gauge
gbox_redis_connected ${metrics.redis_ok ? 1 : 0}
  `)
})
```

---

## 4. CAPACITY CALCULATION (Tinh Toan Chi Tiet)

### 4.1 Request Distribution (100K RPS)

```
100,000 RPS breakdown (estimated):
├── Storefront (public) ........... 60,000 RPS (60%)
│   ├── Product pages ............. 25,000
│   ├── Collection pages .......... 15,000
│   ├── Static assets ............. 15,000
│   └── Search, cart, other ....... 5,000
│
├── API (authenticated) ........... 30,000 RPS (30%)
│   ├── GET products/orders ....... 20,000
│   ├── POST/PUT (writes) ......... 5,000
│   └── Checkout/payments ......... 5,000
│
├── Admin dashboards .............. 8,000 RPS (8%)
│   ├── Store Admin ............... 6,000
│   ├── God Admin ................. 500
│   └── Accounts .................. 1,500
│
└── Webhooks/background ........... 2,000 RPS (2%)
```

### 4.2 Layer-by-Layer Throughput

```
Layer 1: Cloudflare CDN
├── Static assets:  15,000 RPS → 100% cached at edge → 0 to origin
├── Product pages:  25,000 RPS → 80% cached → 5,000 to origin
├── Collection pages: 15,000 → 80% cached → 3,000 to origin
└── TOTAL ABSORBED: ~47,000 RPS
    REMAINING: ~53,000 RPS to origin

Layer 2: Nginx (origin)
├── Nginx cache (API GET): ~15,000 RPS cached → 0 to Node
├── Pass-through: ~38,000 RPS to Node processes
└── Rate limit block: ~2,000 RPS (abusive traffic)
    REMAINING: ~36,000 RPS to Node

Layer 3: Node.js Cluster (15 processes total)
├── Platform API (8 proc): 8 × 4,000 = 32,000 RPS capacity
├── Store Admin (4 proc):  4 × 3,000 = 12,000 RPS capacity
├── Accounts (2 proc):     2 × 3,000 = 6,000 RPS capacity
├── God Admin (1 proc):    1 × 3,000 = 3,000 RPS capacity
└── TOTAL CAPACITY: 53,000 RPS (headroom: 47%)
    ACTUAL LOAD: ~36,000 RPS

Layer 4: Redis
├── Session validation: ~36,000 ops/s (0.1ms each)
├── Rate limit checks:  ~36,000 ops/s
├── Cache hits:         ~25,000 ops/s
├── Cache misses:       ~8,000 ops/s
└── TOTAL: ~105,000 ops/s
    Redis capacity: 200,000+ ops/s (single instance) ✅

Layer 5: PostgreSQL (via PgBouncer)
├── Cache-miss reads:   ~8,000 QPS
├── Writes (POST/PUT):  ~5,000 QPS
├── Background/cron:    ~500 QPS
└── TOTAL: ~13,500 QPS
    PgBouncer capacity: 50 connections × 300 QPS = 15,000 QPS ✅
    (Primary: 10,000 QPS, Replica: 5,000 QPS)
```

### 4.3 Hardware Requirements

| Component | Hien Tai | Can Cho 100K RPS | Ly Do |
|-----------|----------|-------------------|-------|
| **CPU** | Unknown (1 server) | 8+ cores | 15 Node processes + Nginx + PgBouncer |
| **RAM** | Unknown | 16-32GB | PostgreSQL 4GB + Redis 512MB + Node 15x512MB = ~12GB + OS |
| **Disk** | Unknown | SSD 100GB+ | WAL logs, Redis AOF, Nginx cache, app logs |
| **Network** | Unknown | 1Gbps+ | 100K RPS x avg 10KB response = ~1GB/s peak |

**Recommended Server Specs (single server):**
```
CPU:     16 cores (AMD EPYC / Intel Xeon)
RAM:     32GB DDR4
Disk:    500GB NVMe SSD
Network: 1Gbps dedicated
OS:      Ubuntu 22.04 LTS
```

**Multi-Server (recommended cho production):**
```
Server 1 (App): 8 cores, 16GB RAM — Node.js + Nginx + Redis
Server 2 (DB):  8 cores, 16GB RAM — PostgreSQL Primary + PgBouncer
Server 3 (DB):  4 cores, 8GB RAM  — PostgreSQL Read Replica
```

---

## 5. BANG SO SANH TRUOC/SAU

| Metric | Hien Tai | Sau Toi Uu | Tang | Ly Do Chinh |
|--------|----------|------------|------|-------------|
| **Max RPS** | ~1,000 | ~100,000 | **100x** | Redis cache + clustering + CDN |
| **Avg Latency (API GET)** | ~50ms | ~5ms | **10x** | Redis cache (0.1ms) thay DB (10ms) |
| **Avg Latency (API POST)** | ~80ms | ~20ms | **4x** | PgBouncer + optimized queries |
| **DB Queries/s** | ~1,000 | ~13,500 | **13x** | PgBouncer + read replica + tuning |
| **DB Connections** | 80 (4x20) | 50 (PgBouncer) | **Giam 37%** | Connection pooling hieu qua hon |
| **Memory Leaks** | 5 Maps vo han | 0 | **Fixed** | Redis TTL auto-expire |
| **Process count** | 4 | 15 | **3.75x** | PM2 cluster mode |
| **Cache hit rate** | 0% | ~80% | **∞** | Redis + Nginx + Cloudflare layers |
| **Bandwidth saved** | 0% | ~70% | **∞** | Gzip + CDN + compression |
| **Session lookup** | 10ms (DB) | 0.1ms (Redis) | **100x** | Redis in-memory vs disk I/O |
| **Rate limit accuracy** | Per-process | Global | **Fixed** | Redis shared state |
| **Checkout persistence** | None (in-memory) | Redis + AOF | **Fixed** | Survive restarts |
| **Failover** | None | Auto (PM2 + Replica) | **Added** | PM2 auto-restart + DB replica |

---

## 6. TIMELINE TRIEN KHAI

| Phase | Thoi Gian | Do Kho | Impact |
|-------|-----------|--------|--------|
| **Phase 1:** Redis Foundation | 3-4 ngay | Trung binh | +500% throughput, fix memory leaks |
| **Phase 2:** PostgreSQL Optimization | 2-3 ngay | Trung binh | +300% DB throughput |
| **Phase 3:** Horizontal Scaling | 1-2 ngay | De | +400% request handling |
| **Phase 4:** App Optimization | 2-3 ngay | De-TB | +50% per-request speed |
| **Phase 5:** CDN & Edge | 1 ngay | De | -50-70% origin traffic |
| **Phase 6:** Monitoring | 1-2 ngay | De | Visibility, alerting |
| **TONG** | **10-15 ngay** | | **~1,000 → 100,000 RPS** |

---

## 7. RISK & MITIGATION

| Risk | Xac Suat | Impact | Mitigation |
|------|----------|--------|------------|
| Redis crash | Thap | Cao — mat sessions, cache | Redis Sentinel auto-failover + AOF persistence |
| DB replica lag | Trung binh | Thap — stale reads | Monitor lag, fallback to primary cho critical reads |
| PM2 process crash | Thap | Thap — auto-restart | PM2 auto-restart + health checks |
| CDN cache poisoning | Rat thap | Cao | Vary headers + cache key validation |
| Connection pool exhaustion | Trung binh | Cao | PgBouncer queuing + monitoring + alerts |
| Memory exhaustion | Thap | Cao | PM2 max_memory_restart + Redis maxmemory-policy |

---

## 8. TOM TAT (Executive Summary)

### Van de hien tai:
He thong Gbox Platform hien tai chi chiu duoc **~1,000 RPS** do:
1. **Single process** — 1 Node.js process/server, khong tan dung multi-core
2. **Khong co cache** — Moi request hit PostgreSQL truc tiep
3. **In-memory state** — Rate limit, checkout, CSRF, OTP khong scale
4. **Khong co CDN** — Tat ca traffic den origin server
5. **DB khong co pooling** — 20 connections/app, khong co PgBouncer
6. **N+1 queries** — Loop queries trong fulfillment, commission

### Giai phap (6 phases):
1. **Redis** → Cache + shared state → giam DB load 80%, fix memory leaks
2. **PostgreSQL tuning** → PgBouncer + indexes + replica → tang DB throughput 10x
3. **PM2 Cluster** → 15 processes → tang compute 4x
4. **App optimization** → Compression, async crypto, structured logging
5. **CDN (Cloudflare)** → Absorb 50% traffic at edge
6. **Monitoring** → Prometheus + health checks → detect issues early

### Ket qua:
**100,000 RPS** voi:
- P50 latency: ~5ms (GET cached), ~20ms (POST write)
- P99 latency: ~50ms (GET), ~200ms (POST)
- Availability: 99.9%+ (auto-restart + failover)
- Cost: 2-3 VPS servers ($50-150/month) hoac 1 dedicated server ($100/month)
