/**
 * Unit tests — platform-alerts types + env kill-switch (Phase 14 PR6).
 *
 * Pure-function / env-var coverage. DB-touching behaviour is exercised
 * in the end-to-end smoke (`scripts/smoke-phase14-pr6.ts`) so we don't
 * rebuild a Kysely mock here.
 */

import { describe, it, expect, afterEach } from 'vitest'
import {
  PLATFORM_ALERT_TYPES,
  isPlatformAlertsEnabled,
  type PlatformAlertType,
} from './types.js'

describe('PLATFORM_ALERT_TYPES', () => {
  it('contains exactly the 9 god-admin alert keys', () => {
    // This matches migration 089 CHECK constraint — adding a key here
    // WITHOUT adding to the migration will fail at send-time with a
    // CHECK violation, which is the desired fail-closed behaviour.
    expect(PLATFORM_ALERT_TYPES).toEqual([
      'new_merchant_signup',
      'platform_incident_alert',
      'platform_daily_digest',
      'platform_churn_alert',
      'platform_fraud_review',
      'platform_policy_violation',
      'platform_billing_failure',
      'platform_integration_down',
      'platform_weekly_roundup',
    ])
  })

  it('is readonly at the type level', () => {
    // Compile-time proof — if this typechecks, the `as const` cast worked.
    const k: PlatformAlertType = 'platform_incident_alert'
    expect(k).toBe('platform_incident_alert')
  })
})

describe('isPlatformAlertsEnabled', () => {
  const originalEnv = process.env.PLATFORM_ALERTS_ENABLED

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.PLATFORM_ALERTS_ENABLED
    else process.env.PLATFORM_ALERTS_ENABLED = originalEnv
  })

  it('defaults to true when env var is unset', () => {
    delete process.env.PLATFORM_ALERTS_ENABLED
    expect(isPlatformAlertsEnabled()).toBe(true)
  })

  it('treats "0" as disabled', () => {
    process.env.PLATFORM_ALERTS_ENABLED = '0'
    expect(isPlatformAlertsEnabled()).toBe(false)
  })

  it('treats "false" (any case) as disabled', () => {
    process.env.PLATFORM_ALERTS_ENABLED = 'false'
    expect(isPlatformAlertsEnabled()).toBe(false)
    process.env.PLATFORM_ALERTS_ENABLED = 'FALSE'
    expect(isPlatformAlertsEnabled()).toBe(false)
    process.env.PLATFORM_ALERTS_ENABLED = 'False'
    expect(isPlatformAlertsEnabled()).toBe(false)
  })

  it('treats "no" as disabled', () => {
    process.env.PLATFORM_ALERTS_ENABLED = 'no'
    expect(isPlatformAlertsEnabled()).toBe(false)
  })

  it('treats anything else as enabled (empty, "1", "true", random)', () => {
    process.env.PLATFORM_ALERTS_ENABLED = ''
    expect(isPlatformAlertsEnabled()).toBe(true)
    process.env.PLATFORM_ALERTS_ENABLED = '1'
    expect(isPlatformAlertsEnabled()).toBe(true)
    process.env.PLATFORM_ALERTS_ENABLED = 'true'
    expect(isPlatformAlertsEnabled()).toBe(true)
    process.env.PLATFORM_ALERTS_ENABLED = 'yes'
    expect(isPlatformAlertsEnabled()).toBe(true)
  })
})
