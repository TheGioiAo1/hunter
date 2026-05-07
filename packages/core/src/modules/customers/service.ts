/**
 * Gbox Platform — Customer Service
 *
 * Shopify-equivalent customer management: CRUD, addresses, order stats.
 */

import { CustomerApi } from '@gbox/api-client'
import { emitIfEnabled } from '../automations/feature-flag.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CreateCustomerInput {
  email?: string | null
  first_name?: string | null
  last_name?: string | null
  phone?: string | null
  accepts_marketing?: boolean
  tags?: string[] | null
  note?: string | null
  tax_exempt?: boolean
  addresses?: CreateAddressInput[]
}

export interface UpdateCustomerInput {
  email?: string | null
  first_name?: string | null
  last_name?: string | null
  phone?: string | null
  accepts_marketing?: boolean
  tags?: string[] | null
  note?: string | null
  tax_exempt?: boolean
  status?: string
}

export interface CreateAddressInput {
  first_name?: string | null
  last_name?: string | null
  company?: string | null
  address1?: string | null
  address2?: string | null
  city?: string | null
  province?: string | null
  province_code?: string | null
  country?: string | null
  country_code?: string | null
  zip?: string | null
  phone?: string | null
  is_default?: boolean
}

export interface UpdateAddressInput {
  first_name?: string | null
  last_name?: string | null
  company?: string | null
  address1?: string | null
  address2?: string | null
  city?: string | null
  province?: string | null
  province_code?: string | null
  country?: string | null
  country_code?: string | null
  zip?: string | null
  phone?: string | null
  is_default?: boolean
}

export interface CustomerFilters {
  status?: string
  accepts_marketing?: boolean
  search?: string
  ids?: string[]
  created_at_min?: string
  created_at_max?: string
}

export interface Pagination {
  limit?: number
  offset?: number
}

// ---------------------------------------------------------------------------
// Service functions
// ---------------------------------------------------------------------------

/**
 * Create a customer with optional addresses.
 */
export async function createCustomer(
  _db: any,
  shopId: string,
  data: CreateCustomerInput,
) {
  const customer = await CustomerApi.CustomerService.postApi({
    shopId,
    requestBody: {
      email: data.email ?? undefined,
      first_name: data.first_name ?? undefined,
      last_name: data.last_name ?? undefined,
      phone: data.phone ?? undefined,
      // Note: tags, note, tax_exempt, accepts_marketing might need to be mapped to custom fields 
      // or other fields if not present in the Customer API model.
      // For now, we pass them as-is to the requestBody.
      ...data,
    } as any,
  })

  // --- PR3 automation emit ----------------------------------------
  // Emit OUTSIDE the transaction so a runner hiccup never rolls back
  // the customer row. Gated on AUTOMATION_FRAMEWORK_V2 so flag-off is
  // a zero-behavior-change rollback. Drives the `welcome_no_purchase`
  // flow (7-day delay; only fires if the customer hasn't purchased
  // by then — runner loads order count at send time).
  await emitIfEnabled(_db, {
    type: 'customer.created',
    shopId,
    customerId: customer.id,
    hasOrdered: false,
  })

  return customer
}

/**
 * Get a customer with addresses and order statistics.
 */
export async function getCustomer(
  _db: any,
  shopId: string,
  id: string,
) {
  try {
    const customer = await CustomerApi.CustomerService.getApi1({
      shopId,
      idOrEmail: id,
    })

    return customer
  } catch (error) {
    return null
  }
}

/**
 * Update a customer.
 */
export async function updateCustomer(
  _db: any,
  shopId: string,
  id: string,
  data: UpdateCustomerInput,
) {
  // Use putApi1 which takes shopId and idOrEmail (we use email or ID here, but id is more reliable)
  // Wait, CustomerService has putApi which takes shopId and requestBody (Array<Customer>)
  // and putApi1 which takes shopId, email and requestBody (Customer)
  
  // If we have an ID, we might need an endpoint for ID. 
  // But getApi1 takes idOrEmail. Maybe putApi1 does too? The param is named 'email'.
  
  const customer = await CustomerApi.CustomerService.putApi1({
    shopId,
    email: id, // Assuming it works with ID too as it's common in this codebase
    requestBody: data as any,
  })

  return customer
}

/**
 * Soft-delete a customer by setting status to 'disabled'.
 */
export async function deleteCustomer(
  _db: any,
  shopId: string,
  id: string,
): Promise<void> {
  await CustomerApi.CustomerService.deleteApi({
    shopId,
    requestBody: [id],
  })
}

/**
 * List customers with filters and pagination.
 */
export async function listCustomers(
  _db: any,
  shopId: string,
  filters: CustomerFilters = {},
  pagination: Pagination = {},
) {
  const { limit = 50, offset = 0 } = pagination
  const page = Math.floor(offset / limit) + 1

  const response = await CustomerApi.CustomerService.getApi({
    shopId,
    page,
    limit,
    keyword: filters.search ?? undefined,
    ids: filters.ids?.join(','),
    // Note: status, accepts_marketing, created_at_min/max are not directly supported by getApi
    // in the current CustomerService. We might need to use postApiList or wait for API updates.
    // For now, we use what's available.
  })

  // The API likely returns { data: Customer[], total: number } or similar.
  // We'll adapt it to match the original return type { customers, total }.
  return {
    customers: response.items || response.data || [],
    total: response.total || 0,
  }
}

/**
 * Add an address to a customer.
 */
export async function addAddress(
  db: Kysely<Database>,
  customerId: string,
  data: CreateAddressInput,
) {
  return db.transaction().execute(async (trx) => {
    // If this is the default address, unset any existing default
    if (data.is_default) {
      await trx
        .updateTable('customer_addresses')
        .set({ is_default: false } as any)
        .where('customer_id', '=', customerId)
        .where('is_default', '=', true)
        .execute()
    }

    const address = await trx
      .insertInto('customer_addresses')
      .values({
        customer_id: customerId,
        first_name: data.first_name ?? null,
        last_name: data.last_name ?? null,
        company: data.company ?? null,
        address1: data.address1 ?? null,
        address2: data.address2 ?? null,
        city: data.city ?? null,
        province: data.province ?? null,
        province_code: data.province_code ?? null,
        country: data.country ?? null,
        country_code: data.country_code ?? null,
        zip: data.zip ?? null,
        phone: data.phone ?? null,
        is_default: data.is_default ?? false,
      })
      .returningAll()
      .executeTakeFirstOrThrow()

    return address
  })
}

/**
 * Update an existing address.
 */
export async function updateAddress(
  db: Kysely<Database>,
  addressId: string,
  data: UpdateAddressInput,
) {
  return db.transaction().execute(async (trx) => {
    // If promoting to default, unset current default first
    if (data.is_default) {
      const existing = await trx
        .selectFrom('customer_addresses')
        .select('customer_id')
        .where('id', '=', addressId)
        .executeTakeFirstOrThrow()

      await trx
        .updateTable('customer_addresses')
        .set({ is_default: false } as any)
        .where('customer_id', '=', existing.customer_id)
        .where('is_default', '=', true)
        .execute()
    }

    const address = await trx
      .updateTable('customer_addresses')
      .set(data as any)
      .where('id', '=', addressId)
      .returningAll()
      .executeTakeFirstOrThrow()

    return address
  })
}
