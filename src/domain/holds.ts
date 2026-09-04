import type { Db } from '../db/index.js'
import { balanceOf, postEntry } from './ledger.js'
import { pointsFor } from './points.js'

export type HoldState = 'held' | 'committed' | 'rolledback'
export type HoldErrCode = 'insufficient' | 'unknown_txn' | 'conflict' | 'txn_reused'

export type HoldResult =
  | { ok: true; balanceDeni: number; points: number }
  | { ok: false; code: HoldErrCode }

export interface HoldRow {
  id: number
  card_id: string
  txn: string
  session_id: string | null
  amount_deni: number
  state: HoldState
  created_at: string
  resolved_at: string | null
}

/**
 * The unresolved hold for a txn. At most one can exist — the partial unique
 * index enforces it — which is what lets debit_commit and debit_rollback find
 * their hold from a bare txn even though txns recycle across SMIB reboots.
 */
export function openHold(db: Db, txn: string): HoldRow | undefined {
  return db.prepare(`SELECT * FROM holds WHERE txn = ? AND state = 'held'`).get(txn) as
    | HoldRow
    | undefined
}

/**
 * What a bare txn resolves to: the outstanding hold if there is one, otherwise
 * the most recently settled hold that wore that number. Commit and rollback
 * both need the latter to stay idempotent after they have done their work.
 */
export function getHold(db: Db, txn: string): HoldRow | undefined {
  return (
    openHold(db, txn) ??
    (db.prepare('SELECT * FROM holds WHERE txn = ? ORDER BY id DESC LIMIT 1').get(txn) as
      | HoldRow
      | undefined)
  )
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
 * Idempotent within a session: the firmware retries debit_req on timeout, and a
 * retry repeats every field. It is NOT idempotent by txn alone — txns recycle
 * on every SMIB reboot (migration 003), and treating a recycled one as a replay
 * answered ok:true while charging nobody.
 */
export function placeHold(
  db: Db,
  opts: { cardId: string; txn: string; amountDeni: number; sessionId?: string | null }
): HoldResult {
  if (!Number.isInteger(opts.amountDeni) || opts.amountDeni <= 0) {
    return { ok: false, code: 'insufficient' }
  }
  const sessionId = opts.sessionId ?? null

  // A genuine retry repeats card, amount and session as well as the txn.
  // Anything that shares only the txn is a different transfer wearing a
  // recycled number, and must be charged for.
  const replay = db
    .prepare(
      `SELECT * FROM holds
       WHERE txn = ? AND session_id IS ? AND card_id = ? AND amount_deni = ?
       ORDER BY id DESC LIMIT 1`
    )
    .get(opts.txn, sessionId, opts.cardId, opts.amountDeni) as HoldRow | undefined
  if (replay) return { ok: true, ...balances(db, replay.card_id) }

  // Two open holds under one txn could never be told apart by a commit, which
  // carries nothing else. Refuse rather than guess which one it meant.
  if (openHold(db, opts.txn)) return { ok: false, code: 'txn_reused' }

  return db.transaction((): HoldResult => {
    if (opts.amountDeni > balanceOf(db, opts.cardId, 'deni')) {
      return { ok: false, code: 'insufficient' }
    }
    postEntry(db, {
      cardId: opts.cardId,
      unit: 'deni',
      amount: -opts.amountDeni,
      kind: 'aft_debit',
      txn: opts.txn,
      sessionId
    })
    db.prepare(
      `INSERT INTO holds (card_id, txn, session_id, amount_deni, state) VALUES (?, ?, ?, ?, 'held')`
    ).run(opts.cardId, opts.txn, sessionId, opts.amountDeni)
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
        txn: opts.txn,
        sessionId: hold.session_id
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
      ref: opts.reason ?? null,
      sessionId: hold.session_id
    })
    db.prepare(`UPDATE holds SET state = 'rolledback', resolved_at = datetime('now') WHERE txn = ? AND state = 'held'`).run(
      opts.txn
    )
    return { ok: true, ...balances(db, hold.card_id) }
  })()
}
