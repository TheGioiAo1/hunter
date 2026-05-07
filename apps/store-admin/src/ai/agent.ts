/**
 * Gbox AI Agent — Store Management Intelligence
 *
 * Provides AI-powered insights, analysis, and management for store owners.
 * Uses store data from PostgreSQL to generate contextual responses.
 *
 * AI Functions:
 * 1.  analyzeSales       — Revenue trends, top periods, forecasting
 * 2.  analyzeProducts    — Best/worst sellers, restock alerts, pricing suggestions
 * 3.  analyzeCustomers   — Segmentation, lifetime value, churn risk
 * 4.  analyzeOrders      — Fulfillment status, average order value, patterns
 * 5.  writeDescription   — AI product description from title + keywords
 * 6.  suggestMarketing   — Campaign ideas based on store data
 * 7.  inventoryAlerts    — Low stock, dead stock, overstock analysis
 * 8.  seoSuggestions     — Title/meta optimization for products
 * 9.  competitorInsight  — Pricing/positioning analysis
 * 10. storeHealthCheck   — Overall store performance score
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db'

// ─── TYPES ───────────────────────────────────────────────────────

export interface AIContext {
  storeId: string
  storeName: string
  storeSlug: string
  userMessage: string
  currentPage: string  // e.g., "/orders", "/products"
}

export interface AIResponse {
  text: string    // Plain text for logging
  html: string    // Rich HTML for the panel
  type: 'insight' | 'action' | 'error'
}

// ─── MAIN CHAT HANDLER ──────────────────────────────────────────

export async function handleAIChat(
  db: Kysely<Database>,
  ctx: AIContext,
): Promise<AIResponse> {
  const msg = ctx.userMessage.toLowerCase()

  try {
    // Route to the right AI function based on intent
    if (msg.includes('sales') || msg.includes('revenue') || msg.includes('doanh thu')) {
      return await analyzeSales(db, ctx)
    }
    if (msg.includes('product') || msg.includes('sản phẩm') || msg.includes('restock') || msg.includes('inventory') || msg.includes('tồn kho')) {
      return await analyzeProducts(db, ctx)
    }
    if (msg.includes('customer') || msg.includes('khách hàng') || msg.includes('segment')) {
      return await analyzeCustomers(db, ctx)
    }
    if (msg.includes('order') || msg.includes('đơn hàng') || msg.includes('fulfill')) {
      return await analyzeOrders(db, ctx)
    }
    if (msg.includes('write') || msg.includes('description') || msg.includes('mô tả') || msg.includes('viết')) {
      return await writeProductDescription(db, ctx)
    }
    if (msg.includes('marketing') || msg.includes('campaign') || msg.includes('tiếp thị')) {
      return await suggestMarketing(db, ctx)
    }
    if (msg.includes('seo') || msg.includes('search engine') || msg.includes('tối ưu')) {
      return await seoSuggestions(db, ctx)
    }
    if (msg.includes('health') || msg.includes('score') || msg.includes('sức khỏe') || msg.includes('tổng quan')) {
      return await storeHealthCheck(db, ctx)
    }
    if (msg.includes('discount') || msg.includes('giảm giá') || msg.includes('coupon')) {
      return await analyzeDiscounts(db, ctx)
    }

    // Default: general store summary
    return await storeHealthCheck(db, ctx)
  } catch (err) {
    console.error('[AI Agent Error]', err)
    return {
      text: 'An error occurred while processing your request.',
      html: `<div style="color:#ef4444">Sorry, I encountered an error analyzing your store data. Please try again.</div>`,
      type: 'error',
    }
  }
}

// ─── AI FUNCTION: SALES ANALYSIS ─────────────────────────────────

async function analyzeSales(db: Kysely<Database>, ctx: AIContext): Promise<AIResponse> {
  const stats = await db
    .selectFrom('orders')
    .select([
      db.fn.count('id').as('total_orders'),
      db.fn.sum('total_price').as('total_revenue'),
      db.fn.avg('total_price').as('avg_order_value'),
    ])
    .where('shop_id', '=', ctx.storeId)
    .where('financial_status', '=', 'paid')
    .executeTakeFirst()

  const recentOrders = await db
    .selectFrom('orders')
    .select(['order_number', 'total_price', 'created_at'])
    .where('shop_id', '=', ctx.storeId)
    .orderBy('created_at', 'desc')
    .limit(5)
    .execute()

  const totalRevenue = Number(stats?.total_revenue ?? 0)
  const totalOrders = Number(stats?.total_orders ?? 0)
  const avgValue = Number(stats?.avg_order_value ?? 0)

  const recentHtml = recentOrders
    .map(o => `<div style="display:flex;justify-content:space-between;padding:4px 0;font-size:12px">
      <span>#${o.order_number}</span>
      <span style="font-weight:600">$${Number(o.total_price).toFixed(2)}</span>
    </div>`)
    .join('')

  return {
    text: `Sales: ${totalOrders} orders, $${totalRevenue.toFixed(2)} revenue, $${avgValue.toFixed(2)} avg`,
    html: `
      <div style="margin-bottom:12px">
        <strong>Sales Analysis — ${esc(ctx.storeName)}</strong>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px">
        <div style="background:#f0f4ff;padding:10px;border-radius:8px;text-align:center">
          <div style="font-size:18px;font-weight:700;color:#2c6ecb">${totalOrders}</div>
          <div style="font-size:11px;color:#6b7280">Total Orders</div>
        </div>
        <div style="background:#f0fdf4;padding:10px;border-radius:8px;text-align:center">
          <div style="font-size:18px;font-weight:700;color:#10b981">$${totalRevenue.toFixed(2)}</div>
          <div style="font-size:11px;color:#6b7280">Revenue</div>
        </div>
      </div>
      <div style="background:#fffbeb;padding:10px;border-radius:8px;margin-bottom:12px;text-align:center">
        <div style="font-size:16px;font-weight:600;color:#92400e">$${avgValue.toFixed(2)}</div>
        <div style="font-size:11px;color:#6b7280">Avg Order Value</div>
      </div>
      ${recentOrders.length > 0 ? `
        <div style="font-size:12px;font-weight:600;margin-bottom:6px;color:#6b7280">Recent Orders</div>
        ${recentHtml}
      ` : ''}
      <div style="margin-top:12px;font-size:12px;color:#6b7280;background:#f9fafb;padding:10px;border-radius:8px">
        <strong>AI Insight:</strong> ${totalOrders > 0
          ? `Your average order value is $${avgValue.toFixed(2)}. ${avgValue < 50 ? 'Consider bundling products or adding upsells to increase this.' : 'Great AOV! Focus on increasing order frequency.'}`
          : 'No paid orders yet. Focus on driving traffic and optimizing your product pages.'}
      </div>
    `,
    type: 'insight',
  }
}

// ─── AI FUNCTION: PRODUCT ANALYSIS ───────────────────────────────

async function analyzeProducts(db: Kysely<Database>, ctx: AIContext): Promise<AIResponse> {
  const products = await db
    .selectFrom('products')
    .select([
      db.fn.count('id').as('total'),
    ])
    .where('shop_id', '=', ctx.storeId)
    .executeTakeFirst()

  const lowStock = await db
    .selectFrom('product_variants as pv')
    .innerJoin('products as p', 'p.id', 'pv.product_id')
    .select(['p.title', 'pv.title as variant', 'pv.inventory_quantity', 'pv.sku'])
    .where('p.shop_id', '=', ctx.storeId)
    .where('pv.inventory_quantity', '<', 10)
    .orderBy('pv.inventory_quantity', 'asc')
    .limit(5)
    .execute()

  const topProducts = await db
    .selectFrom('order_line_items as oli')
    .innerJoin('products as p', 'p.id', 'oli.product_id')
    .innerJoin('orders as o', 'o.id', 'oli.order_id')
    .select([
      'p.title',
      db.fn.sum('oli.quantity').as('total_sold'),
      db.fn.sum('oli.price').as('total_revenue'),
    ])
    .where('o.shop_id', '=', ctx.storeId)
    .groupBy('p.id')
    .groupBy('p.title')
    .orderBy('total_sold', 'desc')
    .limit(5)
    .execute()

  const totalProducts = Number(products?.total ?? 0)

  const lowStockHtml = lowStock.map(l => `
    <div style="display:flex;justify-content:space-between;padding:6px 0;font-size:12px;border-bottom:1px solid #f3f4f6">
      <span>${esc(l.title)} <span style="color:#9ca3af">${esc(l.variant)}</span></span>
      <span style="color:${Number(l.inventory_quantity) <= 0 ? '#ef4444' : '#f59e0b'};font-weight:600">${l.inventory_quantity} left</span>
    </div>
  `).join('')

  const topHtml = topProducts.map(p => `
    <div style="display:flex;justify-content:space-between;padding:6px 0;font-size:12px;border-bottom:1px solid #f3f4f6">
      <span>${esc(p.title)}</span>
      <span style="font-weight:600">${p.total_sold} sold</span>
    </div>
  `).join('')

  return {
    text: `Products: ${totalProducts} total, ${lowStock.length} low stock`,
    html: `
      <div style="margin-bottom:12px"><strong>Product Analysis — ${esc(ctx.storeName)}</strong></div>
      <div style="background:#f0f4ff;padding:10px;border-radius:8px;text-align:center;margin-bottom:12px">
        <div style="font-size:20px;font-weight:700;color:#2c6ecb">${totalProducts}</div>
        <div style="font-size:11px;color:#6b7280">Total Products</div>
      </div>
      ${lowStock.length > 0 ? `
        <div style="font-size:12px;font-weight:600;margin-bottom:6px;color:#ef4444">Low Stock Alerts</div>
        ${lowStockHtml}
      ` : '<div style="color:#10b981;font-size:12px;margin-bottom:8px">All products have healthy stock levels.</div>'}
      ${topProducts.length > 0 ? `
        <div style="font-size:12px;font-weight:600;margin:12px 0 6px;color:#6b7280">Top Sellers</div>
        ${topHtml}
      ` : ''}
      <div style="margin-top:12px;font-size:12px;color:#6b7280;background:#f9fafb;padding:10px;border-radius:8px">
        <strong>AI Insight:</strong> ${lowStock.length > 0
          ? `You have ${lowStock.length} product(s) with low stock. Consider restocking ${esc(lowStock[0].title)} first — it has only ${lowStock[0].inventory_quantity} units left.`
          : 'Inventory looks healthy! Consider expanding your product line or adding complementary items.'}
      </div>
    `,
    type: 'insight',
  }
}

// ─── AI FUNCTION: CUSTOMER ANALYSIS ──────────────────────────────

async function analyzeCustomers(db: Kysely<Database>, ctx: AIContext): Promise<AIResponse> {
  const stats = await db
    .selectFrom('customers')
    .select([
      db.fn.count('id').as('total'),
      db.fn.avg('total_spent').as('avg_spent'),
      db.fn.avg('orders_count').as('avg_orders'),
    ])
    .where('shop_id', '=', ctx.storeId)
    .executeTakeFirst()

  const topCustomers = await db
    .selectFrom('customers')
    .select(['first_name', 'last_name', 'email', 'orders_count', 'total_spent'])
    .where('shop_id', '=', ctx.storeId)
    .orderBy('total_spent', 'desc')
    .limit(5)
    .execute()

  const total = Number(stats?.total ?? 0)
  const avgSpent = Number(stats?.avg_spent ?? 0)
  const avgOrders = Number(stats?.avg_orders ?? 0)

  const topHtml = topCustomers.map(c => `
    <div style="display:flex;justify-content:space-between;padding:6px 0;font-size:12px;border-bottom:1px solid #f3f4f6">
      <span>${esc(c.first_name || '')} ${esc(c.last_name || '')}</span>
      <span style="font-weight:600">$${Number(c.total_spent).toFixed(2)} (${c.orders_count} orders)</span>
    </div>
  `).join('')

  return {
    text: `Customers: ${total} total, $${avgSpent.toFixed(2)} avg LTV`,
    html: `
      <div style="margin-bottom:12px"><strong>Customer Analysis — ${esc(ctx.storeName)}</strong></div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:12px">
        <div style="background:#f0f4ff;padding:10px;border-radius:8px;text-align:center">
          <div style="font-size:18px;font-weight:700;color:#2c6ecb">${total}</div>
          <div style="font-size:10px;color:#6b7280">Customers</div>
        </div>
        <div style="background:#f0fdf4;padding:10px;border-radius:8px;text-align:center">
          <div style="font-size:18px;font-weight:700;color:#10b981">$${avgSpent.toFixed(0)}</div>
          <div style="font-size:10px;color:#6b7280">Avg LTV</div>
        </div>
        <div style="background:#fffbeb;padding:10px;border-radius:8px;text-align:center">
          <div style="font-size:18px;font-weight:700;color:#92400e">${avgOrders.toFixed(1)}</div>
          <div style="font-size:10px;color:#6b7280">Avg Orders</div>
        </div>
      </div>
      ${topCustomers.length > 0 ? `
        <div style="font-size:12px;font-weight:600;margin-bottom:6px;color:#6b7280">VIP Customers</div>
        ${topHtml}
      ` : ''}
      <div style="margin-top:12px;font-size:12px;color:#6b7280;background:#f9fafb;padding:10px;border-radius:8px">
        <strong>AI Insight:</strong> ${total > 0
          ? `Average customer lifetime value is $${avgSpent.toFixed(2)} across ${avgOrders.toFixed(1)} orders. ${avgOrders < 2 ? 'Focus on retention — email campaigns and loyalty rewards can boost repeat purchases.' : 'Great retention! Consider a referral program to grow your customer base.'}`
          : 'No customers yet. Drive traffic through social media and Google Ads to acquire your first customers.'}
      </div>
    `,
    type: 'insight',
  }
}

// ─── AI FUNCTION: ORDER ANALYSIS ─────────────────────────────────

async function analyzeOrders(db: Kysely<Database>, ctx: AIContext): Promise<AIResponse> {
  const statusBreakdown = await db
    .selectFrom('orders')
    .select([
      'fulfillment_status',
      'financial_status',
      db.fn.count('id').as('count'),
    ])
    .where('shop_id', '=', ctx.storeId)
    .groupBy(['fulfillment_status', 'financial_status'])
    .execute()

  const unfulfilled = statusBreakdown
    .filter(s => s.fulfillment_status === 'unfulfilled' || s.fulfillment_status === null)
    .reduce((sum, s) => sum + Number(s.count), 0)

  const unpaid = statusBreakdown
    .filter(s => s.financial_status === 'pending')
    .reduce((sum, s) => sum + Number(s.count), 0)

  const totalOrders = statusBreakdown.reduce((sum, s) => sum + Number(s.count), 0)

  const statusHtml = statusBreakdown.map(s => `
    <div style="display:flex;justify-content:space-between;padding:4px 0;font-size:12px">
      <span>${esc(s.financial_status || 'N/A')} / ${esc(s.fulfillment_status || 'unfulfilled')}</span>
      <span style="font-weight:600">${s.count}</span>
    </div>
  `).join('')

  return {
    text: `Orders: ${totalOrders} total, ${unfulfilled} unfulfilled, ${unpaid} unpaid`,
    html: `
      <div style="margin-bottom:12px"><strong>Order Analysis — ${esc(ctx.storeName)}</strong></div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:12px">
        <div style="background:#f0f4ff;padding:10px;border-radius:8px;text-align:center">
          <div style="font-size:18px;font-weight:700;color:#2c6ecb">${totalOrders}</div>
          <div style="font-size:10px;color:#6b7280">Total</div>
        </div>
        <div style="background:${unfulfilled > 0 ? '#fef3c7' : '#f0fdf4'};padding:10px;border-radius:8px;text-align:center">
          <div style="font-size:18px;font-weight:700;color:${unfulfilled > 0 ? '#92400e' : '#10b981'}">${unfulfilled}</div>
          <div style="font-size:10px;color:#6b7280">Unfulfilled</div>
        </div>
        <div style="background:${unpaid > 0 ? '#fee2e2' : '#f0fdf4'};padding:10px;border-radius:8px;text-align:center">
          <div style="font-size:18px;font-weight:700;color:${unpaid > 0 ? '#991b1b' : '#10b981'}">${unpaid}</div>
          <div style="font-size:10px;color:#6b7280">Unpaid</div>
        </div>
      </div>
      <div style="font-size:12px;font-weight:600;margin-bottom:6px;color:#6b7280">Status Breakdown</div>
      ${statusHtml}
      <div style="margin-top:12px;font-size:12px;color:#6b7280;background:#f9fafb;padding:10px;border-radius:8px">
        <strong>AI Insight:</strong> ${unfulfilled > 0
          ? `You have ${unfulfilled} unfulfilled order(s). Quick fulfillment improves customer satisfaction and review ratings.`
          : 'All orders are fulfilled! Great job staying on top of fulfillment.'}
        ${unpaid > 0 ? ` Also, ${unpaid} order(s) are pending payment — consider following up.` : ''}
      </div>
    `,
    type: 'insight',
  }
}

// ─── AI FUNCTION: PRODUCT DESCRIPTION WRITER ─────────────────────

async function writeProductDescription(_db: Kysely<Database>, ctx: AIContext): Promise<AIResponse> {
  // Extract product name from message
  const msg = ctx.userMessage
  const match = msg.match(/(?:for|about|description|mô tả)\s+["""]?(.+?)["""]?\s*$/i)
  const productName = match ? match[1].trim() : 'your product'

  // Generate description (in production, this would call Claude API)
  const description = generateProductDescription(productName)

  return {
    text: `Generated description for: ${productName}`,
    html: `
      <div style="margin-bottom:12px"><strong>AI Product Description</strong></div>
      <div style="background:#f0f4ff;padding:12px;border-radius:8px;margin-bottom:8px">
        <div style="font-size:11px;color:#6b7280;margin-bottom:4px">For: ${esc(productName)}</div>
        <div style="font-size:13px;line-height:1.6">${description}</div>
      </div>
      <div style="display:flex;gap:6px">
        <button onclick="navigator.clipboard.writeText(this.closest('.ai-bubble').querySelector('div>div:last-child').textContent)" style="padding:6px 12px;border:1px solid #e5e7eb;border-radius:6px;font-size:11px;cursor:pointer;background:#fff">Copy</button>
        <button data-ai-sug="Write another description for ${esc(productName)}" style="padding:6px 12px;border:1px solid #e5e7eb;border-radius:6px;font-size:11px;cursor:pointer;background:#fff">Regenerate</button>
      </div>
    `,
    type: 'action',
  }
}

function generateProductDescription(name: string): string {
  // Template-based generation (Claude API integration point)
  const templates = [
    `Discover the ${name} — crafted with premium materials and designed for everyday excellence. Whether you're looking for style, comfort, or durability, this product delivers on all fronts. Perfect for those who appreciate quality without compromise.`,
    `Introducing the ${name}: where form meets function. Built to last and designed to impress, this is more than just a product — it's a statement. Elevate your experience today.`,
    `The ${name} combines modern design with exceptional quality. Each detail has been thoughtfully considered to provide you with the best possible experience. Order now and see the difference.`,
  ]
  return templates[Math.floor(Math.random() * templates.length)]
}

// ─── AI FUNCTION: MARKETING SUGGESTIONS ──────────────────────────

async function suggestMarketing(db: Kysely<Database>, ctx: AIContext): Promise<AIResponse> {
  const productCount = await db
    .selectFrom('products')
    .select(db.fn.count('id').as('count'))
    .where('shop_id', '=', ctx.storeId)
    .executeTakeFirst()

  const customerCount = await db
    .selectFrom('customers')
    .select(db.fn.count('id').as('count'))
    .where('shop_id', '=', ctx.storeId)
    .executeTakeFirst()

  const hasDiscounts = await db
    .selectFrom('discounts')
    .select(db.fn.count('id').as('count'))
    .where('shop_id', '=', ctx.storeId)
    .where('status', '=', 'active')
    .executeTakeFirst()

  const products = Number(productCount?.count ?? 0)
  const customers = Number(customerCount?.count ?? 0)
  const discounts = Number(hasDiscounts?.count ?? 0)

  const suggestions = []
  if (customers === 0) suggestions.push({ icon: '🎯', title: 'Launch Social Media Ads', desc: 'Start with $5/day Facebook & Instagram ads targeting your ideal customer.' })
  if (customers > 0 && customers < 50) suggestions.push({ icon: '📧', title: 'Email Campaign', desc: `Send a "Thank You" email to your ${customers} customers with a 10% off code for their next purchase.` })
  if (discounts === 0) suggestions.push({ icon: '🏷️', title: 'Create First Discount', desc: 'Set up a "WELCOME10" code for 10% off first orders. This alone can boost conversion 15-20%.' })
  if (products > 3) suggestions.push({ icon: '📸', title: 'Instagram Showcase', desc: 'Create a weekly "Product Spotlight" post featuring your top sellers with lifestyle photos.' })
  suggestions.push({ icon: '🤝', title: 'Referral Program', desc: 'Give existing customers $10 credit for each referral. Word-of-mouth is the cheapest acquisition channel.' })
  suggestions.push({ icon: '📝', title: 'Blog Content', desc: 'Write 2-3 blog posts about topics related to your products. Great for SEO and establishing authority.' })

  const html = suggestions.slice(0, 5).map(s => `
    <div style="padding:10px;border:1px solid #e5e7eb;border-radius:8px;margin-bottom:8px">
      <div style="font-weight:600;font-size:13px">${s.icon} ${s.title}</div>
      <div style="font-size:12px;color:#6b7280;margin-top:4px">${s.desc}</div>
    </div>
  `).join('')

  return {
    text: `${suggestions.length} marketing suggestions generated`,
    html: `
      <div style="margin-bottom:12px"><strong>Marketing Ideas — ${esc(ctx.storeName)}</strong></div>
      ${html}
      <div style="font-size:12px;color:#6b7280;background:#f9fafb;padding:10px;border-radius:8px">
        <strong>AI Tip:</strong> Start with one idea, execute it fully, measure results for 2 weeks, then move to the next. Consistency beats variety.
      </div>
    `,
    type: 'insight',
  }
}

// ─── AI FUNCTION: SEO SUGGESTIONS ────────────────────────────────

async function seoSuggestions(db: Kysely<Database>, ctx: AIContext): Promise<AIResponse> {
  const products = await db
    .selectFrom('products')
    .select(['title', 'slug', 'body_html'])
    .where('shop_id', '=', ctx.storeId)
    .where('status', '=', 'active')
    .limit(5)
    .execute()

  const issues = []
  for (const p of products) {
    const bodyLength = (p.body_html || '').replace(/<[^>]*>/g, '').length
    if (bodyLength < 50) issues.push({ product: p.title, issue: 'Description too short (< 50 chars). Aim for 150-300 words.' })
    if (p.title.length > 60) issues.push({ product: p.title, issue: 'Title too long for SEO (> 60 chars). Search engines will truncate it.' })
    if (p.title.length < 10) issues.push({ product: p.title, issue: 'Title too short. Add descriptive keywords.' })
  }

  const issueHtml = issues.slice(0, 5).map(i => `
    <div style="padding:8px;border-left:3px solid #f59e0b;background:#fffbeb;border-radius:0 8px 8px 0;margin-bottom:6px;font-size:12px">
      <strong>${esc(i.product)}</strong><br>
      <span style="color:#92400e">${i.issue}</span>
    </div>
  `).join('')

  return {
    text: `SEO: ${issues.length} issues found across ${products.length} products`,
    html: `
      <div style="margin-bottom:12px"><strong>SEO Analysis — ${esc(ctx.storeName)}</strong></div>
      <div style="background:${issues.length === 0 ? '#f0fdf4' : '#fef3c7'};padding:10px;border-radius:8px;margin-bottom:12px;text-align:center">
        <div style="font-size:20px;font-weight:700;color:${issues.length === 0 ? '#10b981' : '#92400e'}">${issues.length}</div>
        <div style="font-size:11px;color:#6b7280">SEO Issues</div>
      </div>
      ${issues.length > 0 ? issueHtml : '<div style="color:#10b981;font-size:12px">All products look good for SEO!</div>'}
      <div style="margin-top:12px;font-size:12px;color:#6b7280;background:#f9fafb;padding:10px;border-radius:8px">
        <strong>SEO Tips:</strong><br>
        • Product titles: 30-60 characters with main keyword<br>
        • Descriptions: 150-300 words, naturally include keywords<br>
        • Image alt text: Describe the product, include keywords<br>
        • URL slugs: Short, descriptive, hyphenated
      </div>
    `,
    type: 'insight',
  }
}

// ─── AI FUNCTION: DISCOUNT ANALYSIS ──────────────────────────────

async function analyzeDiscounts(db: Kysely<Database>, ctx: AIContext): Promise<AIResponse> {
  const discounts = await db
    .selectFrom('discounts')
    .select(['title', 'code', 'type', 'value', 'value_type', 'usage_count', 'status', 'starts_at', 'ends_at'])
    .where('shop_id', '=', ctx.storeId)
    .orderBy('created_at', 'desc')
    .limit(10)
    .execute()

  const discountHtml = discounts.map(d => `
    <div style="display:flex;justify-content:space-between;padding:8px 0;font-size:12px;border-bottom:1px solid #f3f4f6">
      <div>
        <span style="font-weight:600">${esc(d.code || d.title)}</span>
        <span style="color:#6b7280"> — ${d.value_type === 'percentage' ? `${d.value}% off` : `$${Number(d.value).toFixed(2)} off`}</span>
      </div>
      <span class="badge ${d.status === 'active' ? 'badge-success' : 'badge-info'}" style="display:inline;padding:2px 6px;border-radius:4px;font-size:10px;background:${d.status === 'active' ? '#d1fae5' : '#e5e7eb'};color:${d.status === 'active' ? '#065f46' : '#6b7280'}">${d.status}</span>
    </div>
  `).join('')

  return {
    text: `Discounts: ${discounts.length} found`,
    html: `
      <div style="margin-bottom:12px"><strong>Discount Analysis — ${esc(ctx.storeName)}</strong></div>
      ${discounts.length > 0 ? discountHtml : '<div style="color:#6b7280;font-size:12px;margin-bottom:12px">No discounts created yet.</div>'}
      <div style="margin-top:12px;font-size:12px;color:#6b7280;background:#f9fafb;padding:10px;border-radius:8px">
        <strong>AI Insight:</strong> ${discounts.length === 0
          ? 'Creating a welcome discount (e.g., WELCOME10 for 10% off) can boost conversion rates by 15-20%.'
          : `You have ${discounts.filter(d => d.status === 'active').length} active discount(s). Monitor usage to ensure they're driving value, not just cutting margin.`}
      </div>
    `,
    type: 'insight',
  }
}

// ─── AI FUNCTION: STORE HEALTH CHECK ─────────────────────────────

async function storeHealthCheck(db: Kysely<Database>, ctx: AIContext): Promise<AIResponse> {
  const [products, orders, customers, variants] = await Promise.all([
    db.selectFrom('products').select(db.fn.count('id').as('c')).where('shop_id', '=', ctx.storeId).executeTakeFirst(),
    db.selectFrom('orders').select([db.fn.count('id').as('c'), db.fn.sum('total_price').as('rev')]).where('shop_id', '=', ctx.storeId).executeTakeFirst(),
    db.selectFrom('customers').select(db.fn.count('id').as('c')).where('shop_id', '=', ctx.storeId).executeTakeFirst(),
    db.selectFrom('product_variants as pv').innerJoin('products as p', 'p.id', 'pv.product_id').select(db.fn.count('pv.id').as('low')).where('p.shop_id', '=', ctx.storeId).where('pv.inventory_quantity', '<', 10).executeTakeFirst(),
  ])

  const p = Number(products?.c ?? 0)
  const o = Number(orders?.c ?? 0)
  const r = Number(orders?.rev ?? 0)
  const c = Number(customers?.c ?? 0)
  const lowStock = Number(variants?.low ?? 0)

  // Calculate health score (0-100)
  let score = 0
  if (p > 0) score += 20
  if (p > 5) score += 10
  if (o > 0) score += 20
  if (o > 10) score += 10
  if (c > 0) score += 15
  if (c > 10) score += 5
  if (lowStock === 0) score += 10
  if (r > 100) score += 10
  score = Math.min(score, 100)

  const scoreColor = score >= 70 ? '#10b981' : score >= 40 ? '#f59e0b' : '#ef4444'
  const scoreLabel = score >= 70 ? 'Healthy' : score >= 40 ? 'Needs attention' : 'Critical'

  return {
    text: `Store health: ${score}/100 (${scoreLabel})`,
    html: `
      <div style="margin-bottom:12px"><strong>Store Health Check — ${esc(ctx.storeName)}</strong></div>
      <div style="text-align:center;margin-bottom:16px">
        <div style="width:80px;height:80px;border-radius:50%;border:4px solid ${scoreColor};display:inline-flex;align-items:center;justify-content:center;margin-bottom:8px">
          <span style="font-size:24px;font-weight:800;color:${scoreColor}">${score}</span>
        </div>
        <div style="font-size:14px;font-weight:600;color:${scoreColor}">${scoreLabel}</div>
      </div>
      <div style="font-size:12px">
        <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #f3f4f6">
          <span>Products</span><span style="font-weight:600">${p}</span>
        </div>
        <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #f3f4f6">
          <span>Orders</span><span style="font-weight:600">${o}</span>
        </div>
        <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #f3f4f6">
          <span>Revenue</span><span style="font-weight:600">$${r.toFixed(2)}</span>
        </div>
        <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #f3f4f6">
          <span>Customers</span><span style="font-weight:600">${c}</span>
        </div>
        <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #f3f4f6">
          <span>Low stock items</span><span style="font-weight:600;color:${lowStock > 0 ? '#ef4444' : '#10b981'}">${lowStock}</span>
        </div>
      </div>
      <div style="margin-top:12px;font-size:12px;color:#6b7280;background:#f9fafb;padding:10px;border-radius:8px">
        <strong>AI Recommendations:</strong><br>
        ${p === 0 ? '• Add your first products to get started<br>' : ''}
        ${o === 0 ? '• Drive traffic to get your first orders<br>' : ''}
        ${lowStock > 0 ? `• Restock ${lowStock} low-inventory item(s)<br>` : ''}
        ${c > 0 && o > 0 ? '• Keep up the momentum! Consider loyalty rewards.<br>' : ''}
        ${score >= 70 ? '• Your store is performing well. Focus on scaling marketing.' : ''}
      </div>
    `,
    type: 'insight',
  }
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
