import { Router } from 'express'
import { audit } from '../../domain/audit.js'
import {
  getTicket,
  issueTicket,
  listTickets,
  voidTicket,
  type TicketStatus
} from '../../domain/tickets.js'
import { param, type StaffDeps } from '../deps.js'
import { requireRole } from '../staffAuth.js'

const STATUSES: TicketStatus[] = ['issued', 'redeemed', 'voided', 'expired']

export function ticketsRouter(deps: StaffDeps): Router {
  const router = Router()

  router.get('/tickets', (req, res) => {
    const status = req.query.status as TicketStatus | undefined
    if (status && !STATUSES.includes(status)) {
      res.status(400).json({ error: 'unknown status' })
      return
    }
    const search = typeof req.query.search === 'string' ? req.query.search : undefined
    res.json(listTickets(deps.db, { ...(status ? { status } : {}), ...(search ? { search } : {}) }))
  })

  router.get('/tickets/:id', (req, res) => {
    const ticket = getTicket(deps.db, req.params.id)
    if (!ticket) {
      res.status(404).json({ error: 'no such ticket' })
      return
    }
    res.json({
      ticket,
      events: deps.db
        .prepare('SELECT * FROM ticket_events WHERE ticket_id = ? ORDER BY id')
        .all(req.params.id)
    })
  })

  router.post('/tickets', requireRole('admin'), (req, res) => {
    const { amountDeni } = req.body ?? {}
    if (!Number.isInteger(amountDeni) || amountDeni <= 0) {
      res.status(400).json({ error: 'amountDeni must be a positive integer of deni' })
      return
    }

    const ticket = issueTicket(deps.db, {
      amountDeni,
      source: 'manual',
      expiryDays: deps.config.ticketExpiryDays,
      actor: req.staff!.username
    })
    audit(deps.db, {
      actor: req.staff!.username,
      action: 'ticket.issue',
      entityType: 'ticket',
      entityId: ticket.id,
      details: { amountDeni }
    })
    res.json(ticket)
  })

  router.post('/tickets/:id/void', requireRole('admin'), (req, res) => {
    const actor = req.staff!.username
    const ticketId = param(req, 'id')
    if (!voidTicket(deps.db, ticketId, actor)) {
      res.status(409).json({ error: 'only an unredeemed ticket can be voided' })
      return
    }
    audit(deps.db, {
      actor,
      action: 'ticket.void',
      entityType: 'ticket',
      entityId: ticketId
    })
    res.json({ ticket: getTicket(deps.db, ticketId) })
  })

  return router
}
