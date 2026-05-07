# Researcher 02 — Codebase Login Impact (localStorage migration)

Phạm vi ảnh hưởng khi chuyển `gbox_session` (token) + `gbox_user` từ HTTP cookie sang `localStorage`. Mọi đường dẫn tuyệt đối.

---

## 1. Ba đường login trong `apps/accounts`

### 1.1 `apps/accounts/src/pages/login.ts` (password login)
- File: `D:\Code\gbox-platform\apps\accounts\src\pages\login.ts`
- Set cookie tại **L190–L193** (sau khi gọi `/auth/login` + `/auth/me`):
  - `serializeSessionCookie(accessToken, cookieOpts)` → `gbox_session` (HttpOnly).
  - `gbox_user=<JSON.stringify(userData)>; Path=/; Max-Age=30d; SameSite=Lax`.
- Redirect cuối: **L198** `res.redirect(returnTo || DEFAULT_POST_LOGIN)`.
- **Đây là handler DUY NHẤT trong accounts hiện đang ghi `gbox_user`.**

### 1.2 `apps/accounts/src/pages/login-2fa.ts` (TOTP / email OTP / backup)
- File: `D:\Code\gbox-platform\apps\accounts\src\pages\login-2fa.ts`
- Ba POST handler kết thúc 2FA:
  - TOTP verify: L321 `verifyTotpCode` → L343 `markSessionTwoFaVerified` → L352 `res.redirect(getReturnTo(req))`.
  - Email OTP verify: L515 `verifyEmailOtp` → L543 mark verified → L552 redirect.
  - Backup code verify: L649 mark verified → L658 redirect.
- **KHÔNG set Set-Cookie ở đây** (token đã có sẵn từ bước login.ts trước đó, chỉ flip cờ `two_fa_verified` trong DB).
- **KHÔNG gọi `/auth/me`** → hiện không có `gbox_user` được issue ở 2fa flow (vì login.ts đã issue trước rồi).

### 1.3 `apps/accounts/src/pages/oauth-google.ts` (Google OAuth callback)
- File: `D:\Code\gbox-platform\apps\accounts\src\pages\oauth-google.ts`
- Sau khi `createSession`: **L268** `res.setHeader('Set-Cookie', serializeSessionCookie(token, cookieOpts))` — chỉ set `gbox_session`.
- Nếu user enrolled 2FA → redirect `/accounts/login/2fa` (L283–L289).
- Nếu không → redirect tiếp xuống stores hub.
- **KHÔNG gọi `/auth/me` và KHÔNG set `gbox_user`** (grep không có match) → đây là gap so với login.ts password.

---

## 2. Layout HTML — `apps/accounts/src/layouts/auth-layout.ts`

- Hàm `authLayout({ title, content, wide?, noCard? })` trả về full HTML doctype. `content` là raw HTML string nhúng vào `<div class="card">`.
- **Đã hỗ trợ inject custom HTML** (kể cả `<script>`), không escape `content`. Trang interstitial "Đang đăng nhập..." chỉ cần truyền `content` chứa `<script>localStorage.setItem(...); location.replace(returnTo)</script>` là chạy được.
- Có flag `noCard: true` để render full-bleed (phù hợp interstitial loader minimal).

---

## 3. Cross-app consumers của cookie `gbox_session` / `gbox_user`

| App | File | Đọc cookie | Impact nếu BỎ cookie |
|---|---|---|---|
| store-admin | `apps\store-admin\src\middleware\store-auth.ts` L97 | `getSessionTokenFromCookies` (`gbox_session`) | **VỠ** — toàn bộ seller dashboard mất auth |
| store-admin | `apps\store-admin\src\middleware\session-auth.ts` L48 | `gbox_session` | **VỠ** |
| god-admin | `apps\god-admin\src\middleware\god-auth.ts` L263, L309, L323 | `gbox_session` (read + clear) | **VỠ** |
| supporter | `apps\supporter\src\middleware\staff-auth.ts` L86, L95 | `gbox_session` | **VỠ** |
| supporter | `apps\supporter\src\pages\login.ts` L172, L189, L202 | mint + clear `gbox_session` | Independent (own login) |
| accounts | `apps\accounts\src\server.ts` L219, L240, L248 + `pages/account-settings.ts`, `pages/stores.ts`, `pages/create-store.ts`, `pages/two-factor.ts`, `middleware/enforce-2fa.ts` | `gbox_session` (+ L248 đọc `gbox_user` để render welcome name) | **VỠ** nội bộ accounts |
| storefront | `apps\storefront\src\middleware\customer-session.ts` | `gbox_customer_session` (cookie KHÁC, scope per-shop) | KHÔNG ảnh hưởng — đây là cookie buyer riêng, không phải `gbox_session` |
| checkout | `apps\checkout\src\server.ts` L176 | chỉ đọc handoff token, không dùng `gbox_session` | KHÔNG ảnh hưởng |
| god-admin | `apps\god-admin\src\pages\login.ts`, `login-2fa.ts`, `users.ts`, `settings-2fa.ts` | mint + clear `gbox_session` (own login) | Independent |

**Kết luận quan trọng:** Mọi guard cross-app (store-admin, god-admin, supporter) đều dùng `getSessionTokenFromCookies(req.headers.cookie)` chạy server-side trước khi render. Nếu bỏ cookie `gbox_session` → toàn bộ middleware này 401 và redirect login → **không khả thi bỏ cookie**.

`gbox_user` chỉ được consume ở 1 chỗ duy nhất: `apps\accounts\src\server.ts` L248 (welcome name trên `/`). Bỏ cookie `gbox_user` an toàn hơn rất nhiều.

---

## 4. Logout flow

### accounts
- `apps\accounts\src\server.ts` L218–L226 — GET `/accounts/logout`:
  ```
  deleteSession(db, token)
  res.setHeader('Set-Cookie', clearSessionCookie(isProd))
  res.redirect('/accounts/login')
  ```
  → KHÔNG clear `gbox_user` (Max-Age=0). Đây là bug nhỏ hiện tại (cookie `gbox_user` sống 30d).

### god-admin
- `apps\god-admin\src\middleware\god-auth.ts` L309, L323 và `apps\god-admin\src\pages\login.ts` L362, L615 — clear `gbox_session` qua `clearSessionCookie`/`buildSessionClearCookie`.

### supporter
- `apps\supporter\src\pages\login.ts` L202 — clear `gbox_session`.

### storefront / checkout
- Không có endpoint logout dùng `gbox_session`.

**Inject script clear localStorage:** trang `/accounts/login` (GET) hiện trả `authLayout(...)`. Có thể chèn 1 inline `<script>` ở đầu `content` của login page (hoặc ở interstitial logout-success) để gọi `localStorage.removeItem('gbox_token'); localStorage.removeItem('gbox_user')`. Nhưng vì cross-app guard vẫn dùng cookie → **localStorage chỉ là copy, server-side clear cookie vẫn là canonical**.

---

## 5. Khuyến nghị quyết định

**DUAL-WRITE (giữ cookie + thêm localStorage)** — KHÔNG được bỏ cookie.

Lý do:
1. 5 middleware cross-app (`store-admin/store-auth`, `store-admin/session-auth`, `god-admin/god-auth`, `supporter/staff-auth`, `accounts/enforce-2fa`) chạy server-side trước React/SSR và **chỉ biết đọc cookie**. Không thể đọc localStorage từ server.
2. `gbox_session` HttpOnly là yêu cầu bảo mật (chống XSS đọc token). Bỏ HttpOnly để JS-readable sẽ làm yếu auth.
3. `gbox_user` thì có thể migrate hoàn toàn sang localStorage vì chỉ 1 consumer (accounts root welcome) — refactor consumer đó đọc lại từ `/auth/me` hoặc localStorage.

Đề xuất plan:
- **Token**: giữ nguyên cookie `gbox_session` HttpOnly là canonical. Thêm 1 endpoint server-side render interstitial sau login/2fa/oauth, inline `<script>` ghi `localStorage.setItem('gbox_token', '<%= token %>')` cho client-side fetch (nếu thực sự cần JS-accessible token). Cân nhắc rủi ro XSS — chỉ làm khi có usecase cụ thể.
- **User profile**: chuyển sang localStorage-only. Bỏ `gbox_user` cookie (Max-Age=0 ở login.ts + logout). Cập nhật `apps\accounts\src\server.ts` L248 đọc từ localStorage qua client script HOẶC fetch lại `/auth/me`.
- **Login flow đồng bộ**: thêm interstitial page sau cả 3 đường (login.ts, login-2fa.ts last-step, oauth-google.ts non-2fa branch) — hiện oauth-google + login-2fa **chưa hề ghi `gbox_user`**, nên migration này cũng là dịp fix gap đó.
- **Logout**: thêm interstitial trước redirect để clear localStorage; vẫn giữ server-side `clearSessionCookie`.

---

## 6. Unresolved questions

1. Token JS-accessible có thực sự cần? Nếu chỉ để gọi API từ browser SPA → có thể dùng cookie credentials thay vì localStorage (an toàn hơn). Cần xác nhận usecase với product.
2. `apps\accounts\src\pages\signup.ts` (L541) cũng issue `gbox_session` sau verify OTP — có cần đồng bộ interstitial cho signup không? (Ngoài scope question gốc nhưng nên cover.)
3. `apps\accounts\src\pages\account-settings.ts` L498, L547 và `two-factor.ts` L135 cũng re-issue session token (sau đổi password / enable 2FA) — sau migration, có cần update localStorage tương ứng không?
4. Cross-domain: cookie `gbox_session` set `Domain=.gbox.co` nên dùng chung tất cả app. localStorage scoped per-origin → mỗi subdomain (accounts/store-admin/god-admin/supporter) có copy localStorage riêng → cần chiến lược sync (interstitial chỉ chạy trên `accounts.gbox.co`, các app khác lấy lại bằng cách gọi `/auth/me` lần đầu).
