---
name: payment-integration
description: "Integrate payments across 7 providers: SePay (VietQR), Pay2s (VN banks), Polar (SaaS), Stripe (global infrastructure), Paddle (MoR subscriptions), Creem.io (MoR + licensing), PayPal (global wallets). Checkout, webhooks, subscriptions, QR codes, multi-provider orders."
license: MIT
argument-hint: "[provider] [task] OR [--choose | --multi-provider]"
metadata:
  author: claudex-kit
  version: "1.0.0"
---

# The Cashier

You stand between the user's product and their customer's wallet. Every dropped webhook is a lost sale. Every unverified signature is a security hole. Every untested edge case — expired card, duplicate payment, currency mismatch — is a support ticket at 2 AM. Your job is to wire money flow correctly the first time, because "we'll fix billing later" is how startups die.

## Tone Calibration
If a coding-level (0–3) was injected at session init, match it. Those rules override defaults below.

## Operating Laws
**YAGNI**, **KISS**, **DRY**. Plus one for payments: **idempotent by default** — every webhook handler, every status update, every fulfillment call must survive being called twice without double-charging or double-delivering.

## Supported Providers

| Provider | Type | Best for |
|----------|------|----------|
| **SePay** | Direct | Vietnamese market, VND, bank transfers, VietQR, NAPAS |
| **Pay2s** | Direct (webhook) | Vietnamese banks, VND bank transfers, simple webhook-driven flow |
| **Polar** | MoR | Global SaaS, subscriptions, usage billing, automated benefits (GitHub/Discord) |
| **Stripe** | Infrastructure | Enterprise payments, Connect platforms, custom checkout, global cards |
| **Paddle** | MoR | MoR subscriptions, global tax compliance, churn prevention (Retain) |
| **Creem.io** | MoR | MoR + licensing, revenue splits, no-code checkout, device activation |
| **PayPal** | Wallet | Global wallet payments, buyer protection, marketplace, Venmo |

> **MoR = Merchant of Record** — provider handles tax compliance, invoicing, and legal entity. You are the vendor, they are the seller-of-record. Simplifies global sales massively.

## Modes

| Flag | When to use | Behavior |
|------|-------------|----------|
| `--choose` | Greenfield, not sure which provider | Run selection matrix based on market, product type, team |
| `--multi-provider` | Need unified order management across providers | Load `multi-provider-order-management-patterns.md` |
| _(default)_ | Provider already chosen | Load that provider's references, implement |

## <HARD-GATE>
Before writing ANY payment code, confirm these three facts:

1. **Provider** — Which provider(s)? Or need help choosing (`--choose`)?
2. **Payment model** — One-time? Subscription? Usage-based? Licensing?
3. **Currency + market** — VND domestic? USD global? Multi-currency?

No code until all three are answered. Offer `--choose` if user is unsure.
</HARD-GATE>

## Self-Deception Traps

| Your brain says | Reality |
|-----------------|---------|
| "I'll add webhook verification later" | Unverified webhooks = anyone can fake a payment. Do it first |
| "Idempotency is overkill for this" | Webhooks retry. Networks glitch. Your handler WILL be called twice |
| "Test mode works, so production will too" | API keys, webhook URLs, currency formats — all differ between sandbox and live |
| "I'll handle refunds when we need them" | Day one. A customer will dispute within the first week |
| "The amount is always in dollars" | SePay/Pay2s = VND (no decimals). Stripe = cents. Paddle = localized. Polar = cents. PayPal = depends on currency. Always check |
| "One provider is enough" | Until you need VN domestic (SePay/Pay2s) AND global (Stripe/Polar). Plan the abstraction |

## Authoritative Flow

```mermaid
flowchart TD
    A[User request] --> B{Provider chosen?}
    B -->|no| C[Run --choose matrix]
    C --> D[Recommend provider + trade-offs]
    D --> E{User approves?}
    E -->|no| C
    E -->|yes| F[Confirm HARD-GATE: model + currency]
    B -->|yes| F
    F --> G{Task type?}
    G -->|setup| H[Auth + products + pricing]
    G -->|checkout| I[Checkout flow: hosted/embedded/custom]
    G -->|webhooks| J[Webhook handler + signature verification]
    G -->|subscriptions| K[Lifecycle: create/upgrade/cancel/pause]
    G -->|multi-provider| L[Load multi-provider patterns]
    H --> M[Test in sandbox]
    I --> M
    J --> M
    K --> M
    L --> M
    M --> N[Production checklist]
    N --> O[Ship]
```

**The diagram wins.** Prose below is commentary.

## Provider Selection Matrix

When `--choose` is active:

| Factor | SePay | Pay2s | Polar | Stripe | Paddle | Creem | PayPal |
|--------|-------|-------|-------|--------|--------|-------|--------|
| VN domestic | ★★★★★ | ★★★★★ | ☆ | ★★☆ | ☆ | ☆ | ★★☆ |
| Global cards | ☆ | ☆ | ★★★★ | ★★★★★ | ★★★★ | ★★★★ | ★★★★ |
| Subscriptions | ☆ | ☆ | ★★★★★ | ★★★★★ | ★★★★★ | ★★★★ | ★★★ |
| Tax compliance | ☆ | ☆ | ★★★★★ | ★★★ | ★★★★★ | ★★★★★ | ★★ |
| Licensing | ☆ | ☆ | ☆ | ☆ | ☆ | ★★★★★ | ☆ |
| Wallet/buyer protect | ☆ | ☆ | ☆ | ★★ | ★★ | ☆ | ★★★★★ |
| Setup complexity | Low | Low | Low | Medium | Medium | Low | Medium |
| Fees | ~0% | ~0% | 5%+4% | 2.9%+30¢ | 5%+50¢ | ~5% | 2.9%+30¢ |

## Reference Files

### Vietnamese Providers

**SePay** — VietQR, bank transfers, 44+ VN banks:
| File | Contents |
|------|----------|
| `references/sepay/overview.md` | Auth, supported banks, rate limits |
| `references/sepay/api.md` | Endpoints, transactions, responses |
| `references/sepay/webhooks.md` | Setup, payload format, verification |
| `references/sepay/sdk.md` | Node.js, PHP, Laravel integration |
| `references/sepay/qr-codes.md` | VietQR generation, NAPAS format |
| `references/sepay/best-practices.md` | Production patterns, error handling |

**Pay2s** — VN bank webhook integration:
| File | Contents |
|------|----------|
| `references/pay2s/overview.md` | How Pay2s works, auth, webhook-driven flow |
| `references/pay2s/webhooks.md` | Payload format, transaction DTO, processing patterns |

### Global Providers

**Polar** — SaaS monetization + MoR:
| File | Contents |
|------|----------|
| `references/polar/overview.md` | Auth, MoR concept, fees |
| `references/polar/products.md` | Pricing models, usage-based |
| `references/polar/checkouts.md` | Checkout flows |
| `references/polar/subscriptions.md` | Lifecycle management |
| `references/polar/webhooks.md` | Event handling, verification |
| `references/polar/benefits.md` | Automated delivery (GitHub, Discord) |
| `references/polar/sdk.md` | Multi-language SDKs |
| `references/polar/best-practices.md` | Production patterns |

**Stripe** — Global payment infrastructure:
| File | Contents |
|------|----------|
| `references/stripe/stripe-best-practices.md` | Integration design patterns |
| `references/stripe/stripe-sdks.md` | Server SDKs setup |
| `references/stripe/stripe-js.md` | Payment Element, Checkout |
| `references/stripe/stripe-cli.md` | Local testing, webhook forwarding |
| `references/stripe/stripe-upgrade.md` | API version upgrades |

**Paddle** — MoR subscriptions + tax:
| File | Contents |
|------|----------|
| `references/paddle/overview.md` | MoR, auth, entity IDs |
| `references/paddle/api.md` | Products, prices, transactions |
| `references/paddle/paddle-js.md` | Checkout overlay/inline |
| `references/paddle/subscriptions.md` | Trials, upgrades, pause, cancel |
| `references/paddle/webhooks.md` | SHA256 verification |
| `references/paddle/sdk.md` | Node, Python, PHP, Go |
| `references/paddle/best-practices.md` | Production patterns |

**Creem.io** — MoR + licensing:
| File | Contents |
|------|----------|
| `references/creem/overview.md` | MoR, auth, global support |
| `references/creem/api.md` | Products, checkout sessions |
| `references/creem/checkouts.md` | No-code links, storefronts |
| `references/creem/subscriptions.md` | Trials, seat-based billing |
| `references/creem/licensing.md` | Device activation, key validation |
| `references/creem/webhooks.md` | Signature verification |
| `references/creem/sdk.md` | Next.js, Better Auth adapters |

**PayPal** — Global wallet + marketplace:
| File | Contents |
|------|----------|
| `references/paypal/overview.md` | Auth (OAuth 2.0), sandbox, environments |
| `references/paypal/orders-api.md` | Create/capture/authorize orders |
| `references/paypal/subscriptions.md` | Billing plans, subscription lifecycle |
| `references/paypal/webhooks.md` | Event types, signature verification |
| `references/paypal/sdk.md` | Server SDKs + JS SDK (Smart Buttons) |
| `references/paypal/best-practices.md` | Production patterns, disputes, PayPal Commerce Platform |

### Shared References
| File | Contents |
|------|----------|
| `references/implementation-workflows.md` | Step-by-step per-provider integration guide |
| `references/multi-provider-order-management-patterns.md` | Unified orders, currency conversion, commission |

## External Docs (llms.txt)
- Stripe: `https://docs.stripe.com/llms.txt`
- Paddle: `https://developer.paddle.com/llms.txt`
- Creem: `https://docs.creem.io/llms.txt`
- PayPal: `https://developer.paypal.com/llms.txt`

Load via `docs-seeker` skill when references here are insufficient.

## Implementation General Flow

```
auth → products/prices → checkout → webhooks → fulfillment → monitoring
```

See `references/implementation-workflows.md` for provider-specific steps.

## Agent Delegation

| Agent | When to spawn | What it does |
|-------|--------------|--------------|
| `developer` | Implement checkout/webhook/subscription | Writes integration code |
| `tester` | After implementation | Tests sandbox flow end-to-end |
| `code-reviewer` | After tests pass | Security review: signature verification, idempotency, secret handling |
| `debugger` | Webhook not arriving / payment mismatch | Diagnose webhook delivery, payload parsing |

## Boundaries — What This Skill Does NOT Do

- **Accounting / bookkeeping** → out of scope
- **Tax law advice** → use MoR providers (Polar/Paddle/Creem) to handle this automatically
- **Frontend UI design** → use `frontend-design` or `ui-ux-pro-max`
- **Infrastructure / deployment** → use `devops`
- **Mobile in-app purchases** → use `mobile-development` (Apple/Google IAP is a different paradigm)

## Key Principles

1. **Webhook-first architecture** — Don't rely on client-side redirects for payment confirmation. The webhook is the source of truth.
2. **Idempotency keys everywhere** — Store `external_id` + `service` as unique constraint. Check before processing.
3. **Amount precision** — VND has no decimals. USD in Stripe/PayPal = cents (integer). Paddle localizes. Always normalize.
4. **Secret rotation** — API keys and webhook secrets expire. Design for rotation without downtime.
5. **Sandbox before live** — Every provider has a test mode. Use it. Test edge cases (expired cards, insufficient funds, network timeout).
