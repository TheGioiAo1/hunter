# Webhooks

## Setup Webhook

Create a webhook via API or dashboard.

```typescript
const createWebhook = async (
  accessToken: string,
  webhookUrl: string
): Promise<{ id: string }> => {
  const response = await fetch(
    'https://api-m.sandbox.paypal.com/v1/notifications/webhooks',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        url: webhookUrl,
        event_types: [
          {
            name: 'CHECKOUT.ORDER.COMPLETED',
          },
          {
            name: 'PAYMENT.CAPTURE.COMPLETED',
          },
          {
            name: 'PAYMENT.CAPTURE.REFUNDED',
          },
          {
            name: 'BILLING.SUBSCRIPTION.CREATED',
          },
          {
            name: 'BILLING.SUBSCRIPTION.ACTIVATED',
          },
          {
            name: 'BILLING.SUBSCRIPTION.CANCELLED',
          },
          {
            name: 'BILLING.SUBSCRIPTION.UPDATED',
          },
        ],
      }),
    }
  );

  if (!response.ok) {
    throw new Error('Failed to create webhook');
  }

  return response.json();
};
```

## Key Event Types

| Event | Trigger |
|-------|---------|
| `CHECKOUT.ORDER.COMPLETED` | Order payment completed (one-step capture) |
| `PAYMENT.CAPTURE.COMPLETED` | Capture processed after authorization |
| `PAYMENT.CAPTURE.REFUNDED` | Refund issued on captured payment |
| `PAYMENT.CAPTURE.DENIED` | Capture was denied |
| `BILLING.SUBSCRIPTION.CREATED` | Subscription created, approval pending |
| `BILLING.SUBSCRIPTION.ACTIVATED` | Subscription activated after customer approval |
| `BILLING.SUBSCRIPTION.SUSPENDED` | Subscription suspended due to failed payment |
| `BILLING.SUBSCRIPTION.CANCELLED` | Subscription cancelled |
| `BILLING.SUBSCRIPTION.UPDATED` | Subscription details updated |

## Webhook Signature Verification

PayPal signs webhooks with HMAC-SHA256. Verify before processing.

```typescript
import crypto from 'crypto';

const verifyWebhookSignature = async (
  transmissionId: string,
  transmissionTime: string,
  certUrl: string,
  webhookSignature: string,
  webhookBody: string,
  webhookId: string,
  accessToken: string
): Promise<boolean> => {
  // PayPal provides verification endpoint
  const response = await fetch(
    'https://api-m.sandbox.paypal.com/v1/notifications/verify-webhook-signature',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        transmission_id: transmissionId,
        transmission_time: transmissionTime,
        cert_url: certUrl,
        auth_algo: 'SHA256withRSA',
        transmission_sig: webhookSignature,
        webhook_id: webhookId,
        webhook_event: JSON.parse(webhookBody),
      }),
    }
  );

  const data = await response.json();
  return data.verification_status === 'SUCCESS';
};
```

## Express.js Webhook Handler

```typescript
import express, { Request, Response } from 'express';

const app = express();
app.use(express.json());

interface PayPalWebhookRequest extends Request {
  headers: {
    'paypal-transmission-id': string;
    'paypal-transmission-time': string;
    'paypal-cert-url': string;
    'paypal-auth-algo': string;
    'paypal-transmission-sig': string;
  };
}

app.post('/webhook/paypal', async (req: PayPalWebhookRequest, res: Response) => {
  try {
    // Verify signature
    const isValid = await verifyWebhookSignature(
      req.headers['paypal-transmission-id'],
      req.headers['paypal-transmission-time'],
      req.headers['paypal-cert-url'],
      req.headers['paypal-transmission-sig'],
      JSON.stringify(req.body),
      process.env.PAYPAL_WEBHOOK_ID!,
      accessToken
    );

    if (!isValid) {
      console.error('Invalid webhook signature');
      return res.status(403).send('Forbidden');
    }

    const event = req.body;
    console.log(`Received event: ${event.event_type}`);

    // Process event
    switch (event.event_type) {
      case 'CHECKOUT.ORDER.COMPLETED':
        await handleOrderCompleted(event.resource);
        break;

      case 'BILLING.SUBSCRIPTION.ACTIVATED':
        await handleSubscriptionActivated(event.resource);
        break;

      case 'BILLING.SUBSCRIPTION.CANCELLED':
        await handleSubscriptionCancelled(event.resource);
        break;

      default:
        console.log(`Unhandled event type: ${event.event_type}`);
    }

    // Acknowledge receipt (return 2xx immediately)
    res.status(200).send('OK');
  } catch (error) {
    console.error('Webhook processing error:', error);
    res.status(500).send('Internal Server Error');
  }
});

const handleOrderCompleted = async (resource: any) => {
  const { id, status, payer, purchase_units } = resource;
  
  // Store payment in database
  const payment = {
    paypal_order_id: id,
    status: status,
    payer_email: payer.email_address,
    amount: purchase_units[0].amount.value,
    currency: purchase_units[0].amount.currency_code,
    created_at: new Date(),
  };

  console.log('Payment recorded:', payment);
  // await savePaymentToDB(payment);
};

const handleSubscriptionActivated = async (resource: any) => {
  const { id, status, subscriber, plan_id } = resource;

  const subscription = {
    paypal_subscription_id: id,
    status: status,
    customer_email: subscriber.email_address,
    plan_id: plan_id,
    activated_at: new Date(),
  };

  console.log('Subscription activated:', subscription);
  // await saveSubscriptionToDB(subscription);
};

const handleSubscriptionCancelled = async (resource: any) => {
  const { id, reason } = resource;

  console.log(`Subscription ${id} cancelled. Reason: ${reason}`);
  // await markSubscriptionCancelledInDB(id);
};

app.listen(3000, () => {
  console.log('Webhook server running on port 3000');
});
```

## Idempotent Webhook Handling

Webhooks can be retried. Ensure idempotency.

```typescript
const processWebhookEvent = async (event: any): Promise<void> => {
  const eventId = event.id; // Unique event ID from PayPal

  // Check if already processed
  const existing = await getProcessedEvent(eventId);
  if (existing) {
    console.log(`Event ${eventId} already processed, skipping`);
    return;
  }

  // Process new event
  await handleEvent(event);

  // Mark as processed
  await markEventProcessed(eventId);
};
```

## Webhook Retry Behavior

PayPal retries failed webhooks:
- **Initial attempt**: Immediate
- **Retries**: Up to 3 days with exponential backoff
- **Exponential backoff**: 5 min → 30 min → 2 hr → 5 hr → 1 day, etc.

**Return 2xx status immediately** to acknowledge receipt. Process asynchronously.

## Event Resend

Manually resend a webhook:

```typescript
const resendWebhookEvent = async (
  webhookId: string,
  eventId: string,
  accessToken: string
): Promise<void> => {
  await fetch(
    `https://api-m.sandbox.paypal.com/v1/notifications/webhooks/${webhookId}/event-types/${eventId}/resend`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
      },
    }
  );
};
```

## List Webhook Events

```typescript
const listWebhookEvents = async (
  webhookId: string,
  accessToken: string
): Promise<any[]> => {
  const response = await fetch(
    `https://api-m.sandbox.paypal.com/v1/notifications/webhooks/${webhookId}/events?page_size=10`,
    {
      headers: { 'Authorization': `Bearer ${accessToken}` },
    }
  );

  const data = await response.json();
  return data.events;
};
```
