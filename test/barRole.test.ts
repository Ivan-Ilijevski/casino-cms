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

function makeOrder(): string {
  const { card } = createPlayerWithCard(db, { name: 'Иван Илијевски', cardUid: 'AA BB' })
  postEntry(db, { cardId: card.id, unit: 'deni', amount: 100000, kind: 'adjustment' })
  const placed = placeOrder(db, { cardId: card.id, pay: 'cash', items: [{ drink: 1, qty: 1 }] })
  if (!placed.ok) throw new Error(`could not place the fixture order: ${placed.code}`)
  return placed.orderId
}

describe('the bar role exists', () => {
  test('the migration accepts it and login reports it', async () => {
    const agent = await loginAs('sank')

    const res = await agent.get('/api/me')

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ username: 'sank', role: 'bar' })
  })
})

describe('what the bar tablet may do', () => {
  test('reads the order list', async () => {
    const agent = await loginAs('sank')

    expect((await agent.get('/api/orders')).status).toBe(200)
  })

  test('reads a filtered order list', async () => {
    const agent = await loginAs('sank')

    expect((await agent.get('/api/orders?status=received')).status).toBe(200)
  })

  test('moves an order along', async () => {
    const orderId = makeOrder()
    const agent = await loginAs('sank')

    const res = await agent.post(`/api/orders/${orderId}/status`).send({ status: 'fulfilled' })

    expect(res.status).toBe(200)
  })

  test('reads the menu', async () => {
    const agent = await loginAs('sank')

    expect((await agent.get('/api/menu')).status).toBe(200)
  })

  test('corrects the stock count', async () => {
    db.prepare('UPDATE menu_items SET stock_qty = 5 WHERE drink_id = 1').run()
    const agent = await loginAs('sank')

    const res = await agent.post('/api/menu/1/stock').send({ delta: -1 })

    expect(res.status).toBe(200)
  })

  test('changes its own password', async () => {
    const agent = await loginAs('sank')

    const res = await agent
      .post('/api/me/password')
      .send({ current_password: PASSWORD, new_password: 'tablet-pass-2' })

    expect(res.status).toBe(200)
  })
})

describe('what the bar tablet may not do', () => {
  // Everything the tablet has no business seeing: guest PII, money, tickets,
  // reports, and the staff accounts themselves.
  const forbidden: Array<[string, string]> = [
    ['GET', '/api/customers'],
    ['GET', '/api/players'],
    ['GET', '/api/cards'],
    ['GET', '/api/unknown-taps'],
    ['GET', '/api/tickets'],
    ['GET', '/api/reports/summary'],
    ['GET', '/api/reports/audit'],
    ['GET', '/api/users'],
    ['POST', '/api/users'],
    ['POST', '/api/pos/intent'],
    ['POST', '/api/pos/confirm'],
    ['POST', '/api/pos/receipt'],
    ['POST', '/api/menu'],
    ['PATCH', '/api/menu/1'],
    ['DELETE', '/api/menu/1'],
    ['POST', '/api/tickets']
  ]

  for (const [method, path] of forbidden) {
    test(`${method} ${path} is forbidden`, async () => {
      const agent = await loginAs('sank')

      const res = await (method === 'GET'
        ? agent.get(path)
        : method === 'POST'
          ? agent.post(path).send({})
          : method === 'PATCH'
            ? agent.patch(path).send({})
            : agent.delete(path))

      expect(res.status).toBe(403)
    })
  }

  test('a route nobody thought about is denied by default', async () => {
    const agent = await loginAs('sank')

    // The allowlist is positive: a path that does not appear on it is refused
    // even though no requireRole mentions the bar role anywhere.
    expect((await agent.get('/api/customers/anything/notes')).status).toBe(403)
  })

  test('ordinary staff are untouched by the restriction', async () => {
    db.prepare(
      `INSERT INTO staff_users (id, username, password_hash, role) VALUES ('u4', 'barman', ?, 'staff')`
    ).run(hashPassword(PASSWORD))
    const agent = await loginAs('barman')

    expect((await agent.get('/api/customers')).status).toBe(200)
    expect((await agent.get('/api/reports/summary')).status).toBe(200)
  })
})
