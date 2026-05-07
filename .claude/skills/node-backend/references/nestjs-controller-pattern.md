# NestJS Controller Pattern (Opinionated Bundle)

Full pattern for a NestJS project (Fastify + Prisma **or** Mongoose) — covering:
- Folder layout `shared/{authentication,datatable,response}`
- Guards (JWT + Admin + ApiKey), `CurrentUser` decorator, `AuthUser` type
- Datatable via `POST /<resource>/ajax` body-based + DTO + Pipe + Helper
- Response format `{success, data}` (datatable has an extended shape), error `{success:false, error, message|messages, code?}`
- Service contract: returns raw entity or `DataTableResult<T>`; the interceptor wraps it
- Controller skeleton: CRUD + bulk + datatable

> Reference impl: `multisource-api/src/modules/users/users-admin.controller.ts` + `multisource-api/src/shared/{authentication,datatable,response}`.
> This file is an opinionated bundle. Generic NestJS reference stays in `nestjs-patterns.md` — this file does NOT replace it.

---

## TOC

1. Folder layout
2. Response format spec + bootstrap
3. Authentication (guards + CurrentUser + AuthUser)
4. Datatable — Prisma flavor
5. Datatable — Mongoose flavor (NEW)
6. Controller skeleton
7. Service contract
8. Prisma vs Mongoose checklist
9. Cross-links

---

## 1. Folder layout

```
src/
├── shared/
│   ├── authentication/
│   │   ├── decorators/
│   │   │   ├── current-user.decorator.ts
│   │   │   └── index.ts
│   │   ├── guards/
│   │   │   ├── jwt-auth.guard.ts
│   │   │   ├── admin.guard.ts
│   │   │   ├── api-key.guard.ts
│   │   │   └── index.ts
│   │   ├── types/
│   │   │   ├── auth-user.type.ts
│   │   │   └── index.ts
│   │   └── index.ts
│   ├── datatable/
│   │   ├── datatable.dto.ts
│   │   ├── datatable.decorator.ts
│   │   ├── datatable.helper.ts
│   │   ├── datatable.pipe.ts
│   │   └── index.ts
│   ├── dto/
│   │   ├── bulk-ids.dto.ts
│   │   └── index.ts
│   └── response/
│       ├── response.interceptor.ts
│       ├── exceptions.filter.ts
│       └── index.ts
└── modules/
    └── <feature>/
        ├── <feature>-admin.controller.ts
        ├── <feature>-user.controller.ts        // optional
        ├── <feature>-public.controller.ts      // optional
        ├── <feature>.service.ts
        ├── <feature>.module.ts
        └── dto/
            ├── create-<feature>.dto.ts
            ├── update-<feature>.dto.ts
            ├── bulk-update-<feature>.dto.ts
            └── index.ts
```

Barrel `shared/authentication/index.ts`:

```ts
export * from './guards';
export * from './decorators';
export * from './types';
```

Barrel `shared/datatable/index.ts`:

```ts
export * from './datatable.dto';
export * from './datatable.decorator';
export * from './datatable.helper';
export * from './datatable.pipe';
```

---

## 2. Response format + bootstrap

### 2.1 Shapes

**Success scalar / object:**
```json
{ "success": true, "data": { "id": "1", "name": "..." } }
```

**Success datatable:**
```json
{ "success": true, "data": [...], "total": 123, "pageSize": 20, "current": 1 }
```

**Error:**
```json
{ "success": false, "error": "BadRequest", "message": "...", "code": "OPTIONAL_CODE" }
```

**Error validation (array message):**
```json
{ "success": false, "error": [...], "messages": [...], "code": "VALIDATION_ERROR" }
```

### 2.2 `response.interceptor.ts`

```ts
import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common';
import { Observable, map } from 'rxjs';

@Injectable()
export class ResponseTransformInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    return next.handle().pipe(
      map((data) => {
        if (
          data &&
          typeof data === 'object' &&
          Array.isArray(data.data) &&
          typeof data.total !== 'undefined' &&
          typeof data.pageSize !== 'undefined' &&
          typeof data.current !== 'undefined'
        ) {
          return {
            success: true,
            data: data.data,
            total: data.total,
            pageSize: data.pageSize,
            current: data.current,
          };
        }
        return { success: true, data };
      }),
    );
  }
}
```

### 2.3 `exceptions.filter.ts`

```ts
import {
  ExceptionFilter, Catch, ArgumentsHost, HttpException, HttpStatus, Logger,
} from '@nestjs/common';
import { FastifyReply, FastifyRequest } from 'fastify';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<FastifyReply>();
    const request = ctx.getRequest<FastifyRequest>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message: string | string[] = 'Internal server error';
    let error: any = null;
    let code: string | undefined;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const responseData = exception.getResponse();
      if (typeof responseData === 'string') {
        message = responseData;
      } else if (typeof responseData === 'object' && responseData !== null) {
        const obj = responseData as any;
        code = obj.code;
        message = obj.message || message;
        error = obj.error || obj;
      }
    } else if (exception instanceof Error) {
      message = exception.message;
      error = exception.name;
    }

    if (status >= 500) {
      this.logger.error(
        `${request.method} ${request.url} ${status}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    }

    const responseData: any = { success: false, error };
    if (Array.isArray(message)) {
      responseData.code = code || 'VALIDATION_ERROR';
      responseData.messages = message;
    } else {
      if (code) responseData.code = code;
      responseData.message = message;
    }

    response.status(status).send(responseData);
  }
}
```

### 2.4 Bootstrap (`main.ts`)

```ts
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { ResponseTransformInterceptor, AllExceptionsFilter } from './shared/response';

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
  );
  app.useGlobalPipes(new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: false,
    transform: true,
    transformOptions: { enableImplicitConversion: true },
  }));
  app.useGlobalInterceptors(new ResponseTransformInterceptor());
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.listen(process.env.PORT ?? 3000, '0.0.0.0');
}
bootstrap();
```

---

## 3. Authentication

### 3.1 `types/auth-user.type.ts`

```ts
export interface AuthUser {
  id: bigint;        // → string when using Mongo ObjectId
  username: string;
  role: string;
}
```

### 3.2 `decorators/current-user.decorator.ts`

```ts
import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { FastifyRequest } from 'fastify';

export const CurrentUser = createParamDecorator(
  (data: string | undefined, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest<FastifyRequest>();
    const user = request.user;
    return data ? user?.[data] : user;
  },
);
```

Usage:
```ts
@Get('me')
me(@CurrentUser() user: AuthUser) { return user; }

@Get('my-id')
myId(@CurrentUser('id') id: bigint) { ... }
```

### 3.3 `guards/jwt-auth.guard.ts` — Prisma flavor

```ts
import { Injectable, CanActivate, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import * as jwt from 'jsonwebtoken';
import { PrismaService } from '../../prisma';
import { AuthUser } from '../types/auth-user.type';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const token = this.extractToken(request);
    if (!token) throw new UnauthorizedException('Missing authorization token');

    const user = await this.validateToken(token);
    request.user = user;
    return true;
  }

  private async validateToken(token: string): Promise<AuthUser> {
    try {
      const decoded = jwt.decode(token) as { sub: string } | null;
      if (!decoded?.sub) throw new Error('Invalid token payload');

      const user = await this.prisma.users.findUnique({
        where: { id: BigInt(decoded.sub) },
      });
      if (!user) throw new Error('User not found');

      const payload = jwt.verify(token, user.public_key, {
        algorithms: ['RS256'],
      }) as { sub: string; username: string; role: string };

      return { id: user.id, username: payload.username, role: payload.role };
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }

  private extractToken(req: FastifyRequest): string | undefined {
    const auth = req.headers.authorization;
    if (!auth) return undefined;
    const [type, token] = auth.split(' ');
    return type === 'Bearer' ? token : undefined;
  }
}
```

> **Mongoose flavor:** replace `prisma.users.findUnique({ where: { id: BigInt(decoded.sub) } })` with `UserModel.findById(decoded.sub).lean()`. Change `AuthUser.id` to `string` (ObjectId hex). The Mongoose schema must include a per-user `public_key` field.

### 3.4 `guards/admin.guard.ts`

```ts
import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { FastifyRequest } from 'fastify';

@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const user = request.user;
    if (!user || user.role !== 'admin') {
      throw new ForbiddenException('Admin access required');
    }
    return true;
  }
}
```

### 3.5 `guards/api-key.guard.ts`

```ts
import { Injectable, CanActivate, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import { PrismaService } from '../../prisma';

@Injectable()
export class ApiKeyAuthGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const apiKey = request.headers['x-api-key'] as string;
    if (!apiKey) throw new UnauthorizedException('Missing API key');

    const setting = await this.prisma.settings.findUnique({ where: { key: 'api_key' } });
    if (!setting || setting.content !== apiKey) {
      throw new UnauthorizedException('Invalid API key');
    }
    return true;
  }
}
```

> **Mongoose flavor:** `SettingModel.findOne({ key: 'api_key' }).lean()`.

### 3.6 Fastify type augmentation

```ts
// src/types/fastify.d.ts
import 'fastify';
import { AuthUser } from '../shared/authentication/types/auth-user.type';
declare module 'fastify' {
  interface FastifyRequest { user?: AuthUser }
}
```

---

## 4. Datatable — Prisma flavor

### 4.1 `datatable.dto.ts`

```ts
import { IsArray, IsEnum, IsInt, IsObject, IsOptional, IsString, Min } from 'class-validator';

export enum AjaxOrder { Asc = 'ascend', Desc = 'descend' }

export class DatatableAjaxDto {
  @IsInt() @Min(1) pageSize!: number;
  @IsInt() @Min(1) current!: number;

  @IsArray() @IsString({ each: true }) @IsOptional()
  searchColumn?: string[];

  @IsObject() @IsOptional()
  search?: Record<string, any>;

  @IsString() @IsOptional() field?: string;
  @IsOptional() @IsEnum(AjaxOrder) order?: AjaxOrder;
}
```

### 4.2 `datatable.decorator.ts`

```ts
import { ExecutionContext, createParamDecorator } from '@nestjs/common';

export const DatatableQuery = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest().body,
);
```

### 4.3 `datatable.helper.ts`

```ts
import { DatatableAjaxDto } from './datatable.dto';

export type DataTableResult<T> = {
  data: T[];
  total: number;
  pageSize: number | undefined;
  current: number;
};

export const safeParse = (v: string): number | bigint => {
  if (/^-?\d+$/.test(v)) {
    const n = Number(v);
    return Number.isSafeInteger(n) ? n : BigInt(v);
  }
  const f = Number(v);
  return Number.isFinite(f) ? f : 0;
};

/**
 * Convert DatatableAjaxDto → Prisma findMany args (where, orderBy, skip, take).
 * Conventions:
 * - search.keyword + searchColumn[] → where.OR contains (insensitive)
 * - search[col] = scalar → where[col] = scalar
 * - search[col] = string[] | number[] → where[col] = { in: [...] }
 * - search[col] = ['range:a-b'] → where[col] = { gte, lte }
 * - search[col] = [bool] → where[col] = bool
 * - field + order → orderBy[field] = 'asc' | 'desc'
 */
export const genDatatableQuery = (body: DatatableAjaxDto) => {
  const { pageSize, current, searchColumn, search, field, order } = body;
  const where: Record<string, any> = {};
  const orderBy: Record<string, any> = {};

  if (search) {
    Object.keys(search).forEach((key) => {
      const value = search[key];
      if (value == null) return;

      if (key === 'keyword') {
        const OR = (searchColumn || []).map((col) => ({
          [col]: { contains: value, mode: 'insensitive' },
        }));
        if (OR.length > 0) where.OR = OR;
        return;
      }

      if (Array.isArray(value)) {
        if (value.length === 0) return;
        if (typeof value[0] === 'string' || typeof value[0] === 'number') {
          if (typeof value[0] === 'string' && value[0].startsWith('range:')) {
            const [begin, end] = value[0].replace('range:', '').split('-');
            const obj: { gte?: number | bigint; lte?: number | bigint } = { gte: safeParse(begin) };
            if (end) obj.lte = safeParse(end);
            where[key] = obj;
          } else {
            where[key] = { in: value };
          }
        } else if (typeof value[0] === 'boolean' && value.length === 1) {
          where[key] = value[0];
        }
      } else {
        where[key] = value;
      }
    });
  }

  if (field && order) orderBy[field] = order.replace('end', '');

  return { take: pageSize, skip: (current - 1) * pageSize, where, orderBy };
};

/** Coerce snowflake-string FK → BigInt for Prisma. */
export const coerceBigIntKeys = (where: any, keys: Iterable<string>): Record<string, any> => {
  const out: Record<string, any> = { ...(where || {}) };
  const set = keys instanceof Set ? keys : new Set(keys);
  for (const k of Object.keys(out)) {
    if (!set.has(k)) continue;
    const v = out[k];
    if (typeof v === 'string') out[k] = BigInt(v);
    else if (v && typeof v === 'object' && Array.isArray(v.in)) {
      out[k] = { in: v.in.map((x: any) => (typeof x === 'string' ? BigInt(x) : x)) };
    }
  }
  return out;
};
```

### 4.4 `datatable.pipe.ts`

```ts
import { ArgumentMetadata, BadRequestException, Injectable, PipeTransform } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { DatatableAjaxDto } from './datatable.dto';
import { genDatatableQuery } from './datatable.helper';

@Injectable()
export class DatatableQueryPipe implements PipeTransform {
  transform(value: any, _metadata: ArgumentMetadata) {
    const dto = plainToInstance(DatatableAjaxDto, value, { enableImplicitConversion: true });
    const errors = validateSync(dto, { whitelist: true, forbidNonWhitelisted: false });
    if (errors.length > 0) throw new BadRequestException(errors);
    return genDatatableQuery(dto);
  }
}
```

---

## 5. Datatable — Mongoose flavor (NEW)

> **REFERENCE IMPL** — verify on first usage. Same DTO + decorator. Helper + pipe shift to Mongoose-style `{filter, sort, skip, limit}`.

### 5.1 DTO + decorator

Reuse `DatatableAjaxDto` + `DatatableQuery` from sections 4.1 and 4.2 unchanged.

### 5.2 `datatable.helper.mongoose.ts`

```ts
import { DatatableAjaxDto } from './datatable.dto';
import { Types } from 'mongoose';

export type DataTableResult<T> = {
  data: T[];
  total: number;
  pageSize: number | undefined;
  current: number;
};

export type MongoQueryArgs = {
  filter: Record<string, any>;
  sort: Record<string, 1 | -1>;
  skip: number;
  limit: number;
};

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Convert DatatableAjaxDto → Mongoose query args.
 * Mapping:
 * - search.keyword + searchColumn[] → { $or: [{col: {$regex: kw, $options: 'i'}}] }
 * - search[col] = scalar → filter[col] = scalar
 * - search[col] = string[] | number[] → filter[col] = { $in: [...] }
 * - search[col] = ['range:a-b'] → filter[col] = { $gte, $lte }
 * - search[col] = [bool] → filter[col] = bool
 * - field + order → sort[field] = order === 'ascend' ? 1 : -1
 */
export const genDatatableQueryMongoose = (body: DatatableAjaxDto): MongoQueryArgs => {
  const { pageSize, current, searchColumn, search, field, order } = body;
  const filter: Record<string, any> = {};
  const sort: Record<string, 1 | -1> = {};

  if (search) {
    Object.keys(search).forEach((key) => {
      const value = search[key];
      if (value == null) return;

      if (key === 'keyword') {
        const kw = String(value);
        const $or = (searchColumn || []).map((col) => ({
          [col]: { $regex: escapeRegex(kw), $options: 'i' },
        }));
        if ($or.length > 0) filter.$or = $or;
        return;
      }

      if (Array.isArray(value)) {
        if (value.length === 0) return;
        if (typeof value[0] === 'string' || typeof value[0] === 'number') {
          if (typeof value[0] === 'string' && value[0].startsWith('range:')) {
            const [begin, end] = (value[0] as string).replace('range:', '').split('-');
            const obj: { $gte?: number; $lte?: number } = { $gte: Number(begin) };
            if (end) obj.$lte = Number(end);
            filter[key] = obj;
          } else {
            filter[key] = { $in: value };
          }
        } else if (typeof value[0] === 'boolean' && value.length === 1) {
          filter[key] = value[0];
        }
      } else {
        filter[key] = value;
      }
    });
  }

  if (field && order) sort[field] = order === 'ascend' ? 1 : -1;

  return {
    filter,
    sort,
    skip: (current - 1) * pageSize,
    limit: pageSize,
  };
};

/** Coerce string ObjectId → ObjectId for Mongoose. Mongoose equivalent of coerceBigIntKeys. */
export const coerceObjectIdKeys = (
  filter: any,
  keys: Iterable<string>,
): Record<string, any> => {
  const out: Record<string, any> = { ...(filter || {}) };
  const set = keys instanceof Set ? keys : new Set(keys);
  for (const k of Object.keys(out)) {
    if (!set.has(k)) continue;
    const v = out[k];
    if (typeof v === 'string' && Types.ObjectId.isValid(v)) {
      out[k] = new Types.ObjectId(v);
    } else if (v && typeof v === 'object' && Array.isArray(v.$in)) {
      out[k] = {
        $in: v.$in.map((x: any) =>
          typeof x === 'string' && Types.ObjectId.isValid(x) ? new Types.ObjectId(x) : x,
        ),
      };
    }
  }
  return out;
};
```

### 5.3 `datatable.pipe.mongoose.ts`

```ts
import { ArgumentMetadata, BadRequestException, Injectable, PipeTransform } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { DatatableAjaxDto } from './datatable.dto';
import { genDatatableQueryMongoose } from './datatable.helper.mongoose';

@Injectable()
export class DatatableQueryMongoosePipe implements PipeTransform {
  transform(value: any, _metadata: ArgumentMetadata) {
    const dto = plainToInstance(DatatableAjaxDto, value, { enableImplicitConversion: true });
    const errors = validateSync(dto, { whitelist: true, forbidNonWhitelisted: false });
    if (errors.length > 0) throw new BadRequestException(errors);
    return genDatatableQueryMongoose(dto);
  }
}
```

### 5.4 Service usage (Mongoose)

```ts
async datatable(query: MongoQueryArgs): Promise<DataTableResult<UserDoc>> {
  const { filter, sort, skip, limit } = query;
  const [data, total] = await Promise.all([
    this.userModel.find(filter).sort(sort).skip(skip).limit(limit).lean(),
    this.userModel.countDocuments(filter),
  ]);
  return { data, total, pageSize: limit, current: Math.floor(skip / Math.max(limit, 1)) + 1 };
}
```

---

## 6. Controller skeleton

```ts
import {
  Controller, Get, Post, Patch, Delete, Body, Param, UseGuards,
} from '@nestjs/common';
import { UsersService } from './users.service';
import { CreateUserDto, UpdateUserDto, BulkUpdateUserDto } from './dto';
import { JwtAuthGuard, AdminGuard } from '../../shared/authentication';
import { BulkIdsDto } from '../../shared/dto';
import { DatatableQuery, DatatableQueryPipe } from '../../shared/datatable';
// Mongoose: import { DatatableQueryMongoosePipe } from '../../shared/datatable';

@UseGuards(JwtAuthGuard, AdminGuard)
@Controller('admin/users')
export class UsersAdminController {
  constructor(private readonly usersService: UsersService) {}

  @Post('ajax')
  datatable(@DatatableQuery(new DatatableQueryPipe()) query) {
    return this.usersService.datatable(query);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.usersService.findOne(BigInt(id));   // Mongoose: keep id as string
  }

  @Post()
  create(@Body() dto: CreateUserDto) {
    return this.usersService.create(dto);
  }

  @Patch('bulk')
  updateMulti(@Body() dto: BulkUpdateUserDto) {
    return this.usersService.updateMulti(
      dto.ids.map((id) => BigInt(id)),
      dto.data,
    );
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateUserDto) {
    return this.usersService.update(BigInt(id), dto);
  }

  @Delete('bulk')
  deleteMulti(@Body() dto: BulkIdsDto) {
    return this.usersService.deleteMulti(dto.ids.map((id) => BigInt(id)));
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.usersService.remove(BigInt(id));
  }
}
```

`BulkIdsDto` (`shared/dto/bulk-ids.dto.ts`):

```ts
import { ArrayNotEmpty, IsArray, IsString } from 'class-validator';

export class BulkIdsDto {
  @IsArray() @ArrayNotEmpty() @IsString({ each: true })
  ids!: string[];
}
```

`BulkUpdateUserDto` (per-module `dto/`):

```ts
import { Type } from 'class-transformer';
import { ValidateNested } from 'class-validator';
import { BulkIdsDto } from '../../../shared/dto';
import { UpdateUserDto } from './update-user.dto';

export class BulkUpdateUserDto extends BulkIdsDto {
  @ValidateNested() @Type(() => UpdateUserDto)
  data!: UpdateUserDto;
}
```

---

## 7. Service contract

### 7.1 Return-shape conventions

| Method | Returns | Wrapped into |
|---|---|---|
| `datatable()` | `DataTableResult<T>` | `{success, data, total, pageSize, current}` |
| `findOne()` / `create()` / `update()` | entity | `{success, data: entity}` |
| `updateMulti()` / `deleteMulti()` | `{count: n}` or similar | `{success, data: {count}}` |
| `remove()` | entity or `{deleted: true}` | `{success, data: ...}` |

The service MUST NOT wrap `{success, data}` itself — the interceptor does it. Throw `HttpException` for business errors; the filter handles the shape.

### 7.2 Skeleton (Prisma)

```ts
@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async datatable(query: ReturnType<typeof genDatatableQuery>): Promise<DataTableResult<User>> {
    const { where, orderBy, skip, take } = query;
    const safeWhere = coerceBigIntKeys(where, ['id', 'created_by']);
    const [data, total] = await Promise.all([
      this.prisma.users.findMany({ where: safeWhere, orderBy, skip, take }),
      this.prisma.users.count({ where: safeWhere }),
    ]);
    return { data, total, pageSize: take, current: Math.floor(skip / Math.max(take || 1, 1)) + 1 };
  }

  async findOne(id: bigint) {
    const user = await this.prisma.users.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  // create / update / updateMulti / deleteMulti / remove follow the same shape
}
```

---

## 8. Prisma vs Mongoose checklist

When cloning this pattern into a new project, tick through:

| Item | Prisma | Mongoose |
|---|---|---|
| ID type | `bigint` (snowflake) | `string` (ObjectId hex) |
| `AuthUser.id` | `bigint` | `string` |
| Controller `@Param('id')` cast | `BigInt(id)` | keep `string` |
| `JwtAuthGuard` user lookup | `prisma.users.findUnique` | `UserModel.findById(...).lean()` |
| `ApiKeyAuthGuard` setting lookup | `prisma.settings.findUnique` | `SettingModel.findOne(...).lean()` |
| Datatable helper | `genDatatableQuery` (Prisma where/orderBy) | `genDatatableQueryMongoose` (filter/sort/skip/limit) |
| Datatable pipe | `DatatableQueryPipe` | `DatatableQueryMongoosePipe` |
| Coerce IDs in filter | `coerceBigIntKeys` | `coerceObjectIdKeys` |
| Service datatable | `findMany + count` | `find().sort().skip().limit().lean() + countDocuments` |
| Search keyword case-insensitive | `{ contains, mode: 'insensitive' }` | `{ $regex: escapeRegex(kw), $options: 'i' }` |
| Range filter | `{ gte, lte }` | `{ $gte, $lte }` |
| In-array filter | `{ in: [...] }` | `{ $in: [...] }` |

Module wiring:
- Prisma: `imports: [PrismaModule]`
- Mongoose: `imports: [MongooseModule.forFeature([{ name: User.name, schema: UserSchema }])]`

---

## 9. Cross-links

- Generic NestJS pipeline / DI / module / testing: [`nestjs-patterns.md`](./nestjs-patterns.md)
- Prisma query patterns (raw, transactions, soft-delete): [`prisma-patterns.md`](./prisma-patterns.md)
- Mongoose schema / discriminator / hooks: [`mongoose-patterns.md`](./mongoose-patterns.md)
- Redis cache wrapper: [`redis-patterns.md`](./redis-patterns.md)
- Test templates: [`testing-patterns.md`](./testing-patterns.md)
- **Frontend counterpart** (axios interceptor that unwraps `{success, data}` envelope): [`../../frontend-development/resources/data-fetching.md`](../../frontend-development/resources/data-fetching.md) → section "Backend Response Envelope"
- Reference repo: `multisource-api/src/modules/users/users-admin.controller.ts`
