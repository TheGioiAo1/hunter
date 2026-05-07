/**
 * Unit tests for middleware/email-webhook-routes.ts
 *
 * We drive the route via supertest against a minimal Express app. The
 * handler deps are mocked — every test proves exact HTTP-layer behaviour
 * (status code, JSON body, body-parser integration) for a given handler
 * verdict. End-to-end DB integration lives in scripts/smoke-phase14-pr4b.ts.
 */

import crypto from 'node:crypto'
import express from 'express'
import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'
import type {
  HandleGenericWebhookResult,
  HandleSnsWebhookResult,
} from '@gbox/core/modules/email/webhook-handler.js'

import {
  buildEmailWebhookRoutes,
  type EmailWebhookRoutesDeps,
} from './email-webhook-routes.js'

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type Overrides = Partial<EmailWebhookRoutesDeps>

function buildApp(overrides: Overrides = {}): express.Express {
  const deps: EmailWebhookRoutesDeps = {
    handleSnsWebhook: vi.fn(async () => ({
      ok: true,
      outcome: 'processed',
      eventId: 1,
      matchedDeliveryId: null,
      matchedShopId: null,
      eventsCreated: 0,
      suppressionsCreated: 0,
      signatureVerified: true,
    } as HandleSnsWebhookResult)),
    handleGenericWebhook: vi.fn(async () => ({
      ok: true,
      outcome: 'processed',
      eventId: 2,
      matchedDeliveryId: null,
      matchedShopId: null,
      eventsCreated: 0,
      suppressionsCreated: 0,
    } as HandleGenericWebhookResult)),
    confirmSubscriptionUrl: vi.fn(async () => undefined),
    getGenericSecret: () => 'test-secret',
    ...overrides,
  }
  const app = express()
  app.use(buildEmailWebhookRoutes(deps))
  return app
}

function hmacSign(secret: string, body: string): string {
  return crypto.createHmac('sha256', secret).update(body).digest('base64')
}

// ---------------------------------------------------------------------------
// POST /webhooks/email/ses
// ---------------------------------------------------------------------------

describe('POST /webhooks/email/ses — success paths', () => {
  it('returns 200 + processed outcome on a Notification', async () => {
    const app = buildApp()
    const res = await request(app)
      .post('/webhooks/email/ses')
      .set('Content-Type', 'application/json')
      .send({ Type: 'Notification', MessageId: 'abc' })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      ok: true,
      outcome: 'processed',
      eventId: 1,
    })
  })

  it('returns 200 + replayed outcome for dedup hits', async () => {
    const app = buildApp({
      handleSnsWebhook: vi.fn(async () => ({
        ok: true,
        outcome: 'replayed',
        eventId: 99,
      } as HandleSnsWebhookResult)),
    })
    const res = await request(app)
      .post('/webhooks/email/ses')
      .send({ Type: 'Notification', MessageId: 'already-seen' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, outcome: 'replayed', eventId: 99 })
  })

  it('returns 200 + fires confirm URL for SubscriptionConfirmation', async () => {
    const confirm = vi.fn(async () => undefined)
    const app = buildApp({
      handleSnsWebhook: vi.fn(async () => ({
        ok: true,
        outcome: 'subscribe_confirm',
        subscribeUrl: 'https://sns.us-east-1.amazonaws.com/confirm?Token=abc',
      } as HandleSnsWebhookResult)),
      confirmSubscriptionUrl: confirm,
    })
    const res = await request(app)
      .post('/webhooks/email/ses')
      .send({ Type: 'SubscriptionConfirmation', MessageId: 'sub-01' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, outcome: 'subscribe_confirm' })
    // Fire-and-forget semantics — the confirm URL must have been invoked
    // synchronously within the route handler, even though we respond first.
    expect(confirm).toHaveBeenCalledWith(
      'https://sns.us-east-1.amazonaws.com/confirm?Token=abc',
    )
  })
})

describe('POST /webhooks/email/ses — failure paths', () => {
  it('returns 401 for signature_invalid (attacker, no retry)', async () => {
    const app = buildApp({
      handleSnsWebhook: vi.fn(async () => ({
        ok: false,
        reason: 'signature_invalid',
      } as HandleSnsWebhookResult)),
    })
    const res = await request(app)
      .post('/webhooks/email/ses')
      .send({ Type: 'Notification' })
    expect(res.status).toBe(401)
    expect(res.body).toEqual({ ok: false, reason: 'signature_invalid' })
  })

  it('returns 500 for db_error (triggers SNS retry)', async () => {
    const app = buildApp({
      handleSnsWebhook: vi.fn(async () => ({
        ok: false,
        reason: 'db_error',
        error: 'connection refused',
      } as HandleSnsWebhookResult)),
    })
    const res = await request(app)
      .post('/webhooks/email/ses')
      .send({ Type: 'Notification' })
    expect(res.status).toBe(500)
    expect(res.body).toEqual({ ok: false, reason: 'db_error' })
    // Iron Rule 5: no internal error text leaked
    expect(JSON.stringify(res.body)).not.toContain('connection refused')
  })

  it('returns 200 (drop) for missing_field', async () => {
    const app = buildApp({
      handleSnsWebhook: vi.fn(async () => ({
        ok: false,
        reason: 'missing_field',
      } as HandleSnsWebhookResult)),
    })
    const res = await request(app)
      .post('/webhooks/email/ses')
      .send({ Type: 'Notification' })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, outcome: 'dropped' })
  })

  it('returns 200 (drop) for parse_failed', async () => {
    const app = buildApp({
      handleSnsWebhook: vi.fn(async () => ({
        ok: false,
        reason: 'parse_failed',
      } as HandleSnsWebhookResult)),
    })
    const res = await request(app)
      .post('/webhooks/email/ses')
      .send({ Type: 'SomethingNew' })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, outcome: 'dropped' })
  })

  it('returns 500 when the handler throws (belt + braces)', async () => {
    const app = buildApp({
      handleSnsWebhook: vi.fn(async () => {
        throw new Error('boom')
      }),
    })
    const res = await request(app)
      .post('/webhooks/email/ses')
      .send({ Type: 'Notification' })
    expect(res.status).toBe(500)
    expect(res.body).toEqual({ ok: false, reason: 'db_error' })
  })
})

// ---------------------------------------------------------------------------
// POST /webhooks/email/generic
// ---------------------------------------------------------------------------

describe('POST /webhooks/email/generic — success paths', () => {
  it('returns 200 + processed outcome', async () => {
    const app = buildApp()
    const rawBody = '{"notificationType":"Bounce"}'
    const sig = hmacSign('test-secret', rawBody)
    const res = await request(app)
      .post('/webhooks/email/generic')
      .set('Content-Type', 'application/json')
      .set('X-Gbox-Signature', sig)
      .send(rawBody)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, outcome: 'processed' })
  })

  it('passes shopIdHint from X-Gbox-Shop-Id header', async () => {
    const spy = vi.fn(async () => ({
      ok: true,
      outcome: 'processed',
      eventId: 7,
      matchedDeliveryId: null,
      matchedShopId: null,
      eventsCreated: 0,
      suppressionsCreated: 0,
    } as HandleGenericWebhookResult))
    const app = buildApp({ handleGenericWebhook: spy })
    const rawBody = '{"x":1}'
    await request(app)
      .post('/webhooks/email/generic')
      .set('X-Gbox-Signature', 'sig')
      .set('X-Gbox-Shop-Id', 'shop-42')
      .send(rawBody)
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        rawBody: rawBody,
        signatureBase64: 'sig',
        shopIdHint: 'shop-42',
        secret: 'test-secret',
      }),
    )
  })
})

describe('POST /webhooks/email/generic — failure paths', () => {
  it('returns 404 when no secret is configured', async () => {
    const app = buildApp({ getGenericSecret: () => '' })
    const res = await request(app)
      .post('/webhooks/email/generic')
      .send('{}')
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ ok: false, reason: 'not_found' })
  })

  it('returns 401 for signature_invalid', async () => {
    const app = buildApp({
      handleGenericWebhook: vi.fn(async () => ({
        ok: false,
        reason: 'signature_invalid',
      } as HandleGenericWebhookResult)),
    })
    const res = await request(app)
      .post('/webhooks/email/generic')
      .set('X-Gbox-Signature', 'bad')
      .send('{}')
    expect(res.status).toBe(401)
    expect(res.body).toEqual({ ok: false, reason: 'signature_invalid' })
  })

  it('returns 500 for db_error', async () => {
    const app = buildApp({
      handleGenericWebhook: vi.fn(async () => ({
        ok: false,
        reason: 'db_error',
      } as HandleGenericWebhookResult)),
    })
    const res = await request(app)
      .post('/webhooks/email/generic')
      .set('X-Gbox-Signature', 'sig')
      .send('{}')
    expect(res.status).toBe(500)
    expect(res.body).toEqual({ ok: false, reason: 'db_error' })
  })

  it('returns 200 (drop) for parse_failed', async () => {
    const app = buildApp({
      handleGenericWebhook: vi.fn(async () => ({
        ok: false,
        reason: 'parse_failed',
      } as HandleGenericWebhookResult)),
    })
    const res = await request(app)
      .post('/webhooks/email/generic')
      .set('X-Gbox-Signature', 'sig')
      .send('garbage')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, outcome: 'dropped' })
  })

  it('returns 500 when handler throws', async () => {
    const app = buildApp({
      handleGenericWebhook: vi.fn(async () => {
        throw new Error('network partition')
      }),
    })
    const res = await request(app)
      .post('/webhooks/email/generic')
      .set('X-Gbox-Signature', 'sig')
      .send('{}')
    expect(res.status).toBe(500)
    expect(res.body).toEqual({ ok: false, reason: 'db_error' })
    expect(JSON.stringify(res.body)).not.toContain('network partition')
  })
})
