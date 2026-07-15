import request from 'supertest'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { DEFAULT_CONFIG } from '../src/config.js'
import { openTestDb, type Db } from '../src/db/index.js'
import { seed } from '../src/db/seed.js'
import { createPlayerWithCard } from '../src/domain/accounts.js'
import { balanceOf, postEntry } from '../src/domain/ledger.js'
import { placeOrder } from '../src/domain/orders.js'
import { hashPassword } from '../src/domain/password.js'
import { openSession } from '../src/domain/sessions.js'
import { issueTicket } from '../src/domain/tickets.js'
import { CmsEvents } from '../src/events.js'
import { createStaffApp } from '../src/http/server.js'

let db: Db
let app: ReturnType<typeof createStaffApp>
let pushes: { pushBalance: ReturnType<typeof vi.fn>; pushLogout: ReturnType<typeof vi.fn> }

const ADMIN = { username: 'admin', password: 'secret123' }

beforeEach(() => {
  db = openTestDb()
  seed(db, { adminPassword: ADMIN.password })
  db.prepare(
    `INSERT INTO staff_users (id, username, password_hash, role) VALUES ('u2', 'barman', ?, 'staff')`
  ).run(hashPassword(ADMIN.password))
  pushes = { pushBalance: vi.fn().mockReturnValue(true), pushLogout: vi.fn().mockReturnValue(true) }
  app = createStaffApp({
    db,
    config: { ...DEFAULT_CONFIG, sessionSecret: 'test-secret' },
    events: new CmsEvents(),
    pushes
  })
})

async function loginAs(username: string, password: string) {
  const agent = request.agent(app)
  const res = await agent.post('/api/login').send({ username, password })
  expect(res.status).toBe(200)
  return agent
}

function makeCard(uid = 'AA BB', name = 'Иван Илијевски', deni = 100000) {
  const { card, player } = createPlayerWithCard(db, { name, cardUid: uid })
  postEntry(db, { cardId: card.id, unit: 'deni', amount: deni, kind: 'adjustment' })
  return { card, player }
}

describe('authentication', () => {
  test('rejects an unauthenticated request', async () => {
    const res = await request(app).get('/api/orders')

    expect(res.status).toBe(401)
  })

  test('rejects a wrong password', async () => {
    const res = await request(app).post('/api/login').send({ username: 'admin', password: 'wrong' })

    expect(res.status).toBe(401)
  })

  test('rejects an unknown user', async () => {
    const res = await request(app).post('/api/login').send({ username: 'ghost', password: 'x' })

    expect(res.status).toBe(401)
  })

  test('logs in and reports the current user', async () => {
    const agent = await loginAs(ADMIN.username, ADMIN.password)

    const res = await agent.get('/api/me')

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ username: 'admin', role: 'admin' })
  })

  test('never leaks the password hash', async () => {
    const agent = await loginAs(ADMIN.username, ADMIN.password)

    const res = await agent.get('/api/me')

    expect(JSON.stringify(res.body)).not.toContain('scrypt$')
  })

  test('logging out ends the session', async () => {
    const agent = await loginAs(ADMIN.username, ADMIN.password)

    await agent.post('/api/logout')
    const res = await agent.get('/api/me')

    expect(res.status).toBe(401)
  })
})

describe('role guard', () => {
  test('staff may read orders', async () => {
    const agent = await loginAs('barman', ADMIN.password)

    expect((await agent.get('/api/orders')).status).toBe(200)
  })

  test('staff may not manage the menu', async () => {
    const agent = await loginAs('barman', ADMIN.password)

    const res = await agent.patch('/api/menu/1').send({ available: false })

    expect(res.status).toBe(403)
  })

  test('staff may not adjust balances', async () => {
    const { card } = makeCard()
    const agent = await loginAs('barman', ADMIN.password)

    const res = await agent.post(`/api/cards/${card.id}/adjust`).send({ unit: 'deni', amount: 100 })

    expect(res.status).toBe(403)
  })
})

describe('orders', () => {
  test('lists orders with their line items and player', async () => {
    const { card } = makeCard()
    const session = openSession(db, card.id)
    placeOrder(db, { cardId: card.id, sessionId: session.sid, pay: 'cash', items: [{ drink: 1, qty: 2 }] })
    const agent = await loginAs(ADMIN.username, ADMIN.password)

    const res = await agent.get('/api/orders')

    expect(res.status).toBe(200)
    expect(res.body).toHaveLength(1)
    expect(res.body[0]).toMatchObject({ status: 'received', player_name: 'Иван Илијевски' })
    expect(res.body[0].items[0]).toMatchObject({ name: 'Кафе', qty: 2 })
  })

  test('filters by status', async () => {
    const { card } = makeCard()
    const session = openSession(db, card.id)
    placeOrder(db, { cardId: card.id, sessionId: session.sid, pay: 'cash', items: [{ drink: 1, qty: 1 }] })
    const agent = await loginAs(ADMIN.username, ADMIN.password)

    expect((await agent.get('/api/orders?status=fulfilled')).body).toHaveLength(0)
    expect((await agent.get('/api/orders?status=received')).body).toHaveLength(1)
  })

  test('staff can fulfil an order', async () => {
    const { card } = makeCard()
    const session = openSession(db, card.id)
    const order = placeOrder(db, {
      cardId: card.id,
      sessionId: session.sid,
      pay: 'cash',
      items: [{ drink: 1, qty: 1 }]
    }) as any
    const agent = await loginAs('barman', ADMIN.password)

    const res = await agent.post(`/api/orders/${order.orderId}/status`).send({ status: 'fulfilled' })

    expect(res.status).toBe(200)
    expect(res.body.order.status).toBe('fulfilled')
    expect(res.body.order.fulfilled_by).toBe('barman')
  })

  test('cancelling refunds the player and pushes the new balance to the terminal', async () => {
    const { card } = makeCard()
    const session = openSession(db, card.id)
    const order = placeOrder(db, {
      cardId: card.id,
      sessionId: session.sid,
      pay: 'cash',
      items: [{ drink: 1, qty: 2 }]
    }) as any
    const agent = await loginAs(ADMIN.username, ADMIN.password)

    await agent.post(`/api/orders/${order.orderId}/status`).send({ status: 'cancelled' })

    expect(balanceOf(db, card.id, 'deni')).toBe(100000)
    expect(pushes.pushBalance).toHaveBeenCalledWith(session.sid, 100000, 0)
  })

  test('rejects an invalid status', async () => {
    const agent = await loginAs(ADMIN.username, ADMIN.password)

    const res = await agent.post('/api/orders/whatever/status').send({ status: 'exploded' })

    expect(res.status).toBe(400)
  })
})

describe('menu management', () => {
  test('admin can toggle availability', async () => {
    const agent = await loginAs(ADMIN.username, ADMIN.password)

    const res = await agent.patch('/api/menu/5').send({ available: true })

    expect(res.status).toBe(200)
    expect(res.body.available).toBe(1)
  })

  test('admin can create a drink', async () => {
    const agent = await loginAs(ADMIN.username, ADMIN.password)

    const res = await agent
      .post('/api/menu')
      .send({ drink_id: 9, name: 'Чај', price_deni: 5000, points_price: 30 })

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ drink_id: 9, name: 'Чај' })
  })

  test('rejects a drink name that would overflow the firmware buffer', async () => {
    const agent = await loginAs(ADMIN.username, ADMIN.password)

    const res = await agent
      .post('/api/menu')
      .send({ drink_id: 10, name: 'Ж'.repeat(40), price_deni: 100, points_price: 0 })

    // char name[48] in cms_menu_item_t; Cyrillic is 2 bytes each.
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/too long/i)
  })

  test('warns when the menu exceeds what the terminal can show', async () => {
    const agent = await loginAs(ADMIN.username, ADMIN.password)
    for (let i = 6; i <= 20; i++) {
      await agent.post('/api/menu').send({ drink_id: i, name: `П${i}`, price_deni: 100, points_price: 0 })
    }

    const res = await agent.get('/api/menu')

    expect(res.body.warning).toMatch(/16/)
    expect(res.body.items.length).toBeGreaterThan(16)
  })
})

describe('cards and players', () => {
  test('unknown taps are listed so staff can register the card', async () => {
    db.prepare(`INSERT INTO unknown_card_taps (card_uid, count) VALUES ('9C 76 5A F4', 3)`).run()
    const agent = await loginAs(ADMIN.username, ADMIN.password)

    const res = await agent.get('/api/unknown-taps')

    expect(res.body[0]).toMatchObject({ card_uid: '9C 76 5A F4', count: 3 })
  })

  test('registering a tapped card creates the player and clears the tap', async () => {
    db.prepare(`INSERT INTO unknown_card_taps (card_uid, count) VALUES ('9C 76 5A F4', 1)`).run()
    const agent = await loginAs(ADMIN.username, ADMIN.password)

    const res = await agent.post('/api/cards').send({ cardUid: '9C 76 5A F4', playerName: 'Марко' })

    expect(res.status).toBe(200)
    expect(res.body.card.card_uid).toBe('9C 76 5A F4')
    expect((await agent.get('/api/unknown-taps')).body).toHaveLength(0)
  })

  test('refuses to register a uid twice', async () => {
    makeCard('AA BB')
    const agent = await loginAs(ADMIN.username, ADMIN.password)

    const res = await agent.post('/api/cards').send({ cardUid: 'AA BB', playerName: 'Друг' })

    expect(res.status).toBe(400)
  })

  test('adjusting a balance posts to the ledger, audits it and pushes to the terminal', async () => {
    const { card } = makeCard()
    const session = openSession(db, card.id)
    const agent = await loginAs(ADMIN.username, ADMIN.password)

    const res = await agent
      .post(`/api/cards/${card.id}/adjust`)
      .send({ unit: 'deni', amount: 5000, reason: 'goodwill' })

    expect(res.status).toBe(200)
    expect(balanceOf(db, card.id, 'deni')).toBe(105000)
    expect(pushes.pushBalance).toHaveBeenCalledWith(session.sid, 105000, 0)
    const audit = db.prepare(`SELECT * FROM audit_log WHERE action = 'card.adjust'`).get() as any
    expect(audit.actor).toBe('admin')
  })

  test('refuses an adjustment that would drive the balance negative', async () => {
    const { card } = makeCard('CC DD', 'Тест', 1000)
    const agent = await loginAs(ADMIN.username, ADMIN.password)

    const res = await agent.post(`/api/cards/${card.id}/adjust`).send({ unit: 'deni', amount: -5000 })

    expect(res.status).toBe(400)
    expect(balanceOf(db, card.id, 'deni')).toBe(1000)
  })

  test('blocking a card logs the terminal out', async () => {
    const { card } = makeCard()
    const session = openSession(db, card.id)
    const agent = await loginAs(ADMIN.username, ADMIN.password)

    const res = await agent.post(`/api/cards/${card.id}/block`).send({})

    expect(res.status).toBe(200)
    expect(pushes.pushLogout).toHaveBeenCalledWith(session.sid)
    expect(db.prepare('SELECT status FROM cards WHERE id = ?').get(card.id)).toEqual({
      status: 'blocked'
    })
  })

  test('a card detail includes its ledger history', async () => {
    const { card } = makeCard()
    const agent = await loginAs(ADMIN.username, ADMIN.password)

    const res = await agent.get(`/api/cards/${card.id}`)

    expect(res.body.card.balance_deni).toBe(100000)
    expect(res.body.history.length).toBeGreaterThan(0)
  })
})

describe('tickets', () => {
  test('lists tickets', async () => {
    issueTicket(db, { amountDeni: 40000 })
    const agent = await loginAs(ADMIN.username, ADMIN.password)

    const res = await agent.get('/api/tickets')

    expect(res.body).toHaveLength(1)
    expect(res.body[0].amount_deni).toBe(40000)
  })

  test('admin can void an unredeemed ticket', async () => {
    const ticket = issueTicket(db, { amountDeni: 40000 })
    const agent = await loginAs(ADMIN.username, ADMIN.password)

    const res = await agent.post(`/api/tickets/${ticket.id}/void`).send({})

    expect(res.status).toBe(200)
    expect(db.prepare('SELECT status FROM tickets WHERE id = ?').get(ticket.id)).toEqual({
      status: 'voided'
    })
  })

  test('staff may not void a ticket', async () => {
    const ticket = issueTicket(db, { amountDeni: 100 })
    const agent = await loginAs('barman', ADMIN.password)

    expect((await agent.post(`/api/tickets/${ticket.id}/void`).send({})).status).toBe(403)
  })
})

describe('reports', () => {
  test('summarises orders, revenue and outstanding ticket liability', async () => {
    const { card } = makeCard()
    const session = openSession(db, card.id)
    placeOrder(db, { cardId: card.id, sessionId: session.sid, pay: 'cash', items: [{ drink: 1, qty: 2 }] })
    issueTicket(db, { amountDeni: 40000 }) // outstanding
    const redeemed = issueTicket(db, { amountDeni: 10000 })
    db.prepare(`UPDATE tickets SET status = 'redeemed' WHERE id = ?`).run(redeemed.id)
    const agent = await loginAs(ADMIN.username, ADMIN.password)

    const res = await agent.get('/api/reports/summary')

    expect(res.status).toBe(200)
    expect(res.body.orders.total).toBe(1)
    expect(res.body.revenue.cashDeni).toBe(16000)
    expect(res.body.tickets.outstandingDeni).toBe(40000)
    expect(res.body.topDrinks[0]).toMatchObject({ name: 'Кафе', qty: 2 })
    expect(res.body.activeSessions).toBe(1)
  })
})
