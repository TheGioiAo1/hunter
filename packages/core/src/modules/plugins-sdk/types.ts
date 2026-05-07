/**
 * Gbox Platform — Plugin SDK Type Definitions
 *
 * Type definitions for third-party plugin developers to build
 * extensions for the Gbox e-commerce platform.
 */

// ---------------------------------------------------------------------------
// Core plugin definition
// ---------------------------------------------------------------------------

/**
 * Top-level plugin configuration. Every Gbox plugin must export an
 * object satisfying this interface (typically via `defineGboxPlugin()`).
 */
export interface GboxPlugin {
  /** Unique identifier (reverse-DNS recommended, e.g. "com.acme.loyalty"). */
  id: string

  /** Semantic version string (e.g. "1.2.0"). */
  version: string

  /** Human-readable display name. */
  name: string

  /** Short description shown in the plugin marketplace. */
  description: string

  /** Author / organization name. */
  author: string

  /** Permissions the plugin requires from the platform. */
  permissions: GboxPluginPermission[]

  /** Lifecycle and data hooks the plugin listens to. */
  hooks?: GboxPluginHooks

  /** Custom API routes the plugin registers. */
  routes?: GboxPluginRoute[]

  /** Admin dashboard pages the plugin adds. */
  adminPages?: GboxPluginAdminPage[]

  /** Settings schema for the plugin configuration UI. */
  settingsSchema?: Record<string, GboxPluginSettingField>
}

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

/**
 * Granular permissions a plugin can request. The shop owner must
 * approve these during installation.
 */
export type GboxPluginPermission =
  | 'read_products'
  | 'write_products'
  | 'read_orders'
  | 'write_orders'
  | 'read_customers'
  | 'write_customers'
  | 'read_inventory'
  | 'write_inventory'
  | 'read_content'
  | 'write_content'
  | 'read_discounts'
  | 'write_discounts'
  | 'read_shipping'
  | 'write_shipping'
  | 'read_analytics'
  | 'read_shop'
  | 'write_shop_settings'
  | 'send_notifications'
  | 'manage_webhooks'

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/**
 * Plugin hooks for reacting to platform events. Each hook receives a
 * `GboxPluginContext` and event-specific payload.
 */
export interface GboxPluginHooks {
  /** Called once when the plugin is installed on a shop. */
  onInstall?: (ctx: GboxPluginContext) => Promise<void>

  /** Called once when the plugin is uninstalled. */
  onUninstall?: (ctx: GboxPluginContext) => Promise<void>

  /** Called when plugin settings are saved. */
  onSettingsUpdate?: (ctx: GboxPluginContext, settings: Record<string, unknown>) => Promise<void>

  // -- Product hooks --------------------------------------------------------

  /** Fired after a product is created. */
  onProductCreated?: (ctx: GboxPluginContext, payload: ProductEventPayload) => Promise<void>

  /** Fired after a product is updated. */
  onProductUpdated?: (ctx: GboxPluginContext, payload: ProductEventPayload) => Promise<void>

  /** Fired after a product is deleted / archived. */
  onProductDeleted?: (ctx: GboxPluginContext, payload: { productId: string }) => Promise<void>

  // -- Order hooks ----------------------------------------------------------

  /** Fired after a new order is placed. */
  onOrderCreated?: (ctx: GboxPluginContext, payload: OrderEventPayload) => Promise<void>

  /** Fired after an order is updated (status change, etc.). */
  onOrderUpdated?: (ctx: GboxPluginContext, payload: OrderEventPayload) => Promise<void>

  /** Fired after an order is fulfilled. */
  onOrderFulfilled?: (ctx: GboxPluginContext, payload: OrderEventPayload) => Promise<void>

  /** Fired after an order is cancelled. */
  onOrderCancelled?: (ctx: GboxPluginContext, payload: OrderEventPayload) => Promise<void>

  // -- Customer hooks -------------------------------------------------------

  /** Fired after a customer record is created. */
  onCustomerCreated?: (ctx: GboxPluginContext, payload: CustomerEventPayload) => Promise<void>

  /** Fired after a customer record is updated. */
  onCustomerUpdated?: (ctx: GboxPluginContext, payload: CustomerEventPayload) => Promise<void>

  // -- Checkout hooks -------------------------------------------------------

  /** Fired before checkout is finalized — can modify or reject. */
  onCheckoutBeforeComplete?: (
    ctx: GboxPluginContext,
    payload: CheckoutEventPayload,
  ) => Promise<CheckoutHookResult>

  /** Fired after checkout completes successfully. */
  onCheckoutCompleted?: (ctx: GboxPluginContext, payload: CheckoutEventPayload) => Promise<void>
}

// ---------------------------------------------------------------------------
// Hook event payloads
// ---------------------------------------------------------------------------

/** Payload for product-related hooks. */
export interface ProductEventPayload {
  productId: string
  shopId: string
  title: string
  status: string
}

/** Payload for order-related hooks. */
export interface OrderEventPayload {
  orderId: string
  shopId: string
  orderNumber: number
  customerId: string | null
  financialStatus: string
  fulfillmentStatus: string
  totalPrice: string
  currency: string
}

/** Payload for customer-related hooks. */
export interface CustomerEventPayload {
  customerId: string
  shopId: string
  email: string | null
  firstName: string | null
  lastName: string | null
}

/** Payload for checkout-related hooks. */
export interface CheckoutEventPayload {
  checkoutId: string
  shopId: string
  customerId: string | null
  lineItems: Array<{
    productId: string
    variantId: string
    quantity: number
    price: string
  }>
  subtotal: string
  currency: string
}

/** Result from the before-checkout hook. */
export interface CheckoutHookResult {
  /** Set to false to reject the checkout. */
  allowed: boolean
  /** User-facing message if rejected. */
  message?: string
  /** Optional line-item modifications (e.g. loyalty discount). */
  modifications?: {
    discountAmount?: string
    discountReason?: string
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/** HTTP method for plugin routes. */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

/**
 * A custom API route registered by the plugin. Routes are mounted
 * under `/api/plugins/{pluginId}/...`.
 */
export interface GboxPluginRoute {
  /** HTTP method. */
  method: HttpMethod

  /** Path relative to the plugin's route namespace (e.g. "/loyalty/balance"). */
  path: string

  /** Human-readable description for API documentation. */
  description?: string

  /** Whether the route requires authentication (default true). */
  requiresAuth?: boolean

  /** The handler function. */
  handler: (ctx: GboxPluginContext, request: Request) => Promise<Response>
}

// ---------------------------------------------------------------------------
// Admin pages
// ---------------------------------------------------------------------------

/**
 * An admin dashboard page contributed by the plugin. Rendered inside the
 * Gbox admin shell via an iframe or embedded component.
 */
export interface GboxPluginAdminPage {
  /** Navigation label. */
  title: string

  /** Path under the admin area (e.g. "/loyalty"). */
  path: string

  /** Icon name from the platform icon set (optional). */
  icon?: string

  /** Position in the sidebar: 'main' | 'settings'. */
  navSection?: 'main' | 'settings'

  /**
   * The component or URL to render. When a string URL, the admin shell
   * loads it in an iframe. When a function, it receives the plugin context.
   */
  render: string | ((ctx: GboxPluginContext) => Promise<string>)
}

// ---------------------------------------------------------------------------
// Settings schema
// ---------------------------------------------------------------------------

/** Supported setting field types. */
export type GboxPluginSettingFieldType =
  | 'text'
  | 'number'
  | 'boolean'
  | 'select'
  | 'textarea'
  | 'color'
  | 'url'
  | 'email'
  | 'password'

/**
 * Schema for a single plugin setting field. The admin UI auto-generates
 * a form from these definitions.
 */
export interface GboxPluginSettingField {
  /** Display label. */
  label: string

  /** Field type controlling the input widget. */
  type: GboxPluginSettingFieldType

  /** Help text shown below the input. */
  description?: string

  /** Default value when the setting has not been configured. */
  default?: unknown

  /** Whether a value is required before the plugin can activate. */
  required?: boolean

  /** Placeholder text for text-based inputs. */
  placeholder?: string

  /** Options for 'select' type fields. */
  options?: Array<{ label: string; value: string }>

  /** Validation constraints. */
  validation?: {
    min?: number
    max?: number
    pattern?: string
    patternMessage?: string
  }
}

// ---------------------------------------------------------------------------
// Plugin context (runtime)
// ---------------------------------------------------------------------------

/**
 * Runtime context provided to plugin hooks, routes, and admin pages.
 * Gives scoped access to platform APIs within the plugin's permission set.
 */
export interface GboxPluginContext {
  /** The plugin's unique ID. */
  pluginId: string

  /** The shop this plugin instance is running for. */
  shopId: string

  /** Plugin's persisted settings (read-only here; see `settings.update`). */
  settings: Record<string, unknown>

  /** Scoped product operations (requires read_products / write_products). */
  products: {
    get: (productId: string) => Promise<unknown>
    list: (filters?: Record<string, unknown>) => Promise<unknown[]>
    create: (data: Record<string, unknown>) => Promise<unknown>
    update: (productId: string, data: Record<string, unknown>) => Promise<unknown>
  }

  /** Scoped order operations (requires read_orders / write_orders). */
  orders: {
    get: (orderId: string) => Promise<unknown>
    list: (filters?: Record<string, unknown>) => Promise<unknown[]>
  }

  /** Scoped customer operations (requires read_customers / write_customers). */
  customers: {
    get: (customerId: string) => Promise<unknown>
    list: (filters?: Record<string, unknown>) => Promise<unknown[]>
  }

  /** Send notifications (requires send_notifications). */
  notifications: {
    sendEmail: (to: string, subject: string, html: string) => Promise<void>
    createAdminNotification: (title: string, message: string) => Promise<void>
  }

  /** Plugin-scoped key-value storage for persisting arbitrary data. */
  storage: {
    get: <T = unknown>(key: string) => Promise<T | null>
    set: (key: string, value: unknown) => Promise<void>
    delete: (key: string) => Promise<void>
    list: (prefix?: string) => Promise<Array<{ key: string; value: unknown }>>
  }

  /** Structured logger that tags output with the plugin ID. */
  logger: {
    info: (message: string, data?: Record<string, unknown>) => void
    warn: (message: string, data?: Record<string, unknown>) => void
    error: (message: string, data?: Record<string, unknown>) => void
  }
}
