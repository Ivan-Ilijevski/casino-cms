import request from 'supertest'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { DEFAULT_CONFIG } from '../src/config.js'
import { openTestDb, type Db } from '../src/db/index.js'
import { seed } from '../src/db/seed.js'
import { createPlayerWithCard, type Card } from '../src/domain/accounts.js'
import { balanceOf, postEntry } from '../src/domain/ledger.js'
import { hashPassword } from '../src/domain/password.js'
import { setPin } from '../src/domain/pos.js'
import { openSession } from '../src/domain/sessions.js'
import { CmsEvents } from '../src/events.js'
import { createStaffApp } from '../src/http/server.js'

const PASSWORD = 'secret123'
const TERMINAL_UID = '9C 76 5A F4'
const NFC_UID = '9c:76:5a:f4'
const CART = [{ drink: 1, qty: 2 }] // 16000 deni

let db: Db
let app: ReturnType<typeof createStaffApp>
let events: CmsEvents
let pushes: { pushBalance: ReturnType<typeof vi.fn>; pushLogout: ReturnType<typeof vi.fn> }
let card: Card

beforeEach(() => {
  db = openTestDb()
  seed(db, { adminPassword: PASSWORD })
  db.prepare(
    `INSERT INTO staff_users (id, username, password_hash, role) VALUES ('u2', 'barman', ?, 'staff')`
  ).run(hashPassword(PASSWORD))

  card = createPlayerWithCard(db, { name: 'Иван Илијевски', cardUid: TERMINAL_UID }).card
  postEntry(db, { cardId: card.id, unit: 'deni', amount: 100000, kind: 'adjustment' })
  setPin(db, card.id, '1234')

  events = new CmsEvents()
  pushes = { pushBalance: vi.fn().mockReturnValue(true), pushLogout: vi.fn().mockReturnValue(true) }
  app = createStaffApp({
    db,
    config: { ...DEFAULT_CONFIG, sessionSecret: 'test-secret' },
    events,
    pushes
  })
})

async function loginAs(username: string) {
  const agent = request.agent(app)
  const res = await agent.post('/api/login').send({ username, password: PASSWORD })
  expect(res.status).toBe(200)
  return agent
}

async function makeIntent(agent: any, body: Record<string, unknown> = {}) {
  return agent.post('/api/pos/intent').send({ cardUid: NFC_UID, items: CART, pay: 'cash', ...body })
}

describe('POS access control', () => {
  test('rejects an unauthenticated intent', async () => {
    expect((await request(app).post('/api/pos/intent').send({})).status).toBe(401)
  })

  test('rejects an unauthenticated confirm', async () => {
    expect((await request(app).post('/api/pos/confirm').send({})).status).toBe(401)
  })

  test('ordinary staff may take POS payments — they run the bar', async () => {
    const agent = await loginAs('barman')

    expect((await makeIntent(agent)).status).toBe(200)
  })
})

describe('POST /api/pos/intent', () => {
  test('quotes the cart for a tapped card', async () => {
    const agent = await loginAs('barman')

    const res = await makeIntent(agent)

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      ok: true,
      totalDeni: 16000,
      player: { name: 'Иван Илијевски', balance: 100000 }
    })
    expect(typeof res.body.pinRequired).toBe('boolean')
  })

  test('charges nothing at quote time', async () => {
    const agent = await loginAs('barman')

    await makeIntent(agent)

    expect(balanceOf(db, card.id, 'deni')).toBe(100000)
  })

  test('refuses an unknown card', async () => {
    const agent = await loginAs('barman')

    const res = await makeIntent(agent, { cardUid: 'AA BB CC DD' })

    expect(res.status).toBe(400)
    expect(res.body.code).toBe('unknown_card')
  })

  test('refuses a card with no PIN and says so', async () => {
    const other = createPlayerWithCard(db, { name: 'Без пин', cardUid: '11 22 33 44' }).card
    postEntry(db, { cardId: other.id, unit: 'deni', amount: 100000, kind: 'adjustment' })
    const agent = await loginAs('barman')

    const res = await makeIntent(agent, { cardUid: '11:22:33:44' })

    expect(res.status).toBe(400)
    expect(res.body.code).toBe('no_pin_set')
  })

  test('rejects a missing cardUid', async () => {
    const agent = await loginAs('barman')

    expect((await agent.post('/api/pos/confirm').send({})).status).toBe(400)
  })
})

describe('POST /api/pos/confirm', () => {
  test('charges the card and reports the new balance', async () => {
    const agent = await loginAs('barman')
    const intent = await makeIntent(agent, { forcePin: false })

    const res = await agent.post('/api/pos/confirm').send({ intentId: intent.body.intentId })

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, balanceDeni: 84000 })
    expect(balanceOf(db, card.id, 'deni')).toBe(84000)
  })

  test('the client cannot skip a required PIN by omitting it', async () => {
    const agent = await loginAs('barman')
    const intent = await makeIntent(agent, { forcePin: true })
    expect(intent.body.pinRequired).toBe(true)

    const res = await agent.post('/api/pos/confirm').send({ intentId: intent.body.intentId })

    // The server reads pin_required off the stored intent, not the request.
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('pin_required')
    expect(balanceOf(db, card.id, 'deni')).toBe(100000)
  })

  test('a client claiming pinRequired:false cannot override the server', async () => {
    const agent = await loginAs('barman')
    const intent = await makeIntent(agent, { forcePin: true })

    const res = await agent
      .post('/api/pos/confirm')
      .send({ intentId: intent.body.intentId, pinRequired: false })

    expect(res.body.code).toBe('pin_required')
    expect(balanceOf(db, card.id, 'deni')).toBe(100000)
  })

  test('refuses a wrong PIN and reports attempts left', async () => {
    const agent = await loginAs('barman')
    const intent = await makeIntent(agent, { forcePin: true })

    const res = await agent
      .post('/api/pos/confirm')
      .send({ intentId: intent.body.intentId, pin: '9999' })

    expect(res.status).toBe(400)
    expect(res.body.code).toBe('pin_wrong')
    expect(res.body.attemptsLeft).toBe(4)
    expect(balanceOf(db, card.id, 'deni')).toBe(100000)
  })

  test('accepts the right PIN', async () => {
    const agent = await loginAs('barman')
    const intent = await makeIntent(agent, { forcePin: true })

    const res = await agent
      .post('/api/pos/confirm')
      .send({ intentId: intent.body.intentId, pin: '1234' })

    expect(res.status).toBe(200)
    expect(balanceOf(db, card.id, 'deni')).toBe(84000)
  })

  test('pushes the new balance to a terminal holding that card', async () => {
    const session = openSession(db, card.id)
    const agent = await loginAs('barman')
    const intent = await makeIntent(agent, { forcePin: false })

    await agent.post('/api/pos/confirm').send({ intentId: intent.body.intentId })

    expect(pushes.pushBalance).toHaveBeenCalledWith(session.sid, 84000, 0)
  })

  test('the order appears on the live staff feed', async () => {
    const seen: string[] = []
    events.on('order.created', ({ orderId }) => seen.push(orderId))
    const agent = await loginAs('barman')
    const intent = await makeIntent(agent, { forcePin: false })

    const res = await agent.post('/api/pos/confirm').send({ intentId: intent.body.intentId })

    expect(seen).toEqual([res.body.orderId])
  })

  test('the order is tagged as a POS sale and shows in the orders list', async () => {
    const agent = await loginAs('barman')
    const intent = await makeIntent(agent, { forcePin: false })
    await agent.post('/api/pos/confirm').send({ intentId: intent.body.intentId })

    const orders = await agent.get('/api/orders')

    expect(orders.body[0]).toMatchObject({ source: 'pos', status: 'received' })
  })

  test('an intent cannot be charged twice', async () => {
    const agent = await loginAs('barman')
    const intent = await makeIntent(agent, { forcePin: false })

    await agent.post('/api/pos/confirm').send({ intentId: intent.body.intentId })
    const replay = await agent.post('/api/pos/confirm').send({ intentId: intent.body.intentId })

    expect(replay.status).toBe(400)
    expect(replay.body.code).toBe('intent_used')
    expect(balanceOf(db, card.id, 'deni')).toBe(84000)
  })

  test('the payment is audited', async () => {
    const agent = await loginAs('barman')
    const intent = await makeIntent(agent, { forcePin: false })

    await agent.post('/api/pos/confirm').send({ intentId: intent.body.intentId })

    const row = db.prepare(`SELECT * FROM audit_log WHERE action = 'pos.charge'`).get() as any
    expect(row.actor).toBe('barman')
  })
})

describe('POST /api/cards/:id/pin', () => {
  test('an admin can set a PIN', async () => {
    const agent = await loginAs('admin')

    const res = await agent.post(`/api/cards/${card.id}/pin`).send({ pin: '4321' })

    expect(res.status).toBe(200)
    const intent = await makeIntent(agent, { forcePin: true })
    const charge = await agent
      .post('/api/pos/confirm')
      .send({ intentId: intent.body.intentId, pin: '4321' })
    expect(charge.status).toBe(200)
  })

  test('ordinary staff may not set a PIN', async () => {
    const agent = await loginAs('barman')

    expect((await agent.post(`/api/cards/${card.id}/pin`).send({ pin: '4321' })).status).toBe(403)
  })

  test('rejects a PIN that is not 4 digits', async () => {
    const agent = await loginAs('admin')

    expect((await agent.post(`/api/cards/${card.id}/pin`).send({ pin: '12' })).status).toBe(400)
    expect((await agent.post(`/api/cards/${card.id}/pin`).send({ pin: 'abcd' })).status).toBe(400)
  })

  test('never writes the PIN into the audit log', async () => {
    const agent = await loginAs('admin')

    await agent.post(`/api/cards/${card.id}/pin`).send({ pin: '4321' })

    const row = db.prepare(`SELECT * FROM audit_log WHERE action = 'card.set_pin'`).get() as any
    expect(JSON.stringify(row)).not.toContain('4321')
  })

  test('setting a PIN clears a lockout', async () => {
    const agent = await loginAs('admin')
    for (let i = 0; i < 5; i++) {
      const intent = await makeIntent(agent, { forcePin: true })
      await agent.post('/api/pos/confirm').send({ intentId: intent.body.intentId, pin: '0000' })
    }
    expect((await makeIntent(agent)).body.code).toBe('pin_locked')

    await agent.post(`/api/cards/${card.id}/pin`).send({ pin: '5678' })

    expect((await makeIntent(agent)).status).toBe(200)
  })
})
