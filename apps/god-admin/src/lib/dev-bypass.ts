/**
 * God Admin — Dev-only login bypass
 *
 * Local development helper khi @gbox/db package + Postgres chưa restore
 * (god-admin app hiện stub `db = null`). KHÔNG được phép chạy production —
 * isDevBypassEnabled() trả false khi NODE_ENV=production bất kể env khác.
 *
 * Flow:
 *   1. POST /god-admin/login với email + password match GOD_ADMIN_DEV_EMAIL +
 *      GOD_ADMIN_DEV_PASSWORD → mintDevSessionToken() trả token có prefix
 *      DEV_BYPASS_TOKEN_PREFIX, set cookie gbox_session.
 *   2. godAuth middleware nhận diện token có prefix → skip DB, gắn
 *      req.godAdmin với mock user → next().
 *   3. Page handlers vẫn dùng `db = null` — handler nào touch DB sẽ vẫn
 *      crash riêng (out of scope của bypass).
 */

import { randomBytes } from 'crypto'
import type {
  SessionData,
  SessionUser,
} from '../../../../packages/core/src/modules/auth/session.js'

export const DEV_BYPASS_TOKEN_PREFIX = '__DEV_GOD__'

// Sentinel UUID — không trùng row thật trong DB (khi DB restore sau này).
const DEV_USER_ID = '00000000-0000-0000-0000-00000000d3ad'

export function isDevBypassEnabled(): boolean {
  if (process.env.NODE_ENV === 'production') return false
  return process.env.GOD_ADMIN_DEV_BYPASS === '1'
}

export function verifyDevCredentials(email: string, password: string): boolean {
  if (!isDevBypassEnabled()) return false
  const envEmail = (process.env.GOD_ADMIN_DEV_EMAIL ?? '').toLowerCase().trim()
  const envPassword = process.env.GOD_ADMIN_DEV_PASSWORD ?? ''
  if (!envEmail || !envPassword) return false
  return email.toLowerCase().trim() === envEmail && password === envPassword
}

export function mintDevSessionToken(): string {
  return DEV_BYPASS_TOKEN_PREFIX + randomBytes(32).toString('hex')
}

export function isDevSessionToken(token: string | null | undefined): boolean {
  return typeof token === 'string' && token.startsWith(DEV_BYPASS_TOKEN_PREFIX)
}

export function getDevMockUser(): SessionUser {
  return {
    id: DEV_USER_ID,
    email: (process.env.GOD_ADMIN_DEV_EMAIL ?? 'dev@gbox.local').toLowerCase().trim(),
    name: 'Dev God Admin',
    role: 'owner',
    avatarUrl: null,
  }
}

export function getDevMockSession(): SessionData {
  const now = new Date()
  const expiresAt = new Date(now.getTime() + 8 * 60 * 60 * 1000) // 8h
  return {
    user: getDevMockUser(),
    shopId: null,
    shopRole: null,
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
  }
}

/**
 * Mock Kysely-shaped DB cho dev mode.
 *
 * Lý do: page handlers god-admin gọi `db.selectFrom(...).where(...).execute()`
 * khắp nơi. Khi `@gbox/db` package chưa restore, gán `db = null` thì mọi
 * handler crash với TypeError. Mock này dùng Proxy — mọi method chain trả
 * về chính nó, terminal methods (execute / executeTakeFirst) trả về empty
 * array / undefined. Page render trống state thay vì crash.
 *
 * KHÔNG persist gì cả — mọi insert/update/delete đều silent no-op. Chỉ
 * dùng cho dev khi muốn xem UI shell. CRUD thực tế cần DB thật.
 */
export function createDevMockDb(): any {
  const handler: ProxyHandler<any> = {
    get(_target, prop) {
      // Tránh await await vô tình (proxy không phải Promise)
      if (prop === 'then' || prop === 'catch' || prop === 'finally') return undefined
      // Convert sang string/number (template literal, +, ==) → empty string
      if (prop === Symbol.toPrimitive) return () => ''
      if (prop === 'toString' || prop === 'valueOf') return () => ''
      if (prop === Symbol.iterator) return function* () {}
      if (typeof prop === 'symbol') return undefined
      // Terminal methods — trả Promise resolved
      if (prop === 'execute' || prop === 'stream') {
        return () => Promise.resolve([])
      }
      if (prop === 'executeTakeFirst') {
        return () => Promise.resolve(undefined)
      }
      if (prop === 'executeTakeFirstOrThrow') {
        // Trả mockDb thay vì throw để page render được. Caller gọi
        // .x.y tiếp vẫn ra proxy (Symbol.toPrimitive=''), tránh NPE.
        return () => Promise.resolve(mockDb)
      }
      // Mọi prop khác → trả callable proxy chính nó (chain tiếp)
      return mockDb
    },
    apply() {
      return mockDb
    },
  }
  const mockDb: any = new Proxy(function () {}, handler)
  return mockDb
}
