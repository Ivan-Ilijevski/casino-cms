import type { Db } from '../db/index.js'
import type { PayMethod } from './orders.js'

/** Four digits is what the render service's own presets use ('0012', '0148', '1024'). */
const WIDTH = 4

export interface ReceiptNumber {
  id: number
  day: string
  seq: number
  /** What goes on the paper. The render API prints it as `#${receiptNumber}`. */
  printed: string
  /** True when this sale already had a number and none was taken. */
  reused: boolean
}

/** Raised for a receipt against a sale that isn't there. A class so the route can tell it apart. */
export class UnknownOrderError extends Error {
  constructor(orderId: string) {
    super(`no such order: ${orderId}`)
    this.name = 'UnknownOrderError'
  }
}

/**
 * padStart rather than slice: at 10000 this prints five digits instead of truncating
 * to '0000' and reissuing a number that has already been on paper. A cosmetically
 * wide receipt is a much smaller problem than a duplicated fiscal one.
 */
export function formatReceiptNumber(seq: number): string {
  return String(seq).padStart(WIDTH, '0')
}

/**
 * The next receipt number for `day`, recorded against the sale.
 *
 * MAX(seq)+1 scoped to the day — the same read-then-insert orders.number uses
 * (domain/orders.ts:264, :331), but per-day, so it restarts at 1 each morning.
 *
 * A sale that already has a number gets it back rather than a second one: a reprint is
 * the same fiscal document. That holds across midnight too — yesterday's sale keeps
 * yesterday's number, which is why the existing row's day wins over the argument.
 *
 * Throws on an unknown order instead of returning a failure union: inside db.transaction
 * a returned {ok:false} COMMITS and only a throw rolls back (domain/orders.ts:324-327).
 *
 * `.immediate()`, unlike placeOrder: BEGIN DEFERRED takes its write lock only at the
 * INSERT, so a second *process* on the same WAL file (npm run seed, import:vouchers)
 * could read the same MAX in between. UNIQUE (day, seq) is the backstop that turns
 * whatever is left of that race into a constraint error rather than a duplicate number.
 */
export function allocateReceiptNumber(
  db: Db,
  opts: { orderId: string; day: string; timeZone: string; actor: string }
): ReceiptNumber {
  return db
    .transaction((): ReceiptNumber => {
      const existing = db
        .prepare('SELECT id, day, seq FROM receipts WHERE order_id = ?')
        .get(opts.orderId) as { id: number; day: string; seq: number } | undefined
      if (existing) {
        return { ...existing, printed: formatReceiptNumber(existing.seq), reused: true }
      }

      const order = db
        .prepare('SELECT pay_method AS payMethod, total_deni AS totalDeni FROM orders WHERE id = ?')
        .get(opts.orderId) as { payMethod: PayMethod; totalDeni: number } | undefined
      if (!order) throw new UnknownOrderError(opts.orderId)

      const { n } = db
        .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM receipts WHERE day = ?')
        .get(opts.day) as { n: number }

      const info = db
        .prepare(
          `INSERT INTO receipts (day, seq, order_id, pay_method, total_deni, actor, time_zone)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(opts.day, n, opts.orderId, order.payMethod, order.totalDeni, opts.actor, opts.timeZone)

      return {
        id: Number(info.lastInsertRowid),
        day: opts.day,
        seq: n,
        printed: formatReceiptNumber(n),
        reused: false
      }
    })
    .immediate()
}

/**
 * Records that the render API produced this receipt, and keeps what it produced.
 *
 * "Rendered" is not "printed": this runs before a single byte goes over Bluetooth.
 * Whether the paper came out is the print log's question (receipt_prints). What is
 * stored here is the fiscal document itself, so a reprint is that image again rather
 * than a fresh render that might stamp a different time on it.
 *
 * One UPDATE, so no row can claim to have rendered without the image to show for it.
 */
export function storeRendered(db: Db, id: number, rendered: { items: unknown; png: Buffer }): void {
  db.prepare("UPDATE receipts SET rendered_at = datetime('now'), items = ?, png = ? WHERE id = ?").run(
    JSON.stringify(rendered.items),
    rendered.png,
    id
  )
}

/**
 * Gives a number back after a render that never produced paper, so the sequence stays
 * dense — a hole in a daily fiscal sequence is exactly what gets questioned later.
 *
 * Only ever releases the *tail* of its day. If a later sale has already taken seq+1,
 * deleting this row would punch the very gap this exists to avoid, so the WHERE makes
 * that a no-op: the row stays with rendered_at NULL, which reads as "allocated, never
 * printed" rather than as an unexplained missing number.
 *
 * rendered_at IS NULL is the other half: nothing that printed is ever deleted.
 *
 * Returns whether the number was actually released.
 */
export function releaseReceiptNumber(db: Db, id: number): boolean {
  return (
    db
      .prepare(
        `DELETE FROM receipts
          WHERE id = ?
            AND rendered_at IS NULL
            AND seq = (SELECT MAX(seq) FROM receipts r WHERE r.day = receipts.day)`
      )
      .run(id).changes === 1
  )
}
