# Node Backend Testing Patterns (Jest / Vitest + NestJS)

## File layout

```
src/
  users/
    users.service.ts
    users.service.spec.ts      # unit — colocated
    users.controller.ts
    users.controller.spec.ts   # integration (with NestJS test module)
test/
  e2e/
    users.e2e-spec.ts          # full-app e2e via supertest
  fixtures/
    user.fixture.ts
```

## Naming & convention

- Unit / integration: `*.spec.ts` colocated with source
- E2E: `*.e2e-spec.ts` under `test/e2e/`
- Run: `yarn test`, `yarn test:watch`, `yarn test:e2e`, `yarn test:cov`

## Test module setup (NestJS)

```typescript
import { Test, TestingModule } from '@nestjs/testing'

describe('UsersService', () => {
  let service: UsersService
  let prisma: DeepMockProxy<PrismaClient>

  beforeEach(async () => {
    prisma = mockDeep<PrismaClient>()
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile()
    service = module.get(UsersService)
  })
})
```

## Prisma mock (jest-mock-extended)

```typescript
import { mockDeep, DeepMockProxy, mockReset } from 'jest-mock-extended'

prisma.user.findUnique.mockResolvedValue({ id: '1', email: 'a@b.com' })
prisma.user.create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('', { code: 'P2002', clientVersion: '' }))

// Reset between tests
afterEach(() => mockReset(prisma))
```

## Mongoose mock

```typescript
import { getModelToken } from '@nestjs/mongoose'

const userModel = {
  findOne: jest.fn(),
  create: jest.fn(),
  findByIdAndUpdate: jest.fn(),
}

const module = await Test.createTestingModule({
  providers: [
    UsersService,
    { provide: getModelToken(User.name), useValue: userModel },
  ],
}).compile()

userModel.findOne.mockReturnValue({ exec: jest.fn().mockResolvedValue(user) })
```

## Service unit — AAA pattern

```typescript
it('hashes password before create', async () => {
  // Arrange
  prisma.user.create.mockResolvedValue({ id: '1' } as any)

  // Act
  await service.register({ email: 'a@b.com', password: 'plain' })

  // Assert
  expect(prisma.user.create).toHaveBeenCalledWith({
    data: expect.objectContaining({ password: expect.not.stringContaining('plain') }),
  })
})
```

## Controller integration — supertest

```typescript
import * as request from 'supertest'
import { INestApplication } from '@nestjs/common'

describe('AuthController', () => {
  let app: INestApplication

  beforeAll(async () => {
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService).useValue(prismaMock)
      .compile()
    app = module.createNestApplication()
    await app.init()
  })

  afterAll(() => app.close())

  it('POST /auth/login returns token on valid creds', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'a@b.com', password: 'correct' })
      .expect(200)
    expect(res.body.token).toBeDefined()
  })

  it('POST /auth/login returns 401 on wrong password', () =>
    request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'a@b.com', password: 'wrong' })
      .expect(401))
})
```

## Guard testing

```typescript
it('AdminGuard rejects non-admin', () => {
  const ctx = {
    switchToHttp: () => ({ getRequest: () => ({ user: { role: 'user' } }) }),
  } as ExecutionContext
  expect(new AdminGuard().canActivate(ctx)).toBe(false)
})
```

## Redis mock (ioredis-mock)

```typescript
import RedisMock from 'ioredis-mock'
const redis = new RedisMock()

// or inject via provider token
{ provide: 'REDIS_CLIENT', useValue: new RedisMock() }
```

## Error path coverage (must-haves)

Per endpoint / service method, always cover:
- Happy path
- Invalid input → ValidationPipe / DTO rejects (400)
- Not found (404)
- Unauthorized (401) / Forbidden (403)
- Conflict / duplicate (409)
- DB error → 500 propagation

## Fixtures

```typescript
// test/fixtures/user.fixture.ts
export const buildUser = (overrides: Partial<User> = {}): User => ({
  id: 'u1',
  email: 'user@test.com',
  role: 'user',
  createdAt: new Date('2025-01-01'),
  ...overrides,
})
```

Prefer factory functions over static objects — tests can tweak only what matters.

## Async / timing

- `await` every promise — no dangling
- Use `jest.useFakeTimers()` for setTimeout/Interval logic
- Flush microtasks: `await Promise.resolve()` or `await new Promise(setImmediate)`
- Clean up: `afterEach(() => jest.clearAllMocks())`

## Coverage priorities

1. **Critical path**: auth, payments, permissions, data migrations → 90%+ branches
2. **Business logic** (services / use-cases) → 80%+ statements
3. **Controllers** → happy + 2-3 error paths, don't chase 100%
4. **DTOs / entities** → skip (tested via integration)
5. **Infra glue** (main.ts, modules) → skip

## Vitest differences

Same patterns, different imports:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
// vi.fn() instead of jest.fn()
// vi.useFakeTimers() instead of jest.useFakeTimers()
```

Config: `vitest.config.ts` with `test.globals: true` mimics Jest's global API.

## Common pitfalls

- Leaking state between tests → `beforeEach` reset mocks, `afterEach` close connections
- Testing implementation detail (private method) → test through public API
- Mocking what you own → mock external boundaries only (DB, HTTP, Redis)
- Flaky tests from `new Date()` / `Math.random()` → use fake timers + seeded RNG
- E2E pollution → unique emails / ids per test, or fresh DB per suite
