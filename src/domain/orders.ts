import { randomUUID } from 'node:crypto'
import type { Db } from '../db/index.js'
import { balanceOf, postEntry } from './ledger.js'
import { getMenuItem } from './menu.js'

export type PayMethod = 'cash' | 'points'
export type OrderStatus = 'received' | 'accepted' | 'fulfilled' | 'cancelled'
export type OrderSource = 'terminal' | 'pos'
export type OrderErrCode = 'empty' | 'insufficient' | 'out_of_stock'

export interface OrderRow {
  id: string
  number: number
  card_id: string
  session_id: string | null
  pay_method: PayMethod
  total_deni: number
  total_points: number
  status: OrderStatus
  source: OrderSource
  created_at: string
  updated_at: string
  fulfilled_by: string | null
  fulfilled_at: string | null
}

export interface OrderRequestItem {
  drink: number
  qty: number
}

export type OrderResult =
  | { ok: true; orderId: string; number: number; balanceDeni: number; points: number }
  | { ok: false; code: OrderErrCode }

export interface PricedLine {
  drinkId: number
  name: string
  qty: number
  unitPriceDeni: number
  unitPoints: number
  lineTotalDeni: number
  lineTotalPoints: number
}

/**
 * Prices a requested selection against the live menu.
 *
 * Mirrors the prototype: unknown drinks, non-positive quantities and
 * unavailable drinks are silently skipped rather than failing the order.
 * A sold-out drink (stock_qty 0) is skipped for the same reason — it is not on
 * the menu right now. Asking for MORE than is left is a different thing and
 * fails the order in placeOrder, so nobody is quietly sold a short measure.
 *
 * Exported so POS can quote a cart without duplicating the menu maths.
 */
export function priceLines(db: Db, items: OrderRequestItem[]): PricedLine[] {
  const lines: PricedLine[] = []
  for (const item of items) {
    const menuItem = getMenuItem(db, item.drink)
    const qty = Number(item.qty)
    if (!menuItem || !Number.isInteger(qty) || qty <= 0 || menuItem.available !== 1) continue
    if (menuItem.stock_qty === 0) continue
    lines.push({
      drinkId: menuItem.drink_id,
      name: menuItem.name,
      qty,
      unitPriceDeni: menuItem.price_deni,
      unitPoints: menuItem.points_price,
      lineTotalDeni: menuItem.price_deni * qty,
      lineTotalPoints: menuItem.points_price * qty
    })
  }
  return lines
}

/**
 * True when every stock-tracked line can be served in full.
 *
 * Exported so POS can refuse a cart at quote time rather than after the tap.
 * placeOrder re-checks inside its transaction; this is the friendly early one.
 */
export function inStock(db: Db, lines: PricedLine[]): boolean {
  return lines.every((line) => {
    const item = getMenuItem(db, line.drinkId)
    return !item || item.stock_qty === null || item.stock_qty >= line.qty
  })
}

export function getOrder(db: Db, orderId: string): OrderRow | undefined {
  return db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as OrderRow | undefined
}

export interface OrderLineRow {
  drink_id: number
  name: string
  qty: number
  unit_price_deni: number
  unit_points: number
  line_total_deni: number
  line_total_points: number
}

export function getOrderLines(db: Db, orderId: string): OrderLineRow[] {
  return db
    .prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id')
    .all(orderId) as OrderLineRow[]
}

export interface OrderWithLines extends OrderRow {
  items: OrderLineRow[]
  player_name: string
  card_uid: string
}

const ORDER_SELECT = `
  SELECT o.*, p.name AS player_name, c.card_uid AS card_uid
  FROM orders o
  JOIN cards c ON c.id = o.card_id
  JOIN players p ON p.id = c.player_id
`

export function listOrders(
  db: Db,
  filter: { status?: OrderStatus; playerId?: string; limit?: number } = {}
): OrderWithLines[] {
  // playerId filters through the join ORDER_SELECT already makes, so the guest
  // profile reuses this rather than growing a second order query.
  const clauses: string[] = []
  const params: unknown[] = []
  if (filter.status) {
    clauses.push('o.status = ?')
    params.push(filter.status)
  }
  if (filter.playerId) {
    clauses.push('c.player_id = ?')
    params.push(filter.playerId)
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  params.push(filter.limit ?? 100)

  const rows = db
    .prepare(`${ORDER_SELECT} ${where} ORDER BY o.created_at DESC, o.number DESC LIMIT ?`)
    .all(...params) as Array<OrderRow & { player_name: string; card_uid: string }>

  return rows.map((row) => ({ ...row, items: getOrderLines(db, row.id) }))
}

/** Single order in the same shape listOrders returns — used by the SSE feed. */
export function getOrderWithLines(db: Db, orderId: string): OrderWithLines | undefined {
  const row = db.prepare(`${ORDER_SELECT} WHERE o.id = ?`).get(orderId) as
    | (OrderRow & { player_name: string; card_uid: string })
    | undefined
  return row ? { ...row, items: getOrderLines(db, row.id) } : undefined
}

export type StatusResult =
  | { ok: true; refunded: boolean; order: OrderRow }
  | { ok: false; reason: 'unknown_order' | 'invalid_transition' }

/**
 * Staff-driven status change.
 *
 * Cancelling refunds whatever the player was actually charged (cash or points),
 * exactly once — the guard is the status transition itself, so a double-click
 * can't pay out twice. A fulfilled order is terminal: the drink was served.
 */
export function setOrderStatus(
  db: Db,
  opts: { orderId: string; status: OrderStatus; actor: string }
): StatusResult {
  return db.transaction((): StatusResult => {
    const order = getOrder(db, opts.orderId)
    if (!order) return { ok: false, reason: 'unknown_order' }
    if (order.status === 'cancelled' || order.status === 'fulfilled') {
      return { ok: false, reason: 'invalid_transition' }
    }

    let refunded = false
    if (opts.status === 'cancelled') {
      const payingWithPoints = order.pay_method === 'points'
      const amount = payingWithPoints ? order.total_points : order.total_deni
      if (amount > 0) {
        postEntry(db, {
          cardId: order.card_id,
          unit: payingWithPoints ? 'points' : 'deni',
          amount,
          kind: 'order_refund',
          ref: order.id,
          actor: opts.actor
        })
        refunded = true
      }
      // The drink was never poured, so it goes back on the shelf. Fulfilled
      // orders keep their decrement. The status guard above is what stops a
      // double-click restocking twice — same guard the refund relies on.
      const restock = db.prepare(
        `UPDATE menu_items SET stock_qty = stock_qty + ?
         WHERE drink_id = ? AND stock_qty IS NOT NULL`
      )
      for (const line of getOrderLines(db, order.id)) {
        restock.run(line.qty, line.drink_id)
      }
    }

    const fulfilling = opts.status === 'fulfilled'
    db.prepare(
      `UPDATE orders
       SET status = ?,
           updated_at = datetime('now'),
           fulfilled_by = CASE WHEN ? THEN ? ELSE fulfilled_by END,
           fulfilled_at = CASE WHEN ? THEN datetime('now') ELSE fulfilled_at END
       WHERE id = ?`
    ).run(opts.status, fulfilling ? 1 : 0, opts.actor, fulfilling ? 1 : 0, order.id)

    return { ok: true, refunded, order: getOrder(db, order.id)! }
  })()
}

/**
 * Creates a single-line order for a free-form charge that has no menu item.
 * drink_id 0 signals "not a menu item" — the name column carries the label.
 */
export function placeCustomOrder(
  db: Db,
  opts: {
    cardId: string
    amountDeni: number
    label: string
    source?: OrderSource
  }
): OrderResult {
  return db.transaction((): OrderResult => {
    if (opts.amountDeni > balanceOf(db, opts.cardId, 'deni')) {
      return { ok: false, code: 'insufficient' }
    }

    const orderId = randomUUID()
    const next = db.prepare('SELECT COALESCE(MAX(number), 0) + 1 AS n FROM orders').get() as {
      n: number
    }

    db.prepare(
      `INSERT INTO orders (id, number, card_id, session_id, pay_method, total_deni, total_points, source)
       VALUES (?, ?, ?, NULL, 'cash', ?, 0, ?)`
    ).run(orderId, next.n, opts.cardId, opts.amountDeni, opts.source ?? 'pos')

    db.prepare(
      `INSERT INTO order_items
         (order_id, drink_id, name, qty, unit_price_deni, unit_points, line_total_deni, line_total_points)
       VALUES (?, 0, ?, 1, ?, 0, ?, 0)`
    ).run(orderId, opts.label, opts.amountDeni, opts.amountDeni)

    if (opts.amountDeni > 0) {
      postEntry(db, {
        cardId: opts.cardId,
        unit: 'deni',
        amount: -opts.amountDeni,
        kind: 'order',
        ref: orderId
      })
    }

    return {
      ok: true,
      orderId,
      number: next.n,
      balanceDeni: balanceOf(db, opts.cardId, 'deni'),
      points: balanceOf(db, opts.cardId, 'points')
    }
  })()
}

export function placeOrder(
  db: Db,
  opts: {
    cardId: string
    sessionId?: string | null
    pay: PayMethod
    items: OrderRequestItem[]
    /** Where the order came from: the card terminal, or staff at the POS. */
    source?: OrderSource
  }
): OrderResult {
  const lines = priceLines(db, opts.items)
  if (lines.length === 0) return { ok: false, code: 'empty' }

  const totalDeni = lines.reduce((sum, l) => sum + l.lineTotalDeni, 0)
  const totalPoints = lines.reduce((sum, l) => sum + l.lineTotalPoints, 0)

  return db.transaction((): OrderResult => {
    const payingWithPoints = opts.pay === 'points'
    const cost = payingWithPoints ? totalPoints : totalDeni
    const unit = payingWithPoints ? 'points' : 'deni'
    if (cost > balanceOf(db, opts.cardId, unit)) {
      return { ok: false, code: 'insufficient' }
    }

    // Every line is checked before ANY of them is decremented: better-sqlite3
    // rolls back on a thrown error, not on a returned {ok:false}, so a
    // decrement-as-you-go loop would commit the lines it got through before
    // hitting the one that ran out. Same reason the balance check sits here.
    if (!inStock(db, lines)) return { ok: false, code: 'out_of_stock' }

    const orderId = randomUUID()
    const next = db.prepare('SELECT COALESCE(MAX(number), 0) + 1 AS n FROM orders').get() as {
      n: number
    }

    db.prepare(
      `INSERT INTO orders (id, number, card_id, session_id, pay_method, total_deni, total_points, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      orderId,
      next.n,
      opts.cardId,
      opts.sessionId ?? null,
      opts.pay,
      totalDeni,
      totalPoints,
      opts.source ?? 'terminal'
    )

    const insertLine = db.prepare(
      `INSERT INTO order_items
         (order_id, drink_id, name, qty, unit_price_deni, unit_points, line_total_deni, line_total_points)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    for (const l of lines) {
      insertLine.run(
        orderId,
        l.drinkId,
        l.name,
        l.qty,
        l.unitPriceDeni,
        l.unitPoints,
        l.lineTotalDeni,
        l.lineTotalPoints
      )
    }

    const takeStock = db.prepare(
      `UPDATE menu_items SET stock_qty = stock_qty - ?
       WHERE drink_id = ? AND stock_qty IS NOT NULL`
    )
    for (const l of lines) {
      takeStock.run(l.qty, l.drinkId)
    }

    if (cost > 0) {
      postEntry(db, {
        cardId: opts.cardId,
        unit,
        amount: -cost,
        kind: 'order',
        ref: orderId
      })
    }

    return {
      ok: true,
      orderId,
      number: next.n,
      balanceDeni: balanceOf(db, opts.cardId, 'deni'),
      points: balanceOf(db, opts.cardId, 'points')
    }
  })()
}
