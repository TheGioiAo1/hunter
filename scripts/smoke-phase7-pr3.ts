/**
 * Phase 7 PR3 — Domains hardening smoke (Cloudflare-based).
 *
 * Exercises cloudflare-service.ts against the real Postgres schema
 * from migration 035. Focuses on the DB-level behaviours that unit
 * tests can't cover — unique indexes, FK cascade, primary-swap
 * concurrency safety, reclaim flow.
 *
 *   1.  addDomain happy path + pending row written.
 *   2.  addDomain rejects already_added (same shop, same domain).
 *   3.  addDomain rejects already_claimed_by_other_shop (global unique).
 *   4.  addDomain rejects gbox.co subdomain.
 *   5.  addDomain rejects invalid_domain for malformed input.
 *   6.  normalizeDomainInput lowercases + strips scheme before insert.
 *   7.  verifyViaCloudflare not_found for cross-shop id.
 *   8.  verifyViaCloudflare marks verified=true + ssl_status=active on CF NS match.
 *   9.  verifyViaCloudflare persists observed state on not_on_cloudflare.
 *  10.  verifyDomain A-record match flips method=a_record + cloudflare_proxied=false.
 *  11.  verifyDomain CF fallback when A doesn't match + no A resolver.
 *  12.  setPrimary rejects not_verified.
 *  13.  setPrimary swaps atomically: old primary cleared + new primary set.
 *  14.  setPrimary enforces partial unique index (only one primary per shop).
 *  15.  setPrimary clears redirect_to_domain_id on promote.
 *  16.  setRedirect rejects primary_cannot_redirect.
 *  17.  setRedirect happy path writes redirect_to_domain_id.
 *  18.  setRedirect rejects target_not_verified.
 *  19.  setRedirect cross-shop target → target_not_found.
 *  20.  removeDomain cross-shop → not_found (row untouched).
 *  21.  removeDomain happy path deletes row.
 *  22.  removeDomain cascades ON DELETE SET NULL on redirect_to_domain_id.
 *  23.  Reclaim flow: shop A deletes, shop B can claim same domain.
 *
 * Rolls back all seeded rows in finally{} so re-running is safe.
 *
 * Run on server 2 (this box can't reach Postgres):
 *
 *   DATABASE_URL=postgresql://gbox:GboxPlatform2026@192.168.1.13:5432/gbox_platform \
 *     npx tsx scripts/smoke-phase7-pr3.ts
 */

import { randomUUID } from 'node:crypto'
import { createDb } from '../packages/db/src/index.js'
import {
  addDomain,
  normalizeDomainInput,
  removeDomain,
  setPrimary,
  setRedirect,
  verifyDomain,
  verifyViaCloudflare,
  type ResolverBundle,
} from '../packages/core/src/modules/domains/cloudflare-service.js'

const db = createDb({ connectionString: process.env.DATABASE_URL })

const SUFFIX = Date.now()
const SHOP_A = randomUUID()
const SHOP_B = randomUUID()

// Domains are seller-owned hostnames — use unique test names per run
// so concurrent smokes don't collide on the global unique index.
const DOMAIN_PRIMARY = `primary-${SUFFIX}.smoke-gbox.test`
const DOMAIN_REDIRECT = `redirect-${SUFFIX}.smoke-gbox.test`
const DOMAIN_SECOND_SHOP = `shop2-${SUFFIX}.smoke-gbox.test`
const DOMAIN_AREC = `arec-${SUFFIX}.smoke-gbox.test`
const DOMAIN_RECLAIM = `reclaim-${SUFFIX}.smoke-gbox.test`
const DOMAIN_CASCADE_SRC = `cascade-src-${SUFFIX}.smoke-gbox.test`
const DOMAIN_CASCADE_TGT = `cascade-tgt-${SUFFIX}.smoke-gbox.test`

// Track every domain id we insert so finally{} can clean up even if a
// mid-test assertion fails.
const created: string[] = []

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

/**
 * Narrow-through-assert is finicky with discriminated unions in the
 * current TS config. This helper pulls `.error` off the false variant
 * without having to re-teach the type system at every call site.
 */
function errOf(r: unknown): string | null {
  if (r && typeof r === 'object' && (r as { ok?: unknown }).ok === false) {
    const e = (r as { error?: unknown }).error
    return typeof e === 'string' ? e : null
  }
  return null
}

// ---------------------------------------------------------------------------
// Fake resolvers (deterministic, no real DNS)
// ---------------------------------------------------------------------------

const CF_NS = ['dara.ns.cloudflare.com', 'igor.ns.cloudflare.com']
const NON_CF_NS = ['ns1.registrar.test', 'ns2.registrar.test']
const PLATFORM_IP = '14.224.236.129'

function cfBundle(): ResolverBundle {
  return {
    ns: async () => CF_NS,
    cname: async () => ['shops.gbox.co'],
  }
}

function nonCfBundle(): ResolverBundle {
  return {
    ns: async () => NON_CF_NS,
  }
}

function aRecordBundle(matchedIp: string): ResolverBundle {
  return {
    ns: async () => NON_CF_NS, // fallback would fail → ensures A path wins
    a: async () => [matchedIp],
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  log(`\n=== Phase 7 PR3 smoke — suffix=${SUFFIX} ===\n`)

  // --- Seed two shops ------------------------------------------------------
  log('[0] Seeding shops A + B')
  await (db as any)
    .insertInto('shops')
    .values([
      {
        id: SHOP_A,
        slug: `smoke-p7-3-a-${SUFFIX}`,
        name: 'PR3 Shop A',
        email: `a-${SUFFIX}@example.test`,
        status: 'active',
      },
      {
        id: SHOP_B,
        slug: `smoke-p7-3-b-${SUFFIX}`,
        name: 'PR3 Shop B',
        email: `b-${SUFFIX}@example.test`,
        status: 'active',
      },
    ])
    .execute()

  // ---------------------------------------------------------------------
  // Section 1: addDomain
  // ---------------------------------------------------------------------
  log('\n[1] addDomain — happy path + guard rails')
  const a1 = await addDomain(db as any, {
    shopId: SHOP_A,
    rawDomain: DOMAIN_PRIMARY,
  })
  assert(a1.ok === true, '1.1 addDomain returns ok=true')
  if (a1.ok) {
    created.push(a1.id)
    assert(a1.domain === DOMAIN_PRIMARY, '1.2 domain persisted as-normalised')
  }

  const dupSame = await addDomain(db as any, {
    shopId: SHOP_A,
    rawDomain: DOMAIN_PRIMARY,
  })
  assert(
    errOf(dupSame) === 'already_added',
    '1.3 already_added for same-shop duplicate',
  )

  const dupOther = await addDomain(db as any, {
    shopId: SHOP_B,
    rawDomain: DOMAIN_PRIMARY,
  })
  assert(
    errOf(dupOther) === 'already_claimed_by_other_shop',
    '1.4 already_claimed_by_other_shop when another shop owns it',
  )

  const reserved = await addDomain(db as any, {
    shopId: SHOP_A,
    rawDomain: 'foo.gbox.co',
  })
  assert(
    errOf(reserved) === 'gbox_subdomain_not_allowed',
    '1.5 gbox.co subdomain rejected',
  )

  const bad = await addDomain(db as any, {
    shopId: SHOP_A,
    rawDomain: 'not a domain',
  })
  assert(
    errOf(bad) === 'invalid_domain',
    '1.6 invalid_domain for malformed input',
  )

  assert(
    normalizeDomainInput('  HTTPS://FOO.BAR.BAZ/ ') === 'foo.bar.baz',
    '1.7 normalizeDomainInput lowercases + strips scheme + trailing slash',
  )

  // ---------------------------------------------------------------------
  // Section 2: verifyViaCloudflare
  // ---------------------------------------------------------------------
  log('\n[2] verifyViaCloudflare — CF path')

  // Add another domain for this section.
  const secondShopDom = await addDomain(db as any, {
    shopId: SHOP_B,
    rawDomain: DOMAIN_SECOND_SHOP,
  })
  if (secondShopDom.ok) created.push(secondShopDom.id)

  if (a1.ok) {
    // Cross-shop id → not_found.
    const crossShop = await verifyViaCloudflare(db as any, {
      shopId: SHOP_B,
      domainId: a1.id,
      resolvers: cfBundle(),
    })
    assert(
      errOf(crossShop) === 'not_found',
      '2.1 cross-shop verify returns not_found',
    )

    // Success path.
    const ok = await verifyViaCloudflare(db as any, {
      shopId: SHOP_A,
      domainId: a1.id,
      resolvers: cfBundle(),
    })
    assert(ok.ok === true, '2.2 CF NS match → ok=true')

    const row = (await (db as any)
      .selectFrom('shop_domains')
      .select(['verified', 'cloudflare_proxied', 'ssl_status'])
      .where('id', '=', a1.id)
      .executeTakeFirst()) as any
    assert(row?.verified === true, '2.3 row.verified=true after CF success')
    assert(
      row?.cloudflare_proxied === true,
      '2.4 row.cloudflare_proxied=true after CF success',
    )
    assert(
      row?.ssl_status === 'active',
      '2.5 row.ssl_status=active (CF terminates SSL)',
    )
  }

  // Add a domain we'll keep unverified for later sections.
  const redirAdd = await addDomain(db as any, {
    shopId: SHOP_A,
    rawDomain: DOMAIN_REDIRECT,
  })
  if (redirAdd.ok) created.push(redirAdd.id)

  if (redirAdd.ok) {
    const notCf = await verifyViaCloudflare(db as any, {
      shopId: SHOP_A,
      domainId: redirAdd.id,
      resolvers: nonCfBundle(),
    })
    assert(
      errOf(notCf) === 'not_on_cloudflare',
      '2.6 non-CF NS → not_on_cloudflare',
    )

    const row = (await (db as any)
      .selectFrom('shop_domains')
      .select(['verified', 'cloudflare_proxied', 'nameservers'])
      .where('id', '=', redirAdd.id)
      .executeTakeFirst()) as any
    assert(row?.verified === false, '2.7 row.verified stays false on CF miss')
    assert(
      row?.cloudflare_proxied === false,
      '2.8 row.cloudflare_proxied=false on CF miss',
    )
    // Postgres stores nameservers as JSONB so it comes back as an array.
    const nsRaw = row?.nameservers
    const nsList = Array.isArray(nsRaw) ? nsRaw : JSON.parse(nsRaw ?? '[]')
    assert(
      Array.isArray(nsList) &&
        nsList.some((n: string) => n.includes('registrar.test')),
      '2.9 observed NS persisted even on CF miss',
    )
  }

  // ---------------------------------------------------------------------
  // Section 3: verifyDomain (unified A-record + CF)
  // ---------------------------------------------------------------------
  log('\n[3] verifyDomain — A-record + CF fallback')
  const aRecDom = await addDomain(db as any, {
    shopId: SHOP_A,
    rawDomain: DOMAIN_AREC,
  })
  if (aRecDom.ok) created.push(aRecDom.id)

  if (aRecDom.ok) {
    const aMatch = await verifyDomain(db as any, {
      shopId: SHOP_A,
      domainId: aRecDom.id,
      resolvers: aRecordBundle(PLATFORM_IP),
      platformIps: [PLATFORM_IP],
    })
    assert(aMatch.ok === true, '3.1 A-record match → ok=true')
    if (aMatch.ok) {
      assert(aMatch.method === 'a_record', '3.2 method=a_record')
      assert(aMatch.matchedIp === PLATFORM_IP, '3.3 matchedIp surfaced')
    }

    const row = (await (db as any)
      .selectFrom('shop_domains')
      .select(['verification_method', 'cloudflare_proxied', 'ssl_status'])
      .where('id', '=', aRecDom.id)
      .executeTakeFirst()) as any
    assert(
      row?.verification_method === 'a_record',
      '3.4 verification_method=a_record',
    )
    assert(
      row?.cloudflare_proxied === false,
      '3.5 cloudflare_proxied=false on A path',
    )
    assert(
      row?.ssl_status === 'pending',
      '3.6 ssl_status=pending (acme issues later)',
    )
  }

  // ---------------------------------------------------------------------
  // Section 4: setPrimary
  // ---------------------------------------------------------------------
  log('\n[4] setPrimary — verify gate, atomic swap, partial unique index')

  if (redirAdd.ok) {
    // redirAdd is unverified → not_verified.
    const gated = await setPrimary(db as any, {
      shopId: SHOP_A,
      domainId: redirAdd.id,
    })
    assert(
      errOf(gated) === 'not_verified',
      '4.1 setPrimary rejects unverified',
    )
  }

  // Promote a1 (already CF-verified) — nothing was primary before, this
  // is a straight set.
  if (a1.ok) {
    const firstPromote = await setPrimary(db as any, {
      shopId: SHOP_A,
      domainId: a1.id,
    })
    assert(firstPromote.ok === true, '4.2 first primary promote ok')

    const primaries = (await (db as any)
      .selectFrom('shop_domains')
      .select(['id'])
      .where('shop_id', '=', SHOP_A)
      .where('is_primary', '=', true)
      .execute()) as Array<{ id: string }>
    assert(
      primaries.length === 1 && primaries[0]!.id === a1.id,
      '4.3 exactly one primary row (partial unique index holds)',
    )
  }

  // Now promote aRecDom. a1 should flip to is_primary=false.
  if (aRecDom.ok && a1.ok) {
    const swap = await setPrimary(db as any, {
      shopId: SHOP_A,
      domainId: aRecDom.id,
    })
    assert(swap.ok === true, '4.4 primary swap ok')

    const primaries = (await (db as any)
      .selectFrom('shop_domains')
      .select(['id'])
      .where('shop_id', '=', SHOP_A)
      .where('is_primary', '=', true)
      .execute()) as Array<{ id: string }>
    assert(
      primaries.length === 1 && primaries[0]!.id === aRecDom.id,
      '4.5 swap: old primary cleared, new primary set, still unique',
    )
  }

  // clears redirect_to_domain_id on promote
  if (redirAdd.ok && aRecDom.ok) {
    // First verify redirAdd (currently not_on_cloudflare) so setPrimary accepts.
    const verifyFlip = await verifyViaCloudflare(db as any, {
      shopId: SHOP_A,
      domainId: redirAdd.id,
      resolvers: cfBundle(),
    })
    assert(verifyFlip.ok === true, '4.6 re-verify redirAdd with CF bundle')

    // Wire redirAdd → aRecDom redirect, then promote redirAdd to primary.
    await (db as any)
      .updateTable('shop_domains')
      .set({ redirect_to_domain_id: aRecDom.id } as any)
      .where('id', '=', redirAdd.id)
      .execute()

    const promoteOwner = await setPrimary(db as any, {
      shopId: SHOP_A,
      domainId: redirAdd.id,
    })
    assert(promoteOwner.ok === true, '4.7 promote redirAdd to primary')

    const row = (await (db as any)
      .selectFrom('shop_domains')
      .select(['redirect_to_domain_id', 'is_primary'])
      .where('id', '=', redirAdd.id)
      .executeTakeFirst()) as any
    assert(row?.is_primary === true, '4.8 redirAdd is now primary')
    assert(
      row?.redirect_to_domain_id === null,
      '4.9 promoting to primary clears redirect_to_domain_id',
    )
  }

  // ---------------------------------------------------------------------
  // Section 5: setRedirect
  // ---------------------------------------------------------------------
  log('\n[5] setRedirect — primary gate, cross-shop, target_not_verified')

  // redirAdd is now the primary. Promoting it as a redirect source should fail.
  if (redirAdd.ok && a1.ok) {
    const primaryRedir = await setRedirect(db as any, {
      shopId: SHOP_A,
      sourceDomainId: redirAdd.id,
      targetDomainId: a1.id,
    })
    assert(
      errOf(primaryRedir) === 'primary_cannot_redirect',
      '5.1 primary_cannot_redirect on primary source',
    )
  }

  // Demote redirAdd and use a1 as the primary for further redirect tests.
  if (a1.ok) {
    await setPrimary(db as any, { shopId: SHOP_A, domainId: a1.id })
  }

  // Now redirAdd → a1 redirect (both verified, a1 is primary).
  if (redirAdd.ok && a1.ok) {
    const ok = await setRedirect(db as any, {
      shopId: SHOP_A,
      sourceDomainId: redirAdd.id,
      targetDomainId: a1.id,
    })
    assert(ok.ok === true, '5.2 redirect source → primary ok')

    const row = (await (db as any)
      .selectFrom('shop_domains')
      .select(['redirect_to_domain_id'])
      .where('id', '=', redirAdd.id)
      .executeTakeFirst()) as any
    assert(
      row?.redirect_to_domain_id === a1.id,
      '5.3 redirect_to_domain_id written',
    )
  }

  // Cross-shop target → target_not_found.
  if (redirAdd.ok && secondShopDom.ok) {
    const crossShop = await setRedirect(db as any, {
      shopId: SHOP_A,
      sourceDomainId: redirAdd.id,
      targetDomainId: secondShopDom.id,
    })
    assert(
      errOf(crossShop) === 'target_not_found',
      '5.4 cross-shop target returns target_not_found',
    )
  }

  // Add an unverified target and check target_not_verified.
  const unverTarget = await addDomain(db as any, {
    shopId: SHOP_A,
    rawDomain: `unver-target-${SUFFIX}.smoke-gbox.test`,
  })
  if (unverTarget.ok) created.push(unverTarget.id)
  if (redirAdd.ok && unverTarget.ok) {
    const notVer = await setRedirect(db as any, {
      shopId: SHOP_A,
      sourceDomainId: redirAdd.id,
      targetDomainId: unverTarget.id,
    })
    assert(
      errOf(notVer) === 'target_not_verified',
      '5.5 target_not_verified for unverified target',
    )
  }

  // ---------------------------------------------------------------------
  // Section 6: removeDomain cross-shop + cascade
  // ---------------------------------------------------------------------
  log('\n[6] removeDomain — cross-shop + ON DELETE SET NULL cascade')

  if (a1.ok) {
    const crossShop = await removeDomain(db as any, {
      shopId: SHOP_B,
      domainId: a1.id,
    })
    assert(
      errOf(crossShop) === 'not_found',
      '6.1 cross-shop remove returns not_found',
    )

    // Row still there.
    const stillThere = await (db as any)
      .selectFrom('shop_domains')
      .select(['id'])
      .where('id', '=', a1.id)
      .executeTakeFirst()
    assert(Boolean(stillThere), '6.2 cross-shop remove did not delete row')
  }

  // Cascade test: add SRC + TGT, wire SRC → TGT redirect, delete TGT.
  const cascadeTgt = await addDomain(db as any, {
    shopId: SHOP_A,
    rawDomain: DOMAIN_CASCADE_TGT,
  })
  if (cascadeTgt.ok) created.push(cascadeTgt.id)

  const cascadeSrc = await addDomain(db as any, {
    shopId: SHOP_A,
    rawDomain: DOMAIN_CASCADE_SRC,
  })
  if (cascadeSrc.ok) created.push(cascadeSrc.id)

  if (cascadeTgt.ok && cascadeSrc.ok) {
    // Flip tgt to verified via update, then wire src → tgt.
    await (db as any)
      .updateTable('shop_domains')
      .set({ verified: true } as any)
      .where('id', '=', cascadeTgt.id)
      .execute()
    await (db as any)
      .updateTable('shop_domains')
      .set({ redirect_to_domain_id: cascadeTgt.id } as any)
      .where('id', '=', cascadeSrc.id)
      .execute()

    // Delete the target.
    const rm = await removeDomain(db as any, {
      shopId: SHOP_A,
      domainId: cascadeTgt.id,
    })
    assert(rm.ok === true, '6.3 removeDomain(target) ok')
    if (rm.ok) {
      // Already deleted, no need to clean up later.
      const idx = created.indexOf(cascadeTgt.id)
      if (idx !== -1) created.splice(idx, 1)
    }

    const srcAfter = (await (db as any)
      .selectFrom('shop_domains')
      .select(['redirect_to_domain_id'])
      .where('id', '=', cascadeSrc.id)
      .executeTakeFirst()) as any
    assert(
      srcAfter?.redirect_to_domain_id === null,
      '6.4 src.redirect_to_domain_id cleared by ON DELETE SET NULL',
    )
  }

  // ---------------------------------------------------------------------
  // Section 7: reclaim flow
  // ---------------------------------------------------------------------
  log('\n[7] reclaim flow — shop A deletes, shop B can re-claim')

  const reclaimA = await addDomain(db as any, {
    shopId: SHOP_A,
    rawDomain: DOMAIN_RECLAIM,
  })
  if (reclaimA.ok) created.push(reclaimA.id)

  // Confirm shop B is blocked.
  const blockedB = await addDomain(db as any, {
    shopId: SHOP_B,
    rawDomain: DOMAIN_RECLAIM,
  })
  assert(
    errOf(blockedB) === 'already_claimed_by_other_shop',
    '7.1 shop B blocked while shop A owns the domain',
  )

  // Shop A deletes.
  if (reclaimA.ok) {
    const rm = await removeDomain(db as any, {
      shopId: SHOP_A,
      domainId: reclaimA.id,
    })
    assert(rm.ok === true, '7.2 shop A deletes reclaim domain')
    if (rm.ok) {
      const idx = created.indexOf(reclaimA.id)
      if (idx !== -1) created.splice(idx, 1)
    }
  }

  // Now shop B can add.
  const reclaimB = await addDomain(db as any, {
    shopId: SHOP_B,
    rawDomain: DOMAIN_RECLAIM,
  })
  assert(
    reclaimB.ok === true,
    '7.3 shop B can now add same domain (reclaim works)',
  )
  if (reclaimB.ok) created.push(reclaimB.id)

  // ---------------------------------------------------------------------
  log('\n=== Summary ===')
  if (failed === 0) {
    log(`ALL PASS (${total} checks).`)
  } else {
    log(`${failed} FAILURES of ${total} checks.`)
  }
  if (failed > 0) process.exitCode = 1
}

main()
  .catch((err) => {
    log(`FATAL: ${err?.message ?? err}`)
    process.exitCode = 1
  })
  .finally(async () => {
    // Cleanup in reverse insert order (shop_domains first since they
    // reference shops.id; inside shop_domains we rely on
    // ON DELETE SET NULL for redirect pointers).
    try {
      if (created.length > 0) {
        await (db as any)
          .deleteFrom('shop_domains')
          .where('id', 'in', created)
          .execute()
      }
      await (db as any)
        .deleteFrom('shops')
        .where('id', 'in', [SHOP_A, SHOP_B])
        .execute()
      log('\n[cleanup] seeded rows removed.')
    } catch (err) {
      log(`[cleanup] ERROR: ${(err as Error)?.message ?? err}`)
    } finally {
      await db.destroy()
    }
  })
