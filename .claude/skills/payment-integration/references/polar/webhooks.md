# Polar Webhooks

Webhooks deliver real-time event notifications to your application when payments, subscriptions, or other changes occur.

## Setup

1. Go to dashboard → Webhooks
2. Click "Add Endpoint"
3. Configure:
   - **URL:** Your endpoint (must be HTTPS)
   - **Events:** Select which events to receive
   - **API Key:** For signature verification

## Webhook URL Requirements

- HTTPS only (no HTTP)
- Publicly accessible
- Respond with HTTP 200-299 within 30 seconds
- Idempotent (same event multiple times = same result)

## Signature Verification

All webhooks include signature headers:
```
X-Polar-Signature: sha256=xxxxx
X-Polar-Signature-Timestamp: 1234567890
```

**Verify Signature:**

```typescript
import crypto from 'crypto';

function verifyWebhookSignature(
  body: string,
  signature: string,
  timestamp: string,
  secret: string
): boolean {
  const message = `${timestamp}.${body}`;
  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(message)
    .digest('hex');
  
  return signature === `sha256=${expectedSignature}`;
}

// In handler
const isValid = verifyWebhookSignature(
  rawBody,
  req.headers['x-polar-signature'],
  req.headers['x-polar-signature-timestamp'],
  process.env.POLAR_WEBHOOK_SECRET
);

if (!isValid) {
  return res.status(401).json({ error: 'Invalid signature' });
}
```

```php
<?php

function verifyWebhookSignature($rawBody, $signature, $timestamp, $secret) {
    $message = "{$timestamp}.{$rawBody}";
    $expectedSignature = hash_hmac(
        'sha256',
        $message,
        $secret
    );
    
    return hash_equals(
        $signature,
        "sha256={$expectedSignature}"
    );
}

// In handler
$isValid = verifyWebhookSignature(
    file_get_contents('php://input'),
    $_SERVER['HTTP_X_POLAR_SIGNATURE'] ?? '',
    $_SERVER['HTTP_X_POLAR_SIGNATURE_TIMESTAMP'] ?? '',
    getenv('POLAR_WEBHOOK_SECRET')
);

if (!$isValid) {
    http_response_code(401);
    echo json_encode(['error' => 'Invalid signature']);
    exit;
}
?>
```

## Event Types

### Subscription Events
- `subscription.created` - New subscription
- `subscription.updated` - Subscription changed (price, metadata)
- `subscription.active` - Subscription activated
- `subscription.trialing` - Trial started
- `subscription.paused` - Subscription paused
- `subscription.resumed` - Subscription resumed
- `subscription.canceled` - Subscription canceled

### Order Events
- `order.created` - One-time purchase created
- `order.updated` - Order metadata changed
- `order.fulfilled` - Order benefits granted
- `order.failed` - Order payment failed

### Invoice Events
- `invoice.created` - Invoice generated
- `invoice.updated` - Invoice updated
- `invoice.paid` - Invoice payment received
- `invoice.failed` - Invoice payment failed
- `invoice.upcoming` - Invoice scheduled (5 days before)

### Organization Events
- `organization.updated` - Organization info changed

## Webhook Payload Structure

```json
{
  "type": "subscription.updated",
  "id": "evt_123",
  "timestamp": "2025-01-15T10:30:00Z",
  "data": {
    "id": "sub_456",
    "customerId": "cust_789",
    "productId": "prod_012",
    "status": "active",
    "currentPeriodStart": "2025-01-15T00:00:00Z",
    "currentPeriodEnd": "2025-02-15T00:00:00Z",
    "trialEndsAt": null,
    "pausedAt": null,
    "canceledAt": null,
    "metadata": {}
  }
}
```

## Handler Implementation

### Node.js/Express
```typescript
import express from 'express';
import { Polar } from '@polar-sh/sdk';

const app = express();

// Use raw body for signature verification
app.post(
  '/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const signature = req.headers['x-polar-signature'] as string;
    const timestamp = req.headers['x-polar-signature-timestamp'] as string;

    // Verify signature
    const isValid = verifySignature(
      req.body,
      signature,
      timestamp,
      process.env.POLAR_WEBHOOK_SECRET
    );

    if (!isValid) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    const event = JSON.parse(req.body.toString());

    try {
      switch (event.type) {
        case 'subscription.created':
        case 'subscription.active':
          await handleSubscriptionActive(event.data);
          break;

        case 'subscription.canceled':
          await handleSubscriptionCanceled(event.data);
          break;

        case 'invoice.paid':
          await handleInvoicePaid(event.data);
          break;

        case 'order.fulfilled':
          await handleOrderFulfilled(event.data);
          break;

        default:
          console.log(`Unhandled event type: ${event.type}`);
      }

      res.json({ success: true });
    } catch (error) {
      console.error('Webhook processing error:', error);
      res.status(500).json({ error: 'Processing failed' });
    }
  }
);

async function handleSubscriptionActive(subscription) {
  // Grant access, send confirmation email, etc.
  console.log(`Subscription ${subscription.id} activated`);
  // Update database, send email, etc.
}

async function handleSubscriptionCanceled(subscription) {
  // Revoke access, send cancellation email, etc.
  console.log(`Subscription ${subscription.id} canceled`);
  // Revoke benefits, update database, etc.
}

async function handleInvoicePaid(invoice) {
  // Update accounting, trigger fulfillment, etc.
  console.log(`Invoice ${invoice.id} paid`);
}

async function handleOrderFulfilled(order) {
  // Send files/credentials, trigger integrations, etc.
  console.log(`Order ${order.id} fulfilled`);
}
```

### PHP/Laravel
```php
<?php

Route::post('/webhook/polar', function (Request $request) {
    $signature = $request->header('X-Polar-Signature');
    $timestamp = $request->header('X-Polar-Signature-Timestamp');
    
    $isValid = verifyWebhookSignature(
        $request->getContent(),
        $signature,
        $timestamp,
        env('POLAR_WEBHOOK_SECRET')
    );
    
    if (!$isValid) {
        return response()->json(['error' => 'Invalid signature'], 401);
    }
    
    try {
        $event = json_decode($request->getContent());
        
        match($event->type) {
            'subscription.created' => handleSubscriptionCreated($event->data),
            'subscription.canceled' => handleSubscriptionCanceled($event->data),
            'invoice.paid' => handleInvoicePaid($event->data),
            'order.fulfilled' => handleOrderFulfilled($event->data),
            default => Log::info('Unhandled event', ['type' => $event->type])
        };
        
        return response()->json(['success' => true]);
    } catch (Exception $e) {
        Log::error('Webhook processing error', ['error' => $e]);
        return response()->json(['error' => 'Processing failed'], 500);
    }
});

function handleSubscriptionCreated($subscription) {
    // Grant trial access
}

function handleSubscriptionCanceled($subscription) {
    // Revoke access
}

function handleInvoicePaid($invoice) {
    // Update accounting
}

function handleOrderFulfilled($order) {
    // Send digital product
}
```

## Retry Mechanism

**Policy:**
- Retries for 5 days if endpoint returns non-2xx
- Exponential backoff: 1min, 5min, 30min, 2h, 8h, 24h, 48h
- Manual retry available in dashboard

**Duplicate Prevention:**
Use event ID for deduplication:
```typescript
const processed = await db.webhooks.findOne({ eventId: event.id });
if (processed) {
  return res.json({ success: true }); // Already handled
}

// Process event...

await db.webhooks.insert({ eventId: event.id, type: event.type });
```

## Monitoring

### View Webhook Attempts
Dashboard shows:
- Event type
- Timestamp
- Response status
- Retry count
- Payload preview

### Track Metrics
```typescript
const webhookMetrics = {
  received: 0,
  processed: 0,
  failed: 0,
  duplicates: 0,
  avgProcessingTime: 0
};

// Log metrics
app.post('/webhook', async (req, res) => {
  webhookMetrics.received++;
  const start = Date.now();
  
  try {
    // Process...
    webhookMetrics.processed++;
  } catch (error) {
    webhookMetrics.failed++;
  }
  
  webhookMetrics.avgProcessingTime = 
    (webhookMetrics.avgProcessingTime + (Date.now() - start)) / 2;
});
```

## Framework Adapters

### Next.js API Route
```typescript
// pages/api/webhooks/polar.ts
import { NextApiRequest, NextApiResponse } from 'next';

export const config = {
  api: {
    bodyParser: {
      raw: true
    }
  }
};

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Verify and process...
  res.json({ success: true });
}
```

### Remix Action
```typescript
// routes/webhooks/polar.tsx
import { json, type ActionFunction } from '@remix-run/node';

export const action: ActionFunction = async ({ request }) => {
  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, { status: 405 });
  }

  const signature = request.headers.get('X-Polar-Signature');
  const timestamp = request.headers.get('X-Polar-Signature-Timestamp');
  
  // Verify and process...
  return json({ success: true });
};
```

## Best Practices

1. **Idempotency:** Handle duplicate events gracefully
2. **Quick Response:** Respond immediately, process async
3. **Error Logging:** Log all webhook errors with context
4. **Signature Verification:** Always verify signatures
5. **Timeout Handling:** Don't exceed 30-second timeout
6. **Async Processing:** Use queues for long operations
7. **Monitoring:** Track webhook success/failure rates
8. **Testing:** Use sandbox webhooks before production
9. **Secrets Management:** Store webhook secret securely
10. **Documentation:** Document all event handlers
