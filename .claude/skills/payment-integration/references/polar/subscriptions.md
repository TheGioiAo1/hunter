# Polar Subscriptions

Subscriptions enable recurring revenue models with automatic billing and comprehensive lifecycle management.

## Subscription Lifecycle

```
created (new)
  ↓
active (customer can use)
  ↓
paused (customer suspended, billing halted)
  ↓
canceled (ended by customer or merchant)
```

## States and Transitions

### Created
- Subscription just created
- Payment processing or awaiting first invoice
- Trial period starts here (if configured)

### Active
- Customer can use the product
- Automatic billing on schedule
- Customer can upgrade, downgrade, pause, or cancel

### Paused
- Subscription put on hold
- No access to product (usually)
- No billing during pause
- Can be resumed or canceled
- Resume date can be set

### Canceled
- Subscription ended permanently
- No further billing
- Access revoked (benefits removed)
- Cannot be resumed

## Trial Periods

Trial configuration at product level:
```json
{
  "prices": [{
    "type": "recurring",
    "recurringInterval": "month",
    "amountMinor": 9900,
    "currency": "usd",
    "trialDays": 14
  }]
}
```

Trial behavior:
- Subscription created but `status: 'trialing'`
- No charge during trial
- First payment on trial end
- Webhook fires when trial starts/ends
- Customer can cancel before trial end

## Billing and Invoices

### Auto-Renewal
Subscriptions auto-renew on billing cycle date:
```
Jan 15: subscription starts
Feb 15: auto-renew (first charge)
Mar 15: auto-renew (second charge)
```

### Invoice Generation
Invoice created before each billing cycle:
```
Invoice Status Flow:
  pending → scheduled → paid → collected
```

### Failed Payments
Retry mechanism:
- Automatic retry 3 times over 10 days
- Webhook on failure
- Subscription paused after final failed retry
- Customer notified to update payment method

## Upgrades and Downgrades

### Upgrade to Higher Tier
```
POST /subscriptions/{id}/change
{
  "priceId": "new_price_456"
}
```

Behavior:
- Prorated credit applied if mid-cycle
- Excess amount credited to next billing cycle
- Billing date remains unchanged
- Webhook: `subscription.updated`

**Example:**
```
Current: $99/month ($3.30/day), 15 days remaining = $49.50 credit
Upgrade to: $199/month ($6.63/day) 
Additional cost: $199 - $49.50 = $149.50 charge now
Next billing: On original date
```

### Downgrade to Lower Tier
```
POST /subscriptions/{id}/change
{
  "priceId": "new_price_123",
  "effectiveDate": "next_billing"  // or "immediately"
}
```

Behavior:
- Savings applied to next billing cycle
- Changes take effect on specified date
- No refunds (savings credited forward)

**Example:**
```
Current: $199/month, 15 days remaining = $99.50 credit
Downgrade to: $99/month
Savings applied to next billing cycle
```

## Pause and Resume

### Pause Subscription
```
POST /subscriptions/{id}/pause
{
  "resumeAt": "2025-03-15T00:00:00Z"  // optional
}
```

Effects:
- Status becomes `paused`
- Billing cycle pauses
- Benefits may be revoked (configurable)
- Resume date can be auto-set or specified

### Resume Subscription
```
POST /subscriptions/{id}/resume
{
  "resumeAt": "2025-03-01T00:00:00Z"  // optional, defaults to immediately
}
```

Effects:
- Status returns to `active`
- Billing resumes on next scheduled date
- Benefits reinstated
- Prorating applied if resumed mid-cycle

## Cancellation

### Cancel Immediately
```
DELETE /subscriptions/{id}
```

Effects:
- Status: `canceled`
- No further charges
- Benefits revoked immediately
- Webhook: `subscription.canceled`

### Cancel at Period End
```
POST /subscriptions/{id}/cancel
{
  "cancelAt": "2025-02-15T00:00:00Z"
}
```

Effects:
- Subscription marked for cancellation
- Continues until specified date
- No new charges after cancellation date
- Customer retains access until date
- Webhook: `subscription.canceled` fires on cancellation date

## Subscription API

### Get Subscription
```
GET /subscriptions/{id}
```

Response:
```json
{
  "id": "sub_123",
  "customerId": "cust_456",
  "productId": "prod_789",
  "priceId": "price_012",
  "status": "active",
  "currentPeriodStart": "2025-01-15T00:00:00Z",
  "currentPeriodEnd": "2025-02-15T00:00:00Z",
  "canceledAt": null,
  "cancelAtPeriodEnd": false,
  "pausedAt": null,
  "resumeAt": null,
  "trialEndsAt": null,
  "metadata": {}
}
```

### List Customer Subscriptions
```
GET /subscriptions?customerId=cust_456
```

### Update Subscription Metadata
```
PATCH /subscriptions/{id}
{
  "metadata": {
    "teamId": "team_123",
    "seatCount": "25"
  }
}
```

## Seat-Based Subscriptions

Adjust seat count mid-cycle:
```
PATCH /subscriptions/{id}
{
  "seatCount": 25
}
```

Prorating rules:
- Increase: Charge immediately for additional seats
- Decrease: Credit applied to next billing cycle

**Example:**
```
Current: 10 seats @ $15/month = $150/month
Days remaining in cycle: 15/30

Add 5 seats:
  New cost: 15 seats @ $15 = $225/month
  Additional seats (5): $75/month
  Prorated for 15 days: $75 * (15/30) = $37.50 charge now
```

## Webhooks

Common subscription events:
```
subscription.created
subscription.updated
subscription.active
subscription.paused
subscription.resumed
subscription.canceled
subscription.trialEnds
invoice.created
invoice.paid
invoice.failed
```

Example payload:
```json
{
  "type": "subscription.updated",
  "subscriptionId": "sub_123",
  "customerId": "cust_456",
  "status": "active",
  "previousStatus": "trialing",
  "timestamp": "2025-01-15T10:30:00Z"
}
```

## Subscription Retrieval and Management

### Retrieve With Invoices
```
GET /subscriptions/{id}?include=invoices
```

### Calculate Next Billing Date
```
GET /subscriptions/{id}/next-billing-date
```

Response:
```json
{
  "nextBillingDate": "2025-02-15T00:00:00Z",
  "estimatedAmount": 9900,
  "currency": "usd"
}
```

## Renewal Management

### Update Renewal Payment Method
```
PATCH /subscriptions/{id}
{
  "paymentMethodId": "pm_789"
}
```

### Get Renewal History
```
GET /subscriptions/{id}/invoices?statuses=paid,failed
```

## Best Practices

1. **Trial Conversion:** Email before trial ends
2. **Churn Prevention:** Offer retention incentives before cancellation
3. **Pause, Don't Cancel:** Encourage pause instead of full cancellation
4. **Billing Transparency:** Show next billing date and amount clearly
5. **Payment Methods:** Easy update of payment information
6. **Renewal Notifications:** Send invoice/renewal reminders
7. **Proration Clarity:** Clearly communicate upgrade/downgrade costs
8. **Webhook Processing:** Idempotent handlers for duplicates
9. **Seat Tracking:** Monitor seat additions/reductions for cost optimization
10. **Usage Analytics:** Track usage to inform upgrade opportunities
