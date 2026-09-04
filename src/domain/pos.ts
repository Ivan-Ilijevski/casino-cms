import { randomInt, randomUUID } from 'node:crypto'
import type { Db } from '../db/index.js'
import { findCardByUid, type Card } from './accounts.js'
import { balanceOf, postEntry } from './ledger.js'
import { inStock, placeCustomOrder, placeOrder, priceLines, type OrderRequestItem, type PayMethod } from './orders.js'
import { hashPassword, verifyPassword } from './password.js'

export { canonUid } from './uid.js'

/** One POS payment in eight is spot-checked with a PIN. */
export const PIN_CHECK_ODDS = 8
export const PIN_MAX_ATTEMPTS = 5
export const PIN_LOCKOUT_MINUTES = 15
export const INTENT_TTL_SECONDS = 120

export type PosErrCode =
  | 'unknown_card'
  | 'card_blocked'
  | 'no_pin_set'
  | 'pin_locked'
  | 'empty'
  | 'insufficient'
  | 'out_of_stock'
  | 'unknown_intent'
  | 'intent_expired'
  | 'intent_used'
  | 'pin_required'
  | 'pin_wrong'

export type ChargeType = 'order' | 'custom'
export type Direction = 'debit' | 'credit'

export interface PosIntentRow {
  id: string
  card_id: string
  staff_username: string
  pay_method: PayMethod
  items_json: string
  total_deni: number
  total_points: number
  pin_required: number
  state: 'pending' | 'consumed' | 'expired'
  created_at: string
  expires_at: string
  order_id: string | null
  charge_type: ChargeType
  direction: Direction
  label: string | null
}

export type IntentResult =
  | {
      ok: true
      intentId: string
      player: { name: string; balance: number; points: number }
      totalDeni: number
      totalPoints: number
      pinRequired: boolean
      expiresAt: string
      direction: Direction
      chargeType: ChargeType
      label: string | null
    }
  | { ok: false; code: PosErrCode }

export type ConfirmResult =
  | {
      ok: true
      orderId: string | null
      number: number | null
      balanceDeni: number
      points: number
      cardId: string
      direction: Direction
    }
  | { ok: false; code: PosErrCode; attemptsLeft?: number }

// ----------------------------------------------------------------------- PIN

export function setPin(db: Db, cardId: string, pin: string): void {
  if (!/^[0-9]{4}$/.test(pin)) {
    throw new Error('PIN must be exactly 4 digits')
  }
  // Same scrypt as staff passwords — no new dependency, never stored in clear.
  // Also clears any lockout: a staff-set PIN is the way out of one.
  db.prepare(
    `UPDATE cards SET pin_hash = ?, pin_failed_attempts = 0, pin_locked_until = NULL WHERE id = ?`
  ).run(hashPassword(pin), cardId)
}

export function hasPin(db: Db, cardId: string): boolean {
  const row = db.prepare('SELECT pin_hash FROM cards WHERE id = ?').get(cardId) as
    | { pin_hash: string | null }
    | undefined
  return Boolean(row?.pin_hash)
}

export function isPinLocked(db: Db, cardId: string): boolean {
  return Boolean(
    db
      .prepare(
        `SELECT 1 FROM cards
         WHERE id = ? AND pin_locked_until IS NOT NULL AND pin_locked_until > datetime('now')`
      )
      .get(cardId)
  )
}

/**
 * A 4-digit PIN is 10^4 combinations — without this counter the confirm endpoint
 * is a brute-force oracle. Locks the card for POS after PIN_MAX_ATTEMPTS.
 */
export function verifyPin(
  db: Db,
  cardId: string,
  pin: string
): { ok: boolean; attemptsLeft: number } {
  const card = db.prepare('SELECT pin_hash, pin_failed_attempts FROM cards WHERE id = ?').get(cardId) as
    | { pin_hash: string | null; pin_failed_attempts: number }
    | undefined
  if (!card?.pin_hash) return { ok: false, attemptsLeft: 0 }

  if (verifyPassword(pin, card.pin_hash)) {
    db.prepare(`UPDATE cards SET pin_failed_attempts = 0, pin_locked_until = NULL WHERE id = ?`).run(
      cardId
    )
    return { ok: true, attemptsLeft: PIN_MAX_ATTEMPTS }
  }

  const attempts = card.pin_failed_attempts + 1
  const lock = attempts >= PIN_MAX_ATTEMPTS
  db.prepare(
    `UPDATE cards
     SET pin_failed_attempts = ?,
         pin_locked_until = CASE WHEN ? = 1 THEN datetime('now', ?) ELSE pin_locked_until END
     WHERE id = ?`
  ).run(lock ? 0 : attempts, lock ? 1 : 0, `+${PIN_LOCKOUT_MINUTES} minutes`, cardId)

  return { ok: false, attemptsLeft: lock ? 0 : PIN_MAX_ATTEMPTS - attempts }
}

// ------------------------------------------------------------------- intents

export function getIntent(db: Db, id: string): PosIntentRow | undefined {
  return db.prepare('SELECT * FROM pos_intents WHERE id = ?').get(id) as PosIntentRow | undefined
}

function playerName(db: Db, card: Card): string {
  return (db.prepare('SELECT name FROM players WHERE id = ?').get(card.player_id) as { name: string })
    .name
}

/**
 * Prices a cart against a tapped card and decides — server-side — whether this
 * payment gets PIN-checked, persisting that decision. Storing it is the whole
 * point: if the client decided, it would simply never ask for a PIN.
 *
 * Charges nothing; confirmIntent does that.
 *
 * Supports two modes:
 * - `items` (order mode): prices menu items and checks stock.
 * - `customAmountDeni` (custom mode): free-form amount for chips, table charges, etc.
 *   Credits (direction='credit') always require PIN — paying money out is not spot-checked.
 */
export function createIntent(
  db: Db,
  opts: {
    cardUid: string
    /** Menu-item mode. */
    items?: OrderRequestItem[]
    pay?: PayMethod
    /** Custom-amount mode: free-form denars. */
    customAmountDeni?: number
    label?: string
    direction?: Direction
    staff: string
    /**
     * Overrides the 1-in-8 roll. Reachable only through StaffDeps.posPinDecision
     * — never from a request body, or the check could be switched off per sale.
     */
    forcePin?: boolean
  }
): IntentResult {
  const card = findCardByUid(db, opts.cardUid)
  if (!card) return { ok: false, code: 'unknown_card' }
  if (card.status !== 'active') return { ok: false, code: 'card_blocked' }
  if (!hasPin(db, card.id)) return { ok: false, code: 'no_pin_set' }
  if (isPinLocked(db, card.id)) return { ok: false, code: 'pin_locked' }

  const isCustom = opts.customAmountDeni !== undefined
  const direction: Direction = opts.direction ?? 'debit'
  const chargeType: ChargeType = isCustom ? 'custom' : 'order'

  let totalDeni: number
  let totalPoints: number
  let pay: PayMethod
  let itemsJson: string

  if (isCustom) {
    if (!Number.isInteger(opts.customAmountDeni) || opts.customAmountDeni! <= 0) {
      return { ok: false, code: 'empty' }
    }
    totalDeni = opts.customAmountDeni!
    totalPoints = 0
    pay = 'cash'
    itemsJson = '[]'

    // Debit: check balance. Credit: money goes onto the card, no check needed.
    if (direction === 'debit' && totalDeni > balanceOf(db, card.id, 'deni')) {
      return { ok: false, code: 'insufficient' }
    }
  } else {
    const items = opts.items ?? []
    const lines = priceLines(db, items)
    if (lines.length === 0) return { ok: false, code: 'empty' }
    if (!inStock(db, lines)) return { ok: false, code: 'out_of_stock' }

    totalDeni = lines.reduce((sum, l) => sum + l.lineTotalDeni, 0)
    totalPoints = lines.reduce((sum, l) => sum + l.lineTotalPoints, 0)
    pay = opts.pay ?? 'cash'
    itemsJson = JSON.stringify(items)

    const payingWithPoints = pay === 'points'
    const cost = payingWithPoints ? totalPoints : totalDeni
    if (cost > balanceOf(db, card.id, payingWithPoints ? 'points' : 'deni')) {
      return { ok: false, code: 'insufficient' }
    }
  }

  // Credits always require PIN — paying money out must never be spot-checked.
  const pinRequired = direction === 'credit'
    ? true
    : (opts.forcePin ?? randomInt(PIN_CHECK_ODDS) === 0)

  const id = randomUUID()

  db.prepare(
    `INSERT INTO pos_intents
       (id, card_id, staff_username, pay_method, items_json, total_deni, total_points,
        pin_required, expires_at, charge_type, direction, label)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now', ?), ?, ?, ?)`
  ).run(
    id,
    card.id,
    opts.staff,
    pay,
    itemsJson,
    totalDeni,
    totalPoints,
    pinRequired ? 1 : 0,
    `+${INTENT_TTL_SECONDS} seconds`,
    chargeType,
    direction,
    opts.label ?? null
  )

  return {
    ok: true,
    intentId: id,
    player: {
      name: playerName(db, card),
      balance: balanceOf(db, card.id, 'deni'),
      points: balanceOf(db, card.id, 'points')
    },
    totalDeni,
    totalPoints,
    pinRequired,
    expiresAt: getIntent(db, id)!.expires_at,
    direction,
    chargeType,
    label: opts.label ?? null
  }
}

/**
 * Charges a pending intent. The PIN requirement is read back from the STORED
 * intent, never from the request — omitting the pin cannot skip the check.
 *
 * Three paths:
 * - order debit: placeOrder with menu items (existing)
 * - custom debit: placeCustomOrder with free-form amount
 * - custom credit: postEntry with positive amount, no order
 */
export function confirmIntent(db: Db, opts: { intentId: string; pin?: string }): ConfirmResult {
  return db.transaction((): ConfirmResult => {
    const intent = getIntent(db, opts.intentId)
    if (!intent) return { ok: false, code: 'unknown_intent' }
    if (intent.state === 'consumed') return { ok: false, code: 'intent_used' }
    if (intent.state === 'expired') return { ok: false, code: 'intent_expired' }

    const stale = db
      .prepare(`SELECT 1 FROM pos_intents WHERE id = ? AND expires_at <= datetime('now')`)
      .get(intent.id)
    if (stale) {
      db.prepare(`UPDATE pos_intents SET state = 'expired' WHERE id = ?`).run(intent.id)
      return { ok: false, code: 'intent_expired' }
    }

    if (isPinLocked(db, intent.card_id)) return { ok: false, code: 'pin_locked' }

    if (intent.pin_required === 1) {
      if (!opts.pin) return { ok: false, code: 'pin_required' }
      const check = verifyPin(db, intent.card_id, opts.pin)
      if (!check.ok) return { ok: false, code: 'pin_wrong', attemptsLeft: check.attemptsLeft }
    }

    let orderId: string | null = null
    let orderNumber: number | null = null

    if (intent.charge_type === 'order') {
      // Menu-item order: reuse the single money path.
      const order = placeOrder(db, {
        cardId: intent.card_id,
        sessionId: null,
        pay: intent.pay_method,
        items: JSON.parse(intent.items_json) as OrderRequestItem[],
        source: 'pos'
      })
      if (!order.ok) return { ok: false, code: order.code }
      orderId = order.orderId
      orderNumber = order.number
    } else if (intent.direction === 'debit') {
      // Custom debit: free-form charge (chips buy, table fee, etc.)
      const order = placeCustomOrder(db, {
        cardId: intent.card_id,
        amountDeni: intent.total_deni,
        label: intent.label ?? 'Друго',
        source: 'pos'
      })
      if (!order.ok) return { ok: false, code: order.code }
      orderId = order.orderId
      orderNumber = order.number
    } else {
      // Custom credit: money goes onto the card (chip cashout).
      postEntry(db, {
        cardId: intent.card_id,
        unit: 'deni',
        amount: intent.total_deni,
        kind: 'pos_credit',
        ref: intent.id,
        actor: intent.staff_username
      })
    }

    db.prepare(`UPDATE pos_intents SET state = 'consumed', order_id = ? WHERE id = ?`).run(
      orderId,
      intent.id
    )

    return {
      ok: true,
      orderId,
      number: orderNumber,
      balanceDeni: balanceOf(db, intent.card_id, 'deni'),
      points: balanceOf(db, intent.card_id, 'points'),
      cardId: intent.card_id,
      direction: intent.direction
    }
  })()
}
