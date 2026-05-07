# PayPal API Overview

## Authentication

PayPal uses OAuth 2.0 with client credentials flow.

### Get Access Token

```typescript
// POST https://api-m.sandbox.paypal.com/v1/oauth2/token (sandbox)
// POST https://api-m.paypal.com/v1/oauth2/token (production)

const getAccessToken = async (clientId: string, clientSecret: string): Promise<string> => {
  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  
  const response = await fetch('https://api-m.sandbox.paypal.com/v1/oauth2/token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  const data = await response.json();
  return data.access_token; // Expires in 3600 seconds
};
```

### Environment Variables

```bash
PAYPAL_CLIENT_ID=your_client_id_here
PAYPAL_CLIENT_SECRET=your_client_secret_here
PAYPAL_WEBHOOK_ID=your_webhook_id_here
PAYPAL_MODE=sandbox  # or 'live'
```

## Environment URLs

| Environment | URL |
|-------------|-----|
| **Sandbox** | `https://api-m.sandbox.paypal.com` |
| **Live** | `https://api-m.paypal.com` |

## Core APIs

### Orders API v2 (Primary)
Create, authorize, and capture payments. Replaces REST API v1 for payments.
- **Base**: `/v2/checkout/orders`
- **Intent**: `CAPTURE` (one-step) or `AUTHORIZE` (two-step authorization + capture)
- **Status flow**: `CREATED` → `APPROVED` → `COMPLETED`

### Subscriptions API
Recurring billing with products, plans, and subscriptions.
- **Base**: `/v1/billing/plans` and `/v1/billing/subscriptions`
- **Use for**: SaaS, memberships, recurring charges
- **Status flow**: `APPROVAL_PENDING` → `APPROVED` → `ACTIVE`

### Payouts API
Send money to multiple recipients in batch or real-time.
- **Base**: `/v1/payments/payouts`
- **Use for**: Refunds, vendor payments, splits

## Rate Limits

- **General API**: 1000 requests per second per merchant
- **Webhooks**: Retry up to 3 days with exponential backoff
- **Token lifetime**: 3600 seconds (1 hour) — cache aggressively

## Currency Handling

Most currencies use 2 decimal places. Exceptions require 0 decimals:

```typescript
const getDecimalPlaces = (currencyCode: string): number => {
  const noDecimals = ['JPY', 'HUF', 'TWD', 'KRW', 'CLF'];
  return noDecimals.includes(currencyCode) ? 0 : 2;
};

// Example
const amount = {
  currency_code: 'JPY',
  value: '1000', // No decimals
};
```

## Error Codes

| Code | Meaning |
|------|---------|
| `AUTHENTICATION_FAILURE` | Invalid credentials |
| `PERMISSION_DENIED` | Insufficient scope or permissions |
| `RESOURCE_NOT_FOUND` | Order/plan/subscription doesn't exist |
| `INVALID_REQUEST` | Malformed request body |
| `UNPROCESSABLE_ENTITY` | Request violates business rules |
| `INTERNAL_SERVER_ERROR` | PayPal service error (retry later) |

## Best Practices

1. **Cache tokens** — Don't request a new token for every API call
2. **Use Idempotency Headers** — Include `PayPal-Request-Id` to prevent duplicate charges
3. **HTTPS Only** — All requests must use TLS 1.2+
4. **Webhook Verification** — Always verify webhook signatures before processing
5. **Exponential Backoff** — Retry failed requests with increasing delays
