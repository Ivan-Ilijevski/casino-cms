import request from 'supertest'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { DEFAULT_CONFIG } from '../src/config.js'
import { openTestDb, type Db } from '../src/db/index.js'
import { seed } from '../src/db/seed.js'
import { createPlayerWithCard, findCardByUid } from '../src/domain/accounts.js'
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

  test('a new drink defaults to standard-rate domestic when VAT fields are omitted', async () => {
    const agent = await loginAs(ADMIN.username, ADMIN.password)

    const res = await agent
      .post('/api/menu')
      .send({ drink_id: 9, name: 'Чај', price_deni: 5000, points_price: 30 })

    expect(res.body).toMatchObject({ vat_type: 'A', is_domestic: 1 })
  })

  test('a new drink can be given a specific VAT band and imported flag', async () => {
    const agent = await loginAs(ADMIN.username, ADMIN.password)

    const res = await agent
      .post('/api/menu')
      .send({ drink_id: 9, name: 'Виски', price_deni: 25000, points_price: 0, vat_type: 'B', is_domestic: false })

    expect(res.body).toMatchObject({ vat_type: 'B', is_domestic: 0 })
  })

  test('rejects a VAT band outside the four fiscal bands', async () => {
    const agent = await loginAs(ADMIN.username, ADMIN.password)

    const res = await agent
      .post('/api/menu')
      .send({ drink_id: 9, name: 'Чај', price_deni: 5000, points_price: 30, vat_type: 'X' })

    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/vat_type/i)
  })

  test('admin can change a drink\'s VAT band and domestic flag', async () => {
    const agent = await loginAs(ADMIN.username, ADMIN.password)

    const res = await agent.patch('/api/menu/1').send({ vat_type: 'V', is_domestic: false })

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ vat_type: 'V', is_domestic: 0 })
  })
})

describe('menu stock', () => {
  const stockOf = (drinkId: number) =>
    (db.prepare('SELECT stock_qty AS s FROM menu_items WHERE drink_id = ?').get(drinkId) as {
      s: number | null
    }).s

  test('seeded drinks start untracked', async () => {
    const agent = await loginAs(ADMIN.username, ADMIN.password)

    const res = await agent.get('/api/menu')

    expect(res.body.items.every((i: { stock_qty: null }) => i.stock_qty === null)).toBe(true)
  })

  test('admin can start tracking a drink and stop again', async () => {
    const agent = await loginAs(ADMIN.username, ADMIN.password)

    expect((await agent.patch('/api/menu/1').send({ stock_qty: 12 })).body.stock_qty).toBe(12)
    // An explicit null is the only way back to untracked, and COALESCE could
    // not express it — this is the case that regression-proofs the CASE WHEN.
    expect((await agent.patch('/api/menu/1').send({ stock_qty: null })).body.stock_qty).toBeNull()
  })

  test('a patch that does not mention stock leaves it alone', async () => {
    const agent = await loginAs(ADMIN.username, ADMIN.password)
    await agent.patch('/api/menu/1').send({ stock_qty: 7 })

    await agent.patch('/api/menu/1').send({ name: 'Еспресо' })

    expect(stockOf(1)).toBe(7)
  })

  test('rejects a negative stock', async () => {
    const agent = await loginAs(ADMIN.username, ADMIN.password)

    const res = await agent.patch('/api/menu/1').send({ stock_qty: -1 })

    expect(res.status).toBe(400)
  })

  test('non-admin staff may restock — the whole point of the endpoint', async () => {
    const admin = await loginAs(ADMIN.username, ADMIN.password)
    await admin.patch('/api/menu/1').send({ stock_qty: 3 })
    const barman = await loginAs('barman', ADMIN.password)

    const res = await barman.post('/api/menu/1/stock').send({ delta: 12 })

    expect(res.status).toBe(200)
    expect(res.body.stock_qty).toBe(15)
  })

  test('restocking is audited, which is what makes it safe to open up', async () => {
    const admin = await loginAs(ADMIN.username, ADMIN.password)
    await admin.patch('/api/menu/1').send({ stock_qty: 3 })
    const barman = await loginAs('barman', ADMIN.password)

    await barman.post('/api/menu/1/stock').send({ delta: -1 })

    const row = db.prepare(`SELECT * FROM audit_log WHERE action = 'menu.stock'`).get() as any
    expect(row).toMatchObject({ actor: 'barman', entity_id: '1' })
    expect(JSON.parse(row.details)).toMatchObject({ delta: -1, from: 3, to: 2 })
  })

  test('never goes below zero', async () => {
    const agent = await loginAs(ADMIN.username, ADMIN.password)
    await agent.patch('/api/menu/1').send({ stock_qty: 1 })

    const res = await agent.post('/api/menu/1/stock').send({ delta: -5 })

    expect(res.body.stock_qty).toBe(0)
  })

  test('refuses to adjust a drink that is not stock-tracked', async () => {
    const agent = await loginAs(ADMIN.username, ADMIN.password)

    const res = await agent.post('/api/menu/1/stock').send({ delta: 1 })

    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/not stock-tracked/)
  })

  test('rejects a non-integer or zero delta', async () => {
    const agent = await loginAs(ADMIN.username, ADMIN.password)
    await agent.patch('/api/menu/1').send({ stock_qty: 5 })

    expect((await agent.post('/api/menu/1/stock').send({ delta: 0 })).status).toBe(400)
    expect((await agent.post('/api/menu/1/stock').send({ delta: 1.5 })).status).toBe(400)
    expect(stockOf(1)).toBe(5)
  })

  test('404s on an unknown drink', async () => {
    const agent = await loginAs(ADMIN.username, ADMIN.password)

    expect((await agent.post('/api/menu/99/stock').send({ delta: 1 })).status).toBe(404)
  })

  test('creating a drink with a stock count tracks it from the start', async () => {
    const agent = await loginAs(ADMIN.username, ADMIN.password)

    const res = await agent
      .post('/api/menu')
      .send({ drink_id: 11, name: 'Џин', price_deni: 20000, points_price: 0, stock_qty: 6 })

    expect(res.body.stock_qty).toBe(6)
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

  test('a second card for an existing guest records the canonical uid', async () => {
    // The branch this covers used to insert its own row and forget the canon,
    // which left the card unauthenticatable at every reader.
    const { player } = makeCard('AA BB')
    const agent = await loginAs(ADMIN.username, ADMIN.password)

    const res = await agent.post('/api/cards').send({ cardUid: '9c:76:5a:f4', playerId: player.id })

    expect(res.status).toBe(200)
    const row = db.prepare('SELECT card_uid_canon AS c FROM cards WHERE id = ?').get(res.body.card.id)
    expect(row).toEqual({ c: '9C765AF4' })
  })

  test('a second card is found by the OTHER reader’s spelling — the point of canon', async () => {
    const { player } = makeCard('AA BB')
    const agent = await loginAs(ADMIN.username, ADMIN.password)
    await agent.post('/api/cards').send({ cardUid: '9c:76:5a:f4', playerId: player.id })

    // Registered from Web NFC, looked up as the RC522 terminal reports it.
    expect(findCardByUid(db, '9C 76 5A F4')).toBeDefined()
  })

  test('the same physical card cannot be registered twice in two spellings', async () => {
    const { player } = makeCard('AA BB')
    const agent = await loginAs(ADMIN.username, ADMIN.password)
    await agent.post('/api/cards').send({ cardUid: '9C 76 5A F4', playerId: player.id })

    const res = await agent.post('/api/cards').send({ cardUid: '9c:76:5a:f4', playerId: player.id })

    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/already registered/)
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
