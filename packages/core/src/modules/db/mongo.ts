/**
 * Gbox Platform — MongoDB connection layer
 *
 * Single MongoClient pool reused across all DBs (15 separate logical DBs:
 * Gbox-Users, Gbox-Shops, Gbox-Products, …). Each handler picks its DB by
 * key — `getMongoDb('USERS')` reads `process.env.MONGO_USERS` URI, which
 * already encodes user/pass + authSource + dbName.
 *
 * Why multiple DBs share ONE MongoClient: same host, same credentials,
 * different DB path in URI. Connecting once amortises TCP + auth handshake
 * across collections. We cache MongoClient per *host* so re-using a URI
 * for a different DB short-circuits to the existing pool.
 */
import { MongoClient, type Db } from 'mongodb'

export type MongoEnvKey =
  | 'USERS'
  | 'SHOPS'
  | 'PRODUCTS'
  | 'ORDERS'
  | 'CUSTOMERS'
  | 'PAYMENTS'
  | 'EMAILS'
  | 'WEBHOOKS'
  | 'PAGES'
  | 'LOCATIONS'
  | 'LAYOUTS'
  | 'SHIPPINGS'
  | 'APPS'

const clientByHost = new Map<string, MongoClient>()
const dbByEnvKey = new Map<MongoEnvKey, Db>()
let connectingPromise: Promise<void> | null = null

function hostKey(uri: string): string {
  // Strip credentials + path; keep host(s) + replicaSet so a pool is
  // shared across DBs on the same physical cluster.
  const u = new URL(uri)
  const replicaSet = u.searchParams.get('replicaSet') ?? ''
  return `${u.host}|${replicaSet}`
}

function dbNameFromUri(uri: string): string {
  const path = new URL(uri).pathname.replace(/^\//, '')
  if (!path) throw new Error(`MongoDB URI missing dbName path: ${uri}`)
  return path
}

/**
 * Resolve a Mongo `Db` handle for one of the platform DBs. Connects
 * lazily; cached after first call.
 */
export async function getMongoDb(envKey: MongoEnvKey): Promise<Db> {
  const cached = dbByEnvKey.get(envKey)
  if (cached) return cached

  const envName = `MONGO_${envKey}`
  const uri = process.env[envName]
  if (!uri) {
    throw new Error(`Missing env ${envName} — Mongo URI not configured`)
  }

  const host = hostKey(uri)
  let client = clientByHost.get(host)
  if (!client) {
    client = new MongoClient(uri, {
      maxPoolSize: 20,
      minPoolSize: 1,
      serverSelectionTimeoutMS: 5_000,
      retryWrites: true,
    })
    await client.connect()
    clientByHost.set(host, client)
  }

  const db = client.db(dbNameFromUri(uri))
  dbByEnvKey.set(envKey, db)
  return db
}

/**
 * Eagerly open the platform DBs at process startup so the first request
 * doesn't pay TCP+auth latency. Idempotent — safe to call multiple times.
 */
export async function connectMongo(keys: MongoEnvKey[] = ['USERS']): Promise<void> {
  if (connectingPromise) return connectingPromise
  connectingPromise = (async () => {
    await Promise.all(keys.map((k) => getMongoDb(k)))
  })()
  try {
    await connectingPromise
  } finally {
    connectingPromise = null
  }
}

/**
 * Graceful shutdown — close every cached client. Call from SIGTERM/SIGINT.
 */
export async function closeMongo(): Promise<void> {
  const clients = [...clientByHost.values()]
  clientByHost.clear()
  dbByEnvKey.clear()
  await Promise.all(clients.map((c) => c.close().catch(() => {})))
}
