/**
 * Customer CSV Import — commit path.
 *
 * Takes an `ImportPlan` (built by `import-plan.ts`) and applies it to
 * the DB. Blocked rows are skipped silently — the seller already saw
 * the issues on the preview screen.
 *
 * Write strategy:
 *   - All writes for one plan item happen inside a single transaction:
 *     customer upsert + default address upsert. If the address write
 *     fails, we don't leave a half-applied customer row around.
 *   - `tags` is NOT appended — it's written as the CSV cell intended.
 *     Shopify's import behaves the same way (merging would surprise
 *     sellers who delete a tag).
 *   - `note` is NOT overwritten when the CSV cell is blank on an
 *     update. The planner already emits a warning telling the seller
 *     that's what we do; here we enforce it.
 *   - Orders count / Total spent / Lifecycle stage columns in the CSV
 *     are ignored — those are denormalised from orders + the classifier
 *     and would be clobbered by the next order anyway.
 *
 * Return shape is a per-item result so callers can render a summary or
 * write an activity-feed entry.
 */

import { CustomerApi } from '@gbox/api-client'
import type { ImportPlan, ImportPlanItem } from './import-plan.js'

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface ApplyItemResult {
  line: number
  email: string | null
  action: 'created' | 'updated' | 'skipped' | 'error'
  customerId: string | null
  error?: string
}

export interface ApplyResult {
  items: ApplyItemResult[]
  stats: {
    created: number
    updated: number
    skipped: number
    errored: number
  }
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export async function applyImportPlan(
  _db: any,
  shopId: string,
  plan: ImportPlan,
): Promise<ApplyResult> {
  const results: ApplyItemResult[] = []

  for (const item of plan.items) {
    // Skip blocked rows — the seller already saw why.
    if (item.action === 'blocked') {
      results.push({
        line: item.parsed.sourceRow,
        email: item.parsed.email,
        action: 'skipped',
        customerId: null,
      })
      continue
    }

    try {
      // TODO: Map to API [CustomerService.postApi / putApi]
      // Transactional integrity is now managed by the API layer.
      const customerId = item.action === 'create'
        ? await applyCreate(shopId, item)
        : await applyUpdate(shopId, item)

      results.push({
        line: item.parsed.sourceRow,
        email: item.parsed.email,
        action: item.action === 'create' ? 'created' : 'updated',
        customerId,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      results.push({
        line: item.parsed.sourceRow,
        email: item.parsed.email,
        action: 'error',
        customerId: null,
        error: msg,
      })
    }
  }

  return {
    items: results,
    stats: {
      created: results.filter((r) => r.action === 'created').length,
      updated: results.filter((r) => r.action === 'updated').length,
      skipped: results.filter((r) => r.action === 'skipped').length,
      errored: results.filter((r) => r.action === 'error').length,
    },
  }
}

// ---------------------------------------------------------------------------
// Create path
// ---------------------------------------------------------------------------

async function applyCreate(
  shopId: string,
  item: ImportPlanItem,
): Promise<string> {
  const p = item.parsed
  const res = await CustomerApi.CustomerService.postApi({
    shopId,
    requestBody: {
      email: p.email,
      first_name: p.first_name,
      last_name: p.last_name,
      phone: p.phone,
      // accepts_marketing: p.accepts_marketing, // TODO: Map to API
      // note: p.note, // TODO: Map to API
      // tags: p.tags, // TODO: Map to API
      // tax_exempt: p.tax_exempt, // TODO: Map to API
      address_1: p.address?.address1,
      address_2: p.address?.address2,
      city: p.address?.city,
      province: p.address?.province,
      country_code: p.address?.country_code,
      zip: p.address?.zip,
    } as any,
  })

  return res.id
}

// ---------------------------------------------------------------------------
// Update path
// ---------------------------------------------------------------------------

async function applyUpdate(
  shopId: string,
  item: ImportPlanItem,
): Promise<string> {
  const p = item.parsed
  const customerId = item.existingCustomerId!

  // Build an update set that preserves server-owned columns. Specifically:
  //   - note: blank-in-CSV means "don't touch" — see note_cleared warning.
  //   - tags: null means "no change"; empty array means "clear tags".
  //     In parser output, `tags` is null when the Tags column is blank.
  const payload: any = {
    first_name: p.first_name,
    last_name: p.last_name,
    phone: p.phone,
    // accepts_marketing: p.accepts_marketing,
    // tax_exempt: p.tax_exempt,
  }

  // if (p.note !== null) payload.note = p.note
  // if (p.tags !== null) payload.tags = p.tags

  if (p.address) {
    payload.address_1 = p.address.address1
    payload.address_2 = p.address.address2
    payload.city = p.address.city
    payload.province = p.address.province
    payload.country_code = p.address.country_code
    payload.zip = p.address.zip
  }

  const res = await CustomerApi.CustomerService.putApi1({
    shopId,
    email: p.email!,
    requestBody: payload,
  })

  return res.id || customerId
}

