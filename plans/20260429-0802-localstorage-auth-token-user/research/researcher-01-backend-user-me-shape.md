# Research 01 – Backend `/api/user/me` Response Shape

**Ngày:** 2026-04-29
**Scope:** Xác định shape response của `GET /api/user/me` trên Gbox Auth Service và auth scheme đi kèm.

---

## 1. Stack backend

- **.NET (ASP.NET Core Web API, C#)** – namespace gốc `Lencam_Auth_Service_New` (legacy name, repo hiện tại là `Gbox-Auth-Service`).
- Persistence: MongoDB (`MongoDB.Driver`, `[BsonId]`, `[BsonIgnoreExtraElements]`).
- JWT: `System.IdentityModel.Tokens.Jwt` (`JwtSecurityTokenHandler`).

Citation: `D:/Gbox/Gbox-Auth-Service/Gbox-Auth-Service/Controllers/UserController.cs:1-15`, `D:/Gbox/Gbox-Auth-Service/Gbox-Auth-Service/Models/LencamAuth/User.cs:1-10`.

---

## 2. Endpoint `/api/user/me`

| Item | Value |
|---|---|
| Method | `GET` |
| Full path | `/api/user/me` (base prod: `https://api-auth.gbox.co/api/user/me`) |
| Controller-level attribute | `[Authorize]` (mặc định JWT Bearer) |
| Method-level attribute | `[HttpGet("me"), Authorize(Policy = "App", Roles = "owners,read_user")]` |
| Auth header | `Authorization: Bearer <access_token>` |
| Body | none |
| Success | `200 OK` + JSON `User` object |
| Error | `400 BadRequest` với `{ status: false, message: string }` (catch nội bộ) |

Citation: `UserController.cs:17-54` (line 32: `[HttpGet("me"),Authorize(Policy = "App",Roles = "owners,read_user")]`).

> Chú ý: vì có `Roles = "owners,read_user"`, một JWT hợp lệ nhưng thiếu role này sẽ bị middleware trả `403 Forbidden` (chứ không phải 401). 401 chỉ xảy ra khi token thiếu/hết hạn/sai chữ ký.

---

## 3. Response shape `/api/user/me`

Server gọi `UserService.DetailAsync(...).FirstOrDefault()` và `return Ok(_rs)` – tức trả về thẳng object `User` (không có wrapper). Nhờ `[DataMember(EmitDefaultValue = false)]`, **các field `null` sẽ bị bỏ khỏi JSON**.

| Field | Type (JSON) | Nullable | Mô tả |
|---|---|---|---|
| `id` | string (Mongo ObjectId 24-hex) | có | User id |
| `email` | string | có | Email đăng nhập |
| `password` | string | có | **Lưu ý:** model có field này; thực tế DetailAsync project bỏ – cần verify (xem §6) |
| `first_name` | string | có | Tên |
| `last_name` | string | có | Họ |
| `full_name` | string (read-only, computed) | có | `first_name + " " + last_name` |
| `phone` | string | có | SĐT |
| `is_active` | boolean | có | Đã kích hoạt email chưa (default `false`) |
| `role` | string | có | Role chuỗi (vd `"owners"`, `"read_user"`) |
| `avatar` | string | có | URL/path ảnh đại diện (raw – không có host) |
| `access_key` | string | có | Secret kích hoạt / reset – KHÔNG nên expose ra FE |
| `create_date` | string (ISO 8601 DateTime) | có | Ngày tạo |
| `update_date` | string (ISO 8601 DateTime) | có | Ngày cập nhật |
| `ref_id` | string | có | Id người giới thiệu |

**Không có** các field `is_default_admin`, `avatar_url`, `created_at`, `updated_at`, `tenant_id` – tên thực tế là `create_date`/`update_date`/`avatar`. FE cần map theo đúng snake_case này.

Citation: `D:/Gbox/Gbox-Auth-Service/Gbox-Auth-Service/Models/LencamAuth/User.cs:11-56`; generated client `D:/Code/gbox-platform/packages/api-client/src/auth/models/User.ts:6-21` (khớp 1-1, plus `full_name` đánh dấu `readonly`).

---

## 4. Token shape sau `POST /api/token`

Endpoint: `POST /api/token` (controller `TokenController`, không có `[Authorize]` – public). Body: `User { email, password }` (JSON).

Response 200:

```json
{
  "access_token": "<jwt-string>",
  "expires": 1735689600
}
```

| Field | Type | Mô tả |
|---|---|---|
| `access_token` | string (JWT) | Bearer token |
| `expires` | number | Unix epoch **seconds** (UTC), từ `jwt.ValidTo`. KHÔNG phải `expires_in` (delta) mà là absolute epoch. |

**Không có** `refresh_token`, **không có** `token_type`, **không có** `expires_in`. FE cần tự suy `token_type = "Bearer"` và tự tính TTL = `expires - now`.

Error: `400 BadRequest` + `{ status: false, message: "Login failed!" | "Account is not active!" }`.

Citation: `D:/Gbox/Gbox-Auth-Service/Gbox-Auth-Service/Controllers/TokenController.cs:30-66` (line 52-56).

---

## 5. Status code khi token sai/hết hạn

| Tình huống | Status |
|---|---|
| Không có header `Authorization` | `401 Unauthorized` (do `[Authorize]` + JwtBearer middleware) |
| Token sai chữ ký / hết hạn (`exp` < now) | `401 Unauthorized` |
| Token hợp lệ nhưng role không thuộc `owners,read_user` | `403 Forbidden` |
| Token hợp lệ + role hợp lệ nhưng exception runtime | `400 BadRequest` + `RsMessage` |

Suy luận từ ASP.NET Core JwtBearer mặc định + `[Authorize(Roles=...)]`. Không thấy custom 401 handler trong file controller; nếu có middleware override thì cần check `Program.cs`/`Startup.cs` (xem §6).

---

## 6. Unresolved questions

1. **`password` & `access_key` có thực sự bị strip trong `UserService.DetailAsync` không?** Nếu projection không loại 2 field này, FE sẽ nhận password hash – rủi ro bảo mật. Cần đọc `Services/UserService.cs` (`DetailAsync`).
2. **Format `create_date` / `update_date`**: ASP.NET serialize `DateTime?` mặc định ra ISO 8601 (`"2025-04-29T08:02:00Z"`); cần confirm có `Z` hay timezone offset.
3. **JWT bearer scheme name** trong `Program.cs` để FE biết có khác `Bearer` không (mặc định là `Bearer`).
4. **Swagger v1 JSON** chưa fetch (giới hạn 5 tool call). URL kỳ vọng: `https://api-auth.gbox.co/swagger/v1/swagger.json`.
5. **CORS / preflight**: FE gọi từ `localStorage` flow cần biết origin nào được allow – chưa verify.

---

## 7. Tóm tắt dùng cho FE plan

- Header: `Authorization: Bearer <access_token>`
- `GET /api/user/me` → flat `User` object snake_case (xem bảng §3); fields có thể `undefined` (bị strip do `EmitDefaultValue = false`).
- Login: `POST /api/token` body `{ email, password }` → `{ access_token, expires (epoch seconds) }`. **Tự derive expiry**, không có refresh token.
- 401 = token invalid/expired → FE phải clear localStorage + redirect login.
- 403 = thiếu role → KHÔNG nên clear token (user đã login đúng), chỉ show "không đủ quyền".
- FE nên **white-list** field hiển thị (`id, email, first_name, last_name, full_name, avatar, role, is_active`) thay vì spread full object để tránh leak `password`/`access_key` nếu BE chưa strip.
