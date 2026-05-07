/**
 * God Admin — Content Management (Category D: Content)
 *
 * GET /god-admin/content            — Content overview (pages + blog posts across all stores)
 * GET /god-admin/content/campaigns  — Email campaigns management
 */

import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import type { Database } from '../../../../packages/db/src/index.js'
import { godLayout } from '../layouts/god-layout.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function esc(s: string | null): string {
  if (!s) return ''
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function fmtNum(val: number | string | null): string {
  return Number(val || 0).toLocaleString('en-US')
}

function shortDate(iso: string | null): string {
  if (!iso) return '-'
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function statusBadge(status: string | null): string {
  const s = status || 'draft'
  const map: Record<string, string> = {
    published: 'badge-green',
    active: 'badge-green',
    draft: 'badge-gray',
    archived: 'badge-yellow',
  }
  return `<span class="badge ${map[s] || 'badge-gray'}">${esc(s)}</span>`
}

function typeBadge(type: string): string {
  if (type === 'page') {
    return '<span class="badge badge-yellow">Page</span>'
  }
  return '<span class="badge badge-green">Blog Post</span>'
}

// ---------------------------------------------------------------------------
// GET /god-admin/content — Content Overview Dashboard
// ---------------------------------------------------------------------------

export async function getContent(req: Request, res: Response, db: Kysely<Database>): Promise<void> {
  const user = req.godAdmin!.user

  try {
    const [
      totalPagesRow,
      totalBlogPostsRow,
      publishedPagesRow,
      draftPagesRow,
      publishedBlogPostsRow,
      draftBlogPostsRow,
      recentPages,
      recentBlogPosts,
      contentByStore,
    ] = await Promise.all([
      // Total pages
      db.selectFrom('pages')
        .select(sql<string>`count(*)`.as('count'))
        .executeTakeFirst(),

      // Total blog posts
      db.selectFrom('blog_posts')
        .select(sql<string>`count(*)`.as('count'))
        .executeTakeFirst(),

      // Published pages
      db.selectFrom('pages')
        .where('published', '=', true)
        .select(sql<string>`count(*)`.as('count'))
        .executeTakeFirst(),

      // Draft pages
      db.selectFrom('pages')
        .where('published', '=', false)
        .select(sql<string>`count(*)`.as('count'))
        .executeTakeFirst(),

      // Published blog posts
      db.selectFrom('blog_posts')
        .where('published', '=', true)
        .select(sql<string>`count(*)`.as('count'))
        .executeTakeFirst(),

      // Draft blog posts
      db.selectFrom('blog_posts')
        .where('published', '=', false)
        .select(sql<string>`count(*)`.as('count'))
        .executeTakeFirst(),

      // Recent 20 pages (for combining)
      db.selectFrom('pages as p')
        .leftJoin('shops as s', 's.id', 'p.shop_id')
        .select([
          'p.id',
          'p.title',
          'p.slug',
          sql<string>`case when p.published then 'published' else 'draft' end`.as('status'),
          'p.created_at',
          'p.updated_at',
          's.name as shop_name',
          'p.author',
        ])
        .orderBy('p.created_at', 'desc')
        .limit(20)
        .execute(),

      // Recent 20 blog posts (for combining)
      db.selectFrom('blog_posts as bp')
        .leftJoin('shops as s', 's.id', 'bp.shop_id')
        .select([
          'bp.id',
          'bp.title',
          'bp.slug',
          sql<string>`case when bp.published then 'published' else 'draft' end`.as('status'),
          'bp.created_at',
          'bp.updated_at',
          's.name as shop_name',
          'bp.author',
        ])
        .orderBy('bp.created_at', 'desc')
        .limit(20)
        .execute(),

      // Content by store
      db.selectFrom('shops as s')
        .leftJoin(
          db.selectFrom('pages').groupBy('shop_id').select(['shop_id', sql<string>`count(*)`.as('cnt')]).as('pc'),
          'pc.shop_id', 's.id',
        )
        .leftJoin(
          db.selectFrom('blog_posts').groupBy('shop_id').select(['shop_id', sql<string>`count(*)`.as('cnt')]).as('bc'),
          'bc.shop_id', 's.id',
        )
        .select([
          's.name',
          sql<string>`coalesce(pc.cnt, 0)`.as('page_count'),
          sql<string>`coalesce(bc.cnt, 0)`.as('blog_count'),
        ])
        .orderBy('s.name', 'asc')
        .execute(),
    ])

    const totalPages = Number(totalPagesRow?.count ?? 0)
    const totalBlogPosts = Number(totalBlogPostsRow?.count ?? 0)
    const publishedPages = Number(publishedPagesRow?.count ?? 0)
    const draftPages = Number(draftPagesRow?.count ?? 0)
    const publishedBlogPosts = Number(publishedBlogPostsRow?.count ?? 0)
    const draftBlogPosts = Number(draftBlogPostsRow?.count ?? 0)

    // Combine and sort recent content
    type ContentRow = { id: string; title: string; slug: string; status: string; created_at: string; updated_at: string; shop_name: string; author: string | null; type: string }
    const combined: ContentRow[] = [
      ...recentPages.map((p: any) => ({ ...p, type: 'page' })),
      ...recentBlogPosts.map((bp: any) => ({ ...bp, type: 'blog_post' })),
    ]
    combined.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    const recentContent = combined.slice(0, 20)

    // Summary cards
    const statsHtml = `
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-label">Total Pages</div>
          <div class="stat-value">${fmtNum(totalPages)}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Total Blog Posts</div>
          <div class="stat-value">${fmtNum(totalBlogPosts)}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Published</div>
          <div class="stat-value">${fmtNum(publishedPages + publishedBlogPosts)}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Drafts</div>
          <div class="stat-value">${fmtNum(draftPages + draftBlogPosts)}</div>
        </div>
      </div>`

    // Recent content table
    const recentRows = recentContent.map((c) => `
      <tr>
        <td>${esc(c.title)}</td>
        <td>${typeBadge(c.type)}</td>
        <td>${esc(c.shop_name)}</td>
        <td>${statusBadge(c.status)}</td>
        <td>${esc(c.author)}</td>
        <td>${shortDate(c.updated_at || c.created_at)}</td>
      </tr>`).join('')

    const recentContentHtml = `
      <div class="card">
        <div class="card-title">Recent Content</div>
        <table class="data-table">
          <thead>
            <tr>
              <th>Title</th>
              <th>Type</th>
              <th>Store</th>
              <th>Status</th>
              <th>Author</th>
              <th>Last Updated</th>
            </tr>
          </thead>
          <tbody>
            ${recentRows || '<tr><td colspan="6" style="text-align:center;color:var(--text-muted)">No content found</td></tr>'}
          </tbody>
        </table>
      </div>`

    // Content by store
    const storeRows = contentByStore.map((s: any) => `
      <tr>
        <td>${esc(s.name)}</td>
        <td>${fmtNum(s.page_count)}</td>
        <td>${fmtNum(s.blog_count)}</td>
      </tr>`).join('')

    const contentByStoreHtml = `
      <div class="card">
        <div class="card-title">Content by Store</div>
        <table class="data-table">
          <thead>
            <tr>
              <th>Store Name</th>
              <th>Pages</th>
              <th>Blog Posts</th>
            </tr>
          </thead>
          <tbody>
            ${storeRows || '<tr><td colspan="3" style="text-align:center;color:var(--text-muted)">No stores found</td></tr>'}
          </tbody>
        </table>
      </div>`

    const content = `
      <div class="page-header">
        <h1>Content Management</h1>
      </div>
      ${statsHtml}
      ${recentContentHtml}
      ${contentByStoreHtml}
    `

    res.send(godLayout({
      title: 'Content',
      userEmail: user.email,
      userName: user.name,
      isDefaultAdmin: req.godAdmin?.isDefaultAdmin,
      activePath: '/god-admin/content',
      content,
    }))
  } catch (err) {
    console.error('[God Admin] Content page error:', err)
    res.status(500).send(godLayout({
      title: 'Content',
      userEmail: user.email,
      userName: user.name,
      isDefaultAdmin: req.godAdmin?.isDefaultAdmin,
      activePath: '/god-admin/content',
      content: `<div class="card"><p style="color:var(--red)">Error loading content: ${esc(String(err))}</p></div>`,
    }))
  }
}

// ---------------------------------------------------------------------------
// GET /god-admin/content/campaigns — Email Campaigns Management
// ---------------------------------------------------------------------------

export async function getCampaigns(req: Request, res: Response, db: Kysely<Database>): Promise<void> {
  const user = req.godAdmin!.user

  try {
    const [
      totalSubscribersRow,
      totalCustomersRow,
      storesWithMarketingRow,
    ] = await Promise.all([
      // Total subscribers (customers who accept marketing)
      db.selectFrom('customers')
        .where('accepts_marketing', '=', true)
        .select(sql<string>`count(*)`.as('count'))
        .executeTakeFirst(),

      // Total customers (for opt-in rate)
      db.selectFrom('customers')
        .select(sql<string>`count(*)`.as('count'))
        .executeTakeFirst(),

      // Stores with at least one marketing subscriber
      db.selectFrom('customers')
        .where('accepts_marketing', '=', true)
        .select(sql<string>`count(distinct shop_id)`.as('count'))
        .executeTakeFirst(),
    ])

    const totalSubscribers = Number(totalSubscribersRow?.count ?? 0)
    const totalCustomers = Number(totalCustomersRow?.count ?? 0)
    const storesWithMarketing = Number(storesWithMarketingRow?.count ?? 0)
    const optInRate = totalCustomers > 0 ? ((totalSubscribers / totalCustomers) * 100).toFixed(1) : '0.0'

    // Summary cards
    const statsHtml = `
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-label">Total Subscribers</div>
          <div class="stat-value">${fmtNum(totalSubscribers)}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Stores with Marketing</div>
          <div class="stat-value">${fmtNum(storesWithMarketing)}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Opt-in Rate</div>
          <div class="stat-value">${optInRate}%</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Total Customers</div>
          <div class="stat-value">${fmtNum(totalCustomers)}</div>
        </div>
      </div>`

    // Campaign table placeholder
    const campaignTableHtml = `
      <div class="card">
        <div class="card-title" style="display:flex;justify-content:space-between;align-items:center">
          <span>Campaign Builder</span>
          <button disabled title="Campaign builder ships in Phase 3 (Marketing & Content)." style="padding:8px 16px;border-radius:6px;border:1px solid var(--border);background:var(--surface);color:var(--text-muted);cursor:not-allowed;font-size:13px">
            Create Campaign (Phase 3)
          </button>
        </div>
        <table class="data-table">
          <thead>
            <tr>
              <th>Campaign Name</th>
              <th>Status</th>
              <th>Recipients</th>
              <th>Open Rate</th>
              <th>Click Rate</th>
              <th>Sent At</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td colspan="6" style="text-align:center;color:var(--text-muted);padding:40px 0">
                No campaigns yet. Campaign builder ships in Phase 3 (Marketing &amp; Content).
              </td>
            </tr>
          </tbody>
        </table>
      </div>`

    // Quick stats card
    const quickStatsHtml = `
      <div class="card">
        <div class="card-title">Marketing Quick Stats</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;padding:8px 0">
          <div>
            <div style="color:var(--text-muted);font-size:13px;margin-bottom:4px">Subscribers / Total Customers</div>
            <div style="font-size:18px;font-weight:600">${fmtNum(totalSubscribers)} / ${fmtNum(totalCustomers)}</div>
          </div>
          <div>
            <div style="color:var(--text-muted);font-size:13px;margin-bottom:4px">Opt-in Rate (All Stores)</div>
            <div style="font-size:18px;font-weight:600">${optInRate}%</div>
          </div>
          <div>
            <div style="color:var(--text-muted);font-size:13px;margin-bottom:4px">Stores with Subscribers</div>
            <div style="font-size:18px;font-weight:600">${fmtNum(storesWithMarketing)}</div>
          </div>
        </div>
      </div>`

    const content = `
      <div class="page-header">
        <h1>Email Campaigns</h1>
      </div>
      ${statsHtml}
      ${campaignTableHtml}
      ${quickStatsHtml}
    `

    res.send(godLayout({
      title: 'Campaigns',
      userEmail: user.email,
      userName: user.name,
      isDefaultAdmin: req.godAdmin?.isDefaultAdmin,
      activePath: '/god-admin/content/campaigns',
      content,
    }))
  } catch (err) {
    console.error('[God Admin] Campaigns page error:', err)
    res.status(500).send(godLayout({
      title: 'Campaigns',
      userEmail: user.email,
      userName: user.name,
      isDefaultAdmin: req.godAdmin?.isDefaultAdmin,
      activePath: '/god-admin/content/campaigns',
      content: `<div class="card"><p style="color:var(--red)">Error loading campaigns: ${esc(String(err))}</p></div>`,
    }))
  }
}
