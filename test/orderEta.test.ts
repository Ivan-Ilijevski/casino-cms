import request from 'supertest'
import { beforeEach, describe, expect, test } from 'vitest'
import { DEFAULT_CONFIG } from '../src/config.js'
import { openTestDb, type Db } from '../src/db/index.js'
import { seed } from '../src/db/seed.js'
import { createPlayerWithCard } from '../src/domain/accounts.js'
import { postEntry } from '../src/domain/ledger.js'
import { placeOrder } from '../src/domain/orders.js'
import { hashPassword } from '../src/domain/password.js'
import { CmsEvents } from '../src/events.js'
import { createStaffApp } from '../src/http/server.js'

let db: Db
let app: ReturnType<typeof createStaffApp>

const PASSWORD = 'secret123'

beforeEach(() => {
  db = openTestDb()
  seed(db, { adminPassword: PASSWORD })
  db.prepare(
    `INSERT INTO staff_users (id, username, password_hash, role) VALUES ('u3', 'sank', ?, 'bar')`
  ).run(hashPassword(PASSWORD))
  app = createStaffApp({
    db,
    config: { ...DEFAULT_CONFIG, sessionSecret: 'test-secret' },
    events: new CmsEvents()
  })
})

async function loginAs(username: string) {
  const agent = request.agent(app)
  const res = await agent.post('/api/login').send({ username, password: PASSWORD })
  expect(res.status).toBe(200)
  return agent
}

function makeOrder(uid = 'AA BB'): string {
  const { card } = createPlayerWithCard(db, { name: 'Иван Илијевски', cardUid: uid })
  postEntry(db, { cardId: card.id, unit: 'deni', amount: 100000, kind: 'adjustment' })
  const placed = placeOrder(db, { cardId: card.id, pay: 'cash', items: [{ drink: 1, qty: 1 }] })
  if (!placed.ok) throw new Error(`could not place the fixture order: ${placed.code}`)
  return placed.orderId
}

/** SQLite hands back "YYYY-MM-DD HH:MM:SS" in UTC. */
function minutesFromNow(sqliteStamp: string): number {
  const then = new Date(sqliteStamp.replace(' ', 'T') + 'Z').getTime()
  return (then - Date.now()) / 60000
}

describe('promising a time when accepting', () => {
  test('sets promised_at the requested number of minutes ahead', async () => {
    const orderId = makeOrder()
    const agent = await loginAs('sank')

    const res = await agent
      .post(`/api/orders/${orderId}/status`)
      .send({ status: 'accepted', eta_minutes: 15 })

    expect(res.status).toBe(200)
    expect(res.body.order.status).toBe('accepted')
    // Server-side clock, so this is tight regardless of the caller's clock.
    expect(minutesFromNow(res.body.order.promised_at)).toBeGreaterThan(14)
    expect(minutesFromNow(res.body.order.promised_at)).toBeLessThan(16)
  })

  test('the promise comes back on the order list', async () => {
    const orderId = makeOrder()
    const agent = await loginAs('sank')
    await agent.post(`/api/orders/${orderId}/status`).send({ status: 'accepted', eta_minutes: 10 })

    const res = await agent.get('/api/orders?status=accepted')

    expect(res.body).toHaveLength(1)
    expect(res.body[0].promised_at).toBeTruthy()
  })

  test('accepting without an estimate leaves no promise', async () => {
    const orderId = makeOrder()
    const agent = await loginAs('sank')

    const res = await agent.post(`/api/orders/${orderId}/status`).send({ status: 'accepted' })

    expect(res.status).toBe(200)
    // The board has to render these — every order accepted before this shipped
    // is one, and so is any accepted from a client that sends no estimate.
    expect(res.body.order.promised_at).toBeNull()
  })

  test('records the estimate in the audit trail', async () => {
    const orderId = makeOrder()
    const agent = await loginAs('sank')

    await agent.post(`/api/orders/${orderId}/status`).send({ status: 'accepted', eta_minutes: 20 })

    const row = db.prepare(`SELECT * FROM audit_log WHERE action = 'order.accepted'`).get() as {
      actor: string
      details: string
    }
    expect(row).toMatchObject({ actor: 'sank' })
    expect(JSON.parse(row.details)).toMatchObject({ etaMinutes: 20 })
  })
})

describe('rejecting a bad estimate', () => {
  for (const [label, value] of [
    ['zero', 0],
    ['negative', -5],
    ['over four hours', 241],
    ['fractional', 12.5],
    ['not a number', 'soon']
  ] as Array<[string, unknown]>) {
    test(`${label} is a 400`, async () => {
      const orderId = makeOrder()
      const agent = await loginAs('sank')

      const res = await agent
        .post(`/api/orders/${orderId}/status`)
        .send({ status: 'accepted', eta_minutes: value })

      expect(res.status).toBe(400)
      expect(res.body.error).toMatch(/eta_minutes/)
    })
  }

  test('a rejected estimate does not move the order', async () => {
    const orderId = makeOrder()
    const agent = await loginAs('sank')

    await agent.post(`/api/orders/${orderId}/status`).send({ status: 'accepted', eta_minutes: 0 })

    const res = await agent.get('/api/orders?status=received')
    expect(res.body).toHaveLength(1)
  })
})

describe('an estimate on any other transition', () => {
  test('is ignored rather than rejected when fulfilling', async () => {
    const orderId = makeOrder()
    const agent = await loginAs('sank')

    const res = await agent
      .post(`/api/orders/${orderId}/status`)
      .send({ status: 'fulfilled', eta_minutes: 15 })

    expect(res.status).toBe(200)
    expect(res.body.order.status).toBe('fulfilled')
    expect(res.body.order.promised_at).toBeNull()
  })

  test('does not overwrite a promise already made', async () => {
    const orderId = makeOrder()
    const agent = await loginAs('sank')
    await agent.post(`/api/orders/${orderId}/status`).send({ status: 'accepted', eta_minutes: 30 })

    const res = await agent
      .post(`/api/orders/${orderId}/status`)
      .send({ status: 'fulfilled', eta_minutes: 1 })

    expect(minutesFromNow(res.body.order.promised_at)).toBeGreaterThan(29)
  })
})

describe('the bar tablet drives the whole flow', () => {
  test('received to accepted with a promise, then fulfilled', async () => {
    const orderId = makeOrder()
    const agent = await loginAs('sank')

    const accepted = await agent
      .post(`/api/orders/${orderId}/status`)
      .send({ status: 'accepted', eta_minutes: 5 })
    const done = await agent.post(`/api/orders/${orderId}/status`).send({ status: 'fulfilled' })

    expect(accepted.status).toBe(200)
    expect(done.status).toBe(200)
    expect(done.body.order.fulfilled_by).toBe('sank')
    expect(done.body.order.fulfilled_at).toBeTruthy()
  })

  test('can cancel a promised order, and the guest gets the money back', async () => {
    const orderId = makeOrder()
    const agent = await loginAs('sank')
    await agent.post(`/api/orders/${orderId}/status`).send({ status: 'accepted', eta_minutes: 5 })

    const res = await agent.post(`/api/orders/${orderId}/status`).send({ status: 'cancelled' })

    expect(res.status).toBe(200)
    expect(res.body.refunded).toBe(true)
  })
})
