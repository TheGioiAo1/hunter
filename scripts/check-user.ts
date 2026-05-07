import 'dotenv/config'
import { createDb, destroyDb } from '../packages/db/src/index.ts'

async function main() {
  const db = createDb()
  const u = await db
    .selectFrom('users')
    .select(['email', 'password_hash', 'role', 'status'])
    .where('email', '=', 'buithai3107@gmail.com')
    .executeTakeFirst()

  if (u) {
    console.log('Email:', u.email)
    console.log('Role:', u.role)
    console.log('Status:', u.status)
    console.log('Hash prefix:', u.password_hash?.substring(0, 10))
    console.log('Has bcrypt:', u.password_hash?.startsWith('$2'))
  } else {
    console.log('User not found')
  }

  // Also check thaibq
  const s = await db
    .selectFrom('users')
    .select(['email', 'password_hash', 'role', 'status'])
    .where('email', '=', 'thaibq@gbox.co')
    .executeTakeFirst()

  if (s) {
    console.log('\nSeller Email:', s.email)
    console.log('Role:', s.role)
    console.log('Status:', s.status)
    console.log('Hash prefix:', s.password_hash?.substring(0, 10))
  }

  await destroyDb()
}

main()
