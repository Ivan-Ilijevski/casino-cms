import { describe, expect, test } from 'vitest'
import { openTestDb } from '../src/db/index.js'
import { seed } from '../src/db/seed.js'
import { createPlayerWithCard } from '../src/domain/accounts.js'
import { balanceOf, postEntry } from '../src/domain/ledger.js'
import { wireMenu } from '../src/domain/menu.js'
import { placeOrder } from '../src/domain/orders.js'
import { openSession } from '../src/domain/sessions.js'
import { MAX_MENU_ITEMS } from '../src/wire/limits.js'

function setup(deni = 100000, points = 100) {
  const db = openTestDb()
  seed(db, { adminPassword: 'test' })
  const { card } = createPlayerWithCard(db, { name: 'Иван Илијевски', cardUid: 'AA BB' })
  if (deni > 0) postEntry(db, { cardId: card.id, unit: 'deni', amount: deni, kind: 'adjustment' })
  if (points > 0) postEntry(db, { cardId: card.id, unit: 'points', amount: points, kind: 'adjustment' })
  const session = openSession(db, card.id)
  return { db, card, session }
}

describe('menu', () => {
  test('serialises to the firmware shape, including unavailable drinks', () => {
    const { db } = setup()

    const items = wireMenu(db)

    expect(items[0]).toEqual({ drink: 1, name: 'Кафе', price: 8000, points_price: 50, avail: true })
    // Виски is out of stock but must still be listed, flagged unavailable.
    expect(items.find((i) => i.drink === 5)).toEqual({
      drink: 5,
      name: 'Виски',
      price: 25000,
      points_price: 0,
      avail: false
    })
  })

  test('caps at the firmware CMS_MENU_MAX_ITEMS so no drink vanishes silently', () => {
    const { db } = setup()
    for (let i = 6; i <= 25; i++) {
      db.prepare(
        'INSERT INTO menu_items (drink_id, name, price_deni, points_price, available, sort_order) VALUES (?,?,?,?,1,?)'
      ).run(i, `Пијалак ${i}`, 1000, 10, i)
    }

    expect(wireMenu(db)).toHaveLength(MAX_MENU_ITEMS)
  })
})

describe('placeOrder', () => {
  test('charges cash and persists the order with line snapshots', () => {
    const { db, card, session } = setup()

    const res = placeOrder(db, {
      cardId: card.id,
      sessionId: session.sid,
      pay: 'cash',
      items: [{ drink: 1, qty: 2 }]
    })

    expect(res).toMatchObject({ ok: true, balanceDeni: 100000 - 16000 })
    expect(balanceOf(db, card.id, 'deni')).toBe(84000)

    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get((res as any).orderId) as any
    expect(order).toMatchObject({ status: 'received', pay_method: 'cash', total_deni: 16000 })
    expect(order.number).toBe(1)

    const lines = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(order.id) as any[]
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({
      drink_id: 1,
      name: 'Кафе',
      qty: 2,
      unit_price_deni: 8000,
      line_total_deni: 16000
    })
  })

  test('charges points when paying with points, leaving cash untouched', () => {
    const { db, card, session } = setup()

    const res = placeOrder(db, {
      cardId: card.id,
      sessionId: session.sid,
      pay: 'points',
      items: [{ drink: 2, qty: 1 }]
    })

    expect(res).toMatchObject({ ok: true, points: 20 })
    expect(balanceOf(db, card.id, 'points')).toBe(20)
    expect(balanceOf(db, card.id, 'deni')).toBe(100000)
  })

  test('gives consecutive order numbers', () => {
    const { db, card, session } = setup()

    placeOrder(db, { cardId: card.id, sessionId: session.sid, pay: 'cash', items: [{ drink: 1, qty: 1 }] })
    const second = placeOrder(db, {
      cardId: card.id,
      sessionId: session.sid,
      pay: 'cash',
      items: [{ drink: 1, qty: 1 }]
    })

    const order = db.prepare('SELECT number FROM orders WHERE id = ?').get((second as any).orderId) as any
    expect(order.number).toBe(2)
  })

  test('rejects an empty selection', () => {
    const { db, card, session } = setup()

    expect(
      placeOrder(db, { cardId: card.id, sessionId: session.sid, pay: 'cash', items: [] })
    ).toEqual({ ok: false, code: 'empty' })
  })

  test('skips unavailable, unknown and zero-qty drinks — all skipped means empty', () => {
    const { db, card, session } = setup()

    const res = placeOrder(db, {
      cardId: card.id,
      sessionId: session.sid,
      pay: 'cash',
      items: [
        { drink: 5, qty: 1 }, // Виски: unavailable
        { drink: 99, qty: 1 }, // unknown
        { drink: 1, qty: 0 } // zero qty
      ]
    })

    expect(res).toEqual({ ok: false, code: 'empty' })
    expect(balanceOf(db, card.id, 'deni')).toBe(100000)
  })

  test('charges only the valid lines when some are skipped', () => {
    const { db, card, session } = setup()

    const res = placeOrder(db, {
      cardId: card.id,
      sessionId: session.sid,
      pay: 'cash',
      items: [
        { drink: 5, qty: 1 }, // skipped
        { drink: 1, qty: 1 } // 8000
      ]
    })

    expect(res).toMatchObject({ ok: true, balanceDeni: 92000 })
  })

  test('refuses a cash order beyond the balance and charges nothing', () => {
    const { db, card, session } = setup(5000)

    const res = placeOrder(db, {
      cardId: card.id,
      sessionId: session.sid,
      pay: 'cash',
      items: [{ drink: 1, qty: 1 }] // 8000 > 5000
    })

    expect(res).toEqual({ ok: false, code: 'insufficient' })
    expect(balanceOf(db, card.id, 'deni')).toBe(5000)
    expect(db.prepare('SELECT COUNT(*) AS n FROM orders').get()).toEqual({ n: 0 })
  })

  test('refuses a points order beyond the points balance', () => {
    const { db, card, session } = setup(100000, 10)

    const res = placeOrder(db, {
      cardId: card.id,
      sessionId: session.sid,
      pay: 'points',
      items: [{ drink: 3, qty: 1 }] // 100 points > 10
    })

    expect(res).toEqual({ ok: false, code: 'insufficient' })
    expect(balanceOf(db, card.id, 'points')).toBe(10)
  })
})

describe('stock', () => {
  /** The seeded menu is entirely untracked, so a drink has to opt in. */
  function track(db: ReturnType<typeof openTestDb>, drinkId: number, qty: number) {
    db.prepare('UPDATE menu_items SET stock_qty = ? WHERE drink_id = ?').run(qty, drinkId)
  }

  const stockOf = (db: ReturnType<typeof openTestDb>, drinkId: number) =>
    (db.prepare('SELECT stock_qty AS s FROM menu_items WHERE drink_id = ?').get(drinkId) as {
      s: number | null
    }).s

  test('an order takes what it sold off the shelf', () => {
    const { db, card, session } = setup()
    track(db, 1, 10)

    placeOrder(db, { cardId: card.id, sessionId: session.sid, pay: 'cash', items: [{ drink: 1, qty: 3 }] })

    expect(stockOf(db, 1)).toBe(7)
  })

  test('an untracked drink is never decremented', () => {
    const { db, card, session } = setup()

    placeOrder(db, { cardId: card.id, sessionId: session.sid, pay: 'cash', items: [{ drink: 1, qty: 3 }] })

    expect(stockOf(db, 1)).toBeNull()
  })

  test('ordering more than is left writes nothing at all', () => {
    const { db, card, session } = setup()
    track(db, 1, 2)

    const res = placeOrder(db, {
      cardId: card.id,
      sessionId: session.sid,
      pay: 'cash',
      items: [{ drink: 1, qty: 3 }]
    })

    expect(res).toEqual({ ok: false, code: 'out_of_stock' })
    // The whole transaction must be a no-op: no order, no charge, no decrement.
    expect(db.prepare('SELECT COUNT(*) AS n FROM orders').get()).toEqual({ n: 0 })
    expect(balanceOf(db, card.id, 'deni')).toBe(100000)
    expect(stockOf(db, 1)).toBe(2)
  })

  test('one short line rolls back the lines that would have succeeded', () => {
    const { db, card, session } = setup()
    track(db, 1, 10)
    track(db, 2, 1)

    const res = placeOrder(db, {
      cardId: card.id,
      sessionId: session.sid,
      pay: 'cash',
      items: [
        { drink: 1, qty: 1 }, // plenty
        { drink: 2, qty: 5 } // only 1 left
      ]
    })

    expect(res).toEqual({ ok: false, code: 'out_of_stock' })
    expect(stockOf(db, 1)).toBe(10)
    expect(stockOf(db, 2)).toBe(1)
  })

  test('a sold-out drink is skipped like an unavailable one', () => {
    const { db, card, session } = setup()
    track(db, 1, 0)

    const res = placeOrder(db, {
      cardId: card.id,
      sessionId: session.sid,
      pay: 'cash',
      items: [{ drink: 1, qty: 1 }]
    })

    expect(res).toEqual({ ok: false, code: 'empty' })
  })

  test('the terminal sees a sold-out drink as unavailable', () => {
    const { db } = setup()
    track(db, 1, 0)

    expect(wireMenu(db).find((i) => i.drink === 1)).toMatchObject({ name: 'Кафе', avail: false })
  })

  test('a stocked drink is still available on the wire', () => {
    const { db } = setup()
    track(db, 1, 4)

    expect(wireMenu(db).find((i) => i.drink === 1)).toMatchObject({ avail: true })
  })
})
