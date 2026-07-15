import type { Db } from '../db/index.js'
import { MAX_MENU_ITEMS } from '../wire/limits.js'

export interface MenuItemRow {
  drink_id: number
  name: string
  price_deni: number
  points_price: number
  available: number
  sort_order: number
  updated_at: string
}

/** Exactly the shape the firmware's parse_menu() expects. */
export interface WireMenuItem {
  drink: number
  name: string
  /** deni — the wire field is called "price" and carries the same integer. */
  price: number
  /** 0 = not purchasable with points. */
  points_price: number
  avail: boolean
}

/** Every item, for the staff app. */
export function listMenu(db: Db): MenuItemRow[] {
  return db.prepare('SELECT * FROM menu_items ORDER BY sort_order, drink_id').all() as MenuItemRow[]
}

export function getMenuItem(db: Db, drinkId: number): MenuItemRow | undefined {
  return db.prepare('SELECT * FROM menu_items WHERE drink_id = ?').get(drinkId) as
    | MenuItemRow
    | undefined
}

/**
 * The menu as sent in menu_res. Unavailable drinks are included (flagged
 * avail:false) — the prototype did this and the terminal greys them out.
 *
 * Capped at MAX_MENU_ITEMS because the firmware stops parsing there; sending
 * more would make trailing drinks silently invisible at the terminal.
 */
export function wireMenu(db: Db): WireMenuItem[] {
  return listMenu(db)
    .slice(0, MAX_MENU_ITEMS)
    .map((row) => ({
      drink: row.drink_id,
      name: row.name,
      price: row.price_deni,
      points_price: row.points_price,
      avail: row.available === 1
    }))
}
