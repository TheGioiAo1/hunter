/**
 * Tests for the activity action taxonomy helpers.
 */

import { describe, it, expect } from 'vitest'
import { categorizeAction, humanizeAction } from './types.js'

describe('categorizeAction', () => {
  it('classifies destructive and failure actions as danger', () => {
    expect(categorizeAction('login_failed')).toBe('danger')
    expect(categorizeAction('product_deleted')).toBe('danger')
    expect(categorizeAction('user_suspended')).toBe('danger')
    expect(categorizeAction('order_cancelled')).toBe('danger')
    expect(categorizeAction('store_disable')).toBe('danger')
    expect(categorizeAction('admin_banned')).toBe('danger')
    expect(categorizeAction('refund_rejected')).toBe('danger')
    expect(categorizeAction('session_revoked')).toBe('danger')
    expect(categorizeAction('otp_locked')).toBe('danger')
    expect(categorizeAction('dispute_lost')).toBe('danger')
  })

  it('classifies success and creation actions as success', () => {
    expect(categorizeAction('product_created')).toBe('success')
    expect(categorizeAction('login_success')).toBe('success')
    expect(categorizeAction('order_paid')).toBe('success')
    expect(categorizeAction('order_fulfilled')).toBe('success')
    expect(categorizeAction('order_shipped')).toBe('success')
    expect(categorizeAction('order_delivered')).toBe('success')
    expect(categorizeAction('signup_completed')).toBe('success')
    expect(categorizeAction('admin_promoted')).toBe('success')
    expect(categorizeAction('dispute_won')).toBe('success')
  })

  it('classifies mutation actions as warning', () => {
    expect(categorizeAction('product_updated')).toBe('warning')
    expect(categorizeAction('inventory_adjusted')).toBe('warning')
    expect(categorizeAction('password_changed')).toBe('warning')
    expect(categorizeAction('order_refunded')).toBe('warning')
    expect(categorizeAction('admin_demoted')).toBe('warning')
  })

  it('classifies unknown or neutral actions as info', () => {
    expect(categorizeAction('admin_action')).toBe('info')
    expect(categorizeAction('foo_bar')).toBe('info')
    expect(categorizeAction('')).toBe('info')
  })

  it('is case-insensitive', () => {
    expect(categorizeAction('PRODUCT_DELETED')).toBe('danger')
    expect(categorizeAction('Order_Paid')).toBe('success')
  })

  it('prioritizes danger signals over success signals', () => {
    // "signup_failed" contains both "signup" (success) and "fail" (danger).
    expect(categorizeAction('signup_failed')).toBe('danger')
  })
})

describe('humanizeAction', () => {
  it('converts snake_case to a sentence', () => {
    expect(humanizeAction('product_deleted')).toBe('Product deleted')
    expect(humanizeAction('order_partially_refunded')).toBe(
      'Order partially refunded',
    )
  })

  it('capitalizes a single-word action', () => {
    expect(humanizeAction('logout')).toBe('Logout')
  })

  it('handles empty strings', () => {
    expect(humanizeAction('')).toBe('')
  })

  it('collapses multiple underscores', () => {
    expect(humanizeAction('foo__bar')).toBe('Foo  bar')
  })
})
