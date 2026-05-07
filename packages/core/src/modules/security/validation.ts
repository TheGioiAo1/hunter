/**
 * Security Module — Zod Validation Schemas
 *
 * Centralized input validation for all Gbox Platform API endpoints.
 * Every CRUD endpoint MUST validate through these schemas before touching the DB.
 */

import { z } from 'zod'
import type { Request, Response, NextFunction } from 'express'

// ---------------------------------------------------------------------------
// Primitives (reusable building blocks)
// ---------------------------------------------------------------------------

const trimStr = z.string().trim()
const email = trimStr.email('Invalid email format').toLowerCase()
const slug = trimStr.min(1).max(255).regex(/^[a-z0-9-]+$/, 'Slug must be lowercase alphanumeric with hyphens')
const uuid = z.string().uuid('Invalid UUID format')
const price = z.union([z.string(), z.number()])
  .refine(v => !isNaN(Number(v)) && Number(v) >= 0, { message: 'Price must be a non-negative number' })
  .transform(v => Number(v).toFixed(2))
const optionalPrice = price.optional().nullable()
const positiveInt = z.number().int().min(0)
const tags = z.array(z.string().trim().max(100)).max(50).optional().default([])
const safeHtml = z.string().max(100_000).optional().nullable() // body_html, descriptions
const shortText = trimStr.min(1).max(500)
const longText = trimStr.max(10_000).optional().nullable()
const phone = trimStr.max(30).optional().nullable()
const isoDate = z.string().datetime({ offset: true }).or(z.string().datetime())

// ---------------------------------------------------------------------------
// Product Schemas
// ---------------------------------------------------------------------------

const createProduct = z.object({
  title: trimStr.min(1, 'Title is required').max(500),
  body_html: safeHtml,
  description: z.string().max(10_000).optional().nullable(),
  vendor: trimStr.max(255).optional().nullable(),
  product_type: trimStr.max(255).optional().nullable(),
  status: z.enum(['active', 'draft', 'archived']).optional().default('draft'),
  tags,
  template_suffix: trimStr.max(255).optional().nullable(),
  price: optionalPrice,
  compare_at_price: optionalPrice,
  sku: trimStr.max(255).optional().nullable(),
}).strict()

const updateProduct = z.object({
  title: trimStr.min(1).max(500).optional(),
  body_html: safeHtml,
  description: z.string().max(10_000).optional().nullable(),
  vendor: trimStr.max(255).optional().nullable(),
  product_type: trimStr.max(255).optional().nullable(),
  status: z.enum(['active', 'draft', 'archived']).optional(),
  tags: tags.optional(),
  template_suffix: trimStr.max(255).optional().nullable(),
}).strict()

// ---------------------------------------------------------------------------
// Variant Schemas
// ---------------------------------------------------------------------------

const createVariant = z.object({
  title: trimStr.max(255).optional().default('Default Title'),
  price: price,
  compare_at_price: optionalPrice,
  cost: optionalPrice,
  sku: trimStr.max(255).optional().nullable(),
  barcode: trimStr.max(255).optional().nullable(),
  inventory_quantity: z.number().int().min(0).optional().default(0),
  weight: z.union([z.string(), z.number()]).transform(v => Number(v)).optional().nullable(),
  weight_unit: z.enum(['kg', 'g', 'lb', 'oz']).optional().default('kg'),
  option1: trimStr.max(255).optional().nullable(),
  option2: trimStr.max(255).optional().nullable(),
  option3: trimStr.max(255).optional().nullable(),
  requires_shipping: z.boolean().optional().default(true),
  taxable: z.boolean().optional().default(true),
}).strict()

const updateVariant = z.object({
  title: trimStr.max(255).optional(),
  price: price.optional(),
  compare_at_price: optionalPrice,
  cost: optionalPrice,
  sku: trimStr.max(255).optional().nullable(),
  barcode: trimStr.max(255).optional().nullable(),
  inventory_quantity: z.number().int().min(0).optional(),
  weight: z.union([z.string(), z.number()]).transform(v => Number(v)).optional().nullable(),
  weight_unit: z.enum(['kg', 'g', 'lb', 'oz']).optional(),
  option1: trimStr.max(255).optional().nullable(),
  option2: trimStr.max(255).optional().nullable(),
  option3: trimStr.max(255).optional().nullable(),
  image_url: z.string().url().max(2048).optional().nullable(),
  requires_shipping: z.boolean().optional(),
  taxable: z.boolean().optional(),
}).strict()

// ---------------------------------------------------------------------------
// Collection Schemas
// ---------------------------------------------------------------------------

const createCollection = z.object({
  title: trimStr.min(1, 'Title is required').max(500),
  body_html: safeHtml,
  description: z.string().max(10_000).optional().nullable(),
  image_url: z.string().url().max(2048).optional().nullable(),
  sort_order: z.enum(['alpha-asc', 'alpha-desc', 'best-selling', 'created', 'created-desc', 'manual', 'price-asc', 'price-desc']).optional().default('alpha-asc'),
  published: z.boolean().optional().default(false),
  collection_type: z.enum(['manual', 'automated']).optional().default('manual'),
  rules: z.any().optional().nullable(),
  template_suffix: trimStr.max(255).optional().nullable(),
}).strict()

const updateCollection = z.object({
  title: trimStr.min(1).max(500).optional(),
  body_html: safeHtml,
  description: z.string().max(10_000).optional().nullable(),
  image_url: z.string().url().max(2048).optional().nullable(),
  sort_order: z.enum(['alpha-asc', 'alpha-desc', 'best-selling', 'created', 'created-desc', 'manual', 'price-asc', 'price-desc']).optional(),
  published: z.boolean().optional(),
  rules: z.any().optional().nullable(),
  template_suffix: trimStr.max(255).optional().nullable(),
}).strict()

const addCollectionProduct = z.object({
  product_id: uuid,
}).strict()

// ---------------------------------------------------------------------------
// Discount Schemas
// ---------------------------------------------------------------------------

const createDiscount = z.object({
  title: trimStr.min(1, 'Title is required').max(500),
  code: trimStr.min(1, 'Code is required').max(50).transform(v => v.toUpperCase()),
  type: z.enum(['percentage', 'fixed_amount']),
  value: z.union([z.string(), z.number()])
    .refine(v => !isNaN(Number(v)) && Number(v) > 0, { message: 'Value must be positive' })
    .transform(v => Number(v)),
  value_type: z.enum(['percentage', 'fixed_amount']),
  applies_to: z.enum(['all', 'specific_products', 'specific_collections']).optional().default('all'),
  target_selection: z.any().optional().nullable(),
  minimum_requirement_type: z.enum(['none', 'minimum_amount', 'minimum_quantity']).optional().default('none'),
  minimum_requirement_value: z.union([z.string(), z.number()]).transform(v => Number(v)).optional().nullable(),
  usage_limit: z.number().int().min(0).optional().nullable(),
  once_per_customer: z.boolean().optional().default(false),
  starts_at: isoDate,
  ends_at: isoDate.optional().nullable(),
}).strict()

const updateDiscount = z.object({
  title: trimStr.min(1).max(500).optional(),
  code: trimStr.min(1).max(50).transform(v => v.toUpperCase()).optional(),
  type: z.enum(['percentage', 'fixed_amount']).optional(),
  value: z.union([z.string(), z.number()]).transform(v => Number(v)).optional(),
  value_type: z.enum(['percentage', 'fixed_amount']).optional(),
  applies_to: z.enum(['all', 'specific_products', 'specific_collections']).optional(),
  target_selection: z.any().optional().nullable(),
  minimum_requirement_type: z.enum(['none', 'minimum_amount', 'minimum_quantity']).optional(),
  minimum_requirement_value: z.union([z.string(), z.number()]).transform(v => Number(v)).optional().nullable(),
  usage_limit: z.number().int().min(0).optional().nullable(),
  once_per_customer: z.boolean().optional(),
  starts_at: isoDate.optional(),
  ends_at: isoDate.optional().nullable(),
}).strict()

const toggleDiscountStatus = z.object({
  status: z.enum(['active', 'expired', 'scheduled']),
}).strict()

// ---------------------------------------------------------------------------
// Inventory Schemas
// ---------------------------------------------------------------------------

const inventoryAdjust = z.object({
  variant_id: uuid,
  adjustment: z.number().int().min(-99999).max(99999),
  reason: trimStr.max(500).optional().nullable(),
}).strict()

const inventorySet = z.object({
  variant_id: uuid,
  quantity: z.number().int().min(0).max(9999999),
  reason: trimStr.max(500).optional().nullable(),
}).strict()

// ---------------------------------------------------------------------------
// Customer Schemas
// ---------------------------------------------------------------------------

const createCustomer = z.object({
  email: email,
  first_name: trimStr.min(1, 'First name is required').max(255),
  last_name: trimStr.max(255).optional().default(''),
  phone: phone,
  accepts_marketing: z.boolean().optional().default(false),
  tags,
  note: longText,
  tax_exempt: z.boolean().optional().default(false),
}).strict()

const updateCustomer = z.object({
  email: email.optional(),
  first_name: trimStr.min(1).max(255).optional(),
  last_name: trimStr.max(255).optional(),
  phone: phone,
  accepts_marketing: z.boolean().optional(),
  tags: tags.optional(),
  note: longText,
  tax_exempt: z.boolean().optional(),
  status: z.enum(['active', 'disabled', 'invited', 'declined']).optional(),
}).strict()

// ---------------------------------------------------------------------------
// Query Schemas (for GET endpoints with pagination/filters)
// ---------------------------------------------------------------------------

const paginationQuery = z.object({
  page: z.string().transform(v => Math.max(1, parseInt(v) || 1)).optional().default('1'),
  limit: z.string().transform(v => Math.min(250, Math.max(1, parseInt(v) || 50))).optional().default('50'),
  sort: trimStr.max(50).optional(),
  order: z.enum(['asc', 'desc']).optional().default('desc'),
}).passthrough()

const customerListQuery = paginationQuery.extend({
  search: trimStr.max(200).optional(),
  segment: z.enum(['all', 'repeat', 'high_value', 'new', 'at_risk', 'subscribers']).optional(),
  tag: trimStr.max(100).optional(),
})

const inventoryListQuery = paginationQuery.extend({
  search: trimStr.max(200).optional(),
  low_stock: z.string().transform(v => v === 'true').optional(),
})

// ---------------------------------------------------------------------------
// Store Settings Schema
// ---------------------------------------------------------------------------

const updateStoreSettings = z.object({
  name: trimStr.min(1).max(255).optional(),
  email: email.optional(),
  phone: phone,
  description: z.string().max(5000).optional().nullable(),
  currency: trimStr.min(3).max(3).toUpperCase().optional(),
  timezone: trimStr.max(100).optional(),
  weight_unit: z.enum(['kg', 'g', 'lb', 'oz']).optional(),
  address1: trimStr.max(500).optional().nullable(),
  address2: trimStr.max(500).optional().nullable(),
  city: trimStr.max(255).optional().nullable(),
  province: trimStr.max(255).optional().nullable(),
  zip: trimStr.max(20).optional().nullable(),
  country: trimStr.max(2).toUpperCase().optional().nullable(),
}).strict()

// ---------------------------------------------------------------------------
// Staff / Invite Schemas
// ---------------------------------------------------------------------------

const inviteStaff = z.object({
  email: email,
  role: z.enum(['admin', 'staff', 'limited']),
}).strict()

const updateStaffRole = z.object({
  role: z.enum(['admin', 'staff', 'limited']),
}).strict()

// ---------------------------------------------------------------------------
// Auth Schemas
// ---------------------------------------------------------------------------

const loginBody = z.object({
  email: email,
  password: z.string().min(1, 'Password is required').max(256),
  _csrf: z.string().optional(),
}).passthrough()

const signupBody = z.object({
  email: email,
  password: z.string().min(8, 'Password must be at least 8 characters').max(256),
  name: trimStr.min(1, 'Name is required').max(255),
  _csrf: z.string().optional(),
}).passthrough()

// ---------------------------------------------------------------------------
// Page Schemas (H.4 Security Audit — input validation for CMS endpoints)
// ---------------------------------------------------------------------------

const createPage = z.object({
  title: trimStr.min(1, 'Title is required').max(500),
  slug: slug,
  body_html: safeHtml,
  author: trimStr.max(255).optional().nullable(),
  template_suffix: trimStr.max(255).optional().nullable(),
  published: z.boolean().optional().default(false),
}).strict()

const updatePage = z.object({
  title: trimStr.min(1).max(500).optional(),
  slug: slug.optional(),
  body_html: safeHtml,
  author: trimStr.max(255).optional().nullable(),
  template_suffix: trimStr.max(255).optional().nullable(),
  published: z.boolean().optional(),
}).strict()

// ---------------------------------------------------------------------------
// Blog Post Schemas
// ---------------------------------------------------------------------------

const createBlogPost = z.object({
  title: trimStr.min(1, 'Title is required').max(500),
  slug: slug,
  body_html: safeHtml,
  excerpt: z.string().max(5000).optional().nullable(),
  author: trimStr.max(255).optional().nullable(),
  tags,
  image_url: z.string().url().max(2048).optional().nullable(),
  published: z.boolean().optional().default(false),
  published_at: isoDate.optional().nullable(),
}).strict()

const updateBlogPost = z.object({
  title: trimStr.min(1).max(500).optional(),
  slug: slug.optional(),
  body_html: safeHtml,
  excerpt: z.string().max(5000).optional().nullable(),
  author: trimStr.max(255).optional().nullable(),
  tags: tags.optional(),
  image_url: z.string().url().max(2048).optional().nullable(),
  published: z.boolean().optional(),
  published_at: isoDate.optional().nullable(),
}).strict()

// ---------------------------------------------------------------------------
// Menu Schemas
// ---------------------------------------------------------------------------

const createMenu = z.object({
  title: trimStr.min(1, 'Title is required').max(255),
  slug: slug,
}).strict()

const updateMenu = z.object({
  title: trimStr.min(1).max(255).optional(),
  slug: slug.optional(),
}).strict()

const createMenuItem = z.object({
  title: trimStr.min(1, 'Title is required').max(255),
  url: z.string().max(2048).optional().nullable(),
  resource_type: trimStr.max(50).optional().nullable(),
  resource_id: trimStr.max(255).optional().nullable(),
  parent_id: trimStr.max(255).optional().nullable(),
  position: z.number().int().min(0).optional(),
}).strict()

// ---------------------------------------------------------------------------
// Gift Card Schemas
// ---------------------------------------------------------------------------

const createGiftCard = z.object({
  initial_value: price,
  code: trimStr.min(4).max(64).optional(),
  currency: trimStr.min(3).max(3).toUpperCase().optional().default('USD'),
  customer_id: uuid.optional().nullable(),
  note: longText,
  expires_at: isoDate.optional().nullable(),
}).strict()

// ---------------------------------------------------------------------------
// Review Schemas (public endpoint — extra important to validate)
// ---------------------------------------------------------------------------

const createReview = z.object({
  customer_id: uuid.optional().nullable(),
  author_name: trimStr.min(1, 'Author name is required').max(255),
  author_email: email,
  rating: z.union([z.string(), z.number()])
    .transform(v => Number(v))
    .refine(v => Number.isInteger(v) && v >= 1 && v <= 5, { message: 'Rating must be 1-5' }),
  title: trimStr.max(500).optional().nullable(),
  body: trimStr.min(1, 'Review body is required').max(10_000),
}).strict()

// ---------------------------------------------------------------------------
// Notification Schemas
// ---------------------------------------------------------------------------

const sendNotification = z.object({
  shop_id: uuid,
  type: z.enum(['system', 'order', 'product', 'marketing', 'billing']).optional().default('system'),
  title: trimStr.min(1, 'Title is required').max(500),
  message: z.string().max(5000).optional().nullable(),
  user_id: uuid.optional().nullable(),
}).strict()

const broadcastNotification = z.object({
  type: z.enum(['system', 'order', 'product', 'marketing', 'billing']).optional().default('system'),
  title: trimStr.min(1, 'Title is required').max(500),
  message: z.string().max(5000).optional().nullable(),
}).strict()

// ---------------------------------------------------------------------------
// File Schemas
// ---------------------------------------------------------------------------

const createFile = z.object({
  filename: trimStr.min(1).max(500),
  mime_type: trimStr.max(100).optional().nullable(),
  size: z.number().int().min(0).optional().nullable(),
  url: z.string().url().max(2048),
  alt: z.string().max(500).optional().nullable(),
}).strict()

// ---------------------------------------------------------------------------
// Export all schemas
// ---------------------------------------------------------------------------

export const schemas = {
  // Products
  createProduct,
  updateProduct,
  // Variants
  createVariant,
  updateVariant,
  // Collections
  createCollection,
  updateCollection,
  addCollectionProduct,
  // Discounts
  createDiscount,
  updateDiscount,
  toggleDiscountStatus,
  // Inventory
  inventoryAdjust,
  inventorySet,
  // Customers
  createCustomer,
  updateCustomer,
  // Queries
  paginationQuery,
  customerListQuery,
  inventoryListQuery,
  // Settings
  updateStoreSettings,
  // Staff
  inviteStaff,
  updateStaffRole,
  // Auth
  loginBody,
  signupBody,
  // Pages (H.4)
  createPage,
  updatePage,
  // Blog posts (H.4)
  createBlogPost,
  updateBlogPost,
  // Menus (H.4)
  createMenu,
  updateMenu,
  createMenuItem,
  // Gift cards (H.4)
  createGiftCard,
  // Reviews (H.4)
  createReview,
  // Notifications (H.4)
  sendNotification,
  broadcastNotification,
  // Files (H.4)
  createFile,
  // Primitives (for ad-hoc use)
  uuid,
  email,
  slug,
} as const

// ---------------------------------------------------------------------------
// Validation middleware factory
// ---------------------------------------------------------------------------

/**
 * Express middleware that validates req.body against a Zod schema.
 * On failure: returns 400 with structured error details.
 * On success: replaces req.body with sanitized/parsed data.
 *
 * Usage: app.post('/api/...', validate(schemas.createProduct), handler)
 */
export function validate<T extends z.ZodTypeAny>(schema: T) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body)
    if (!result.success) {
      const errors = result.error.issues.map(issue => ({
        field: issue.path.join('.'),
        message: issue.message,
        code: issue.code,
      }))
      res.status(400).json({
        error: 'Validation error',
        message: errors[0]?.message || 'Invalid input',
        details: errors,
      })
      return
    }
    // Replace body with validated & sanitized data
    req.body = result.data
    next()
  }
}

/**
 * Validate query parameters.
 * Usage: app.get('/api/...', validateQuery(schemas.customerListQuery), handler)
 */
export function validateQuery<T extends z.ZodTypeAny>(schema: T) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.query)
    if (!result.success) {
      const errors = result.error.issues.map(issue => ({
        field: issue.path.join('.'),
        message: issue.message,
      }))
      res.status(400).json({
        error: 'Validation error',
        message: errors[0]?.message || 'Invalid query parameters',
        details: errors,
      })
      return
    }
    ;(req as any).validatedQuery = result.data
    next()
  }
}

// ---------------------------------------------------------------------------
// Sanitize helpers
// ---------------------------------------------------------------------------

export const sanitize = {
  /** Strip HTML tags (basic XSS prevention for text fields) */
  stripTags(s: string): string {
    return s.replace(/<[^>]*>/g, '')
  },

  /** Escape HTML entities */
  escapeHtml(s: string): string {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#x27;')
  },

  /** Normalize email: lowercase + trim */
  normalizeEmail(e: string): string {
    return e.trim().toLowerCase()
  },

  /** Ensure string is safe for use in SQL LIKE patterns */
  escapeLike(s: string): string {
    return s.replace(/%/g, '\\%').replace(/_/g, '\\_')
  },

  /** Truncate string to max length */
  truncate(s: string, max: number): string {
    return s.length > max ? s.slice(0, max) : s
  },
}
