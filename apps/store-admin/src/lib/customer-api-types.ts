/**
 * Customer Service types — bám sát BE Gbox-Customer-Service
 * (Models/LencamCustomer/CustomerSegment.cs + CustomerStats.cs).
 *
 * Field naming: BE dùng snake_case → giữ nguyên để render code trong
 * customer-segments.ts (đã expect shape DB Kysely cũ) hoạt động.
 */

// ─── CustomerSegment ────────────────────────────────────────────────────

export interface ApiCustomerSegment {
  id?: string
  shop_id?: string
  name?: string
  description?: string
  rules_json?: string
  created_at?: string
  updated_at?: string
  created_by?: string
  last_count?: number
  last_count_at?: string
}

export interface ApiSegmentRule {
  field: string
  op: string
  value?: string | number | boolean | null
}

export interface ApiSegmentRuleSet {
  combinator: 'and' | 'or'
  rules: ApiSegmentRule[]
}

export interface ApiSegmentListResponse {
  pagination?: { page?: number; limit?: number; count?: number }
  data?: ApiCustomerSegment[]
}

export interface ApiSegmentPreviewResponse {
  count: number
  sample?: ApiCustomer[]
}

export interface ApiSegmentApplyResponse {
  pagination?: { page?: number; limit?: number; count?: number }
  data?: ApiCustomer[]
}

// ─── Auto-summary ────────────────────────────────────────────────────────

export interface ApiSegmentPerf {
  avg_order_value?: number
  total_revenue?: number
  customer_count?: number
}

export interface ApiSegmentSummary {
  total: number
  new_30d: number
  new_this_month: number
  with_email: number
  with_phone: number
  with_managers: number
  // Stats-derived (0 nếu CustomerStats chưa sync từ Order Service)
  repeat_buyers: number
  high_value: number
  vip: number
  at_risk: number
  email_subscribers: number
  perf?: Record<string, ApiSegmentPerf>
}

// ─── Customer + Stats (subset cho FE — không phải full schema BE) ───────

export interface ApiCustomer {
  id?: string
  shop_id?: string
  email?: string
  first_name?: string
  last_name?: string
  full_name?: string
  phone?: string
  province?: string
  city?: string
  country_code?: string
  country_name?: string
  created_at?: string
  // Khi apply segment với include_stats=true → BE nhúng _stats vào doc
  _stats?: ApiCustomerStats
  [k: string]: unknown
}

export interface ApiCustomerStats {
  id?: string
  shop_id?: string
  customer_id?: string
  total_spent?: number
  orders_count?: number
  first_order_at?: string
  last_order_at?: string
  accepts_marketing?: boolean
  tags?: string[]
  currency?: string
  updated_at?: string
}
