# Polar Checkouts

Checkouts are the interface for collecting payments from customers. Polar offers multiple checkout approaches to fit your use case.

## Checkout Types

### 1. Checkout Links
Pre-built, shareable payment links. Simplest to integrate.

**Advantages:**
- No code required
- Shareable via email, social, etc.
- Fully customizable branding
- No PCI compliance burden

**Create Checkout Link:**
```
POST /checkouts
{
  "productId": "prod_123",
  "priceId": "price_456",
  "successUrl": "https://example.com/success",
  "customerId": "cust_789",  // optional
  "discountCode": "SAVE20"   // optional
}
```

**Response:**
```json
{
  "id": "checkout_123",
  "clientSecret": "cs_live_xxxxx",
  "url": "https://checkout.polar.sh/checkout_123",
  "expiresAt": "2025-02-15T10:30:00Z"
}
```

Share `url` with customers directly.

### 2. Checkout Sessions
Backend-rendered checkouts with frontend handling.

**Create Session:**
```
POST /checkouts/sessions
{
  "productId": "prod_123",
  "priceId": "price_456",
  "successUrl": "https://example.com/success",
  "errorUrl": "https://example.com/error"
}
```

**Use Session Token in Frontend:**
```html
<script src="https://sdk.polar.sh/checkout.js"></script>
<button onclick="startCheckout()">Purchase</button>

<script>
function startCheckout() {
  PolarCheckout.open({
    clientSecret: sessionToken
  });
}
</script>
```

### 3. Embedded Checkout
Iframe-embedded payment form on your site.

**HTML:**
```html
<div id="polar-checkout"></div>

<script src="https://sdk.polar.sh/checkout.js"></script>
<script>
PolarCheckout.render({
  target: '#polar-checkout',
  clientSecret: 'cs_live_xxxxx',
  onSuccess: (result) => {
    console.log('Payment successful:', result);
  }
});
</script>
```

## Multi-Product Checkouts

Sell multiple products in one checkout:

```json
{
  "items": [
    {
      "productId": "prod_123",
      "priceId": "price_456",
      "quantity": 1
    },
    {
      "productId": "prod_789",
      "priceId": "price_012",
      "quantity": 2
    }
  ],
  "successUrl": "https://example.com/success",
  "errorUrl": "https://example.com/error"
}
```

## Customer Pre-Population

Pre-fill checkout with known customer data:

```json
{
  "productId": "prod_123",
  "priceId": "price_456",
  "customerId": "cust_123",  // Link to existing customer
  "customerEmail": "user@example.com",
  "customerName": "John Doe",
  "customerCountry": "US",
  "customerTaxId": "tax_12345",
  "successUrl": "https://example.com/success"
}
```

## Discount Application

### Apply Discount Code to Checkout
```json
{
  "productId": "prod_123",
  "priceId": "price_456",
  "discountCode": "SAVE20",
  "successUrl": "https://example.com/success"
}
```

### Validation
```
GET /discounts/validate?code=SAVE20&productId=prod_123
```

Response:
```json
{
  "valid": true,
  "type": "percentage",
  "value": 20,
  "description": "20% off",
  "remaining": 85  // Redemptions left
}
```

## Success/Error Handling

### URL Parameters
Success and error URLs receive query parameters:

**Success:**
```
https://example.com/success?
  checkout_id=checkout_123&
  status=completed&
  customer_id=cust_456
```

**Error:**
```
https://example.com/error?
  checkout_id=checkout_123&
  error=card_declined&
  error_message=Your+card+was+declined
```

### Webhook Confirmation
Webhooks fire on checkout completion:
```json
{
  "type": "checkout.completed",
  "checkoutId": "checkout_123",
  "customerId": "cust_456",
  "amount": 9900,
  "currency": "usd",
  "timestamp": "2025-01-15T10:30:00Z"
}
```

## Framework Examples

### Next.js 13+ (App Router)
```typescript
// app/checkout/[id]/page.tsx
'use client';

import { useEffect, useState } from 'react';

export default function CheckoutPage({ params }) {
  useEffect(() => {
    // Load checkout
    const loadCheckout = async () => {
      const response = await fetch(`/api/checkout/${params.id}`);
      const data = await response.json();
      
      // Render Polar checkout
      if (window.PolarCheckout) {
        window.PolarCheckout.render({
          target: '#checkout',
          clientSecret: data.clientSecret,
          onSuccess: handleSuccess
        });
      }
    };
    
    loadCheckout();
  }, [params.id]);

  const handleSuccess = (result) => {
    window.location.href = '/success';
  };

  return <div id="checkout" />;
}

// app/api/checkout/[id]/route.ts
export async function GET(request, { params }) {
  const checkout = await fetch(`https://api.polar.sh/checkouts/${params.id}`, {
    headers: { Authorization: `Bearer ${process.env.POLAR_API_KEY}` }
  }).then(r => r.json());
  
  return Response.json(checkout);
}
```

### Express.js
```javascript
app.get('/checkout/:id', async (req, res) => {
  const checkoutId = req.params.id;
  
  const checkout = await polar.checkouts.retrieve(checkoutId);
  
  res.render('checkout', {
    checkout,
    clientSecret: checkout.clientSecret
  });
});

app.post('/api/create-checkout', async (req, res) => {
  const checkout = await polar.checkouts.create({
    productId: req.body.productId,
    priceId: req.body.priceId,
    successUrl: `${process.env.BASE_URL}/success`,
    errorUrl: `${process.env.BASE_URL}/error`
  });
  
  res.json({ url: checkout.url });
});
```

### React
```jsx
import { useCallback, useEffect, useState } from 'react';

function CheckoutPage() {
  const [clientSecret, setClientSecret] = useState('');
  
  useEffect(() => {
    const createCheckout = async () => {
      const response = await fetch('/api/create-checkout', {
        method: 'POST',
        body: JSON.stringify({
          productId: 'prod_123',
          priceId: 'price_456'
        })
      });
      const { clientSecret } = await response.json();
      setClientSecret(clientSecret);
    };
    
    createCheckout();
  }, []);

  const openCheckout = useCallback(() => {
    window.PolarCheckout.open({
      clientSecret
    });
  }, [clientSecret]);

  return (
    <div>
      <h1>Checkout</h1>
      <button onClick={openCheckout}>Pay Now</button>
    </div>
  );
}
```

### Laravel
```php
<?php

Route::get('/checkout/{id}', function ($id) {
    $polar = app(PolarClient::class);
    $checkout = $polar->checkouts()->retrieve($id);
    
    return view('checkout', ['checkout' => $checkout]);
});

Route::post('/api/create-checkout', function () {
    $polar = app(PolarClient::class);
    
    $checkout = $polar->checkouts()->create([
        'productId' => request('product_id'),
        'priceId' => request('price_id'),
        'successUrl' => route('checkout.success'),
        'errorUrl' => route('checkout.error')
    ]);
    
    return response()->json(['url' => $checkout->url]);
});
```

## Checkout Customization

### Branding
```json
{
  "productId": "prod_123",
  "priceId": "price_456",
  "branding": {
    "logo": "https://example.com/logo.png",
    "primaryColor": "#0066cc",
    "accentColor": "#ff6600"
  },
  "successUrl": "https://example.com/success"
}
```

### Metadata
Attach custom data to checkout:
```json
{
  "productId": "prod_123",
  "priceId": "price_456",
  "metadata": {
    "userId": "user_123",
    "referrer": "newsletter",
    "campaign": "summer2025"
  },
  "successUrl": "https://example.com/success"
}
```

## Best Practices

1. **Clear CTAs:** Make "Buy Now" button obvious
2. **Trust Signals:** Show payment methods, security badges
3. **Mobile Optimized:** Test on mobile devices
4. **Error Recovery:** Clear error messages, easy retry
5. **Redirect Timing:** Immediately redirect on success
6. **Metadata Tracking:** Tag checkouts for analytics
7. **Discount Promotion:** Highlight available discount codes
8. **Pre-population:** Auto-fill known customer data
9. **Testing:** Always test in sandbox first
10. **Analytics:** Track checkout flow metrics
