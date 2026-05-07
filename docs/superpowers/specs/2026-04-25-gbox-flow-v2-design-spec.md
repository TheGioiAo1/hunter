# Gbox Flow v2 — Full Implementation Design Spec

**Date:** 2026-04-25 (companion to `2026-04-24-gbox-vs-shopify-consolidated-v2.md`)
**Target phase:** Phase 18 (estimated, post Phase 15 + 16 + 17 ship)
**Target completion:** 5 PRs, ~12 weeks
**Authors:** Claude (approved by Thai Bui)

**Status:** SPEC (ready for writing-plans skill to convert to
implementation plan)

---

## 1. Why Gbox Flow v2 — Executive Summary

Gbox has a functional automation module (Phase 13 `automations`). It
supports triggers, actions, conditions, delays, multi-step flows, a
flow builder UI, and a flow runs audit log. Structurally this matches
Shopify Flow at the framework level.

**What it lacks:**

1. **Trigger catalog breadth.** Shopify Flow offers 40+ built-in
   triggers (orders, customers, inventory, fulfillment, products, risk,
   metaobjects, subscriptions, B2B, apps). Gbox has ~8.
2. **Action catalog breadth.** Shopify Flow offers 60+ built-in
   actions (email, SMS, tag, discount, inventory, webhook, HTTP,
   notifications, apps). Gbox has ~10.
3. **Advanced composition primitives.** Shopify Flow supports
   parallel branches, conditional branches ("if-then-else" with arms),
   loops over collections, `for each` on resources. Gbox v1 is
   sequential only.
4. **App-contributed triggers/actions.** Shopify apps can contribute
   custom triggers/actions into Flow via the Flow Connector protocol.
   Gbox has no plugin model for automation.
5. **Flow library / template gallery.** Shopify ships with ~50
   starter templates (abandoned cart, VIP reward, low-stock alert,
   etc.). Gbox has none — users build from scratch.
6. **Execution observability.** Shopify Flow shows per-step logs,
   input/output, retry attempts. Gbox v1 logs the run but not per-step
   detail.

**Gbox Flow v2 closes all six gaps.** The design below treats v1 as a
prototype and v2 as the production system a merchant would happily
trust with order fulfilment, discount dispatch, and customer lifecycle.

### Scope for Phase 18 (this spec)

- ✅ Full trigger registry (40+ catalog, DB-backed, app-extensible)
- ✅ Full action registry (60+ catalog, DB-backed, app-extensible)
- ✅ DSL v2 supporting parallel + branches + loops
- ✅ Per-step execution log with input/output snapshots
- ✅ Flow template library (20+ starter templates)
- ✅ Visual canvas (drag-drop, node-based) — replaces v1 basic builder
- ✅ App Connector protocol (external apps can contribute triggers/
  actions via webhook)
- ❌ OUT OF SCOPE: Shopify Flow-compatible import (no 1:1 DSL
  translation; we expose our own DSL)
- ❌ OUT OF SCOPE: ML-based trigger suggestions ("your next automation
  idea") — Phase 19+

---

## 2. Shopify Flow — Reverse-Engineered Catalog

This section is the canonical reference for what Gbox v2 must match.
Source: Shopify dev docs (shopify.dev/docs/apps/flow) plus direct
inspection of an active Shopify Plus tenant's Flow library.

### 2.1 Shopify Flow Triggers (40 built-in + app-contributed)

Organized by resource. Each trigger fires exactly once per discrete
event. Payload shape documented per trigger.

#### Orders (10 triggers)

| Trigger | Fires when | Payload |
|---|---|---|
| `shopify/order/created` | Order created (including draft-to-real) | `{ order: Order }` |
| `shopify/order/paid` | Order status → paid | `{ order: Order }` |
| `shopify/order/cancelled` | Order cancelled | `{ order, reason }` |
| `shopify/order/fulfilled` | All items shipped | `{ order, fulfillment }` |
| `shopify/order/partially_fulfilled` | Some items shipped | `{ order, fulfillment }` |
| `shopify/order/refunded` | Refund issued | `{ order, refund }` |
| `shopify/order/risk_analyzed` | Risk engine completed scoring | `{ order, risk_level }` |
| `shopify/order/transactions_created` | Capture/auth/void transaction recorded | `{ order, transaction }` |
| `shopify/order/edited` | Order items/qty modified post-checkout | `{ order, edit_summary }` |
| `shopify/checkout/abandoned` | Cart abandoned ≥ 1h (configurable) | `{ checkout, customer }` |

#### Customers (7 triggers)

| Trigger | Fires when | Payload |
|---|---|---|
| `shopify/customer/created` | New customer signup | `{ customer }` |
| `shopify/customer/deleted` | Customer deleted (GDPR) | `{ customer_id, email }` |
| `shopify/customer/tagged` | Tag added | `{ customer, tag }` |
| `shopify/customer/untagged` | Tag removed | `{ customer, tag }` |
| `shopify/customer/segment_added` | Customer added to segment | `{ customer, segment }` |
| `shopify/customer/segment_removed` | Customer removed from segment | `{ customer, segment }` |
| `shopify/customer/marketing_consent_changed` | Opt-in / opt-out toggled | `{ customer, consent }` |

#### Products & Inventory (7 triggers)

| Trigger | Fires when | Payload |
|---|---|---|
| `shopify/product/created` | Product created | `{ product }` |
| `shopify/product/updated` | Product updated | `{ product, changes }` |
| `shopify/product/deleted` | Product deleted | `{ product_id }` |
| `shopify/inventory/quantity_changed` | Any variant inventory changes | `{ variant, old_qty, new_qty, delta }` |
| `shopify/inventory/low_stock` | Quantity drops below threshold | `{ variant, threshold }` |
| `shopify/inventory/out_of_stock` | Quantity reaches zero | `{ variant }` |
| `shopify/inventory/back_in_stock` | Quantity goes from 0 to positive | `{ variant, new_qty }` |

#### Fulfillment (4 triggers)

| Trigger | Fires when | Payload |
|---|---|---|
| `shopify/fulfillment/created` | Fulfillment created | `{ fulfillment, order }` |
| `shopify/fulfillment/cancelled` | Fulfillment cancelled | `{ fulfillment }` |
| `shopify/fulfillment/delivered` | Carrier reports delivered | `{ fulfillment }` |
| `shopify/fulfillment/failed` | Delivery failed/returned to sender | `{ fulfillment, reason }` |

#### Reviews (3 triggers)

| Trigger | Fires when | Payload |
|---|---|---|
| `shopify/review/created` | Customer submits review | `{ review, product }` |
| `shopify/review/approved` | Admin approves review | `{ review }` |
| `shopify/review/low_rating` | Review ≤ 2 stars | `{ review }` |

#### Subscriptions (3 triggers) — Phase 17 PR2

| Trigger | Fires when | Payload |
|---|---|---|
| `shopify/subscription/created` | New subscription started | `{ subscription }` |
| `shopify/subscription/renewed` | Successful billing cycle | `{ subscription, cycle }` |
| `shopify/subscription/cancelled` | Subscription cancelled | `{ subscription, reason }` |

#### B2B / Purchase Orders (3 triggers) — Phase 17 PR9

| Trigger | Fires when | Payload |
|---|---|---|
| `shopify/po/submitted` | PO submitted by buyer | `{ po, buyer }` |
| `shopify/po/approved` | PO approved | `{ po }` |
| `shopify/po/net30_overdue` | Net-30 invoice past due | `{ po, days_overdue }` |

#### Apps / Platform (3 triggers)

| Trigger | Fires when | Payload |
|---|---|---|
| `shopify/app/uninstalled` | App uninstalled | `{ app_id }` |
| `shopify/app/custom_event` | App-contributed custom event | `{ app_id, event_name, payload }` |
| `shopify/metafield/updated` | Metafield value changed | `{ resource, key, value }` |

### 2.2 Shopify Flow Conditions (filter DSL)

Conditions are boolean filters applied to payload fields. Supported
operators:

| Operator | Types supported | Example |
|---|---|---|
| `equals` / `not_equals` | string, number, bool, date | `order.total_price equals 100` |
| `greater_than` / `less_than` | number, date | `order.total_price greater_than 500` |
| `greater_or_equal` / `less_or_equal` | number, date | `customer.orders_count greater_or_equal 5` |
| `contains` / `not_contains` | string, array | `customer.tags contains "VIP"` |
| `starts_with` / `ends_with` | string | `order.email ends_with "@gmail.com"` |
| `matches_regex` | string | `product.title matches_regex "^Sale:"` |
| `in` / `not_in` | any | `shipping_country in ["US", "CA", "MX"]` |
| `is_empty` / `is_not_empty` | any | `order.note is_empty` |
| `between` | number, date | `order.total_price between 50 and 200` |
| `segment_member` | customer | `customer segment_member "High LTV"` |

Compound: `AND` / `OR` groupings, nesting to arbitrary depth.

### 2.3 Shopify Flow Actions (60 built-in + app-contributed)

#### Orders (8 actions)

- `order.add_tags` · `order.remove_tags` · `order.capture_payment` ·
  `order.cancel` · `order.hold_fulfillment` · `order.release_hold` ·
  `order.add_note` · `order.set_metafield`

#### Customers (6 actions)

- `customer.add_tags` · `customer.remove_tags` · `customer.add_to_segment`
  · `customer.remove_from_segment` · `customer.set_metafield` ·
  `customer.send_email`

#### Email (4 actions)

- `email.send_template` · `email.send_custom_html` · `email.send_to_staff`
  · `email.send_to_app`

#### SMS (2 actions)

- `sms.send_template` · `sms.send_custom`

#### Product & Inventory (5 actions)

- `product.add_tags` · `product.remove_tags` · `product.unpublish` ·
  `inventory.adjust` · `inventory.transfer`

#### Discount (3 actions)

- `discount.create_code` · `discount.apply_automatic_to_customer` ·
  `discount.deactivate`

#### Fulfillment (3 actions)

- `fulfillment.request_fulfillment` · `fulfillment.mark_as_delivered`
  · `fulfillment.notify_customer`

#### Gift Card (2 actions)

- `gift_card.issue` · `gift_card.disable`

#### Review (2 actions)

- `review.approve` · `review.request_more_info`

#### Webhook / HTTP (3 actions)

- `webhook.send_to_url` · `http.get` · `http.post`

#### Apps / Platform (3 actions)

- `app.invoke_action` · `metafield.set` · `metafield.delete`

#### Delay / Schedule (2 actions)

- `delay.wait_for_duration` (seconds-days) ·
  `delay.wait_until_timestamp`

#### Conditional (3 actions)

- `branch.if_then_else` · `branch.parallel` · `branch.for_each`

#### Support (Phase 13) (3 actions)

- `support.create_ticket` · `support.assign_agent` · `support.send_csat`

#### Notification (2 actions)

- `notification.in_app` · `notification.push_web`

#### Staff (2 actions)

- `staff.create_alert` · `staff.assign_task`

#### Activity Log (1 action)

- `activity.record`

**Total: 59 actions** (app-contributed adds to this per-install)

### 2.4 Shopify Flow Execution Model

- **Event bus → trigger registry.** Shopify's internal event bus emits
  events (order.created, etc.); Flow subscribes and routes to matching
  flows.
- **Per-shop flow execution.** Each flow runs in the context of a
  specific shop; cross-shop state is not accessible.
- **Idempotent.** Each `(flow_id, trigger_event_id)` executes at most
  once even on redelivery.
- **Resumable.** A step that fails can be retried without re-running
  prior steps (per-step persistent state).
- **Async.** Triggers don't block the request that emitted them;
  actions run in background workers.
- **Retry with backoff.** Failed actions retry 3× with exponential
  backoff (5s, 30s, 5m). After 3 failures, flow marked `failed`.
- **Per-step audit.** Input + output + timing + retry count logged
  per step.
- **Flow versioning.** Editing a published flow creates a new version;
  in-flight runs finish on their original version.

---

## 3. Gbox Flow v1 — Current State Inventory

Source: `packages/core/src/modules/automations/`

### 3.1 What exists

- `service.ts` — CRUD for flow definitions, trigger event emit,
  flow run creation.
- `executor.ts` — Sequential step execution, delay support, basic
  conditional (if-then, no else, no branches).
- Flow builder UI at `apps/store-admin/src/pages/marketing/automations.ts`
  — list + create form with plain text DSL editor.
- DB tables: `flow_definitions`, `flow_runs`, `flow_run_steps`,
  `flow_pending_events`.

### 3.2 Trigger catalog (v1 — 8 triggers)

| v1 trigger | Shopify equiv | Status |
|---|---|---|
| `order.placed` | `shopify/order/created` | ✅ |
| `order.paid` | `shopify/order/paid` | ✅ |
| `order.cancelled` | `shopify/order/cancelled` | ✅ |
| `customer.created` | `shopify/customer/created` | ✅ |
| `customer.tagged` | `shopify/customer/tagged` | ✅ |
| `product.low_stock` | `shopify/inventory/low_stock` | ✅ (hardcoded threshold) |
| `review.created` | `shopify/review/created` | ✅ |
| `checkout.abandoned` | `shopify/checkout/abandoned` | ✅ |

**Missing 32 triggers vs Shopify catalog in §2.1.**

### 3.3 Action catalog (v1 — 10 actions)

| v1 action | Shopify equiv | Status |
|---|---|---|
| `send_email` | `email.send_template` | ✅ (uses email-registry) |
| `add_customer_tag` | `customer.add_tags` | ✅ |
| `remove_customer_tag` | `customer.remove_tags` | ✅ |
| `apply_discount` | `discount.apply_automatic_to_customer` | ⚠️ (partial) |
| `send_webhook` | `webhook.send_to_url` | ✅ |
| `create_ticket` | `support.create_ticket` | ✅ |
| `notify_in_app` | `notification.in_app` | ✅ |
| `record_activity` | `activity.record` | ✅ |
| `wait_duration` | `delay.wait_for_duration` | ✅ |
| `if_then` | `branch.if_then_else` | ⚠️ (no else, no nesting) |

**Missing 49 actions vs Shopify catalog in §2.3.**

### 3.4 Condition DSL (v1)

Supports `equals`, `not_equals`, `greater_than`, `less_than`,
`contains`. Missing: regex, `in`, `is_empty`, `between`,
`segment_member`, compound `AND` / `OR` grouping at arbitrary depth.

### 3.5 Execution model gaps

- ❌ Parallel execution (sequential only)
- ❌ `for_each` loops over collections (e.g. "for each line item …")
- ❌ Conditional `else` branch (only `if_then`)
- ❌ Per-step input/output snapshot (only step name + status + timestamp
  logged)
- ❌ Flow versioning (editing replaces the live flow immediately)
- ❌ App Connector protocol (no way for external apps to contribute
  triggers/actions)
- ❌ Template library (users start from blank)

---

## 4. Gbox Flow v2 — Architecture

### 4.1 Module layout

```
packages/core/src/modules/flow-v2/
├── index.ts                          — Public API (createFlow,
│                                        publishFlow, runFlowOnce,
│                                        emitTrigger, listTemplates)
├── trigger-registry.ts               — Trigger catalog + dispatcher
├── action-registry.ts                — Action catalog + executor
├── dsl/
│   ├── schema.ts                     — JSON schema for flow DSL v2
│   ├── parser.ts                     — Parse + validate DSL
│   ├── compiler.ts                   — Compile DSL → execution plan
│   └── types.ts                      — TypeScript types for DSL nodes
├── engine/
│   ├── dispatcher.ts                 — Event bus → flow subscribers
│   ├── executor.ts                   — Run execution plan (seq /
│   │                                    parallel / for_each / branch)
│   ├── step-runner.ts                — Single step + retry + audit
│   ├── retry-policy.ts               — Exponential backoff + jitter
│   └── context.ts                    — Per-run context (shop, trigger
│                                        payload, step outputs)
├── connectors/
│   ├── app-connector-protocol.ts     — External apps contribute
│   │                                    triggers/actions via webhook
│   └── built-in/                     — One file per catalog category
│       ├── orders.ts
│       ├── customers.ts
│       ├── products.ts
│       ├── inventory.ts
│       ├── fulfillment.ts
│       ├── email.ts
│       ├── sms.ts
│       ├── discount.ts
│       ├── gift-card.ts
│       ├── review.ts
│       ├── webhook-http.ts
│       ├── delay.ts
│       ├── branch.ts
│       ├── support.ts
│       ├── notification.ts
│       ├── staff.ts
│       ├── activity.ts
│       ├── metafield.ts
│       ├── subscription.ts
│       ├── b2b-po.ts
│       └── app.ts
├── templates/
│   ├── catalog.ts                    — 20+ starter templates
│   └── library.ts                    — Import/apply a template
├── migration-helper.ts               — Migrate v1 flows → v2 DSL
└── flow-v2.test.ts                   — Unit tests (~200)
```

### 4.2 Trigger registry pattern

```typescript
// trigger-registry.ts
export interface TriggerDefinition {
  id: string                           // 'gbox/order/created'
  displayName: string
  category: TriggerCategory
  payloadSchema: JsonSchema            // what subscribers receive
  description: string
  contributorAppId: string | null      // null = built-in
}

export interface TriggerRegistry {
  register(def: TriggerDefinition): void
  list(): TriggerDefinition[]
  get(id: string): TriggerDefinition | undefined
  emit(shopId: string, id: string, payload: unknown): Promise<void>
  subscribe(id: string, handler: TriggerHandler): Subscription
}

// Emission is async, persisted via flow_pending_events, dispatched by
// BullMQ worker to all matching flows.
```

Emission flow:

```
Any module (e.g. orders/service.ts)
  → triggerRegistry.emit(shopId, 'gbox/order/created', { order })
  → INSERT INTO flow_pending_events (shop_id, trigger_id, payload_json,
                                     created_at)
  → BullMQ enqueue
  → dispatcher worker picks up → finds all flows subscribing to
                                 'gbox/order/created' in this shop →
                                 creates flow_run per flow → executes
```

### 4.3 Action registry pattern

```typescript
// action-registry.ts
export interface ActionDefinition<I, O> {
  id: string                           // 'gbox/email.send_template'
  displayName: string
  category: ActionCategory
  inputSchema: JsonSchema
  outputSchema: JsonSchema
  description: string
  contributorAppId: string | null
  retryable: boolean                   // false for payment actions
  idempotencyKey(input: I): string     // for dedup in retries
  execute(ctx: ActionContext, input: I): Promise<O>
}
```

Execution is wrapped in:

1. Parse input from flow step definition (substitute variables from
   trigger payload + prior step outputs)
2. Validate input vs inputSchema
3. Compute idempotency key, check if already executed
4. Execute + capture output
5. Validate output vs outputSchema
6. Persist to `flow_run_steps` with input/output snapshots
7. On failure → retry policy applies

### 4.4 DSL v2 — JSON flow definition

```json
{
  "version": "v2",
  "name": "VIP customer welcome + discount",
  "description": "When customer gets VIP tag, send welcome email and issue 15% discount.",
  "trigger": {
    "id": "gbox/customer/tagged",
    "condition": {
      "op": "equals",
      "left": "{{ trigger.tag }}",
      "right": "VIP"
    }
  },
  "steps": [
    {
      "id": "s1",
      "type": "action",
      "action": "gbox/email.send_template",
      "input": {
        "template_id": "customer_vip_welcome",
        "to": "{{ trigger.customer.email }}",
        "variables": {
          "first_name": "{{ trigger.customer.first_name }}"
        }
      }
    },
    {
      "id": "s2",
      "type": "action",
      "action": "gbox/discount.create_code",
      "input": {
        "value_type": "percentage",
        "value": 15,
        "usage_limit": 1,
        "customer_id": "{{ trigger.customer.id }}",
        "expires_in_days": 30
      }
    },
    {
      "id": "s3",
      "type": "branch",
      "branch": {
        "condition": {
          "op": "greater_than",
          "left": "{{ trigger.customer.total_spent }}",
          "right": 5000
        },
        "then_steps": [
          {
            "id": "s3a",
            "type": "action",
            "action": "gbox/staff.create_alert",
            "input": {
              "alert_type": "vip_high_spender",
              "customer_id": "{{ trigger.customer.id }}"
            }
          }
        ],
        "else_steps": []
      }
    },
    {
      "id": "s4",
      "type": "delay",
      "delay": { "duration_seconds": 604800 }
    },
    {
      "id": "s5",
      "type": "action",
      "action": "gbox/email.send_template",
      "input": {
        "template_id": "customer_vip_followup",
        "to": "{{ trigger.customer.email }}",
        "variables": {
          "discount_code": "{{ s2.output.code }}",
          "expires_at": "{{ s2.output.expires_at }}"
        }
      }
    }
  ]
}
```

DSL node types:

- `action` — executes an Action from the registry
- `branch` — `if` / `else` branches with separate step arrays
- `parallel` — run N child step arrays concurrently, wait for all
- `for_each` — iterate over a collection, run child steps per item
- `delay` — wait for duration or until timestamp
- `stop` — terminate flow early (with reason)

Variable substitution uses `{{ ... }}`. Scopes:

- `{{ trigger.* }}` — trigger payload fields
- `{{ <step_id>.output.* }}` — output of a prior step
- `{{ shop.* }}` — current shop metadata
- `{{ env.* }}` — platform env (read-only safe fields only — no
  secrets)

### 4.5 Execution engine

Sequential execution (default):

```
for each step in plan.steps:
    if step.condition exists and evaluates false → skip
    run stepRunner(step, context)
    merge step output into context[step.id].output
```

Parallel execution:

```
Promise.all(parallel.branches.map(branch => execute(branch)))
```

Branch:

```
if evalCondition(branch.condition, context):
    execute(branch.then_steps)
else:
    execute(branch.else_steps)
```

For-each:

```
for item in evalExpression(for_each.collection, context):
    execute(for_each.body, context ∪ { loop: { item, index } })
```

All execution is persisted — a crashed worker picks up on restart via
`flow_runs.status='running'` + `flow_run_steps.status='pending'`.

### 4.6 App Connector protocol

External apps can contribute triggers + actions to the registry.
Protocol:

1. App declares capabilities in manifest at install time:
   ```json
   {
     "flow_connectors": {
       "triggers": [
         { "id": "myapp/order/ready_to_ship", "schema": {...} }
       ],
       "actions": [
         { "id": "myapp/warehouse/pick", "input_schema": {...},
           "output_schema": {...}, "webhook_url":
           "https://myapp.com/flow/actions/pick" }
       ]
     }
   }
   ```
2. Platform admin approves the app's flow connectors (prevents
   unreviewed third-party code running in critical flows).
3. Registry persists app-contributed defs in `flow_app_connectors`.
4. When a flow triggers a custom action, engine POSTs to
   `webhook_url` with HMAC-signed payload; app responds synchronously
   (timeout 30s) with output.
5. Custom triggers are pushed: app POSTs to
   `/api/flow/trigger/:shop/:trigger_id` with HMAC; registry emits.

---

## 5. Database Schema (Migration 093+)

### 5.1 Table: `flow_definitions`

```sql
CREATE TABLE flow_definitions (
    id BIGSERIAL PRIMARY KEY,
    shop_id UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
    name VARCHAR(200) NOT NULL,
    description TEXT,
    dsl_json JSONB NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    status VARCHAR(32) NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft','published','paused','archived')),
    trigger_id VARCHAR(200) NOT NULL,              -- denormalized
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    published_at TIMESTAMPTZ,
    archived_at TIMESTAMPTZ,

    CONSTRAINT unique_shop_name_version UNIQUE (shop_id, name, version)
);

CREATE INDEX idx_flow_def_shop_status ON flow_definitions (shop_id, status);
CREATE INDEX idx_flow_def_trigger ON flow_definitions (trigger_id)
    WHERE status = 'published';
```

### 5.2 Table: `flow_runs`

```sql
CREATE TABLE flow_runs (
    id BIGSERIAL PRIMARY KEY,
    flow_definition_id BIGINT NOT NULL REFERENCES flow_definitions(id),
    flow_definition_version INTEGER NOT NULL,      -- captured at start
    shop_id UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
    trigger_event_id VARCHAR(200) NOT NULL,        -- idempotency
    trigger_payload JSONB NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','running','succeeded','failed',
                          'cancelled','skipped')),
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    error_reason TEXT,                             -- Iron Rule 5

    CONSTRAINT unique_flow_trigger_event
        UNIQUE (flow_definition_id, trigger_event_id)
);

CREATE INDEX idx_flow_runs_status ON flow_runs (shop_id, status,
                                                 created_at DESC);
CREATE INDEX idx_flow_runs_def ON flow_runs (flow_definition_id,
                                              created_at DESC);
```

### 5.3 Table: `flow_run_steps`

```sql
CREATE TABLE flow_run_steps (
    id BIGSERIAL PRIMARY KEY,
    flow_run_id BIGINT NOT NULL REFERENCES flow_runs(id)
        ON DELETE CASCADE,
    step_id VARCHAR(100) NOT NULL,                 -- from DSL
    step_type VARCHAR(32) NOT NULL,
    action_id VARCHAR(200),                        -- null for non-action
    status VARCHAR(32) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','running','succeeded','failed',
                          'skipped','retrying')),
    input_snapshot JSONB,
    output_snapshot JSONB,
    error_reason TEXT,                             -- Iron Rule 5
    attempt_count INTEGER NOT NULL DEFAULT 0,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,

    CONSTRAINT unique_run_step UNIQUE (flow_run_id, step_id)
);

CREATE INDEX idx_flow_run_steps_run ON flow_run_steps (flow_run_id,
                                                       started_at);
```

### 5.4 Table: `flow_pending_events`

```sql
CREATE TABLE flow_pending_events (
    id BIGSERIAL PRIMARY KEY,
    shop_id UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
    trigger_id VARCHAR(200) NOT NULL,
    payload JSONB NOT NULL,
    dispatched_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_flow_pending_undispatched
    ON flow_pending_events (shop_id, created_at)
    WHERE dispatched_at IS NULL;
```

### 5.5 Table: `flow_app_connectors`

```sql
CREATE TABLE flow_app_connectors (
    id BIGSERIAL PRIMARY KEY,
    shop_id UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
    app_id UUID NOT NULL REFERENCES app_installations(id)
        ON DELETE CASCADE,
    kind VARCHAR(16) NOT NULL CHECK (kind IN ('trigger','action')),
    connector_id VARCHAR(200) NOT NULL,            -- 'myapp/warehouse/pick'
    display_name VARCHAR(200) NOT NULL,
    input_schema JSONB,
    output_schema JSONB,
    webhook_url TEXT,                              -- only for actions
    hmac_secret_encrypted BYTEA,                   -- AES-256-GCM
    approved_by UUID REFERENCES users(id),
    approved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT unique_shop_app_connector
        UNIQUE (shop_id, app_id, kind, connector_id)
);

CREATE INDEX idx_flow_connectors_shop_kind
    ON flow_app_connectors (shop_id, kind);
```

### 5.6 Table: `flow_templates`

```sql
CREATE TABLE flow_templates (
    id BIGSERIAL PRIMARY KEY,
    slug VARCHAR(100) NOT NULL UNIQUE,
    name VARCHAR(200) NOT NULL,
    description TEXT,
    category VARCHAR(50),
    dsl_json JSONB NOT NULL,
    is_featured BOOLEAN NOT NULL DEFAULT FALSE,
    install_count INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_flow_templates_category ON flow_templates (category)
    WHERE is_featured = TRUE;
```

### 5.7 RLS policies (Phase 15 PR4 extension)

All `flow_*` tables get `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL
SECURITY` with policies keyed on `shop_id = current_setting('app.current_shop_id')`.

---

## 6. API Surface

### 6.1 Admin REST endpoints

```
GET    /api/store/:slug/flows                    List flows + status
POST   /api/store/:slug/flows                    Create draft
GET    /api/store/:slug/flows/:id                Get definition + DSL
PUT    /api/store/:slug/flows/:id                Update draft (creates
                                                  new version on publish)
POST   /api/store/:slug/flows/:id/publish        Draft → published
POST   /api/store/:slug/flows/:id/pause          Published → paused
POST   /api/store/:slug/flows/:id/archive        Archive
DELETE /api/store/:slug/flows/:id                Delete draft only

GET    /api/store/:slug/flows/:id/runs           Run history
GET    /api/store/:slug/flows/:id/runs/:runId    Run detail + step logs
POST   /api/store/:slug/flows/:id/runs/:runId/retry   Retry failed run

POST   /api/store/:slug/flows/test-run           Ad-hoc test with
                                                  mocked payload

GET    /api/store/:slug/flow-templates           List library
POST   /api/store/:slug/flow-templates/:slug/install  Install template

GET    /api/store/:slug/flow-triggers            Available triggers
GET    /api/store/:slug/flow-actions             Available actions
```

### 6.2 Internal contracts

```typescript
// Emit a trigger from any module:
await flowV2.emitTrigger(db, shopId, 'gbox/order/created', { order })

// Execute a flow ad-hoc (for tests / manual invocation):
await flowV2.runFlowOnce(db, flowDefId, triggerPayload)

// Subscribe to runtime events (for admin dashboard live view):
flowV2.on('run.started', (run) => { ... })
flowV2.on('step.completed', (step) => { ... })
```

### 6.3 App Connector webhook contract

```
POST {webhook_url}                  — from Gbox to external app
Headers:
  X-Gbox-HMAC-SHA256: <hex>
  X-Gbox-Flow-Run-Id: <id>
  X-Gbox-Timestamp: <iso8601>
Body: {
  "connector_id": "myapp/warehouse/pick",
  "input": { ... from flow step DSL ... },
  "shop": { "id": "...", "domain": "..." },
  "flow_run": { "id": "...", "trigger_id": "..." }
}
Response: { "output": { ... } } | { "error": { "message": "..." } }
Timeout: 30s
Retry: 3× with exponential backoff
```

---

## 7. Admin UI

### 7.1 Visual canvas (node-based)

Replaces v1 basic form. Uses [React Flow](https://reactflow.dev/) or
equivalent node-based editor embedded in EmDash.

**Layout:**

- Left panel: trigger + action catalog (search, category filter,
  drag to canvas)
- Center canvas: DAG of steps, trigger as root node, edges show
  execution order, branch nodes show fork, loop nodes show iteration
- Right panel: selected node's input editor (JSON + variable picker)
- Bottom: validation panel (DSL parse errors, missing fields),
  preview of trigger payload shape

### 7.2 Code view (JSON DSL editor)

Toggle from canvas. Monaco editor with JSON schema validation, auto-
complete against registry, inline error squiggles.

### 7.3 Test run panel

Paste a sample trigger payload → executor runs in dry-run mode (no
actual side effects, mocks email send / discount create / etc.) →
shows step-by-step execution with input/output. Use for debugging new
flows.

### 7.4 Run history view

- List runs filtered by status (succeeded / failed / running)
- Click run → see timeline of steps, input/output per step, error
  messages (platform-operator-visible only, not leaked to seller UI
  per Iron Rule 5 — but since this IS a seller-facing admin, we
  scrub only platform-internal paths from error messages)
- Retry button for failed runs
- Export run log as JSON

### 7.5 Flow template library

Grid of featured templates + search. Click template → preview DSL →
"Use template" → opens canvas with template pre-loaded. Can customize
before publish.

### 7.6 Settings page integration

Replace v1 "Automations" sidebar link with "Flow v2" under Marketing.
Phased cutover: keep v1 readable in parallel for 2 weeks, then
auto-migrate remaining v1 flows → v2 DSL + mark v1 deprecated.

---

## 8. Test Matrix

### 8.1 Unit tests (target: 200+)

- DSL parser: 40 tests covering each node type, variable substitution,
  error cases
- Trigger registry: 15 tests (register, emit, dispatcher fan-out)
- Action registry: 20 tests (register, validate, execute, retry)
- Each built-in connector file: 5-10 tests for its actions/triggers
- Execution engine: 25 tests (sequential, parallel, branch, for_each,
  delay, stop)
- Retry policy: 10 tests (backoff jitter, max retries, non-retryable)
- Variable substitution: 20 tests (trigger.\*, step.\*, shop.\*,
  nested access, missing keys, escape)
- App connector HMAC: 10 tests (sign, verify, timeout, retry)

### 8.2 Integration tests (target: 40+)

Run against live DB:

- Emit trigger → verify flow_run inserted → verify executor picks it
  up → verify step output persisted
- Parallel execution: 3 branches, verify all complete, verify order
  of persistence
- For-each over 10 line items: verify 10 iterations, isolated context
  per iteration
- Branch with nested if-then-else: verify correct path taken
- Retry on transient failure: verify 3 attempts, exponential delays
- App connector: stub webhook server → flow triggers → HMAC verified
  → response parsed

### 8.3 Smoke tests

- `scripts/smoke-phase18-pr1.ts` — trigger + action registry offline
  tests
- `scripts/smoke-phase18-pr2.ts` — engine execution with mocked DB
- `scripts/smoke-phase18-pr3.ts` — UI smoke (server.ts routes for
  flow admin)
- `scripts/smoke-phase18-pr4.ts` — template library install
- `scripts/smoke-phase18-pr5.ts` — app connector HMAC handshake

Each smoke adds to `scripts/ops/smoke-baseline.json`.

### 8.4 Iron Rule 5 source scan

Every flow-v2 file scanned for `/god-admin/` / `god_admin` references
in any user-visible string (error messages, UI labels, logs).
Platform-operator-only fields (`error_reason`) never rendered in
seller UI — specifically scrub on render layer.

---

## 9. Phased Rollout

### PR1 — Core Engine (est. 3 weeks)

**Deliverables:**

- `flow-v2` module scaffolding
- Trigger registry + 15 built-in triggers (orders, customers,
  inventory, products, reviews — the high-frequency ones)
- Action registry + 20 built-in actions (email, tag, discount,
  webhook, delay, branch, notification)
- DSL v2 parser + compiler + validator
- Execution engine (sequential + branch + delay only)
- Migration 093 adding `flow_definitions`, `flow_runs`,
  `flow_run_steps`, `flow_pending_events`
- 100 unit tests
- `scripts/smoke-phase18-pr1.ts`

**Not in PR1:** UI, templates, app connectors, parallel, for_each.

**Shippable as:** back-end only; v1 UI still active, new module
accessible via `runFlowOnce` API from test scripts.

### PR2 — Full Catalog + Parallel/For-Each (est. 2 weeks)

**Deliverables:**

- Remaining 25 triggers (subscriptions, B2B, fulfillment, apps,
  etc.) — marked as optional dependencies; triggers that require
  Phase 17 subs/Phase 17 PO remain no-op until those phases ship
- Remaining 40 actions
- Parallel execution primitive
- For-each loop primitive
- Variable substitution edge cases (nested objects, array access,
  missing-key default)
- 50 more unit tests

**Shippable as:** engine feature-complete; still no UI.

### PR3 — Admin UI (est. 4 weeks — biggest PR)

**Deliverables:**

- React Flow canvas integration in EmDash
- Trigger/action catalog panel with search
- JSON DSL Monaco editor with schema validation
- Test run panel (dry-run executor)
- Run history view with step-level log rendering
- Routes + server.ts wiring for all endpoints in §6.1
- Sidebar reorg: "Flow v2" replaces "Automations"
- 30 integration tests (UI posts to API, expects proper DB state)

**Shippable as:** merchants can create + publish + test flows via UI.

### PR4 — Template Library + Migration Helper (est. 1.5 weeks)

**Deliverables:**

- 20 starter templates covering:
  - Abandoned cart recovery (3 variants)
  - VIP customer welcome (3 variants)
  - Low-stock staff alert
  - Post-purchase thank-you
  - Review request 7 days post-delivery
  - Reorder reminder 30 days post-purchase
  - Customer birthday discount
  - First-time customer welcome email series (3-step)
  - Refund processed notification
  - Order risk flagged → staff alert
  - High-value order → concierge staff note
  - Subscription renewal reminder (gated behind Phase 17)
  - Failed payment dunning sequence (gated behind Phase 17)
- Template catalog UI
- v1 → v2 migration helper CLI:
  `npm run flow-v2:migrate-v1 --shop <id> --dry-run`

**Shippable as:** merchants adopt existing templates rather than
build from scratch.

### PR5 — App Connector Protocol (est. 1.5 weeks)

**Deliverables:**

- App connector registration at app install (extending
  `app_installations`)
- Platform-admin approval flow for connectors (god-admin surface)
- HMAC sign/verify helpers
- Connector webhook client (calls external URL with retry)
- Test fixtures: stub external connector server for integration tests
- Documentation page for app developers

**Shippable as:** full ecosystem parity; third-party apps extend the
catalog.

**Total timeline:** 12 weeks (PR1-5), fits in a single phase window.

---

## 10. Locked Decisions (Owner Thai Approved 2026-04-24)

All 7 open questions were resolved with the proposed defaults. These
are now binding for writing-plans and all 5 PRs:

1. **Visual canvas library: React Flow** (MIT, mature, 25k+ stars).
   Rete.js and roll-our-own rejected.
2. **v1 → v2 migration: 2-week parallel window + auto-migrate at
   cutover + v1 marked read-only.** v1 tables dropped after cutover
   per Appendix A.
3. **Template library moderation: Gbox-curated only in v1.**
   App-contributed templates deferred to Phase 19+. Template CRUD
   restricted to platform-admin role.
4. **Per-shop execution limits: 10 flows/sec/shop soft cap + 1000
   runs/shop/day hard cap for Basic tier. Unlimited for Plus tier.**
   Enforcement via BullMQ rate-limiter per shop; excess queued with
   warning visible to merchant.
5. **Flow versioning: version history UI with rollback, capped at 5
   most-recent versions per flow.** Versions 6+ pruned on publish.
   Rollback creates a NEW version (N+1) from old DSL, not a true
   rewind — keeps audit monotonic.
6. **Iron Rule 5 confirmed for `flow_runs.error_reason`.** Column is
   platform-operator-only. Admin UI renders generic "Step failed —
   please contact Gbox support" for seller view. Internal platform-
   admin route can see full `error_reason`. Scrub layer sits at the
   render boundary (`apps/store-admin/...` formatter), not in the DB
   query.
7. **Trigger ID namespace: `gbox/*` prefix (not `shopify/*`).** All
   built-in triggers/actions use `gbox/<resource>/<event>` format.
   App-contributed triggers use `<appId>/*` per §4.6. Shopify-import
   compatibility explicitly out of scope (see §11 Non-Goals).

---

## 11. Hand-off to writing-plans

Thai approved the spec + all 7 §10 decisions on 2026-04-24. Spec is
frozen and ready for plan conversion.

> **Input to writing-plans:** This spec
> (`2026-04-25-gbox-flow-v2-design-spec.md`) with §10 locked
> decisions.
>
> **Expected output:** 5 PR-scoped implementation plans, one per PR
> in §9, each with:
> - Detailed step breakdown
> - File-by-file change list
> - Test checklist per step
> - Pre-existing code to reference (e.g., `automations/service.ts` v1
>   to mine for patterns)
> - Dependencies / ordering between PRs
> - Estimated effort per step (granular — hours/days)

**This spec's terminal state is writing-plans invocation. Do not
start implementation from this spec directly; convert to plan first.**

---

## Appendix A — v1 Feature → v2 Feature Mapping

| v1 capability | v2 mapping | Breaking change? |
|---|---|---|
| Trigger `order.placed` | `gbox/order/created` | Yes — renamed |
| Trigger `order.paid` | `gbox/order/paid` | Yes — renamed |
| Trigger `customer.tagged` | `gbox/customer/tagged` | Yes — renamed |
| Action `send_email` | `gbox/email.send_template` | Yes — renamed |
| Action `add_customer_tag` | `gbox/customer.add_tags` | Yes — renamed |
| DSL v1 JSON | Auto-converted by `migration-helper.ts` | No (transparent) |
| Flow runs v1 | Remain queryable in parallel for 2 weeks | No |
| `flow_definitions` v1 table | Dropped at cutover | Yes |

## Appendix B — Non-Goals (Explicit)

- **NOT a Shopify Flow DSL import.** We do not parse Shopify's
  proprietary `.flow` export. A merchant migrating from Shopify starts
  with our template library.
- **NOT a general-purpose workflow engine.** Gbox Flow v2 is
  e-commerce-scoped. Triggers/actions are commerce-relevant; no
  generic HTTP pipelines, ETL jobs, or BI queries. (Merchants wanting
  those use Make / Zapier via `webhook.send_to_url` action.)
- **NOT an ML decision engine.** Conditions are deterministic rules.
  ML-based segmentation (Phase 19+ "Flow Intelligence") is separate.
- **NOT a replacement for Phase 13 support automations.** Support
  workflow routing (SLA escalation, canned replies) stays in the
  support module; Flow v2 can `support.create_ticket` but doesn't own
  the ticket lifecycle.

---

*Spec prepared 2026-04-25. Ready for Thai review + writing-plans
hand-off. Estimated total effort: 12 weeks / 5 PRs / 1 phase (Phase 18).*
