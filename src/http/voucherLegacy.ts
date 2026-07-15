import express from 'express'
import type { Db } from '../db/index.js'
import {
  denarsToDeni,
  deniToDenars,
  generateTicketId,
  issueTicketWithId,
  redeemTicket,
  type TicketRow
} from '../domain/tickets.js'

export interface VoucherAppDeps {
  db: Db
  /** Value the x-api-key header must carry on /generate. */
  apiKey: string
  ticketExpiryDays: number | null
}

/**
 * Byte-compatible replacement for /Users/ivanilijevski/voucher-server/voucher-server.js.
 *
 * The slot game calls this with ZERO changes (voucherGenerator.ts -> /generate,
 * VoucherInput -> /api/voucher/redeem -> /validate), so every path, status code
 * and response shape below is pinned to the original. Quirks are deliberate:
 *
 *  - no /api/voucher prefix (that prefix belongs to the game's own proxy routes)
 *  - only /generate checks the api key
 *  - /validate cannot distinguish "already used" from "never existed"
 *  - `credit` is in whole denars, not deni
 */
export function createVoucherApp(deps: VoucherAppDeps): express.Express {
  const app = express()
  app.use(express.json())

  app.post('/validate', (req, res) => {
    const { id } = req.body ?? {}
    if (!id) {
      res.status(400).json({ valid: false, reason: 'Missing voucher ID' })
      return
    }

    const result = redeemTicket(deps.db, String(id), { actor: 'slot-machine' })
    if (!result.ok) {
      res.status(409).json({ valid: false, credit: 0, reason: 'Already used or invalid' })
      return
    }
    res.json({ valid: true, credit: deniToDenars(result.amountDeni) })
  })

  app.post('/create', (req, res) => {
    const { code, credit } = req.body ?? {}
    if (!code || typeof credit !== 'number' || !Number.isFinite(credit)) {
      res.status(400).json({ success: false, message: 'Missing or invalid input' })
      return
    }

    try {
      issueTicketWithId(deps.db, {
        id: String(code),
        amountDeni: denarsToDeni(credit),
        source: 'manual',
        expiryDays: deps.ticketExpiryDays,
        actor: 'legacy-api'
      })
      res.json({ success: true })
    } catch {
      res.status(400).json({ success: false, message: 'Duplicate code or database error' })
    }
  })

  app.post('/generate', (req, res) => {
    if (req.headers['x-api-key'] !== deps.apiKey) {
      res.status(403).json({ success: false, message: 'Unauthorized' })
      return
    }

    const { credit } = req.body ?? {}
    if (typeof credit !== 'number' || !Number.isFinite(credit) || credit <= 0) {
      res.status(400).json({ success: false, message: 'Invalid credit amount' })
      return
    }

    try {
      const id = generateTicketId(deps.db)
      issueTicketWithId(deps.db, {
        id,
        amountDeni: denarsToDeni(credit),
        source: 'cashout',
        expiryDays: deps.ticketExpiryDays,
        actor: 'slot-machine'
      })
      res.json({ success: true, id })
    } catch {
      res.status(500).json({ success: false, message: 'Failed to create voucher' })
    }
  })

  app.get('/vouchers', (_req, res) => {
    const rows = deps.db
      .prepare('SELECT * FROM tickets ORDER BY created_at DESC, rowid DESC')
      .all() as TicketRow[]

    // Project the richer schema back onto the legacy four fields so the old
    // mobileApp.html admin page keeps working.
    res.json(
      rows.map((row) => ({
        id: row.id,
        credit: deniToDenars(row.amount_deni),
        used: row.status === 'redeemed' ? 1 : 0,
        created_at: row.created_at
      }))
    )
  })

  return app
}
