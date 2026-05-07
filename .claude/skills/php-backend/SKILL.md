---
name: php-backend
description: "Build PHP backends with Laravel (Eloquent + Sanctum + Redis + Horizon). Use for REST APIs, controllers, middleware, Eloquent models, validation, authentication, caching, queues, project structure."
argument-hint: "[feature or pattern]"
metadata:
  author: claudex-kit
  version: "1.0.0"
---

# PHP Backend — Laravel + Eloquent + Sanctum + Redis

## When to use

- Create controllers, middleware, routes (REST / API)
- Write Eloquent models + relationships + migrations
- Implement authentication (Sanctum for SPA/token, Passport for OAuth)
- Caching with Redis (`Illuminate\Support\Facades\Cache`)
- Validation via FormRequest classes
- Background jobs + queues (Horizon)
- Error handling, logging (Monolog), project structure

**Not for:** pure WordPress/Drupal themes (these are CMS, different idiom), static sites, or framework-less PHP scripts.

## Project Structure (Laravel 11)

```
app/
  Console/
    Commands/                   # artisan commands
  Exceptions/
    Handler.php                 # centralized error rendering
  Http/
    Controllers/
      Api/
        V1/
          AuthController.php
          UserController.php
    Middleware/
      EnsureTokenIsValid.php
    Requests/
      StoreUserRequest.php      # validation + authorization per endpoint
    Resources/
      UserResource.php          # response shaping (like DTO)
  Models/
    User.php
  Services/
    UserService.php             # business logic — NOT required by Laravel but idiomatic for non-trivial apps
  Repositories/
    UserRepository.php          # optional — wraps Eloquent for testability
  Jobs/
    SendWelcomeEmail.php
  Events/
    UserRegistered.php
  Listeners/
    SendWelcomeNotification.php
  Policies/
    UserPolicy.php              # authorization rules
bootstrap/
config/
  app.php, auth.php, cache.php, database.php, queue.php, sanctum.php, ...
database/
  migrations/
    2024_01_01_000000_create_users_table.php
  factories/
    UserFactory.php
  seeders/
    DatabaseSeeder.php
routes/
  api.php                       # API routes (prefix: /api)
  web.php                       # web routes
  console.php                   # artisan command routes
tests/
  Feature/                      # HTTP-level tests (with app bootstrap)
  Unit/                         # isolated logic tests
.env
composer.json
phpunit.xml
```

## Core patterns

### Routing

Keep routes thin. Controllers dispatch; services do work.

```php
// routes/api.php
use App\Http\Controllers\Api\V1\{AuthController, UserController};

Route::prefix('v1')->group(function () {
    Route::post('/auth/login', [AuthController::class, 'login']);
    Route::post('/auth/register', [AuthController::class, 'register']);

    Route::middleware('auth:sanctum')->group(function () {
        Route::get('/me', [AuthController::class, 'me']);
        Route::apiResource('users', UserController::class);
    });
});
```

### Controllers — thin

```php
namespace App\Http\Controllers\Api\V1;

use App\Http\Controllers\Controller;
use App\Http\Requests\StoreUserRequest;
use App\Http\Resources\UserResource;
use App\Services\UserService;

class UserController extends Controller
{
    public function __construct(private UserService $users) {}

    public function store(StoreUserRequest $request)
    {
        $user = $this->users->create($request->validated());
        return new UserResource($user);
    }

    public function show(int $id)
    {
        return new UserResource($this->users->findOrFail($id));
    }
}
```

### FormRequest — validation + authorization

```php
namespace App\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;

class StoreUserRequest extends FormRequest
{
    public function authorize(): bool
    {
        return $this->user()?->can('create', \App\Models\User::class) ?? false;
    }

    public function rules(): array
    {
        return [
            'email'    => ['required', 'email', 'unique:users,email'],
            'password' => ['required', 'string', 'min:8'],
            'role'     => ['sometimes', 'in:user,admin'],
        ];
    }

    public function messages(): array
    {
        return ['email.unique' => 'This email is already registered.'];
    }
}
```

### Services — business logic

```php
namespace App\Services;

use App\Models\User;
use Illuminate\Support\Facades\Hash;

class UserService
{
    public function create(array $data): User
    {
        return User::create([
            ...$data,
            'password' => Hash::make($data['password']),
        ]);
    }

    public function findOrFail(int $id): User
    {
        return User::findOrFail($id);
    }
}
```

### Eloquent Model

```php
namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Foundation\Auth\User as Authenticatable;
use Laravel\Sanctum\HasApiTokens;

class User extends Authenticatable
{
    use HasApiTokens, HasFactory;

    protected $fillable = ['email', 'password', 'role'];
    protected $hidden   = ['password', 'remember_token'];
    protected $casts    = [
        'email_verified_at' => 'datetime',
        'password'          => 'hashed',
    ];

    public function orders()
    {
        return $this->hasMany(Order::class);
    }
}
```

### Resource — response shaping

```php
namespace App\Http\Resources;

use Illuminate\Http\Resources\Json\JsonResource;

class UserResource extends JsonResource
{
    public function toArray($request): array
    {
        return [
            'id'         => $this->id,
            'email'      => $this->email,
            'role'       => $this->role,
            'created_at' => $this->created_at?->toIso8601String(),
        ];
    }
}
```

## Authentication — Sanctum (SPA + API tokens)

```php
// AuthController::login
public function login(LoginRequest $request)
{
    $user = User::where('email', $request->email)->first();
    if (!$user || !Hash::check($request->password, $user->password)) {
        throw ValidationException::withMessages([
            'email' => ['Invalid credentials.'],
        ]);
    }
    $token = $user->createToken('api')->plainTextToken;
    return response()->json(['token' => $token, 'user' => new UserResource($user)]);
}
```

Revoke on logout: `$request->user()->currentAccessToken()->delete();`

For OAuth / 3rd-party logins, use **Laravel Passport** instead.

## Caching — Redis

```php
use Illuminate\Support\Facades\Cache;

// Read-through with TTL
$user = Cache::remember("user:{$id}", now()->addMinutes(10), fn () => User::findOrFail($id));

// Invalidate on write
public function update(User $user, array $data): User
{
    $user->update($data);
    Cache::forget("user:{$user->id}");
    return $user->fresh();
}

// Rate limit
use Illuminate\Support\Facades\RateLimiter;
if (RateLimiter::tooManyAttempts("login:{$email}", 5)) {
    abort(429, 'Too many attempts.');
}
RateLimiter::hit("login:{$email}", 600); // 10-min window
```

Config: `config/cache.php` → default `'redis'`; `config/database.php` → redis connection.

## Queues + Jobs (Horizon)

```php
namespace App\Jobs;

use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\SerializesModels;

class SendWelcomeEmail implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable, SerializesModels;

    public int $tries = 3;
    public int $backoff = 60; // seconds

    public function __construct(public int $userId) {}

    public function handle(): void
    {
        $user = User::findOrFail($this->userId);
        Mail::to($user)->send(new WelcomeMail($user));
    }
}

// Dispatch:
SendWelcomeEmail::dispatch($user->id)->onQueue('emails');
```

Run workers via Horizon: `php artisan horizon`. Config in `config/horizon.php`.

## Events + Listeners (decouple side effects)

```php
// Event
class UserRegistered { public function __construct(public User $user) {} }

// Listener (can be queued)
class SendWelcomeNotification implements ShouldQueue
{
    public function handle(UserRegistered $event): void {
        SendWelcomeEmail::dispatch($event->user->id);
    }
}

// Dispatch from service:
event(new UserRegistered($user));
```

Listeners auto-wired if you use `EventServiceProvider::$listen` OR Laravel 11 auto-discovery.

## Error handling

Centralize in `app/Exceptions/Handler.php`:

```php
public function register(): void
{
    $this->renderable(function (ValidationException $e, $request) {
        if ($request->expectsJson()) {
            return response()->json([
                'message' => 'Validation failed',
                'errors'  => $e->errors(),
            ], 422);
        }
    });

    $this->renderable(function (ModelNotFoundException $e, $request) {
        if ($request->expectsJson()) {
            return response()->json(['message' => 'Not found'], 404);
        }
    });
}
```

Custom exceptions extend `\Exception` + implement `render()`:

```php
class BusinessRuleViolated extends \Exception {
    public function render($request) {
        return response()->json(['error' => $this->getMessage()], 409);
    }
}
```

## Migrations

```php
public function up(): void
{
    Schema::create('users', function (Blueprint $table) {
        $table->id();
        $table->string('email')->unique();
        $table->string('password');
        $table->string('role')->default('user');
        $table->timestamp('email_verified_at')->nullable();
        $table->rememberToken();
        $table->timestamps();

        $table->index('role');
    });
}

public function down(): void
{
    Schema::dropIfExists('users');
}
```

Run: `php artisan migrate`. Rollback: `php artisan migrate:rollback`. Reset for dev: `php artisan migrate:fresh --seed`.

**Rules:**
- ONE logical change per migration (adding column ≠ renaming table).
- Add-column + backfill + change-NOT-NULL in **3 separate migrations** on prod DBs with live traffic.
- Add indexes with `->index()` in the same migration as the column; don't forget `->unique()` where needed.

## Common pitfalls

- Writing business logic in controllers → extract to service once >20 lines or reused
- Over-eager use of facades in services → inject dependencies for testability
- `User::all()` in a controller listing endpoint → always paginate (`->paginate(20)`)
- Not using `$fillable` / `$guarded` → mass-assignment vulnerability
- Forgetting `use HasApiTokens` on User → Sanctum won't work
- Queue jobs holding Eloquent models without `SerializesModels` → stale data on retry
- N+1 queries — use `->with(['orders'])` eager-load, or install `beyondcode/laravel-query-detector` in dev
- Cache keys collide across envs → prefix with `config('app.env')` or use `Cache::tags()`
- `.env` committed to git → gitignore, rotate immediately if leaked
- Running `composer update` in prod → use `composer install --no-dev --optimize-autoloader`

## Testing

See `references/testing-patterns.md` — PHPUnit + Laravel's TestCase (RefreshDatabase, WithFaker), Pest as modern alternative, HTTP feature tests, factories, mocking Eloquent.
