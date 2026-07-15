import { Router } from 'express'
import { audit } from '../../domain/audit.js'
import {
  getOrderWithLines,
  listOrders,
  setOrderStatus,
  type OrderStatus
} from '../../domain/orders.js'
import { pushBalanceForCard, type StaffDeps } from '../deps.js'

const STATUSES: OrderStatus[] = ['received', 'accepted', 'fulfilled', 'cancelled']

export function ordersRouter(deps: StaffDeps): Router {
  const router = Router()

  router.get('/orders', (req, res) => {
    const status = req.query.status as OrderStatus | undefined
    if (status && !STATUSES.includes(status)) {
      res.status(400).json({ error: 'unknown status' })
      return
    }
    res.json(listOrders(deps.db, status ? { status } : {}))
  })

  router.post('/orders/:id/status', (req, res) => {
    const status = req.body?.status as OrderStatus
    if (!STATUSES.includes(status)) {
      res.status(400).json({ error: 'unknown status' })
      return
    }

    const actor = req.staff!.username
    const result = setOrderStatus(deps.db, { orderId: req.params.id, status, actor })
    if (!result.ok) {
      res.status(result.reason === 'unknown_order' ? 404 : 409).json({ error: result.reason })
      return
    }

    audit(deps.db, {
      actor,
      action: `order.${status}`,
      entityType: 'order',
      entityId: req.params.id,
      details: { refunded: result.refunded }
    })

    // A refund changed the balance — tell the terminal before the player notices.
    if (result.refunded) pushBalanceForCard(deps, result.order.card_id)

    deps.events.emit('order.updated', { orderId: req.params.id })
    res.json({ order: result.order, refunded: result.refunded })
  })

  /** Live order feed for the bar screen. */
  router.get('/orders/events', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    })
    res.write(': connected\n\n')

    const send = (event: string, payload: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`)
    }

    const offCreated = deps.events.on('order.created', ({ orderId }) => {
      send('order.created', getOrderWithLines(deps.db, orderId) ?? { orderId })
    })
    const offUpdated = deps.events.on('order.updated', ({ orderId }) => {
      send('order.updated', getOrderWithLines(deps.db, orderId) ?? { orderId })
    })

    // Proxies drop idle connections; a comment keeps the stream warm.
    const keepAlive = setInterval(() => res.write(': ping\n\n'), 25_000)

    req.on('close', () => {
      clearInterval(keepAlive)
      offCreated()
      offUpdated()
    })
  })

  return router
}
