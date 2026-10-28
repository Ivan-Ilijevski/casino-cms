import request from 'supertest'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { DEFAULT_CONFIG } from '../src/config.js'
import { openTestDb, type Db } from '../src/db/index.js'
import { seed } from '../src/db/seed.js'
import { createPlayerWithCard } from '../src/domain/accounts.js'
import { postEntry } from '../src/domain/ledger.js'
import { placeOrder } from '../src/domain/orders.js'
import { hashPassword } from '../src/domain/password.js'
import { openSession } from '../src/domain/sessions.js'
import { CmsEvents } from '../src/events.js'
import { createStaffApp } from '../src/http/server.js'
import { handleCmsMessage, type CmsContext } from '../src/wire/handlers.js'

const PASSWORD = 'secret123'

let db: Db
let app: ReturnType<typeof createStaffApp>
let pushes: {
  pushBalance: ReturnType<typeof vi.fn>
  pushLogout: ReturnType<typeof vi.fn>
  pushOrder: ReturnType<typeof vi.fn>
}
let cardId: string

beforeEach(() => {
  db = openTestDb()
  seed(db, { adminPassword: PASSWORD })
  db.prepare(
    `INSERT INTO staff_users (id, username, password_hash, role) VALUES ('u3', 'sank', ?, 'bar')`
  ).run(hashPassword(PASSWORD))

  const { card } = createPlayerWithCard(db, { name: 'Иван Илијевски', cardUid: 'AA BB' })
  postEntry(db, { cardId: card.id, unit: 'deni', amount: 1_000_000, kind: 'adjustment' })
  cardId = card.id

  pushes = {
    pushBalance: vi.fn().mockReturnValue(true),
    pushLogout: vi.fn().mockReturnValue(true),
    pushOrder: vi.fn().mockReturnValue(true)
  }
  app = createStaffApp({
    db,
    config: { ...DEFAULT_CONFIG, sessionSecret: 'test-secret' },
    events: new CmsEvents(),
    pushes
  })
})

async function loginAsBar() {
  const agent = request.agent(app)
  const res = await agent.post('/api/login').send({ username: 'sank', password: PASSWORD })
  expect(res.status).toBe(200)
  return agent
}

function makeOrder(): string {
  const res = placeOrder(db, { cardId, pay: 'cash', items: [{ drink: 1, qty: 1 }] })
  if (!res.ok) throw new Error(`fixture order rejected: ${res.code}`)
  return res.orderId
}

describe('telling the terminal its order moved', () => {
  test('accepting pushes the promised time to the session holding the card', async () => {
    const session = openSession(db, cardId)
    const orderId = makeOrder()
    const agent = await loginAsBar()

    await agent.post(`/api/orders/${orderId}/status`).send({ status: 'accepted', eta_minutes: 12 })

    expect(pushes.pushOrder).toHaveBeenCalledTimes(1)
    const [sid, payload] = pushes.pushOrder.mock.calls[0]
    expect(sid).toBe(session.sid)
    expect(payload).toMatchObject({ status: 'accepted', eta_src: 'promised' })
    expect(payload.eta_s).toBeGreaterThan(12 * 60 - 5)
    // The firmware identifies an order by its short number, never the UUID.
    expect(typeof payload.num).toBe('number')
  })

  test('fulfilling pushes too, with no countdown left to show', async () => {
    openSession(db, cardId)
    const orderId = makeOrder()
    const agent = await loginAsBar()

    await agent.post(`/api/orders/${orderId}/status`).send({ status: 'fulfilled' })

    const [, payload] = pushes.pushOrder.mock.calls[0]
    expect(payload).toMatchObject({ status: 'fulfilled' })
    expect(payload).not.toHaveProperty('eta_s')
  })

  test('a card nobody is holding is simply not pushed to, and nothing throws', async () => {
    // No openSession: the guest took their card and left. PushRegistry would
    // drop this anyway; the terminal repairs it by re-asking on its next auth.
    const orderId = makeOrder()
    const agent = await loginAsBar()

    const res = await agent.post(`/api/orders/${orderId}/status`).send({ status: 'accepted', eta_minutes: 5 })

    expect(res.status).toBe(200)
    expect(pushes.pushOrder).not.toHaveBeenCalled()
  })

  test('an order placed before this session still pushes to the new one', async () => {
    // The order is bound to a session that has since closed; what matters is
    // who is holding the card now.
    const orderId = makeOrder()
    db.prepare(`UPDATE orders SET session_id = 'an-old-session' WHERE id = ?`).run(orderId)
    const fresh = openSession(db, cardId)
    const agent = await loginAsBar()

    await agent.post(`/api/orders/${orderId}/status`).send({ status: 'accepted', eta_minutes: 3 })

    expect(pushes.pushOrder.mock.calls[0][0]).toBe(fresh.sid)
  })

  test('a staff app with no terminal link at all does not fall over', async () => {
    const lonely = createStaffApp({
      db,
      config: { ...DEFAULT_CONFIG, sessionSecret: 'test-secret' },
      events: new CmsEvents()
    })
    const orderId = makeOrder()
    const agent = request.agent(lonely)
    await agent.post('/api/login').send({ username: 'sank', password: PASSWORD })

    const res = await agent.post(`/api/orders/${orderId}/status`).send({ status: 'accepted', eta_minutes: 4 })

    expect(res.status).toBe(200)
  })
})

describe('what the terminal asks for on reconnect', () => {
  function ctxFor(): CmsContext {
    return { db, pointsPerMkd: 0, currency: 'MKD' }
  }

  test('orders_req answers with a count and one push per open order', () => {
    const session = openSession(db, cardId)
    makeOrder()
    makeOrder()

    const replies = handleCmsMessage(ctxFor(), {
      t: 'orders_req',
      id: 9,
      d: { sid: session.sid }
    })

    expect(replies[0]).toMatchObject({ t: 'orders_res', id: 9, d: { ok: true, n: 2 } })
    expect(replies.slice(1).map((r) => r.t)).toEqual(['order_push', 'order_push'])
    // Addressed to the asking session, and unsolicited frames carry id 0.
    for (const push of replies.slice(1)) {
      expect(push.id).toBe(0)
      expect(push.d).toMatchObject({ ok: true, sid: session.sid })
    }
  })

  test('nothing open is an explicit zero, which is what clears a stale ring', () => {
    const session = openSession(db, cardId)

    const replies = handleCmsMessage(ctxFor(), { t: 'orders_req', id: 3, d: { sid: session.sid } })

    expect(replies).toHaveLength(1)
    expect(replies[0].d).toMatchObject({ ok: true, n: 0 })
  })

  test('an unknown session is refused rather than leaking orders', () => {
    makeOrder()

    const replies = handleCmsMessage(ctxFor(), { t: 'orders_req', id: 4, d: { sid: 'nope' } })

    expect(replies[0]).toMatchObject({ t: 'orders_res', d: { ok: false } })
    expect(replies).toHaveLength(1)
  })

  test('order_res carries the estimate so the ring starts straight away', () => {
    const session = openSession(db, cardId)

    const replies = handleCmsMessage(ctxFor(), {
      t: 'order_req',
      id: 5,
      d: { sid: session.sid, pay: 'cash', items: [{ drink: 1, qty: 1 }] }
    })

    expect(replies[0].t).toBe('order_res')
    expect(replies[0].d).toMatchObject({ ok: true, status: 'received', eta_src: 'est' })
    expect(replies[0].d.eta_s).toBeGreaterThan(0)
    expect(replies[0].d.eta_total_s).toBeGreaterThan(0)
    // Still carries what it always did, so nothing that read the old reply breaks.
    expect(replies[0].d).toHaveProperty('order')
    expect(replies[0].d).toHaveProperty('balance')
    expect(replies[0].d).toHaveProperty('points')
  })

  test('a failed order_res carries no order fields to misread', () => {
    const session = openSession(db, cardId)

    const replies = handleCmsMessage(ctxFor(), {
      t: 'order_req',
      id: 6,
      d: { sid: session.sid, pay: 'cash', items: [] }
    })

    expect(replies[0].d.ok).toBe(false)
    expect(replies[0].d).not.toHaveProperty('num')
    expect(replies[0].d).not.toHaveProperty('eta_s')
  })
})
