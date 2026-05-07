/**
 * Store Admin — Online Store Stub Pages (Phase 2B Sprint 1)
 *
 * Sprint 1 ships the new sidebar layout (Design / Pages / Blog / Landing /
 * Navigation / Preferences / Domains / Watermark / Size charts) but only
 * Design is fully wired this sprint. The remaining new items — Landing
 * pages (Sprint 3), Watermark (Sprint 4), and Size charts (Sprint 4) —
 * get a "coming soon" placeholder so clicking the sidebar never 404s.
 *
 * Each stub:
 *   - Uses the same sellerLayout chrome as real pages
 *   - Tells the seller which sprint the feature ships in
 *   - Links to the closest existing alternative (e.g. Landing → Pages)
 *
 * Why not a single shared handler? Each stub needs its own title +
 * "coming soon" copy + alternative-CTA, so cramming it into one switch
 * just hides the intent. Three 20-line handlers is easier to swap out
 * one-by-one as the real pages land in later sprints.
 */

import type { Request, Response } from 'express'
import { sellerLayout } from '../layouts/seller-layout.js'

function esc(raw: unknown): string {
  return String(raw ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

interface StubOptions {
  readonly title: string
  readonly subtitle: string
  readonly sprint: string
  readonly description: string
  readonly altLinks: readonly { label: string; href: string; hint?: string }[]
}

function renderStub(req: Request, res: Response, opts: StubOptions): void {
  const store = req.store!
  const user = req.storeUser!
  const theme = (req as any).theme || 'dark'

  const altLinksHtml = opts.altLinks
    .map(
      (l) => `
        <a href="${esc(l.href)}" style="display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border:1px solid var(--s-border);border-radius:8px;background:var(--s-card-bg);text-decoration:none;color:var(--s-text);transition:border-color .15s"
           onmouseover="this.style.borderColor='var(--s-accent)'" onmouseout="this.style.borderColor='var(--s-border)'">
          <div>
            <div style="font-size:13px;font-weight:600">${esc(l.label)}</div>
            ${l.hint ? `<div style="font-size:12px;color:var(--s-text-secondary);margin-top:2px">${esc(l.hint)}</div>` : ''}
          </div>
          <span style="color:var(--s-text-secondary)">→</span>
        </a>`,
    )
    .join('')

  const content = `
    <div style="margin-bottom:20px">
      <h1 style="font-size:20px;font-weight:700;margin:0 0 4px">${esc(opts.title)}</h1>
      <p style="color:var(--s-text-secondary);font-size:13px;margin:0">${esc(opts.subtitle)}</p>
    </div>

    <div class="card" style="margin-bottom:16px">
      <div class="card-body" style="display:flex;gap:16px;align-items:flex-start;padding:24px">
        <div style="width:48px;height:48px;border-radius:10px;background:rgba(167,139,250,.15);display:flex;align-items:center;justify-content:center;flex-shrink:0">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#a78bfa" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"/>
            <polyline points="12 6 12 12 16 14"/>
          </svg>
        </div>
        <div style="flex:1">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
            <h3 style="font-size:15px;font-weight:600;margin:0">Coming in ${esc(opts.sprint)}</h3>
            <span style="display:inline-block;padding:2px 10px;border-radius:9999px;font-size:11px;font-weight:600;background:rgba(167,139,250,.15);color:#a78bfa">Planned</span>
          </div>
          <p style="font-size:13px;color:var(--s-text-secondary);margin:0;line-height:1.5">${esc(opts.description)}</p>
        </div>
      </div>
    </div>

    ${
      opts.altLinks.length > 0
        ? `
      <div class="card">
        <div class="card-header"><h3 class="card-title" style="margin:0;font-size:14px;font-weight:600">While you wait</h3></div>
        <div class="card-body">
          <div style="display:grid;grid-template-columns:1fr;gap:10px">${altLinksHtml}</div>
        </div>
      </div>`
        : ''
    }
  `

  res.send(
    sellerLayout({
      title: opts.title,
      storeName: store.name,
      storeSlug: store.slug,
      userName: user.name,
      userEmail: user.email,
      userRole: user.role,
      storeRole: user.storeRole,
      theme: theme as 'dark' | 'light',
      activePage: 'online-store',
      content,
    }),
  )
}

// ---------------------------------------------------------------------------
// GET /online-store/landing — Landing Pages (Sprint 3)
// ---------------------------------------------------------------------------

export function getLandingPages(req: Request, res: Response): void {
  const base = `/admin/store/${req.store!.slug}`
  renderStub(req, res, {
    title: 'Landing pages',
    subtitle: 'Drag-and-drop builder for high-conversion campaign pages.',
    sprint: 'Sprint 3',
    description:
      'A client-side builder (React) that lets you compose hero sections, product grids, testimonials, FAQs, ' +
      'and tracking pixels into a single landing page. Output is stored as JSON and rendered SSR by the ' +
      'storefront so it stays SEO-friendly.',
    altLinks: [
      {
        label: 'CMS Pages',
        href: `${base}/online-store/pages`,
        hint: 'Create a standard page with rich-text content until the landing-page builder ships.',
      },
      {
        label: 'Design (Clone a site)',
        href: `${base}/online-store/design`,
        hint: 'Clone an existing high-converting landing page into your theme.',
      },
    ],
  })
}

// ---------------------------------------------------------------------------
// GET /online-store/watermark — Retroactive Watermark (Sprint 4)
// ---------------------------------------------------------------------------

export function getWatermarkPage(req: Request, res: Response): void {
  const base = `/admin/store/${req.store!.slug}`
  renderStub(req, res, {
    title: 'Watermark',
    subtitle: 'Apply your logo or branding mark to existing product images.',
    sprint: 'Sprint 4',
    description:
      'Upload a logo, configure position (top-left, top-right, bottom-left, bottom-right, center) and ' +
      'opacity, then run an "Apply to existing products" background job. Sprint 4 ships retroactive ' +
      'processing only — new uploads are not auto-watermarked so you retain full control over each image.',
    altLinks: [
      {
        label: 'Files library',
        href: `${base}/online-store/files`,
        hint: 'Upload pre-watermarked images manually.',
      },
      {
        label: 'Products',
        href: `${base}/products`,
        hint: 'Edit product images one-at-a-time today.',
      },
    ],
  })
}

// ---------------------------------------------------------------------------
// GET /online-store/size-charts — Lenful-backed size charts (Sprint 4)
// ---------------------------------------------------------------------------

export function getSizeChartsPage(req: Request, res: Response): void {
  const base = `/admin/store/${req.store!.slug}`
  renderStub(req, res, {
    title: 'Size charts',
    subtitle: 'Attach size charts to products for accurate fit guidance.',
    sprint: 'Sprint 4',
    description:
      "Size chart data comes straight from Lenful's product catalog — when a product is linked to a " +
      'Lenful product, its official size chart auto-attaches. You can override per-product, or set a ' +
      'default chart for collections without Lenful mapping.',
    altLinks: [
      {
        label: 'Lenful integration',
        href: `${base}/settings/integrations`,
        hint: 'Configure your Lenful catalog connection.',
      },
      {
        label: 'Products',
        href: `${base}/products`,
        hint: 'Products with Lenful mapping will auto-show the right size chart in Sprint 4.',
      },
    ],
  })
}
