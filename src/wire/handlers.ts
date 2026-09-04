import type { Db } from '../db/index.js'
import { findCardByUid, getCard } from '../domain/accounts.js'
import { creditCard } from '../domain/credits.js'
import { commitHold, placeHold, rollbackHold } from '../domain/holds.js'
import { balanceOf } from '../domain/ledger.js'
import { wireMenu } from '../domain/menu.js'
import { placeOrder, type PayMethod } from '../domain/orders.js'
import { closeSession, getActiveSession, openSession, touchSession, type CloseReason } from '../domain/sessions.js'
import { ERRORS, failure, reply, type InMessage, type OutMessage } from './envelope.js'
import { MAX_PLAYER_NAME_BYTES, MAX_TXN_LEN, truncateUtf8 } from './limits.js'

export interface CmsContext {
  db: Db
  pointsPerMkd: number
  currency: string
  /** Notifies the staff app (SSE) that a new order landed. */
  onOrderCreated?: (orderId: string) => void
}

type Handler = (ctx: CmsContext, msg: InMessage) => OutMessage[]

function playerFor(ctx: CmsContext, cardId: string) {
  const card = getCard(ctx.db, cardId)!
  const player = ctx.db.prepare('SELECT name FROM players WHERE id = ?').get(card.player_id) as {
    name: string
  }
  return {
    name: truncateUtf8(player.name, MAX_PLAYER_NAME_BYTES),
    balance: balanceOf(ctx.db, cardId, 'deni'),
    points: balanceOf(ctx.db, cardId, 'points'),
    cur: ctx.currency
  }
}

/** Resolves the card behind a sid, refreshing the idle timer. */
function cardForSession(ctx: CmsContext, sid: unknown): string | null {
  if (typeof sid !== 'string' || sid === '') return null
  const session = getActiveSession(ctx.db, sid)
  if (!session) return null
  touchSession(ctx.db, sid)
  return session.card_id
}

/**
 * A usable transfer id, or null.
 *
 * Both halves matter. An absent txn used to default to the empty string, which
 * collapsed every untxned transfer onto one hold — the second answered ok:true
 * and moved no money. And the firmware copies txn into `char txn[24]`, so
 * anything longer comes back truncated and would resolve the wrong hold on
 * commit; better to refuse it than to settle someone else's transfer.
 */
function wireTxn(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const txn = raw.trim()
  return txn === '' || txn.length > MAX_TXN_LEN ? null : txn
}

/** The txn as sent, for echoing back on a failure. */
function echoTxn(raw: unknown): string {
  return typeof raw === 'string' ? raw : ''
}

const hello: Handler = (_ctx, msg) => [reply('hello_res', msg.id)]

const ping: Handler = (_ctx, msg) => [{ t: 'pong', id: msg.id, d: {} }]

const auth_req: Handler = (ctx, msg) => {
  const uid = typeof msg.d.uid === 'string' ? msg.d.uid : ''
  const card = uid ? findCardByUid(ctx.db, uid) : undefined

  if (!card || card.status !== 'active') {
    // Unknown taps feed the staff "register this card" flow, so the operator
    // never has to type a hex UID by hand.
    if (uid && !card) {
      ctx.db
        .prepare(
          `INSERT INTO unknown_card_taps (card_uid) VALUES (?)
           ON CONFLICT(card_uid) DO UPDATE SET count = count + 1, last_seen = datetime('now')`
        )
        .run(uid)
    }
    return [failure('auth_res', msg.id, ERRORS.unknown_card)]
  }

  const session = openSession(ctx.db, card.id)
  return [reply('auth_res', msg.id, { sid: session.sid, player: playerFor(ctx, card.id) })]
}

const logout: Handler = (ctx, msg) => {
  const sid = msg.d.sid
  if (typeof sid === 'string') {
    const reason: CloseReason = msg.d.reason === 'inactivity' ? 'inactivity' : 'cashout'
    closeSession(ctx.db, sid, reason)
  }
  return [] // fire-and-forget: the firmware tracks no reply for this
}

const debit_req: Handler = (ctx, msg) => {
  const echo = echoTxn(msg.d.txn)
  const amount = Number(msg.d.amount ?? 0)

  const cardId = cardForSession(ctx, msg.d.sid)
  if (!cardId) return [failure('debit_res', msg.id, ERRORS.no_session, { txn: echo })]

  const txn = wireTxn(msg.d.txn)
  if (!txn) return [failure('debit_res', msg.id, ERRORS.denied, { txn: echo })]

  const res = placeHold(ctx.db, {
    cardId,
    txn,
    amountDeni: amount,
    sessionId: msg.d.sid as string
  })
  if (!res.ok) {
    // Only say "not enough money" when that is actually why.
    const error = res.code === 'insufficient' ? ERRORS.insufficient_funds : ERRORS.denied
    return [failure('debit_res', msg.id, error, { txn })]
  }
  return [reply('debit_res', msg.id, { txn, balance: res.balanceDeni })]
}

const debit_commit: Handler = (ctx, msg) => {
  const echo = echoTxn(msg.d.txn)
  const txn = wireTxn(msg.d.txn)
  if (!txn) return [failure('debit_commit_res', msg.id, ERRORS.unknown_txn, { txn: echo })]

  const res = commitHold(ctx.db, { txn, pointsPerMkd: ctx.pointsPerMkd })

  if (!res.ok) {
    const error = res.code === 'conflict' ? ERRORS.conflict : ERRORS.unknown_txn
    return [failure('debit_commit_res', msg.id, error, { txn })]
  }
  return [reply('debit_commit_res', msg.id, { txn, balance: res.balanceDeni, points: res.points })]
}

const debit_rollback: Handler = (ctx, msg) => {
  const echo = echoTxn(msg.d.txn)
  const txn = wireTxn(msg.d.txn)
  if (!txn) return [failure('debit_rollback_res', msg.id, ERRORS.unknown_txn, { txn: echo })]

  const reason = typeof msg.d.reason === 'string' ? msg.d.reason : undefined
  const res = rollbackHold(ctx.db, { txn, ...(reason ? { reason } : {}) })

  if (!res.ok) return [failure('debit_rollback_res', msg.id, ERRORS.unknown_txn, { txn })]
  return [reply('debit_rollback_res', msg.id, { txn, balance: res.balanceDeni })]
}

const credit_req: Handler = (ctx, msg) => {
  const echo = echoTxn(msg.d.txn)
  const amount = Number(msg.d.amount ?? 0)

  const cardId = cardForSession(ctx, msg.d.sid)
  if (!cardId) return [failure('credit_res', msg.id, ERRORS.no_session, { txn: echo })]

  const txn = wireTxn(msg.d.txn)
  if (!txn) return [failure('credit_res', msg.id, ERRORS.denied, { txn: echo })]
  if (!Number.isInteger(amount) || amount <= 0) {
    return [failure('credit_res', msg.id, ERRORS.denied, { txn })]
  }

  const res = creditCard(ctx.db, {
    cardId,
    txn,
    amountDeni: amount,
    sessionId: msg.d.sid as string
  })
  return [reply('credit_res', msg.id, { txn, balance: res.balanceDeni, points: res.points })]
}

const menu_req: Handler = (ctx, msg) => [reply('menu_res', msg.id, { items: wireMenu(ctx.db) })]

const order_req: Handler = (ctx, msg) => {
  const cardId = cardForSession(ctx, msg.d.sid)
  if (!cardId) return [failure('order_res', msg.id, ERRORS.no_session)]

  const pay: PayMethod = msg.d.pay === 'points' ? 'points' : 'cash'
  const items = Array.isArray(msg.d.items) ? msg.d.items : []

  const res = placeOrder(ctx.db, {
    cardId,
    sessionId: typeof msg.d.sid === 'string' ? msg.d.sid : null,
    pay,
    items
  })

  if (!res.ok) {
    const error =
      res.code === 'empty'
        ? ERRORS.empty
        : res.code === 'out_of_stock'
          ? ERRORS.out_of_stock
          : pay === 'points'
            ? ERRORS.insufficient_points
            : ERRORS.insufficient_funds
    return [failure('order_res', msg.id, error)]
  }

  ctx.onOrderCreated?.(res.orderId)
  return [reply('order_res', msg.id, { order: res.orderId, balance: res.balanceDeni, points: res.points })]
}

const HANDLERS: Record<string, Handler> = {
  hello,
  ping,
  auth_req,
  logout,
  debit_req,
  debit_commit,
  debit_rollback,
  credit_req,
  menu_req,
  order_req
}

/** Returns the replies to send. An unknown type is ignored, never fatal. */
export function handleCmsMessage(ctx: CmsContext, msg: InMessage): OutMessage[] {
  const handler = HANDLERS[msg.t]
  if (!handler) return []
  return handler(ctx, msg)
}
