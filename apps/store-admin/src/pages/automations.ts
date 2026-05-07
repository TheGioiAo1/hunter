/**
 * Store Admin — Marketing Automations
 *
 * Manage automated marketing workflows: abandoned cart recovery,
 * welcome emails, post-purchase follow-ups, etc.
 * Uses shop_settings for configuration.
 */

import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db'
import { sellerLayout, esc } from '../layouts/seller-layout.js'
import { listAutomations as listCustomAutomations, createAutomation, deleteAutomation } from '@gbox/core/modules/automations/engine.js'
import type { Automation, AutomationTriggerType, AutomationActionType } from '@gbox/core/modules/automations/engine.js'
import { notify, byActor } from '../lib/notify.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getShopSetting(db: Kysely<Database>, shopId: string, key: string): Promise<any> {
  const row = await db
    .selectFrom('shop_settings')
    .select('value')
    .where('shop_id', '=', shopId)
    .where('key', '=', key)
    .executeTakeFirst()
  return row ? (row as any).value : null
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

// ---------------------------------------------------------------------------
// Automation definitions
// ---------------------------------------------------------------------------

const AUTOMATIONS = [
  {
    id: 'abandoned_cart',
    name: 'Abandoned Cart Recovery',
    description: 'Send an email when a customer leaves items in their cart without completing checkout',
    icon: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 002 1.61h9.72a2 2 0 002-1.61L23 6H6"/></svg>',
    settingKey: 'auto_abandoned_cart',
    delayOptions: ['1 hour', '4 hours', '12 hours', '24 hours'],
  },
  {
    id: 'welcome_email',
    name: 'Welcome Email',
    description: 'Send a welcome email when a new customer creates an account',
    icon: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>',
    settingKey: 'auto_welcome_email',
    delayOptions: ['Immediately', '5 minutes', '1 hour'],
  },
  {
    id: 'post_purchase',
    name: 'Post-Purchase Follow-up',
    description: 'Ask for a review or offer a discount after a customer receives their order',
    icon: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
    settingKey: 'auto_post_purchase',
    delayOptions: ['3 days', '7 days', '14 days', '30 days'],
  },
  {
    id: 'win_back',
    name: 'Win-back Campaign',
    description: 'Re-engage customers who haven\'t purchased in a while',
    icon: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/></svg>',
    settingKey: 'auto_win_back',
    delayOptions: ['30 days', '60 days', '90 days'],
  },
  {
    id: 'birthday',
    name: 'Birthday Discount',
    description: 'Send a special discount to customers on their birthday',
    icon: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
    settingKey: 'auto_birthday',
    delayOptions: ['On birthday', '1 day before', '3 days before'],
  },
]

// ---------------------------------------------------------------------------
// GET /marketing/automations
// ---------------------------------------------------------------------------

export async function getAutomations(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const theme = (req as any).theme || 'dark'

  // Load all automation settings
  const settings: Record<string, any> = {}
  for (const auto of AUTOMATIONS) {
    settings[auto.id] = await getShopSetting(db, store.id, auto.settingKey)
  }

  const activeCount = Object.values(settings).filter(s => s?.enabled).length

  // Load custom automations
  const customAutomations = await listCustomAutomations(db, store.id)
  const customActiveCount = customAutomations.filter(a => a.enabled).length

  const automationCards = AUTOMATIONS.map(auto => {
    const s = settings[auto.id] || {}
    const enabled = s.enabled === true
    return `
    <div class="card" style="background:var(--s-surface);border:1px solid ${enabled ? 'rgba(34,197,94,.3)' : 'var(--s-border)'};border-radius:10px;padding:20px;margin-bottom:16px">
      <div style="display:flex;align-items:flex-start;justify-content:space-between">
        <div style="display:flex;align-items:flex-start;gap:14px">
          <div style="color:${enabled ? '#22c55e' : 'var(--s-text-secondary)'};margin-top:2px">${auto.icon}</div>
          <div>
            <div style="font-weight:700;font-size:15px;color:var(--s-text-primary);margin-bottom:2px">${auto.name}</div>
            <div style="font-size:13px;color:var(--s-text-secondary);margin-bottom:12px">${auto.description}</div>
            <div style="display:flex;align-items:center;gap:12px">
              <span class="badge ${enabled ? 'badge-success' : 'badge-warning'}" style="font-size:11px">${enabled ? 'Active' : 'Inactive'}</span>
              ${s.delay ? `<span style="font-size:12px;color:var(--s-text-secondary)">Delay: ${esc(s.delay)}</span>` : ''}
            </div>
          </div>
        </div>
        <form method="POST" action="/admin/store/${esc(store.slug)}/marketing/automations">
          <input type="hidden" name="_csrf" value="${esc((req as any).csrfToken || '')}" />
          <input type="hidden" name="automation_id" value="${auto.id}" />
          <input type="hidden" name="action" value="${enabled ? 'disable' : 'enable'}" />
          <button type="submit" class="btn btn-sm" style="font-size:12px;padding:6px 14px;background:${enabled ? '#ef444422' : '#22c55e22'};border:1px solid ${enabled ? '#ef444444' : '#22c55e44'};border-radius:6px;color:${enabled ? '#ef4444' : '#22c55e'};cursor:pointer;font-weight:600">
            ${enabled ? 'Disable' : 'Enable'}
          </button>
        </form>
      </div>
    </div>`
  }).join('')

  // Trigger type display names
  const triggerLabels: Record<string, string> = {
    order_created: 'Order Created',
    order_fulfilled: 'Order Fulfilled',
    customer_created: 'Customer Created',
    inventory_low: 'Low Inventory',
    abandoned_cart: 'Abandoned Cart',
    product_created: 'Product Created',
  }

  // Action type display names
  const actionLabels: Record<string, string> = {
    send_email: 'Send Email',
    add_tag: 'Add Tag',
    remove_tag: 'Remove Tag',
    notify_staff: 'Notify Staff',
    webhook: 'Webhook',
    wait: 'Wait',
  }

  const customCards = customAutomations.map(auto => {
    const actionSummary = auto.actions
      .map(a => actionLabels[a.type] || a.type)
      .join(' &rarr; ')

    return `
    <div class="card" style="background:var(--s-surface);border:1px solid ${auto.enabled ? 'rgba(99,102,241,.3)' : 'var(--s-border)'};border-radius:10px;padding:20px;margin-bottom:16px">
      <div style="display:flex;align-items:flex-start;justify-content:space-between">
        <div style="display:flex;align-items:flex-start;gap:14px">
          <div style="color:${auto.enabled ? '#6366f1' : 'var(--s-text-secondary)'};margin-top:2px">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
          </div>
          <div>
            <div style="font-weight:700;font-size:15px;color:var(--s-text-primary);margin-bottom:2px">${esc(auto.name)}</div>
            <div style="font-size:13px;color:var(--s-text-secondary);margin-bottom:8px">
              Trigger: <strong>${triggerLabels[auto.trigger.type] || auto.trigger.type}</strong>
              ${auto.trigger.conditions && auto.trigger.conditions.length > 0
                ? ` (${auto.trigger.conditions.length} condition${auto.trigger.conditions.length > 1 ? 's' : ''})`
                : ''}
            </div>
            <div style="font-size:12px;color:var(--s-text-secondary);margin-bottom:8px">
              Actions: ${actionSummary || 'None'}
            </div>
            <div style="display:flex;align-items:center;gap:12px">
              <span class="badge ${auto.enabled ? 'badge-success' : 'badge-warning'}" style="font-size:11px">${auto.enabled ? 'Active' : 'Inactive'}</span>
              <span style="font-size:11px;color:var(--s-text-secondary)">Custom</span>
            </div>
          </div>
        </div>
        <div style="display:flex;gap:8px">
          <form method="POST" action="/admin/store/${esc(store.slug)}/marketing/automations">
            <input type="hidden" name="_csrf" value="${esc((req as any).csrfToken || '')}" />
            <input type="hidden" name="custom_automation_id" value="${esc(auto.id)}" />
            <input type="hidden" name="action" value="${auto.enabled ? 'disable_custom' : 'enable_custom'}" />
            <button type="submit" class="btn btn-sm" style="font-size:12px;padding:6px 14px;background:${auto.enabled ? '#ef444422' : '#22c55e22'};border:1px solid ${auto.enabled ? '#ef444444' : '#22c55e44'};border-radius:6px;color:${auto.enabled ? '#ef4444' : '#22c55e'};cursor:pointer;font-weight:600">
              ${auto.enabled ? 'Disable' : 'Enable'}
            </button>
          </form>
          <form method="POST" action="/admin/store/${esc(store.slug)}/marketing/automations">
            <input type="hidden" name="_csrf" value="${esc((req as any).csrfToken || '')}" />
            <input type="hidden" name="custom_automation_id" value="${esc(auto.id)}" />
            <input type="hidden" name="action" value="delete_custom" />
            <button type="submit" class="btn btn-sm" style="font-size:12px;padding:6px 14px;background:#ef444411;border:1px solid #ef444433;border-radius:6px;color:#ef4444;cursor:pointer;font-weight:600" onclick="return confirm('Delete this automation?')">
              Delete
            </button>
          </form>
        </div>
      </div>
    </div>`
  }).join('')

  // Show/hide create form based on query param
  const showForm = req.query.create === '1'

  const triggerOptions = Object.entries(triggerLabels)
    .map(([val, label]) => `<option value="${val}">${label}</option>`)
    .join('')

  const actionOptions = Object.entries(actionLabels)
    .map(([val, label]) => `<option value="${val}">${label}</option>`)
    .join('')

  const createForm = showForm ? `
    <div class="card" style="background:var(--s-surface);border:1px solid var(--s-border);border-radius:10px;padding:24px;margin-bottom:24px">
      <h3 style="font-size:16px;font-weight:700;margin:0 0 16px;color:var(--s-text-primary)">Create Custom Automation</h3>
      <form method="POST" action="/admin/store/${esc(store.slug)}/marketing/automations">
        <input type="hidden" name="_csrf" value="${esc((req as any).csrfToken || '')}" />
        <input type="hidden" name="action" value="create_custom" />

        <div style="margin-bottom:14px">
          <label style="display:block;font-size:13px;font-weight:600;color:var(--s-text-secondary);margin-bottom:4px">Name</label>
          <input type="text" name="name" required placeholder="e.g. Tag VIP orders" style="width:100%;padding:8px 12px;background:var(--s-bg);border:1px solid var(--s-border);border-radius:6px;color:var(--s-text-primary);font-size:14px" />
        </div>

        <div style="margin-bottom:14px">
          <label style="display:block;font-size:13px;font-weight:600;color:var(--s-text-secondary);margin-bottom:4px">Trigger</label>
          <select name="trigger_type" required style="width:100%;padding:8px 12px;background:var(--s-bg);border:1px solid var(--s-border);border-radius:6px;color:var(--s-text-primary);font-size:14px">
            ${triggerOptions}
          </select>
        </div>

        <div style="margin-bottom:14px;padding:12px;background:var(--s-bg);border:1px solid var(--s-border);border-radius:8px">
          <div style="font-size:13px;font-weight:600;color:var(--s-text-secondary);margin-bottom:8px">Condition (optional)</div>
          <div style="display:grid;grid-template-columns:1fr auto 1fr;gap:8px;align-items:center">
            <input type="text" name="cond_field" placeholder="e.g. order.total_price" style="padding:8px 12px;background:var(--s-surface);border:1px solid var(--s-border);border-radius:6px;color:var(--s-text-primary);font-size:13px" />
            <select name="cond_operator" style="padding:8px 10px;background:var(--s-surface);border:1px solid var(--s-border);border-radius:6px;color:var(--s-text-primary);font-size:13px">
              <option value="equals">equals</option>
              <option value="contains">contains</option>
              <option value="greater_than">greater than</option>
              <option value="less_than">less than</option>
            </select>
            <input type="text" name="cond_value" placeholder="value" style="padding:8px 12px;background:var(--s-surface);border:1px solid var(--s-border);border-radius:6px;color:var(--s-text-primary);font-size:13px" />
          </div>
        </div>

        <div style="margin-bottom:14px;padding:12px;background:var(--s-bg);border:1px solid var(--s-border);border-radius:8px">
          <div style="font-size:13px;font-weight:600;color:var(--s-text-secondary);margin-bottom:8px">Action 1</div>
          <div style="display:grid;grid-template-columns:auto 1fr;gap:8px;align-items:center">
            <select name="action1_type" required style="padding:8px 10px;background:var(--s-surface);border:1px solid var(--s-border);border-radius:6px;color:var(--s-text-primary);font-size:13px">
              ${actionOptions}
            </select>
            <input type="text" name="action1_config" placeholder='{"tag":"vip","resource":"order"}' style="padding:8px 12px;background:var(--s-surface);border:1px solid var(--s-border);border-radius:6px;color:var(--s-text-primary);font-size:13px" />
          </div>
        </div>

        <div style="margin-bottom:18px;padding:12px;background:var(--s-bg);border:1px solid var(--s-border);border-radius:8px">
          <div style="font-size:13px;font-weight:600;color:var(--s-text-secondary);margin-bottom:8px">Action 2 (optional)</div>
          <div style="display:grid;grid-template-columns:auto 1fr;gap:8px;align-items:center">
            <select name="action2_type" style="padding:8px 10px;background:var(--s-surface);border:1px solid var(--s-border);border-radius:6px;color:var(--s-text-primary);font-size:13px">
              <option value="">-- none --</option>
              ${actionOptions}
            </select>
            <input type="text" name="action2_config" placeholder='{"message":"New order!"}' style="padding:8px 12px;background:var(--s-surface);border:1px solid var(--s-border);border-radius:6px;color:var(--s-text-primary);font-size:13px" />
          </div>
        </div>

        <div style="display:flex;gap:10px">
          <button type="submit" class="btn btn-primary" style="padding:8px 20px;background:#6366f1;border:none;border-radius:6px;color:#fff;cursor:pointer;font-weight:600;font-size:14px">Create Automation</button>
          <a href="/admin/store/${esc(store.slug)}/marketing/automations" style="padding:8px 20px;background:var(--s-surface);border:1px solid var(--s-border);border-radius:6px;color:var(--s-text-secondary);text-decoration:none;font-size:14px;display:inline-flex;align-items:center">Cancel</a>
        </div>
      </form>
    </div>
  ` : ''

  const content = `
    <div class="page-header" style="display:flex;align-items:center;justify-content:space-between;margin-bottom:24px">
      <div>
        <h1 style="margin:0;font-size:22px;font-weight:700">Automations</h1>
        <p style="margin:4px 0 0;color:var(--s-text-secondary);font-size:13px">Automated marketing workflows for ${esc(store.name)}</p>
      </div>
      ${!showForm ? `<a href="/admin/store/${esc(store.slug)}/marketing/automations?create=1" class="btn btn-primary" style="padding:8px 16px;background:#6366f1;border:none;border-radius:6px;color:#fff;text-decoration:none;font-weight:600;font-size:13px;display:inline-flex;align-items:center;gap:6px">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        Create Automation
      </a>` : ''}
    </div>

    ${createForm}

    <div class="stats-grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;margin-bottom:24px">
      <div class="stat-card" style="background:var(--s-surface);border:1px solid var(--s-border);border-radius:10px;padding:20px">
        <div style="font-size:12px;font-weight:600;color:var(--s-text-secondary);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">Preset Active</div>
        <div style="font-size:28px;font-weight:700;color:#34d399">${activeCount}</div>
      </div>
      <div class="stat-card" style="background:var(--s-surface);border:1px solid var(--s-border);border-radius:10px;padding:20px">
        <div style="font-size:12px;font-weight:600;color:var(--s-text-secondary);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">Custom Active</div>
        <div style="font-size:28px;font-weight:700;color:#6366f1">${customActiveCount}</div>
      </div>
      <div class="stat-card" style="background:var(--s-surface);border:1px solid var(--s-border);border-radius:10px;padding:20px">
        <div style="font-size:12px;font-weight:600;color:var(--s-text-secondary);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">Total</div>
        <div style="font-size:28px;font-weight:700;color:var(--s-text-primary)">${AUTOMATIONS.length + customAutomations.length}</div>
      </div>
    </div>

    ${customAutomations.length > 0 ? `
      <h2 style="font-size:16px;font-weight:700;margin:0 0 12px;color:var(--s-text-primary)">Custom Automations</h2>
      ${customCards}
    ` : ''}

    <h2 style="font-size:16px;font-weight:700;margin:24px 0 12px;color:var(--s-text-primary)">Preset Automations</h2>
    ${automationCards}
  `

  res.send(
    sellerLayout({
      title: 'Automations',
      storeName: store.name,
      storeSlug: store.slug,
      userName: user.name,
      userEmail: user.email,
      userRole: user.role,
      storeRole: user.storeRole,
      activePage: 'marketing',
      content,
      theme: theme as 'dark' | 'light',
    }),
  )
}

// ---------------------------------------------------------------------------
// POST /marketing/automations — Toggle automation
// ---------------------------------------------------------------------------

export async function postAutomationToggle(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const { automation_id, custom_automation_id, action } = req.body

  // ---- Custom automation actions ----
  if (action === 'create_custom') {
    try {
      const { name, trigger_type, cond_field, cond_operator, cond_value,
              action1_type, action1_config, action2_type, action2_config } = req.body

      if (!name || !trigger_type || !action1_type) {
        return res.redirect(`/admin/store/${store.slug}/marketing/automations?create=1&error=missing_fields`)
      }

      const conditions = cond_field && cond_value
        ? [{ field: cond_field, operator: cond_operator || 'equals', value: cond_value }]
        : []

      const actions: Array<{ type: AutomationActionType; config: Record<string, any> }> = []

      // Parse action 1
      let config1: Record<string, any> = {}
      if (action1_config) {
        try { config1 = JSON.parse(action1_config) } catch { config1 = { value: action1_config } }
      }
      actions.push({ type: action1_type as AutomationActionType, config: config1 })

      // Parse action 2 (optional)
      if (action2_type) {
        let config2: Record<string, any> = {}
        if (action2_config) {
          try { config2 = JSON.parse(action2_config) } catch { config2 = { value: action2_config } }
        }
        actions.push({ type: action2_type as AutomationActionType, config: config2 })
      }

      await createAutomation(db, store.id, {
        name,
        trigger: { type: trigger_type as AutomationTriggerType, conditions },
        actions,
        enabled: true,
      })

      notify(db, {
        shopId: store.id,
        userId: (req as any).storeUser?.id,
        type: 'automation_created',
        title: `Automation created: ${name}`,
        message: [`Trigger: ${trigger_type}`, byActor((req as any).storeUser)].filter(Boolean).join(' • '),
        resourceType: 'automation',
        resourceId: null,
      })

      return res.redirect(`/admin/store/${store.slug}/marketing/automations?success=automation_created`)
    } catch (err: any) {
      return res.redirect(`/admin/store/${store.slug}/marketing/automations?create=1&error=${encodeURIComponent(err.message)}`)
    }
  }

  if (action === 'enable_custom' || action === 'disable_custom') {
    if (!custom_automation_id) {
      return res.redirect(`/admin/store/${store.slug}/marketing/automations?error=missing_id`)
    }
    try {
      const { updateAutomation } = await import('@gbox/core/modules/automations/engine.js')
      await updateAutomation(db, store.id, custom_automation_id, {
        enabled: action === 'enable_custom',
      })
      notify(db, {
        shopId: store.id,
        userId: (req as any).storeUser?.id,
        type: action === 'enable_custom' ? 'automation_enabled' : 'automation_disabled',
        title: `Automation ${action === 'enable_custom' ? 'enabled' : 'disabled'}`,
        message: byActor((req as any).storeUser),
        resourceType: 'automation',
        resourceId: custom_automation_id,
      })
      return res.redirect(`/admin/store/${store.slug}/marketing/automations?success=${action}d`)
    } catch (err: any) {
      return res.redirect(`/admin/store/${store.slug}/marketing/automations?error=${encodeURIComponent(err.message)}`)
    }
  }

  if (action === 'delete_custom') {
    if (!custom_automation_id) {
      return res.redirect(`/admin/store/${store.slug}/marketing/automations?error=missing_id`)
    }
    try {
      await deleteAutomation(db, store.id, custom_automation_id)
      notify(db, {
        shopId: store.id,
        userId: (req as any).storeUser?.id,
        type: 'automation_deleted',
        title: 'Automation deleted',
        message: byActor((req as any).storeUser),
        resourceType: 'automation',
        resourceId: custom_automation_id,
      })
      return res.redirect(`/admin/store/${store.slug}/marketing/automations?success=deleted`)
    } catch (err: any) {
      return res.redirect(`/admin/store/${store.slug}/marketing/automations?error=${encodeURIComponent(err.message)}`)
    }
  }

  // ---- Preset automation toggle (original logic) ----
  const auto = AUTOMATIONS.find(a => a.id === automation_id)
  if (!auto) {
    return res.redirect(`/admin/store/${store.slug}/marketing/automations?error=invalid_automation`)
  }

  try {
    const current = (await getShopSetting(db, store.id, auto.settingKey)) || {}
    await setShopSetting(db, store.id, auto.settingKey, {
      ...current,
      enabled: action === 'enable',
      delay: current.delay || auto.delayOptions[0],
    })
    notify(db, {
      shopId: store.id,
      userId: (req as any).storeUser?.id,
      type: action === 'enable' ? 'automation_enabled' : 'automation_disabled',
      title: `${auto.name} ${action === 'enable' ? 'enabled' : 'disabled'}`,
      message: byActor((req as any).storeUser),
      resourceType: 'automation',
      resourceId: automation_id,
    })
    res.redirect(`/admin/store/${store.slug}/marketing/automations?success=${action}d`)
  } catch (err: any) {
    res.redirect(`/admin/store/${store.slug}/marketing/automations?error=${encodeURIComponent(err.message)}`)
  }
}
