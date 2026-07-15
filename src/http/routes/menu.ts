import { Router } from 'express'
import { audit } from '../../domain/audit.js'
import { getMenuItem, listMenu } from '../../domain/menu.js'
import { MAX_MENU_ITEMS, MAX_MENU_NAME_BYTES, utf8Bytes } from '../../wire/limits.js'
import type { StaffDeps } from '../deps.js'
import { requireRole } from '../staffAuth.js'

export function menuRouter(deps: StaffDeps): Router {
  const router = Router()

  router.get('/menu', (_req, res) => {
    const items = listMenu(deps.db)
    res.json({
      items,
      // The terminal's parse_menu() stops at CMS_MENU_MAX_ITEMS, so anything
      // past 16 would never be seen by a player. Say so rather than hide it.
      warning:
        items.length > MAX_MENU_ITEMS
          ? `The terminal only shows the first ${MAX_MENU_ITEMS} drinks; ${items.length - MAX_MENU_ITEMS} will not appear.`
          : null
    })
  })

  router.post('/menu', requireRole('admin'), (req, res) => {
    const { drink_id, name, price_deni, points_price, available, sort_order } = req.body ?? {}

    if (!Number.isInteger(drink_id) || drink_id <= 0) {
      res.status(400).json({ error: 'drink_id must be a positive integer' })
      return
    }
    if (typeof name !== 'string' || name.trim() === '') {
      res.status(400).json({ error: 'name is required' })
      return
    }
    if (utf8Bytes(name) > MAX_MENU_NAME_BYTES) {
      res.status(400).json({
        error: `name is too long: ${utf8Bytes(name)} bytes, the terminal accepts ${MAX_MENU_NAME_BYTES}`
      })
      return
    }
    if (!Number.isInteger(price_deni) || price_deni < 0) {
      res.status(400).json({ error: 'price_deni must be a non-negative integer of deni' })
      return
    }
    if (!Number.isInteger(points_price) || points_price < 0) {
      res.status(400).json({ error: 'points_price must be a non-negative integer' })
      return
    }

    try {
      deps.db
        .prepare(
          `INSERT INTO menu_items (drink_id, name, price_deni, points_price, available, sort_order)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(drink_id, name, price_deni, points_price, available === false ? 0 : 1, sort_order ?? drink_id)
    } catch {
      res.status(400).json({ error: 'drink_id already exists' })
      return
    }

    audit(deps.db, {
      actor: req.staff!.username,
      action: 'menu.create',
      entityType: 'menu_item',
      entityId: String(drink_id),
      details: { name, price_deni, points_price }
    })
    res.json(getMenuItem(deps.db, drink_id))
  })

  router.patch('/menu/:drinkId', requireRole('admin'), (req, res) => {
    const drinkId = Number(req.params.drinkId)
    const existing = getMenuItem(deps.db, drinkId)
    if (!existing) {
      res.status(404).json({ error: 'no such drink' })
      return
    }

    const { name, price_deni, points_price, available, sort_order } = req.body ?? {}
    if (name !== undefined && utf8Bytes(String(name)) > MAX_MENU_NAME_BYTES) {
      res.status(400).json({
        error: `name is too long: ${utf8Bytes(String(name))} bytes, the terminal accepts ${MAX_MENU_NAME_BYTES}`
      })
      return
    }

    deps.db
      .prepare(
        `UPDATE menu_items
         SET name = COALESCE(?, name),
             price_deni = COALESCE(?, price_deni),
             points_price = COALESCE(?, points_price),
             available = COALESCE(?, available),
             sort_order = COALESCE(?, sort_order),
             updated_at = datetime('now')
         WHERE drink_id = ?`
      )
      .run(
        name ?? null,
        Number.isInteger(price_deni) ? price_deni : null,
        Number.isInteger(points_price) ? points_price : null,
        available === undefined ? null : available ? 1 : 0,
        Number.isInteger(sort_order) ? sort_order : null,
        drinkId
      )

    audit(deps.db, {
      actor: req.staff!.username,
      action: 'menu.update',
      entityType: 'menu_item',
      entityId: String(drinkId),
      details: req.body
    })
    res.json(getMenuItem(deps.db, drinkId))
  })

  router.delete('/menu/:drinkId', requireRole('admin'), (req, res) => {
    const drinkId = Number(req.params.drinkId)
    if (!getMenuItem(deps.db, drinkId)) {
      res.status(404).json({ error: 'no such drink' })
      return
    }
    // order_items keep a name/price snapshot, so history survives the delete.
    deps.db.prepare('DELETE FROM menu_items WHERE drink_id = ?').run(drinkId)
    audit(deps.db, {
      actor: req.staff!.username,
      action: 'menu.delete',
      entityType: 'menu_item',
      entityId: String(drinkId)
    })
    res.json({ ok: true })
  })

  return router
}
