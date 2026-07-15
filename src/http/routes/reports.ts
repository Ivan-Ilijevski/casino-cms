import { Router } from 'express'
import { listAudit } from '../../domain/audit.js'
import type { StaffDeps } from '../deps.js'
import { requireRole } from '../staffAuth.js'

function one<T>(db: StaffDeps['db'], sql: string, ...params: unknown[]): T {
  return db.prepare(sql).get(...params) as T
}

export function reportsRouter(deps: StaffDeps): Router {
  const router = Router()

  router.get('/reports/summary', (_req, res) => {
    const db = deps.db

    const orders = one<{ total: number; received: number; fulfilled: number; cancelled: number }>(
      db,
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(status = 'received'), 0)  AS received,
              COALESCE(SUM(status = 'fulfilled'), 0) AS fulfilled,
              COALESCE(SUM(status = 'cancelled'), 0) AS cancelled
       FROM orders`
    )

    // Cancelled orders were refunded, so they are not revenue.
    const revenue = one<{ cashDeni: number; pointsSpent: number }>(
      db,
      `SELECT COALESCE(SUM(CASE WHEN pay_method = 'cash'   THEN total_deni   END), 0) AS cashDeni,
              COALESCE(SUM(CASE WHEN pay_method = 'points' THEN total_points END), 0) AS pointsSpent
       FROM orders WHERE status <> 'cancelled'`
    )

    const tickets = one<{ outstandingDeni: number; outstanding: number; redeemedDeni: number }>(
      db,
      `SELECT COALESCE(SUM(CASE WHEN status = 'issued'   THEN amount_deni END), 0) AS outstandingDeni,
              COALESCE(SUM(status = 'issued'), 0)                                  AS outstanding,
              COALESCE(SUM(CASE WHEN status = 'redeemed' THEN amount_deni END), 0) AS redeemedDeni
       FROM tickets`
    )

    const topDrinks = db
      .prepare(
        `SELECT oi.name, SUM(oi.qty) AS qty, SUM(oi.line_total_deni) AS deni
         FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
         WHERE o.status <> 'cancelled'
         GROUP BY oi.drink_id, oi.name
         ORDER BY qty DESC
         LIMIT 10`
      )
      .all()

    const ordersPerDay = db
      .prepare(
        `SELECT date(created_at) AS day, COUNT(*) AS orders, COALESCE(SUM(total_deni), 0) AS deni
         FROM orders
         WHERE created_at >= datetime('now', '-30 days')
         GROUP BY day ORDER BY day`
      )
      .all()

    const activeSessions = one<{ n: number }>(
      db,
      'SELECT COUNT(*) AS n FROM sessions WHERE closed_at IS NULL'
    ).n

    const cards = one<{ n: number; balanceDeni: number }>(
      db,
      'SELECT COUNT(*) AS n, COALESCE(SUM(balance_deni), 0) AS balanceDeni FROM cards'
    )

    res.json({ orders, revenue, tickets, topDrinks, ordersPerDay, activeSessions, cards })
  })

  router.get('/reports/audit', requireRole('admin'), (_req, res) => {
    res.json(listAudit(deps.db, 200))
  })

  return router
}
