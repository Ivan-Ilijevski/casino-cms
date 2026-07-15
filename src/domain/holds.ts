import type { Db } from '../db/index.js'
import { balanceOf, postEntry } from './ledger.js'
import { pointsFor } from './points.js'

export type HoldState = 'held' | 'committed' | 'rolledback'
export type HoldErrCode = 'insufficient' | 'unknown_txn' | 'conflict'

export type HoldResult =
  | { ok: true; balanceDeni: number; points: number }
  | { ok: false; code: HoldErrCode }

export interface HoldRow {
  id: number
  card_id: string
  txn: string
  amount_deni: number
  state: HoldState
  created_at: string
  resolved_at: string | null
}

export function getHold(db: Db, txn: string): HoldRow | undefined {
  return db.prepare('SELECT * FROM holds WHERE txn = ?').get(txn) as HoldRow | undefined
}

function balances(db: Db, cardId: string): { balanceDeni: number; points: number } {
  return {
    balanceDeni: balanceOf(db, cardId, 'deni'),
    points: balanceOf(db, cardId, 'points')
  }
}

/**
 * Reserves funds for a transfer to the machine. The debit hits the ledger
 * immediately so the available balance can't be double-spent; the hold row
 * carries the state that decides whether it stays gone (commit) or comes back
 * (rollback).
 *
 * Idempotent by txn: a replay returns the current state without re-debiting.
 */
export function placeHold(
  db: Db,
  opts: { cardId: string; txn: string; amountDeni: number }
): HoldResult {
  const existing = getHold(db, opts.txn)
  if (existing) return { ok: true, ...balances(db, existing.card_id) }

  if (!Number.isInteger(opts.amountDeni) || opts.amountDeni <= 0) {
    return { ok: false, code: 'insufficient' }
  }

  return db.transaction((): HoldResult => {
    if (opts.amountDeni > balanceOf(db, opts.cardId, 'deni')) {
      return { ok: false, code: 'insufficient' }
    }
    postEntry(db, {
      cardId: opts.cardId,
      unit: 'deni',
      amount: -opts.amountDeni,
      kind: 'aft_debit',
      txn: opts.txn
    })
    db.prepare(`INSERT INTO holds (card_id, txn, amount_deni, state) VALUES (?, ?, ?, 'held')`).run(
      opts.cardId,
      opts.txn,
      opts.amountDeni
    )
    return { ok: true, ...balances(db, opts.cardId) }
  })()
}

/**
 * Finalises a hold after the money reached the machine, and awards points.
 *
 * MUST stay idempotent and keep succeeding: after a successful AFT the firmware
 * retries commit forever and must never be told to roll back.
 */
export function commitHold(db: Db, opts: { txn: string; pointsPerMkd: number }): HoldResult {
  const hold = getHold(db, opts.txn)
  if (!hold) return { ok: false, code: 'unknown_txn' }
  if (hold.state === 'rolledback') return { ok: false, code: 'conflict' }
  if (hold.state === 'committed') return { ok: true, ...balances(db, hold.card_id) }

  return db.transaction((): HoldResult => {
    db.prepare(`UPDATE holds SET state = 'committed', resolved_at = datetime('now') WHERE txn = ? AND state = 'held'`).run(
      opts.txn
    )
    const earned = pointsFor(hold.amount_deni, opts.pointsPerMkd)
    if (earned > 0) {
      postEntry(db, {
        cardId: hold.card_id,
        unit: 'points',
        amount: earned,
        kind: 'points_earned',
        txn: opts.txn
      })
    }
    return { ok: true, ...balances(db, hold.card_id) }
  })()
}

/**
 * Releases a hold whose transfer failed, returning the money.
 *
 * Idempotent. A rollback arriving after a commit reports ok but restores
 * nothing — committed money stays gone.
 */
export function rollbackHold(db: Db, opts: { txn: string; reason?: string }): HoldResult {
  const hold = getHold(db, opts.txn)
  if (!hold) return { ok: false, code: 'unknown_txn' }
  if (hold.state !== 'held') return { ok: true, ...balances(db, hold.card_id) }

  return db.transaction((): HoldResult => {
    postEntry(db, {
      cardId: hold.card_id,
      unit: 'deni',
      amount: hold.amount_deni,
      kind: 'aft_rollback',
      txn: opts.txn,
      ref: opts.reason ?? null
    })
    db.prepare(`UPDATE holds SET state = 'rolledback', resolved_at = datetime('now') WHERE txn = ? AND state = 'held'`).run(
      opts.txn
    )
    return { ok: true, ...balances(db, hold.card_id) }
  })()
}
