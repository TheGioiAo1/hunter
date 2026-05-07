# NestJS Patterns

## Execution Pipeline

Request → Middleware → Guards → Interceptors (before) → Pipes → Handler → Interceptors (after) → Exception Filters → Response

## Guards

```typescript
// JWT Guard — verify token, attach user to request
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {}

// Admin Guard — check role after JWT
@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest()
    return request.user?.role === 'admin'
  }
}

// Apply at class level
@UseGuards(JwtAuthGuard, AdminGuard)
@Controller('admin/users')
export class UsersAdminController {}

// Public decorator — bypass JWT
export const Public = () => SetMetadata('isPublic', true)
```

## Interceptors

```typescript
// Transform response
@Injectable()
export class TransformInterceptor<T> implements NestInterceptor<T, Response<T>> {
  intercept(context: ExecutionContext, next: CallHandler): Observable<Response<T>> {
    return next.handle().pipe(map(data => ({ success: true, data })))
  }
}

// Logging interceptor
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const now = Date.now()
    return next.handle().pipe(
      tap(() => console.log(`${context.getHandler().name}: ${Date.now() - now}ms`)),
    )
  }
}
```

## Pipes

```typescript
// Global validation pipe (main.ts)
app.useGlobalPipes(new ValidationPipe({
  whitelist: true,        // strip unknown properties
  forbidNonWhitelisted: true,
  transform: true,        // auto-transform types
  transformOptions: { enableImplicitConversion: true },
}))

// Custom parse pipe
@Injectable()
export class ParseBigIntPipe implements PipeTransform {
  transform(value: string): bigint {
    try { return BigInt(value) }
    catch { throw new BadRequestException(`Invalid ID: ${value}`) }
  }
}

// Usage: @Param('id', ParseBigIntPipe) id: bigint
```

## Middleware

```typescript
@Injectable()
export class RequestLoggerMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    console.log(`${req.method} ${req.url}`)
    next()
  }
}

// Apply in module
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestLoggerMiddleware).forRoutes('*')
  }
}
```

## Exception Filters

```typescript
@Catch(HttpException)
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: HttpException, host: ArgumentsHost) {
    const ctx = host.switchToHttp()
    const response = ctx.getResponse<Response>()
    const status = exception.getStatus()
    response.status(status).json({
      success: false,
      statusCode: status,
      message: exception.message,
      timestamp: new Date().toISOString(),
    })
  }
}
```

## Custom Decorators

```typescript
// Current user from JWT payload
export const CurrentUser = createParamDecorator(
  (data: string, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest()
    return data ? request.user?.[data] : request.user
  },
)

// Usage: @CurrentUser('id') userId: bigint
// Usage: @CurrentUser() user: JwtPayload
```

## Module Patterns

```typescript
// Feature module
@Module({
  imports: [PrismaModule],
  controllers: [UsersAdminController],
  providers: [UsersService],
  exports: [UsersService],  // export if other modules need it
})
export class UsersModule {}

// Dynamic module (e.g., config)
@Module({})
export class ConfigModule {
  static forRoot(options: ConfigOptions): DynamicModule {
    return {
      module: ConfigModule,
      global: true,
      providers: [{ provide: CONFIG_OPTIONS, useValue: options }, ConfigService],
      exports: [ConfigService],
    }
  }
}
```

## Testing

```typescript
describe('UsersService', () => {
  let service: UsersService
  let prisma: PrismaService

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: PrismaService, useValue: mockPrismaService },
      ],
    }).compile()

    service = module.get(UsersService)
    prisma = module.get(PrismaService)
  })

  it('should find user by id', async () => {
    prisma.user.findUnique = jest.fn().mockResolvedValue(mockUser)
    const result = await service.findOne(1n)
    expect(result).toEqual(mockUser)
  })

  it('should throw NotFoundException', async () => {
    prisma.user.findUnique = jest.fn().mockResolvedValue(null)
    await expect(service.findOne(999n)).rejects.toThrow(NotFoundException)
  })
})
```

## Common Patterns

### Service with paginated query

```typescript
async findAll(query: QueryFeatureDto) {
  const { page = 1, pageSize = 20, search, status, ...rest } = query
  const where: Prisma.FeatureWhereInput = {
    ...(search && { name: { contains: search, mode: 'insensitive' } }),
    ...(status && { status }),
  }

  const [data, total] = await Promise.all([
    this.prisma.feature.findMany({
      where,
      skip: (page - 1) * pageSize,
      take: pageSize,
      orderBy: { created_at: 'desc' },
    }),
    this.prisma.feature.count({ where }),
  ])

  return { data, total, current: page, pageSize }
}
```

### Bulk operations

```typescript
async bulkDelete(dto: BulkDeleteDto) {
  const { count } = await this.prisma.feature.deleteMany({
    where: { id: { in: dto.ids.map(BigInt) } },
  })
  return { deleted: count }
}
```

### Soft delete + restore

```typescript
async remove(id: bigint) {
  return this.prisma.feature.update({
    where: { id },
    data: { deleted_at: new Date() },
  })
}

async restore(id: bigint) {
  return this.prisma.feature.update({
    where: { id },
    data: { deleted_at: null },
  })
}
```
