# Subscriptions API

## Product → Plan → Subscription Flow

Subscriptions require a product and billing plan first.

### Create Product

```typescript
const createProduct = async (
  accessToken: string,
  name: string
): Promise<{ id: string }> => {
  const response = await fetch(
    'https://api-m.sandbox.paypal.com/v1/billing/products',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        name: name,
        type: 'SERVICE', // or 'PHYSICAL'
        description: 'Monthly subscription product',
      }),
    }
  );

  return response.json();
};
```

### Create Billing Plan

```typescript
const createBillingPlan = async (
  accessToken: string,
  productId: string,
  price: string,
  currency: string = 'USD'
): Promise<{ id: string }> => {
  const response = await fetch(
    'https://api-m.sandbox.paypal.com/v1/billing/plans',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
        'Prefer': 'return=representation',
      },
      body: JSON.stringify({
        product_id: productId,
        name: 'Monthly Plan',
        description: 'Recurring monthly subscription',
        status: 'ACTIVE',
        billing_cycles: [
          {
            frequency: {
              interval_unit: 'MONTH',
              interval_count: 1,
            },
            tenure_type: 'TRIAL',
            sequence: 1,
            total_cycles: 1,
            pricing_scheme: {
              fixed_price: {
                value: '0.00',
                currency_code: currency,
              },
            },
          },
          {
            frequency: {
              interval_unit: 'MONTH',
              interval_count: 1,
            },
            tenure_type: 'REGULAR',
            sequence: 2,
            total_cycles: 0, // Infinite
            pricing_scheme: {
              fixed_price: {
                value: price,
                currency_code: currency,
              },
            },
          },
        ],
        payment_preferences: {
          auto_bill_amount: 'YES',
          payment_failure_threshold: 3,
          setup_fee: {
            value: '0.00',
            currency_code: currency,
          },
        },
      }),
    }
  );

  if (!response.ok) {
    throw new Error(`Failed to create plan: ${response.statusText}`);
  }

  return response.json();
};
```

## Create Subscription

```typescript
const createSubscription = async (
  accessToken: string,
  planId: string,
  customerId: string
): Promise<{ id: string; status: string }> => {
  const response = await fetch(
    'https://api-m.sandbox.paypal.com/v1/billing/subscriptions',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
        'PayPal-Request-Id': crypto.randomUUID(),
        'Prefer': 'return=representation',
      },
      body: JSON.stringify({
        plan_id: planId,
        subscriber: {
          name: {
            given_name: 'John',
            surname: 'Doe',
          },
          email_address: `${customerId}@example.com`,
        },
        application_context: {
          brand_name: 'Your Brand',
          user_action: 'SUBSCRIBE_NOW',
          return_url: 'https://example.com/success',
          cancel_url: 'https://example.com/cancel',
        },
        start_time: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      }),
    }
  );

  if (!response.ok) {
    throw new Error(`Failed to create subscription: ${response.statusText}`);
  }

  return response.json();
};
```

**Response**:
```json
{
  "id": "I-7VDXP9A6XZP5",
  "status": "APPROVAL_PENDING",
  "links": [
    {
      "rel": "approve",
      "href": "https://www.sandbox.paypal.com/subscribe?token=I-7VDXP9A6XZP5"
    }
  ]
}
```

## Subscription Lifecycle

| Status | Meaning |
|--------|---------|
| `APPROVAL_PENDING` | Awaiting customer approval |
| `APPROVED` | Customer approved, awaiting activation |
| `ACTIVE` | Subscription active, payments processing |
| `SUSPENDED` | Payment failed, automatic retry in progress |
| `CANCELLED` | Subscription cancelled by merchant or customer |
| `EXPIRED` | Subscription naturally expired |

## Revise Subscription (Upgrade/Downgrade)

```typescript
const reviseSubscription = async (
  subscriptionId: string,
  accessToken: string,
  newPrice: string
): Promise<void> => {
  const response = await fetch(
    `https://api-m.sandbox.paypal.com/v1/billing/subscriptions/${subscriptionId}/revise`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        plan_id: 'new_plan_id_if_changing_plan', // optional
        pricing_schemes: [
          {
            billing_cycle_sequence: 2, // Apply to regular cycle
            pricing_scheme: {
              fixed_price: {
                value: newPrice,
                currency_code: 'USD',
              },
            },
          },
        ],
      }),
    }
  );

  if (!response.ok) {
    throw new Error('Failed to revise subscription');
  }
};
```

## Suspend Subscription

```typescript
const suspendSubscription = async (
  subscriptionId: string,
  accessToken: string,
  reason: string
): Promise<void> => {
  await fetch(
    `https://api-m.sandbox.paypal.com/v1/billing/subscriptions/${subscriptionId}/suspend`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        reason_code: 'CUSTOMER_REQUEST',
        reason: reason,
      }),
    }
  );
};
```

## Cancel Subscription

```typescript
const cancelSubscription = async (
  subscriptionId: string,
  accessToken: string,
  reason: string
): Promise<void> => {
  await fetch(
    `https://api-m.sandbox.paypal.com/v1/billing/subscriptions/${subscriptionId}/cancel`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        reason_code: 'CUSTOMER_REQUEST',
        reason: reason,
      }),
    }
  );
};
```

## Get Subscription Details

```typescript
const getSubscription = async (
  subscriptionId: string,
  accessToken: string
): Promise<any> => {
  const response = await fetch(
    `https://api-m.sandbox.paypal.com/v1/billing/subscriptions/${subscriptionId}`,
    {
      headers: { 'Authorization': `Bearer ${accessToken}` },
    }
  );
  return response.json();
};
```

## Pricing Scheme Types

### Fixed Price
Same amount every billing cycle.

### Tiered Pricing
Volume-based pricing.

```typescript
{
  pricing_scheme: {
    tiered_pricing: [
      {
        starting_quantity: '1',
        ending_quantity: '10',
        pricing_mode: 'VOLUME',
        fixed_price: { value: '100', currency_code: 'USD' },
      },
      {
        starting_quantity: '11',
        ending_quantity: '100',
        pricing_mode: 'VOLUME',
        fixed_price: { value: '90', currency_code: 'USD' },
      },
    ],
  },
}
```

## Trial Period Example

```typescript
{
  billing_cycles: [
    {
      frequency: {
        interval_unit: 'MONTH',
        interval_count: 1,
      },
      tenure_type: 'TRIAL',
      sequence: 1,
      total_cycles: 1, // 1 month free
      pricing_scheme: {
        fixed_price: {
          value: '0.00',
          currency_code: 'USD',
        },
      },
    },
    // ... regular cycle follows
  ],
}
```
