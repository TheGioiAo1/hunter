/**
 * User Stores Lookup
 */

import type { Kysely } from 'kysely'
import {
  AdminLevel,
  hasAtLeastLevel,
} from '@gbox/core/modules/auth/admin-levels.js'

export interface AccessibleStore {
  id: string
  slug: string
  name: string
}

export async function listAccessibleStores(
  db: Kysely<any>,
  userId: string,
  userRole: string,
): Promise<AccessibleStore[]> {
  // Phase 14 Demo Mode — if db is null, return mock stores
  if (!db) {
    return [
      { id: 'shop_demo1', slug: 'gbox-demo', name: 'Gbox Demo Store' },
      { id: 'shop_demo2', slug: 'test-shop-1', name: 'Test Shop #1' },
    ]
  }

  try {
    // Resolve platform privilege. Platform admins bypass user_shops;
    // everyone else must have an explicit row.
    const userRow = await db
      .selectFrom('users')
      .select(['is_default_admin'])
      .where('id', '=', userId)
      .executeTakeFirst()

    const isPlatformAdmin = hasAtLeastLevel(
      {
        userRole,
        isDefaultAdmin: userRow?.is_default_admin === true,
      },
      AdminLevel.PLATFORM_ADMIN,
    )

    if (isPlatformAdmin) {
      const rows = await db
        .selectFrom('shops')
        .select(['id', 'slug', 'name'])
        .where('status', '=', 'active')
        .orderBy('name', 'asc')
        .limit(50)
        .execute()
      return rows.map(r => ({ id: r.id, slug: r.slug, name: r.name }))
    }

    // Regular user: join user_shops → shops
    const rows = await db
      .selectFrom('user_shops as us')
      .innerJoin('shops as s', 's.id', 'us.shop_id')
      .select(['s.id', 's.slug', 's.name'])
      .where('us.user_id', '=', userId)
      .where('s.status', '=', 'active')
      .orderBy('s.name', 'asc')
      .limit(50)
      .execute()
    return rows.map(r => ({ id: r.id, slug: r.slug, name: r.name }))
  } catch (err: any) {
    console.error('[user-stores] listAccessibleStores failed:', err.message)
    return []
  }
}
