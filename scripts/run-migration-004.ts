import 'dotenv/config'
import { createDb, destroyDb } from '../packages/db/src/index.ts'
import { up } from '../packages/db/src/migrations/004_refund_requests.ts'
import { sql } from 'kysely'

async function main() {
  const db = createDb()

  try {
    await up(db)
    console.log('Migration 004_refund_requests completed successfully')
  } catch (e: any) {
    if (e.message?.includes('already exists')) {
      console.log('Table refund_requests already exists, skipping')
    } else {
      console.error('Migration error:', e.message)
      await destroyDb()
      process.exit(1)
    }
  }

  // Verify
  try {
    const r = await sql`SELECT column_name, data_type FROM information_schema.columns WHERE table_name='refund_requests' ORDER BY ordinal_position`.execute(db)
    console.log('Table columns:', JSON.stringify(r.rows, null, 2))
  } catch (e: any) {
    console.error('Verify error:', e.message)
  }

  await destroyDb()
}

main()
