import type { Db } from '../db/index.js'
import { balanceOf } from './ledger.js'
import type { PayMethod } from './orders.js'
import { getIntent, type Direction } from './pos.js'
import { tryCanonUid } from './uid.js'

/**
 * What the guest's card slip says — the paper an Ingenico terminal would hand over
 * next to the till's fiscal receipt. Here one printer does both, so the tablet draws
 * this above the fiscal receipt, or on its own for a sale that has none.
 *
 * It is NOT a fiscal document and is deliberately never kept: no row, no number, no
 * print log, no КОПИЈА. The receipts table stays the only record of what was issued,
 * and a reprint from Сметки is the fiscal receipt alone. These facts exist only in the
 * one /pos/confirm response that produced them.
 */
export interface PaymentSlip {
  /** The venue's address from config; null when unset rather than a blank line. */
  address: string | null
  /** When the charge was approved, as an ISO instant. */
  at: string
  /** Only the last four hex digits of the canonical UID — `**** 5AF4`. */
  card: string
  playerName: string
  direction: Direction
  pay: PayMethod
  amountDeni: number
  amountPoints: number
  /** Чипови / Друго for a custom charge; null for a bar order. */
  label: string | null
  orderNumber: number | null
  /** The intent's first eight hex digits — enough to find the sale again. */
  reference: string
  pinVerified: boolean
  /** The staff member whose session took the payment. */
  staff: string
  /** Balances before and after the payment. */
  balanceBeforeDeni: number
  pointsBefore: number
  balanceDeni: number
  points: number
}

export class UnknownPaymentError extends Error {
  constructor(intentId: string) {
    super(`no consumed POS intent ${intentId}`)
    this.name = 'UnknownPaymentError'
  }
}

/**
 * The slip for a payment that has just been confirmed.
 *
 * Read back from the consumed intent rather than taken from the request, so the slip
 * can only say what was actually charged. A blank address reads as null for the reason
 * renderReceipt gives: a blank header line is worse than none.
 */
export function paymentSlip(
  db: Db,
  intentId: string,
  opts: { address: string; at: Date }
): PaymentSlip {
  const intent = getIntent(db, intentId)
  if (!intent || intent.state !== 'consumed') throw new UnknownPaymentError(intentId)

  const card = db
    .prepare(
      `SELECT c.card_uid, c.card_uid_canon, p.name
       FROM cards c JOIN players p ON p.id = c.player_id
       WHERE c.id = ?`
    )
    .get(intent.card_id) as { card_uid: string; card_uid_canon: string | null; name: string }

  const order = intent.order_id
    ? (db.prepare('SELECT number FROM orders WHERE id = ?').get(intent.order_id) as
        | { number: number }
        | undefined)
    : undefined

  const address = opts.address.trim()

  // The balances before are this payment undone. It moved one unit only — points for a
  // points sale, denars otherwise — out of the card for a debit and into it for a credit.
  // Exact because the slip is read straight after the confirm, with nothing in between.
  const balanceDeni = balanceOf(db, intent.card_id, 'deni')
  const points = balanceOf(db, intent.card_id, 'points')
  const undo = intent.direction === 'credit' ? -1 : 1
  const paidInPoints = intent.pay_method === 'points'

  return {
    address: address || null,
    at: opts.at.toISOString(),
    card: maskCard(card.card_uid_canon ?? tryCanonUid(card.card_uid)),
    playerName: card.name,
    direction: intent.direction,
    pay: intent.pay_method,
    amountDeni: intent.total_deni,
    amountPoints: intent.total_points,
    label: intent.label,
    orderNumber: order?.number ?? null,
    reference: intent.id.replace(/-/g, '').slice(0, 8).toUpperCase(),
    // confirmIntent only consumes an intent whose required PIN matched.
    pinVerified: intent.pin_required === 1,
    staff: intent.staff_username,
    balanceBeforeDeni: paidInPoints ? balanceDeni : balanceDeni + undo * intent.total_deni,
    pointsBefore: paidInPoints ? points + undo * intent.total_points : points,
    balanceDeni,
    points
  }
}

/** A slip leaves the building in a guest's pocket, so the UID never prints whole. */
export function maskCard(canon: string | null): string {
  return canon ? `**** ${canon.slice(-4)}` : '****'
}
