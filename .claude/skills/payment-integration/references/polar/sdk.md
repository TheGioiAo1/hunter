# Polar SDK Integration

Official SDKs for multiple languages with framework-specific adapters.

## TypeScript/JavaScript SDK

**Installation:**
```bash
npm install @polar-sh/sdk
```

**Configuration:**
```typescript
import { Polar } from '@polar-sh/sdk';

const polar = new Polar({
  accessToken: process.env.POLAR_API_KEY,
  environment: 'production'  // or 'sandbox'
});
```

**Basic Usage:**
```typescript
// Create checkout
const checkout = await polar.checkouts.create({
  productId: 'prod_123',
  priceId: 'price_456',
  successUrl: 'https://example.com/success',
  errorUrl: 'https://example.com/error'
});

// Retrieve subscription
const subscription = await polar.subscriptions.retrieve('sub_123');

// List products
const products = await polar.products.list({
  organizationId: 'org_123'
});

// Create customer
const customer = await polar.customers.create({
  organizationId: 'org_123',
  email: 'user@example.com',
  name: 'John Doe'
});
```

## Python SDK

**Installation:**
```bash
pip install polar
```

**Configuration:**
```python
from polar import Polar

polar = Polar(
    access_token=os.getenv('POLAR_API_KEY'),
    environment='production'
)
```

**Basic Usage:**
```python
# Create product
product = polar.products.create(
    organization_id='org_123',
    name='Pro Plan',
    prices=[{
        'type': 'recurring',
        'recurring_interval': 'month',
        'amount_minor': 9900,
        'currency': 'usd'
    }]
)

# List subscriptions
subscriptions = polar.subscriptions.list(
    organization_id='org_123'
)

# Retrieve order
order = polar.orders.retrieve('order_123')

# Create webhook
webhook = polar.webhooks.create(
    organization_id='org_123',
    url='https://example.com/webhook',
    events=['subscription.created', 'order.fulfilled']
)
```

## PHP SDK

**Installation:**
```bash
composer require polar/sdk
```

**Configuration:**
```php
<?php

use Polar\PolarClient;

$polar = new PolarClient(
    accessToken: getenv('POLAR_API_KEY'),
    environment: 'production'
);
```

**Basic Usage:**
```php
<?php

// Create product
$product = $polar->products()->create([
    'organizationId' => 'org_123',
    'name' => 'Pro Plan',
    'prices' => [[
        'type' => 'recurring',
        'recurringInterval' => 'month',
        'amountMinor' => 9900,
        'currency' => 'usd'
    ]]
]);

// Retrieve customer
$customer = $polar->customers()->retrieve('cust_123');

// List invoices
$invoices = $polar->invoices()->list([
    'organizationId' => 'org_123',
    'limit' => 50
]);
```

## Go SDK

**Installation:**
```bash
go get github.com/polarizedev/go-sdk
```

**Configuration:**
```go
package main

import (
  "github.com/polarizedev/go-sdk"
)

func main() {
  client := polar.NewClient(
    os.Getenv("POLAR_API_KEY"),
    polar.ProductionEnvironment,
  )
}
```

**Basic Usage:**
```go
// Create checkout
checkout, err := client.Checkouts.Create(context.Background(), &polar.CheckoutRequest{
  ProductID: "prod_123",
  PriceID:   "price_456",
  SuccessURL: "https://example.com/success",
})

// Retrieve subscription
subscription, err := client.Subscriptions.Retrieve(
  context.Background(),
  "sub_123",
)

// List products
products, err := client.Products.List(context.Background(), &polar.ListRequest{
  OrganizationID: "org_123",
})
```

## Framework Adapters

### Next.js 13+
```typescript
// lib/polar.ts
import { Polar } from '@polar-sh/sdk';

export const polar = new Polar({
  accessToken: process.env.POLAR_API_KEY,
  environment: process.env.NODE_ENV === 'production' ? 'production' : 'sandbox'
});

// app/api/checkout/route.ts
import { polar } from '@/lib/polar';

export async function POST(req: Request) {
  const { productId, priceId } = await req.json();
  
  const checkout = await polar.checkouts.create({
    productId,
    priceId,
    successUrl: `${process.env.NEXT_PUBLIC_URL}/success`,
    errorUrl: `${process.env.NEXT_PUBLIC_URL}/error`
  });
  
  return Response.json(checkout);
}
```

### Express.js
```typescript
import express from 'express';
import { Polar } from '@polar-sh/sdk';

const app = express();
const polar = new Polar({
  accessToken: process.env.POLAR_API_KEY
});

app.post('/api/checkout', async (req, res) => {
  const checkout = await polar.checkouts.create({
    productId: req.body.productId,
    priceId: req.body.priceId,
    successUrl: `${process.env.BASE_URL}/success`,
    errorUrl: `${process.env.BASE_URL}/error`
  });
  
  res.json(checkout);
});

app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const signature = req.headers['x-polar-signature'];
  const timestamp = req.headers['x-polar-signature-timestamp'];
  
  // Verify and handle webhook...
  res.json({ success: true });
});

app.listen(3000);
```

### Laravel
```php
<?php

// config/polar.php
return [
    'api_key' => env('POLAR_API_KEY'),
    'environment' => env('POLAR_ENV', 'sandbox'),
];

// PolarService.php
namespace App\Services;

use Polar\PolarClient;

class PolarService {
    private $client;
    
    public function __construct() {
        $this->client = new PolarClient(
            accessToken: config('polar.api_key'),
            environment: config('polar.environment')
        );
    }
    
    public function createCheckout($productId, $priceId) {
        return $this->client->checkouts()->create([
            'productId' => $productId,
            'priceId' => $priceId,
            'successUrl' => route('checkout.success'),
            'errorUrl' => route('checkout.error')
        ]);
    }
    
    public function handleWebhook($payload) {
        match($payload['type']) {
            'subscription.created' => $this->handleSubscriptionCreated($payload),
            'order.fulfilled' => $this->handleOrderFulfilled($payload),
            default => null
        };
    }
}

// In controller
Route::post('/webhook/polar', function (Request $request) {
    $polar = app(PolarService::class);
    $polar->handleWebhook($request->json()->all());
    return response()->json(['success' => true]);
});
```

### FastAPI (Python)
```python
from fastapi import FastAPI, Request
from polar import Polar
import os

app = FastAPI()

polar = Polar(
    access_token=os.getenv('POLAR_API_KEY'),
    environment='production'
)

@app.post('/api/checkout')
async def create_checkout(product_id: str, price_id: str):
    checkout = await polar.checkouts.create(
        product_id=product_id,
        price_id=price_id,
        success_url='https://example.com/success',
        error_url='https://example.com/error'
    )
    return checkout

@app.post('/webhook/polar')
async def handle_webhook(request: Request):
    signature = request.headers.get('X-Polar-Signature')
    timestamp = request.headers.get('X-Polar-Signature-Timestamp')
    body = await request.body()
    
    # Verify signature...
    
    payload = await request.json()
    
    if payload['type'] == 'subscription.created':
        # Handle subscription...
        pass
    
    return {'success': True}
```

### Remix
```typescript
// routes/api/checkout.tsx
import { json, type ActionFunction } from '@remix-run/node';
import { Polar } from '@polar-sh/sdk';

const polar = new Polar({
  accessToken: process.env.POLAR_API_KEY
});

export const action: ActionFunction = async ({ request }) => {
  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, { status: 405 });
  }
  
  const { productId, priceId } = await request.json();
  
  const checkout = await polar.checkouts.create({
    productId,
    priceId,
    successUrl: `${process.env.BASE_URL}/success`,
    errorUrl: `${process.env.BASE_URL}/error`
  });
  
  return json(checkout);
};
```

## Lazy Initialization Pattern

Initialize SDK only when needed (reduces cold start time):

```typescript
let polar: Polar | null = null;

function getPolar(): Polar {
  if (!polar) {
    polar = new Polar({
      accessToken: process.env.POLAR_API_KEY
    });
  }
  return polar;
}

// Use in functions
export async function getCheckout(id: string) {
  return getPolar().checkouts.retrieve(id);
}
```

## Error Handling

```typescript
import { Polar, PolarError } from '@polar-sh/sdk';

try {
  const checkout = await polar.checkouts.create({
    productId: 'prod_123',
    priceId: 'invalid_price'
  });
} catch (error) {
  if (error instanceof PolarError) {
    console.error(`Polar API Error: ${error.status} - ${error.message}`);
    
    if (error.status === 422) {
      // Validation error
      console.error('Validation errors:', error.errors);
    }
  } else {
    throw error;
  }
}
```

## Best Practices

1. **Environment Configuration:** Use different API keys for sandbox/production
2. **Error Handling:** Catch and log all SDK errors
3. **Lazy Initialization:** Defer SDK creation until needed
4. **Type Safety:** Use TypeScript for better type checking
5. **Request Timeouts:** Set reasonable timeout values
6. **Rate Limiting:** Implement exponential backoff
7. **Logging:** Log all API calls for debugging
8. **Testing:** Test with sandbox credentials first
9. **Secrets Management:** Never commit API keys
10. **SDK Updates:** Keep SDKs up to date for latest features
