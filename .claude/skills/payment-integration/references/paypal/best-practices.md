# Best Practices

## Production Checklist

Before deploying to production:

- [ ] Switch from sandbox (api-m.sandbox.paypal.com) to live (api-m.paypal.com)
- [ ] Update PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET to live credentials
- [ ] Create webhook on live environment with production URL
- [ ] Test webhook verification in production
- [ ] Configure return/cancel URLs to production domain
- [ ] Verify currency decimal places for all supported currencies
- [ ] Enable error monitoring and logging
- [ ] Set up customer support for refund/dispute handling
- [ ] Test end-to-end payment flow with real transaction
- [ ] Document payment troubleshooting process

## Security Best Practices

### Webhook Verification
Always verify webhook signatures. Never trust unauthenticated webhooks.

```typescript
// ✅ DO: Verify every webhook
const isValid = await verifyWebhookSignature(
  transmissionId,
  transmissionTime,
  certUrl,
  signature,
  body,
  webhookId,
  accessToken
);

if (!isValid) {
  return res.status(403).send('Invalid signature');
}

// ❌ DON'T: Skip verification
// Direct processing without verification = security risk
```

### HTTPS Only
All requests must use TLS 1.2+. Never send credentials over HTTP.

### Token Caching
Cache access tokens to avoid rate limiting.

```typescript
let cachedToken: string = '';
let tokenExpiry: number = 0;

const getCachedAccessToken = async (): Promise<string> => {
  const now = Date.now();
  
  if (cachedToken && tokenExpiry > now) {
    return cachedToken;
  }

  const response = await fetch('https://api-m.paypal.com/v1/oauth2/token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  const data = await response.json();
  cachedToken = data.access_token;
  tokenExpiry = now + (data.expires_in * 1000) - 60000; // Refresh 60s early

  return cachedToken;
};
```

### No Sensitive Data in Logs
Never log order IDs, transaction IDs, or customer emails in error logs.

```typescript
// ✅ DO
console.error('Payment capture failed for order');

// ❌ DON'T
console.error('Payment capture failed for order 5O190127TN364715T');
```

## Idempotency & Duplicate Prevention

Include PayPal-Request-Id header to prevent duplicate charges from retries.

```typescript
const idempotentRequest = (operationKey: string) => ({
  'PayPal-Request-Id': `${operationKey}_${Date.now()}`,
});

// If same key sent twice, PayPal returns cached result
// Safe to retry indefinitely
```

## Error Handling & Recovery

### Transient Errors (5xx)
Retry with exponential backoff.

```typescript
const retryWithBackoff = async (
  fn: () => Promise<any>,
  maxRetries: number = 3
): Promise<any> => {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error: any) {
      if (error.status >= 500 && i < maxRetries - 1) {
        const delay = Math.pow(2, i) * 1000; // 1s, 2s, 4s
        await new Promise(r => setTimeout(r, delay));
      } else {
        throw error;
      }
    }
  }
};
```

### Client Errors (4xx)
Don't retry. Log and report to user.

```typescript
if (error.status === 400) {
  console.error('Invalid request:', error.details);
  return res.status(400).json({ message: 'Invalid payment details' });
}

if (error.status === 404) {
  console.error('Order not found');
  return res.status(404).json({ message: 'Order not found' });
}
```

## Dispute Handling

### Dispute Lifecycle
- `INQUIRY` — Buyer disputes charge, PayPal investigating
- `WAITING_FOR_SELLER` — PayPal awaiting merchant response
- `RESOLVED` — PayPal ruled in favor of buyer or merchant

### Responding to Disputes
1. **Receive webhook**: `DISPUTE.CREATED`
2. **Provide evidence**: Upload tracking, shipment proof, refund receipt
3. **Wait for resolution**: Up to 20 days
4. **Process refund if needed**: Issue refund if claim is valid

```typescript
const handleDispute = async (event: any) => {
  const { id, status, reason_code, amount } = event.resource;

  // Log dispute in database
  await saveDispute({
    paypal_dispute_id: id,
    status: status,
    reason: reason_code,
    amount: amount.value,
  });

  // Notify merchant
  if (reason_code === 'ITEM_NOT_RECEIVED') {
    console.log('Provide tracking number as evidence');
  }

  if (reason_code === 'UNAUTHORIZED_TRANSACTION') {
    console.log('Review transaction for fraud');
  }
};
```

## Marketplace & Platform Payments

For marketplaces splitting payments between multiple parties:

```typescript
{
  purchase_units: [
    {
      reference_id: 'order_12345',
      amount: {
        currency_code: 'USD',
        value: '100.00',
        breakdown: {
          item_total: { value: '100.00', currency_code: 'USD' },
          shipping: { value: '0.00', currency_code: 'USD' },
          tax_total: { value: '0.00', currency_code: 'USD' },
        },
      },
      payment_instructions: {
        platform_fees: [
          {
            amount: {
              currency_code: 'USD',
              value: '10.00', // 10% platform fee
            },
          },
        ],
        disbursement_mode: 'INSTANT',
        payee_receivable_breakdown: {
          gross_amount: {
            currency_code: 'USD',
            value: '90.00', // Vendor receives $90
          },
          paypal_fee: {
            currency_code: 'USD',
            value: '0.00',
          },
          net_amount: {
            currency_code: 'USD',
            value: '90.00',
          },
        },
      },
      payee: {
        email_address: 'vendor@example.com',
      },
    },
  ],
}
```

## Testing in Sandbox

### Test Accounts
Create test accounts in PayPal sandbox dashboard.
- Buyer account: test.buyer@example.com
- Seller account: test.seller@example.com

### Simulating Payment Failures

Return specific amounts to trigger errors:
- `$100.02` → Card declined
- `$100.03` → 3D Secure failure
- `$100.04` → Invalid card
- `$100.05` → Fraud detection

### Testing Webhooks
Use PayPal dashboard to manually trigger webhook events, or use CLI:

```bash
curl -X POST https://api.sandbox.paypal.com/v1/notifications/webhooks/{webhook_id}/event-types/CHECKOUT.ORDER.COMPLETED/simulate \
  -H "Authorization: Bearer {access_token}"
```

## Currency Handling Edge Cases

### Zero-Decimal Currencies
JPY, HUF, TWD, KRW require integer values.

```typescript
const formatAmount = (amount: number, currency: string): string => {
  const noDecimals = ['JPY', 'HUF', 'TWD', 'KRW', 'CLF'];
  
  if (noDecimals.includes(currency)) {
    return Math.round(amount).toString(); // e.g., '1000'
  }
  
  return amount.toFixed(2); // e.g., '100.00'
};

// Examples
formatAmount(100, 'USD')     // '100.00'
formatAmount(100, 'JPY')     // '100' (no decimals)
formatAmount(100.556, 'USD') // '100.56' (rounded)
```

## Common Pitfalls

| Mistake | Fix |
|---------|-----|
| Decimal mismatch (JPY with decimals) | Use `getDecimalPlaces()` helper |
| No webhook verification | Always call `/verify-webhook-signature` |
| Token expiration mid-request | Implement token caching with refresh |
| Missing error handling | Wrap API calls in try-catch, log details |
| Ignoring idempotency | Include PayPal-Request-Id header |
| Processing webhook twice | Track `event.id` to detect duplicates |
| Hardcoded sandbox URLs | Use environment variables for URLs |
| Storing credentials in code | Load from .env, never commit |

## Rate Limiting Strategy

PayPal allows 1000 req/sec per merchant.

```typescript
const rateLimiter = {
  requests: [] as number[],
  maxRequests: 900, // Safety margin
  timeWindow: 1000,

  async wait() {
    const now = Date.now();
    this.requests = this.requests.filter(t => now - t < this.timeWindow);

    if (this.requests.length >= this.maxRequests) {
      const oldestRequest = this.requests[0];
      const waitTime = this.timeWindow - (now - oldestRequest) + 10;
      await new Promise(r => setTimeout(r, waitTime));
    }

    this.requests.push(now);
  },
};

// Usage
await rateLimiter.wait();
await makePayPalAPICall();
```
