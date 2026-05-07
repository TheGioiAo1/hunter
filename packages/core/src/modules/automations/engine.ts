/**
 * Gbox Platform — Automation Engine (Shopify Flow Equivalent)
 *
 * Event-driven automation system that fires actions when triggers occur.
 * Automations are stored per-shop in shop_settings under key 'custom_automations'.
 *
 * Trigger types: order_created, order_fulfilled, customer_created,
 *                inventory_low, abandoned_cart, product_created
 * Action types:  send_email, add_tag, remove_tag, notify_staff, webhook, wait
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AutomationCondition {
  field: string       // e.g. 'order.total_price', 'customer.tags'
  operator: 'equals' | 'contains' | 'greater_than' | 'less_than'
  value: string
}

export type AutomationTriggerType =
  | 'order_created'
  | 'order_fulfilled'
  | 'customer_created'
  | 'inventory_low'
  | 'abandoned_cart'
  | 'product_created'

export interface AutomationTrigger {
  type: AutomationTriggerType
  conditions?: AutomationCondition[]
}

export type AutomationActionType =
  | 'send_email'
  | 'add_tag'
  | 'remove_tag'
  | 'notify_staff'
  | 'webhook'
  | 'wait'

export interface AutomationAction {
  type: AutomationActionType
  config: Record<string, any>
  // send_email:   { template: string, to: 'customer' | 'staff' }
  // add_tag:      { resource: 'order' | 'customer', tag: string }
  // remove_tag:   { resource: 'order' | 'customer', tag: string }
  // notify_staff: { message: string }
  // webhook:      { url: string, method?: string }
  // wait:         { duration_minutes: number }
}

export interface Automation {
  id: string
  shop_id: string
  name: string
  enabled: boolean
  trigger: AutomationTrigger
  actions: AutomationAction[]
  created_at: string
  updated_at: string
}

export interface AutomationContext {
  trigger_type: AutomationTriggerType
  resource_id?: string
  order?: Record<string, any>
  customer?: Record<string, any>
  product?: Record<string, any>
  shop_id: string
}

// ---------------------------------------------------------------------------
// Shop settings helpers (same pattern as automations.ts page)
// ---------------------------------------------------------------------------

async function getShopSetting(db: Kysely<Database>, shopId: string, key: string): Promise<any> {
  const row = await db
    .selectFrom('shop_settings')
    .select('value')
    .where('shop_id', '=', shopId)
    .where('key', '=', key)
    .executeTakeFirst()
  if (!row) return null
  try {
    return typeof (row as any).value === 'string'
      ? JSON.parse((row as any).value)
      : (row as any).value
  } catch {
    return (row as any).value
  }
}

async function setShopSetting(db: Kysely<Database>, shopId: string, key: string, value: any): Promise<void> {
  const existing = await db
    .selectFrom('shop_settings')
    .select('id')
    .where('shop_id', '=', shopId)
    .where('key', '=', key)
    .executeTakeFirst()

  if (existing) {
    await db
      .updateTable('shop_settings')
      .set({ value: JSON.stringify(value), updated_at: new Date().toISOString() } as any)
      .where('shop_id', '=', shopId)
      .where('key', '=', key)
      .execute()
  } else {
    await db
      .insertInto('shop_settings')
      .values({ shop_id: shopId, key, value: JSON.stringify(value) } as any)
      .execute()
  }
}

const AUTOMATIONS_KEY = 'custom_automations'

// ---------------------------------------------------------------------------
// CRUD helpers
// ---------------------------------------------------------------------------

export async function listAutomations(db: Kysely<Database>, shopId: string): Promise<Automation[]> {
  const data = await getShopSetting(db, shopId, AUTOMATIONS_KEY)
  if (!Array.isArray(data)) return []
  return data as Automation[]
}

export async function getAutomationById(db: Kysely<Database>, shopId: string, automationId: string): Promise<Automation | null> {
  const list = await listAutomations(db, shopId)
  return list.find(a => a.id === automationId) ?? null
}

export async function createAutomation(
  db: Kysely<Database>,
  shopId: string,
  input: { name: string; trigger: AutomationTrigger; actions: AutomationAction[]; enabled?: boolean },
): Promise<Automation> {
  const list = await listAutomations(db, shopId)
  const now = new Date().toISOString()
  const automation: Automation = {
    id: generateId(),
    shop_id: shopId,
    name: input.name,
    enabled: input.enabled ?? true,
    trigger: input.trigger,
    actions: input.actions,
    created_at: now,
    updated_at: now,
  }
  list.push(automation)
  await setShopSetting(db, shopId, AUTOMATIONS_KEY, list)
  return automation
}

export async function updateAutomation(
  db: Kysely<Database>,
  shopId: string,
  automationId: string,
  updates: Partial<Pick<Automation, 'name' | 'enabled' | 'trigger' | 'actions'>>,
): Promise<Automation | null> {
  const list = await listAutomations(db, shopId)
  const idx = list.findIndex(a => a.id === automationId)
  if (idx === -1) return null

  const existing = list[idx]
  const updated: Automation = {
    ...existing,
    ...updates,
    updated_at: new Date().toISOString(),
  }
  list[idx] = updated
  await setShopSetting(db, shopId, AUTOMATIONS_KEY, list)
  return updated
}

export async function deleteAutomation(
  db: Kysely<Database>,
  shopId: string,
  automationId: string,
): Promise<boolean> {
  const list = await listAutomations(db, shopId)
  const filtered = list.filter(a => a.id !== automationId)
  if (filtered.length === list.length) return false
  await setShopSetting(db, shopId, AUTOMATIONS_KEY, filtered)
  return true
}

// ---------------------------------------------------------------------------
// Condition evaluator
// ---------------------------------------------------------------------------

/**
 * Resolve a dotted field path against the trigger data context.
 * e.g. 'order.total_price' resolves to context.order.total_price
 */
function resolveField(data: Record<string, any>, field: string): any {
  const parts = field.split('.')
  let current: any = data
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined
    current = current[part]
  }
  return current
}

/**
 * Evaluate whether all conditions match the given trigger data.
 * Returns true if there are no conditions (unconditional trigger).
 */
export function evaluateConditions(
  triggerData: Record<string, any>,
  conditions?: AutomationCondition[],
): boolean {
  if (!conditions || conditions.length === 0) return true

  for (const cond of conditions) {
    const actual = resolveField(triggerData, cond.field)
    if (actual === undefined) return false

    const actualStr = String(actual)
    const expected = cond.value

    switch (cond.operator) {
      case 'equals':
        if (actualStr !== expected) return false
        break
      case 'contains':
        if (!actualStr.toLowerCase().includes(expected.toLowerCase())) return false
        break
      case 'greater_than':
        if (parseFloat(actualStr) <= parseFloat(expected)) return false
        break
      case 'less_than':
        if (parseFloat(actualStr) >= parseFloat(expected)) return false
        break
      default:
        return false
    }
  }

  return true
}

// ---------------------------------------------------------------------------
// Action executor
// ---------------------------------------------------------------------------

/**
 * Execute a single automation action.
 * Returns a result object with status and optional details.
 */
export async function executeAction(
  db: Kysely<Database>,
  shopId: string,
  action: AutomationAction,
  context: AutomationContext,
): Promise<{ action: string; status: 'success' | 'skipped' | 'error'; detail?: string }> {
  try {
    switch (action.type) {
      case 'send_email': {
        // Log to notifications as a placeholder until real email service is wired
        const template = action.config.template || 'default'
        const to = action.config.to || 'staff'
        await db
          .insertInto('notifications')
          .values({
            shop_id: shopId,
            type: 'automation_email',
            title: `Automation email: ${template}`,
            message: `Email queued to ${to} for ${context.trigger_type} (resource: ${context.resource_id || 'n/a'})`,
            resource_type: 'automation',
            resource_id: context.resource_id ?? null,
          })
          .execute()
        return { action: 'send_email', status: 'success', detail: `Queued "${template}" to ${to}` }
      }

      case 'add_tag': {
        const { resource, tag } = action.config
        if (!resource || !tag) return { action: 'add_tag', status: 'skipped', detail: 'Missing resource or tag' }
        const resourceId = resource === 'order' ? context.order?.id : context.customer?.id
        if (!resourceId) return { action: 'add_tag', status: 'skipped', detail: `No ${resource} in context` }

        const table = resource === 'order' ? 'orders' : 'customers'
        const row = await db
          .selectFrom(table as any)
          .select('tags')
          .where('id', '=', resourceId)
          .where('shop_id', '=', shopId)
          .executeTakeFirst()

        if (!row) return { action: 'add_tag', status: 'skipped', detail: `${resource} not found` }

        const existing: string[] = Array.isArray((row as any).tags) ? (row as any).tags : []
        if (!existing.includes(tag)) {
          existing.push(tag)
          await db
            .updateTable(table as any)
            .set({ tags: existing } as any)
            .where('id', '=', resourceId)
            .where('shop_id', '=', shopId)
            .execute()
        }
        return { action: 'add_tag', status: 'success', detail: `Added "${tag}" to ${resource}` }
      }

      case 'remove_tag': {
        const { resource, tag } = action.config
        if (!resource || !tag) return { action: 'remove_tag', status: 'skipped', detail: 'Missing resource or tag' }
        const resourceId = resource === 'order' ? context.order?.id : context.customer?.id
        if (!resourceId) return { action: 'remove_tag', status: 'skipped', detail: `No ${resource} in context` }

        const table = resource === 'order' ? 'orders' : 'customers'
        const row = await db
          .selectFrom(table as any)
          .select('tags')
          .where('id', '=', resourceId)
          .where('shop_id', '=', shopId)
          .executeTakeFirst()

        if (!row) return { action: 'remove_tag', status: 'skipped', detail: `${resource} not found` }

        const existing: string[] = Array.isArray((row as any).tags) ? (row as any).tags : []
        const filtered = existing.filter(t => t !== tag)
        if (filtered.length !== existing.length) {
          await db
            .updateTable(table as any)
            .set({ tags: filtered } as any)
            .where('id', '=', resourceId)
            .where('shop_id', '=', shopId)
            .execute()
        }
        return { action: 'remove_tag', status: 'success', detail: `Removed "${tag}" from ${resource}` }
      }

      case 'notify_staff': {
        const message = action.config.message || 'Automation triggered'
        await db
          .insertInto('notifications')
          .values({
            shop_id: shopId,
            type: 'automation',
            title: 'Automation Notification',
            message: message.replace(/\{trigger\}/g, context.trigger_type)
              .replace(/\{resource_id\}/g, context.resource_id || ''),
            resource_type: 'automation',
            resource_id: context.resource_id ?? null,
          })
          .execute()
        return { action: 'notify_staff', status: 'success', detail: message }
      }

      case 'webhook': {
        const url = action.config.url
        if (!url) return { action: 'webhook', status: 'skipped', detail: 'No URL configured' }

        try {
          const resp = await fetch(url, {
            method: action.config.method || 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              trigger: context.trigger_type,
              shop_id: shopId,
              resource_id: context.resource_id,
              data: {
                order: context.order,
                customer: context.customer,
                product: context.product,
              },
              timestamp: new Date().toISOString(),
            }),
            signal: AbortSignal.timeout(10000), // 10s timeout
          })
          return {
            action: 'webhook',
            status: resp.ok ? 'success' : 'error',
            detail: `${resp.status} ${resp.statusText}`,
          }
        } catch (err: any) {
          return { action: 'webhook', status: 'error', detail: err.message }
        }
      }

      case 'wait': {
        const minutes = action.config.duration_minutes || 0
        if (minutes > 0) {
          // In a real system this would schedule a delayed job via the cron system.
          // For now, log as a notification and return.
          await db
            .insertInto('notifications')
            .values({
              shop_id: shopId,
              type: 'automation',
              title: 'Automation Wait Step',
              message: `Waiting ${minutes} minutes before next action (${context.trigger_type})`,
              resource_type: 'automation',
              resource_id: context.resource_id ?? null,
            })
            .execute()
        }
        return { action: 'wait', status: 'success', detail: `Wait ${minutes}m` }
      }

      default:
        return { action: action.type, status: 'skipped', detail: 'Unknown action type' }
    }
  } catch (err: any) {
    return { action: action.type, status: 'error', detail: err.message }
  }
}

// ---------------------------------------------------------------------------
// Pipeline runner
// ---------------------------------------------------------------------------

/**
 * Run the full automation pipeline: evaluate conditions, then execute each
 * action in sequence.
 */
export async function processAutomation(
  db: Kysely<Database>,
  automation: Automation,
  triggerData: Record<string, any>,
): Promise<{ automationId: string; name: string; results: Array<{ action: string; status: string; detail?: string }> }> {
  // Check conditions
  if (!evaluateConditions(triggerData, automation.trigger.conditions)) {
    return {
      automationId: automation.id,
      name: automation.name,
      results: [{ action: 'conditions', status: 'skipped', detail: 'Conditions not met' }],
    }
  }

  const context: AutomationContext = {
    trigger_type: automation.trigger.type,
    resource_id: triggerData.order?.id || triggerData.customer?.id || triggerData.product?.id,
    order: triggerData.order,
    customer: triggerData.customer,
    product: triggerData.product,
    shop_id: automation.shop_id,
  }

  const results: Array<{ action: string; status: string; detail?: string }> = []

  for (const action of automation.actions) {
    const result = await executeAction(db, automation.shop_id, action, context)
    results.push(result)

    // Stop on error (fail-fast)
    if (result.status === 'error') break
  }

  // Log to events table for audit trail
  try {
    await db
      .insertInto('events')
      .values({
        shop_id: automation.shop_id,
        subject_type: 'automation',
        subject_id: automation.id,
        verb: 'executed',
        body: JSON.stringify({
          automation_name: automation.name,
          trigger: automation.trigger.type,
          results,
        }),
      })
      .execute()
  } catch {
    // Non-critical — don't fail the automation
  }

  return { automationId: automation.id, name: automation.name, results }
}

// ---------------------------------------------------------------------------
// Trigger entry point
// ---------------------------------------------------------------------------

/**
 * Called from API routes when events happen (order created, customer created, etc.).
 * Loads all enabled automations for the shop, filters by trigger type, and runs them.
 *
 * This is designed to be called fire-and-forget:
 *   void fireAutomationTrigger(db, shopId, 'order_created', { order }).catch(() => {})
 */
export async function fireAutomationTrigger(
  db: Kysely<Database>,
  shopId: string,
  triggerType: AutomationTriggerType,
  data: Record<string, any>,
): Promise<void> {
  const automations = await listAutomations(db, shopId)
  const matching = automations.filter(a => a.enabled && a.trigger.type === triggerType)

  for (const automation of matching) {
    try {
      await processAutomation(db, automation, data)
    } catch {
      // Swallow errors — automations should never break the main flow
    }
  }
}

// ---------------------------------------------------------------------------
// ID generator
// ---------------------------------------------------------------------------

function generateId(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  const segments = [8, 4, 4]
  return segments
    .map(len => Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join(''))
    .join('-')
}
