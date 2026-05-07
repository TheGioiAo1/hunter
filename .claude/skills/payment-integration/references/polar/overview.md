# Polar Overview

Polar is a modern payment and subscription platform for digital products and services, offering both payment processing and subscription management capabilities.

## Core Capabilities

- **Flexible Pricing Models:** Fixed price, usage-based, tiered, custom
- **Subscription Management:** Automatic renewals, trials, downgrades
- **Checkout Flows:** Hosted checkout, embedded checkout, checkout links
- **Product Management:** Licensing, digital benefits (files, GitHub access, Discord roles, etc.)
- **Webhooks:** Real-time event notifications
- **Multi-Currency Support:** Global transactions
- **Team/Organization Support:** Multiple business entities
- **Customer Portal:** Self-service management, subscription updates

## Authentication

### OAT (OAuth Access Token)
- Personal access tokens for API authentication
- Used for server-side integrations
- Format: `Authorization: Bearer polar_oa_xxxxx`
- Scope-based permissions

### OAuth2
- Full OAuth2 flow for application integrations
- Third-party app authorization
- User consent workflows

## Base URLs

**API:** `https://api.polar.sh`
**Dashboard:** `https://app.polar.sh`

## Rate Limits

- **Tier 1 (Free):** 10 requests/second
- **Tier 2 (Standard):** 30 requests/second
- **Tier 3 (Pro):** 100 requests/second

Rate limit headers:
- `X-RateLimit-Limit`
- `X-RateLimit-Remaining`
- `X-RateLimit-Reset`

## Key Concepts

### Products
- Digital goods, services, or subscriptions
- Can be one-time or recurring
- Support multiple pricing models
- Can offer benefits (files, licenses, access)

### Customers
- Individual or organization accounts
- Can have subscriptions and one-time purchases
- Customer portal for self-service management
- Support multiple payment methods

### Subscriptions
- Recurring revenue model
- Lifecycle: active → paused → canceled
- Support trials, upgrades, downgrades
- Automatic renewal handling

### Checkouts
- Payment collection points
- Support multiple products
- Configurable success/error flows
- Can be hosted, embedded, or link-based

### Benefits
- Value delivery system
- Types: licenses, GitHub access, Discord roles, files, usage credits, custom webhooks
- Auto-granted on subscription/purchase
- Revoked on cancellation

### Webhooks
- Real-time event notifications
- Signature verification for security
- Auto-retry mechanism
- Event types: subscription, order, organization updates

## Quick Start

```typescript
import { Polar } from '@polar-sh/sdk';

const polar = new Polar({
  accessToken: 'polar_oa_xxxxx',
});

// Create a product
const product = await polar.products.create({
  organizationId: 'org_123',
  name: 'Pro Plan',
  prices: [{
    type: 'recurring',
    recurringInterval: 'month',
    amountMinor: 9900, // $99.00
    currency: 'usd',
  }],
});
```

## Common Workflows

1. **Sell Subscriptions:** Create product → Setup checkout → Handle webhooks
2. **Offer Trials:** Configure trial period in pricing → Webhook on trial end
3. **Deliver Benefits:** Add benefits to product → Auto-grant on purchase
4. **Manage Customers:** Create customer → Track purchases and subscriptions
5. **Generate Revenue Reports:** Query subscription data → Calculate metrics

## Sandbox vs Production

- **Sandbox:** `polar-test_*` credentials, prefixed with `test_`
- **Production:** `polar_*` credentials, real transactions
- Switch via API credentials in dashboard
- Test cards available in sandbox

## Error Handling

Standard HTTP status codes with JSON error responses:

```json
{
  "detail": "Error message",
  "type": "error_type"
}
```

Common statuses:
- 400: Bad Request (validation error)
- 401: Unauthorized (invalid auth)
- 403: Forbidden (insufficient permissions)
- 404: Not Found
- 422: Unprocessable Entity (validation error)
- 429: Too Many Requests (rate limited)
- 500: Server Error
