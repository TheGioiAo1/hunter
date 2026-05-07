/**
 * God Admin — Lenful Catalog / Product Mapping (Phase F1)
 *
 *   GET  /god-admin/fulfillments/catalog                           — list
 *   GET  /god-admin/fulfillments/catalog/:productId                — edit mapping
 *   POST /god-admin/fulfillments/catalog/:productId                — save mapping
 *   POST /god-admin/fulfillments/catalog/:productId/unmap          — remove mapping
 *   POST /god-admin/fulfillments/catalog/:productId/verify-sku     — validate a SKU against Lenful
 *   GET  /god-admin/fulfillments/catalog/lookup                    — live Lenful search (JSON)
 *
 * Data flow
 * ---------
 * Every Gbox product that sellers want fulfilled by Gbox must be mapped
 * to a Lenful `product_sku`. F1 uses a product-level mapping (variant_id
 * = null); variant-level overrides are recorded in the same table and
 * win at push-time.
 */

import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import type { Database } from '../../../../packages/db/src/index.js'
import { godLayout } from '../layouts/god-layout.js'
import { createCsrfStore } from '../../../../packages/core/src/modules/auth/csrf-express.js'
import {
  listGboxProductsWithMapping,
  listMappingsForProduct,
  saveMapping,
  deleteMapping,
  getActiveCredential,
  LenfulClient,
  PRINT_POSITIONS,
  SHIPPING_METHODS,
  type LenfulMappingRow,
} from '../../../../packages/core/src/modules/fulfillment/lenful/index.js'

const csrfStore = createCsrfStore({ cookieName: 'gbox_csrf_lenful_catalog' })

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production'
}

function esc(s: unknown): string {
  if (s === null || s === undefined) return ''
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function shortDate(iso: string | null | undefined): string {
  if (!iso) return '-'
  try {
    return new Date(iso).toLocaleString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    })
  } catch {
    return String(iso)
  }
}

function parseShippingPriority(raw: string): number[] {
  const parts = raw.split(',').map((x) => x.trim()).filter(Boolean)
  const result: number[] = []
  for (const p of parts) {
    const n = Number.parseInt(p, 10)
    if (Number.isFinite(n) && n >= 0 && n <= 8) result.push(n)
  }
  if (result.length === 0) return [0, 1, 2]
  return Array.from(new Set(result))
}

// ---------------------------------------------------------------------------
// GET /god-admin/fulfillments/catalog
// ---------------------------------------------------------------------------

export async function getCatalog(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const user = req.godAdmin!.user
  const page = Math.max(1, Number.parseInt(String(req.query.page ?? '1'), 10) || 1)
  const search = String(req.query.q ?? '').trim()
  const filter = String(req.query.filter ?? 'all')
  const unmappedOnly = filter === 'unmapped'
  const limit = 50

  const flash = typeof req.query.msg === 'string' ? req.query.msg : ''
  const err = typeof req.query.err === 'string' ? req.query.err : ''

  try {
    const [{ rows, total }, cred] = await Promise.all([
      listGboxProductsWithMapping(db, { search, page, limit, unmappedOnly }),
      getActiveCredential(db),
    ])

    const totalMapped = rows.filter((r) => r.mapping).length
    const totalRows = rows.length
    const pageCount = Math.max(1, Math.ceil(total / limit))

    const tabs = [
      { id: 'all', label: 'All products' },
      { id: 'unmapped', label: 'Unmapped only' },
    ]
      .map(
        (t) => `
        <a href="?filter=${t.id}${search ? `&q=${encodeURIComponent(search)}` : ''}"
           style="padding:8px 14px;border-radius:8px;text-decoration:none;font-size:13px;font-weight:600;
                  background:${filter === t.id ? '#6366f1' : '#1e293b'};
                  color:${filter === t.id ? '#fff' : '#94a3b8'};
                  border:1px solid ${filter === t.id ? '#6366f1' : '#334155'}">
          ${esc(t.label)}
        </a>`,
      )
      .join(' ')

    const credBanner = cred
      ? `<div style="padding:10px 14px;border:1px solid #10b98144;background:#10b98111;border-radius:10px;margin-bottom:16px;font-size:13px;color:#86efac">
          Active Lenful credential: <strong>${esc(cred.label)}</strong> (${esc(cred.user_name)})
          ${cred.lenful_store_id ? ` • store <code>${esc(cred.lenful_store_id)}</code>` : ' • <span style="color:#fbbf24">no store_id</span>'}
         </div>`
      : `<div style="padding:12px 16px;border:1px solid #ef444466;background:#ef444411;border-radius:10px;margin-bottom:16px;color:#fecaca;font-size:13px">
          ⚠ No active Lenful credential. Go to <a href="/god-admin/fulfillments/credentials" style="color:#f87171">Credentials</a> first — mapping still works, but "Verify SKU" will fail.
         </div>`

    const tbody = rows.length
      ? rows
          .map((r) => {
            const mapped = r.mapping
            const badge = mapped
              ? `<span style="display:inline-block;padding:2px 10px;background:#10b98122;color:#10b981;border-radius:10px;font-size:11px;font-weight:600">MAPPED</span>`
              : `<span style="display:inline-block;padding:2px 10px;background:#f59e0b22;color:#fbbf24;border-radius:10px;font-size:11px;font-weight:600">UNMAPPED</span>`
            const lenfulCell = mapped
              ? `<div style="font-family:monospace;font-size:12px">${esc(mapped.lenful_product_sku)}</div>
                 ${mapped.lenful_product_title ? `<div style="font-size:11px;color:#94a3b8">${esc(mapped.lenful_product_title)}</div>` : ''}`
              : '<span style="color:#64748b">—</span>'
            return `
            <tr style="border-bottom:1px solid #1e293b">
              <td style="padding:12px">${badge}</td>
              <td style="padding:12px">
                <div style="font-weight:600">${esc(r.gbox_product_title)}</div>
                <div style="font-size:11px;color:#94a3b8">${esc(r.gbox_shop_name || '-')} • ${r.variant_count} variants</div>
              </td>
              <td style="padding:12px">${lenfulCell}</td>
              <td style="padding:12px;font-size:12px;color:#94a3b8">${mapped ? shortDate(mapped.mapped_at) : '-'}</td>
              <td style="padding:12px;text-align:right">
                <a href="/god-admin/fulfillments/catalog/${esc(r.gbox_product_id)}"
                   style="padding:6px 14px;background:#3b82f6;color:#fff;text-decoration:none;border-radius:6px;font-size:12px;font-weight:600">
                  ${mapped ? 'Edit' : 'Map'}
                </a>
              </td>
            </tr>
          `
          })
          .join('')
      : `<tr><td colspan="5" style="padding:48px;text-align:center;color:#64748b">No products found.</td></tr>`

    const prevPage = Math.max(1, page - 1)
    const nextPage = Math.min(pageCount, page + 1)
    const pager = `
      <div style="display:flex;gap:8px;align-items:center;padding:14px 16px;border-top:1px solid #1e293b;font-size:12px">
        <span style="color:#94a3b8">Page ${page} / ${pageCount} • ${total} products • ${totalMapped}/${totalRows} mapped on this page</span>
        <div style="margin-left:auto;display:flex;gap:6px">
          ${page > 1 ? `<a href="?page=${prevPage}&filter=${filter}${search ? `&q=${encodeURIComponent(search)}` : ''}" style="padding:6px 12px;background:#1e293b;color:#cbd5e1;border-radius:6px;text-decoration:none">← Prev</a>` : ''}
          ${page < pageCount ? `<a href="?page=${nextPage}&filter=${filter}${search ? `&q=${encodeURIComponent(search)}` : ''}" style="padding:6px 12px;background:#1e293b;color:#cbd5e1;border-radius:6px;text-decoration:none">Next →</a>` : ''}
        </div>
      </div>`

    const content = `
      <div style="padding:24px">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:8px">
          <div>
            <h1 style="margin:0 0 4px;font-size:22px;color:#fff">Lenful Product Mapping</h1>
            <p style="margin:0;color:#94a3b8;font-size:13px">Map each Gbox product to a Lenful SKU so orders push cleanly.</p>
          </div>
        </div>

        ${flash ? `<div style="padding:10px 14px;border:1px solid #10b98166;background:#10b98122;border-radius:10px;margin:12px 0;font-size:13px;color:#86efac">${esc(flash)}</div>` : ''}
        ${err ? `<div style="padding:10px 14px;border:1px solid #ef444466;background:#ef444422;border-radius:10px;margin:12px 0;font-size:13px;color:#fecaca">${esc(err)}</div>` : ''}

        ${credBanner}

        <div style="display:flex;gap:12px;align-items:center;margin:12px 0">
          <div style="display:flex;gap:8px">${tabs}</div>
          <form method="GET" style="margin-left:auto;display:flex;gap:8px">
            <input type="hidden" name="filter" value="${esc(filter)}">
            <input type="text" name="q" value="${esc(search)}" placeholder="Search by title / handle / shop…"
                   style="padding:8px 12px;background:#0f172a;border:1px solid #334155;border-radius:8px;color:#e2e8f0;font-size:13px;width:280px">
            <button type="submit" style="padding:8px 16px;background:#3b82f6;color:#fff;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer">Search</button>
          </form>
        </div>

        <div style="background:#0f172a;border:1px solid #1e293b;border-radius:12px;overflow:hidden">
          <table style="width:100%;border-collapse:collapse">
            <thead>
              <tr style="background:#1e293b;text-align:left;font-size:11px;color:#94a3b8;text-transform:uppercase;letter-spacing:0.5px">
                <th style="padding:12px;width:120px">Status</th>
                <th style="padding:12px">Gbox Product</th>
                <th style="padding:12px">Lenful SKU</th>
                <th style="padding:12px;width:160px">Mapped At</th>
                <th style="padding:12px;width:100px;text-align:right">Action</th>
              </tr>
            </thead>
            <tbody>
              ${tbody}
            </tbody>
          </table>
          ${pager}
        </div>
      </div>
    `

    res.send(
      godLayout({
        title: 'Lenful Catalog',
        userEmail: user.email,
        activePath: '/god-admin/fulfillments/catalog',
        content,
      }),
    )
  } catch (e: any) {
    console.error('[god-admin] lenful catalog error:', e)
    res.status(500).send('Error: ' + esc(e?.message ?? String(e)))
  }
}

// ---------------------------------------------------------------------------
// GET /god-admin/fulfillments/catalog/:productId
// ---------------------------------------------------------------------------

export async function getCatalogEdit(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const user = req.godAdmin!.user
  const productId = String(req.params.productId ?? '')
  const csrfToken = await csrfStore.issue(res, isProduction())
  const csrfField = csrfStore.hiddenField(csrfToken)
  const flash = typeof req.query.msg === 'string' ? req.query.msg : ''
  const err = typeof req.query.err === 'string' ? req.query.err : ''

  try {
    const product = await db
      .selectFrom('products as p')
      .leftJoin('shops as s', 's.id', 'p.shop_id')
      .select([
        'p.id as id',
        'p.title as title',
        'p.slug as handle',
        'p.shop_id as shop_id',
        's.name as shop_name',
      ])
      .where('p.id', '=', productId)
      .executeTakeFirst()

    if (!product) {
      res.status(404).send('Product not found')
      return
    }

    const variants = await db
      .selectFrom('product_variants')
      .select(['id', 'title', 'sku', 'price'])
      .where('product_id', '=', productId)
      .orderBy('position', 'asc')
      .execute()

    const mappings = await listMappingsForProduct(db, productId)
    const productLevel = mappings.find((m) => m.gbox_variant_id === null)

    const shippingOpts = Object.entries(SHIPPING_METHODS)
      .map(([code, name]) => `<option value="${code}">${code} — ${esc(name)}</option>`)
      .join('')
    const printOpts = Object.entries(PRINT_POSITIONS)
      .map(([code, name]) => `<option value="${code}">${code} — ${esc(name)}</option>`)
      .join('')

    // Per-variant mapping rows
    const variantRows = variants
      .map((v) => {
        const m = mappings.find((mm) => mm.gbox_variant_id === v.id)
        return `
          <tr style="border-bottom:1px solid #1e293b">
            <td style="padding:10px">
              <div style="font-weight:600;font-size:13px">${esc(v.title || '(default)')}</div>
              <div style="font-size:11px;color:#94a3b8;font-family:monospace">SKU: ${esc(v.sku || '-')}</div>
            </td>
            <td style="padding:10px;font-family:monospace;font-size:12px">${m ? esc(m.lenful_product_sku) : '<span style="color:#64748b">inherits from product</span>'}</td>
            <td style="padding:10px;text-align:right">
              <button type="button" onclick="mapVariant('${esc(v.id)}','${esc(v.title || '')}')"
                      style="padding:6px 12px;background:#1e293b;color:#cbd5e1;border:1px solid #334155;border-radius:6px;font-size:11px;cursor:pointer">
                ${m ? 'Edit variant' : 'Override variant'}
              </button>
              ${m ? `
                <form method="POST" action="/god-admin/fulfillments/catalog/${esc(productId)}/unmap" style="display:inline">
                  ${csrfField}
                  <input type="hidden" name="mapping_id" value="${esc(m.id)}">
                  <button type="submit" onclick="return confirm('Remove variant mapping?')"
                          style="padding:6px 12px;background:#7f1d1d;color:#fecaca;border:1px solid #991b1b;border-radius:6px;font-size:11px;cursor:pointer;margin-left:4px">
                    Remove
                  </button>
                </form>
              ` : ''}
            </td>
          </tr>
        `
      })
      .join('')

    const currentPriority = productLevel?.default_shipping_priority?.join(', ') || '0, 1, 2'
    const currentPosition = productLevel?.default_print_position ?? 1

    const content = `
      <div style="padding:24px;max-width:1000px">
        <div style="margin-bottom:16px">
          <a href="/god-admin/fulfillments/catalog" style="color:#6366f1;text-decoration:none;font-size:13px">← Back to catalog</a>
        </div>
        <h1 style="margin:0 0 4px;font-size:22px;color:#fff">${esc(product.title)}</h1>
        <p style="margin:0 0 20px;color:#94a3b8;font-size:13px">
          ${esc(product.shop_name || '-')} • ${variants.length} variants
          ${product.handle ? ` • <code style="font-size:11px">${esc(product.handle)}</code>` : ''}
        </p>

        ${flash ? `<div style="padding:10px 14px;border:1px solid #10b98166;background:#10b98122;border-radius:10px;margin-bottom:16px;font-size:13px;color:#86efac">${esc(flash)}</div>` : ''}
        ${err ? `<div style="padding:10px 14px;border:1px solid #ef444466;background:#ef444422;border-radius:10px;margin-bottom:16px;font-size:13px;color:#fecaca">${esc(err)}</div>` : ''}

        <!-- PRODUCT-LEVEL MAPPING -->
        <div style="background:#0f172a;border:1px solid #1e293b;border-radius:12px;padding:20px;margin-bottom:20px">
          <h2 style="margin:0 0 16px;font-size:15px;color:#fff">Product-level mapping (applies to all variants unless overridden)</h2>
          <form method="POST" action="/god-admin/fulfillments/catalog/${esc(productId)}" id="mapForm">
            ${csrfField}
            <input type="hidden" name="gbox_variant_id" id="fGboxVariantId" value="">
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
              <label style="display:block">
                <div style="font-size:12px;color:#94a3b8;margin-bottom:4px">Lenful product_sku <span style="color:#ef4444">*</span></div>
                <div style="display:flex;gap:6px">
                  <input type="text" name="lenful_product_sku" id="fSku"
                         value="${esc(productLevel?.lenful_product_sku ?? '')}" required
                         placeholder="e.g. GT5000-BLK-M"
                         style="flex:1;padding:10px 12px;background:#020617;border:1px solid #334155;border-radius:8px;color:#e2e8f0;font-family:monospace">
                  <button type="button" onclick="verifySku()" id="fVerifyBtn"
                          style="padding:10px 14px;background:#1e293b;color:#cbd5e1;border:1px solid #334155;border-radius:8px;font-size:12px;cursor:pointer">
                    Verify
                  </button>
                </div>
                <div id="fVerifyResult" style="font-size:11px;margin-top:4px;color:#64748b">&nbsp;</div>
              </label>
              <label style="display:block">
                <div style="font-size:12px;color:#94a3b8;margin-bottom:4px">Lenful product_id <span style="color:#ef4444">*</span></div>
                <input type="text" name="lenful_product_id" id="fProductId"
                       value="${esc(productLevel?.lenful_product_id ?? '')}" required
                       placeholder="UUID from Lenful"
                       style="width:100%;padding:10px 12px;background:#020617;border:1px solid #334155;border-radius:8px;color:#e2e8f0;font-family:monospace">
              </label>
              <label style="display:block">
                <div style="font-size:12px;color:#94a3b8;margin-bottom:4px">Display title (optional)</div>
                <input type="text" name="lenful_product_title" id="fTitle"
                       value="${esc(productLevel?.lenful_product_title ?? '')}"
                       style="width:100%;padding:10px 12px;background:#020617;border:1px solid #334155;border-radius:8px;color:#e2e8f0">
              </label>
              <label style="display:block">
                <div style="font-size:12px;color:#94a3b8;margin-bottom:4px">Category slug (optional)</div>
                <input type="text" name="lenful_category_slug"
                       value="${esc(productLevel?.lenful_category_slug ?? '')}"
                       style="width:100%;padding:10px 12px;background:#020617;border:1px solid #334155;border-radius:8px;color:#e2e8f0">
              </label>
              <label style="display:block">
                <div style="font-size:12px;color:#94a3b8;margin-bottom:4px">Shipping priority (comma-separated codes 0–8)</div>
                <input type="text" name="default_shipping_priority"
                       value="${esc(currentPriority)}"
                       placeholder="0, 1, 2"
                       style="width:100%;padding:10px 12px;background:#020617;border:1px solid #334155;border-radius:8px;color:#e2e8f0;font-family:monospace">
                <div style="font-size:10px;color:#64748b;margin-top:4px">
                  0=Standard, 1=Ground, 2=Express, 3=3day, 4=Special, 5=US Island, 6=WW Std, 7=By Platform, 8=By Seller
                </div>
              </label>
              <label style="display:block">
                <div style="font-size:12px;color:#94a3b8;margin-bottom:4px">Default print position</div>
                <select name="default_print_position"
                        style="width:100%;padding:10px 12px;background:#020617;border:1px solid #334155;border-radius:8px;color:#e2e8f0">
                  ${Object.entries(PRINT_POSITIONS).map(([code, name]) => `
                    <option value="${code}" ${Number(code) === currentPosition ? 'selected' : ''}>${code} — ${esc(name)}</option>
                  `).join('')}
                </select>
              </label>
            </div>
            <div style="display:flex;gap:10px;margin-top:18px;justify-content:flex-end">
              ${productLevel ? `
                <form method="POST" action="/god-admin/fulfillments/catalog/${esc(productId)}/unmap" style="display:inline">
                  ${csrfField}
                  <input type="hidden" name="mapping_id" value="${esc(productLevel.id)}">
                  <button type="submit" onclick="return confirm('Remove the product-level mapping?')"
                          style="padding:10px 18px;background:#7f1d1d;color:#fecaca;border:1px solid #991b1b;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer">
                    Remove mapping
                  </button>
                </form>
              ` : ''}
              <button type="submit"
                      style="padding:10px 22px;background:#6366f1;color:#fff;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer">
                Save mapping
              </button>
            </div>
          </form>
        </div>

        <!-- PER-VARIANT OVERRIDES -->
        <div style="background:#0f172a;border:1px solid #1e293b;border-radius:12px;overflow:hidden;margin-bottom:20px">
          <div style="padding:16px;border-bottom:1px solid #1e293b">
            <h2 style="margin:0;font-size:15px;color:#fff">Variant-level overrides</h2>
            <p style="margin:6px 0 0;color:#94a3b8;font-size:12px">Override the product-level mapping for a specific variant when Lenful has different SKUs per color/size.</p>
          </div>
          <table style="width:100%;border-collapse:collapse">
            <thead>
              <tr style="background:#1e293b;text-align:left;font-size:11px;color:#94a3b8;text-transform:uppercase">
                <th style="padding:12px">Variant</th>
                <th style="padding:12px">Mapped Lenful SKU</th>
                <th style="padding:12px;text-align:right">Action</th>
              </tr>
            </thead>
            <tbody>
              ${variantRows || `<tr><td colspan="3" style="padding:24px;text-align:center;color:#64748b">This product has no variants.</td></tr>`}
            </tbody>
          </table>
        </div>
      </div>

      <script>
        function mapVariant(variantId, variantTitle) {
          document.getElementById('fGboxVariantId').value = variantId
          document.getElementById('mapForm').scrollIntoView({ behavior: 'smooth', block: 'start' })
          document.getElementById('fSku').focus()
          document.getElementById('fVerifyResult').innerHTML = 'Editing variant override: ' + variantTitle
          document.getElementById('fVerifyResult').style.color = '#fbbf24'
        }
        async function verifySku() {
          const sku = document.getElementById('fSku').value.trim()
          const out = document.getElementById('fVerifyResult')
          if (!sku) { out.textContent = 'Enter a SKU first.'; out.style.color = '#ef4444'; return }
          out.textContent = 'Checking…'; out.style.color = '#94a3b8'
          try {
            const r = await fetch('/god-admin/fulfillments/catalog/lookup?sku=' + encodeURIComponent(sku))
            const j = await r.json()
            if (j.ok && j.hit) {
              out.innerHTML = '✓ Found: <strong>' + (j.hit.title || j.hit.product_sku) + '</strong>'
              out.style.color = '#10b981'
              if (j.hit.id) document.getElementById('fProductId').value = j.hit.id
              if (j.hit.title) document.getElementById('fTitle').value = j.hit.title
            } else {
              out.textContent = j.error || 'Not found in Lenful catalog.'
              out.style.color = '#ef4444'
            }
          } catch (e) {
            out.textContent = 'Verify failed: ' + e.message
            out.style.color = '#ef4444'
          }
        }
      </script>
    `

    res.send(
      godLayout({
        title: `Map: ${product.title}`,
        userEmail: user.email,
        activePath: '/god-admin/fulfillments/catalog',
        content,
      }),
    )
  } catch (e: any) {
    console.error('[god-admin] lenful catalog edit error:', e)
    res.status(500).send('Error: ' + esc(e?.message ?? String(e)))
  }
}

// ---------------------------------------------------------------------------
// POST /god-admin/fulfillments/catalog/:productId
// ---------------------------------------------------------------------------

export async function postCatalogSave(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  if (!(await csrfStore.verify(req))) {
    res.redirect('/god-admin/fulfillments/catalog?err=' + encodeURIComponent('CSRF expired. Retry.'))
    return
  }
  const productId = String(req.params.productId ?? '')
  const user = req.godAdmin!.user
  const body = req.body as Record<string, string>
  try {
    const sku = String(body.lenful_product_sku ?? '').trim()
    const lProductId = String(body.lenful_product_id ?? '').trim()
    if (!sku || !lProductId) {
      throw new Error('lenful_product_sku and lenful_product_id are required')
    }
    await saveMapping(db, {
      gboxProductId: productId,
      gboxVariantId: body.gbox_variant_id ? String(body.gbox_variant_id) : null,
      lenfulProductId: lProductId,
      lenfulProductSku: sku,
      lenfulProductTitle: body.lenful_product_title ? String(body.lenful_product_title).trim() : undefined,
      lenfulCategorySlug: body.lenful_category_slug ? String(body.lenful_category_slug).trim() : undefined,
      defaultShippingPriority: parseShippingPriority(String(body.default_shipping_priority ?? '')),
      defaultPrintPosition: Number.parseInt(String(body.default_print_position ?? '1'), 10) || 1,
      mappedBy: user.id,
    })
    res.redirect(
      `/god-admin/fulfillments/catalog/${encodeURIComponent(productId)}?msg=` +
        encodeURIComponent(`Mapping saved (${sku}).`),
    )
  } catch (e: any) {
    console.error('[god-admin] lenful catalog save error:', e)
    res.redirect(
      `/god-admin/fulfillments/catalog/${encodeURIComponent(productId)}?err=` +
        encodeURIComponent(e?.message ?? String(e)),
    )
  }
}

// ---------------------------------------------------------------------------
// POST /god-admin/fulfillments/catalog/:productId/unmap
// ---------------------------------------------------------------------------

export async function postCatalogUnmap(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  if (!(await csrfStore.verify(req))) {
    res.redirect('/god-admin/fulfillments/catalog?err=' + encodeURIComponent('CSRF expired. Retry.'))
    return
  }
  const productId = String(req.params.productId ?? '')
  const body = req.body as Record<string, string>
  try {
    const id = String(body.mapping_id ?? '')
    if (!id) throw new Error('mapping_id required')
    await deleteMapping(db, id)
    res.redirect(
      `/god-admin/fulfillments/catalog/${encodeURIComponent(productId)}?msg=` +
        encodeURIComponent('Mapping removed.'),
    )
  } catch (e: any) {
    res.redirect(
      `/god-admin/fulfillments/catalog/${encodeURIComponent(productId)}?err=` +
        encodeURIComponent(e?.message ?? String(e)),
    )
  }
}

// ---------------------------------------------------------------------------
// GET /god-admin/fulfillments/catalog/lookup?sku=…
// Live Lenful catalog search used by the Verify button. JSON, no HTML.
// ---------------------------------------------------------------------------

export async function getCatalogLookup(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const user = req.godAdmin!.user
  const sku = String(req.query.sku ?? '').trim()
  if (!sku) {
    res.json({ ok: false, error: 'sku query param required' })
    return
  }
  try {
    const cred = await getActiveCredential(db)
    if (!cred) {
      res.json({ ok: false, error: 'No active Lenful credential' })
      return
    }
    const client = new LenfulClient({
      db,
      credentialId: cred.id,
      triggeredBy: 'god-admin-lookup',
      userId: user.id,
    })
    const hit = await client.findProductBySku(sku)
    if (!hit) {
      res.json({ ok: true, hit: null, error: 'SKU not found in Lenful catalog' })
      return
    }
    res.json({ ok: true, hit })
  } catch (e: any) {
    res.json({ ok: false, error: e?.message ?? String(e) })
  }
}
