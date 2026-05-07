/**
 * Store Admin — Content Hub
 *
 * Matches Shopify's Content section:
 * - Metaobjects (structured content entries)
 * - Files (media library)
 *
 * Shopify reference: admin.shopify.com/store/xxx/content
 */

import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db'
import { sellerLayout, esc } from '../layouts/seller-layout.js'

// ─── Content Hub ────────────────────────────────────────────────

export async function getContentHub(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const theme = (req as any).theme || 'dark'
  const base = `/admin/store/${esc(store.slug)}`

  const content = `
    <div class="page-header">
      <div>
        <h1 class="page-title">Content</h1>
        <p class="page-subtitle">Manage your store's content and media</p>
      </div>
    </div>

    <div class="content-grid">
      <!-- Metaobjects Card -->
      <a href="${base}/content/metaobjects" class="content-card">
        <div class="content-card-icon">
          <svg width="24" height="24" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5">
            <rect x="3" y="3" width="14" height="14" rx="2"/>
            <path d="M7 7h6M7 10h4M7 13h5"/>
          </svg>
        </div>
        <div class="content-card-info">
          <h3>Metaobjects</h3>
          <p>Create and manage custom content types like FAQs, size guides, and lookbooks</p>
        </div>
        <div class="content-card-arrow">
          <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M7 4l6 6-6 6"/>
          </svg>
        </div>
      </a>

      <!-- Files Card -->
      <a href="${base}/content/files" class="content-card">
        <div class="content-card-icon">
          <svg width="24" height="24" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5">
            <rect x="2" y="3" width="16" height="14" rx="2"/>
            <circle cx="7" cy="9" r="2"/>
            <path d="M18 14l-4-4-6 6"/>
          </svg>
        </div>
        <div class="content-card-info">
          <h3>Files</h3>
          <p>Upload and manage images, videos, and documents for your store</p>
        </div>
        <div class="content-card-arrow">
          <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M7 4l6 6-6 6"/>
          </svg>
        </div>
      </a>
    </div>

    <style>
      .content-grid { display:flex; flex-direction:column; gap:12px; max-width:680px; }
      .content-card {
        display:flex; align-items:center; gap:16px; padding:20px;
        background:var(--s-card); border:1px solid var(--s-border);
        border-radius:12px; text-decoration:none; color:var(--s-text);
        transition:all .15s;
      }
      .content-card:hover { border-color:var(--s-accent); background:rgba(99,102,241,.04); }
      .content-card-icon {
        width:48px; height:48px; border-radius:10px;
        background:rgba(99,102,241,.1); color:var(--s-accent);
        display:flex; align-items:center; justify-content:center; flex-shrink:0;
      }
      .content-card-info { flex:1; }
      .content-card-info h3 { font-size:14px; font-weight:600; margin:0 0 4px; }
      .content-card-info p { font-size:13px; color:var(--s-text-muted); margin:0; line-height:1.4; }
      .content-card-arrow { color:var(--s-text-dim); flex-shrink:0; }
    </style>
  `

  res.send(sellerLayout({
    title: 'Content',
    storeName: store.name,
    storeSlug: store.slug,
    userName: user.name,
    userEmail: user.email,
    userRole: user.role,
    storeRole: user.storeRole,
    activePage: 'content',
    content,
    theme: theme as 'dark' | 'light',
  }))
}

// ─── Metaobjects Page ───────────────────────────────────────────

export async function getMetaobjects(
  req: Request,
  res: Response,
  _db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const theme = (req as any).theme || 'dark'

  const content = `
    <div class="page-header">
      <div>
        <h1 class="page-title">Metaobjects</h1>
        <p class="page-subtitle">Custom structured content for your store</p>
      </div>
      <button class="btn btn-primary" disabled>Add definition</button>
    </div>

    <div class="card">
      <div class="card-body">
        <div class="empty-state">
          <div class="empty-state-icon">
            <svg width="48" height="48" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.2" style="opacity:.5">
              <rect x="3" y="3" width="14" height="14" rx="2"/>
              <path d="M7 7h6M7 10h4M7 13h5"/>
            </svg>
          </div>
          <div class="empty-state-title">No metaobject definitions yet</div>
          <div class="empty-state-text">
            Metaobjects let you create custom content types for your store — like FAQs,
            size guides, testimonials, or lookbooks. Define your structure, then create entries.
          </div>
        </div>
      </div>
    </div>
  `

  res.send(sellerLayout({
    title: 'Metaobjects',
    storeName: store.name,
    storeSlug: store.slug,
    userName: user.name,
    userEmail: user.email,
    userRole: user.role,
    storeRole: user.storeRole,
    activePage: 'content',
    content,
    theme: theme as 'dark' | 'light',
  }))
}
