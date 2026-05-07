/**
 * Store-admin — Design Library page (Phase D4)
 *
 * Two tabs rendered from one handler:
 *
 *   - "Gallery" tab (?tab=gallery, default)
 *       Every SEED entry from xaozayta/awesome-design-md. Public across
 *       all sellers — same list for every shop. Filterable by category
 *       chip and a client-side title search.
 *
 *   - "My Clones" tab (?tab=my-clones)
 *       Every CLONE entry stamped by the D2 pipeline hook for the
 *       current shop. No category filter (clone entries have NULL
 *       category by design). Supports delete.
 *
 * Extra GET endpoints on this route:
 *
 *   GET /entry/:source/:slug  → JSON { entry } — AJAX-loaded when the
 *                               preview modal opens. Keeps the grid
 *                               page narrow (58 seed cards × ~4 KB
 *                               designMd = 230 KB would bloat the page
 *                               if we inlined every modal).
 *
 *   GET /preview/:source/:slug[?dark=1]
 *                             → raw preview HTML served into a sandboxed
 *                               iframe. `dark=1` returns the preview-dark
 *                               body (falls back to light if missing).
 *
 * Mutations (delete a clone) live in pages/design-library/actions.ts
 * to keep the file from growing past ~700 LOC.
 *
 * Per Thai's D4 directive (2026-04-18 chat):
 *
 *   - "UI thật chuyên nghiệp, dễ sử dụng" → tabs + chip filter + search,
 *     no giant settings dropdowns, no wall of small buttons.
 *
 *   - "tham khảo một chút ui của getdesign.md" → card grid with summary
 *     + category chip, preview modal with split 2-column (code left,
 *     live preview right), copy + download + clone actions.
 *
 *   - "layout 2 cột … preview sang cột bên phải, code … cột bên trái"
 *     → modal is an explicit 2-column CSS grid; collapses to stacked
 *     on narrow viewports. LEFT = DESIGN.md rendered. RIGHT = iframe
 *     preview with dark-mode toggle.
 *
 *   - "dark mode em làm luôn nhé, lưu ý các lỗi nền trắng khi chuyển"
 *     → every .dl-* selector defines explicit colors; a parent
 *     `[data-theme="dark"]` override flips tokens. We do NOT inherit
 *     from root tokens alone because dialogs escape the flow; a missing
 *     override would produce "white text on white background".
 */

import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db'
import { sellerLayout } from '../layouts/seller-layout.js'
import { renderLibraryTabs } from './library.js'
import {
  listGallery,
  listMyClones,
  countSeedEntries,
  countSeedEntriesByCategory,
  getEntryBySlug,
  DESIGN_LIBRARY_CATEGORIES,
  DESIGN_LIBRARY_CATEGORY_LABELS,
  type DesignLibraryCard,
  type DesignLibraryCategory,
  type DesignLibraryEntry,
  type DesignLibrarySource,
} from '@gbox/core/modules/design-library/index.js'

// ---------------------------------------------------------------------------
// Main page handler
// ---------------------------------------------------------------------------

type Tab = 'gallery' | 'my-clones'

/** GET /admin/store/:slug/design-library[?tab=…&category=…&q=…] */
export async function getDesignLibraryPage(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const base = `/admin/store/${store.slug}`
  const csrfToken = (req as any).csrfToken ?? ''

  const tab = toTab(String((req.query as any).tab ?? 'gallery'))
  const rawCat = String((req.query as any).category ?? '').trim()
  const category: DesignLibraryCategory | null = DESIGN_LIBRARY_CATEGORIES.includes(
    rawCat as DesignLibraryCategory,
  )
    ? (rawCat as DesignLibraryCategory)
    : null
  const q = String((req.query as any).q ?? '').trim().slice(0, 100)

  // Phase F Task F6 (2026-04-18) — onboarding continuity. When a seller
  // arrives here from the welcome page's "Browse full library →" link,
  // the URL carries `?from=onboarding`. Swap the H1 + breadcrumb label
  // to "Theme Library" so the naming stays consistent with what they
  // just saw on Tab 2 of the wizard. Default (no query) keeps the
  // canonical page title for direct nav hits.
  const fromOnboarding = String((req.query as any).from ?? '') === 'onboarding'
  // 2026-04-26 cleanup — Library merge. When the unified `/online-store/library`
  // wrapper invokes us with `?tab=designs`, render the merged-library tab
  // banner above content, switch breadcrumb back-link to /library, and
  // mark the sidebar 'Online Store' parent active (rather than the
  // standalone 'design-library' page that no longer exists in nav).
  const isEmbedded = (res.locals as any).libraryEmbedded === true
  const surfaceLabel = fromOnboarding
    ? 'Theme Library'
    : isEmbedded
      ? 'Design references'
      : 'Design Library'

  // Fetch both counts + the list for the active tab. Keep gallery count
  // always — it's the default-tab badge. Pull clone count separately.
  const [galleryCount, categoryCounts, galleryCards, cloneCards] = await Promise.all([
    countSeedEntries(db),
    countSeedEntriesByCategory(db),
    tab === 'gallery'
      ? listGallery(db, { category: category ?? undefined })
      : Promise.resolve([] as readonly DesignLibraryCard[]),
    listMyClones(db, { shopId: store.id }),
  ])

  // Client-side search is fine for 58 + <~20 cards; no pagination
  // pressure, no DB work saved by pushing this down. We match on
  // title OR summary, case-insensitive. Empty q → show everything.
  const filterCards = (cards: readonly DesignLibraryCard[]): readonly DesignLibraryCard[] => {
    if (!q) return cards
    const needle = q.toLowerCase()
    return cards.filter(
      (c) =>
        c.title.toLowerCase().includes(needle) ||
        (c.summary ?? '').toLowerCase().includes(needle),
    )
  }
  const visibleCards = tab === 'gallery' ? filterCards(galleryCards) : filterCards(cloneCards)

  const libraryTabsBanner = isEmbedded ? renderLibraryTabs(base, 'designs') : ''
  const breadcrumbBackHref = isEmbedded ? `${base}/online-store/library` : `${base}/online-store`

  const content = `
    <style>${DESIGN_LIBRARY_CSS}</style>
    <nav class="dl-breadcrumb" aria-label="Breadcrumb">
      <a href="${breadcrumbBackHref}">${isEmbedded ? 'Online Store' : 'Online Store'}</a>
      <span class="dl-breadcrumb-sep">›</span>
      <span class="dl-breadcrumb-current">${isEmbedded ? 'Library' : surfaceLabel}</span>
    </nav>

    ${libraryTabsBanner}

    <header class="dl-hero">
      <div class="dl-hero-text">
        <h1 class="dl-title">${surfaceLabel}</h1>
        <p class="dl-subtitle">
          Curated brand design systems plus every site you've cloned.
          Preview, copy the <code>DESIGN.md</code>, or spin up a new theme.
        </p>
      </div>
      <div class="dl-hero-stats">
        <div class="dl-stat">
          <div class="dl-stat-n">${galleryCount}</div>
          <div class="dl-stat-label">Brands</div>
        </div>
        <div class="dl-stat">
          <div class="dl-stat-n">${cloneCards.length}</div>
          <div class="dl-stat-label">Your clones</div>
        </div>
      </div>
    </header>

    ${renderThemeActionsBar(base, csrfToken, errFromQuery(req))}

    ${renderGuideBanner(base)}

    ${renderTabs(base, tab, galleryCount, cloneCards.length, category, q)}

    ${tab === 'gallery'
      ? renderFilterRow(base, category, q, categoryCounts, galleryCount)
      : renderSearchOnly(base, tab, q)}

    ${visibleCards.length === 0
      ? renderEmptyState(tab, base, q, category)
      : renderGrid(visibleCards, tab, base, csrfToken)}

    ${renderModalTemplate(base)}

    <script>${DESIGN_LIBRARY_JS}</script>
  `

  // Override the app-wide CSP just for this page so the preview modal
  // can actually mount its iframe. The global helmet policy sets
  // `frame-src 'none'` which kills <iframe> creation outright and
  // produces Chrome's "This content is blocked" screen.
  //
  // We mirror the existing helmet policy verbatim except for the one
  // directive that matters here: `frame-src 'self'`. The preview
  // endpoint then independently permits being framed (see
  // `applyPreviewFramingHeaders`).
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "script-src-attr 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https:",
      "font-src 'self' https:",
      "connect-src 'self'",
      "object-src 'none'",
      "frame-src 'self'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      'upgrade-insecure-requests',
    ].join(';'),
  )

  res.send(
    sellerLayout({
      title: isEmbedded ? 'Library — Design references' : surfaceLabel,
      storeName: store.name,
      storeSlug: store.slug,
      userName: user.name,
      userEmail: user.email,
      userRole: user.role,
      storeRole: user.storeRole,
      activePage: isEmbedded ? 'online-store' : 'design-library',
      content,
      cookieHeader: req.headers?.cookie ?? null,
    }),
  )
}

// ---------------------------------------------------------------------------
// AJAX endpoints — backing the preview modal
// ---------------------------------------------------------------------------

/**
 * GET /admin/store/:slug/design-library/entry/:source/:slug
 *
 * Returns the full entry as JSON so the client-side modal can populate
 * its columns. Seed lookups are global; clone lookups are scoped to the
 * current store. Anything else returns 404.
 */
export async function getDesignLibraryEntryJson(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const source = req.params.source === 'clone' ? 'clone' : 'seed'
  const slug = String(req.params.slug ?? '').trim()
  if (!slug) {
    res.status(400).json({ error: 'missing-slug' })
    return
  }

  const entry = await getEntryBySlug(db, {
    slug,
    source: source as DesignLibrarySource,
    shopId: source === 'clone' ? store.id : undefined,
  })
  if (!entry) {
    res.status(404).json({ error: 'not-found' })
    return
  }

  // Belt-and-braces: clone entries MUST belong to the current shop.
  // The query already enforces this via the where clause, but a
  // defence-in-depth check guards against future refactors that might
  // drop the predicate.
  if (entry.source === 'clone' && entry.shopId !== store.id) {
    res.status(404).json({ error: 'not-found' })
    return
  }

  res.json({
    entry: {
      id: entry.id,
      slug: entry.slug,
      source: entry.source,
      title: entry.title,
      summary: entry.summary,
      category: entry.category,
      categoryLabel: entry.category
        ? DESIGN_LIBRARY_CATEGORY_LABELS[entry.category]
        : null,
      designMd: entry.designMd,
      designMdHtml: renderMarkdown(entry.designMd),
      hasLightPreview: Boolean(entry.previewHtml || entry.previewHtmlUrl),
      hasDarkPreview: Boolean(entry.previewDarkHtml || entry.previewDarkHtmlUrl),
      thumbnailUrl: entry.thumbnailUrl,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      sourceCloneJobId: entry.sourceCloneJobId,
      sourceThemeId: entry.sourceThemeId,
    },
  })
}

/**
 * GET /admin/store/:slug/design-library/preview/:source/:slug[?dark=1]
 *
 * Serves the raw preview HTML body for the modal iframe. Works from
 * hot-tier (inline TEXT) rows; cold-tier rows get a 302 redirect to
 * the CDN URL stored in preview_html_url.
 *
 * When previewHtml is null we render a friendly placeholder — mostly
 * hit by clone entries awaiting D3's async preview job. A placeholder
 * is much less jarring than a blank iframe.
 *
 * The iframe is sandboxed at the client (sandbox="allow-scripts") so
 * the preview can't break out of its own subtree. We do NOT add
 * `allow-same-origin` — that combo would let scripts escape sandbox.
 */
export async function getDesignLibraryPreview(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const source = req.params.source === 'clone' ? 'clone' : 'seed'
  const slug = String(req.params.slug ?? '').trim()
  const wantDark = String((req.query as any).dark ?? '') === '1'

  // Allow same-origin framing — the modal iframe on the admin page is the
  // sole legitimate embedder. Global helmet middleware sets
  // `X-Frame-Options: DENY` + CSP `frame-ancestors 'none'` which would
  // otherwise block the browser from rendering this response inside
  // ANY iframe (even same-origin), producing Chrome's generic
  // "This content is blocked" screen. We override BOTH headers here
  // because some browsers honour only one of them. The iframe itself
  // is still sandboxed with `sandbox="allow-scripts"` (no
  // allow-same-origin) at the parent so preview scripts can't read
  // admin cookies or bust out into the host page.
  applyPreviewFramingHeaders(res)

  if (!slug) {
    res.status(400).type('html').send(renderPreviewPlaceholder('Bad request', wantDark))
    return
  }

  const entry = await getEntryBySlug(db, {
    slug,
    source: source as DesignLibrarySource,
    shopId: source === 'clone' ? store.id : undefined,
  })
  if (!entry) {
    res.status(404).type('html').send(renderPreviewPlaceholder('Preview not found', wantDark))
    return
  }

  // Cold tier short-circuit — the actual body lives on S3. Forward the
  // browser there; the iframe will resolve the redirect itself.
  const coldUrl = wantDark ? entry.previewDarkHtmlUrl : entry.previewHtmlUrl
  if (entry.storageTier === 'cold' && coldUrl) {
    res.redirect(302, coldUrl)
    return
  }

  const body = wantDark ? entry.previewDarkHtml : entry.previewHtml
  // Fall back to the light body when dark is requested but missing —
  // the modal toggle still works (toggle tints the chrome around the
  // iframe), the iframe just doesn't have a dark variant.
  const finalBody = body ?? entry.previewHtml

  if (!finalBody) {
    res
      .status(200)
      .type('html')
      .send(
        renderPreviewPlaceholder(
          entry.source === 'clone'
            ? 'Preview is still generating. Check back in a few minutes.'
            : 'Preview not available for this brand yet.',
          wantDark,
        ),
      )
    return
  }

  // Don't cache — previews for clone entries may be rewritten by D3 in
  // the background after the row first appears. A 5s browser cache is
  // enough to make the iframe flip-flop feel snappy without pinning a
  // stale body.
  res.setHeader('Cache-Control', 'private, max-age=5')
  res.type('html').send(finalBody)
}

// ---------------------------------------------------------------------------
// Iframe-friendly headers for the preview endpoint
// ---------------------------------------------------------------------------

/**
 * Replace the app-wide helmet headers that forbid framing with a
 * same-origin-only policy. The preview body is legitimate iframe
 * content — it MUST be framable by the admin page.
 *
 * Why two headers?
 *   - `X-Frame-Options: SAMEORIGIN` — the legacy control still honoured
 *     by some clients (Edge, older Chromium forks).
 *   - `Content-Security-Policy: frame-ancestors 'self'` — the modern
 *     equivalent, and the one Chrome actually enforces here.
 *
 * We keep the rest of the response locked down: `default-src 'none'`
 * means the preview can't call home to third-party scripts even though
 * its iframe has `allow-scripts`. Inline styles and data:/https: images
 * are permitted because every serialised DESIGN.md preview inlines its
 * own styles and logos by design.
 */
function applyPreviewFramingHeaders(res: Response): void {
  res.setHeader('X-Frame-Options', 'SAMEORIGIN')
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'none'",
      "style-src 'self' 'unsafe-inline' https:",
      "img-src 'self' data: https:",
      "font-src 'self' https: data:",
      "script-src 'self' 'unsafe-inline'",
      "frame-ancestors 'self'",
      "base-uri 'self'",
    ].join('; '),
  )
}

// ---------------------------------------------------------------------------
// Render helpers — navigation + filters
// ---------------------------------------------------------------------------

function toTab(raw: string): Tab {
  return raw === 'my-clones' ? 'my-clones' : 'gallery'
}

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function fmtAge(date: Date | string | null): string {
  if (!date) return ''
  const ms = Date.now() - new Date(date).getTime()
  const hours = Math.floor(ms / 3600_000)
  if (hours < 1) return 'just now'
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  return `${months}mo ago`
}

function renderTabs(
  base: string,
  active: Tab,
  galleryCount: number,
  myClonesCount: number,
  activeCat: DesignLibraryCategory | null,
  q: string,
): string {
  // Preserve `q` across tab switches but DROP `category` — categories
  // don't apply to the "My Clones" tab, and keeping a filter that
  // doesn't apply produces a confusing empty state.
  const qParam = q ? `&q=${encodeURIComponent(q)}` : ''
  const galleryHref =
    active === 'gallery' || !activeCat
      ? `${base}/design-library?tab=gallery${qParam}`
      : `${base}/design-library?tab=gallery&category=${activeCat}${qParam}`
  const clonesHref = `${base}/design-library?tab=my-clones${qParam}`

  return `
    <nav class="dl-tabs" aria-label="Library section">
      <a class="dl-tab${active === 'gallery' ? ' dl-tab-active' : ''}" href="${galleryHref}">
        Gallery
        <span class="dl-tab-count">${galleryCount}</span>
      </a>
      <a class="dl-tab${active === 'my-clones' ? ' dl-tab-active' : ''}" href="${clonesHref}">
        My Clones
        <span class="dl-tab-count">${myClonesCount}</span>
      </a>
    </nav>
  `
}

/**
 * "Getting started" banner — how to actually use a DESIGN.md file.
 *
 * Why this lives at the top of the page and not only in the modal:
 * the in-modal hint is a contextual reminder, but a user who's never
 * heard of a "design spec" may not even click a card — they see the
 * grid, shrug, and leave. This banner catches them before that. It's
 * closed by default (keeps the page tidy for power users) but the
 * inline `<script>` right after it force-opens it on a user's FIRST
 * visit (localStorage flag). A Dismiss button inside the banner
 * stores the flag so the user never sees the open state again unless
 * they clear storage.
 *
 * Three use cases, each with a nested <details> that expands to the
 * step-by-step recipe. We keep the collapsed state dense (one line
 * per card: number + title + one-sentence tagline) so the three
 * options fit at a glance and the user picks the recipe they want.
 *
 * Recipe 2 was a "Brief for Clone Library" workflow before 2026-04-26;
 * with clone tooling moved to god-admin-only concierge service, that
 * recipe now points at mailto:contact@gbox.co directly.
 */
function renderGuideBanner(base: string): string {
  // Keep chevron SVG reusable — three separate chevrons on this block.
  const chevron =
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>'
  return `
    <details class="dl-guide" id="dl-guide">
      <summary class="dl-guide-summary">
        <div class="dl-guide-summary-left">
          <div class="dl-guide-summary-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
              <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
              <line x1="8" y1="7" x2="16" y2="7" />
              <line x1="8" y1="11" x2="14" y2="11" />
            </svg>
          </div>
          <div class="dl-guide-summary-text">
            <strong class="dl-guide-summary-title">New here? Learn how to use these DESIGN.md files</strong>
            <span class="dl-guide-summary-tagline">
              A DESIGN.md is a <em>design spec</em>, not a theme. Three concrete ways to put it to work — with copy-paste prompts and checklists.
            </span>
          </div>
        </div>
        <span class="dl-guide-summary-chevron" aria-hidden="true">${chevron}</span>
      </summary>

      <div class="dl-guide-body">
        <!-- Intro: what is it, what is it not -->
        <section class="dl-guide-intro">
          <h3 class="dl-guide-h3">What exactly is a DESIGN.md file?</h3>
          <p>
            A <strong>DESIGN.md</strong> is a <strong>design specification</strong> — a structured
            document that captures a brand's visual identity: exact hex colours, font families,
            section layouts, and writing voice. It's machine-readable (Markdown) so you can paste
            it into an AI assistant and the AI will understand it.
          </p>
          <p class="dl-guide-analogy">
            <strong>Analogy:</strong> if a finished storefront theme is a <em>ready-to-wear
            outfit</em>, a DESIGN.md is the <em>tailor's pattern</em> — every measurement needed to
            re-create the look, either by hand or by handing it to someone (or an AI) who can
            sew. It is <strong>not</strong> a theme you can install directly.
          </p>
        </section>

        <!-- Three recipes -->
        <h3 class="dl-guide-h3">Three ways to use it — pick the one that fits you</h3>
        <div class="dl-guide-cards">

          <!-- Recipe 1: AI assistant -->
          <article class="dl-guide-card">
            <div class="dl-guide-card-head">
              <div class="dl-guide-card-num">1</div>
              <div>
                <h4 class="dl-guide-card-title">Feed it to ChatGPT or Claude</h4>
                <p class="dl-guide-card-lede">
                  Use the file as a <strong>style reference</strong> when you ask an AI to write
                  product copy, marketing emails, or design variations in the same brand voice.
                </p>
              </div>
            </div>
            <details class="dl-guide-how">
              <summary class="dl-guide-how-summary">
                <span>Step-by-step with example prompt</span>
                ${chevron}
              </summary>
              <ol class="dl-guide-steps">
                <li>
                  Click any card in the gallery below, then press <strong>Download</strong>
                  inside the preview modal. You'll get a file called e.g.
                  <code>airbnb-com.md</code> saved to your Downloads folder.
                </li>
                <li>
                  Open <a class="dl-guide-link" href="https://chat.openai.com" target="_blank" rel="noopener">chat.openai.com</a>
                  or <a class="dl-guide-link" href="https://claude.ai" target="_blank" rel="noopener">claude.ai</a>
                  and start a <strong>new chat</strong>.
                </li>
                <li>
                  Drag-and-drop the <code>.md</code> file straight into the chat input, or press
                  <kbd>Copy</kbd> in the preview modal and paste the Markdown text directly.
                </li>
                <li>
                  Ask the AI a request that references the spec. For example:
                  <pre class="dl-guide-prompt">Using the DESIGN.md I just shared as a brand reference, write 5 product descriptions for a men's sneaker store. Match the same tone and visual language. Each under 80 words, with a headline, 2-3 sentences of body copy, and a call-to-action.</pre>
                </li>
                <li>
                  The AI reads the spec, picks up the voice, and produces copy that matches. Iterate
                  with follow-ups like <em>"make #3 more playful"</em> until you're happy.
                </li>
              </ol>
              <p class="dl-guide-tip">
                <strong>Pro tip —</strong> paste 2-3 DESIGN.md files from different brands into
                the same chat and ask the AI <em>"Which of these three voices best fits a
                [premium / playful / minimalist] brand?"</em> It's a fast way to pick the style
                that suits your own shop before you commit.
              </p>
            </details>
          </article>

          <!-- Recipe 2: Concierge brief -->
          <article class="dl-guide-card">
            <div class="dl-guide-card-head">
              <div class="dl-guide-card-num">2</div>
              <div>
                <h4 class="dl-guide-card-title">Send it to the Gbox concierge</h4>
                <p class="dl-guide-card-lede">
                  Want a custom theme assembled to match this brand? Email the DESIGN.md to
                  Gbox support and we'll build it for you.
                </p>
              </div>
            </div>
            <details class="dl-guide-how">
              <summary class="dl-guide-how-summary">
                <span>How to request a custom theme</span>
                ${chevron}
              </summary>
              <ol class="dl-guide-steps">
                <li>
                  Open the brand in <strong>Design Library</strong> and press <strong>Download</strong>
                  to grab the DESIGN.md file.
                </li>
                <li>
                  Email <a class="dl-guide-link" href="mailto:contact@gbox.co">contact@gbox.co</a>
                  with the file attached and a one-line note (e.g. "Build a theme that feels
                  like this brand for my store").
                </li>
                <li>
                  Gbox support assembles the theme and imports it into your store as an
                  unpublished draft you can preview, edit, and publish.
                </li>
                <li>
                  For page copy, product descriptions, and marketing emails, follow Recipe #1
                  above — feed the DESIGN.md to an AI assistant for matching voice + tone.
                </li>
              </ol>
            </details>
          </article>

          <!-- Recipe 3: hand-tune -->
          <article class="dl-guide-card">
            <div class="dl-guide-card-head">
              <div class="dl-guide-card-num">3</div>
              <div>
                <h4 class="dl-guide-card-title">Hand-tune your existing theme</h4>
                <p class="dl-guide-card-lede">
                  Already have a theme you like? Treat DESIGN.md as a <strong>checklist</strong>
                  to bring it in line with a brand you admire — no rebuild needed.
                </p>
              </div>
            </div>
            <details class="dl-guide-how">
              <summary class="dl-guide-how-summary">
                <span>Step-by-step checklist</span>
                ${chevron}
              </summary>
              <ol class="dl-guide-steps">
                <li>
                  Open the DESIGN.md in one browser tab (from the preview modal) and your
                  <strong>Theme Editor</strong> in another — side by side.
                </li>
                <li>
                  <strong>Palette —</strong> find the <em>"Visual Theme"</em> or
                  <em>"Palette"</em> section in the spec. Copy each hex code (e.g.
                  <code>#FF5A5F</code>) into Theme Editor → <em>Colors</em>.
                </li>
                <li>
                  <strong>Typography —</strong> the <em>"Fonts"</em> section lists heading and
                  body font families. Pick them (or the closest Google Font) in
                  Theme Editor → <em>Typography</em>.
                </li>
                <li>
                  <strong>Layout —</strong> the <em>"Sections Detected"</em> list shows which
                  homepage blocks this brand uses (hero, product grid, testimonial, press strip,
                  etc.) and in what order. Rearrange your storefront sections to match.
                </li>
                <li>
                  <strong>Voice —</strong> read the <em>"Tone"</em> paragraph and rewrite your
                  page headlines, product descriptions, and email subject lines to match. This
                  is where Recipe #1 (AI assistant) saves hours.
                </li>
              </ol>
              <p class="dl-guide-tip">
                <strong>You don't need 100% fidelity —</strong> hitting 60-70% of a spec usually
                lands you 90% of the visual impression. Start with <em>palette + fonts</em>;
                they do the heaviest lifting. Section reorder second, voice third.
              </p>
            </details>
          </article>

        </div>

        <!-- Footer: dismiss -->
        <div class="dl-guide-footer">
          <p class="dl-guide-foot-note">
            <em>
              These three workflows are the fastest path to use a DESIGN.md today.
            </em>
          </p>
          <button type="button" class="dl-guide-dismiss" id="dl-guide-dismiss">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>
            <span>Got it — hide this banner next time</span>
          </button>
        </div>
      </div>
    </details>

    <!--
      Inline init. Runs synchronously right after the <details> is in
      the DOM (before first paint) so we can flip it to [open] for
      first-time visitors WITHOUT a flash of the collapsed state. If
      the user has previously dismissed the banner, we leave it
      closed. Wrapped in a try/catch because private-mode browsers
      throw on localStorage access.
    -->
    <script>(function(){
      try {
        var g = document.getElementById('dl-guide');
        if (!g) return;
        if (!localStorage.getItem('dl-guide-dismissed')) {
          g.setAttribute('open', '');
        }
      } catch (_) { /* storage disabled — fall through with banner closed */ }
    })();</script>
  `
}

function renderFilterRow(
  base: string,
  activeCat: DesignLibraryCategory | null,
  q: string,
  counts: Readonly<Record<DesignLibraryCategory, number>>,
  total: number,
): string {
  const qParam = q ? `&q=${encodeURIComponent(q)}` : ''

  // Build chip list — "All" is first, then the 9 category chips with
  // their counts. Hide any category whose count is zero so seller
  // doesn't see dead chips (upstream might not have filled every bucket).
  const allHref = `${base}/design-library?tab=gallery${qParam}`
  const allChip = `<a class="dl-chip${activeCat === null ? ' dl-chip-active' : ''}" href="${allHref}">
    All <span class="dl-chip-count">${total}</span>
  </a>`

  const categoryChips = DESIGN_LIBRARY_CATEGORIES.map((cat) => {
    const n = counts[cat] ?? 0
    if (n === 0) return ''
    const href = `${base}/design-library?tab=gallery&category=${cat}${qParam}`
    const label = DESIGN_LIBRARY_CATEGORY_LABELS[cat]
    return `<a class="dl-chip dl-chip-${cat}${activeCat === cat ? ' dl-chip-active' : ''}" href="${href}">
      ${esc(label)} <span class="dl-chip-count">${n}</span>
    </a>`
  })
    .filter(Boolean)
    .join('')

  return `
    <div class="dl-filter-row">
      <form method="get" action="${base}/design-library" class="dl-search">
        <input type="hidden" name="tab" value="gallery" />
        ${activeCat ? `<input type="hidden" name="category" value="${esc(activeCat)}" />` : ''}
        <input
          type="search"
          name="q"
          value="${esc(q)}"
          placeholder="Search brands…"
          autocomplete="off"
          class="dl-search-input"
        />
        ${q ? `<a href="${base}/design-library?tab=gallery${activeCat ? `&category=${activeCat}` : ''}" class="dl-search-clear" title="Clear search">×</a>` : ''}
      </form>
      <div class="dl-chips" role="tablist" aria-label="Filter by category">
        ${allChip}${categoryChips}
      </div>
    </div>
  `
}

function renderSearchOnly(base: string, tab: Tab, q: string): string {
  return `
    <div class="dl-filter-row">
      <form method="get" action="${base}/design-library" class="dl-search">
        <input type="hidden" name="tab" value="${tab}" />
        <input
          type="search"
          name="q"
          value="${esc(q)}"
          placeholder="Search your clones…"
          autocomplete="off"
          class="dl-search-input"
        />
        ${q ? `<a href="${base}/design-library?tab=${tab}" class="dl-search-clear" title="Clear search">×</a>` : ''}
      </form>
    </div>
  `
}

// ---------------------------------------------------------------------------
// Render helpers — grid + cards
// ---------------------------------------------------------------------------

function renderGrid(
  cards: readonly DesignLibraryCard[],
  tab: Tab,
  base: string,
  csrfToken: string,
): string {
  const html = cards.map((c) => renderCard(c, tab, base, csrfToken)).join('\n')
  return `<div class="dl-grid">${html}</div>`
}

function renderCard(
  card: DesignLibraryCard,
  tab: Tab,
  base: string,
  csrfToken: string,
): string {
  const catLabel = card.category ? DESIGN_LIBRARY_CATEGORY_LABELS[card.category] : null
  const chipHtml = card.category
    ? `<span class="dl-chip dl-chip-sm dl-chip-${card.category}">${esc(catLabel)}</span>`
    : tab === 'my-clones'
      ? `<span class="dl-chip dl-chip-sm dl-chip-clone">Clone</span>`
      : ''

  // For clone entries show an age. Seed entries don't need an age —
  // they're timeless curated content; the metadata clutters the card.
  const ageHtml =
    tab === 'my-clones'
      ? `<span class="dl-card-age">${esc(fmtAge(card.createdAt))}</span>`
      : ''

  // Owner-of-source sees a delete. For seed cards (public, immutable)
  // we never render a delete. The /actions.ts handler also does server-
  // side checks — this UI filter is cosmetic.
  const deleteBtn =
    tab === 'my-clones'
      ? `<form method="post" action="${base}/design-library/clone/${esc(card.slug)}/delete"
             class="dl-inline-form"
             onsubmit="return confirm('Delete this clone from your Design Library? The underlying theme is untouched.');">
           <input type="hidden" name="_csrf" value="${esc(csrfToken)}" />
           <button type="submit" class="dl-btn-icon dl-btn-danger" title="Delete">✕</button>
         </form>`
      : ''

  // Card thumbnail. We have thumbnailUrl on the row once D3 fills it
  // (cold-tier PNG). For now it's null — render a gradient placeholder
  // that hints at the brand's primary color IF we wanted to be fancy,
  // but a pleasant neutral is fine for the first cut.
  const thumb = card.thumbnailUrl
    ? `<img src="${esc(card.thumbnailUrl)}" alt="" class="dl-card-thumb" loading="lazy" />`
    : `<div class="dl-card-thumb dl-card-thumb-placeholder">
        <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <path d="M3 15l4-4 6 6" />
          <circle cx="16" cy="9" r="1.5" />
        </svg>
      </div>`

  return `<article class="dl-card"
            data-dl-slug="${esc(card.slug)}"
            data-dl-source="${esc(card.source)}"
            data-dl-title="${esc(card.title)}">
    ${thumb}
    <div class="dl-card-body">
      <header class="dl-card-head">
        <h3 class="dl-card-title">${esc(card.title)}</h3>
        ${deleteBtn}
      </header>
      <p class="dl-card-summary">${esc(card.summary ?? '')}</p>
      <footer class="dl-card-foot">
        ${chipHtml}
        ${ageHtml}
      </footer>
    </div>
    <button type="button" class="dl-card-click" aria-label="Open preview for ${esc(card.title)}"></button>
  </article>`
}

function renderEmptyState(
  tab: Tab,
  base: string,
  q: string,
  cat: DesignLibraryCategory | null,
): string {
  if (q) {
    return `<div class="dl-empty">
      <div class="dl-empty-title">No matches for "${esc(q)}"</div>
      <p class="dl-empty-body">Try a different search term or clear filters.</p>
      <a href="${base}/design-library?tab=${tab}" class="dl-btn-secondary">Clear search</a>
    </div>`
  }
  if (tab === 'gallery' && cat) {
    return `<div class="dl-empty">
      <div class="dl-empty-title">No brands in this category yet</div>
      <p class="dl-empty-body">We add brands as the upstream mirror is updated.</p>
      <a href="${base}/design-library?tab=gallery" class="dl-btn-secondary">Show all brands</a>
    </div>`
  }
  if (tab === 'my-clones') {
    return `<div class="dl-empty">
      <div class="dl-empty-title">No saved designs yet</div>
      <p class="dl-empty-body">Designs you import from the Theme Library will appear here so you can reuse them later.</p>
      <a href="${base}/online-store/library" class="dl-btn-primary">Open Theme Library</a>
    </div>`
  }
  return `<div class="dl-empty">
    <div class="dl-empty-title">Gallery is empty</div>
    <p class="dl-empty-body">Run the sync-seed CLI to populate curated brands.</p>
  </div>`
}

// ---------------------------------------------------------------------------
// Modal template — SINGLE <dialog> populated by AJAX on card click
// ---------------------------------------------------------------------------

/**
 * The modal is one element; a `dl-open-preview` click fetches the
 * entry JSON and fills the placeholders. Keeping it as a template
 * (not one-per-card) keeps the page under ~200 KB even with 58 cards.
 */
function renderModalTemplate(base: string): string {
  return `
    <dialog id="dl-preview-modal" class="dl-modal" data-base="${esc(base)}" data-theme="light">
      <div class="dl-modal-chrome">
        <header class="dl-modal-head">
          <div class="dl-modal-head-text">
            <h2 class="dl-modal-title" id="dl-mt-title">Loading…</h2>
            <div class="dl-modal-meta">
              <span class="dl-chip dl-chip-sm" id="dl-mt-cat" hidden></span>
              <span class="dl-modal-slug" id="dl-mt-slug"></span>
            </div>
          </div>
          <div class="dl-modal-head-actions">
            <button type="button" class="dl-btn-icon" id="dl-mt-toggle-dark" title="Toggle preview dark mode" aria-label="Toggle dark mode">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
              </svg>
            </button>
            <button type="button" class="dl-btn-icon" id="dl-mt-close" title="Close" aria-label="Close">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </header>

        <div class="dl-modal-body">
          <section class="dl-modal-col dl-modal-col-code" aria-label="Design specification">
            <div class="dl-modal-col-head">
              <span class="dl-modal-col-label">DESIGN.md</span>
              <div class="dl-modal-col-actions">
                <button type="button" class="dl-btn-xs" id="dl-mt-copy" title="Copy DESIGN.md to clipboard">
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <rect x="9" y="9" width="13" height="13" rx="2" />
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                  </svg>
                  <span>Copy</span>
                </button>
                <a class="dl-btn-xs" id="dl-mt-download" href="#" download>
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="7 10 12 15 17 10" />
                    <line x1="12" y1="15" x2="12" y2="3" />
                  </svg>
                  <span>Download</span>
                </a>
              </div>
            </div>
            <div class="dl-prose" id="dl-mt-md">
              <p class="dl-muted">Loading specification…</p>
            </div>

            <!--
              What-is-this-file hint. The raw DESIGN.md isn't
              self-explanatory — it's a design spec, not a theme file,
              and the average seller won't know what to do with the
              download. A compact <details> block saves vertical
              space when collapsed but keeps the answer one click
              away.
            -->
            <details class="dl-hint" id="dl-mt-hint">
              <summary class="dl-hint-summary">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="16" x2="12" y2="12" />
                  <line x1="12" y1="8" x2="12.01" y2="8" />
                </svg>
                <span>What is this file &amp; how do I use it?</span>
              </summary>
              <div class="dl-hint-body">
                <p>
                  <strong>DESIGN.md</strong> is a <em>design specification</em> — a structured brief
                  describing the brand's palette, typography, layout rules, and section inventory.
                  It is <strong>not</strong> a ready-to-use theme file.
                </p>
                <p class="dl-hint-what">Three things you can do with it:</p>
                <ol class="dl-hint-list">
                  <li>
                    <strong>Feed it to an AI assistant.</strong> Paste the file into ChatGPT,
                    Claude, or any LLM and ask it to draft copy, images, or a variation that
                    matches the same voice and visual language.
                  </li>
                  <li>
                    <strong>Hand it to the Gbox concierge.</strong> Email
                    <a class="dl-hint-link" href="mailto:contact@gbox.co">contact@gbox.co</a>
                    with this file attached — Gbox support uses it as a brief when assembling
                    a custom theme on your behalf.
                  </li>
                  <li>
                    <strong>Hand-tune your own storefront.</strong> Open it alongside your Theme
                    Editor as a checklist — palette hexes, font stacks, and section order are all
                    spelled out.
                  </li>
                </ol>
                <p class="dl-hint-foot">
                  The file is Markdown — any text editor (VS Code, Notepad, Typora) will render
                  it correctly.
                </p>
              </div>
            </details>
          </section>

          <section class="dl-modal-col dl-modal-col-preview" aria-label="Live preview">
            <div class="dl-modal-col-head">
              <span class="dl-modal-col-label">Preview</span>
              <div class="dl-modal-col-actions">
                <a class="dl-btn-xs" id="dl-mt-open-preview" href="#" target="_blank" rel="noopener" title="Open preview in new tab">
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                    <polyline points="15 3 21 3 21 9" />
                    <line x1="10" y1="14" x2="21" y2="3" />
                  </svg>
                  <span>Open</span>
                </a>
              </div>
            </div>
            <div class="dl-iframe-wrap" id="dl-mt-iframe-wrap">
              <div class="dl-iframe-loader" id="dl-mt-iframe-loader">Loading preview…</div>
              <iframe
                id="dl-mt-iframe"
                class="dl-iframe"
                title="Design preview"
                sandbox="allow-scripts"
                referrerpolicy="no-referrer"
                loading="lazy"
              ></iframe>
            </div>
          </section>
        </div>

        <footer class="dl-modal-foot">
          <div class="dl-modal-foot-left">
            <a class="dl-btn-primary"
               href="mailto:contact@gbox.co?subject=Custom%20theme%20request"
               title="Email Gbox support to request a custom theme using this DESIGN.md as a brief">
              Request as a custom theme
            </a>
          </div>
          <div class="dl-modal-foot-right">
            <span class="dl-toast" id="dl-mt-toast" hidden></span>
          </div>
        </footer>
      </div>
    </dialog>
  `
}

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

/**
 * Minimal DESIGN.md → HTML renderer. Safe by construction: we escape
 * every raw byte first, then apply a fixed set of regex-based rules.
 * No third-party parser is pulled in — the input shape is narrow (our
 * own serializer's output) and we only need headings, lists, inline
 * code, bold, and fenced blocks.
 *
 * What we do NOT support (by design):
 *
 *   - Tables, blockquotes, footnotes — DESIGN.md doesn't use them.
 *   - Arbitrary HTML pass-through — would undo the escape pass.
 *   - Images — DESIGN.md is spec text only; previews go in the iframe.
 *
 * Swatch detection: any `#XXXXXX` hex colour inside a `<code>` tag
 * gets a small colour dot prepended — lifts the palette section of
 * DESIGN.md from "wall of hex codes" to "scannable chip list".
 */
export function renderMarkdown(md: string): string {
  let html = esc(md)

  // Fenced code blocks — do this FIRST so the content inside isn't
  // mangled by the heading / list rules below. The matched body is
  // already HTML-escaped (we ran esc() on the whole string), so it's
  // safe to wrap in <pre><code>.
  html = html.replace(/```([a-zA-Z0-9]*)\n([\s\S]*?)```/g, (_full, _lang, code) => {
    return `<pre class="dl-code"><code>${code.trimEnd()}</code></pre>`
  })

  // Block-level: headings. ### before ## before # so the shorter
  // prefix can't eat the longer one (# matches `## x` too without this).
  html = html.replace(/^### (.+)$/gm, '<h3 class="dl-h3">$1</h3>')
  html = html.replace(/^## (.+)$/gm, '<h2 class="dl-h2">$1</h2>')
  html = html.replace(/^# (.+)$/gm, '<h1 class="dl-h1">$1</h1>')

  // Block-level: unordered lists. Collapse any run of "- …" lines into
  // one <ul>. Any other markdown inside the items is processed later
  // by the inline pass.
  html = html.replace(/(?:^[-*] .+(?:\n|$))+/gm, (block) => {
    const items = block
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => `<li>${line.replace(/^[-*] /, '')}</li>`)
      .join('')
    return `<ul class="dl-list">${items}</ul>\n`
  })

  // Inline: bold / italic / code / links. Order matters — bold uses
  // `**…**`, italic uses `*…*`; if we ran italic first, **foo** would
  // become <em>*foo*</em>.
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  html = html.replace(/(?<![\w*])\*([^*\n]+)\*(?!\w)/g, '<em>$1</em>')
  html = html.replace(/`([^`\n]+)`/g, '<code class="dl-inline-code">$1</code>')

  // Only allow http(s) links. `javascript:` and `data:` URIs are
  // stripped to their visible text to prevent XSS.
  html = html.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (_full, text: string, href: string) => {
      if (!/^https?:\/\//i.test(href)) return esc(text)
      return `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${text}</a>`
    },
  )

  // Paragraphs. Split by blank-line; wrap chunks that DON'T already
  // start with a block tag. Single newlines inside a chunk become <br>
  // so a hand-broken line in DESIGN.md doesn't collapse.
  html = html
    .split(/\n{2,}/)
    .map((chunk) => {
      const trimmed = chunk.trim()
      if (!trimmed) return ''
      if (/^<(h[1-6]|ul|ol|pre|blockquote)/.test(trimmed)) return trimmed
      return `<p class="dl-p">${trimmed.replace(/\n/g, '<br>')}</p>`
    })
    .join('\n')

  // Swatch decoration — inside-<code> hex colours get a dot prepended.
  // Allows the palette section to double as a visual quick-scan: you
  // see a colour chip next to the name and value.
  html = html.replace(
    /(<code[^>]*>)(#[0-9A-Fa-f]{3,8})(<\/code>)/g,
    (_full, open: string, hex: string, close: string) =>
      `${open}<span class="dl-swatch" style="background:${hex}"></span>${hex}${close}`,
  )

  return html
}

// ---------------------------------------------------------------------------
// Preview placeholder — rendered when previewHtml is null
// ---------------------------------------------------------------------------

function renderPreviewPlaceholder(message: string, dark: boolean): string {
  // Full HTML document because it's going into an iframe. Colours
  // hard-coded; this file never sees the parent page's CSS tokens.
  const bg = dark ? '#0f172a' : '#f8fafc'
  const fg = dark ? '#e2e8f0' : '#475569'
  const accent = dark ? '#3b82f6' : '#6366f1'
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Preview unavailable</title>
<style>
  html, body { margin:0; padding:0; height:100%; background:${bg}; color:${fg};
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  .wrap { display:flex; flex-direction:column; align-items:center; justify-content:center;
    height:100%; padding:32px; text-align:center; }
  .icon { width:48px; height:48px; border-radius:50%; background:${accent}1a;
    display:flex; align-items:center; justify-content:center; color:${accent}; margin-bottom:16px;
    font-size:24px; }
  h1 { font-size:16px; font-weight:600; margin:0 0 6px; color:${dark ? '#f1f5f9' : '#1e293b'}; }
  p { font-size:13px; margin:0; max-width:360px; line-height:1.5; }
</style>
</head>
<body>
  <div class="wrap">
    <div class="icon">⋯</div>
    <h1>Preview unavailable</h1>
    <p>${esc(message)}</p>
  </div>
</body>
</html>`
}

// ---------------------------------------------------------------------------
// Inline CSS — scoped to .dl-* to avoid collisions with the layout
// ---------------------------------------------------------------------------

const DESIGN_LIBRARY_CSS = `
/* ── Layout structure ─────────────────────────────────────────── */
.dl-breadcrumb { display:flex; align-items:center; gap:6px; color:var(--text-muted); font-size:13px; margin-bottom:12px; }
.dl-breadcrumb a { color:var(--text-muted); text-decoration:none; }
.dl-breadcrumb a:hover { color:var(--text); }
.dl-breadcrumb-current { color:var(--text); font-weight:500; }
.dl-breadcrumb-sep { opacity:.5; }

.dl-hero { display:flex; justify-content:space-between; align-items:flex-end; gap:24px;
  padding:20px 24px; margin-bottom:20px;
  background: linear-gradient(135deg, rgba(99,102,241,.06), rgba(168,85,247,.04));
  border:1px solid var(--border); border-radius:12px; }
.dl-hero-text { flex:1 1 auto; min-width:0; }
.dl-title { font-size:24px; font-weight:700; color:var(--text); margin:0 0 6px; letter-spacing:-.01em; }
.dl-subtitle { font-size:13px; color:var(--text-muted); margin:0; max-width:640px; line-height:1.5; }
.dl-subtitle code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  background:var(--surface-alt, #f1f5f9); padding:1px 6px; border-radius:4px; font-size:12px; }
.dl-hero-stats { display:flex; gap:16px; flex:0 0 auto; }
.dl-stat { text-align:right; }
.dl-stat-n { font-size:22px; font-weight:700; color:var(--text); line-height:1; }
.dl-stat-label { font-size:11px; color:var(--text-muted); text-transform:uppercase; letter-spacing:.05em; margin-top:4px; }

/* ── "Getting started" guide banner ──────────────────────────────
   Sits between the hero and the tabs. Closed by default (summary
   row only); the inline init script opens it for first-time visitors.
   Once expanded, shows an intro + a 3-card recipe grid, each recipe
   being an independent <details> that reveals step-by-step
   instructions. All colours specified explicitly so dark mode via
   admin-root tokens can't produce the white-on-white bug.
   ─────────────────────────────────────────────────────────────── */
.dl-guide { margin:0 0 20px; padding:0; border:1px solid #c7d2fe;
  background:linear-gradient(180deg, #eef2ff 0%, #f5f3ff 100%);
  border-radius:12px; overflow:hidden;
  box-shadow:0 1px 2px rgba(99,102,241,.06); }
.dl-guide[open] { background:#ffffff; }

/* Summary row (always visible) */
.dl-guide-summary { display:flex; align-items:center; gap:12px;
  padding:14px 18px; cursor:pointer; list-style:none; user-select:none;
  transition: background .12s; }
.dl-guide-summary::-webkit-details-marker { display:none; }
.dl-guide-summary:hover { background:rgba(99,102,241,.05); }
.dl-guide[open] .dl-guide-summary {
  border-bottom:1px solid #e2e8f0; background:#fafbff; }
.dl-guide-summary-left { display:flex; gap:12px; align-items:center;
  flex:1 1 auto; min-width:0; }
.dl-guide-summary-icon { flex:0 0 36px; width:36px; height:36px;
  border-radius:10px; background:#6366f1; color:#fff;
  display:flex; align-items:center; justify-content:center; }
.dl-guide-summary-text { flex:1 1 auto; min-width:0; }
.dl-guide-summary-title { display:block; font-size:14px; font-weight:600;
  color:#1e1b4b; margin-bottom:2px; }
.dl-guide-summary-tagline { display:block; font-size:12.5px; color:#4b5563;
  line-height:1.45; }
.dl-guide-summary-tagline em { color:#4f46e5; font-style:normal; font-weight:500; }
.dl-guide-summary-chevron { flex:0 0 auto; color:#6366f1;
  transition: transform .18s; }
.dl-guide[open] .dl-guide-summary-chevron { transform:rotate(180deg); }

/* Expanded body */
.dl-guide-body { padding:18px 22px 20px; background:#ffffff; }
.dl-guide-intro { margin-bottom:18px; }
.dl-guide-h3 { font-size:14px; font-weight:700; color:#0f172a;
  margin:0 0 10px; letter-spacing:-.005em; }
.dl-guide-body p { margin:6px 0; font-size:13px; line-height:1.6;
  color:#334155; }
.dl-guide-body strong { color:#0f172a; font-weight:600; }
.dl-guide-body em { color:#475569; }
.dl-guide-analogy { background:#fefce8; border-left:3px solid #eab308;
  padding:10px 14px; border-radius:6px; }
.dl-guide-analogy strong { color:#713f12; }

/* 3-card recipe grid */
.dl-guide-cards { display:grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap:14px; margin:10px 0 18px; }
.dl-guide-card { background:#ffffff; border:1px solid #e2e8f0;
  border-radius:10px; padding:14px 16px;
  display:flex; flex-direction:column; gap:10px;
  transition: border-color .15s, box-shadow .15s; }
.dl-guide-card:hover { border-color:#c7d2fe;
  box-shadow:0 2px 6px rgba(99,102,241,.08); }
.dl-guide-card-head { display:flex; gap:10px; align-items:flex-start; }
.dl-guide-card-num { flex:0 0 28px; width:28px; height:28px; border-radius:50%;
  background:#eef2ff; color:#4338ca; font-size:13px; font-weight:700;
  display:flex; align-items:center; justify-content:center; }
.dl-guide-card-title { font-size:14px; font-weight:700; color:#0f172a;
  margin:0 0 4px; line-height:1.3; }
.dl-guide-card-lede { font-size:12.5px; color:#475569;
  line-height:1.5; margin:0; }

/* Nested "Show me how" <details> inside each recipe card */
.dl-guide-how { border-top:1px dashed #e2e8f0; padding-top:10px; margin-top:auto; }
.dl-guide-how-summary { display:inline-flex; align-items:center; gap:4px;
  cursor:pointer; font-size:12px; font-weight:600; color:#6366f1;
  list-style:none; user-select:none; padding:2px 0; }
.dl-guide-how-summary::-webkit-details-marker { display:none; }
.dl-guide-how-summary:hover { color:#4f46e5; }
.dl-guide-how-summary svg { transition: transform .18s; }
.dl-guide-how[open] .dl-guide-how-summary svg { transform:rotate(180deg); }

.dl-guide-steps { margin:10px 0 8px; padding-left:22px;
  font-size:12.5px; line-height:1.6; color:#334155; }
.dl-guide-steps li { margin:6px 0; }
.dl-guide-steps code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  background:#f1f5f9; color:#0f172a; padding:1px 5px; border-radius:4px; font-size:11.5px; }
.dl-guide-steps kbd { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  background:#0f172a; color:#e2e8f0; padding:1px 6px; border-radius:4px;
  font-size:11px; border:1px solid #1e293b; }
.dl-guide-link { color:#6366f1; font-weight:500; text-decoration:underline;
  text-underline-offset:2px; }
.dl-guide-link:hover { color:#4f46e5; }
.dl-guide-prompt { background:#0f172a; color:#e2e8f0;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size:11.5px; line-height:1.5; padding:10px 14px; border-radius:6px;
  margin:6px 0; white-space:pre-wrap; overflow-x:auto; }

.dl-guide-tip { background:#ecfdf5; border-left:3px solid #10b981;
  padding:8px 12px; border-radius:6px; font-size:12px; color:#065f46;
  margin:8px 0 0; line-height:1.5; }
.dl-guide-tip strong { color:#065f46; }

/* Footer: D5 note + dismiss button */
.dl-guide-footer { display:flex; flex-wrap:wrap; gap:12px;
  align-items:center; justify-content:space-between;
  margin-top:18px; padding-top:14px; border-top:1px solid #e2e8f0; }
.dl-guide-foot-note { font-size:12px; color:#64748b; margin:0;
  flex:1 1 300px; line-height:1.5; }
.dl-guide-foot-note strong { color:#334155; }
.dl-badge-inline { display:inline-block; font-size:10px; font-weight:700;
  background:#fef3c7; color:#92400e; padding:1px 7px; border-radius:10px;
  letter-spacing:.02em; vertical-align:middle; }
.dl-guide-dismiss { display:inline-flex; align-items:center; gap:6px;
  background:#f1f5f9; color:#475569; border:1px solid #e2e8f0;
  padding:6px 12px; border-radius:6px; font-size:12px; font-weight:500;
  cursor:pointer; transition: all .12s; }
.dl-guide-dismiss:hover { background:#e2e8f0; color:#1e293b; }

@media (max-width: 640px) {
  .dl-guide-summary-tagline { font-size:12px; }
  .dl-guide-body { padding:14px 16px 16px; }
}

/* Dark-theme overrides for the guide banner.
   Admin root defaults to DARK — so the banner's light palette would
   otherwise float as a white card on a dark page. We override every
   surface and text colour explicitly (no reliance on root tokens,
   same discipline as the modal) to guarantee the banner reads
   correctly in either theme without a flash of the other. */
[data-theme="dark"] .dl-guide {
  border-color:#3730a3;
  background:linear-gradient(180deg, rgba(79,70,229,.18) 0%, rgba(124,58,237,.14) 100%);
  box-shadow:0 1px 2px rgba(99,102,241,.18); }
[data-theme="dark"] .dl-guide[open] { background:#0f172a; }
[data-theme="dark"] .dl-guide-summary:hover { background:rgba(99,102,241,.14); }
[data-theme="dark"] .dl-guide[open] .dl-guide-summary {
  border-bottom-color:#1e293b; background:#1e1b4b; }
[data-theme="dark"] .dl-guide-summary-icon { background:#4f46e5; color:#fff; }
[data-theme="dark"] .dl-guide-summary-title { color:#f1f5f9; }
[data-theme="dark"] .dl-guide-summary-tagline { color:#cbd5e1; }
[data-theme="dark"] .dl-guide-summary-tagline em { color:#a5b4fc; }
[data-theme="dark"] .dl-guide-summary-chevron { color:#a5b4fc; }
[data-theme="dark"] .dl-guide-body { background:#0f172a; }
[data-theme="dark"] .dl-guide-h3 { color:#f1f5f9; }
[data-theme="dark"] .dl-guide-body p { color:#cbd5e1; }
[data-theme="dark"] .dl-guide-body strong { color:#f1f5f9; }
[data-theme="dark"] .dl-guide-body em { color:#94a3b8; }
[data-theme="dark"] .dl-guide-analogy {
  background:rgba(234,179,8,.08); border-left-color:#eab308; color:#fde68a; }
[data-theme="dark"] .dl-guide-analogy strong { color:#fde68a; }
[data-theme="dark"] .dl-guide-card { background:#1e293b; border-color:#334155; }
[data-theme="dark"] .dl-guide-card:hover {
  border-color:#6366f1; box-shadow:0 2px 8px rgba(99,102,241,.25); }
[data-theme="dark"] .dl-guide-card-num { background:#312e81; color:#c7d2fe; }
[data-theme="dark"] .dl-guide-card-title { color:#f1f5f9; }
[data-theme="dark"] .dl-guide-card-lede { color:#cbd5e1; }
[data-theme="dark"] .dl-guide-how { border-top-color:#334155; }
[data-theme="dark"] .dl-guide-how-summary { color:#a5b4fc; }
[data-theme="dark"] .dl-guide-how-summary:hover { color:#c7d2fe; }
[data-theme="dark"] .dl-guide-steps { color:#cbd5e1; }
[data-theme="dark"] .dl-guide-steps code {
  background:#0f172a; color:#e2e8f0; border:1px solid #1e293b; }
[data-theme="dark"] .dl-guide-steps kbd {
  background:#020617; color:#e2e8f0; border-color:#1e293b; }
[data-theme="dark"] .dl-guide-link { color:#a5b4fc; }
[data-theme="dark"] .dl-guide-link:hover { color:#c7d2fe; }
[data-theme="dark"] .dl-guide-prompt {
  background:#020617; color:#e2e8f0; border:1px solid #1e293b; }
[data-theme="dark"] .dl-guide-tip {
  background:rgba(16,185,129,.1); border-left-color:#10b981; color:#6ee7b7; }
[data-theme="dark"] .dl-guide-tip strong { color:#a7f3d0; }
[data-theme="dark"] .dl-guide-footer { border-top-color:#1e293b; }
[data-theme="dark"] .dl-guide-foot-note { color:#94a3b8; }
[data-theme="dark"] .dl-guide-foot-note strong { color:#e2e8f0; }
[data-theme="dark"] .dl-badge-inline { background:rgba(251,191,36,.18); color:#fcd34d; }
[data-theme="dark"] .dl-guide-dismiss {
  background:#1e293b; color:#cbd5e1; border-color:#334155; }
[data-theme="dark"] .dl-guide-dismiss:hover { background:#334155; color:#f1f5f9; }

/* ── Tabs ─────────────────────────────────────────────────────── */
.dl-tabs { display:flex; gap:4px; margin-bottom:16px; border-bottom:1px solid var(--border); }
.dl-tab { padding:10px 16px; font-size:14px; color:var(--text-muted); text-decoration:none;
  border-bottom:2px solid transparent; display:inline-flex; align-items:center; gap:8px;
  transition: color .12s; }
.dl-tab:hover { color:var(--text); }
.dl-tab-active { color:var(--text); font-weight:600; border-bottom-color:#6366f1; }
.dl-tab-count { font-size:11px; color:var(--text-muted); background:var(--surface-alt, #f1f5f9);
  padding:2px 8px; border-radius:10px; font-weight:500; }
.dl-tab-active .dl-tab-count { background:#eef2ff; color:#4338ca; }

/* ── Filter row (search + chips) ──────────────────────────────── */
.dl-filter-row { display:flex; flex-direction:column; gap:12px; margin-bottom:20px; }
.dl-search { position:relative; max-width:360px; }
.dl-search-input { width:100%; padding:9px 36px 9px 14px; border:1px solid var(--border);
  border-radius:8px; font-size:13px; background:var(--surface, #fff); color:var(--text);
  transition: border-color .12s, box-shadow .12s; }
.dl-search-input:focus { outline:none; border-color:#6366f1; box-shadow:0 0 0 3px rgba(99,102,241,.12); }
.dl-search-clear { position:absolute; right:10px; top:50%; transform:translateY(-50%);
  width:22px; height:22px; display:inline-flex; align-items:center; justify-content:center;
  border-radius:50%; background:var(--surface-alt, #f1f5f9); color:var(--text-muted);
  text-decoration:none; font-size:14px; line-height:1; }
.dl-search-clear:hover { background:#e2e8f0; color:var(--text); }

.dl-chips { display:flex; flex-wrap:wrap; gap:6px; }
.dl-chip { display:inline-flex; align-items:center; gap:6px; padding:6px 12px; border-radius:20px;
  border:1px solid var(--border); background:var(--surface, #fff); color:var(--text);
  font-size:12px; font-weight:500; text-decoration:none; transition: background .12s, border-color .12s; }
.dl-chip:hover { background:var(--surface-alt, #f8fafc); border-color:#cbd5e1; }
.dl-chip-count { font-size:11px; color:var(--text-muted); font-weight:500; }
.dl-chip-active { background:#1e293b; color:#fff; border-color:#1e293b; }
.dl-chip-active .dl-chip-count { color:rgba(255,255,255,.7); }
.dl-chip-sm { padding:2px 8px; font-size:11px; border:none; font-weight:600;
  text-transform:uppercase; letter-spacing:.02em; }

/* Per-category tint — subtle, not noisy. Each chip gets a faint
   background + a solid dot so the eye can zone in on the category
   without the page looking like a crayon box. */
.dl-chip-ecom      { background:#fef3c7; color:#92400e; }
.dl-chip-ai        { background:#ede9fe; color:#5b21b6; }
.dl-chip-devtool   { background:#dcfce7; color:#14532d; }
.dl-chip-saas      { background:#dbeafe; color:#1e3a8a; }
.dl-chip-media     { background:#fce7f3; color:#831843; }
.dl-chip-finance   { background:#d1fae5; color:#064e3b; }
.dl-chip-social    { background:#fee2e2; color:#7f1d1d; }
.dl-chip-travel    { background:#e0f2fe; color:#0c4a6e; }
.dl-chip-lifestyle { background:#fef2f2; color:#9f1239; }
.dl-chip-clone     { background:#f3e8ff; color:#6b21a8; }
.dl-chip-active.dl-chip-ecom,
.dl-chip-active.dl-chip-ai,
.dl-chip-active.dl-chip-devtool,
.dl-chip-active.dl-chip-saas,
.dl-chip-active.dl-chip-media,
.dl-chip-active.dl-chip-finance,
.dl-chip-active.dl-chip-social,
.dl-chip-active.dl-chip-travel,
.dl-chip-active.dl-chip-lifestyle { background:#1e293b; color:#fff; }

/* ── Grid + cards ────────────────────────────────────────────── */
.dl-grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(280px, 1fr)); gap:16px; }
.dl-card { position:relative; background:var(--surface, #fff); border:1px solid var(--border);
  border-radius:10px; overflow:hidden; display:flex; flex-direction:column;
  transition: transform .15s, box-shadow .15s, border-color .15s; }
.dl-card:hover { transform:translateY(-2px); box-shadow:0 8px 24px -6px rgba(0,0,0,.08); border-color:#cbd5e1; }
.dl-card-click { position:absolute; inset:0; background:transparent; border:0; cursor:pointer;
  z-index:1; padding:0; }
.dl-card > *:not(.dl-card-click) { position:relative; z-index:2; pointer-events:none; }
.dl-card .dl-inline-form, .dl-card .dl-btn-icon { pointer-events:auto; }
.dl-card-thumb { width:100%; aspect-ratio:16/9; object-fit:cover; border-bottom:1px solid var(--border);
  background:#f8fafc; display:block; }
.dl-card-thumb-placeholder { display:flex; align-items:center; justify-content:center;
  color:#cbd5e1;
  background: linear-gradient(135deg, #f8fafc 0%, #f1f5f9 100%); }
.dl-card-body { padding:14px; display:flex; flex-direction:column; gap:8px; flex:1 1 auto; }
.dl-card-head { display:flex; justify-content:space-between; align-items:flex-start; gap:8px; }
.dl-card-title { font-size:14px; font-weight:600; color:var(--text); margin:0; line-height:1.3;
  word-break:break-word; }
.dl-card-summary { font-size:12px; color:var(--text-muted); margin:0; line-height:1.5;
  display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
.dl-card-foot { display:flex; justify-content:space-between; align-items:center; gap:8px;
  margin-top:auto; padding-top:4px; }
.dl-card-age { font-size:11px; color:var(--text-muted); }

/* ── Buttons ─────────────────────────────────────────────────── */
.dl-btn-primary, .dl-btn-secondary, .dl-btn-danger {
  display:inline-flex; align-items:center; gap:6px; padding:9px 16px;
  border-radius:8px; font-size:13px; font-weight:600; cursor:pointer;
  border:1px solid var(--border); text-decoration:none; transition: background .12s, opacity .12s; }
.dl-btn-primary { background:#1e293b; color:#fff; border-color:transparent; }
.dl-btn-primary:hover:not(:disabled) { background:#0f172a; }
.dl-btn-primary:disabled { opacity:.6; cursor:not-allowed; }
.dl-btn-secondary { background:var(--surface, #fff); color:var(--text); }
.dl-btn-secondary:hover { background:var(--surface-alt, #f8fafc); }
.dl-btn-danger { background:transparent; color:#b91c1c; border-color:#fca5a5; }
.dl-btn-danger:hover { background:#fee2e2; }
.dl-btn-xs { display:inline-flex; align-items:center; gap:4px; padding:5px 10px; border-radius:6px;
  font-size:11px; font-weight:500; color:var(--text); background:var(--surface-alt, #f1f5f9);
  border:1px solid transparent; cursor:pointer; text-decoration:none; transition: background .12s; }
.dl-btn-xs:hover { background:#e2e8f0; }
.dl-btn-icon { display:inline-flex; align-items:center; justify-content:center;
  width:28px; height:28px; border-radius:6px; border:none; cursor:pointer;
  background:transparent; color:var(--text-muted); transition: background .12s, color .12s; }
.dl-btn-icon:hover { background:var(--surface-alt, #f1f5f9); color:var(--text); }
.dl-btn-icon.dl-btn-danger { color:#b91c1c; }
.dl-btn-icon.dl-btn-danger:hover { background:#fee2e2; }
.dl-inline-form { display:inline; margin:0; }

.dl-badge { display:inline-block; font-size:10px; font-weight:600; padding:2px 6px;
  border-radius:10px; margin-left:6px; }
.dl-badge-soon { background:rgba(255,255,255,.2); color:#fff; }

/* ── Empty state ─────────────────────────────────────────────── */
.dl-empty { background:var(--surface, #fff); border:1px dashed var(--border);
  border-radius:12px; padding:48px 24px; text-align:center; }
.dl-empty-title { font-size:18px; font-weight:700; color:var(--text); }
.dl-empty-body { font-size:13px; color:var(--text-muted); margin:8px auto 16px; max-width:480px; line-height:1.5; }

/* ── Modal (2-column, dark-mode aware) ───────────────────────── */
.dl-modal { position:fixed; border:none; padding:0; background:transparent;
  max-width:min(1280px, 96vw); width:100%; max-height:92vh; height:92vh;
  top:50%; left:50%; transform:translate(-50%, -50%);
  margin:0; overflow:visible; }
.dl-modal::backdrop { background:rgba(15, 23, 42, .55); backdrop-filter:blur(4px); }
.dl-modal-chrome { display:flex; flex-direction:column; height:100%;
  background:#ffffff; color:#1e293b; border-radius:12px; overflow:hidden;
  box-shadow:0 24px 64px -12px rgba(0,0,0,.25); border:1px solid #e2e8f0; }

/* Modal HEAD */
.dl-modal-head { display:flex; justify-content:space-between; align-items:flex-start;
  padding:16px 20px; border-bottom:1px solid #e2e8f0; gap:12px; flex:0 0 auto; }
.dl-modal-head-text { flex:1 1 auto; min-width:0; }
.dl-modal-title { font-size:18px; font-weight:700; margin:0 0 4px; color:#0f172a;
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.dl-modal-meta { display:flex; gap:8px; align-items:center; font-size:12px; color:#64748b; }
.dl-modal-slug { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.dl-modal-head-actions { display:flex; gap:4px; flex:0 0 auto; }

/* Modal BODY — the 2 columns */
.dl-modal-body { flex:1 1 auto; display:grid; grid-template-columns: minmax(320px, 42fr) minmax(320px, 58fr);
  min-height:0; overflow:hidden; }
.dl-modal-col { display:flex; flex-direction:column; min-height:0; min-width:0; }
.dl-modal-col-code { border-right:1px solid #e2e8f0; background:#fafbfc; }
.dl-modal-col-preview { background:#f1f5f9; }
.dl-modal-col-head { display:flex; justify-content:space-between; align-items:center;
  padding:10px 16px; border-bottom:1px solid #e2e8f0; flex:0 0 auto; background:#ffffff; }
.dl-modal-col-label { font-size:11px; font-weight:600; color:#64748b; text-transform:uppercase; letter-spacing:.06em; }
.dl-modal-col-actions { display:flex; gap:4px; }

/* Modal FOOT */
.dl-modal-foot { display:flex; justify-content:space-between; align-items:center;
  padding:12px 20px; border-top:1px solid #e2e8f0; flex:0 0 auto; background:#ffffff; gap:12px; }
.dl-toast { font-size:12px; color:#64748b; padding:4px 10px; border-radius:6px;
  background:#ecfdf5; color:#047857; font-weight:500; }

/* ── Iframe + loader ─────────────────────────────────────────── */
.dl-iframe-wrap { position:relative; flex:1 1 auto; min-height:0; overflow:hidden; background:#fff; }
.dl-iframe { width:100%; height:100%; border:0; background:#fff; display:block; }
.dl-iframe-loader { position:absolute; inset:0; display:flex; align-items:center; justify-content:center;
  background:#fafbfc; color:#64748b; font-size:13px; pointer-events:none;
  transition: opacity .2s; }
.dl-iframe-wrap.dl-loaded .dl-iframe-loader { opacity:0; }

/* ── Prose — DESIGN.md rendered body ─────────────────────────── */
.dl-prose { flex:1 1 auto; overflow-y:auto; padding:18px 20px; line-height:1.6;
  font-size:13px; color:#334155;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
.dl-prose .dl-h1 { font-size:20px; font-weight:700; color:#0f172a; margin:0 0 12px; letter-spacing:-.01em; }
.dl-prose .dl-h2 { font-size:15px; font-weight:700; color:#0f172a; margin:20px 0 8px;
  padding-bottom:4px; border-bottom:1px solid #e2e8f0; }
.dl-prose .dl-h3 { font-size:13px; font-weight:600; color:#334155; margin:14px 0 6px; }
.dl-prose .dl-p { margin:8px 0; }
.dl-prose .dl-list { margin:8px 0; padding-left:20px; }
.dl-prose .dl-list li { margin:4px 0; }
.dl-prose .dl-muted { color:#94a3b8; font-style:italic; }
.dl-prose a { color:#6366f1; }
.dl-prose strong { color:#0f172a; font-weight:600; }
.dl-prose .dl-inline-code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  background:#f1f5f9; color:#0f172a; padding:1px 6px; border-radius:4px; font-size:12px; }
.dl-prose .dl-code { background:#0f172a; color:#e2e8f0; padding:12px 14px; border-radius:8px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size:12px;
  overflow-x:auto; margin:10px 0; }
.dl-prose .dl-code code { background:transparent; color:inherit; padding:0; }
.dl-swatch { display:inline-block; width:10px; height:10px; border-radius:50%;
  border:1px solid rgba(0,0,0,.1); margin-right:5px; vertical-align:middle; }

/* ── "What is this file" hint — collapsed <details> under prose ─
   Lives at the bottom of the code column, outside .dl-prose so the
   scrollable prose doesn't eat it. Explicit bg + fg colours on BOTH
   light and dark so there's no chance of the dark-mode whiteness bug
   (details elements inherit from <dialog> which inherits from <html>
   — surprisingly fragile). */
.dl-hint { flex:0 0 auto; margin:0; padding:10px 20px 14px;
  background:#f8fafc; border-top:1px solid #e2e8f0; color:#475569;
  font-size:12.5px; line-height:1.55; }
.dl-hint-summary { display:inline-flex; align-items:center; gap:6px;
  cursor:pointer; font-weight:600; color:#0f172a;
  list-style:none; user-select:none; padding:2px 0; }
.dl-hint-summary::-webkit-details-marker { display:none; }
.dl-hint-summary:hover { color:#6366f1; }
.dl-hint-summary svg { flex:0 0 14px; color:#6366f1; }
.dl-hint[open] .dl-hint-summary { margin-bottom:8px; }
.dl-hint-body { color:#475569; }
.dl-hint-body p { margin:6px 0; }
.dl-hint-what { font-weight:600; color:#0f172a; margin-top:10px !important; }
.dl-hint-list { margin:6px 0 8px; padding-left:20px; }
.dl-hint-list li { margin:6px 0; }
.dl-hint-list strong { color:#0f172a; font-weight:600; }
.dl-hint-link { color:#6366f1; text-decoration:underline; text-underline-offset:2px; }
.dl-hint-link:hover { color:#4f46e5; }
.dl-hint-foot { font-size:11.5px; color:#64748b; font-style:italic;
  border-top:1px dashed #e2e8f0; padding-top:8px; margin-top:8px !important; }

/* ── Dark mode — modal only (site-admin root stays light) ────── */
/* Why the modal and not the whole page: dark mode on admin chrome is
   a separate feature; what Thai asked for here is a dark PREVIEW
   toggle — so the user can check how their cloned design reads on a
   dark canvas without navigating away. We flip the modal chrome too
   so text contrast stays right; otherwise white panels around a dark
   iframe fight the eye. */
.dl-modal[data-theme="dark"] .dl-modal-chrome {
  background:#0f172a; color:#e2e8f0; border-color:#1e293b; }
.dl-modal[data-theme="dark"] .dl-modal-head,
.dl-modal[data-theme="dark"] .dl-modal-col-head,
.dl-modal[data-theme="dark"] .dl-modal-foot { border-color:#1e293b; background:#0f172a; }
.dl-modal[data-theme="dark"] .dl-modal-col-code { background:#0b1220; border-color:#1e293b; }
.dl-modal[data-theme="dark"] .dl-modal-col-preview { background:#020617; }
.dl-modal[data-theme="dark"] .dl-modal-title { color:#f1f5f9; }
.dl-modal[data-theme="dark"] .dl-modal-meta,
.dl-modal[data-theme="dark"] .dl-modal-col-label { color:#94a3b8; }
.dl-modal[data-theme="dark"] .dl-btn-icon { color:#94a3b8; }
.dl-modal[data-theme="dark"] .dl-btn-icon:hover { background:#1e293b; color:#f1f5f9; }
.dl-modal[data-theme="dark"] .dl-btn-xs { background:#1e293b; color:#cbd5e1; }
.dl-modal[data-theme="dark"] .dl-btn-xs:hover { background:#334155; }
.dl-modal[data-theme="dark"] .dl-btn-primary { background:#6366f1; color:#fff; }
.dl-modal[data-theme="dark"] .dl-btn-primary:hover:not(:disabled) { background:#4f46e5; }
.dl-modal[data-theme="dark"] .dl-prose { color:#cbd5e1; }
.dl-modal[data-theme="dark"] .dl-prose .dl-h1,
.dl-modal[data-theme="dark"] .dl-prose .dl-h2 { color:#f1f5f9; }
.dl-modal[data-theme="dark"] .dl-prose .dl-h2 { border-color:#1e293b; }
.dl-modal[data-theme="dark"] .dl-prose .dl-h3 { color:#cbd5e1; }
.dl-modal[data-theme="dark"] .dl-prose strong { color:#f1f5f9; }
.dl-modal[data-theme="dark"] .dl-prose a { color:#818cf8; }
.dl-modal[data-theme="dark"] .dl-prose .dl-inline-code { background:#1e293b; color:#e2e8f0; }
.dl-modal[data-theme="dark"] .dl-prose .dl-code { background:#020617; border:1px solid #1e293b; }
.dl-modal[data-theme="dark"] .dl-prose .dl-muted { color:#64748b; }
.dl-modal[data-theme="dark"] .dl-iframe-loader { background:#0b1220; color:#94a3b8; }
.dl-modal[data-theme="dark"] .dl-iframe { background:#0f172a; }
.dl-modal[data-theme="dark"] .dl-toast { background:#064e3b; color:#6ee7b7; }
.dl-modal[data-theme="dark"] .dl-hint {
  background:#0b1220; border-top-color:#1e293b; color:#cbd5e1; }
.dl-modal[data-theme="dark"] .dl-hint-summary { color:#f1f5f9; }
.dl-modal[data-theme="dark"] .dl-hint-summary:hover { color:#a5b4fc; }
.dl-modal[data-theme="dark"] .dl-hint-summary svg { color:#a5b4fc; }
.dl-modal[data-theme="dark"] .dl-hint-body { color:#cbd5e1; }
.dl-modal[data-theme="dark"] .dl-hint-what,
.dl-modal[data-theme="dark"] .dl-hint-list strong { color:#f1f5f9; }
.dl-modal[data-theme="dark"] .dl-hint-foot { color:#94a3b8; border-top-color:#1e293b; }
.dl-modal[data-theme="dark"] .dl-hint-link { color:#a5b4fc; }
.dl-modal[data-theme="dark"] .dl-hint-link:hover { color:#c7d2fe; }

/* ── Responsive — stack the two modal columns on narrow screens ─ */
@media (max-width: 900px) {
  .dl-modal-body { grid-template-columns: 1fr; grid-template-rows: auto 1fr; }
  .dl-modal-col-code { border-right:0; border-bottom:1px solid #e2e8f0; max-height:40vh; }
  .dl-modal[data-theme="dark"] .dl-modal-col-code { border-bottom-color:#1e293b; }
  .dl-hero { flex-direction:column; align-items:flex-start; }
  .dl-hero-stats { width:100%; justify-content:flex-start; }
  .dl-stat { text-align:left; }
}
`

// ---------------------------------------------------------------------------
// Inline JS — modal open/close, AJAX load, dark toggle, copy, download
// ---------------------------------------------------------------------------

const DESIGN_LIBRARY_JS = `
(function(){
  var modal = document.getElementById('dl-preview-modal');
  if (!modal) return;

  var base = modal.getAttribute('data-base') || '';
  var titleEl = document.getElementById('dl-mt-title');
  var catEl = document.getElementById('dl-mt-cat');
  var slugEl = document.getElementById('dl-mt-slug');
  var mdEl = document.getElementById('dl-mt-md');
  var iframeEl = document.getElementById('dl-mt-iframe');
  var iframeWrap = document.getElementById('dl-mt-iframe-wrap');
  var iframeLoader = document.getElementById('dl-mt-iframe-loader');
  var copyBtn = document.getElementById('dl-mt-copy');
  var downloadBtn = document.getElementById('dl-mt-download');
  var openPreviewBtn = document.getElementById('dl-mt-open-preview');
  var toggleDarkBtn = document.getElementById('dl-mt-toggle-dark');
  var closeBtn = document.getElementById('dl-mt-close');
  var toastEl = document.getElementById('dl-mt-toast');
  var guideEl = document.getElementById('dl-guide');
  var guideDismissBtn = document.getElementById('dl-guide-dismiss');

  // 2026-04-26: hintCloneLink + guideCloneLink removed — both pointed
  // at the retired /clone-library URL. The recipe copy now points at
  // mailto:contact@gbox.co directly.

  // Dismiss button on the Getting Started banner. Writes the flag to
  // localStorage so the inline init script above keeps the banner
  // collapsed on subsequent visits. Closing the <details> here gives
  // the user immediate feedback — the page reflows and the banner
  // disappears except for its one-line summary. Wrapped in try/catch
  // for private-mode storage quirks.
  if (guideDismissBtn && guideEl) {
    guideDismissBtn.addEventListener('click', function () {
      try { localStorage.setItem('dl-guide-dismissed', '1'); } catch (_) {}
      guideEl.removeAttribute('open');
    });
  }

  var current = { source:null, slug:null, title:null, md:'' };

  function escHtml(s){
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function setCategoryChip(entry){
    if (entry.source === 'clone') {
      catEl.textContent = 'Clone';
      catEl.className = 'dl-chip dl-chip-sm dl-chip-clone';
      catEl.hidden = false;
    } else if (entry.category) {
      catEl.textContent = entry.categoryLabel || entry.category;
      catEl.className = 'dl-chip dl-chip-sm dl-chip-' + entry.category;
      catEl.hidden = false;
    } else {
      catEl.hidden = true;
    }
  }

  function showToast(msg){
    toastEl.textContent = msg;
    toastEl.hidden = false;
    clearTimeout(toastEl._hideTimer);
    toastEl._hideTimer = setTimeout(function(){ toastEl.hidden = true; }, 2000);
  }

  function setIframeSrc(dark){
    if (!current.source || !current.slug) return;
    iframeWrap.classList.remove('dl-loaded');
    var url = base + '/design-library/preview/' + encodeURIComponent(current.source) +
      '/' + encodeURIComponent(current.slug) + (dark ? '?dark=1' : '');
    iframeEl.src = url;
    openPreviewBtn.href = url;
  }

  // Wire "card click" → open modal
  document.addEventListener('click', function(ev){
    var t = ev.target;
    if (!(t instanceof Element)) return;

    // Never hijack clicks on nested actionable controls (delete button / form).
    if (t.closest('.dl-inline-form') || t.closest('.dl-btn-icon')) return;

    var trigger = t.closest('.dl-card-click');
    if (!trigger) return;
    var card = trigger.closest('.dl-card');
    if (!card) return;

    var source = card.getAttribute('data-dl-source');
    var slug = card.getAttribute('data-dl-slug');
    var title = card.getAttribute('data-dl-title') || '';
    if (!source || !slug) return;

    ev.preventDefault();
    openModal(source, slug, title);
  });

  function openModal(source, slug, title){
    current.source = source;
    current.slug = slug;
    current.title = title;
    current.md = '';

    // Reset state BEFORE showing so a slow fetch doesn't leave old data.
    titleEl.textContent = title || 'Loading…';
    slugEl.textContent = slug;
    catEl.hidden = true;
    mdEl.innerHTML = '<p class="dl-muted">Loading specification…</p>';
    modal.setAttribute('data-theme', 'light');
    iframeEl.src = 'about:blank';
    iframeWrap.classList.remove('dl-loaded');
    toastEl.hidden = true;

    if (typeof modal.showModal === 'function') {
      modal.showModal();
    } else {
      modal.setAttribute('open', '');
    }

    var url = base + '/design-library/entry/' + encodeURIComponent(source) +
      '/' + encodeURIComponent(slug);
    fetch(url, { credentials:'same-origin', headers:{ 'Accept':'application/json' } })
      .then(function(r){
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function(data){
        var entry = data.entry;
        if (!entry) throw new Error('no entry in response');
        current.md = entry.designMd || '';

        titleEl.textContent = entry.title;
        slugEl.textContent = entry.slug;
        setCategoryChip(entry);
        mdEl.innerHTML = entry.designMdHtml || '<p class="dl-muted">No specification available.</p>';

        var dlUrl = 'data:text/markdown;charset=utf-8,' + encodeURIComponent(current.md);
        downloadBtn.href = dlUrl;
        downloadBtn.setAttribute('download', entry.slug + '.md');

        setIframeSrc(modal.getAttribute('data-theme') === 'dark');
      })
      .catch(function(err){
        mdEl.innerHTML = '<p class="dl-muted">Failed to load specification: ' + escHtml(String(err && err.message || err)) + '</p>';
        console.warn('[design-library] modal load failed', err);
      });
  }

  function closeModal(){
    if (typeof modal.close === 'function') modal.close();
    else modal.removeAttribute('open');
    // Clear the iframe so a background tab doesn't hold onto the
    // brand site's CPU/network budget.
    iframeEl.src = 'about:blank';
  }

  closeBtn.addEventListener('click', closeModal);
  modal.addEventListener('click', function(ev){
    // Clicking the backdrop (outside the chrome) closes the modal.
    // We detect backdrop via target === dialog.
    if (ev.target === modal) closeModal();
  });
  modal.addEventListener('cancel', function(ev){
    ev.preventDefault();
    closeModal();
  });

  // Dark mode toggle — flips both the modal chrome AND the iframe src.
  toggleDarkBtn.addEventListener('click', function(){
    var next = modal.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    modal.setAttribute('data-theme', next);
    setIframeSrc(next === 'dark');
  });

  // Iframe load fade
  iframeEl.addEventListener('load', function(){
    // about:blank also fires 'load'; we only want the transition after
    // a real src (non-empty, non-about:blank).
    if (iframeEl.src && iframeEl.src !== 'about:blank') {
      iframeWrap.classList.add('dl-loaded');
    }
  });

  // Copy DESIGN.md — clipboard API with a safe execCommand fallback.
  copyBtn.addEventListener('click', function(){
    if (!current.md) { showToast('Nothing to copy yet'); return; }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(current.md).then(
        function(){ showToast('Copied to clipboard'); },
        function(){ fallbackCopy(current.md); }
      );
    } else {
      fallbackCopy(current.md);
    }
  });

  function fallbackCopy(text){
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.focus(); ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      showToast('Copied to clipboard');
    } catch (err) {
      showToast('Copy failed — select the text manually.');
    }
  }

  // Escape closes the modal — browser default on <dialog>, but some
  // legacy browsers don't honour it cleanly; belt-and-braces:
  document.addEventListener('keydown', function(ev){
    if (ev.key === 'Escape' && modal.open) closeModal();
  });
})();
`

// ─── Sprint 8: Theme actions bar ───────────────────────────────────────
//
// Two CTAs above the gallery grid:
//   • "Use the Gbox Default theme" → POST /theme-library/install-default
//   • "Import theme (.zip)"        → multipart POST /theme-library/import
//
// Errors surface via ?err=<code> in the URL — translated below to
// safe seller-friendly copy (Iron Rule 5).

import { importErrorMessage } from './theme-library/import.js'

function errFromQuery(req: Request): string | null {
  const e = (req as any)?.query?.err
  return typeof e === 'string' && e.length > 0 ? e : null
}

function renderThemeActionsBar(base: string, csrfToken: string, errCode: string | null): string {
  const errBanner = errCode
    ? `<div class="dl-banner dl-banner--err" role="alert">${esc(importErrorMessage(errCode))}</div>`
    : ''
  return `
    ${errBanner}
    <section class="dl-actions" aria-label="Theme actions">
      <div class="dl-actions__intro">
        <h2 class="dl-actions__title">Start a new theme</h2>
        <p class="dl-actions__sub">Spin up the bundled Gbox Default to customise from scratch, or upload a theme zip you've already built.</p>
      </div>
      <div class="dl-actions__buttons">
        <form method="POST" action="${esc(base)}/online-store/theme-library/install-default" class="dl-actions__form">
          <input type="hidden" name="_csrf" value="${esc(csrfToken)}" />
          <button type="submit" class="dl-btn dl-btn--primary">
            <span aria-hidden="true">✨</span>
            Use Gbox Default
          </button>
        </form>
        <form method="POST" action="${esc(base)}/online-store/theme-library/import" enctype="multipart/form-data" class="dl-actions__form dl-actions__import">
          <input type="hidden" name="_csrf" value="${esc(csrfToken)}" />
          <label class="dl-btn dl-btn--secondary">
            <span aria-hidden="true">📦</span>
            Import theme (.zip)
            <input type="file" name="theme_zip" accept=".zip,application/zip" required onchange="this.form.submit()" hidden />
          </label>
        </form>
      </div>
    </section>
    <style>
      .dl-actions {
        display: flex; align-items: center; justify-content: space-between;
        gap: 24px; flex-wrap: wrap;
        padding: 20px 24px; margin-bottom: 24px;
        background: var(--surface, var(--s-card));
        border: 1px solid var(--border, var(--s-border));
        border-radius: 12px;
      }
      .dl-actions__intro { flex: 1; min-width: 220px; }
      .dl-actions__title { margin: 0; font-size: 16px; font-weight: 600; color: var(--text, var(--s-text)); }
      .dl-actions__sub   { margin: 4px 0 0; font-size: 13px; color: var(--text-muted, var(--s-text-muted)); max-width: 520px; }
      .dl-actions__buttons { display: flex; gap: 8px; flex-wrap: wrap; }
      .dl-btn {
        display: inline-flex; align-items: center; gap: 8px;
        padding: 10px 16px; border-radius: 6px;
        font-size: 13px; font-weight: 600; cursor: pointer;
        border: 1px solid transparent; text-decoration: none;
      }
      .dl-btn--primary { background: var(--s-accent); color: #fff; }
      .dl-btn--primary:hover { background: var(--s-accent-hover); }
      .dl-btn--secondary {
        background: var(--surface, var(--s-card));
        border-color: var(--border-light, var(--s-border-light));
        color: var(--text, var(--s-text));
      }
      .dl-btn--secondary:hover { background: var(--surface-alt, var(--s-card-hover)); }
      .dl-banner { padding: 10px 14px; border-radius: 8px; margin-bottom: 16px; font-size: 13px; }
      .dl-banner--err { background: rgba(239,68,68,.12); color: var(--s-danger); border: 1px solid rgba(239,68,68,.25); }
    </style>
  `
}
