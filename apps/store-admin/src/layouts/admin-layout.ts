/**
 * Gbox Store Admin — Layout (Compatibility Wrapper)
 *
 * This re-exports the new sellerLayout as adminLayout for backward
 * compatibility with existing pages that import from './admin-layout.js'.
 *
 * Old pages use: adminLayout({ title, storeName, storeSlug, userName,
 *   userEmail, userRole, activePage, content })
 * New layout needs: sellerLayout({ ...same + storeRole, theme })
 *
 * The wrapper maps userRole → storeRole. As of Phase 2 Step 2.1 it also
 * forwards a `cookieHeader` so the theme is auto-resolved from the
 * `gbox_theme` cookie — older callers that don't pass cookieHeader will
 * still render in the platform default ('dark') which matches the
 * pre-Phase-2 behavior.
 */

import { sellerLayout, esc } from './seller-layout.js'
import type { SellerLayoutOptions } from './seller-layout.js'

export { esc }

export interface LayoutOptions {
  title: string
  storeName: string
  storeSlug: string
  userName: string
  userEmail: string
  userRole: string
  activePage: string
  content: string
  aiPanel?: string
  /**
   * Raw `Cookie` header (req.headers.cookie). When provided the theme
   * auto-resolves from the `gbox_theme` cookie. Optional — callers that
   * don't pass it fall back to the platform default.
   */
  cookieHeader?: string | null
}

export function adminLayout(opts: LayoutOptions): string {
  const sellerOpts: SellerLayoutOptions = {
    title: opts.title,
    storeName: opts.storeName,
    storeSlug: opts.storeSlug,
    userName: opts.userName,
    userEmail: opts.userEmail,
    userRole: opts.userRole,     // platform role
    storeRole: opts.userRole,    // map to storeRole for backward compat
    activePage: opts.activePage,
    content: opts.content,
    aiPanel: opts.aiPanel,
    cookieHeader: opts.cookieHeader ?? null,
  }
  return sellerLayout(sellerOpts)
}
