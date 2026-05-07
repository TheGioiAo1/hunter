/**
 * Auto-segment key → ruleset map. Mirror 6 buckets render trong
 * customer-segments.ts auto cards. Dùng cho filter customers list khi
 * URL có `?segment=<key>`.
 *
 * Sync với customer-segments.ts segments[] khi đổi định nghĩa bucket.
 */

import type { ApiSegmentRuleSet } from './customer-api-types.js'

const days = (n: number) => new Date(Date.now() - n * 86400_000).toISOString()

export function buildAutoSegmentRules(key: string): ApiSegmentRuleSet | null {
  switch (key) {
    case 'repeat':
      return { combinator: 'and', rules: [{ field: 'orders_count', op: 'greater_than', value: 1 }] }
    case 'high-value':
      return { combinator: 'and', rules: [{ field: 'total_spent', op: 'greater_than', value: 200 }] }
    case 'vip':
      return { combinator: 'and', rules: [{ field: 'total_spent', op: 'greater_than', value: 500 }] }
    case 'new':
      return { combinator: 'and', rules: [{ field: 'created_at', op: 'after', value: days(30) }] }
    case 'at-risk':
      return { combinator: 'and', rules: [{ field: 'last_order_at', op: 'before', value: days(90) }] }
    case 'email-subscribers':
      return { combinator: 'and', rules: [{ field: 'accepts_marketing', op: 'equals', value: true }] }
    // 'all' → null = no ruleset, caller fall back to listCustomers root
    default:
      return null
  }
}

export const AUTO_SEGMENT_LABELS: Record<string, string> = {
  all: 'All Customers',
  repeat: 'Repeat Buyers',
  'high-value': 'High Value',
  vip: 'VIP Customers',
  new: 'New Customers',
  'at-risk': 'At Risk',
  'email-subscribers': 'Email Subscribers',
}
