# Polar Products

Products are the core of your monetization strategy on Polar. They represent digital goods, services, or subscriptions you offer to customers.

## Product Types

### One-Time Purchase
- Single payment model
- Customer receives benefit immediately
- No recurring charges
- Examples: ebooks, templates, tools

### Subscription
- Recurring billing (monthly, annual, etc.)
- Automatic renewals
- Customer can cancel anytime
- Lifecycle management (active, paused, canceled)
- Trial period support

## Billing Cycles

Subscriptions renew on fixed billing cycles:
- **Monthly:** Renews on same day each month
- **Annual:** Renews on same day each year
- **Custom:** Define your own interval

## Pricing Models

### Fixed Price
```json
{
  "type": "recurring",
  "recurringInterval": "month",
  "amountMinor": 9900,  // $99.00 (amount in cents)
  "currency": "usd"
}
```

### Tiered Pricing
Multiple pricing tiers within same product:
```json
{
  "name": "Pro Plan - Tiered",
  "prices": [
    {
      "name": "Starter",
      "amountMinor": 4900,
      "currency": "usd",
      "recurringInterval": "month"
    },
    {
      "name": "Professional",
      "amountMinor": 9900,
      "currency": "usd",
      "recurringInterval": "month"
    },
    {
      "name": "Enterprise",
      "amountMinor": 19900,
      "currency": "usd",
      "recurringInterval": "month"
    }
  ]
}
```

### Usage-Based Pricing
```json
{
  "type": "usage_based",
  "usagePricingMetricId": "metric_123",
  "usagePricingMode": "pay_as_you_go",
  "usagePricingPeriodStart": "current_period",
  "usagePricingPeriodEnd": "period_end"
}
```

Meter data reported as:
```json
{
  "meterId": "meter_123",
  "subscriptionId": "sub_456",
  "events": [
    {
      "timestamp": "2025-01-15T10:30:00Z",
      "amount": 100  // units consumed
    }
  ]
}
```

### Seat-Based Pricing
```json
{
  "type": "seat_based",
  "seatPricingAmountMinor": 1500,  // $15 per seat/month
  "currency": "usd",
  "recurringInterval": "month"
}
```

Adjust seats mid-subscription:
```
PATCH /products/{id}/subscriptions/{subscriptionId}
{
  "seatCount": 25
}
```

### Custom Pricing Models
Mix and match:
```json
{
  "type": "custom",
  "customPriceAmountMinor": 29900,
  "customPriceCurrency": "usd",
  "customPriceRecurringInterval": "month",
  "customPriceDescription": "Custom plan for enterprise"
}
```

## Trial Periods

```json
{
  "name": "Pro with Trial",
  "prices": [{
    "type": "recurring",
    "recurringInterval": "month",
    "amountMinor": 9900,
    "currency": "usd",
    "trialDays": 14  // 14-day free trial
  }]
}
```

Trial behavior:
- Customer doesn't pay during trial
- Subscription created but marked as trialing
- After trial ends, first charge occurs
- Webhook fired when trial ends
- Customer can cancel before trial ends

## Product Metadata

```json
{
  "name": "Pro Plan",
  "description": "Professional tier with advanced features",
  "mediaUrls": ["https://example.com/image.jpg"],
  "metadata": {
    "features": "advanced,analytics,support",
    "maxUsers": "unlimited",
    "dataRetention": "unlimited"
  }
}
```

Custom fields for tracking:
```json
{
  "name": "Custom Feature Plan",
  "attributes": [
    {
      "id": "attr_storage",
      "name": "Storage",
      "value": "1TB"
    },
    {
      "id": "attr_users",
      "name": "Team Members",
      "value": "50"
    }
  ]
}
```

## Benefits

Products can offer benefits automatically granted to customers:

```json
{
  "name": "Premium Plan",
  "benefits": [
    {
      "type": "downloadable",
      "name": "License Key",
      "properties": {
        "downloadUrl": "https://example.com/license-key.txt"
      }
    },
    {
      "type": "github",
      "name": "GitHub Access",
      "properties": {
        "organizationName": "my-org",
        "repositoryName": "my-repo",
        "permission": "pull"
      }
    },
    {
      "type": "discord",
      "name": "Discord Role",
      "properties": {
        "guildId": "guild123",
        "roleId": "role456"
      }
    }
  ]
}
```

## Product API

### Create Product
```
POST /products
{
  "organizationId": "org_123",
  "name": "Pro Plan",
  "description": "Premium features",
  "prices": [{
    "type": "recurring",
    "recurringInterval": "month",
    "amountMinor": 9900,
    "currency": "usd"
  }],
  "benefits": [...]
}
```

### List Products
```
GET /products?organizationId=org_123
```

### Get Product Details
```
GET /products/{id}
```

### Update Product
```
PATCH /products/{id}
{
  "name": "Updated Plan Name",
  "description": "Updated description"
}
```

### Delete Product
```
DELETE /products/{id}
```

Note: Can only delete products without purchases/subscriptions.

## Advanced Features

### Discount Codes

```typescript
const discount = await polar.discountCodes.create({
  organizationId: 'org_123',
  productId: 'prod_456',
  code: 'SAVE20',
  discountType: 'percentage',
  discountPercentage: 20,
  expiresAt: '2025-12-31T23:59:59Z',
  maxRedemptions: 100,
  maxRedemptionsPerCustomer: 1
});
```

### Product Bundles

Group multiple products:
```json
{
  "name": "Bundle: Starter Pack",
  "bundledProducts": [
    { "productId": "prod_001", "quantity": 1 },
    { "productId": "prod_002", "quantity": 1 }
  ],
  "bundleDiscountPercentage": 15
}
```

### Seasonal Pricing

Temporarily adjust prices:
```json
{
  "type": "recurring",
  "recurringInterval": "month",
  "amountMinor": 4900,  // Holiday discount
  "currency": "usd",
  "validFrom": "2025-12-01T00:00:00Z",
  "validTo": "2025-01-05T23:59:59Z"
}
```

## Best Practices

1. **Clear Pricing:** Make price and billing interval obvious
2. **Trial Strategy:** Offer trial for high-consideration products
3. **Transparent Metadata:** Document features, limits, inclusions
4. **Benefit Clarity:** Clearly communicate what customers receive
5. **Usage Tracking:** Use meters for usage-based products
6. **Version Control:** Manage price changes with effective dates
7. **Testing:** Use sandbox to test all pricing models before launch
