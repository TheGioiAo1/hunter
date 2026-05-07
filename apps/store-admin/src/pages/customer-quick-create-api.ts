/**
 * Quick-create customer JSON API — dùng cho modal popup trong /orders/drafts/new.
 * POST /admin/store/:slug/api/customers/quick-create
 *
 * Body JSON: { email, first_name, last_name, phone?, country_code? }
 * Response 200: { id, email, first_name, last_name, ... }
 * Response 400/502: { error }
 */

import type { Request, Response } from 'express'
import { createApiContext, createCustomer } from '../lib/customer-api-client.js'
import { ProductApiError } from '../lib/product-api-errors.js'

export async function postQuickCreateCustomer(req: Request, res: Response): Promise<void> {
  let ctx
  try { ctx = createApiContext(req) } catch {
    res.status(401).json({ error: 'auth' })
    return
  }

  const body = (req.body || {}) as Record<string, unknown>
  const s = (k: string) => String(body[k] ?? '').trim()
  const email = s('email').toLowerCase()
  const firstName = s('first_name')
  const lastName = s('last_name')
  const phone = s('phone')
  const acceptsMarketing = body.accepts_marketing === true || body.accepts_marketing === 'true' || body.accepts_marketing === '1'
  const tagsRaw = s('tags')
  const tagsArr = tagsRaw ? tagsRaw.split(',').map((t) => t.trim()).filter(Boolean) : []
  const note = s('note')
  const address1 = s('address_1')
  const address2 = s('address_2')
  const city = s('city')
  const province = s('province')
  const zip = s('zip')
  const countryCode = s('country_code').toUpperCase() || undefined

  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    res.status(400).json({ error: 'Email không hợp lệ' })
    return
  }
  if (!firstName && !lastName) {
    res.status(400).json({ error: 'Cần ít nhất first_name hoặc last_name' })
    return
  }

  try {
    const created = await createCustomer(ctx, {
      email,
      first_name: firstName || null,
      last_name: lastName || null,
      full_name: [firstName, lastName].filter(Boolean).join(' ') || null,
      phone: phone || null,
      accepts_marketing: acceptsMarketing,
      tags: tagsArr.length > 0 ? tagsArr : undefined,
      note: note || null,
      address_1: address1 || null,
      address_2: address2 || null,
      city: city || null,
      province: province || null,
      zip: zip || null,
      country_code: countryCode,
    } as any)
    res.status(200).json({
      id: created?.id ?? '',
      email: created?.email ?? email,
      first_name: created?.first_name ?? firstName,
      last_name: created?.last_name ?? lastName,
      full_name: created?.full_name ?? [firstName, lastName].filter(Boolean).join(' '),
    })
  } catch (err) {
    if (err instanceof ProductApiError && err.kind === 'auth') {
      res.status(401).json({ error: 'auth' })
      return
    }
    const msg = err instanceof Error ? err.message : 'create_failed'
    console.error('[customer-quick-create] BE failed:', msg)
    res.status(502).json({ error: msg })
  }
}
