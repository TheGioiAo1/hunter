/**
 * Mongo document types for the auth path. Field names are snake_case to
 * minimise diff vs the legacy Postgres schema. `_id` is a string (nanoid)
 * so app code can keep treating user ids / session ids etc. as opaque
 * strings.
 */

export interface UserDoc {
  _id: string
  email: string
  name: string | null
  password_hash: string | null
  role: string                       // 'owner' | 'admin' | 'staff'
  status: 'active' | 'pending_verification' | 'disabled'
  is_default_admin?: boolean
  avatar_url?: string | null
  password_reset_token?: string | null
  password_reset_expires?: string | null
  created_at: string
  updated_at: string
}

export interface SessionDoc {
  _id: string
  user_id: string
  token_hash: string
  ip_address: string | null
  user_agent: string | null
  expires_at: string
  created_at: string
  two_fa_verified?: boolean
}

export interface UserShopDoc {
  _id: string
  user_id: string
  shop_id: string
  role: string                       // 'owner' | 'admin' | 'editor' | 'viewer'
  created_at: string
}

export interface ShopDoc {
  _id: string
  name: string
  slug: string
  domain: string | null
  email?: string | null
  currency: string
  timezone?: string
  plan?: string
  status: 'active' | 'inactive' | 'suspended'
  created_at: string
}

export interface AuditLogDoc {
  _id: string
  user_id: string | null
  shop_id: string | null
  action: string
  resource_type: string
  resource_id: string | null
  details: string                    // JSON-encoded
  ip_address: string | null
  created_at: string
}

export interface TwoFactorDoc {
  _id: string                        // == user_id (1:1)
  user_id: string
  totp_secret: string
  enabled: boolean
  enabled_at: string | null
  backup_codes_hashes: (string | null)[]
  email_otp_hash: string | null
  email_otp_expires_at: string | null
  email_otp_attempts: number
  last_used_at: string | null
  updated_at: string
}

export interface ApiTokenDoc {
  _id: string
  user_id: string
  shop_id: string
  name: string
  token_hash: string
  scopes: string | null              // JSON-encoded array
  last_used_at: string | null
  created_at: string
}
