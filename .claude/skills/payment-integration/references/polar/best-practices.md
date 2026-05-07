# Polar Best Practices

Production-ready patterns for payment integration and revenue management.

## Environment Configuration

### Sandbox vs Production
Separate credentials and endpoints:

```typescript
const environment = process.env.NODE_ENV === 'production' 
  ? 'production'
  : 'sandbox';

const polar = new Polar({
  accessToken: process.env.POLAR_API_KEY,
  environment
});
```

### Environment Variables
```bash
# .env.local (sandbox)
POLAR_API_KEY=polar-sb_xxxxx
NEXT_PUBLIC_POLAR_ENV=sandbox

# .env.production (production)
POLAR_API_KEY=polar_xxxxx
NEXT_PUBLIC_POLAR_ENV=production
```

### Secrets Management
Store API keys securely:
- Never commit to git
- Use environment variable services
- Rotate keys periodically
- Use distinct keys per environment

## Checkout Flow Implementation

### Basic Checkout Flow
```typescript
// 1. Create checkout
const checkout = await polar.checkouts.create({
  productId: req.body.productId,
  priceId: req.body.priceId,
  customerId: req.user?.id,  // optional, pre-populate
  successUrl: `${process.env.BASE_URL}/success`,
  errorUrl: `${process.env.BASE_URL}/error`,
  metadata: {
    userId: req.user?.id,
    campaignId: req.body.campaignId
  }
});

// 2. Return checkout URL to frontend
res.json({ checkoutUrl: checkout.url });

// 3. Frontend redirects or opens checkout
window.location.href = checkout.url;

// 4. After payment, Polar redirects to successUrl
// Success page retrieves order via checkout ID
```

### Pre-Checkout Validation
Validate before creating checkout:

```typescript
export async function validateCheckout(productId, priceId) {
  // Check product exists
  const product = await polar.products.retrieve(productId);
  if (!product) throw new Error('Product not found');
  
  // Check price exists
  const hasPrice = product.prices.some(p => p.id === priceId);
  if (!hasPrice) throw new Error('Invalid price');
  
  // Additional validations
  if (product.archived) throw new Error('Product unavailable');
  
  return { product, valid: true };
}
```

### Post-Checkout Confirmation
Handle success redirect:

```typescript
// pages/success.tsx
import { useSearchParams } from 'next/navigation';

export default function SuccessPage() {
  const searchParams = useSearchParams();
  const checkoutId = searchParams.get('checkout_id');
  
  useEffect(() => {
    // Verify order on backend
    const verifyOrder = async () => {
      const response = await fetch(`/api/verify-order?checkout=${checkoutId}`);
      const { orderId, status } = await response.json();
      
      if (status === 'fulfilled') {
        // Order fulfilled, benefits granted
        // Redirect to app or show success message
      }
    };
    
    verifyOrder();
  }, [checkoutId]);
  
  return <div>Payment received! Your benefits are being prepared...</div>;
}
```

## Webhook Handler Patterns

### Idempotent Processing
Handle duplicate webhooks safely:

```typescript
const processedWebhooks = new Set();

async function handleWebhook(event) {
  // Check if already processed
  if (processedWebhooks.has(event.id)) {
    return { success: true }; // Already handled
  }
  
  try {
    switch (event.type) {
      case 'subscription.created':
        await handleSubscriptionCreated(event.data);
        break;
      // ... other handlers
    }
    
    // Mark as processed
    processedWebhooks.add(event.id);
    
    // Optional: Store in database for persistence
    await db.webhooks.insert({ eventId: event.id, processed: true });
    
    return { success: true };
  } catch (error) {
    console.error('Webhook processing failed:', error);
    // Don't mark as processed, allow retry
    throw error;
  }
}
```

### Event-Specific Handlers
```typescript
const webhookHandlers = {
  'subscription.created': async (subscription) => {
    // Create user account or enable access
    await db.subscriptions.insert(subscription);
    await sendWelcomeEmail(subscription.customerId);
  },
  
  'subscription.canceled': async (subscription) => {
    // Revoke access
    await db.subscriptions.delete(subscription.id);
    await revokeCustomerAccess(subscription.customerId);
  },
  
  'invoice.paid': async (invoice) => {
    // Update accounting
    await accounting.recordPayment(invoice);
    // Send receipt
    await sendReceiptEmail(invoice.customerId, invoice);
  },
  
  'order.fulfilled': async (order) => {
    // Grant benefits
    await fulfillOrder(order);
  }
};
```

## Fee Calculation and Pricing

### Understand Polar Fees
Polar charges:
- Standard: 2.9% + $0.30 per transaction
- Custom: Negotiable on higher volume

**Calculate net proceeds:**
```typescript
function calculateNetProceeds(amount, taxRate = 0) {
  const subtotal = amount / (1 + taxRate);
  const polarFee = subtotal * 0.029 + 0.30;
  return subtotal - polarFee;
}

// Example: $99 order
const grossAmount = 99 * 1.0; // no tax
const netProceeds = calculateNetProceeds(grossAmount);
console.log(`Gross: $99, Net: $${netProceeds.toFixed(2)}`);
// Output: Gross: $99, Net: $96.42
```

### Dynamic Pricing Calculations
Account for platform fees in pricing:

```typescript
function calculateCheckoutPrice(targetMargin, polarFee = 0.029) {
  // targetMargin = net amount you want
  // Solve: targetMargin = amount * (1 - polarFee) - 0.30
  const checkoutAmount = (targetMargin + 0.30) / (1 - polarFee);
  return Math.ceil(checkoutAmount * 100) / 100; // Round to cents
}

// Example: Want to net $79
const checkoutPrice = calculateCheckoutPrice(79);
console.log(`Display price: $${checkoutPrice}`);
// Output: Display price: $82
```

## Discount Management

### Apply Discount Codes
```typescript
// In checkout creation
const checkout = await polar.checkouts.create({
  productId: 'prod_123',
  priceId: 'price_456',
  discountCode: 'SAVE20',  // Apply code
  successUrl: '...',
  errorUrl: '...'
});
```

### Create Promotional Campaigns
```typescript
// Create time-limited discount
const discount = await polar.discountCodes.create({
  organizationId: 'org_123',
  productId: 'prod_456',
  code: 'NEWUSER25',
  discountType: 'percentage',
  discountPercentage: 25,
  maxRedemptions: 1000,
  maxRedemptionsPerCustomer: 1,
  expiresAt: '2025-12-31T23:59:59Z',
  metadata: {
    campaign: 'launch',
    segment: 'email_list'
  }
});
```

### Track Campaign Performance
```typescript
async function getCampaignStats(code) {
  const discount = await polar.discountCodes.retrieve(code);
  
  return {
    code: discount.code,
    discount: `${discount.discountPercentage}%`,
    redeemed: discount.redeemed,
    maxRedemptions: discount.maxRedemptions,
    redeemRate: `${(discount.redeemed / discount.maxRedemptions * 100).toFixed(1)}%`,
    estimatedRevenue: discount.redeemed * discount.averageOrderValue
  };
}
```

## Revenue and Analytics Tracking

### Track Revenue Events
```typescript
// Send revenue event when subscription created
const subscriptionCreated = async (event) => {
  const { subscriptionId, amount, currency, customerId } = event.data;
  
  // Segment.io, Mixpanel, etc.
  analytics.track('Subscription Created', {
    subscriptionId,
    revenue: amount / 100,
    currency,
    userId: customerId
  });
  
  // Custom analytics
  await db.analytics.insert({
    event: 'subscription.created',
    amount,
    currency,
    timestamp: new Date(),
    customerId
  });
};
```

### MRR and ARR Calculations
```typescript
async function calculateMetrics() {
  const subscriptions = await polar.subscriptions.list({
    organizationId: 'org_123',
    status: 'active'
  });
  
  let mrr = 0;
  subscriptions.forEach(sub => {
    // Normalize to monthly
    const monthlyAmount = sub.billingCycle === 'month'
      ? sub.amount
      : sub.amount / 12;
    mrr += monthlyAmount;
  });
  
  const arr = mrr * 12;
  
  return {
    activeSubscriptions: subscriptions.length,
    mrr: (mrr / 100).toFixed(2),  // Convert from cents
    arr: (arr / 100).toFixed(2),
    avgMrr: ((mrr / subscriptions.length) / 100).toFixed(2)
  };
}
```

## Customer Portal Integration

### Redirect to Customer Portal
```typescript
app.get('/account/billing', (req, res) => {
  if (!req.user) {
    res.redirect('/login');
    return;
  }
  
  // Get customer in Polar
  const polar = new Polar({ accessToken: process.env.POLAR_API_KEY });
  
  // Redirect to Polar-hosted portal
  res.redirect(
    `https://app.polar.sh/customers/${req.user.polarCustomerId}/dashboard`
  );
});
```

### Self-Hosted Portal
Display subscriptions and manage access:

```typescript
// Get customer subscriptions
const subscriptions = await polar.subscriptions.list({
  customerId: req.user.polarCustomerId
});

res.render('billing', {
  subscriptions: subscriptions.map(sub => ({
    productName: sub.productName,
    amount: (sub.amount / 100).toFixed(2),
    currency: sub.currency,
    nextBillingDate: sub.currentPeriodEnd,
    status: sub.status
  }))
});
```

## Testing Patterns

### Sandbox Testing
Always test in sandbox first:

```typescript
// Use sandbox credentials during testing
const testPolar = new Polar({
  accessToken: 'polar-sb_xxxxx',
  environment: 'sandbox'
});

// Create test product
const testProduct = await testPolar.products.create({
  organizationId: 'org_sandbox_123',
  name: 'Test Product',
  prices: [{
    type: 'recurring',
    recurringInterval: 'month',
    amountMinor: 9900,
    currency: 'usd'
  }]
});

// Use test cards for checkout
const testCards = {
  success: '4242424242424242',
  decline: '4000000000000002',
  3dSecure: '4000002500003155'
};
```

### Mock Webhook Testing
```typescript
// Simulate webhook for testing
async function simulateWebhook(eventType, data) {
  const event = {
    type: eventType,
    id: `evt_test_${Date.now()}`,
    timestamp: new Date().toISOString(),
    data
  };
  
  // Call your webhook handler
  const response = await handleWebhook(event);
  console.log('Webhook response:', response);
}

// Test subscription creation
simulateWebhook('subscription.created', {
  id: 'sub_test_123',
  customerId: 'cust_test_456',
  productId: 'prod_test_789',
  status: 'active'
});
```

## Monitoring and Debugging

### Error Tracking
```typescript
import * as Sentry from "@sentry/node";

try {
  await polar.checkouts.create({...});
} catch (error) {
  Sentry.captureException(error, {
    tags: {
      service: 'polar',
      operation: 'checkout.create'
    },
    extra: {
      productId: req.body.productId,
      priceId: req.body.priceId
    }
  });
  
  throw error;
}
```

### Logging
```typescript
// Log all Polar API calls
const originalCreate = polar.checkouts.create.bind(polar.checkouts);
polar.checkouts.create = async function(...args) {
  const start = Date.now();
  console.log(`[Polar] Creating checkout with:`, args[0]);
  
  try {
    const result = await originalCreate(...args);
    console.log(`[Polar] Checkout created in ${Date.now() - start}ms:`, result.id);
    return result;
  } catch (error) {
    console.error(`[Polar] Checkout creation failed:`, error);
    throw error;
  }
};
```

## Best Practices Summary

1. **Separate Environments:** Use distinct sandbox/production configs
2. **Idempotent Webhooks:** Handle duplicates gracefully
3. **Error Handling:** Log and monitor all failures
4. **Fee Accounting:** Always include Polar fees in calculations
5. **Test First:** Always test in sandbox before production
6. **Security:** Never expose API keys in frontend code
7. **Monitoring:** Track key metrics (MRR, conversion, churn)
8. **Customer Communication:** Clear pricing and billing notifications
9. **Webhook Reliability:** Implement robust retry logic
10. **Documentation:** Document your checkout/subscription flow
