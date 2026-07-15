import { randomBytes, randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { loadConfig } from '../config.js'
import { hashPassword } from '../domain/password.js'
import { openDb, type Db } from './index.js'

/**
 * The drink list the Python prototype hardcoded (tools/host_sim/cms_server.py
 * DEFAULT_MENU). Prices are deni; on the wire they go out as "price" unchanged.
 */
export const DEFAULT_MENU = [
  { drink_id: 1, name: 'Кафе', price_deni: 8000, points_price: 50, available: 1, sort_order: 1 },
  { drink_id: 2, name: 'Кока-Кола', price_deni: 10000, points_price: 80, available: 1, sort_order: 2 },
  { drink_id: 3, name: 'Скопско', price_deni: 12000, points_price: 100, available: 1, sort_order: 3 },
  { drink_id: 4, name: 'Вода', price_deni: 6000, points_price: 40, available: 1, sort_order: 4 },
  { drink_id: 5, name: 'Виски', price_deni: 25000, points_price: 0, available: 0, sort_order: 5 }
] as const

export interface SeedResult {
  menuInserted: number
  adminCreated: boolean
  adminUsername: string
  /** Only set when an admin was created and no password was supplied. */
  generatedPassword?: string
}

/** Idempotent: safe to run against an existing database. */
export function seed(db: Db, opts: { adminUsername?: string; adminPassword?: string } = {}): SeedResult {
  const adminUsername = opts.adminUsername ?? 'admin'

  const insertMenu = db.prepare(`
    INSERT OR IGNORE INTO menu_items (drink_id, name, price_deni, points_price, available, sort_order)
    VALUES (@drink_id, @name, @price_deni, @points_price, @available, @sort_order)
  `)
  let menuInserted = 0
  db.transaction(() => {
    for (const item of DEFAULT_MENU) {
      menuInserted += insertMenu.run(item).changes
    }
  })()

  const staffCount = (db.prepare('SELECT COUNT(*) AS n FROM staff_users').get() as { n: number }).n
  if (staffCount > 0) {
    return { menuInserted, adminCreated: false, adminUsername }
  }

  const generated = opts.adminPassword ? undefined : randomBytes(9).toString('base64url')
  const password = opts.adminPassword ?? generated!
  db.prepare(
    `INSERT INTO staff_users (id, username, password_hash, role) VALUES (?, ?, ?, 'admin')`
  ).run(randomUUID(), adminUsername, hashPassword(password))

  return {
    menuInserted,
    adminCreated: true,
    adminUsername,
    ...(generated ? { generatedPassword: generated } : {})
  }
}

async function main(): Promise<void> {
  const config = loadConfig()
  const db = openDb(config.dbPath)
  const result = seed(db, {
    adminUsername: process.env.CMS_ADMIN_USERNAME ?? 'admin',
    ...(process.env.CMS_ADMIN_PASSWORD ? { adminPassword: process.env.CMS_ADMIN_PASSWORD } : {})
  })
  db.close()

  console.log(`seeded ${config.dbPath}`)
  console.log(`  menu items inserted: ${result.menuInserted}`)
  if (result.adminCreated) {
    console.log(`  admin user created:  ${result.adminUsername}`)
    if (result.generatedPassword) {
      console.log(`  generated password:  ${result.generatedPassword}`)
      console.log('  ^ shown once — store it now, or set CMS_ADMIN_PASSWORD and reseed a fresh DB.')
    }
  } else {
    console.log('  staff users already exist — admin not touched')
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
