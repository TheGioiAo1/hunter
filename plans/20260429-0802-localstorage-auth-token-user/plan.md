# Plan — Migrate auth token + user info sang localStorage (apps/accounts)

**Date:** 2026-04-29
**Scope:** `apps/accounts` 3 login flows + cross-app logout. Dual-write token, localStorage-only user.
**Research:** [R-01 backend shape](./research/researcher-01-backend-user-me-shape.md), [R-02 codebase impact](./research/researcher-02-codebase-login-impact.md)

## Mục tiêu
- Token JS-accessible qua `localStorage['gbox_token']` cho client SPA fetch, đồng thời GIỮ cookie `gbox_session` HttpOnly (5 server-side middleware phụ thuộc).
- User profile: chuyển hoàn toàn sang `localStorage['gbox_user']`, deprecate cookie `gbox_user`.
- Đồng bộ 3 login flow (email, 2FA, OAuth) — hiện 2FA + OAuth chưa ghi `gbox_user` (gap fix luôn).
- Logout xoá localStorage cross-app.

## Quyết định kiến trúc (đã chốt)
- **Phương án A — HTML interstitial:** server response HTML có inline `<script>` chạy `localStorage.setItem` rồi `location.replace(returnTo)`. Form POST no-JS-friendly giữ nguyên.
- **DUAL-WRITE token:** Set-Cookie `gbox_session` HttpOnly + `localStorage.setItem('gbox_token', token)`. Trade-off: XSS đọc được token từ localStorage — chấp nhận.
- **localStorage-only user:** strip `password`, `access_key` trước setItem. White-list field hiển thị.
- **Helper mới:** `apps/accounts/src/lib/login-success.ts` export `renderLoginSuccess(res, {token, user, returnTo})` — DRY.

## Phases

| # | File | Status |
|---|---|---|
| 01 | [Phase 01 — Helper + email login](./phase-01-shared-helper-and-email-login.md) | Pending |
| 02 | [Phase 02 — 2FA flow](./phase-02-2fa-flow-localstorage.md) | Pending |
| 03 | [Phase 03 — OAuth Google](./phase-03-oauth-google-localstorage.md) | Pending |
| 04 | [Phase 04 — Logout cross-app](./phase-04-logout-and-cross-app-clear.md) | Pending |

## Top-level risks
- **XSS token theft:** localStorage không HttpOnly → XSS payload có thể exfiltrate `gbox_token`. Cookie HttpOnly vẫn còn nên server auth không vỡ, nhưng attacker có thể dùng token raw gọi API trực tiếp. Cần CSP review + audit innerHTML usage trước rollout.
- **Dual-write inconsistency:** cookie & localStorage có thể out-of-sync (vd cookie bị clear mà localStorage còn). Mitigation: 401 handler client clear cả 2.
- **No-JS browser:** interstitial script không chạy → user kẹt. Mitigation: `<noscript><meta http-equiv="refresh">` fallback.
- **Cross-domain sync:** localStorage scoped per-origin. `accounts.gbox.co` set xong, `store-admin.gbox.co` mở sau cần tự fetch `/auth/me` lần đầu.
- **return_to bypass:** `location.replace(untrustedURL)` → open redirect. Phải validate qua existing `getReturnTo` allowlist.

## Unresolved questions (cần user xác nhận)
1. **(R-01 §6.1)** `UserService.DetailAsync` có strip `password` + `access_key` không? Nếu không, FE white-list bắt buộc.
2. **(R-01 §6.2)** Format `create_date` ISO có `Z` hay offset?
3. **(R-02 §6.1)** Token JS-accessible thực sự cần usecase gì? Nếu chỉ để fetch API → cookie credentials an toàn hơn, có thể bỏ dual-write.
4. **(R-02 §6.2)** `signup.ts` (L541) có nằm trong scope migration không?
5. **(R-02 §6.3)** `account-settings.ts` (L498, L547), `two-factor.ts` (L135) re-issue token — có cần update localStorage không?
6. **(R-02 §6.4)** Cross-domain sync strategy: chấp nhận mỗi subdomain tự fetch `/auth/me` lần đầu hay cần postMessage broadcast?
