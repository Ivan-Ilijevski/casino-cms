import { beforeEach, describe, expect, test } from 'vitest'
import { openTestDb, type Db } from '../src/db/index.js'
import { seed } from '../src/db/seed.js'
import { createPlayerWithCard } from '../src/domain/accounts.js'
import { postEntry } from '../src/domain/ledger.js'
import { getMenuItem, wireMenu } from '../src/domain/menu.js'
import {
  DEFAULT_PREP_S,
  activeOrdersForCard,
  estimatePrepSeconds,
  etaForOrder,
  getOrder,
  placeOrder,
  setOrderStatus,
  type OrderRequestItem
} from '../src/domain/orders.js'

let db: Db
let cardId: string

beforeEach(() => {
  db = openTestDb()
  seed(db, { adminPassword: 'test' })
  const { card } = createPlayerWithCard(db, { name: 'Иван Илијевски', cardUid: 'AA BB' })
  postEntry(db, { cardId: card.id, unit: 'deni', amount: 10_000_000, kind: 'adjustment' })
  cardId = card.id
})

function order(items: OrderRequestItem[]): string {
  const res = placeOrder(db, { cardId, pay: 'cash', items })
  if (!res.ok) throw new Error(`fixture order rejected: ${res.code}`)
  return res.orderId
}

/** Backdates an order so fulfilling it records a known duration. */
function aged(orderId: string, seconds: number): string {
  db.prepare(`UPDATE orders SET created_at = datetime('now', ?) WHERE id = ?`).run(
    `-${seconds} seconds`,
    orderId
  )
  return orderId
}

function fulfil(orderId: string) {
  const res = setOrderStatus(db, { orderId, status: 'fulfilled', actor: 'sank' })
  expect(res.ok).toBe(true)
}

function stats(drinkId: number) {
  return db
    .prepare('SELECT avg_prep_s, prep_samples FROM menu_items WHERE drink_id = ?')
    .get(drinkId) as { avg_prep_s: number | null; prep_samples: number }
}

describe('learning how long a drink takes', () => {
  test('a drink starts with no history at all', () => {
    expect(stats(1)).toMatchObject({ avg_prep_s: null, prep_samples: 0 })
  })

  test('the first fulfilment IS the average', () => {
    fulfil(aged(order([{ drink: 1, qty: 1 }]), 200))

    // Not an average of the default and the sample: with nothing to average
    // against, the one real measurement stands on its own.
    expect(stats(1)).toMatchObject({ avg_prep_s: 200, prep_samples: 1 })
  })

  test('later fulfilments move the average part of the way', () => {
    fulfil(aged(order([{ drink: 1, qty: 1 }]), 200))
    fulfil(aged(order([{ drink: 1, qty: 1 }]), 400))

    // alpha = 1/2 on the second sample: 200 + (400-200)/2.
    expect(stats(1)).toMatchObject({ avg_prep_s: 300, prep_samples: 2 })
  })

  test('an absurd duration is discarded rather than averaged in', () => {
    fulfil(aged(order([{ drink: 1, qty: 1 }]), 200))
    // An order the bar forgot about until closing time says nothing about how
    // long a coffee takes, and one sample like it would wreck the average.
    fulfil(aged(order([{ drink: 1, qty: 1 }]), 40_000))

    expect(stats(1)).toMatchObject({ avg_prep_s: 200, prep_samples: 1 })
  })

  test('a suspiciously instant fulfilment is discarded too', () => {
    fulfil(order([{ drink: 1, qty: 1 }])) // fulfilled the same second

    expect(stats(1)).toMatchObject({ avg_prep_s: null, prep_samples: 0 })
  })

  test('every drink in the order learns from it', () => {
    fulfil(aged(order([{ drink: 1, qty: 1 }, { drink: 2, qty: 1 }]), 300))

    expect(stats(1).avg_prep_s).toBe(300)
    expect(stats(2).avg_prep_s).toBe(300)
  })

  test('the same drink twice in one order counts once', () => {
    fulfil(aged(order([{ drink: 1, qty: 2 }]), 300))

    expect(stats(1)).toMatchObject({ avg_prep_s: 300, prep_samples: 1 })
  })

  test('cancelling teaches nothing', () => {
    const id = aged(order([{ drink: 1, qty: 1 }]), 300)
    setOrderStatus(db, { orderId: id, status: 'cancelled', actor: 'sank' })

    expect(stats(1)).toMatchObject({ avg_prep_s: null, prep_samples: 0 })
  })
})

describe('estimating an order', () => {
  test('with no history every drink is assumed to take the default', () => {
    expect(estimatePrepSeconds(db, [{ drinkId: 1 }])).toBe(DEFAULT_PREP_S)
  })

  test('the slowest drink decides, because they are poured in parallel', () => {
    fulfil(aged(order([{ drink: 1, qty: 1 }]), 120))
    fulfil(aged(order([{ drink: 2, qty: 1 }]), 300))

    expect(estimatePrepSeconds(db, [{ drinkId: 1 }, { drinkId: 2 }])).toBe(300)
  })

  test('an untimed drink drags the estimate up to the default', () => {
    fulfil(aged(order([{ drink: 1, qty: 1 }]), 60))

    expect(estimatePrepSeconds(db, [{ drinkId: 1 }, { drinkId: 2 }])).toBe(DEFAULT_PREP_S)
  })

  test('the learned average reaches the terminal on the drink list', () => {
    fulfil(aged(order([{ drink: 1, qty: 1 }]), 180))

    const items = wireMenu(db)
    expect(items.find((i) => i.drink === 1)?.avg_s).toBe(180)
    // A drink nobody has timed sends no figure at all rather than a zero the
    // terminal would have to special-case.
    expect(items.find((i) => i.drink === 2)).not.toHaveProperty('avg_s')
  })
})

describe('the countdown the ring draws', () => {
  test('a fresh order counts down from its estimate', () => {
    const row = getOrder(db, order([{ drink: 1, qty: 1 }]))!
    const eta = etaForOrder(db, row)!

    expect(eta.eta_src).toBe('est')
    expect(eta.eta_total_s).toBe(DEFAULT_PREP_S)
    expect(eta.eta_s).toBeGreaterThan(DEFAULT_PREP_S - 5)
    expect(eta.eta_s).toBeLessThanOrEqual(DEFAULT_PREP_S)
  })

  test('the estimate shrinks as the order waits, it does not restart', () => {
    const row = getOrder(db, aged(order([{ drink: 1, qty: 1 }]), 120))!
    const eta = etaForOrder(db, row)!

    expect(eta.eta_total_s).toBe(DEFAULT_PREP_S)
    expect(eta.eta_s).toBeCloseTo(DEFAULT_PREP_S - 120, -1)
  })

  test("the bar's promise outranks the estimate", () => {
    const id = order([{ drink: 1, qty: 1 }])
    setOrderStatus(db, { orderId: id, status: 'accepted', actor: 'sank', etaMinutes: 12 })

    const eta = etaForOrder(db, getOrder(db, id)!)!
    expect(eta.eta_src).toBe('promised')
    expect(eta.eta_s).toBeGreaterThan(12 * 60 - 5)
    expect(eta.eta_s).toBeLessThanOrEqual(12 * 60)
  })

  test('eta_total_s spans from creation, so a resync lands on the right arc', () => {
    // A terminal that reboots mid-order is told the whole span and what is
    // left, and needs no memory of what it was told before.
    const id = aged(order([{ drink: 1, qty: 1 }]), 60)
    setOrderStatus(db, { orderId: id, status: 'accepted', actor: 'sank', etaMinutes: 5 })

    const eta = etaForOrder(db, getOrder(db, id)!)!
    expect(eta.eta_total_s).toBeCloseTo(60 + 5 * 60, -1)
    expect(eta.eta_s).toBeCloseTo(5 * 60, -1)
  })

  test('a promise already past reads as zero, never as a negative', () => {
    const id = order([{ drink: 1, qty: 1 }])
    setOrderStatus(db, { orderId: id, status: 'accepted', actor: 'sank', etaMinutes: 1 })
    db.prepare(`UPDATE orders SET promised_at = datetime('now','-10 minutes') WHERE id = ?`).run(id)

    expect(etaForOrder(db, getOrder(db, id)!)!.eta_s).toBe(0)
  })

  test('a finished order has no countdown; the status says it all', () => {
    const id = aged(order([{ drink: 1, qty: 1 }]), 200)
    fulfil(id)
    expect(etaForOrder(db, getOrder(db, id)!)).toBeNull()

    const cancelled = order([{ drink: 1, qty: 1 }])
    setOrderStatus(db, { orderId: cancelled, status: 'cancelled', actor: 'sank' })
    expect(etaForOrder(db, getOrder(db, cancelled)!)).toBeNull()
  })
})

describe('what a reconnecting terminal is told', () => {
  test('open orders come back newest first', () => {
    const first = order([{ drink: 1, qty: 1 }])
    const second = order([{ drink: 2, qty: 1 }])

    const open = activeOrdersForCard(db, cardId)
    expect(open.map((o) => o.id)).toEqual([second, first])
  })

  test('finished orders drop out', () => {
    const kept = order([{ drink: 1, qty: 1 }])
    fulfil(aged(order([{ drink: 2, qty: 1 }]), 200))

    expect(activeOrdersForCard(db, cardId).map((o) => o.id)).toEqual([kept])
  })

  test("another card's orders are never included", () => {
    order([{ drink: 1, qty: 1 }])
    const { card: other } = createPlayerWithCard(db, { name: 'Друг', cardUid: 'CC DD' })

    expect(activeOrdersForCard(db, other.id)).toHaveLength(0)
  })

  test('an order outlives the session it was placed in', () => {
    // The sid is minted fresh on every re-auth, which is exactly why the
    // lookup is by card: a session-scoped one would come back empty for the
    // guest who just tapped in to check on their drink.
    const id = order([{ drink: 1, qty: 1 }])
    db.prepare(`UPDATE orders SET session_id = 'a-closed-session' WHERE id = ?`).run(id)

    expect(activeOrdersForCard(db, cardId).map((o) => o.id)).toEqual([id])
  })

  test('a POS order with no session at all still reaches the card', () => {
    const id = order([{ drink: 1, qty: 1 }])
    db.prepare(`UPDATE orders SET session_id = NULL, source = 'pos' WHERE id = ?`).run(id)

    expect(activeOrdersForCard(db, cardId).map((o) => o.id)).toEqual([id])
  })

  test('the menu item lookup survives a drink being delisted', () => {
    // estimatePrepSeconds reads through getMenuItem; a drink that no longer
    // exists must fall back rather than throw at a guest's terminal.
    expect(getMenuItem(db, 9999)).toBeUndefined()
    expect(estimatePrepSeconds(db, [{ drinkId: 9999 }])).toBe(DEFAULT_PREP_S)
  })
})
