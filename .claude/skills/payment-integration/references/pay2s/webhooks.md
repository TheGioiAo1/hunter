# Pay2s Webhook Integration Guide

## Webhook Payload Structure

Pay2s delivers transactions in batches via a single webhook POST request:

```typescript
export class Pay2sTransactionDto {
  id!: string;                    // Unique transaction ID from Pay2s
  gateway!: string;               // Bank gateway code (e.g., "VIETCOMBANK", "TECHCOMBANK")
  transactionDate!: string;       // ISO 8601 timestamp (e.g., "2026-04-16T10:30:00Z")
  transactionNumber!: string;     // Bank-issued transaction reference number
  accountNumber!: string;         // Receiving account number (your registered account)
  content!: string;               // Transfer memo/description from sender
  transferType!: string;          // 'IN' (incoming) or 'OUT' (outgoing)
  transferAmount!: number;        // Amount in VND (integer, no decimals)
  checksum?: string;              // Optional HMAC verification checksum
}

export class Pay2sWebhookDto {
  transactions!: Pay2sTransactionDto[];  // Array of transactions (1 or more)
}
```

## Field Descriptions

| Field | Type | Purpose | Example |
|-------|------|---------|---------|
| `id` | string | Unique Pay2s transaction ID, used for idempotency | `"tx-20260416-001234"` |
| `gateway` | string | Bank code | `"VIETCOMBANK"` |
| `transactionDate` | string | ISO timestamp of bank transaction | `"2026-04-16T10:30:45Z"` |
| `transactionNumber` | string | Bank's reference number | `"0041234567"` |
| `accountNumber` | string | Your registered receiving account | `"123456789012"` |
| `content` | string | Memo/description from sender | `"CLXP 12345 - Monthly Sub"` |
| `transferType` | string | Direction: `'IN'` or `'OUT'` | `"IN"` |
| `transferAmount` | number | Amount in VND (integer) | `250000` |
| `checksum` | string (optional) | HMAC-SHA256 for validation | `"a1b2c3d4..."` |

## Processing Flow

### 1. Receive & Validate Webhook

```typescript
// NestJS controller example
import { Controller, Post, Body, BadRequestException } from '@nestjs/common';
import { Pay2sWebhookDto, Pay2sTransactionDto } from './pay2s.dto';
import { Pay2sService } from './pay2s.service';

@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly pay2sService: Pay2sService) {}

  @Post('pay2s')
  async handlePay2sWebhook(@Body() payload: Pay2sWebhookDto) {
    // Validate webhook signature (if checksum provided)
    if (payload.transactions?.length === 0) {
      throw new BadRequestException('No transactions in payload');
    }

    // Process each transaction independently
    const results = await this.pay2sService.processBatch(payload.transactions);
    
    return { success: true, processed: results.length };
  }
}
```

### 2. Filter & Idempotency Check

```typescript
// pay2s.service.ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '@nestjs/prisma';
import { Pay2sTransactionDto } from './pay2s.dto';

@Injectable()
export class Pay2sService {
  constructor(private readonly prisma: PrismaService) {}

  async processBatch(transactions: Pay2sTransactionDto[]) {
    const results = [];

    for (const tx of transactions) {
      try {
        // Step 1: Only process incoming transfers
        if (tx.transferType !== 'IN') {
          console.log(`[Pay2s] Skipping ${tx.transferType} transfer: ${tx.id}`);
          results.push({ id: tx.id, status: 'skipped', reason: 'not_incoming' });
          continue;
        }

        // Step 2: Idempotency check
        // Query by (service + external_id) to ensure exactly-once processing
        const existing = await this.prisma.payment.findUnique({
          where: {
            service_external_id: {
              service: 'pay2s',
              external_id: tx.id, // Pay2s transaction ID
            },
          },
        });

        if (existing) {
          console.log(`[Pay2s] Duplicate transaction (idempotent): ${tx.id}`);
          results.push({ 
            id: tx.id, 
            status: 'duplicate', 
            paymentId: existing.id 
          });
          continue;
        }

        // Step 3: Process the transaction
        const result = await this.processTransaction(tx);
        results.push(result);
      } catch (error) {
        // Fail gracefully: log error, continue with next transaction
        console.error(`[Pay2s] Error processing ${tx.id}:`, error.message);
        results.push({ 
          id: tx.id, 
          status: 'error', 
          error: error.message 
        });
      }
    }

    return results;
  }

  private async processTransaction(tx: Pay2sTransactionDto) {
    // Step 3a: Extract order ID from memo
    const orderId = this.extractOrderIdFromMemo(tx.content);
    if (!orderId) {
      return {
        id: tx.id,
        status: 'skipped',
        reason: 'no_order_id_in_memo',
      };
    }

    // Step 3b: Find order
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
    });

    if (!order) {
      return {
        id: tx.id,
        status: 'skipped',
        reason: `order_not_found_${orderId}`,
      };
    }

    // Step 3c: Create payment record (idempotency key)
    const payment = await this.prisma.payment.create({
      data: {
        service: 'pay2s',
        external_id: tx.id, // Unique constraint: service + external_id
        order_id: order.id,
        amount: tx.transferAmount,
        currency: 'VND',
        gateway: tx.gateway,
        transaction_number: tx.transactionNumber,
        transaction_date: new Date(tx.transactionDate),
        memo: tx.content,
        raw_payload: tx,
        status: 'confirmed',
      },
    });

    // Step 3d: Accumulate payment
    const accumulated = await this.accumulatePayment(order);

    // Step 3e: Check completion & fulfill
    if (accumulated.total >= order.total_amount) {
      await this.fulfillOrder(order);
    }

    return {
      id: tx.id,
      status: 'processed',
      payment_id: payment.id,
      order_id: order.id,
      accumulated_total: accumulated.total,
      completed: accumulated.total >= order.total_amount,
    };
  }

  // Extract order ID from memo using regex
  private extractOrderIdFromMemo(memo: string): string | null {
    // Pattern: "CLXP 12345" or "CLXP12345"
    const match = memo.match(/CLXP\s*(\d+)/i);
    return match ? match[1] : null;
  }

  // Accumulate payments toward order total
  private async accumulatePayment(order: any) {
    const confirmed = await this.prisma.payment.aggregate({
      where: {
        order_id: order.id,
        status: 'confirmed',
      },
      _sum: {
        amount: true,
      },
    });

    return {
      total: confirmed._sum.amount || 0,
      pending: order.total_amount - (confirmed._sum.amount || 0),
    };
  }

  // Fulfill order on payment completion
  private async fulfillOrder(order: any) {
    // Update order status
    await this.prisma.order.update({
      where: { id: order.id },
      data: { status: 'paid' },
    });

    // Activate subscription
    if (order.subscription_id) {
      await this.prisma.subscription.update({
        where: { id: order.subscription_id },
        data: { status: 'active' },
      });
    }

    // Send welcome email
    await this.emailService.sendWelcomeEmail(order.user);

    console.log(`[Pay2s] Order ${order.id} fulfilled`);
  }
}
```

## Idempotency Pattern

**Problem:** Pay2s may retry webhooks if your endpoint times out or returns an error. Without idempotency, duplicate payments would be recorded.

**Solution:** Unique constraint on `(service, external_id)` in your payments table:

```typescript
// Prisma schema
model Payment {
  id              String      @id @default(cuid())
  service         String      // 'pay2s', 'sepay', etc.
  external_id     String      // Pay2s transaction ID
  order_id        String
  order           Order       @relation(fields: [order_id], references: [id])
  amount          Int         // VND
  currency        String      @default("VND")
  gateway         String
  transaction_number String
  transaction_date DateTime
  memo            String
  raw_payload     Json
  status          String      @default("pending") // 'pending', 'confirmed', 'failed'
  created_at      DateTime    @default(now())
  updated_at      DateTime    @updatedAt

  @@unique([service, external_id]) // Idempotency key
}
```

**Result:** If the same `tx.id` arrives twice, the second `create()` will throw a unique constraint violation, which you catch and return as "duplicate" (safe operation).

## Webhook Validation (Checksum)

If Pay2s includes a `checksum` in the payload, validate it to ensure authenticity:

```typescript
import * as crypto from 'crypto';

private validateChecksum(payload: Pay2sWebhookDto, checksum: string): boolean {
  if (!process.env.PAY2S_WEBHOOK_SECRET) {
    console.warn('[Pay2s] No webhook secret configured; skipping checksum validation');
    return true; // Allow if secret not set
  }

  // HMAC-SHA256 over JSON payload (without checksum field)
  const { checksum: _, ...payloadWithoutChecksum } = payload;
  const message = JSON.stringify(payloadWithoutChecksum);
  const computed = crypto
    .createHmac('sha256', process.env.PAY2S_WEBHOOK_SECRET)
    .update(message)
    .digest('hex');

  const valid = computed === checksum;
  if (!valid) {
    console.error('[Pay2s] Checksum validation failed');
  }
  return valid;
}
```

## Error Handling Strategy

**Per-transaction error handling:** Each transaction fails independently; one error does not break the batch:

```typescript
for (const tx of transactions) {
  try {
    // Process transaction
  } catch (error) {
    // Log error, continue with next transaction
    console.error(`[Pay2s] Error processing ${tx.id}:`, error.message);
    results.push({ id: tx.id, status: 'error', error: error.message });
  }
}

// Return success even if some transactions failed
return { success: true, processed: results };
```

**Webhook response:** Always return HTTP 200 if the webhook was received and parsed. Async errors are logged but don't fail the webhook response.

## Common Patterns

### Memo-Based Order Matching

Extract order ID from the transfer memo:

```typescript
// Pattern: "CLXP 12345" or "ORDER-12345"
private extractOrderId(memo: string): string | null {
  // Try "CLXP XXXXX" pattern first
  let match = memo.match(/CLXP\s*(\d+)/i);
  if (match) return match[1];

  // Try "ORDER-XXXXX" pattern
  match = memo.match(/ORDER-(\d+)/i);
  if (match) return match[1];

  return null;
}
```

### Overpayment Tolerance

Some payments may arrive with slight overpayment (customer rounding up). Set a tolerance:

```typescript
private async checkCompletion(order: any, tolerance_vnd: number = 5000) {
  const accumulated = await this.accumulatePayment(order);
  
  // Allow slight overpayment
  const completed = accumulated.total >= (order.total_amount - tolerance_vnd);
  
  return {
    completed,
    overpay: Math.max(0, accumulated.total - order.total_amount),
    underpay: Math.max(0, order.total_amount - accumulated.total),
  };
}
```

### Partial Payment Accumulation

Log partial payments and fulfill only when total is reached:

```typescript
private async accumulatePayment(order: any) {
  const payments = await this.prisma.payment.findMany({
    where: { order_id: order.id, status: 'confirmed' },
    orderBy: { created_at: 'asc' },
  });

  const total = payments.reduce((sum, p) => sum + p.amount, 0);
  
  return {
    total,
    count: payments.length,
    pending: order.total_amount - total,
    payments, // For audit trail
  };
}
```

## Security Considerations

1. **Webhook URL Protection:**
   - Use HTTPS only
   - Rotate webhook URL periodically
   - Consider IP whitelisting Pay2s servers

2. **Rate Limiting:**
   - Limit webhook endpoint to Pay2s IP ranges
   - Implement request throttling to prevent abuse

3. **Data Validation:**
   - Validate all incoming amounts are positive integers
   - Verify account number matches your registered account
   - Sanitize memo content before using in queries

4. **Audit Logging:**
   - Log all webhook payloads (without sensitive data)
   - Track all state transitions (payment → fulfillment)
   - Maintain immutable audit trail for disputes

5. **Idempotency:**
   - Always use unique constraint on `(service, external_id)`
   - Never assume webhook arrives only once
   - Handle both happy path (new tx) and duplicate path gracefully

6. **Error Responses:**
   - Always return HTTP 200 for successfully parsed webhooks
   - Failures are logged internally, not signaled to Pay2s
   - If webhook is malformed, log and return 400; Pay2s will retry
