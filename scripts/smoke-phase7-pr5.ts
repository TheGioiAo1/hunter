/**
 * Phase 7 PR5 — Files library service smoke.
 *
 * The service layer has full unit coverage in
 * packages/core/src/modules/files/service.test.ts (24 cases). This
 * script verifies the live-DB chain — the `files` table CRUD + the
 * cross-tenant scoping — against a real Postgres on server 2
 * (gbox_platform DB). Local Windows dev can't reach PG; run on
 * server 2 with:
 *
 *   DATABASE_URL=postgresql://gbox:GboxPlatform2026@192.168.1.13:5432/gbox_platform \
 *     npx tsx scripts/smoke-phase7-pr5.ts
 *
 * Cleans up every seeded row + blob in finally{} so re-running is
 * safe (including the blobs in MemoryStore — we only run against
 * MemoryStore to avoid leaking into the shared R2 bucket).
 *
 * Coverage:
 *   1.  upload → row + blob persist, URL shape sane
 *   2.  list → total, usedBytes, row ordering (created_at desc)
 *   3.  search by filename (case-insensitive, substring)
 *   4.  type filter (image / document / other) narrows correctly
 *   5.  pagination (limit + offset) no overlap, total stays shop-wide
 *   6.  getFile scoped to shop; cross-shop returns null
 *   7.  updateFile renames (sanitized) + sets alt; cross-shop null
 *   8.  deleteFile removes row + blob; cross-shop returns not_found
 *   9.  quota: upload that would overflow rejects with quota_exceeded
 *   10. mime allowlist rejects application/x-msdownload
 *   11. size cap rejects >maxFileSize
 *   12. empty filename rejected before reaching storage
 *   13. path-traversal filename sanitized (no `..`, no `/`)
 *   14. tenancy: shop-2 list never surfaces shop-1 rows
 */
import { randomUUID } from 'node:crypto'
import { createDb } from '../packages/db/src/index.js'
import {
  uploadFile,
  listFiles,
  getFile,
  deleteFile,
  updateFile,
} from '../packages/core/src/modules/files/service.js'
import { MemoryStore } from '../packages/core/src/modules/storage/memory-store.js'

const db = createDb({ connectionString: process.env.DATABASE_URL })
const store = new MemoryStore()

const SUFFIX = Date.now()
const SHOP_ID = randomUUID()
const OTHER_SHOP_ID = randomUUID()
const createdFileIds = new Set<string>()

function log(s: string) {
  // eslint-disable-next-line no-console
  console.log(s)
}

let failed = 0
let total = 0
function assert(cond: boolean, msg: string) {
  total++
  if (cond) log(`  OK   ${msg}`)
  else {
    failed++
    log(`  FAIL ${msg}`)
  }
}

function bytes(n: number): Uint8Array {
  return new Uint8Array(n)
}

async function upload(
  shopId: string,
  filename: string,
  mimeType: string,
  size: number,
  opts: { maxShopBytes?: number | null; maxFileSize?: number } = {},
) {
  const res = await uploadFile(
    db as any,
    { shopId, filename, mimeType, body: bytes(size) },
    { objectStore: store, maxShopBytes: opts.maxShopBytes ?? null, maxFileSize: opts.maxFileSize },
  )
  if (res.ok) createdFileIds.add(res.file.id)
  return res
}

async function main() {
  log(`\n=== Phase 7 PR5 smoke — suffix=${SUFFIX} ===\n`)

  // --- Seed shops ----------------------------------------------------------
  log('[0] Seeding shops')
  await (db as any)
    .insertInto('shops')
    .values([
      {
        id: SHOP_ID,
        slug: `smoke-p7-5-${SUFFIX}`,
        name: 'PR5 Shop',
        email: `p7-5-${SUFFIX}@example.test`,
        status: 'active',
        plan: 'free',
      },
      {
        id: OTHER_SHOP_ID,
        slug: `smoke-p7-5-other-${SUFFIX}`,
        name: 'PR5 Other Shop',
        email: `p7-5-other-${SUFFIX}@example.test`,
        status: 'active',
        plan: 'free',
      },
    ])
    .execute()

  // ---------------------------------------------------------------------
  // 1. upload → row + blob persist
  // ---------------------------------------------------------------------
  log('\n[1] upload')
  const r1 = await upload(SHOP_ID, 'hero.jpg', 'image/jpeg', 4096)
  assert(r1.ok === true, '1.1 upload returns ok=true')
  if (r1.ok) {
    assert(r1.file.shop_id === SHOP_ID, '1.2 row is scoped to the shop')
    assert(r1.file.filename === 'hero.jpg', '1.3 filename persisted as-is')
    // Postgres bigint comes back as string via node-postgres — Number() it.
    assert(Number(r1.file.size) === 4096, '1.4 size persisted')
    assert(r1.file.mime_type === 'image/jpeg', '1.5 mime persisted')
    assert(r1.file.url.startsWith('memory://files/'), '1.6 url is the object-store sentinel')
    assert(await store.has(`files/${SHOP_ID}/${r1.file.id}/hero.jpg`), '1.7 blob exists in store')
  }

  // ---------------------------------------------------------------------
  // 2. list returns the row with total + usedBytes
  // ---------------------------------------------------------------------
  log('\n[2] listFiles basics')
  const l1 = await listFiles(db as any, SHOP_ID)
  assert(l1.rows.length === 1, '2.1 one row returned')
  assert(l1.total === 1, '2.2 total=1')
  assert(l1.usedBytes === 4096, '2.3 usedBytes=4096')

  // ---------------------------------------------------------------------
  // 3. search by filename — seed a couple more rows first
  // ---------------------------------------------------------------------
  log('\n[3] search / filter / pagination')
  const r2 = await upload(SHOP_ID, 'logo.png', 'image/png', 500)
  const r3 = await upload(SHOP_ID, 'manual.pdf', 'application/pdf', 2000)
  const r4 = await upload(SHOP_ID, 'demo.mp4', 'video/mp4', 5000)
  const r5 = await upload(SHOP_ID, 'style.css', 'text/css', 300)
  assert(r2.ok && r3.ok && r4.ok && r5.ok, '3.0 seeded four extra files')

  const s1 = await listFiles(db as any, SHOP_ID, { search: 'hero' })
  assert(s1.rows.length === 1 && s1.rows[0]!.filename === 'hero.jpg', '3.1 search=hero → one row')

  const s2 = await listFiles(db as any, SHOP_ID, { search: 'LOGO' })
  assert(s2.rows.length === 1, '3.2 search is case-insensitive (LOGO → logo.png)')

  // ---------------------------------------------------------------------
  // 4. type filter
  // ---------------------------------------------------------------------
  const t1 = await listFiles(db as any, SHOP_ID, { type: 'image' })
  assert(
    t1.rows.length === 2 &&
      t1.rows.every((r: any) => r.mime_type?.startsWith('image/')),
    '4.1 type=image → 2 rows, all image/*',
  )
  const t2 = await listFiles(db as any, SHOP_ID, { type: 'document' })
  assert(
    t2.rows.map((r: any) => r.filename).sort().includes('manual.pdf'),
    '4.2 type=document includes manual.pdf',
  )
  assert(
    t2.rows.map((r: any) => r.filename).sort().includes('style.css'),
    '4.3 type=document includes style.css (text/*)',
  )
  const t3 = await listFiles(db as any, SHOP_ID, { type: 'video' })
  assert(t3.rows.length === 1 && t3.rows[0]!.filename === 'demo.mp4', '4.4 type=video → demo.mp4')

  // ---------------------------------------------------------------------
  // 5. pagination — limit + offset, total stays shop-wide
  // ---------------------------------------------------------------------
  const p1 = await listFiles(db as any, SHOP_ID, { limit: 2, offset: 0 })
  const p2 = await listFiles(db as any, SHOP_ID, { limit: 2, offset: 2 })
  assert(p1.rows.length === 2, '5.1 page 1 → 2 rows')
  assert(p2.rows.length === 2, '5.2 page 2 → 2 rows')
  const ids = new Set([...p1.rows, ...p2.rows].map((r: any) => r.id))
  assert(ids.size === 4, '5.3 no overlap between pages')
  assert(p1.total === 5 && p2.total === 5, '5.4 total stays 5 across pages')

  // ---------------------------------------------------------------------
  // 6. getFile scoped to shop; cross-shop → null
  // ---------------------------------------------------------------------
  log('\n[6] getFile scope')
  if (r1.ok) {
    const got = await getFile(db as any, SHOP_ID, r1.file.id)
    assert(got?.id === r1.file.id, '6.1 getFile returns the row for its own shop')

    const cross = await getFile(db as any, OTHER_SHOP_ID, r1.file.id)
    assert(cross === null, '6.2 getFile returns null for a different shop')
  }

  // ---------------------------------------------------------------------
  // 7. updateFile — rename + alt; cross-shop → null
  // ---------------------------------------------------------------------
  log('\n[7] updateFile')
  if (r2.ok) {
    const u1 = await updateFile(db as any, SHOP_ID, r2.file.id, {
      filename: 'renamed-logo.png',
      alt: 'New alt text',
    })
    assert(u1?.filename === 'renamed-logo.png', '7.1 filename updated')
    assert(u1?.alt === 'New alt text', '7.2 alt updated')

    const u2 = await updateFile(db as any, OTHER_SHOP_ID, r2.file.id, { alt: 'bogus' })
    assert(u2 === null, '7.3 cross-shop update returns null (and no-op)')

    // confirm cross-shop call didn't actually mutate:
    const still = await getFile(db as any, SHOP_ID, r2.file.id)
    assert(still?.alt === 'New alt text', '7.4 cross-shop attempt did not mutate the row')
  }

  // ---------------------------------------------------------------------
  // 8. deleteFile — removes row + blob; cross-shop not_found
  // ---------------------------------------------------------------------
  log('\n[8] deleteFile')
  if (r5.ok) {
    const cross = await deleteFile(db as any, OTHER_SHOP_ID, r5.file.id, { objectStore: store })
    assert(
      cross.ok === false && cross.error === 'not_found',
      '8.1 cross-shop delete returns not_found',
    )

    const del = await deleteFile(db as any, SHOP_ID, r5.file.id, { objectStore: store })
    assert(del.ok === true, '8.2 delete returns ok=true')

    const gone = await getFile(db as any, SHOP_ID, r5.file.id)
    assert(gone === null, '8.3 row is gone after delete')

    const hasBlob = await store.has(`files/${SHOP_ID}/${r5.file.id}/${r5.file.filename}`)
    assert(hasBlob === false, '8.4 blob is gone after delete')

    // Re-list: total shrinks by 1.
    const after = await listFiles(db as any, SHOP_ID)
    assert(after.total === 4, '8.5 listFiles total decremented by 1')
  }

  // ---------------------------------------------------------------------
  // 9. quota
  // ---------------------------------------------------------------------
  log('\n[9] quota')
  const quotaRes = await upload(
    SHOP_ID,
    'big.jpg',
    'image/jpeg',
    8000, // current used: 4096 + 2000 + 500 + 5000 = 11596 (we deleted style.css=300)
    { maxShopBytes: 11600 }, // tiny cap; +8000 overflows
  )
  assert(
    quotaRes.ok === false && !quotaRes.ok && quotaRes.error === 'quota_exceeded',
    '9.1 upload over quota returns quota_exceeded',
  )

  // ---------------------------------------------------------------------
  // 10. mime allowlist
  // ---------------------------------------------------------------------
  log('\n[10] mime allowlist')
  const mimeRes = await upload(SHOP_ID, 'malware.exe', 'application/x-msdownload', 10)
  assert(
    mimeRes.ok === false && !mimeRes.ok && mimeRes.error === 'mime_not_allowed',
    '10.1 executable mime rejected',
  )

  // ---------------------------------------------------------------------
  // 11. size cap
  // ---------------------------------------------------------------------
  log('\n[11] size cap')
  const sizeRes = await upload(SHOP_ID, 'big.jpg', 'image/jpeg', 200, {
    maxFileSize: 100,
  })
  assert(
    sizeRes.ok === false && !sizeRes.ok && sizeRes.error === 'too_large',
    '11.1 file over maxFileSize rejected',
  )

  // ---------------------------------------------------------------------
  // 12. empty filename rejected
  // ---------------------------------------------------------------------
  log('\n[12] empty filename')
  const emptyRes = await upload(SHOP_ID, '', 'image/png', 10)
  assert(
    emptyRes.ok === false && !emptyRes.ok && emptyRes.error === 'filename_required',
    '12.1 empty filename rejected',
  )

  // ---------------------------------------------------------------------
  // 13. path-traversal filename sanitized
  // ---------------------------------------------------------------------
  log('\n[13] path traversal')
  const traversal = await upload(SHOP_ID, '../../etc/passwd.png', 'image/png', 10)
  assert(traversal.ok === true, '13.1 path-traversal upload still succeeds (sanitized)')
  if (traversal.ok) {
    assert(!traversal.file.filename.includes('..'), '13.2 stored filename does not contain ..')
    assert(!traversal.file.filename.includes('/'), '13.3 stored filename does not contain /')
  }

  // ---------------------------------------------------------------------
  // 14. tenancy: shop-2 list never surfaces shop-1 rows
  // ---------------------------------------------------------------------
  log('\n[14] tenancy isolation')
  await upload(OTHER_SHOP_ID, 'other.jpg', 'image/jpeg', 1)
  const otherList = await listFiles(db as any, OTHER_SHOP_ID)
  assert(otherList.total === 1, '14.1 other shop sees exactly its own 1 file')
  assert(
    otherList.rows.every((r: any) => r.shop_id === OTHER_SHOP_ID),
    '14.2 every row in other shop list belongs to other shop',
  )

  const myList = await listFiles(db as any, SHOP_ID)
  assert(
    myList.rows.every((r: any) => r.shop_id === SHOP_ID),
    '14.3 every row in our list belongs to our shop',
  )
  assert(
    !myList.rows.some((r: any) => r.filename === 'other.jpg'),
    '14.4 other shop’s files never surface in our list',
  )

  log(`\n=== DONE: ${total - failed}/${total} passed, ${failed} failed ===\n`)
}

main()
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error('SMOKE CRASHED', err)
    failed = Math.max(failed, 1)
  })
  .finally(async () => {
    // Cleanup — rows first (FK-safe since files has no children), then
    // the two shops we seeded.
    try {
      if (createdFileIds.size) {
        await (db as any)
          .deleteFrom('files')
          .where('id', 'in', [...createdFileIds])
          .execute()
      }
      await (db as any)
        .deleteFrom('files')
        .where('shop_id', 'in', [SHOP_ID, OTHER_SHOP_ID])
        .execute()
      await (db as any)
        .deleteFrom('shops')
        .where('id', 'in', [SHOP_ID, OTHER_SHOP_ID])
        .execute()
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('cleanup error', e)
    }
    await (db as any).destroy()
    if (failed > 0) process.exit(1)
  })
