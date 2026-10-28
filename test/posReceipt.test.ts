import request from 'supertest'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { DEFAULT_CONFIG } from '../src/config.js'
import { openTestDb, type Db } from '../src/db/index.js'
import { seed } from '../src/db/seed.js'
import { hashPassword } from '../src/domain/password.js'
import { CmsEvents } from '../src/events.js'
import { createStaffApp } from '../src/http/server.js'

const PASSWORD = 'secret123'
const ITEMS = [{ name: 'Кафе', quantity: 2, price: 3.5, vatType: 'A', isDomestic: true }]

let db: Db
let app: ReturnType<typeof createStaffApp>

function buildApp(
  configOverrides: Partial<typeof DEFAULT_CONFIG> = {},
  depsOverrides: { now?: () => Date } = {}
) {
  return createStaffApp({
    db,
    config: { ...DEFAULT_CONFIG, sessionSecret: 'test-secret', ...configOverrides },
    events: new CmsEvents(),
    ...depsOverrides
  })
}

/**
 * A receipt is issued against a sale, so every printing test needs one — with lines,
 * because the receipt's lines are read from the sale. Drink 1 is the seeded Кафе.
 * Drink 0 is what a custom POS charge records, which is on no menu.
 */
function seedOrder(id: string, number: number, drinkId = 1): string {
  db.prepare(
    `INSERT INTO orders (id, number, card_id, pay_method, total_deni, total_points)
     VALUES (?, ?, 'c1', 'cash', 16000, 0)`
  ).run(id, number)
  db.prepare(
    `INSERT INTO order_items
       (order_id, drink_id, name, qty, unit_price_deni, unit_points, line_total_deni, line_total_points)
     VALUES (?, ?, ?, 2, 8000, 0, 16000, 0)`
  ).run(id, drinkId, drinkId === 0 ? 'Чипови' : 'Кафе')
  return id
}

function receiptRows() {
  return db.prepare('SELECT day, seq, order_id AS orderId, actor, rendered_at AS renderedAt FROM receipts ORDER BY id').all()
}

beforeEach(() => {
  db = openTestDb()
  seed(db, { adminPassword: PASSWORD })
  db.prepare(
    `INSERT INTO staff_users (id, username, password_hash, role) VALUES ('u2', 'barman', ?, 'staff')`
  ).run(hashPassword(PASSWORD))
  db.prepare("INSERT INTO players (id, name) VALUES ('p1', 'Иван')").run()
  db.prepare(
    "INSERT INTO cards (id, card_uid, player_id, card_uid_canon) VALUES ('c1', 'AA BB', 'p1', 'AABB')"
  ).run()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

async function loginAs(username: string) {
  const agent = request.agent(app)
  const res = await agent.post('/api/login').send({ username, password: PASSWORD })
  expect(res.status).toBe(200)
  return agent
}

/** A render API that answers with a PNG, so a test can read back the body we sent it. */
function stubRender() {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    headers: new Headers({ 'content-type': 'image/png' }),
    arrayBuffer: async () => new Uint8Array([137, 80, 78, 71]).buffer
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('POST /api/pos/receipt', () => {
  test('rejects an unauthenticated request', async () => {
    app = buildApp()
    expect((await request(app).post('/api/pos/receipt').send({ items: ITEMS })).status).toBe(401)
  })

  test("prints the sale's own lines, whatever the browser sends", async () => {
    app = buildApp({ receiptApiUrl: 'https://receipts.example', receiptApiKey: 'secret' })
    const agent = await loginAs('barman')
    const fetchMock = stubRender()
    db.prepare("UPDATE menu_items SET vat_type = 'B', is_domestic = 0 WHERE drink_id = 1").run()

    const res = await agent.post('/api/pos/receipt').send({
      items: [{ name: 'Шампањ', quantity: 9, price: 1, vatType: 'V', isDomestic: true }],
      payMethod: 'cash',
      orderId: seedOrder('o1', 1)
    })

    expect(res.status).toBe(200)
    // Name, quantity and price as the sale froze them; the VAT band from the menu.
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).items).toEqual([
      { name: 'Кафе', quantity: 2, price: 80, vatType: 'B', isDomestic: false }
    ])
  })

  test('refuses a sale whose lines are not drinks, and numbers nothing', async () => {
    app = buildApp({ receiptApiUrl: 'https://receipts.example', receiptApiKey: 'secret' })
    const agent = await loginAs('barman')
    const fetchMock = stubRender()

    // A custom charge is on no menu, so it has no VAT band to print — and guessing one
    // on a fiscal document is worse than printing nothing.
    const res = await agent
      .post('/api/pos/receipt')
      .send({ payMethod: 'cash', orderId: seedOrder('o1', 1, 0) })

    expect(res.status).toBe(409)
    expect(res.body.code).toBe('unprintable')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(receiptRows()).toEqual([])
  })

  test('fails closed when the receipt API is not configured', async () => {
    app = buildApp() // receiptApiUrl/receiptApiKey default to ''
    const agent = await loginAs('barman')

    const res = await agent
      .post('/api/pos/receipt')
      .send({ items: ITEMS, payMethod: 'cash', orderId: seedOrder('o1', 1) })

    expect(res.status).toBe(503)
  })

  test('streams back the rendered PNG on success', async () => {
    app = buildApp({ receiptApiUrl: 'https://receipts.example', receiptApiKey: 'secret' })
    const agent = await loginAs('barman')

    const png = new Uint8Array([137, 80, 78, 71])
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers({ 'content-type': 'image/png' }),
        arrayBuffer: async () => png.buffer
      })
    )

    const res = await agent
      .post('/api/pos/receipt')
      .send({ items: ITEMS, payMethod: 'cash', orderId: seedOrder('o1', 1) })

    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toMatch(/image\/png/)
    expect(Buffer.from(res.body)).toEqual(Buffer.from(png))
  })

  test('passes an upstream error status through to the client', async () => {
    app = buildApp({ receiptApiUrl: 'https://receipts.example', receiptApiKey: 'secret' })
    const agent = await loginAs('barman')

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({ error: 'Body does not describe a receipt' })
      })
    )

    const res = await agent
      .post('/api/pos/receipt')
      .send({ items: ITEMS, payMethod: 'cash', orderId: seedOrder('o1', 1) })

    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/does not describe a receipt/)
  })

  test('a денари sale reaches the render API as a card payment', async () => {
    app = buildApp({ receiptApiUrl: 'https://receipts.example', receiptApiKey: 'secret' })
    const agent = await loginAs('barman')
    const fetchMock = stubRender()

    const res = await agent
      .post('/api/pos/receipt')
      .send({ items: ITEMS, payMethod: 'cash', orderId: seedOrder('o1', 1) })

    expect(res.status).toBe(200)
    const [, init] = fetchMock.mock.calls[0]
    expect(JSON.parse(init.body).paymentMethod).toBe('НА КРЕДИТ')
  })

  test('a points sale reaches the render API as ПОЕНИ', async () => {
    app = buildApp({ receiptApiUrl: 'https://receipts.example', receiptApiKey: 'secret' })
    const agent = await loginAs('barman')
    const fetchMock = stubRender()

    const res = await agent
      .post('/api/pos/receipt')
      .send({ items: ITEMS, payMethod: 'points', orderId: seedOrder('o1', 1) })

    expect(res.status).toBe(200)
    const [, init] = fetchMock.mock.calls[0]
    expect(JSON.parse(init.body).paymentMethod).toBe('ПОЕНИ')
  })

  test('refuses to print a receipt that does not say how it was paid', async () => {
    app = buildApp({ receiptApiUrl: 'https://receipts.example', receiptApiKey: 'secret' })
    const agent = await loginAs('barman')
    const fetchMock = stubRender()

    const res = await agent
      .post('/api/pos/receipt')
      .send({ items: ITEMS, orderId: seedOrder('o1', 1) })

    // Fail closed. No paper is a failure the barman can see and retry; a receipt whose
    // tender line the render API filled in from its own cash preset is not.
    expect(res.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('refuses a tender line chosen by the browser', async () => {
    app = buildApp({ receiptApiUrl: 'https://receipts.example', receiptApiKey: 'secret' })
    const agent = await loginAs('barman')
    const fetchMock = stubRender()

    const orderId = seedOrder('o1', 1)
    const bodies = [
      // The old free-form key, which used to be printed verbatim.
      { items: ITEMS, paymentMethod: 'ВО ГОТОВО', orderId },
      // A printed string smuggled into the semantic slot.
      { items: ITEMS, payMethod: 'ВО ГОТОВО', orderId },
      // `'constructor' in labels` is true, so an `in` check here would let the browser
      // pick a value whose label JSON.stringify drops — the original bug, reopened.
      { items: ITEMS, payMethod: 'constructor', orderId }
    ]

    for (const body of bodies) {
      const res = await agent.post('/api/pos/receipt').send(body)
      expect(res.status).toBe(400)
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('refuses to print a receipt that names no sale', async () => {
    app = buildApp({ receiptApiUrl: 'https://receipts.example', receiptApiKey: 'secret' })
    const agent = await loginAs('barman')
    const fetchMock = stubRender()

    // The number is recorded against a sale, so there has to be one. A pos credit has
    // no order and therefore can never be printed — a client convention until now.
    const res = await agent.post('/api/pos/receipt').send({ items: ITEMS, payMethod: 'cash' })

    expect(res.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('404s for a sale that does not exist, and numbers nothing', async () => {
    app = buildApp({ receiptApiUrl: 'https://receipts.example', receiptApiKey: 'secret' })
    const agent = await loginAs('barman')
    const fetchMock = stubRender()

    const res = await agent
      .post('/api/pos/receipt')
      .send({ items: ITEMS, payMethod: 'cash', orderId: 'nope' })

    expect(res.status).toBe(404)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(receiptRows()).toEqual([])
  })

  test('numbers the sales of a day 0001, 0002, and says so in a header', async () => {
    app = buildApp({ receiptApiUrl: 'https://receipts.example', receiptApiKey: 'secret' })
    const agent = await loginAs('barman')
    const fetchMock = stubRender()

    const first = await agent
      .post('/api/pos/receipt')
      .send({ items: ITEMS, payMethod: 'cash', orderId: seedOrder('o1', 1) })
    const second = await agent
      .post('/api/pos/receipt')
      .send({ items: ITEMS, payMethod: 'cash', orderId: seedOrder('o2', 2) })

    expect(JSON.parse(fetchMock.mock.calls[0][1].body).receiptNumber).toBe('0001')
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).receiptNumber).toBe('0002')
    expect(first.headers['x-receipt-number']).toBe('0001')
    expect(second.headers['x-receipt-number']).toBe('0002')
  })

  test('a reprint of one sale prints the same number and takes no new one', async () => {
    app = buildApp({ receiptApiUrl: 'https://receipts.example', receiptApiKey: 'secret' })
    const agent = await loginAs('barman')
    const fetchMock = stubRender()
    const orderId = seedOrder('o1', 1)

    const first = await agent.post('/api/pos/receipt').send({ payMethod: 'cash', orderId })
    const again = await agent.post('/api/pos/receipt').send({ payMethod: 'cash', orderId })

    expect(again.headers['x-receipt-number']).toBe('0001')
    expect(again.headers['x-receipt-id']).toBe(first.headers['x-receipt-id'])
    expect(receiptRows()).toHaveLength(1)
    // The stored document comes back; a second render could stamp a different time.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(Buffer.from(again.body)).toEqual(Buffer.from(first.body))
  })

  test('the counter restarts at 0001 when the local day rolls over', async () => {
    const stubbed = stubRender()
    // 21:30Z is 23:30 in Skopje — still the 7th.
    app = buildApp(
      { receiptApiUrl: 'https://receipts.example', receiptApiKey: 'secret' },
      { now: () => new Date('2026-07-07T21:30:00Z') }
    )
    let agent = await loginAs('barman')
    const tonight = await agent
      .post('/api/pos/receipt')
      .send({ items: ITEMS, payMethod: 'cash', orderId: seedOrder('o1', 1) })

    // 22:30Z is 00:30 — the next fiscal day, an hour before UTC would agree.
    app = buildApp(
      { receiptApiUrl: 'https://receipts.example', receiptApiKey: 'secret' },
      { now: () => new Date('2026-07-07T22:30:00Z') }
    )
    agent = await loginAs('barman')
    const afterMidnight = await agent
      .post('/api/pos/receipt')
      .send({ items: ITEMS, payMethod: 'cash', orderId: seedOrder('o2', 2) })

    expect(tonight.headers['x-receipt-number']).toBe('0001')
    expect(afterMidnight.headers['x-receipt-number']).toBe('0001')
    expect(receiptRows().map((r) => (r as { day: string }).day)).toEqual(['2026-07-07', '2026-07-08'])
    expect(stubbed).toHaveBeenCalledTimes(2)
  })

  test('records who printed it and that it reached paper', async () => {
    app = buildApp(
      { receiptApiUrl: 'https://receipts.example', receiptApiKey: 'secret' },
      { now: () => new Date('2026-07-07T12:00:00Z') }
    )
    const agent = await loginAs('barman')
    stubRender()

    await agent
      .post('/api/pos/receipt')
      .send({ items: ITEMS, payMethod: 'cash', orderId: seedOrder('o1', 1) })

    const [row] = receiptRows() as Array<{ day: string; seq: number; orderId: string; actor: string; renderedAt: string | null }>
    expect(row!.actor).toBe('barman')
    expect(row!.orderId).toBe('o1')
    expect(row!.renderedAt).not.toBeNull()
  })

  test('keeps the rendered image and its lines, and names the row in a header', async () => {
    app = buildApp({ receiptApiUrl: 'https://receipts.example', receiptApiKey: 'secret' })
    const agent = await loginAs('barman')
    stubRender()

    const res = await agent.post('/api/pos/receipt').send({ payMethod: 'cash', orderId: seedOrder('o1', 1) })

    const stored = db.prepare('SELECT id, items, png FROM receipts').get() as {
      id: number
      items: string
      png: Buffer
    }
    expect(res.headers['x-receipt-id']).toBe(String(stored.id))
    expect(Buffer.from(stored.png)).toEqual(Buffer.from([137, 80, 78, 71]))
    expect(JSON.parse(stored.items)).toEqual([
      { name: 'Кафе', quantity: 2, price: 80, vatType: 'A', isDomestic: true }
    ])
  })

  test('an upstream failure gives the number back, so the sequence stays dense', async () => {
    app = buildApp({ receiptApiUrl: 'https://receipts.example', receiptApiKey: 'secret' })
    const agent = await loginAs('barman')
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 400, json: async () => ({ error: 'nope' }) })
    )

    const failed = await agent
      .post('/api/pos/receipt')
      .send({ items: ITEMS, payMethod: 'cash', orderId: seedOrder('o1', 1) })
    expect(failed.status).toBe(400)
    expect(receiptRows()).toEqual([])

    // The next sale takes 0001 rather than leaving a hole where nothing printed.
    const fetchMock = stubRender()
    await agent
      .post('/api/pos/receipt')
      .send({ items: ITEMS, payMethod: 'cash', orderId: seedOrder('o2', 2) })

    expect(JSON.parse(fetchMock.mock.calls[0][1].body).receiptNumber).toBe('0001')
  })

  test('a dead network answers instead of hanging, and gives the number back', async () => {
    app = buildApp({ receiptApiUrl: 'https://receipts.example', receiptApiKey: 'secret' })
    const agent = await loginAs('barman')
    // fetch rejects rather than resolving !ok. Before this path was handled the promise
    // was unhandled and the request hung until the client gave up.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))

    const res = await agent
      .post('/api/pos/receipt')
      .send({ items: ITEMS, payMethod: 'cash', orderId: seedOrder('o1', 1) })

    expect(res.status).toBe(502)
    expect(receiptRows()).toEqual([])
  })
})
