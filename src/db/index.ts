import BetterSqlite3 from 'better-sqlite3'
import { migrations } from './migrations.js'

export type Db = InstanceType<typeof BetterSqlite3>

export function migrate(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)
  const applied = new Set(
    db.prepare('SELECT name FROM schema_migrations').all().map((r) => (r as { name: string }).name)
  )
  const record = db.prepare('INSERT INTO schema_migrations (name) VALUES (?)')
  for (const m of migrations) {
    if (applied.has(m.name)) continue
    db.transaction(() => {
      db.exec(m.sql)
      record.run(m.name)
    })()
  }
}

/** Opens (creating if needed) the CMS database and brings the schema up to date. */
export function openDb(path: string): Db {
  const db = new BetterSqlite3(path)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  migrate(db)
  return db
}

/** In-memory database for tests. */
export function openTestDb(): Db {
  const db = new BetterSqlite3(':memory:')
  db.pragma('foreign_keys = ON')
  migrate(db)
  return db
}
