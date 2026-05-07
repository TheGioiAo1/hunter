# Mongoose Patterns (MongoDB)

## Schema Definition

```typescript
// src/modules/{feature}/schemas/{feature}.schema.ts
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose'
import { HydratedDocument, Types } from 'mongoose'

export type UserDocument = HydratedDocument<User>

@Schema({ timestamps: true, collection: 'users' })
export class User {
  @Prop({ required: true, trim: true })
  name: string

  @Prop({ required: true, unique: true, lowercase: true })
  email: string

  @Prop({ select: false })  // auto-exclude from queries
  password: string

  @Prop({ type: String, enum: ['user', 'admin'], default: 'user' })
  role: string

  @Prop({ type: Types.ObjectId, ref: 'Organization' })
  organization: Types.ObjectId

  @Prop({ type: [String], default: [] })
  tags: string[]

  @Prop({ type: Object, default: {} })
  metadata: Record<string, any>
}

export const UserSchema = SchemaFactory.createForClass(User)

// Compound index
UserSchema.index({ email: 1, organization: 1 }, { unique: true })
// Text index for search
UserSchema.index({ name: 'text', email: 'text' })
```

## Module Registration

```typescript
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: User.name, schema: UserSchema },
    ]),
  ],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
```

## Service Pattern

```typescript
@Injectable()
export class UsersService {
  constructor(
    @InjectModel(User.name) private userModel: Model<User>,
  ) {}

  async findAll(query: QueryUserDto) {
    const { page = 1, pageSize = 20, search, role } = query
    const filter: FilterQuery<User> = {
      ...(search && { $text: { $search: search } }),
      ...(role && { role }),
    }

    const [data, total] = await Promise.all([
      this.userModel
        .find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .lean(),
      this.userModel.countDocuments(filter),
    ])

    return { data, total, current: page, pageSize }
  }

  async findOne(id: string) {
    const user = await this.userModel.findById(id).lean()
    if (!user) throw new NotFoundException(`User ${id} not found`)
    return user
  }

  async create(dto: CreateUserDto) {
    try {
      return await this.userModel.create(dto)
    } catch (error) {
      if (error.code === 11000) {  // Duplicate key
        throw new ConflictException('Email already exists')
      }
      throw error
    }
  }

  async update(id: string, dto: UpdateUserDto) {
    const user = await this.userModel.findByIdAndUpdate(id, dto, { new: true }).lean()
    if (!user) throw new NotFoundException(`User ${id} not found`)
    return user
  }

  async remove(id: string) {
    const result = await this.userModel.findByIdAndDelete(id)
    if (!result) throw new NotFoundException(`User ${id} not found`)
    return { deleted: true }
  }
}
```

## Population (Relations)

```typescript
// Single populate
const user = await this.userModel
  .findById(id)
  .populate('organization', 'name logo')
  .lean()

// Nested populate
const post = await this.postModel
  .findById(id)
  .populate({
    path: 'author',
    select: 'name email',
    populate: { path: 'organization', select: 'name' },
  })
  .lean()

// Virtual populate (no ObjectId stored)
UserSchema.virtual('posts', {
  ref: 'Post',
  localField: '_id',
  foreignField: 'author',
})
```

## Aggregation

```typescript
// Stats by role
const stats = await this.userModel.aggregate([
  { $match: { createdAt: { $gte: startDate } } },
  { $group: { _id: '$role', count: { $sum: 1 } } },
  { $sort: { count: -1 } },
])

// Lookup (join)
const results = await this.orderModel.aggregate([
  { $match: { status: 'completed' } },
  { $lookup: {
    from: 'users',
    localField: 'userId',
    foreignField: '_id',
    as: 'user',
  }},
  { $unwind: '$user' },
  { $project: { total: 1, 'user.name': 1, 'user.email': 1 } },
])
```

## Performance Tips

- `.lean()` for read-only queries — returns plain JS object, ~5x faster
- `.select('field1 field2')` or `.select('-password')` — only fetch needed fields
- Index frequently queried fields: `@Prop({ index: true })`
- `countDocuments` + `find` in parallel with `Promise.all`
- Bulk operations: `insertMany`, `bulkWrite`
- `$text` index for full-text search

## Transactions (Replica Set required)

```typescript
const session = await this.connection.startSession()
try {
  session.startTransaction()

  const order = await this.orderModel.create([orderData], { session })
  await this.inventoryModel.updateMany(
    { productId: { $in: productIds } },
    { $inc: { stock: -1 } },
    { session },
  )

  await session.commitTransaction()
  return order[0]
} catch (error) {
  await session.abortTransaction()
  throw error
} finally {
  session.endSession()
}
```
