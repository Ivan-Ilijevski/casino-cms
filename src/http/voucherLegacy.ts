import express from 'express'
import type { Db } from '../db/index.js'
import { getMachine, resolveMachineByLink } from '../domain/machines.js'
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

  /**
   * Which cabinet this request came from, resolved by remote IP.
   *
   * tickets.machine_id has existed since 001 and no caller has ever filled it,
   * so a cashout could not be attributed to a machine. The slot game reaches
   * 8080 from the same host that holds its CMS socket on 9020, so the address is
   * enough to link the two without the game changing at all.
   *
   * This is a HINT, not a fact: 8080 has no auth beyond x-api-key on /generate,
   * so anything on the LAN could cash out from a machine's address. It is used
   * only to attribute a ticket for staff, never to authorise anything.
   */
  const machineFor = (req: express.Request) => {
    const id = resolveMachineByLink(deps.db, { host: req.socket.remoteAddress })
    return id ? getMachine(deps.db, id) : undefined
  }

  app.post('/validate', (req, res) => {
    const { id } = req.body ?? {}
    if (!id) {
      res.status(400).json({ valid: false, reason: 'Missing voucher ID' })
      return
    }

    // Falls back to the legacy literal when the address matches no machine, so
    // redeemed_by keeps its old meaning on an unregistered floor.
    const result = redeemTicket(deps.db, String(id), {
      actor: machineFor(req)?.label ?? 'slot-machine'
    })
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
        machineId: machineFor(req)?.id ?? null,
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
        machineId: machineFor(req)?.id ?? null,
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
