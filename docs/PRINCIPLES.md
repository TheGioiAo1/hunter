# Gbox Platform — Engineering & Product Principles

Hard-won lessons distilled from Shopify / Stripe / ecommerce history.
These are defaults, not laws — violate them with a good reason and a
comment, not by accident.

---

## Security & Trust

### P1. Never trust the client for money
All prices, tax rates, shipping costs, discount amounts come from the
database, not from JSON the client sent. The client tells us *what* to
buy (product + quantity), we tell the client *what it costs*. This is
non-negotiable.

### P2. Idempotency is a UX feature, not a bug fix
Mobile networks drop POSTs. If you force users to stare at a spinner
and hope, they will double-tap. Any endpoint that creates/charges/
fulfills must honor `Idempotency-Key`. Cost: ~20 lines of middleware.
Benefit: zero double-charge support tickets.

### P3. Treat merchant email as a potential typo
Magic-link + 6-digit OTP is kinder than "enter your password
correctly". Typo-tolerant flows convert 30-40% better. Passwords are
the fallback, not the default.

### P4. Multi-tenant leaks happen at forgotten `WHERE shop_id=?`
Never hand-thread `shop_id` through handlers. Derive it once in
middleware (`req.shopId`) and make it impossible to query the DB
without it. This is Gbox's #1 security risk.

### P5. Webhook bodies are always signed
Outgoing: HMAC-SHA256 every body. Incoming: verify *before* parsing.
Never `JSON.parse` then verify — the parser can be tricked into
allocating gigabytes before you notice.

### P6. User-submitted HTML is XSS until proven otherwise
Product reviews, customer questions, CMS snippets: sanitize on write,
escape on render. Both. Belt and suspenders.

---

## Data & Architecture

### P7. Metafields solve 70% of "how do I customize X?"
When a merchant asks for a new product field, the answer is almost
always metafields. Only create a real column when the field affects
search, indexing, or billing.

### P8. Money has two currencies
`shop_money` (what the merchant sees in their books) and
`presentment_money` (what the buyer paid). Every monetary value in
orders carries both + the exchange rate snapshot. This is the single
most painful thing to add after the fact.

### P9. Orders are an event stream, not a row
The canonical source of truth for an order's history is the
`order_events` table, not the current state of the `orders` row. The
row is a derived view for fast reads. Disputes are impossible to
resolve without the timeline.

### P10. Prefer jsonb_agg over N+1
If you find yourself calling `getX()` in a loop after `listX()`,
replace both with a single query that uses `jsonb_agg` or
`kysely/helpers/postgres#jsonArrayFrom`. This is usually 10-30x faster
and halves your Postgres round-trip cost.

### P11. Never interpolate column names into ORDER BY
`?sort=price` is SQL injection waiting to happen. Use
`safeOrderBy(input, allowList, fallback)` every time.

### P12. File uploads are validated by magic bytes, not Content-Type
Content-Type is client-controlled. Read the first few bytes and refuse
anything that doesn't match an allow-listed signature. Reject SVG
outright unless you've parsed it as XML and stripped `<script>`.

---

## Performance

### P13. Cache is for reads, not for writes
Write-through caching is a footgun — the first stale read can poison
the cache for the TTL duration. Cache only where the source of truth
is trivially recomputable (product listing JSON, FX rates, CORS
allow-list).

### P14. Dashboard queries hit pre-aggregates, not raw tables
Any query that says `now() - interval '30 days'` on the admin hot path
is already broken at 500 merchants. Roll up into `daily_metrics`
nightly and let the dashboard read the pre-aggregated table.

### P15. Inventory decrement uses advisory locks, not row locks
Postgres advisory locks are ~10x faster than `SELECT FOR UPDATE`
because they don't hit the row. Use them for the oversell race
condition during checkout.

### P16. Hashed static assets are immutable
`Cache-Control: public, max-age=31536000, immutable` for anything
with a hash in the URL. Never for HTML.

---

## Product & UX

### P17. The refund flow is more important than the checkout flow
Customers who get refunded smoothly come back. Customers who have to
email support twice never come back. Invest accordingly.

### P18. "Password strength meter" has higher bounce than "6-digit code"
OTP/magic-link is not a lesser auth method. It's the better default
for most of our audience.

### P19. Search is a feature, not a query
Plan for `pg_trgm` (fuzzy match) and `pg_vector` (semantic) from day
one. `ILIKE '%search%'` is a last resort.

### P20. Every merchant flow needs a "what just happened?" receipt
After any mutation — product saved, order fulfilled, refund issued —
show a timestamped, copy-pasteable record. Shopify's Order Timeline UI
is the single most-used support tool.

### P21. Ask the merchant BEFORE you build the feature
Every new flow gets a workflow mindmap reviewed by Thai before code
is written. This is IRON RULE #3 in CLAUDE.md — it's listed here to
reinforce that this is also a product principle, not just a process
rule.

---

## Operational

### P22. Don't mock the DB in tests
Integration tests hit a real Postgres. Mocked tests pass while
migrations break in prod.

### P23. Every cron job is idempotent
Crons fire twice on network partitions. The second run must be a
no-op or `UPSERT`, never a duplicate insert.

### P24. Secrets in env vars, not in code, not in memory for diagnostic logs
If you need to log that a secret is "set", log its length, never its
value. Never `console.log(process.env)`.

### P25. Backups live OUTSIDE the directory they back up
Nginx backups in `sites-enabled/` cause "duplicate upstream" errors on
reload. Back up to `/etc/nginx/backups/` or `~/backups/`, never inside
the active config dir.

---

## How these principles get violated

- Time pressure ("we'll add it later" → you won't)
- "Just this once" (it won't be just this once)
- Copy-paste from a Stack Overflow answer that predates the principle
- A new team member who hasn't read this file

If you find yourself violating one of these, stop. Leave a comment
saying *which* principle and *why* the exception is safe. Future-you
will thank past-you.
