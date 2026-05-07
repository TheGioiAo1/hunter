/**
 * Gbox Platform — Plugin SDK Entry Point
 *
 * Provides helpers for third-party developers to define, validate,
 * and instantiate plugins.
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import type {
  GboxPlugin,
  GboxPluginContext,
  GboxPluginPermission,
} from './types.js'

// Re-export all types for convenience
export * from './types.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_PERMISSIONS: GboxPluginPermission[] = [
  'read_products',
  'write_products',
  'read_orders',
  'write_orders',
  'read_customers',
  'write_customers',
  'read_inventory',
  'write_inventory',
  'read_content',
  'write_content',
  'read_discounts',
  'write_discounts',
  'read_shipping',
  'write_shipping',
  'read_analytics',
  'read_shop',
  'write_shop_settings',
  'send_notifications',
  'manage_webhooks',
]

const SEMVER_RE = /^\d+\.\d+\.\d+(-[\w.]+)?$/
const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9._-]{1,127}$/

// ---------------------------------------------------------------------------
// defineGboxPlugin
// ---------------------------------------------------------------------------

/**
 * Define a Gbox plugin with validation. This is the primary entry point
 * for plugin authors.
 *
 * @example
 * ```ts
 * import { defineGboxPlugin } from '@gbox/core/modules/plugins-sdk'
 *
 * export default defineGboxPlugin({
 *   id: 'com.acme.loyalty',
 *   version: '1.0.0',
 *   name: 'Acme Loyalty Program',
 *   description: 'Reward customers with loyalty points.',
 *   author: 'Acme Inc.',
 *   permissions: ['read_orders', 'read_customers'],
 * })
 * ```
 */
export function defineGboxPlugin(config: GboxPlugin): GboxPlugin {
  const { valid, errors } = validatePlugin(config)
  if (!valid) {
    throw new Error(
      `Invalid plugin definition:\n${errors.map((e) => `  - ${e}`).join('\n')}`,
    )
  }
  return Object.freeze({ ...config })
}

// ---------------------------------------------------------------------------
// validatePlugin
// ---------------------------------------------------------------------------

/**
 * Validate a plugin definition and return structured errors.
 */
export function validatePlugin(
  plugin: GboxPlugin,
): { valid: boolean; errors: string[] } {
  const errors: string[] = []

  // Required string fields
  if (!plugin.id || typeof plugin.id !== 'string') {
    errors.push('id is required and must be a string')
  } else if (!PLUGIN_ID_RE.test(plugin.id)) {
    errors.push(
      'id must be lowercase alphanumeric with dots, hyphens, underscores (2-128 chars)',
    )
  }

  if (!plugin.version || typeof plugin.version !== 'string') {
    errors.push('version is required and must be a string')
  } else if (!SEMVER_RE.test(plugin.version)) {
    errors.push('version must be a valid semver string (e.g. "1.0.0")')
  }

  if (!plugin.name || typeof plugin.name !== 'string') {
    errors.push('name is required and must be a string')
  } else if (plugin.name.length > 100) {
    errors.push('name must be 100 characters or fewer')
  }

  if (!plugin.description || typeof plugin.description !== 'string') {
    errors.push('description is required and must be a string')
  }

  if (!plugin.author || typeof plugin.author !== 'string') {
    errors.push('author is required and must be a string')
  }

  // Permissions
  if (!Array.isArray(plugin.permissions)) {
    errors.push('permissions must be an array')
  } else {
    for (const perm of plugin.permissions) {
      if (!VALID_PERMISSIONS.includes(perm)) {
        errors.push(`Unknown permission: "${perm}"`)
      }
    }
  }

  // Routes validation
  if (plugin.routes) {
    if (!Array.isArray(plugin.routes)) {
      errors.push('routes must be an array')
    } else {
      for (const route of plugin.routes) {
        if (!route.method || !route.path) {
          errors.push('Each route must have a method and path')
        }
        if (route.handler && typeof route.handler !== 'function') {
          errors.push(`Route handler for ${route.method} ${route.path} must be a function`)
        }
      }
    }
  }

  // Admin pages validation
  if (plugin.adminPages) {
    if (!Array.isArray(plugin.adminPages)) {
      errors.push('adminPages must be an array')
    } else {
      for (const page of plugin.adminPages) {
        if (!page.title || !page.path) {
          errors.push('Each admin page must have a title and path')
        }
        if (!page.render) {
          errors.push(`Admin page "${page.title}" must have a render property`)
        }
      }
    }
  }

  // Settings schema validation
  if (plugin.settingsSchema) {
    if (typeof plugin.settingsSchema !== 'object' || Array.isArray(plugin.settingsSchema)) {
      errors.push('settingsSchema must be a plain object')
    } else {
      for (const [key, field] of Object.entries(plugin.settingsSchema)) {
        if (!field.label) {
          errors.push(`Setting "${key}" must have a label`)
        }
        if (!field.type) {
          errors.push(`Setting "${key}" must have a type`)
        }
        if (field.type === 'select' && (!field.options || field.options.length === 0)) {
          errors.push(`Setting "${key}" is a select but has no options`)
        }
      }
    }
  }

  return { valid: errors.length === 0, errors }
}

// ---------------------------------------------------------------------------
// createPluginContext
// ---------------------------------------------------------------------------

/**
 * Create a runtime context for a plugin with scoped, permission-gated
 * access to platform APIs.
 *
 * This is called by the platform when executing plugin hooks or handling
 * plugin route requests. Plugin authors do not call this directly.
 */
export function createPluginContext(
  db: Kysely<Database>,
  shopId: string,
  pluginId: string,
  permissions: GboxPluginPermission[] = [],
  settings: Record<string, unknown> = {},
): GboxPluginContext {
  // Permission gate helper
  function requirePermission(perm: GboxPluginPermission, action: string): void {
    if (!permissions.includes(perm)) {
      throw new Error(
        `Plugin "${pluginId}" lacks permission "${perm}" required for ${action}`,
      )
    }
  }

  return {
    pluginId,
    shopId,
    settings: Object.freeze({ ...settings }),

    // -- Products -----------------------------------------------------------
    products: {
      async get(productId: string) {
        requirePermission('read_products', 'products.get')
        return db
          .selectFrom('products')
          .selectAll()
          .where('id', '=', productId)
          .where('shop_id', '=', shopId)
          .executeTakeFirst() ?? null
      },

      async list(filters: Record<string, unknown> = {}) {
        requirePermission('read_products', 'products.list')
        let query = db
          .selectFrom('products')
          .selectAll()
          .where('shop_id', '=', shopId)

        if (filters.status && typeof filters.status === 'string') {
          query = query.where('status', '=', filters.status)
        }

        return query
          .orderBy('created_at', 'desc')
          .limit(typeof filters.limit === 'number' ? filters.limit : 50)
          .execute()
      },

      async create(data: Record<string, unknown>) {
        requirePermission('write_products', 'products.create')
        return db
          .insertInto('products')
          .values({ shop_id: shopId, ...data } as any)
          .returningAll()
          .executeTakeFirstOrThrow()
      },

      async update(productId: string, data: Record<string, unknown>) {
        requirePermission('write_products', 'products.update')
        return db
          .updateTable('products')
          .set({ ...data, updated_at: new Date().toISOString() } as any)
          .where('id', '=', productId)
          .where('shop_id', '=', shopId)
          .returningAll()
          .executeTakeFirstOrThrow()
      },
    },

    // -- Orders -------------------------------------------------------------
    orders: {
      async get(orderId: string) {
        requirePermission('read_orders', 'orders.get')
        return db
          .selectFrom('orders')
          .selectAll()
          .where('id', '=', orderId)
          .where('shop_id', '=', shopId)
          .executeTakeFirst() ?? null
      },

      async list(filters: Record<string, unknown> = {}) {
        requirePermission('read_orders', 'orders.list')
        let query = db
          .selectFrom('orders')
          .selectAll()
          .where('shop_id', '=', shopId)

        if (filters.financial_status && typeof filters.financial_status === 'string') {
          query = query.where('financial_status', '=', filters.financial_status)
        }

        return query
          .orderBy('created_at', 'desc')
          .limit(typeof filters.limit === 'number' ? filters.limit : 50)
          .execute()
      },
    },

    // -- Customers ----------------------------------------------------------
    customers: {
      async get(customerId: string) {
        requirePermission('read_customers', 'customers.get')
        return db
          .selectFrom('customers')
          .selectAll()
          .where('id', '=', customerId)
          .where('shop_id', '=', shopId)
          .executeTakeFirst() ?? null
      },

      async list(filters: Record<string, unknown> = {}) {
        requirePermission('read_customers', 'customers.list')
        let query = db
          .selectFrom('customers')
          .selectAll()
          .where('shop_id', '=', shopId)

        if (filters.status && typeof filters.status === 'string') {
          query = query.where('status', '=', filters.status)
        }

        return query
          .orderBy('created_at', 'desc')
          .limit(typeof filters.limit === 'number' ? filters.limit : 50)
          .execute()
      },
    },

    // -- Notifications ------------------------------------------------------
    notifications: {
      async sendEmail(_to: string, _subject: string, _html: string) {
        requirePermission('send_notifications', 'notifications.sendEmail')
        // In a real implementation this would delegate to the email service.
        // For now, log and return.
        console.log(`[plugin:${pluginId}] sendEmail to ${_to}: ${_subject}`)
      },

      async createAdminNotification(title: string, message: string) {
        requirePermission('send_notifications', 'notifications.createAdminNotification')
        await db
          .insertInto('notifications')
          .values({
            shop_id: shopId,
            type: `plugin:${pluginId}`,
            title,
            message,
          })
          .execute()
      },
    },

    // -- Plugin-scoped storage ----------------------------------------------
    storage: {
      async get<T = unknown>(key: string): Promise<T | null> {
        const row = await db
          .selectFrom('shop_settings')
          .select('value')
          .where('shop_id', '=', shopId)
          .where('key', '=', `plugin:${pluginId}:${key}`)
          .executeTakeFirst()

        if (!row) return null
        return row.value as T
      },

      async set(key: string, value: unknown) {
        const fullKey = `plugin:${pluginId}:${key}`
        const jsonValue = JSON.stringify(value)

        // Upsert using insert + on conflict (Kysely)
        const existing = await db
          .selectFrom('shop_settings')
          .select('id')
          .where('shop_id', '=', shopId)
          .where('key', '=', fullKey)
          .executeTakeFirst()

        if (existing) {
          await db
            .updateTable('shop_settings')
            .set({ value: jsonValue, updated_at: new Date().toISOString() } as any)
            .where('id', '=', existing.id)
            .execute()
        } else {
          await db
            .insertInto('shop_settings')
            .values({
              shop_id: shopId,
              key: fullKey,
              value: jsonValue,
            } as any)
            .execute()
        }
      },

      async delete(key: string) {
        await db
          .deleteFrom('shop_settings')
          .where('shop_id', '=', shopId)
          .where('key', '=', `plugin:${pluginId}:${key}`)
          .execute()
      },

      async list(prefix = '') {
        const fullPrefix = `plugin:${pluginId}:${prefix}`
        const rows = await db
          .selectFrom('shop_settings')
          .select(['key', 'value'])
          .where('shop_id', '=', shopId)
          .where('key', 'like', `${fullPrefix}%`)
          .execute()

        return rows.map((r) => ({
          key: r.key.replace(`plugin:${pluginId}:`, ''),
          value: r.value,
        }))
      },
    },

    // -- Logger -------------------------------------------------------------
    logger: {
      info(message: string, data?: Record<string, unknown>) {
        console.log(`[plugin:${pluginId}] INFO: ${message}`, data ?? '')
      },
      warn(message: string, data?: Record<string, unknown>) {
        console.warn(`[plugin:${pluginId}] WARN: ${message}`, data ?? '')
      },
      error(message: string, data?: Record<string, unknown>) {
        console.error(`[plugin:${pluginId}] ERROR: ${message}`, data ?? '')
      },
    },
  }
}
