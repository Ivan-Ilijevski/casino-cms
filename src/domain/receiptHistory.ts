import type { Config } from '../config.js'
import type { Db } from '../db/index.js'
import type { PayMethod } from './orders.js'
import { renderReceipt, type ReceiptItem, type ReceiptResult } from './receipt.js'
import { formatReceiptNumber, storeRendered } from './receiptNumbers.js'

/**
 * Fiscal receipt history: what each receipt said, and every attempt to get it onto
 * paper. Numbering and the receipts row lifecycle stay in receiptNumbers.ts; this is
 * everything that happens to a receipt after it has a number.
 */

/** 'sending' is an attempt still open — or one whose tablet died before it could say. */
export type PrintStatus = 'sending' | 'sent' | 'interrupted' | 'failed'
export type PrintOutcome = Exclude<PrintStatus, 'sending'>

const OUTCOMES: readonly PrintOutcome[] = ['sent', 'interrupted', 'failed']

export function isPrintOutcome(value: unknown): value is PrintOutcome {
  return typeof value === 'string' && (OUTCOMES as readonly string[]).includes(value)
}

/** Raised when a sale's lines cannot be put on a fiscal receipt truthfully. */
export class UnprintableOrderError extends Error {
  constructor(orderId: string, reason: string) {
    super(`order ${orderId} cannot be printed: ${reason}`)
    this.name = 'UnprintableOrderError'
  }
}

/**
 * The receipt lines for a sale, read from the sale rather than from the browser.
 *
 * Name, quantity and price come from order_items, which froze them when the drink was
 * sold. The VAT band and the domestic flag exist only on menu_items (migration 009), so
 * they are joined from there.
 *
 * A line with no menu row is refused rather than printed with a guessed VAT band: a
 * custom POS charge ("Чипови", drink_id 0) is not a drink and has no band, and a
 * deleted drink no longer says which band it had. A wrong VAT band on a fiscal document
 * is worse than no document — the same reasoning isPayMethod applies to the tender line.
 */
export function receiptLinesForOrder(db: Db, orderId: string): ReceiptItem[] {
  const rows = db
    .prepare(
      `SELECT oi.name, oi.qty, oi.unit_price_deni AS unitPriceDeni,
              m.vat_type AS vatType, m.is_domestic AS isDomestic
         FROM order_items oi
         LEFT JOIN menu_items m ON m.drink_id = oi.drink_id
        WHERE oi.order_id = ?
        ORDER BY oi.id`
    )
    .all(orderId) as Array<{
    name: string
    qty: number
    unitPriceDeni: number
    vatType: ReceiptItem['vatType'] | null
    isDomestic: number | null
  }>

  if (rows.length === 0) throw new UnprintableOrderError(orderId, 'it has no lines')

  return rows.map((row) => {
    if (row.vatType === null || row.isDomestic === null) {
      throw new UnprintableOrderError(orderId, `"${row.name}" is not on the menu`)
    }
    return {
      name: row.name,
      quantity: row.qty,
      // The render API speaks denars; order_items holds deni.
      price: row.unitPriceDeni / 100,
      vatType: row.vatType,
      isDomestic: row.isDomestic === 1
    }
  })
}

interface ReceiptRow {
  id: number
  day: string
  seq: number
  orderId: string
  payMethod: PayMethod
  items: string | null
  png: Buffer | null
}

function receiptRow(db: Db, id: number): ReceiptRow | undefined {
  return db
    .prepare(
      `SELECT id, day, seq, order_id AS orderId, pay_method AS payMethod, items, png
         FROM receipts WHERE id = ?`
    )
    .get(id) as ReceiptRow | undefined
}

export type ReceiptImageResult =
  | ReceiptResult
  | { ok: false; status: 404; code: 'unknown_receipt' }
  | { ok: false; status: 409; code: 'unprintable'; error: string }

/**
 * The receipt's image, for a reprint.
 *
 * Normally the stored render, untouched. A receipt issued before images were stored
 * has none, so it is rendered once — from its sale, under the number it already has —
 * and stored, which makes every later reprint of it identical to that one.
 */
export async function receiptImage(db: Db, config: Config, id: number): Promise<ReceiptImageResult> {
  const row = receiptRow(db, id)
  if (!row) return { ok: false, status: 404, code: 'unknown_receipt' }
  if (row.png) return { ok: true, png: row.png, contentType: 'image/png' }

  let items: ReceiptItem[]
  try {
    items = receiptLinesForOrder(db, row.orderId)
  } catch (e) {
    if (e instanceof UnprintableOrderError) {
      return { ok: false, status: 409, code: 'unprintable', error: e.message }
    }
    throw e
  }

  const result = await renderReceipt(config, {
    items,
    payMethod: row.payMethod,
    receiptNumber: formatReceiptNumber(row.seq)
  })
  if (result.ok) storeRendered(db, row.id, { items, png: result.png })
  return result
}

export interface StartedPrint {
  printId: number
  /** Whether this attempt prints the КОПИЈА band. Decided here, never by the tablet. */
  copy: boolean
  receipt: { day: string; seq: number; orderId: string }
}

/**
 * Opens a print attempt and decides whether it is a copy.
 *
 * A copy is a print of a receipt that has already come out whole once — an earlier
 * attempt reached 'sent'. An interrupted or failed attempt does not count: the guest
 * never got a complete original, so the retry is that original.
 *
 * In one transaction so two tablets reprinting at once cannot both read "no sent
 * attempt yet" and both print an unmarked original — the second one's read waits.
 */
export function startPrint(
  db: Db,
  opts: { receiptId: number; actor: string; device: string | null }
): StartedPrint | undefined {
  return db
    .transaction((): StartedPrint | undefined => {
      const row = receiptRow(db, opts.receiptId)
      if (!row) return undefined

      const { sent } = db
        .prepare(
          `SELECT EXISTS (SELECT 1 FROM receipt_prints WHERE receipt_id = ? AND status = 'sent') AS sent`
        )
        .get(opts.receiptId) as { sent: number }
      const copy = sent === 1

      const info = db
        .prepare('INSERT INTO receipt_prints (receipt_id, copy, actor, device) VALUES (?, ?, ?, ?)')
        .run(opts.receiptId, copy ? 1 : 0, opts.actor, opts.device)

      return {
        printId: Number(info.lastInsertRowid),
        copy,
        receipt: { day: row.day, seq: row.seq, orderId: row.orderId }
      }
    })
    .immediate()
}

/**
 * Records how a print attempt ended.
 *
 * Only an attempt still 'sending' moves. A report that arrives twice, or late, cannot
 * turn a 'sent' into an 'interrupted' after the fact — the first outcome is the one
 * the tablet saw happen.
 */
export function finishPrint(
  db: Db,
  printId: number,
  outcome: { status: PrintOutcome; percent: number | null; error: string | null }
): 'finished' | 'already_finished' | 'unknown' {
  const changed = db
    .prepare(
      `UPDATE receipt_prints
          SET status = ?, percent = ?, error = ?, finished_at = datetime('now')
        WHERE id = ? AND status = 'sending'`
    )
    .run(outcome.status, outcome.percent, outcome.error, printId).changes
  if (changed === 1) return 'finished'

  const exists = db.prepare('SELECT 1 FROM receipt_prints WHERE id = ?').get(printId)
  return exists ? 'already_finished' : 'unknown'
}

export interface ReceiptListRow {
  id: number
  day: string
  seq: number
  number: string
  orderId: string
  orderNumber: number
  payMethod: PayMethod
  totalDeni: number
  actor: string
  createdAt: string
  /** True once an attempt reached 'sent'. What "неиспечатена" is the absence of. */
  printed: boolean
  attempts: number
  /** КОПИЈА prints that went through. */
  copies: number
  lastStatus: PrintStatus | null
  lastPercent: number | null
  lastAt: string | null
}

/** One business day's receipts, newest number first. */
export function listReceipts(db: Db, opts: { day: string; unprinted?: boolean }): ReceiptListRow[] {
  const rows = db
    .prepare(
      `SELECT r.id, r.day, r.seq, r.order_id AS orderId, o.number AS orderNumber,
              r.pay_method AS payMethod, r.total_deni AS totalDeni, r.actor,
              r.created_at AS createdAt,
              EXISTS (SELECT 1 FROM receipt_prints p
                       WHERE p.receipt_id = r.id AND p.status = 'sent') AS printed,
              (SELECT COUNT(*) FROM receipt_prints p WHERE p.receipt_id = r.id) AS attempts,
              (SELECT COUNT(*) FROM receipt_prints p
                WHERE p.receipt_id = r.id AND p.copy = 1 AND p.status = 'sent') AS copies,
              lp.status AS lastStatus, lp.percent AS lastPercent, lp.started_at AS lastAt
         FROM receipts r
         JOIN orders o ON o.id = r.order_id
         LEFT JOIN receipt_prints lp
           ON lp.id = (SELECT MAX(id) FROM receipt_prints p WHERE p.receipt_id = r.id)
        WHERE r.day = ?
        ORDER BY r.seq DESC`
    )
    .all(opts.day) as Array<Omit<ReceiptListRow, 'printed' | 'number'> & { printed: number }>

  return rows
    .map((row) => ({ ...row, number: formatReceiptNumber(row.seq), printed: row.printed === 1 }))
    .filter((row) => !opts.unprinted || !row.printed)
}

export interface ReceiptPrintRow {
  id: number
  copy: boolean
  actor: string
  device: string | null
  status: PrintStatus
  percent: number | null
  error: string | null
  startedAt: string
  finishedAt: string | null
}

export interface ReceiptDetail {
  receipt: ReceiptListRow & { renderedAt: string | null; timeZone: string; stored: boolean }
  /** The lines as printed; rebuilt from the sale for a receipt that predates stored lines. */
  items: ReceiptItem[] | null
  prints: ReceiptPrintRow[]
}

export function receiptDetail(db: Db, id: number): ReceiptDetail | undefined {
  const meta = db
    .prepare(
      `SELECT day, rendered_at AS renderedAt, time_zone AS timeZone,
              items, png IS NOT NULL AS stored
         FROM receipts WHERE id = ?`
    )
    .get(id) as
    | { day: string; renderedAt: string | null; timeZone: string; items: string | null; stored: number }
    | undefined
  if (!meta) return undefined

  const listed = listReceipts(db, { day: meta.day }).find((r) => r.id === id)
  if (!listed) return undefined

  let items: ReceiptItem[] | null = null
  if (meta.items) {
    items = JSON.parse(meta.items) as ReceiptItem[]
  } else {
    try {
      items = receiptLinesForOrder(db, listed.orderId)
    } catch (e) {
      if (!(e instanceof UnprintableOrderError)) throw e
    }
  }

  const prints = (
    db
      .prepare(
        `SELECT id, copy, actor, device, status, percent, error,
                started_at AS startedAt, finished_at AS finishedAt
           FROM receipt_prints WHERE receipt_id = ? ORDER BY id DESC`
      )
      .all(id) as Array<Omit<ReceiptPrintRow, 'copy'> & { copy: number }>
  ).map((p) => ({ ...p, copy: p.copy === 1 }))

  return {
    receipt: {
      ...listed,
      renderedAt: meta.renderedAt,
      timeZone: meta.timeZone,
      stored: meta.stored === 1
    },
    items,
    prints
  }
}
