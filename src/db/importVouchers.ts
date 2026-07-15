import BetterSqlite3 from 'better-sqlite3'
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { loadConfig } from '../config.js'
import { denarsToDeni, getTicket, issueTicketWithId } from '../domain/tickets.js'
import { openDb, type Db } from './index.js'

/** The legacy voucher-server row shape. */
interface LegacyVoucher {
  id: string
  credit: number
  used: number
  created_at: string
}

export interface ImportResult {
  imported: number
  skipped: number
}

/**
 * One-time migration of /Users/ivanilijevski/voucher-server/vouchers.db into the
 * CMS ticket table.
 *
 * Idempotent: rows already present are skipped, so it is safe to re-run after a
 * partial import. A legacy `used = 1` becomes status 'redeemed' — an already
 * spent voucher must never become spendable again.
 */
export function importVouchers(db: Db, legacyDbPath: string): ImportResult {
  if (!existsSync(legacyDbPath)) {
    throw new Error(`legacy voucher database not found: ${legacyDbPath}`)
  }

  const legacy = new BetterSqlite3(legacyDbPath, { readonly: true })
  let rows: LegacyVoucher[]
  try {
    rows = legacy.prepare('SELECT id, credit, used, created_at FROM vouchers').all() as LegacyVoucher[]
  } finally {
    legacy.close()
  }

  let imported = 0
  let skipped = 0

  for (const row of rows) {
    if (getTicket(db, row.id)) {
      skipped++
      continue
    }

    db.transaction(() => {
      issueTicketWithId(db, {
        id: row.id,
        amountDeni: denarsToDeni(row.credit),
        source: 'legacy_import',
        createdAt: row.created_at,
        actor: 'import'
      })

      if (row.used === 1) {
        db.prepare(
          `UPDATE tickets SET status = 'redeemed', redeemed_at = ?, redeemed_by = 'legacy' WHERE id = ?`
        ).run(row.created_at, row.id)
        db.prepare(
          `INSERT INTO ticket_events (ticket_id, event, actor, details) VALUES (?, 'redeemed', 'import', ?)`
        ).run(row.id, JSON.stringify({ note: 'already used in the legacy voucher server' }))
      }
    })()
    imported++
  }

  return { imported, skipped }
}

async function main(): Promise<void> {
  const legacyPath = process.argv[2] ?? '/Users/ivanilijevski/voucher-server/vouchers.db'
  const config = loadConfig()
  const db = openDb(config.dbPath)

  const result = importVouchers(db, legacyPath)
  db.close()

  console.log(`imported vouchers from ${legacyPath} into ${config.dbPath}`)
  console.log(`  imported: ${result.imported}`)
  console.log(`  skipped (already present): ${result.skipped}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
