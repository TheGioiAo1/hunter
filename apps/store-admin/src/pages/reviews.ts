/**
 * Store Admin — Product Reviews Management
 *
 * Full reviews moderation with real DB integration.
 * Uses @gbox/core/modules/reviews/service for data.
 */

import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db'
import { sellerLayout, esc } from '../layouts/seller-layout.js'
import {
  getShopReviews,
  updateReviewStatus,
  deleteReview,
  bulkUpdateReviewStatus,
  getReview,
  approveReview,
  replyToReview,
} from '@gbox/core/modules/reviews/service.js'
import { notify, byActor } from '../lib/notify.js'

import { getSessionTokenFromCookies } from '@gbox/core/modules/auth/session.js'
import { createApiContext } from '../lib/product-api-client.js'
import { ProductApiError } from '../lib/product-api-errors.js'
import {
  listReviews as apiListReviews,
  bulkApproveReviews as apiBulkApproveReviews,
  deleteReview as apiDeleteReview,
  bulkDeleteReviews as apiBulkDeleteReviews,
  addReplyToReview as apiAddReplyToReview,
  clearLastReplyFromReview as apiClearLastReplyFromReview,
} from '../lib/review-api-client.js'
import { apiToDisplayReview, type DisplayReviewStatus } from '../lib/review-api-types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function starRating(rating: number): string {
  return [1, 2, 3, 4, 5]
    .map(
      i =>
        `<svg width="16" height="16" viewBox="0 0 24 24" fill="${i <= rating ? '#eab308' : 'none'}" stroke="#eab308" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26"/></svg>`,
    )
    .join('')
}

function statusBadge(status: string): string {
  const cls =
    status === 'approved'
      ? 'badge-success'
      : status === 'rejected'
        ? 'badge-danger'
        : status === 'spam'
          ? 'badge-neutral'
          : 'badge-warning'
  return `<span class="badge ${cls}" style="font-size:11px">${status.charAt(0).toUpperCase() + status.slice(1)}</span>`
}

/**
 * Coerce the submitted id list from a bulk-action form into a
 * string[]. Form posts either `review_ids=a&review_ids=b&review_ids=c`
 * (Express parses that as ['a','b','c']) or `review_ids=solo` (Express
 * parses as 'solo'), or the field may be absent entirely.
 */
function parseReviewIdList(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map((x) => String(x)).filter((s) => s.length > 0)
  }
  if (typeof raw === 'string' && raw.length > 0) return [raw]
  return []
}

// ---------------------------------------------------------------------------
// GET /reviews — Reviews list with real data + moderation
// ---------------------------------------------------------------------------

export async function getReviews(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const theme = (req as any).theme || 'dark'
  const hasDb = !!db && typeof (db as any).selectFrom === 'function'

  const page = Math.max(1, parseInt(req.query.page as string) || 1)
  const perPage = 25
  const statusFilter = (req.query.status as string) || undefined

  let reviews: any[] = []
  let total = 0
  let pendingCount = 0
  let totalAll = 0
  let approvedCount = 0
  let avgRating = 0
  let spamCount = 0

  if (!hasDb) {
    // API MODE — gọi BE Gbox-Product-Service-V2/ReviewController.
    // Các quirks (đã ghi nhớ trong memory):
    //  - shop_id ở BE là 24-hex ObjectId, không phải store.slug → dùng
    //    createApiContext (resolve từ store.id hoặc JWT.Shops[0]).
    //  - Singleton _FieldsDefault pollution → client tự pass explicit fields.
    //  - Status enum BE = pending/approcess/refuse, mapping qua review-api-types.
    let ctx
    try {
      ctx = createApiContext(req)
    } catch (err: any) {
      res.status(401).send(`Auth error: ${esc(err?.message || 'unknown')}`)
      return
    }

    // Spam ẩn ở API mode (BE không hỗ trợ). Status khác → undefined = no filter.
    const apiStatusFilter: DisplayReviewStatus | undefined =
      statusFilter === 'pending' || statusFilter === 'approved' || statusFilter === 'rejected'
        ? statusFilter
        : undefined

    try {
      // 4 fetches parallel: page chính + 3 counts (limit=1, fields=id chỉ để
      // lấy pagination.count). BE Count rẻ — CountDocumentsAsync có index shop_id.
      const countFields = 'id'
      const [main, pendingResp, approvedResp, rejectedResp] = await Promise.all([
        apiListReviews(ctx, { page, limit: perPage, status: apiStatusFilter }),
        apiListReviews(ctx, { limit: 1, status: 'pending', fields: countFields }),
        apiListReviews(ctx, { limit: 1, status: 'approved', fields: countFields }),
        apiListReviews(ctx, { limit: 1, status: 'rejected', fields: countFields }),
      ])

      reviews = (main.data ?? []).map(apiToDisplayReview)
      total = main.pagination?.count ?? reviews.length
      pendingCount = pendingResp.pagination?.count ?? 0
      approvedCount = approvedResp.pagination?.count ?? 0
      const rejectedCount = rejectedResp.pagination?.count ?? 0
      spamCount = 0
      totalAll = pendingCount + approvedCount + rejectedCount

      // avgRating: BE chưa expose summary endpoint. Tính tạm trên approved của
      // page hiện tại — chỉ indicative. Cải thiện sau khi BE expose SummaryAsync.
      const approvedOnPage = reviews.filter((r: any) => r.status === 'approved')
      if (approvedOnPage.length > 0) {
        avgRating =
          approvedOnPage.reduce((s: number, rv: any) => s + Number(rv.rating), 0) /
          approvedOnPage.length
      }
    } catch (err: any) {
      const msg = err instanceof ProductApiError
        ? `${err.kind}: ${err.message}`
        : String(err?.message || err)
      console.error('[reviews] API mode list failed:', msg)
      // Không 500 — render trang trống để moderator vẫn dùng được nav/stats.
      reviews = []
      total = 0
    }
  } else {
    // DB MODE
    const [result, pendingResult] = await Promise.all([
      getShopReviews(db, store.id, statusFilter as any, {
        limit: perPage,
        offset: (page - 1) * perPage,
      }),
      getShopReviews(db, store.id, 'pending', { limit: 0, offset: 0 }),
    ])

    reviews = result.reviews as any[]
    total = result.total
    pendingCount = pendingResult.total

    let allResult: any = result
    if (statusFilter) {
      allResult = await getShopReviews(db, store.id, undefined, { limit: 0, offset: 0 })
    }
    totalAll = allResult.total

    const approvedResult = await getShopReviews(db, store.id, 'approved', { limit: 0, offset: 0 })
    approvedCount = approvedResult.total

    if (reviews.length > 0) {
      const approvedReviews = reviews.filter((r: any) => r.status === 'approved')
      if (approvedReviews.length > 0) {
        avgRating = approvedReviews.reduce((s: number, rv: any) => s + Number(rv.rating), 0) / approvedReviews.length
      }
    }

    const spamResult = await getShopReviews(db, store.id, 'spam', { limit: 0, offset: 0 })
    spamCount = spamResult.total
  }

  const totalPages = Math.ceil(total / perPage) || 1
  const filters: Array<{ label: string; value: string; count: number | null }> = [
    { label: 'All', value: '', count: totalAll },
    { label: 'Pending', value: 'pending', count: pendingCount },
    { label: 'Approved', value: 'approved', count: approvedCount },
    { label: 'Rejected', value: 'rejected', count: null },
    // Spam ẩn ở API mode — BE Gbox-Product-Service-V2 không có status spam.
    ...(hasDb ? [{ label: 'Spam', value: 'spam', count: spamCount }] : []),
  ]
  const activeFilter = statusFilter || ''

  const filterTabs = filters
    .map(
      f => `
    <a href="?status=${f.value}${page > 1 ? '&page=1' : ''}"
       style="padding:6px 14px;font-size:13px;font-weight:${activeFilter === f.value ? '600' : '400'};
              color:${activeFilter === f.value ? 'var(--s-text-primary)' : 'var(--s-text-secondary)'};
              border-bottom:2px solid ${activeFilter === f.value ? 'var(--s-accent,#6366f1)' : 'transparent'};
              text-decoration:none;white-space:nowrap">
      ${f.label}${f.count !== null ? ` (${f.count})` : ''}
    </a>`,
    )
    .join('')

  const csrf = esc((req as any).csrfToken || '')

  const tableRows =
    reviews.length === 0
      ? `<tr><td colspan="8" style="text-align:center;padding:48px 12px;color:var(--s-text-secondary)">
          <div style="margin-bottom:8px">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="opacity:.4">
              <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>
            </svg>
          </div>
          <div style="font-weight:600;font-size:14px;color:var(--s-text-primary);margin-bottom:4px">No reviews${statusFilter ? ` with status "${statusFilter}"` : ''}</div>
          <div style="font-size:13px">Reviews will appear here once customers leave feedback.</div>
         </td></tr>`
      : reviews
          .map((r: any) => {
            const date = new Date(r.created_at).toLocaleDateString()
            const hasReply = !!(r.reply_body && r.replied_at)
            const replyBlock = hasReply
              ? `<div style="margin-top:8px;padding:8px 10px;background:var(--s-bg);border-left:3px solid var(--s-accent,#6366f1);border-radius:0 6px 6px 0">
                   <div style="font-size:11px;font-weight:600;color:var(--s-text-secondary);margin-bottom:2px">Your reply${r.reply_author ? ` · ${esc(r.reply_author)}` : ''}</div>
                   <div style="font-size:12px;color:var(--s-text-primary)">${esc(r.reply_body)}</div>
                 </div>`
              : ''
            // Reply form — inline textarea that posts to /reply. Hidden
            // until the user clicks the "Reply" toggle (a details tag
            // keeps this 100% CSS-only, no JS needed).
            const replyForm = `
              <details style="margin-top:6px">
                <summary style="font-size:11px;color:var(--s-text-secondary);cursor:pointer;user-select:none">${hasReply ? 'Edit reply' : 'Reply'}</summary>
                <form method="POST" action="/admin/store/${esc(store.slug)}/products/reviews/${esc(r.id)}/reply" style="margin-top:6px;display:flex;flex-direction:column;gap:6px">
                  <input type="hidden" name="_csrf" value="${csrf}" />
                  <textarea name="reply_body" rows="2" maxlength="2000" placeholder="Thanks for your feedback!" style="width:100%;font-size:12px;padding:6px;border:1px solid var(--s-border);border-radius:6px;background:var(--s-bg);color:var(--s-text-primary);resize:vertical">${esc(r.reply_body ?? '')}</textarea>
                  <div style="display:flex;gap:6px">
                    <button type="submit" class="btn btn-sm" style="font-size:11px;padding:4px 10px;background:var(--s-accent,#6366f1);color:#fff;border:0;border-radius:4px;cursor:pointer">${hasReply ? 'Update reply' : 'Post reply'}</button>
                    ${hasReply ? `<button type="submit" name="clear" value="1" class="btn btn-sm" style="font-size:11px;padding:4px 10px;background:var(--s-bg);border:1px solid var(--s-border);border-radius:4px;color:var(--s-text-secondary);cursor:pointer">Clear</button>` : ''}
                  </div>
                </form>
              </details>
            `
            // Phase 10 PR3 — compact metadata strip: profanity flag +
            // photo count + helpful/unhelpful counts. Rendered below the
            // review body so the table stays scannable.
            const profanityHits = Number(r.profanity_hits ?? 0)
            const photosCount = Number(r.photos_count ?? 0)
            const helpfulCount = Number(r.helpful_count ?? 0)
            const unhelpfulCount = Number(r.unhelpful_count ?? 0)
            const metaBits: string[] = []
            if (profanityHits > 0) {
              metaBits.push(
                `<span title="${profanityHits} profanity hit(s) — review is held for moderation" style="display:inline-flex;align-items:center;gap:4px;font-size:11px;padding:2px 6px;border-radius:4px;background:#ef444422;color:#ef4444;font-weight:600">⚠️ Flagged</span>`,
              )
            }
            if (photosCount > 0) {
              metaBits.push(
                `<span title="${photosCount} attached photo(s)" style="display:inline-flex;align-items:center;gap:4px;font-size:11px;padding:2px 6px;border-radius:4px;background:var(--s-bg);color:var(--s-text-secondary)">📷 ${photosCount}</span>`,
              )
            }
            if (helpfulCount > 0 || unhelpfulCount > 0) {
              metaBits.push(
                `<span title="Helpful / unhelpful votes from shoppers" style="display:inline-flex;align-items:center;gap:4px;font-size:11px;padding:2px 6px;border-radius:4px;background:var(--s-bg);color:var(--s-text-secondary)">👍 ${helpfulCount} · 👎 ${unhelpfulCount}</span>`,
              )
            }
            const metaStrip = metaBits.length
              ? `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px">${metaBits.join('')}</div>`
              : ''

            return `<tr style="border-bottom:1px solid var(--s-border)">
            <td style="padding:10px 12px"><input type="checkbox" name="review_ids" value="${esc(r.id)}" form="bulk-form" /></td>
            <td style="padding:10px 12px">${starRating(Number(r.rating))}</td>
            <td style="padding:10px 12px;max-width:320px">
              <div style="font-weight:600;font-size:13px;color:var(--s-text-primary);margin-bottom:2px">${esc(r.title || '(No title)')}</div>
              <div style="font-size:12px;color:var(--s-text-secondary);max-width:320px">${esc((r.body || '').slice(0, 200))}</div>
              ${metaStrip}
              ${replyBlock}
              ${replyForm}
            </td>
            <td style="padding:10px 12px;font-size:13px;color:var(--s-text-primary)">${esc(r.author_name || 'Anonymous')}</td>
            <td style="padding:10px 12px">${statusBadge(r.status)}</td>
            <td style="padding:10px 12px;font-size:12px;color:var(--s-text-secondary)">${r.product_id ? esc(String(r.product_id).slice(0, 8)) + '...' : '-'}</td>
            <td style="padding:10px 12px;font-size:12px;color:var(--s-text-secondary)">${date}</td>
            <td style="padding:10px 12px;white-space:nowrap">
              ${r.status !== 'approved' ? `<form method="POST" action="/admin/store/${esc(store.slug)}/products/reviews/${esc(r.id)}/approve" style="display:inline"><input type="hidden" name="_csrf" value="${csrf}" /><button type="submit" class="btn btn-sm" style="font-size:11px;padding:4px 8px;background:#22c55e22;border:1px solid #22c55e44;border-radius:4px;color:#22c55e;cursor:pointer;margin-right:4px" title="Approve">Approve</button></form>` : ''}
              ${r.status !== 'rejected' ? `<form method="POST" action="/admin/store/${esc(store.slug)}/products/reviews/${esc(r.id)}/reject" style="display:inline"><input type="hidden" name="_csrf" value="${csrf}" /><button type="submit" class="btn btn-sm" style="font-size:11px;padding:4px 8px;background:#ef444422;border:1px solid #ef444444;border-radius:4px;color:#ef4444;cursor:pointer;margin-right:4px" title="Reject">Reject</button></form>` : ''}
              <form method="POST" action="/admin/store/${esc(store.slug)}/products/reviews/${esc(r.id)}/delete" style="display:inline"><input type="hidden" name="_csrf" value="${csrf}" /><button type="submit" class="btn btn-sm" style="font-size:11px;padding:4px 8px;background:var(--s-bg);border:1px solid var(--s-border);border-radius:4px;color:var(--s-text-secondary);cursor:pointer" onclick="return confirm('Delete this review permanently?')" title="Delete">Del</button></form>
            </td>
          </tr>`
          })
          .join('')

  const pagination =
    total > perPage
      ? `
    <div style="display:flex;justify-content:center;gap:8px;margin-top:16px">
      ${page > 1 ? `<a href="?${statusFilter ? 'status=' + statusFilter + '&' : ''}page=${page - 1}" class="btn btn-sm" style="font-size:12px;padding:6px 12px;background:var(--s-bg);border:1px solid var(--s-border);border-radius:6px;color:var(--s-text-primary);text-decoration:none">&laquo; Prev</a>` : ''}
      <span style="padding:6px 12px;font-size:12px;color:var(--s-text-secondary)">Page ${page} of ${totalPages}</span>
      ${page < totalPages ? `<a href="?${statusFilter ? 'status=' + statusFilter + '&' : ''}page=${page + 1}" class="btn btn-sm" style="font-size:12px;padding:6px 12px;background:var(--s-bg);border:1px solid var(--s-border);border-radius:6px;color:var(--s-text-primary);text-decoration:none">Next &raquo;</a>` : ''}
    </div>
  `
      : ''

  const content = `
    <div class="page-header" style="display:flex;align-items:center;justify-content:space-between;margin-bottom:24px">
      <div>
        <h1 style="margin:0;font-size:22px;font-weight:700">Product Reviews</h1>
        <p style="margin:4px 0 0;color:var(--s-text-secondary);font-size:13px">Manage customer reviews for ${esc(store.name)}</p>
      </div>
      <div>
        <a href="/admin/store/${esc(store.slug)}/products/reviews/settings"
           class="btn btn-sm"
           style="font-size:12px;padding:8px 14px;background:var(--s-bg);border:1px solid var(--s-border);border-radius:6px;color:var(--s-text-primary);text-decoration:none">
          Review settings
        </a>
      </div>
    </div>

    <!-- Stats -->
    <div class="stats-grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px;margin-bottom:24px">
      <div class="stat-card" style="background:var(--s-surface);border:1px solid var(--s-border);border-radius:10px;padding:20px">
        <div style="font-size:12px;font-weight:600;color:var(--s-text-secondary);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">Total Reviews</div>
        <div style="font-size:28px;font-weight:700;color:var(--s-text-primary)">${totalAll}</div>
      </div>
      <div class="stat-card" style="background:var(--s-surface);border:1px solid var(--s-border);border-radius:10px;padding:20px">
        <div style="font-size:12px;font-weight:600;color:var(--s-text-secondary);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">Pending Moderation</div>
        <div style="font-size:28px;font-weight:700;color:${pendingCount > 0 ? '#f59e0b' : 'var(--s-text-primary)'}">${pendingCount}</div>
      </div>
      <div class="stat-card" style="background:var(--s-surface);border:1px solid var(--s-border);border-radius:10px;padding:20px">
        <div style="font-size:12px;font-weight:600;color:var(--s-text-secondary);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">Approved</div>
        <div style="font-size:28px;font-weight:700;color:#34d399">${approvedCount}</div>
      </div>
      <div class="stat-card" style="background:var(--s-surface);border:1px solid var(--s-border);border-radius:10px;padding:20px">
        <div style="font-size:12px;font-weight:600;color:var(--s-text-secondary);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">Avg Rating</div>
        <div style="font-size:28px;font-weight:700;color:var(--s-text-primary)">${avgRating > 0 ? avgRating.toFixed(1) : 'N/A'}</div>
      </div>
    </div>

    <!-- Filter Tabs -->
    <div style="display:flex;gap:4px;border-bottom:1px solid var(--s-border);margin-bottom:0">
      ${filterTabs}
    </div>

    <!--
      Bulk-action form. Lives outside the table so each row's
      checkbox can reference it via form="bulk-form" — that lets
      a single <form> collect checkboxes scattered across the rows
      without the rows being nested inside <form> (which is invalid
      inside <table>/<tbody>). The bulk action buttons live in a
      bar above the table and also reference form="bulk-form".
    -->
    <form id="bulk-form" method="POST" action="/admin/store/${esc(store.slug)}/products/reviews/bulk" style="display:none">
      <input type="hidden" name="_csrf" value="${csrf}" />
    </form>

    <!-- Reviews Table -->
    <div class="card" style="background:var(--s-surface);border:1px solid var(--s-border);border-top:none;border-radius:0 0 10px 10px;padding:24px;margin-bottom:24px">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px;flex-wrap:wrap">
        <div style="font-size:12px;color:var(--s-text-secondary)">Select rows to run a bulk action.</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          <button type="submit" form="bulk-form" name="action" value="approve"
                  class="btn btn-sm" style="font-size:12px;padding:6px 12px;background:#22c55e22;border:1px solid #22c55e44;border-radius:6px;color:#22c55e;cursor:pointer">Approve selected</button>
          <button type="submit" form="bulk-form" name="action" value="reject"
                  class="btn btn-sm" style="font-size:12px;padding:6px 12px;background:#ef444422;border:1px solid #ef444444;border-radius:6px;color:#ef4444;cursor:pointer">Reject selected</button>
          <button type="submit" form="bulk-form" name="action" value="spam"
                  class="btn btn-sm" style="font-size:12px;padding:6px 12px;background:var(--s-bg);border:1px solid var(--s-border);border-radius:6px;color:var(--s-text-secondary);cursor:pointer">Mark as spam</button>
          <button type="submit" form="bulk-form" name="action" value="delete"
                  class="btn btn-sm" style="font-size:12px;padding:6px 12px;background:var(--s-bg);border:1px solid var(--s-border);border-radius:6px;color:var(--s-text-secondary);cursor:pointer"
                  onclick="return confirm('Delete the selected reviews permanently?')">Delete selected</button>
        </div>
      </div>
      <div class="data-table" style="overflow-x:auto">
        <table style="width:100%;border-collapse:collapse;font-size:13px">
          <thead>
            <tr style="border-bottom:1px solid var(--s-border)">
              <th style="text-align:left;padding:10px 12px;font-weight:600;color:var(--s-text-secondary);font-size:11px;text-transform:uppercase;letter-spacing:.5px;width:32px"><input type="checkbox" onclick="document.querySelectorAll('input[name=review_ids]').forEach(c=>c.checked=this.checked)" title="Select all on this page" /></th>
              <th style="text-align:left;padding:10px 12px;font-weight:600;color:var(--s-text-secondary);font-size:11px;text-transform:uppercase;letter-spacing:.5px">Rating</th>
              <th style="text-align:left;padding:10px 12px;font-weight:600;color:var(--s-text-secondary);font-size:11px;text-transform:uppercase;letter-spacing:.5px">Review</th>
              <th style="text-align:left;padding:10px 12px;font-weight:600;color:var(--s-text-secondary);font-size:11px;text-transform:uppercase;letter-spacing:.5px">Author</th>
              <th style="text-align:left;padding:10px 12px;font-weight:600;color:var(--s-text-secondary);font-size:11px;text-transform:uppercase;letter-spacing:.5px">Status</th>
              <th style="text-align:left;padding:10px 12px;font-weight:600;color:var(--s-text-secondary);font-size:11px;text-transform:uppercase;letter-spacing:.5px">Product</th>
              <th style="text-align:left;padding:10px 12px;font-weight:600;color:var(--s-text-secondary);font-size:11px;text-transform:uppercase;letter-spacing:.5px">Date</th>
              <th style="text-align:left;padding:10px 12px;font-weight:600;color:var(--s-text-secondary);font-size:11px;text-transform:uppercase;letter-spacing:.5px">Actions</th>
            </tr>
          </thead>
          <tbody>${tableRows}</tbody>
        </table>
      </div>
      ${pagination}
    </div>
  `

  res.send(
    sellerLayout({
      title: 'Product Reviews',
      storeName: store.name,
      storeSlug: store.slug,
      userName: user.name,
      userEmail: user.email,
      userRole: user.role,
      storeRole: user.storeRole,
      activePage: 'products',
      content,
      theme: theme as 'dark' | 'light',
    }),
  )
}

// ---------------------------------------------------------------------------
// POST /reviews/:reviewId/approve — Approve a review
// ---------------------------------------------------------------------------

export async function postApproveReview(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser
  const hasDb = !!db && typeof (db as any).selectFrom === 'function'

  if (!hasDb) {
    try {
      const ctx = createApiContext(req)
      await apiBulkApproveReviews(ctx, [String(req.params.reviewId)], 'approved')
      res.redirect(`/admin/store/${store.slug}/products/reviews?success=approved`)
    } catch (err: any) {
      const msg = err instanceof ProductApiError ? `${err.kind}: ${err.message}` : (err?.message ?? 'unknown')
      res.redirect(`/admin/store/${store.slug}/products/reviews?error=${encodeURIComponent(msg)}`)
    }
    return
  }

  try {
    await approveReview(db, req.params.reviewId, {
      shopName: store.name,
    })
    notify(db, {
      shopId: store.id,
      userId: user?.id,
      type: 'review_approved',
      title: 'Review approved',
      message: byActor(user),
      resourceType: 'review',
      resourceId: req.params.reviewId,
    })
    res.redirect(`/admin/store/${store.slug}/products/reviews?success=approved`)
  } catch (err: any) {
    res.redirect(`/admin/store/${store.slug}/products/reviews?error=${encodeURIComponent(err.message)}`)
  }
}

// ---------------------------------------------------------------------------
// POST /reviews/:reviewId/reject — Reject a review
// ---------------------------------------------------------------------------

export async function postRejectReview(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser
  const hasDb = !!db && typeof (db as any).selectFrom === 'function'

  if (!hasDb) {
    try {
      const ctx = createApiContext(req)
      await apiBulkApproveReviews(ctx, [String(req.params.reviewId)], 'rejected')
      res.redirect(`/admin/store/${store.slug}/products/reviews?success=rejected`)
    } catch (err: any) {
      const msg = err instanceof ProductApiError ? `${err.kind}: ${err.message}` : (err?.message ?? 'unknown')
      res.redirect(`/admin/store/${store.slug}/products/reviews?error=${encodeURIComponent(msg)}`)
    }
    return
  }

  try {
    await updateReviewStatus(db, req.params.reviewId, 'rejected')
    notify(db, {
      shopId: store.id,
      userId: user?.id,
      type: 'review_rejected',
      title: 'Review rejected',
      message: byActor(user),
      resourceType: 'review',
      resourceId: req.params.reviewId,
    })
    res.redirect(`/admin/store/${store.slug}/products/reviews?success=rejected`)
  } catch (err: any) {
    res.redirect(`/admin/store/${store.slug}/products/reviews?error=${encodeURIComponent(err.message)}`)
  }
}

// ---------------------------------------------------------------------------
// POST /reviews/:reviewId/delete — Delete a review
// ---------------------------------------------------------------------------

export async function postDeleteReview(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser
  const hasDb = !!db && typeof (db as any).selectFrom === 'function'

  if (!hasDb) {
    try {
      const ctx = createApiContext(req)
      await apiDeleteReview(ctx, String(req.params.reviewId))
      res.redirect(`/admin/store/${store.slug}/products/reviews?success=deleted`)
    } catch (err: any) {
      const msg = err instanceof ProductApiError ? `${err.kind}: ${err.message}` : (err?.message ?? 'unknown')
      res.redirect(`/admin/store/${store.slug}/products/reviews?error=${encodeURIComponent(msg)}`)
    }
    return
  }

  try {
    await deleteReview(db, req.params.reviewId)
    notify(db, {
      shopId: store.id,
      userId: user?.id,
      type: 'review_deleted',
      title: 'Review deleted',
      message: byActor(user),
      resourceType: 'review',
      resourceId: req.params.reviewId,
    })
    res.redirect(`/admin/store/${store.slug}/products/reviews?success=deleted`)
  } catch (err: any) {
    res.redirect(`/admin/store/${store.slug}/products/reviews?error=${encodeURIComponent(err.message)}`)
  }
}

// ---------------------------------------------------------------------------
// POST /reviews/:reviewId/reply — Post / update / clear merchant reply
// ---------------------------------------------------------------------------

export async function postReply(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser
  const reviewId = req.params.reviewId
  const hasDb = !!db && typeof (db as any).selectFrom === 'function'

  if (!hasDb) {
    try {
      const ctx = createApiContext(req)
      const apiReviewId = String(reviewId)
      const body = req.body as { reply_body?: string; clear?: string } | undefined
      const clearFlag = body?.clear === '1' || body?.clear === 'true'
      if (clearFlag) {
        await apiClearLastReplyFromReview(ctx, apiReviewId)
      } else {
        const content = (body?.reply_body ?? '').trim()
        if (!content) {
          res.redirect(`/admin/store/${store.slug}/products/reviews?error=${encodeURIComponent('Reply is empty')}`)
          return
        }
        const author = user?.name || user?.email || 'Merchant'
        await apiAddReplyToReview(ctx, apiReviewId, { name: author, content })
      }
      res.redirect(`/admin/store/${store.slug}/products/reviews?success=${clearFlag ? 'reply_cleared' : 'reply_posted'}`)
    } catch (err: any) {
      const msg = err instanceof ProductApiError ? `${err.kind}: ${err.message}` : (err?.message ?? 'unknown')
      res.redirect(`/admin/store/${store.slug}/products/reviews?error=${encodeURIComponent(msg)}`)
    }
    return
  }

  try {
    // Shop-scope guard: confirm the review belongs to this store before
    // editing. `getReview` doesn't take a shop filter so we check the
    // returned row manually.
    const existing = await getReview(db, reviewId)
    if (!existing || existing.shop_id !== store.id) {
      res.redirect(`/admin/store/${store.slug}/products/reviews?error=${encodeURIComponent('Review not found')}`)
      return
    }

    const body = req.body as { reply_body?: string; clear?: string } | undefined
    const clearFlag = body?.clear === '1' || body?.clear === 'true'
    const replyBody = clearFlag ? null : (body?.reply_body ?? null)
    const replyAuthor = clearFlag ? null : (user?.name || user?.email || null)

    // Phase 10 PR3 — wrapper respects `notify_customer_on_reply` and
    // fires the review-reply email when appropriate. Cleared replies
    // (null body) skip the email automatically.
    await replyToReview(db, reviewId, replyBody, replyAuthor, {
      shopName: store.name,
    })

    notify(db, {
      shopId: store.id,
      userId: user?.id,
      type: 'review_replied',
      title: clearFlag ? 'Review reply cleared' : 'Review reply posted',
      message: byActor(user),
      resourceType: 'review',
      resourceId: reviewId,
    })

    res.redirect(`/admin/store/${store.slug}/products/reviews?success=${clearFlag ? 'reply_cleared' : 'reply_posted'}`)
  } catch (err: any) {
    res.redirect(`/admin/store/${store.slug}/products/reviews?error=${encodeURIComponent(err.message)}`)
  }
}

// ---------------------------------------------------------------------------
// POST /reviews/bulk — Run a moderation action across selected reviews
// ---------------------------------------------------------------------------

/**
 * Bulk action dispatcher. Reads `action` + `review_ids[]` from the
 * submitted form and routes to the right service call:
 *
 *   action=approve | reject | spam  → bulkUpdateReviewStatus
 *   action=delete                    → delete each review, sequentially
 *
 * Empty selection is a silent no-op that just redirects back with a
 * neutral error so non-JS browsers aren't left staring at a blank page.
 * All writes are shop-scoped via bulkUpdateReviewStatus (internal
 * .where('shop_id', '=', shopId)) or via getReview + shop_id check
 * on the delete path.
 */
export async function postBulkAction(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser
  const hasDb = !!db && typeof (db as any).selectFrom === 'function'

  const body = (req.body ?? {}) as { action?: string; review_ids?: unknown }
  const action = String(body.action ?? '')
  const ids = parseReviewIdList(body.review_ids)

  if (ids.length === 0) {
    res.redirect(`/admin/store/${store.slug}/products/reviews?error=${encodeURIComponent('No reviews selected')}`)
    return
  }

  if (!hasDb) {
    try {
      const ctx = createApiContext(req)
      let summary = ''
      if (action === 'approve') {
        await apiBulkApproveReviews(ctx, ids, 'approved')
        summary = `${ids.length} approved`
      } else if (action === 'reject') {
        await apiBulkApproveReviews(ctx, ids, 'rejected')
        summary = `${ids.length} rejected`
      } else if (action === 'delete') {
        await apiBulkDeleteReviews(ctx, ids)
        summary = `${ids.length} deleted`
      } else if (action === 'spam') {
        // BE Gbox-Product-Service-V2 không có status 'spam' — chỉ pending/approcess/refuse.
        res.redirect(
          `/admin/store/${store.slug}/products/reviews?error=${encodeURIComponent('Spam action not supported by API')}`,
        )
        return
      } else {
        res.redirect(`/admin/store/${store.slug}/products/reviews?error=${encodeURIComponent('Unknown action')}`)
        return
      }
      res.redirect(`/admin/store/${store.slug}/products/reviews?success=${encodeURIComponent(summary)}`)
    } catch (err: any) {
      const msg = err instanceof ProductApiError ? `${err.kind}: ${err.message}` : (err?.message ?? 'unknown')
      res.redirect(`/admin/store/${store.slug}/products/reviews?error=${encodeURIComponent(msg)}`)
    }
    return
  }

  try {
    let summary = ''
    let notifType: 'review_approved' | 'review_rejected' | 'review_spam_flagged' | 'review_deleted' = 'review_approved'

    if (action === 'approve') {
      await bulkUpdateReviewStatus(db, store.id, ids, 'approved')
      summary = `${ids.length} approved`
      notifType = 'review_approved'
    } else if (action === 'reject') {
      await bulkUpdateReviewStatus(db, store.id, ids, 'rejected')
      summary = `${ids.length} rejected`
      notifType = 'review_rejected'
    } else if (action === 'spam') {
      await bulkUpdateReviewStatus(db, store.id, ids, 'spam')
      summary = `${ids.length} marked spam`
      notifType = 'review_spam_flagged'
    } else if (action === 'delete') {
      // Delete path — shop-scope each row individually. Done
      // sequentially because the set is bounded to whatever fits on
      // one page of the admin table (25 by default).
      for (const id of ids) {
        const existing = await getReview(db, id)
        if (existing && existing.shop_id === store.id) {
          await deleteReview(db, id)
        }
      }
      summary = `${ids.length} deleted`
      notifType = 'review_deleted'
    } else {
      res.redirect(`/admin/store/${store.slug}/products/reviews?error=${encodeURIComponent('Unknown action')}`)
      return
    }

    notify(db, {
      shopId: store.id,
      userId: user?.id,
      type: notifType,
      title: `Bulk action: ${summary}`,
      message: byActor(user),
      resourceType: 'review',
      resourceId: null,
    })

    res.redirect(`/admin/store/${store.slug}/products/reviews?success=${encodeURIComponent(summary)}`)
  } catch (err: any) {
    res.redirect(`/admin/store/${store.slug}/products/reviews?error=${encodeURIComponent(err.message)}`)
  }
}
