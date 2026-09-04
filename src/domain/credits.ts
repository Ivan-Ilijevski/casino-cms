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
 * Idempotent within a session, keyed on the ledger itself rather than a separate
 * table: the firmware retries until confirmed, and a replay must never
 * double-credit. Scoped to the session because txns recycle on every SMIB
 * reboot (migration 003) — keyed on the txn alone, the first cashout of a new
 * boot was mistaken for a retry and the player's money vanished.
 */
export function creditCard(
  db: Db,
  opts: { cardId: string; txn: string; amountDeni: number; sessionId?: string | null }
): CreditResult {
  if (!Number.isInteger(opts.amountDeni) || opts.amountDeni <= 0) {
    throw new Error(`credit amount must be a positive integer, got ${opts.amountDeni}`)
  }
  const sessionId = opts.sessionId ?? null

  return db.transaction((): CreditResult => {
    // Amount is deliberately not compared: a retry always repeats it, and if one
    // ever did not, crediting twice within a session is the worse outcome.
    const already = db
      .prepare(
        `SELECT 1 FROM ledger_entries
         WHERE txn = ? AND kind = ? AND card_id = ? AND session_id IS ?
         LIMIT 1`
      )
      .get(opts.txn, CREDIT_KIND, opts.cardId, sessionId)

    if (!already) {
      postEntry(db, {
        cardId: opts.cardId,
        unit: 'deni',
        amount: opts.amountDeni,
        kind: CREDIT_KIND,
        txn: opts.txn,
        sessionId
      })
    }

    return {
      ok: true,
      balanceDeni: balanceOf(db, opts.cardId, 'deni'),
      points: balanceOf(db, opts.cardId, 'points')
    }
  })()
}
