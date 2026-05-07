# Polar Benefits

Benefits are the value delivered to customers after purchase or subscription. They enable digital product monetization with automatic delivery and revocation.

## Benefit Types

### Downloadable Files
Deliver files (ebooks, templates, tools, etc.) immediately.

```json
{
  "type": "downloadable",
  "name": "Pro Template Pack",
  "properties": {
    "downloadUrl": "https://example.com/templates.zip",
    "fileName": "templates-pro.zip",
    "expiresAt": "2026-12-31T23:59:59Z"
  }
}
```

Behavior:
- File delivered instantly after purchase
- Download link sent to customer
- Optional expiration date
- Works for any file type

### License Keys
Distribute software licenses, API keys, or access codes.

```json
{
  "type": "license",
  "name": "Software License",
  "properties": {
    "key": "XXXX-XXXX-XXXX-XXXX",
    "expiresAt": "2026-12-31T23:59:59Z"
  }
}
```

Behavior:
- One key per customer
- Unique key generation
- Optional expiration
- Revoked on cancellation

### GitHub Access
Grant GitHub repository access automatically.

```json
{
  "type": "github",
  "name": "Private Repository Access",
  "properties": {
    "organizationName": "my-company",
    "repositoryName": "private-repo",
    "permission": "pull"  // pull, push, admin
  }
}
```

Behavior:
- Automatic org invitation
- Permission level configurable
- Revoked on cancellation
- Works with GitHub teams

Permissions:
- `pull` - Read-only access
- `push` - Read and write
- `admin` - Full admin access

### Discord Roles
Add Discord server roles automatically.

```json
{
  "type": "discord",
  "name": "Premium Member Role",
  "properties": {
    "guildId": "123456789",
    "roleId": "987654321",
    "requireRole": false  // if true, member must have role
  }
}
```

Behavior:
- Automatic role assignment
- Works via OAuth or invite link
- Revoked on cancellation
- Can require existing guild membership

### Meter Credits
Grant usage credits (API calls, storage, etc.).

```json
{
  "type": "meter",
  "name": "API Credits",
  "properties": {
    "meterId": "meter_123",
    "amount": 10000,  // credits granted
    "expiresAt": "2026-12-31T23:59:59Z",
    "renewalBehavior": "reset_on_period"  // or "accumulate"
  }
}
```

Behavior:
- Credits granted per subscription period
- Can reset or accumulate
- Tracked via meter API
- Revoked/reset on cancellation

### Custom Webhooks
Trigger custom logic when benefits are granted/revoked.

```json
{
  "type": "custom",
  "name": "Custom Integration",
  "properties": {
    "webhookUrl": "https://example.com/polar-webhook",
    "webhookSecret": "secret_123",
    "grantedPayload": {
      "action": "grant_access",
      "customData": "value"
    },
    "revokedPayload": {
      "action": "revoke_access",
      "customData": "value"
    }
  }
}
```

Behavior:
- Webhook called when benefit granted/revoked
- Implement any custom logic
- Can integrate with third-party systems
- Full control over integration

## Benefit Grants

### Automatic Grants
Benefits granted immediately on:
- Purchase completion
- Subscription activation
- Subscription renewal (for recurring benefits)

### Manual Grants
Grant benefits outside normal flow:
```
POST /benefits/grants
{
  "subscriptionId": "sub_123",
  "benefitId": "benefit_456",
  "grantedAt": "2025-01-15T10:30:00Z"
}
```

## Benefit Revocation

### Automatic Revocation
Benefits revoked on:
- Subscription cancellation
- Order refund
- Failed payment (after retries)
- Manual revocation

### Manual Revocation
```
POST /benefits/{id}/revocations
{
  "subscriptionId": "sub_123",
  "revokedAt": "2025-01-20T00:00:00Z",
  "reason": "customer_request"
}
```

## Customer Experience

### Benefit Delivery Flow

1. **Purchase Confirmation**
   - Customer completes checkout
   - Order marked as fulfilled
   - Benefits granted

2. **Email Notification**
   - Confirmation email sent
   - Benefit details included
   - Access instructions provided

3. **Customer Portal**
   - Benefits visible in dashboard
   - Download links available
   - Integration status shown

4. **Ongoing Access**
   - Active subscription = benefit active
   - Pause subscription = benefit access suspended
   - Cancel subscription = benefits revoked

### Download Links
Customers access downloads via portal or email:

```html
<!-- Email template -->
<h2>Your Download</h2>
<p>Thank you for your purchase!</p>
<a href="https://app.polar.sh/downloads/benefit_123">
  Download Your Files
</a>
```

## Benefit Configuration

### Product-Level Benefits
Add benefits when creating product:

```json
{
  "name": "Pro Plan",
  "benefits": [
    {
      "type": "downloadable",
      "name": "Documentation",
      "properties": {
        "downloadUrl": "https://example.com/docs.pdf"
      }
    },
    {
      "type": "license",
      "name": "License Key",
      "properties": {
        "key": "PRO-2025-XXXXX"
      }
    }
  ]
}
```

### Dynamic Benefits
Generate benefit per customer (keys, codes):

```typescript
// When order is fulfilled, generate unique key
app.post('/webhook/polar', async (req, res) => {
  const event = JSON.parse(req.body);
  
  if (event.type === 'order.created') {
    const { orderId, customerId } = event.data;
    
    // Generate unique license key
    const licenseKey = generateUniqueLicenseKey();
    
    // Grant benefit with dynamic key
    await polar.benefits.grant({
      orderId,
      benefitId: 'benefit_license',
      properties: { key: licenseKey }
    });
  }
});
```

## Benefit Analytics

### Track Benefit Usage
```
GET /benefits/{id}/grants?status=active,revoked
```

Response:
```json
{
  "grants": [
    {
      "customerId": "cust_123",
      "grantedAt": "2025-01-15T10:30:00Z",
      "revokedAt": null,
      "properties": {
        "key": "XXXX-XXXX-XXXX"
      }
    }
  ],
  "total": 150,
  "active": 147,
  "revoked": 3
}
```

### Monitor Grant/Revocation Events
Track via webhooks:
```json
{
  "type": "benefit.granted",
  "customerId": "cust_123",
  "benefitId": "benefit_456",
  "timestamp": "2025-01-15T10:30:00Z"
}
```

## Integration Patterns

### SaaS Access
Grant accounts programmatically:

```typescript
const event = await polar.webhooks.handle(req);

if (event.type === 'order.fulfilled') {
  const { customerId, email } = event.data;
  
  // Create SaaS account
  const account = await saas.createAccount({
    email,
    customerId,
    planTier: 'pro'
  });
  
  // Send credentials
  await sendCredentialsEmail(email, account);
}
```

### GitHub Repository Access
Auto-invite to private repos:

```typescript
if (event.type === 'subscription.active') {
  const { customerId } = event.data;
  const customer = await polar.customers.retrieve(customerId);
  
  // Invite to GitHub org
  await github.inviteUserToOrg({
    username: customer.githubUsername,
    org: 'my-org',
    role: 'member'
  });
}
```

### Content Delivery
Gate content based on benefits:

```typescript
// In API route
app.get('/api/premium-content', async (req, res) => {
  const subscription = await polar.subscriptions.retrieve(req.user.subscriptionId);
  
  if (subscription.status !== 'active') {
    return res.status(403).json({ error: 'Access denied' });
  }
  
  const hasAccess = await polar.benefits.hasAccess(
    subscription.id,
    'benefit_premium_content'
  );
  
  if (!hasAccess) {
    return res.status(403).json({ error: 'Benefit not granted' });
  }
  
  res.json(premiumContent);
});
```

### Usage-Based Limits
Apply benefit-based quotas:

```typescript
app.post('/api/usage', async (req, res) => {
  const { userId, amount } = req.body;
  const customer = await polar.customers.retrieve(userId);
  const meter = await polar.meters.report({
    customerId: customer.id,
    meterId: 'meter_api_calls',
    amount
  });
  
  if (meter.exceeded) {
    return res.status(429).json({ error: 'Quota exceeded' });
  }
  
  res.json({ success: true });
});
```

## Best Practices

1. **Clear Communication:** Explain exactly what customer receives
2. **Quick Delivery:** Grant benefits immediately after payment
3. **Accessible Retrieval:** Easy download/access for customers
4. **Multiple Methods:** Support email, portal, webhook retrieval
5. **Failure Handling:** Handle benefit grant failures gracefully
6. **Expiration Management:** Clear policy on benefit expiration
7. **Support Integration:** Easy customer support for benefit issues
8. **Analytics Tracking:** Monitor benefit adoption and usage
9. **Custom Logic:** Use webhooks for complex integrations
10. **Testing:** Test benefit grant/revocation in sandbox
