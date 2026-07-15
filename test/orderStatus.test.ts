import { describe, expect, test } from 'vitest'
import { openTestDb } from '../src/db/index.js'
import { seed } from '../src/db/seed.js'
import { createPlayerWithCard } from '../src/domain/accounts.js'
import { balanceOf, postEntry } from '../src/domain/ledger.js'
import { getOrder, placeOrder, setOrderStatus } from '../src/domain/orders.js'
import { openSession } from '../src/domain/sessions.js'

function setup(deni = 100000, points = 100) {
  const db = openTestDb()
  seed(db, { adminPassword: 'test' })
  const { card } = createPlayerWithCard(db, { name: 'Иван Илијевски', cardUid: 'AA BB' })
  postEntry(db, { cardId: card.id, unit: 'deni', amount: deni, kind: 'adjustment' })
  postEntry(db, { cardId: card.id, unit: 'points', amount: points, kind: 'adjustment' })
  const session = openSession(db, card.id)
  return { db, card, session }
}

function cashOrder(db: any, card: any, session: any) {
  const res = placeOrder(db, {
    cardId: card.id,
    sessionId: session.sid,
    pay: 'cash',
    items: [{ drink: 1, qty: 2 }] // 16000 deni
  })
  if (!res.ok) throw new Error('order should have succeeded')
  return res
}

describe('setOrderStatus', () => {
  test('accepts a received order', () => {
    const { db, card, session } = setup()
    const order = cashOrder(db, card, session)

    const res = setOrderStatus(db, { orderId: order.orderId, status: 'accepted', actor: 'barman' })

    expect(res.ok).toBe(true)
    expect(getOrder(db, order.orderId)?.status).toBe('accepted')
  })

  test('fulfilling records who did it and when', () => {
    const { db, card, session } = setup()
    const order = cashOrder(db, card, session)

    setOrderStatus(db, { orderId: order.orderId, status: 'fulfilled', actor: 'barman' })

    const row = getOrder(db, order.orderId)!
    expect(row.status).toBe('fulfilled')
    expect(row.fulfilled_by).toBe('barman')
    expect(row.fulfilled_at).not.toBeNull()
  })

  test('cancelling a cash order refunds the player', () => {
    const { db, card, session } = setup()
    const order = cashOrder(db, card, session)
    expect(balanceOf(db, card.id, 'deni')).toBe(84000)

    const res = setOrderStatus(db, { orderId: order.orderId, status: 'cancelled', actor: 'barman' })

    expect(res).toMatchObject({ ok: true, refunded: true })
    expect(balanceOf(db, card.id, 'deni')).toBe(100000)
    expect(getOrder(db, order.orderId)?.status).toBe('cancelled')
  })

  test('cancelling a points order refunds points, not cash', () => {
    const { db, card, session } = setup()
    const order = placeOrder(db, {
      cardId: card.id,
      sessionId: session.sid,
      pay: 'points',
      items: [{ drink: 2, qty: 1 }] // 80 points
    })
    if (!order.ok) throw new Error('order should have succeeded')
    expect(balanceOf(db, card.id, 'points')).toBe(20)

    setOrderStatus(db, { orderId: order.orderId, status: 'cancelled', actor: 'barman' })

    expect(balanceOf(db, card.id, 'points')).toBe(100)
    expect(balanceOf(db, card.id, 'deni')).toBe(100000)
  })

  test('cancelling twice refunds only once', () => {
    const { db, card, session } = setup()
    const order = cashOrder(db, card, session)

    setOrderStatus(db, { orderId: order.orderId, status: 'cancelled', actor: 'barman' })
    const second = setOrderStatus(db, { orderId: order.orderId, status: 'cancelled', actor: 'barman' })

    expect(second.ok).toBe(false)
    expect(balanceOf(db, card.id, 'deni')).toBe(100000)
  })

  test('a fulfilled order can no longer be cancelled', () => {
    const { db, card, session } = setup()
    const order = cashOrder(db, card, session)
    setOrderStatus(db, { orderId: order.orderId, status: 'fulfilled', actor: 'barman' })

    const res = setOrderStatus(db, { orderId: order.orderId, status: 'cancelled', actor: 'barman' })

    expect(res.ok).toBe(false)
    expect(balanceOf(db, card.id, 'deni')).toBe(84000) // drink was served; no refund
  })

  test('rejects an unknown order', () => {
    const { db } = setup()

    expect(setOrderStatus(db, { orderId: 'nope', status: 'fulfilled', actor: 'x' }).ok).toBe(false)
  })
})
