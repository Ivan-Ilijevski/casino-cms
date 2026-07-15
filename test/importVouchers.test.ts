import BetterSqlite3 from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { openTestDb, type Db } from '../src/db/index.js'
import { importVouchers } from '../src/db/importVouchers.js'
import { getTicket } from '../src/domain/tickets.js'

let db: Db
let dir: string
let legacyPath: string

/** Recreates the legacy voucher-server schema exactly. */
function makeLegacyDb(rows: Array<{ id: string; credit: number; used: number; created_at: string }>) {
  const legacy = new BetterSqlite3(legacyPath)
  legacy.exec(`
    CREATE TABLE IF NOT EXISTS vouchers (
      id TEXT PRIMARY KEY,
      credit INTEGER NOT NULL CHECK (credit >= 0),
      used INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `)
  const insert = legacy.prepare('INSERT INTO vouchers (id, credit, used, created_at) VALUES (?,?,?,?)')
  for (const r of rows) insert.run(r.id, r.credit, r.used, r.created_at)
  legacy.close()
}

beforeEach(() => {
  db = openTestDb()
  dir = mkdtempSync(join(tmpdir(), 'cms-import-'))
  legacyPath = join(dir, 'vouchers.db')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('importVouchers', () => {
  test('carries every legacy row across, converting denars to deni', () => {
    makeLegacyDb([
      { id: '136065428325788185', credit: 400, used: 0, created_at: '2025-09-22 21:03:13' },
      { id: '136065428325788186', credit: 246270, used: 1, created_at: '2025-09-23 10:00:00' }
    ])

    const result = importVouchers(db, legacyPath)

    expect(result).toEqual({ imported: 2, skipped: 0 })
    expect(getTicket(db, '136065428325788185')).toMatchObject({
      amount_deni: 40000,
      status: 'issued',
      source: 'legacy_import'
    })
    expect(getTicket(db, '136065428325788186')).toMatchObject({
      amount_deni: 24627000,
      status: 'redeemed'
    })
  })

  test('preserves the original created_at', () => {
    makeLegacyDb([{ id: 'A1', credit: 10, used: 0, created_at: '2025-09-22 21:03:13' }])

    importVouchers(db, legacyPath)

    expect(getTicket(db, 'A1')?.created_at).toBe('2025-09-22 21:03:13')
  })

  test('marks a used voucher redeemed so it can never be spent twice', () => {
    makeLegacyDb([{ id: 'USED', credit: 10, used: 1, created_at: '2025-09-22 21:03:13' }])

    importVouchers(db, legacyPath)

    expect(getTicket(db, 'USED')?.status).toBe('redeemed')
    expect(getTicket(db, 'USED')?.redeemed_at).not.toBeNull()
  })

  test('is idempotent — re-running skips rows already imported', () => {
    makeLegacyDb([{ id: 'A1', credit: 10, used: 0, created_at: '2025-09-22 21:03:13' }])
    importVouchers(db, legacyPath)

    const second = importVouchers(db, legacyPath)

    expect(second).toEqual({ imported: 0, skipped: 1 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM tickets').get()).toEqual({ n: 1 })
  })

  test('records an audit event per imported ticket', () => {
    makeLegacyDb([{ id: 'A1', credit: 10, used: 0, created_at: '2025-09-22 21:03:13' }])

    importVouchers(db, legacyPath)

    const events = db.prepare('SELECT * FROM ticket_events WHERE ticket_id = ?').all('A1') as any[]
    expect(events.some((e) => e.event === 'issued')).toBe(true)
  })
})
