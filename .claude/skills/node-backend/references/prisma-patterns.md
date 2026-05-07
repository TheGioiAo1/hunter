# Prisma Patterns (PostgreSQL)

## Schema Conventions

```prisma
// PascalCase models, camelCase fields, @map snake_case
model User {
  id        BigInt   @id @default(autoincrement())
  email     String   @unique
  name      String?
  role      Role     @default(USER)
  createdAt DateTime @default(now()) @map("created_at")
  updatedAt DateTime @updatedAt @map("updated_at")
  deletedAt DateTime? @map("deleted_at")

  posts     Post[]

  @@map("users")
}

enum Role {
  USER
  ADMIN
}
```

## PrismaService

```typescript
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit {
  async onModuleInit() {
    await this.$connect()
  }

  async onModuleDestroy() {
    await this.$disconnect()
  }
}

// Register as global module
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
```

## Common Queries

### FindMany with filters

```typescript
const where: Prisma.UserWhereInput = {
  ...(search && {
    OR: [
      { name: { contains: search, mode: 'insensitive' } },
      { email: { contains: search, mode: 'insensitive' } },
    ],
  }),
  ...(role && { role }),
  deletedAt: null,  // exclude soft-deleted
}

const users = await this.prisma.user.findMany({
  where,
  skip: (page - 1) * pageSize,
  take: pageSize,
  orderBy: { createdAt: 'desc' },
  omit: { password: true },  // Prisma v6+
})
```

### Relations

```typescript
// Include relations
const user = await this.prisma.user.findUnique({
  where: { id },
  include: { posts: { where: { published: true }, take: 10 } },
})

// Select specific fields
const user = await this.prisma.user.findUnique({
  where: { id },
  select: { id: true, name: true, email: true },
})
```

### Upsert

```typescript
const user = await this.prisma.user.upsert({
  where: { email },
  update: { name, updatedAt: new Date() },
  create: { email, name },
})
```

## Transactions

```typescript
// Interactive transaction
const result = await this.prisma.$transaction(async (tx) => {
  const order = await tx.order.create({ data: orderData })
  await tx.orderItem.createMany({
    data: items.map(item => ({ ...item, orderId: order.id })),
  })
  await tx.inventory.updateMany({
    where: { productId: { in: items.map(i => i.productId) } },
    data: { stock: { decrement: 1 } },
  })
  return order
})

// Sequential transaction (simple)
const [users, posts] = await this.prisma.$transaction([
  this.prisma.user.findMany(),
  this.prisma.post.findMany(),
])
```

## Error Handling

```typescript
try {
  return await this.prisma.user.create({ data: dto })
} catch (error) {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    switch (error.code) {
      case 'P2002':  // Unique constraint
        const field = (error.meta?.target as string[])?.[0]
        throw new ConflictException(`${field} already exists`)
      case 'P2025':  // Record not found
        throw new NotFoundException('Record not found')
      case 'P2003':  // Foreign key constraint
        throw new BadRequestException('Related record not found')
    }
  }
  throw error
}
```

## Migrations

```bash
# Development — create + apply migration
npx prisma migrate dev --name add-user-role

# Production — apply pending migrations
npx prisma migrate deploy

# Reset database (dev only)
npx prisma migrate reset

# Generate client after schema changes
npx prisma generate
```

## Seeding

```typescript
// prisma/seed.ts
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  await prisma.user.upsert({
    where: { email: 'admin@example.com' },
    update: {},
    create: { email: 'admin@example.com', name: 'Admin', role: 'ADMIN' },
  })
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect())
```

## Performance Tips

- Use `select` instead of `include` when only a few fields are needed
- `omit` (Prisma v6+) to exclude sensitive fields
- `findMany` + `count` in parallel with `Promise.all`
- Batch operations: `createMany`, `updateMany`, `deleteMany`
- Raw queries for complex aggregations: `this.prisma.$queryRaw`
