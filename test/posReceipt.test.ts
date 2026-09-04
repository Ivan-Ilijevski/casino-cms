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

function buildApp(configOverrides: Partial<typeof DEFAULT_CONFIG> = {}) {
  return createStaffApp({
    db,
    config: { ...DEFAULT_CONFIG, sessionSecret: 'test-secret', ...configOverrides },
    events: new CmsEvents()
  })
}

beforeEach(() => {
  db = openTestDb()
  seed(db, { adminPassword: PASSWORD })
  db.prepare(
    `INSERT INTO staff_users (id, username, password_hash, role) VALUES ('u2', 'barman', ?, 'staff')`
  ).run(hashPassword(PASSWORD))
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

describe('POST /api/pos/receipt', () => {
  test('rejects an unauthenticated request', async () => {
    app = buildApp()
    expect((await request(app).post('/api/pos/receipt').send({ items: ITEMS })).status).toBe(401)
  })

  test('rejects a request with no items', async () => {
    app = buildApp()
    const agent = await loginAs('barman')

    const res = await agent.post('/api/pos/receipt').send({ items: [] })

    expect(res.status).toBe(400)
  })

  test('fails closed when the receipt API is not configured', async () => {
    app = buildApp() // receiptApiUrl/receiptApiKey default to ''
    const agent = await loginAs('barman')

    const res = await agent.post('/api/pos/receipt').send({ items: ITEMS })

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

    const res = await agent.post('/api/pos/receipt').send({ items: ITEMS })

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

    const res = await agent.post('/api/pos/receipt').send({ items: ITEMS })

    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/does not describe a receipt/)
  })
})
