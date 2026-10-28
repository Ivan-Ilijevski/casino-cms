import request from 'supertest'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { DEFAULT_CONFIG } from '../src/config.js'
import { openTestDb, type Db } from '../src/db/index.js'
import { seed } from '../src/db/seed.js'
import { hashPassword } from '../src/domain/password.js'
import { CmsEvents } from '../src/events.js'
import { createStaffApp } from '../src/http/server.js'

const PASSWORD = 'secret123'
const PNG = new Uint8Array([137, 80, 78, 71])
// 12:00Z is 14:00 in Skopje: comfortably inside the business day 2026-07-07.
const NOW = new Date('2026-07-07T12:00:00Z')

let db: Db
let app: ReturnType<typeof createStaffApp>

beforeEach(() => {
  db = openTestDb()
  seed(db, { adminPassword: PASSWORD })
  for (const [id, username, role] of [
    ['u2', 'barman', 'staff'],
    ['u3', 'sank', 'bar']
  ] as const) {
    db.prepare('INSERT INTO staff_users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(
      id,
      username,
      hashPassword(PASSWORD),
      role
    )
  }
  db.prepare("INSERT INTO players (id, name) VALUES ('p1', 'Иван')").run()
  db.prepare(
    "INSERT INTO cards (id, card_uid, player_id, card_uid_canon) VALUES ('c1', 'AA BB', 'p1', 'AABB')"
  ).run()
  app = createStaffApp({
    db,
    config: {
      ...DEFAULT_CONFIG,
      sessionSecret: 'test-secret',
      receiptApiUrl: 'https://receipts.example',
      receiptApiKey: 'secret'
    },
    events: new CmsEvents(),
    now: () => NOW
  })
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

function stubRender() {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    headers: new Headers({ 'content-type': 'image/png' }),
    arrayBuffer: async () => PNG.buffer
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function seedOrder(id: string, number: number): string {
  db.prepare(
    `INSERT INTO orders (id, number, card_id, pay_method, total_deni, total_points)
     VALUES (?, ?, 'c1', 'cash', 16000, 0)`
  ).run(id, number)
  db.prepare(
    `INSERT INTO order_items
       (order_id, drink_id, name, qty, unit_price_deni, unit_points, line_total_deni, line_total_points)
     VALUES (?, 1, 'Кафе', 2, 8000, 0, 16000, 0)`
  ).run(id)
  return id
}

/** A sale printed the way Каса prints it: through /pos/receipt. Returns the receipt id. */
async function issueReceipt(agent: request.Agent, orderId: string): Promise<number> {
  const res = await agent.post('/api/pos/receipt').send({ payMethod: 'cash', orderId })
  expect(res.status).toBe(200)
  return Number(res.headers['x-receipt-id'])
}

/** One whole print attempt, as the tablet reports it. */
async function print(
  agent: request.Agent,
  receiptId: number,
  outcome: { status: string; percent?: number; error?: string }
) {
  const started = await agent.post(`/api/receipts/${receiptId}/prints`).send({ device: 'X5h' })
  expect(started.status).toBe(200)
  const finished = await agent.post(`/api/receipts/prints/${started.body.printId}`).send(outcome)
  expect(finished.status).toBe(200)
  return started.body as { printId: number; copy: boolean }
}

function reprintAudits() {
  return db.prepare("SELECT actor, entity_id AS entityId, details FROM audit_log WHERE action = 'receipt.reprint'").all() as Array<{
    actor: string
    entityId: string
    details: string
  }>
}

describe('who may see receipts', () => {
  test('the bar tablet may not read history, print, or log', async () => {
    const agent = await loginAs('sank')

    expect((await agent.get('/api/receipts')).status).toBe(403)
    expect((await agent.get('/api/receipts/1')).status).toBe(403)
    expect((await agent.get('/api/receipts/1/image')).status).toBe(403)
    expect((await agent.post('/api/receipts/1/prints').send({})).status).toBe(403)
    expect((await agent.post('/api/receipts/prints/1').send({ status: 'sent' })).status).toBe(403)
  })

  test('staff who run Каса can', async () => {
    const agent = await loginAs('barman')
    expect((await agent.get('/api/receipts')).status).toBe(200)
  })
})

describe('copies', () => {
  test('the first print of a receipt is the original', async () => {
    const agent = await loginAs('barman')
    stubRender()
    const id = await issueReceipt(agent, seedOrder('o1', 1))

    expect((await print(agent, id, { status: 'sent', percent: 100 })).copy).toBe(false)
    expect(reprintAudits()).toEqual([])
  })

  test('a print after one went through is a КОПИЈА, and says who asked for it', async () => {
    const agent = await loginAs('barman')
    stubRender()
    const id = await issueReceipt(agent, seedOrder('o1', 1))
    await print(agent, id, { status: 'sent', percent: 100 })

    const again = await print(agent, id, { status: 'sent', percent: 100 })

    expect(again.copy).toBe(true)
    const [entry] = reprintAudits()
    expect(entry!.actor).toBe('barman')
    expect(entry!.entityId).toBe(String(id))
    expect(JSON.parse(entry!.details)).toMatchObject({ number: '0001', day: '2026-07-07', orderId: 'o1' })
  })

  test('a retry after an interrupted print is still the original', async () => {
    const agent = await loginAs('barman')
    stubRender()
    const id = await issueReceipt(agent, seedOrder('o1', 1))
    // The printer dropped at 40%: the guest has half a receipt, not an original.
    await print(agent, id, { status: 'interrupted', percent: 40, error: 'link lost' })
    await print(agent, id, { status: 'failed', percent: 0 })

    expect((await print(agent, id, { status: 'sent', percent: 100 })).copy).toBe(false)
    expect(reprintAudits()).toEqual([])
  })

  test('a print that never reported back does not make the next one a copy', async () => {
    const agent = await loginAs('barman')
    stubRender()
    const id = await issueReceipt(agent, seedOrder('o1', 1))
    // The tablet died mid-print: the attempt stays 'sending' forever.
    await agent.post(`/api/receipts/${id}/prints`).send({})

    const next = await agent.post(`/api/receipts/${id}/prints`).send({})
    expect(next.body.copy).toBe(false)
  })

  test('an unknown receipt cannot be printed', async () => {
    const agent = await loginAs('barman')
    expect((await agent.post('/api/receipts/999/prints').send({})).status).toBe(404)
    expect((await agent.post('/api/receipts/abc/prints').send({})).status).toBe(404)
  })
})

describe('the print log', () => {
  test('records each attempt with who, which printer, how far and why', async () => {
    const agent = await loginAs('barman')
    stubRender()
    const id = await issueReceipt(agent, seedOrder('o1', 1))
    await print(agent, id, { status: 'interrupted', percent: 62, error: 'Врската со печатачот се прекина.' })
    await print(agent, id, { status: 'sent', percent: 100 })

    const res = await agent.get(`/api/receipts/${id}`)

    expect(res.status).toBe(200)
    expect(res.body.prints).toHaveLength(2)
    // Newest first.
    expect(res.body.prints[0]).toMatchObject({ status: 'sent', percent: 100, copy: false, actor: 'barman', device: 'X5h' })
    expect(res.body.prints[1]).toMatchObject({
      status: 'interrupted',
      percent: 62,
      error: 'Врската со печатачот се прекина.'
    })
    expect(res.body.items).toEqual([{ name: 'Кафе', quantity: 2, price: 80, vatType: 'A', isDomestic: true }])
    expect(res.body.receipt).toMatchObject({ number: '0001', orderNumber: 1, printed: true, attempts: 2, copies: 0 })
  })

  test('the first outcome reported is the one that stands', async () => {
    const agent = await loginAs('barman')
    stubRender()
    const id = await issueReceipt(agent, seedOrder('o1', 1))
    const { printId } = await print(agent, id, { status: 'sent', percent: 100 })

    const late = await agent.post(`/api/receipts/prints/${printId}`).send({ status: 'interrupted', percent: 10 })

    expect(late.status).toBe(409)
    const detail = await agent.get(`/api/receipts/${id}`)
    expect(detail.body.prints[0]).toMatchObject({ status: 'sent', percent: 100 })
  })

  test('refuses an outcome it does not know, or a percent that is not one', async () => {
    const agent = await loginAs('barman')
    stubRender()
    const id = await issueReceipt(agent, seedOrder('o1', 1))
    const started = await agent.post(`/api/receipts/${id}/prints`).send({})
    const url = `/api/receipts/prints/${started.body.printId}`

    expect((await agent.post(url).send({ status: 'sending' })).status).toBe(400)
    expect((await agent.post(url).send({ status: 'printed' })).status).toBe(400)
    expect((await agent.post(url).send({ status: 'sent', percent: 140 })).status).toBe(400)
    expect((await agent.post(url).send({ status: 'sent', percent: 'all' })).status).toBe(400)
    expect((await agent.post('/api/receipts/prints/999').send({ status: 'sent' })).status).toBe(404)
  })
})

describe('the day list', () => {
  test("lists today's receipts newest first, and can narrow to the unprinted", async () => {
    const agent = await loginAs('barman')
    stubRender()
    const printed = await issueReceipt(agent, seedOrder('o1', 1))
    const cutOff = await issueReceipt(agent, seedOrder('o2', 2))
    await issueReceipt(agent, seedOrder('o3', 3))
    await print(agent, printed, { status: 'sent', percent: 100 })
    await print(agent, cutOff, { status: 'interrupted', percent: 30 })

    const all = await agent.get('/api/receipts')
    const unprinted = await agent.get('/api/receipts?unprinted=1')

    expect(all.body.map((r: { number: string }) => r.number)).toEqual(['0003', '0002', '0001'])
    expect(unprinted.body.map((r: { number: string }) => r.number)).toEqual(['0003', '0002'])
    expect(unprinted.body[1]).toMatchObject({ lastStatus: 'interrupted', lastPercent: 30, printed: false })
    expect(unprinted.body[0]).toMatchObject({ lastStatus: null, attempts: 0 })
  })

  test('another day is asked for by date, and a malformed one is refused', async () => {
    const agent = await loginAs('barman')

    expect((await agent.get('/api/receipts?day=2026-07-06')).body).toEqual([])
    expect((await agent.get('/api/receipts?day=yesterday')).status).toBe(400)
  })
})

describe('the image', () => {
  test('is the stored render, without calling the render API again', async () => {
    const agent = await loginAs('barman')
    const fetchMock = stubRender()
    const id = await issueReceipt(agent, seedOrder('o1', 1))

    const res = await agent.get(`/api/receipts/${id}/image`).buffer(true)

    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toMatch(/image\/png/)
    expect(Buffer.from(res.body)).toEqual(Buffer.from(PNG))
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test('a receipt from before images were stored renders once, under its own number, then keeps it', async () => {
    const agent = await loginAs('barman')
    seedOrder('o1', 1)
    const id = Number(
      db
        .prepare(
          `INSERT INTO receipts (day, seq, order_id, pay_method, total_deni, actor, time_zone, rendered_at)
           VALUES ('2026-07-01', 7, 'o1', 'cash', 16000, 'barman', 'Europe/Skopje', datetime('now'))`
        )
        .run().lastInsertRowid
    )
    const fetchMock = stubRender()

    const first = await agent.get(`/api/receipts/${id}/image`).buffer(true)
    const second = await agent.get(`/api/receipts/${id}/image`).buffer(true)

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).receiptNumber).toBe('0007')
    expect((db.prepare('SELECT png IS NOT NULL AS stored FROM receipts WHERE id = ?').get(id) as { stored: number }).stored).toBe(1)
  })

  test('a legacy receipt the render API cannot reach answers instead of hanging', async () => {
    const agent = await loginAs('barman')
    seedOrder('o1', 1)
    const id = Number(
      db
        .prepare(
          `INSERT INTO receipts (day, seq, order_id, pay_method, total_deni, actor, time_zone)
           VALUES ('2026-07-01', 1, 'o1', 'cash', 16000, 'barman', 'Europe/Skopje')`
        )
        .run().lastInsertRowid
    )
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))

    expect((await agent.get(`/api/receipts/${id}/image`)).status).toBe(502)
    expect((await agent.get('/api/receipts/999/image')).status).toBe(404)
  })
})
