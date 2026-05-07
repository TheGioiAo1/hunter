# Orders API v2

## Create Order

Create an order for payment capture or authorization.

```typescript
const createOrder = async (
  accessToken: string,
  amount: string,
  currencyCode: string = 'USD'
): Promise<{ id: string; status: string }> => {
  const response = await fetch(
    'https://api-m.sandbox.paypal.com/v2/checkout/orders',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
        'PayPal-Request-Id': crypto.randomUUID(), // Idempotency
      },
      body: JSON.stringify({
        intent: 'CAPTURE', // or 'AUTHORIZE'
        purchase_units: [
          {
            reference_id: 'order_' + Date.now(),
            amount: {
              currency_code: currencyCode,
              value: amount,
            },
            description: 'Product purchase',
          },
        ],
        payment_source: {
          paypal: {
            experience_context: {
              return_url: 'https://example.com/return',
              cancel_url: 'https://example.com/cancel',
              user_action: 'PAY_NOW',
              brand_name: 'Your Store',
            },
          },
        },
      }),
    }
  );

  return response.json();
};
```

**Response (201 Created)**:
```json
{
  "id": "5O190127TN364715T",
  "status": "CREATED",
  "links": [
    {
      "rel": "approve",
      "href": "https://www.sandbox.paypal.com/checkoutnow?token=5O190127TN364715T"
    },
    {
      "rel": "self",
      "href": "https://api-m.sandbox.paypal.com/v2/checkout/orders/5O190127TN364715T"
    }
  ]
}
```

## Capture Order

Capture funds from an approved order (after customer approves on PayPal).

```typescript
const captureOrder = async (
  orderId: string,
  accessToken: string
): Promise<{ id: string; status: string; purchase_units: any[] }> => {
  const response = await fetch(
    `https://api-m.sandbox.paypal.com/v2/checkout/orders/${orderId}/capture`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
        'PayPal-Request-Id': crypto.randomUUID(),
      },
    }
  );

  if (!response.ok) {
    const error = await response.json();
    throw new Error(`Capture failed: ${error.message}`);
  }

  return response.json();
};
```

**Response (201 Created)**:
```json
{
  "id": "5O190127TN364715T",
  "status": "COMPLETED",
  "purchase_units": [
    {
      "reference_id": "order_1681234567890",
      "payments": {
        "captures": [
          {
            "id": "3C679366HH908393H",
            "status": "COMPLETED",
            "amount": {
              "currency_code": "USD",
              "value": "100.00"
            }
          }
        ]
      }
    }
  ]
}
```

## Authorize Then Capture

For merchants needing two-step flow (validate before charging).

```typescript
const authorizeAndCapture = async (
  accessToken: string,
  amount: string
): Promise<void> => {
  // Step 1: Create order with intent: 'AUTHORIZE'
  const order = await createOrder(accessToken, amount, 'USD');
  console.log('Order created, awaiting customer approval...');
  // Customer approves on PayPal, returns with order.id in URL param

  // Step 2: Authorize
  const authResponse = await fetch(
    `https://api-m.sandbox.paypal.com/v2/checkout/orders/${order.id}/authorize`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'PayPal-Request-Id': crypto.randomUUID(),
      },
    }
  );
  const authOrder = await authResponse.json();
  console.log('Authorized:', authOrder.purchase_units[0].payments.authorizations[0].id);

  // Step 3: Capture within 3 days
  const authId = authOrder.purchase_units[0].payments.authorizations[0].id;
  const captureResponse = await fetch(
    `https://api-m.sandbox.paypal.com/v2/payments/authorizations/${authId}/capture`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'PayPal-Request-Id': crypto.randomUUID(),
      },
      body: JSON.stringify({
        amount: {
          currency_code: 'USD',
          value: amount,
        },
      }),
    }
  );

  return captureResponse.json();
};
```

## Order Status Lifecycle

| Status | Meaning |
|--------|---------|
| `CREATED` | Order created, awaiting customer approval |
| `APPROVED` | Customer approved payment on PayPal |
| `COMPLETED` | Payment captured successfully |
| `PAYER_ACTION_REQUIRED` | Customer action needed |
| `VOIDED` | Authorization was voided |

## Error Handling

```typescript
const handleOrderError = (error: any) => {
  const details = error.details?.[0];
  
  if (details?.issue === 'ORDER_ALREADY_CAPTURED') {
    console.log('Order already captured — duplicate request');
    return;
  }
  
  if (details?.issue === 'INVALID_REQUEST') {
    console.error('Bad request body:', details.description);
    return;
  }

  if (error.status === 400) {
    console.error('Invalid order state or data');
    return;
  }

  if (error.status === 404) {
    console.error('Order not found — check order ID');
    return;
  }

  throw error;
};
```

## Idempotency

Always include `PayPal-Request-Id` header to ensure idempotent requests:

```typescript
const idempotentCapture = async (orderId: string, accessToken: string) => {
  const idempotencyKey = `capture_${orderId}_${Date.now()}`;
  
  const response = await fetch(
    `https://api-m.sandbox.paypal.com/v2/checkout/orders/${orderId}/capture`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'PayPal-Request-Id': idempotencyKey,
      },
    }
  );

  // If duplicate request, returns 422 with DUPLICATE_REFERENCE_ID
  // Safe to retry — idempotent key prevents double charge
  return response.json();
};
```

## Get Order Details

```typescript
const getOrder = async (orderId: string, accessToken: string) => {
  const response = await fetch(
    `https://api-m.sandbox.paypal.com/v2/checkout/orders/${orderId}`,
    {
      headers: { 'Authorization': `Bearer ${accessToken}` },
    }
  );
  return response.json();
};
```
