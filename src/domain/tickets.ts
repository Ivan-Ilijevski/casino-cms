import { randomBytes } from 'node:crypto'
import type { Db } from '../db/index.js'

export type TicketStatus = 'issued' | 'redeemed' | 'voided' | 'expired'
export type TicketSource = 'cashout' | 'manual' | 'legacy_import'

export interface TicketRow {
  id: string
  amount_deni: number
  status: TicketStatus
  source: TicketSource
  machine_id: string | null
  created_at: string
  expires_at: string | null
  redeemed_at: string | null
  redeemed_by: string | null
}

export type RedeemResult =
  | { ok: true; amountDeni: number }
  | { ok: false; reason: 'already_used_or_invalid' | 'expired' }

/**
 * The legacy voucher API speaks whole denars; everything else in this system —
 * card ledger, orders, the slot game's wallet and meters — is integer deni.
 * These two functions are the ONLY place that conversion happens.
 *
 * Math.round matters: 0.07 * 100 is 7.000000000000001 in IEEE-754.
 */
export function denarsToDeni(credit: number): number {
  return Math.round(credit * 100)
}

export function deniToDenars(amountDeni: number): number {
  return amountDeni / 100
}

/**
 * Port of voucher-server.js generateShortId(): concatenate decimal renderings
 * of random uint32s until we have 18 digits. Not a SAS validation number — the
 * slot game QR-encodes these 18 digits and displays them as xx-xxxx-xxxx-xxxx-xxxx.
 */
function shortId(length = 18): string {
  let result = ''
  while (result.length < length) {
    result += randomBytes(4).readUInt32BE(0).toString()
  }
  return result.substring(0, length)
}

export function getTicket(db: Db, id: string): TicketRow | undefined {
  return db.prepare('SELECT * FROM tickets WHERE id = ?').get(id) as TicketRow | undefined
}

export function generateTicketId(db: Db): string {
  for (;;) {
    const id = shortId()
    if (!db.prepare('SELECT 1 FROM tickets WHERE id = ?').get(id)) return id
  }
}

function logEvent(
  db: Db,
  ticketId: string,
  event: TicketStatus,
  actor: string,
  details?: unknown
): void {
  db.prepare(
    'INSERT INTO ticket_events (ticket_id, event, actor, details) VALUES (?, ?, ?, ?)'
  ).run(ticketId, event, actor, details === undefined ? null : JSON.stringify(details))
}

export function issueTicketWithId(
  db: Db,
  opts: {
    id: string
    amountDeni: number
    source?: TicketSource
    machineId?: string | null
    expiryDays?: number | null
    actor?: string
    createdAt?: string
  }
): TicketRow {
  if (!Number.isInteger(opts.amountDeni) || opts.amountDeni < 0) {
    throw new Error(`ticket amount must be a non-negative integer of deni, got ${opts.amountDeni}`)
  }
  const expiry = opts.expiryDays != null && opts.expiryDays > 0 ? `+${opts.expiryDays} days` : null

  return db.transaction((): TicketRow => {
    db.prepare(
      `INSERT INTO tickets (id, amount_deni, source, machine_id, created_at, expires_at)
       VALUES (?, ?, ?, ?, COALESCE(?, datetime('now')), CASE WHEN ? IS NULL THEN NULL ELSE datetime('now', ?) END)`
    ).run(
      opts.id,
      opts.amountDeni,
      opts.source ?? 'cashout',
      opts.machineId ?? null,
      opts.createdAt ?? null,
      expiry,
      expiry
    )
    logEvent(db, opts.id, 'issued', opts.actor ?? 'system', { amountDeni: opts.amountDeni })
    return getTicket(db, opts.id)!
  })()
}

export function issueTicket(
  db: Db,
  opts: {
    amountDeni: number
    source?: TicketSource
    machineId?: string | null
    expiryDays?: number | null
    actor?: string
  }
): TicketRow {
  return issueTicketWithId(db, { ...opts, id: generateTicketId(db) })
}

/**
 * Atomic redeem. The conditional UPDATE is the double-spend guard — exactly the
 * mechanism the legacy server relied on, kept intact.
 */
export function redeemTicket(db: Db, id: string, opts: { actor?: string } = {}): RedeemResult {
  return db.transaction((): RedeemResult => {
    const expired = db
      .prepare(
        `UPDATE tickets SET status = 'expired'
         WHERE id = ? AND status = 'issued' AND expires_at IS NOT NULL AND expires_at <= datetime('now')`
      )
      .run(id)
    if (expired.changes === 1) {
      logEvent(db, id, 'expired', opts.actor ?? 'system')
      return { ok: false, reason: 'expired' }
    }

    const res = db
      .prepare(
        `UPDATE tickets
         SET status = 'redeemed', redeemed_at = datetime('now'), redeemed_by = ?
         WHERE id = ? AND status = 'issued'`
      )
      .run(opts.actor ?? null, id)

    if (res.changes !== 1) return { ok: false, reason: 'already_used_or_invalid' }

    const row = getTicket(db, id)!
    logEvent(db, id, 'redeemed', opts.actor ?? 'system', { amountDeni: row.amount_deni })
    return { ok: true, amountDeni: row.amount_deni }
  })()
}

export function voidTicket(db: Db, id: string, actor: string): boolean {
  return db.transaction((): boolean => {
    const res = db
      .prepare(`UPDATE tickets SET status = 'voided' WHERE id = ? AND status = 'issued'`)
      .run(id)
    if (res.changes !== 1) return false
    logEvent(db, id, 'voided', actor)
    return true
  })()
}

export interface TicketFilter {
  status?: TicketStatus
  search?: string
  limit?: number
}

export function listTickets(db: Db, filter: TicketFilter = {}): TicketRow[] {
  const where: string[] = []
  const params: unknown[] = []
  if (filter.status) {
    where.push('status = ?')
    params.push(filter.status)
  }
  if (filter.search) {
    where.push('id LIKE ?')
    params.push(`%${filter.search}%`)
  }
  params.push(filter.limit ?? 200)
  return db
    .prepare(
      `SELECT * FROM tickets
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY created_at DESC, rowid DESC
       LIMIT ?`
    )
    .all(...params) as TicketRow[]
}
