/**
 * Smoke test — Decision #1 Step 1.2a storage/ module factory behavior.
 *
 * Verifies:
 *   1. With no R2 env vars + NODE_ENV=development, getObjectStore() returns
 *      a MemoryStore and put/get round-trips.
 *   2. With no R2 env vars + NODE_ENV=production, getObjectStore() throws
 *      the configured refusal error.
 *   3. Singleton caching: two calls return the same instance.
 *   4. resetObjectStore() clears the cache.
 *   5. readR2ConfigFromEnv() returns null when creds are missing.
 *
 * This is a one-off verification of the end-to-end factory wiring. The
 * per-implementation behavior is covered by the vitest suites.
 *
 * Run:
 *   npx tsx scripts/smoke-storage-step-1-2a.ts
 */

import {
  getObjectStore,
  readR2ConfigFromEnv,
  resetObjectStore,
  MemoryStore,
} from '../packages/core/src/modules/storage/index.js'

async function main() {
  // Scrub any real env so the test is deterministic.
  delete process.env.R2_ENDPOINT
  delete process.env.R2_ACCESS_KEY_ID
  delete process.env.R2_SECRET_ACCESS_KEY

  // (1) Dev fallback → MemoryStore + round-trip.
  process.env.NODE_ENV = 'development'
  resetObjectStore()
  const dev = getObjectStore()
  if (!(dev instanceof MemoryStore)) throw new Error('expected MemoryStore in dev')
  await dev.put('hello.txt', 'world', { contentType: 'text/plain' })
  const got = await dev.get('hello.txt')
  if (!got || new TextDecoder().decode(got) !== 'world') {
    throw new Error('put/get round-trip failed')
  }
  console.log('PASS (1) dev fallback → MemoryStore round-trip')

  // (2) Singleton caching.
  const again = getObjectStore()
  if (again !== dev) throw new Error('expected singleton caching')
  console.log('PASS (2) singleton caching')

  // (3) resetObjectStore() clears the cache.
  resetObjectStore()
  const fresh = getObjectStore()
  if (fresh === dev) throw new Error('expected a new instance after reset')
  console.log('PASS (3) resetObjectStore() creates fresh instance')

  // (4) Production without creds → throw.
  process.env.NODE_ENV = 'production'
  resetObjectStore()
  let threw = false
  try {
    getObjectStore()
  } catch (e: any) {
    threw = /production/.test(e.message)
  }
  if (!threw) throw new Error('expected getObjectStore() to throw in production without creds')
  console.log('PASS (4) production without creds → throws')

  // (5) readR2ConfigFromEnv() returns null when creds are missing.
  if (readR2ConfigFromEnv() !== null) throw new Error('expected null config')
  console.log('PASS (5) readR2ConfigFromEnv() → null when creds missing')

  // Restore default.
  process.env.NODE_ENV = 'development'
  resetObjectStore()

  console.log('\nALL PASSED — Step 1.2a storage/ factory is correctly wired')
}

main().catch((err) => {
  console.error('FAIL:', err.message)
  console.error(err.stack)
  process.exit(1)
})
