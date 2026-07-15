import type { Db } from '../db/index.js'
import { balanceOf, postEntry } from './ledger.js'

export const CREDIT_KIND = 'aft_credit'

export interface CreditResult {
  ok: true
  balanceDeni: number
  points: number
}

/**
 * Deposits money that has already left the machine onto the card (cashout).
 *
 * Idempotent by txn, keyed on the ledger itself rather than a separate table:
 * the firmware retries until confirmed, and a replay must never double-credit.
 */
export function creditCard(
  db: Db,
  opts: { cardId: string; txn: string; amountDeni: number }
): CreditResult {
  if (!Number.isInteger(opts.amountDeni) || opts.amountDeni <= 0) {
    throw new Error(`credit amount must be a positive integer, got ${opts.amountDeni}`)
  }

  return db.transaction((): CreditResult => {
    const already = db
      .prepare('SELECT 1 FROM ledger_entries WHERE txn = ? AND kind = ? LIMIT 1')
      .get(opts.txn, CREDIT_KIND)

    if (!already) {
      postEntry(db, {
        cardId: opts.cardId,
        unit: 'deni',
        amount: opts.amountDeni,
        kind: CREDIT_KIND,
        txn: opts.txn
      })
    }

    return {
      ok: true,
      balanceDeni: balanceOf(db, opts.cardId, 'deni'),
      points: balanceOf(db, opts.cardId, 'points')
    }
  })()
}
