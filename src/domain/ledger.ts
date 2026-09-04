import type { Db } from '../db/index.js'

export type Unit = 'deni' | 'points'

export interface LedgerEntry {
  cardId: string
  unit: Unit
  /** Signed. Negative = money/points leaving the card. Always an integer. */
  amount: number
  kind: string
  txn?: string | null
  ref?: string | null
  actor?: string
  /**
   * The terminal session a wire-driven entry belongs to. Firmware txns recycle
   * across reboots, so this is what makes "have I already applied this txn?"
   * answerable — see migration 003.
   */
  sessionId?: string | null
}

/** The cached column on `cards` that mirrors SUM(ledger_entries.amount) for a unit. */
function cacheColumn(unit: Unit): 'balance_deni' | 'points' {
  if (unit === 'deni') return 'balance_deni'
  if (unit === 'points') return 'points'
  throw new Error(`unknown ledger unit: ${unit}`)
}

/**
 * Appends one immutable row and moves the cached balance by the same amount.
 * Never update or delete ledger rows — corrections are new, compensating entries.
 */
export function postEntry(db: Db, entry: LedgerEntry): void {
  if (!Number.isInteger(entry.amount)) {
    throw new Error(`ledger amount must be an integer, got ${entry.amount}`)
  }
  const column = cacheColumn(entry.unit)

  db.transaction(() => {
    db.prepare(
      `INSERT INTO ledger_entries (card_id, unit, amount, kind, txn, ref, actor, session_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      entry.cardId,
      entry.unit,
      entry.amount,
      entry.kind,
      entry.txn ?? null,
      entry.ref ?? null,
      entry.actor ?? 'system',
      entry.sessionId ?? null
    )
    const updated = db
      .prepare(`UPDATE cards SET ${column} = ${column} + ? WHERE id = ?`)
      .run(entry.amount, entry.cardId)
    if (updated.changes !== 1) {
      throw new Error(`no such card: ${entry.cardId}`)
    }
  })()
}

/** The authoritative balance: derived from the ledger, never stored. */
export function balanceOf(db: Db, cardId: string, unit: Unit): number {
  const row = db
    .prepare(
      'SELECT COALESCE(SUM(amount), 0) AS balance FROM ledger_entries WHERE card_id = ? AND unit = ?'
    )
    .get(cardId, unit) as { balance: number }
  return row.balance
}

/** Rebuilds the cached columns from the ledger. The ledger always wins. */
export function recomputeCache(db: Db, cardId: string): void {
  db.transaction(() => {
    db.prepare('UPDATE cards SET balance_deni = ?, points = ? WHERE id = ?').run(
      balanceOf(db, cardId, 'deni'),
      balanceOf(db, cardId, 'points'),
      cardId
    )
  })()
}

export interface LedgerRow {
  id: number
  card_id: string
  unit: Unit
  amount: number
  kind: string
  txn: string | null
  ref: string | null
  actor: string
  created_at: string
}

export function historyFor(db: Db, cardId: string, limit = 100): LedgerRow[] {
  return db
    .prepare('SELECT * FROM ledger_entries WHERE card_id = ? ORDER BY id DESC LIMIT ?')
    .all(cardId, limit) as LedgerRow[]
}
