# Pay2s Payment Integration Overview

## What is Pay2s?

Pay2s is a Vietnamese bank transfer webhook service that monitors registered bank accounts and delivers real-time notifications when transfers arrive. It acts as a bridge between your application and Vietnam's banking system, enabling customers to complete payments via direct bank transfers.

**Core concept:** Customers initiate bank transfers → Pay2s detects the transfer → webhook fires with transaction details → your app processes the payment.

## How Pay2s Works

1. **Setup:** Register bank account(s) with Pay2s
2. **Monitoring:** Pay2s continuously monitors those accounts for incoming transfers
3. **Detection:** When a transfer arrives, Pay2s collects transaction metadata (amount, sender, memo, timestamp)
4. **Webhook Delivery:** Pay2s sends an HTTP POST to your webhook endpoint with a batch of transactions
5. **Processing:** Your app validates, matches orders, accumulates amounts, fulfills orders on completion

Unlike SePay (which provides QR generation APIs), Pay2s focuses purely on webhook delivery—the bank account and QR codes are managed separately.

## Authentication & Security

**Webhook endpoint configuration:**
- Your application provides a public HTTPS endpoint (e.g., `https://yourdomain.com/webhooks/pay2s`)
- Pay2s sends POST requests to this endpoint
- Optional checksum verification: payload includes `checksum` field for HMAC validation

**Environment variables:**
```bash
PAY2S_WEBHOOK_SECRET=your-secret-key-for-checksum-validation
PAY2S_WEBHOOK_ENDPOINT=https://yourdomain.com/webhooks/pay2s
```

**Security best practices:**
- Always verify checksum if provided (HMAC-SHA256)
- Whitelist Pay2s IP addresses if possible
- Log all webhook requests for audit trails
- Implement idempotency to handle retries safely

## Currency & Amount Format

- **Currency:** Vietnamese Dong (VND) only
- **Decimal handling:** Amounts are integers, no decimal places
- **Example:** 250,000 VND = `250000` (not `250000.00`)
- For multi-currency apps, convert user-facing amounts to VND before matching

## When to Choose Pay2s vs SePay

| Aspect | Pay2s | SePay |
|--------|-------|-------|
| **Setup** | Register existing bank account | Generate QR codes per transaction |
| **API Type** | Webhook-only | Webhook + QR generation API |
| **Transaction Batching** | Multiple transactions per webhook | Single transaction per webhook |
| **Use Case** | Fixed bank account, batch reconciliation | Dynamic QR per order, immediate confirmation |
| **Complexity** | Lower (passive monitoring) | Higher (active QR lifecycle) |
| **Customer Flow** | Manual bank app transfer | Scan QR, enter amount |

**Choose Pay2s if:**
- You have a dedicated bank account for payments
- Batch processing is acceptable (slight delay in webhook delivery)
- You want minimal setup overhead

**Choose SePay if:**
- You need unique QR per transaction for UX clarity
- You require immediate confirmation feedback
- You prefer active API control over passive webhooks

## Key Differences from SePay

1. **No QR API:** Pay2s does not provide dynamic QR generation—bank account and QR management is external
2. **Transaction Batching:** Multiple transactions in a single webhook payload (vs SePay's one-per-webhook)
3. **Simpler Integration:** Webhook endpoint only; no additional API calls needed
4. **Account Management:** You manage the bank account independently; Pay2s only monitors and reports

## Transaction Flow Example

```
Customer initiates payment via bank app
    ↓
Transfers 250,000 VND to your Pay2s-registered account
    ↓
Bank processes transfer
    ↓
Pay2s detects transfer, collects metadata
    ↓
Pay2s sends webhook: { transactions: [{id, amount, content, ...}] }
    ↓
Your app receives webhook
    ↓
Extracts order ID from memo (e.g., "CLXP 12345")
    ↓
Queries order, checks payment accumulation
    ↓
If completed: activate subscription, send email
```

## Webhook Delivery Guarantees

- **At-least-once delivery:** Pay2s may retry if your endpoint is unavailable
- **Batched transactions:** Multiple transactions delivered in a single webhook payload
- **Idempotency required:** Your app must handle duplicate webhooks gracefully (see webhooks.md)
