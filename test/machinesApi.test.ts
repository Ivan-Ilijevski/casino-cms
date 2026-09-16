import request from 'supertest'
import { beforeEach, describe, expect, test } from 'vitest'
import { DEFAULT_CONFIG } from '../src/config.js'
import { openTestDb, type Db } from '../src/db/index.js'
import { seed } from '../src/db/seed.js'
import { createPlayerWithCard } from '../src/domain/accounts.js'
import { createMachine } from '../src/domain/machines.js'
import { hashPassword } from '../src/domain/password.js'
import { openSession } from '../src/domain/sessions.js'
import { CmsEvents } from '../src/events.js'
import type { Pusher } from '../src/http/deps.js'
import { createStaffApp } from '../src/http/server.js'
import type { TerminalLink } from '../src/wire/tcpServer.js'

let db: Db

const ADMIN = { username: 'admin', password: 'secret123' }

/** A live connection, as CmsTcpServer would report it. */
function link(over: Partial<TerminalLink> = {}): TerminalLink {
  return {
    connId: 'conn-1',
    host: '10.0.0.1',
    port: 51000,
    connectedAt: Date.now(),
    lastRxAt: Date.now(),
    deviceId: 'smib-1',
    fw: '0.1.0',
    proto: 1,
    frames: 12,
    lastType: 'ping',
    machineId: null,
    sids: [],
    ...over
  }
}

class StubPusher implements Pusher {
  logouts: string[] = []
  dropped: string[] = []
  adopted: Array<{ connId: string; machineId: string }> = []
  constructor(private live: TerminalLink[] = []) {}
  pushBalance(): boolean {
    return true
  }
  pushLogout(sid: string): boolean {
    this.logouts.push(sid)
    return true
  }
  /**
   * Copies, exactly as CmsTcpServer.listLinks() does. Handing out the live
   * objects would let a route "work" by mutating what it was given — which is a
   * bug the real server cannot have, so the stub must not permit it either.
   */
  listLinks(): TerminalLink[] {
    return this.live.map((l) => ({ ...l, sids: [...l.sids] }))
  }
  sidsForLink(): string[] {
    return []
  }
  adoptLink(connId: string, machineId: string): boolean {
    this.adopted.push({ connId, machineId })
    const link = this.live.find((l) => l.connId === connId)
    if (!link) return false
    link.machineId = machineId
    return true
  }
  dropLink(connId: string): boolean {
    this.dropped.push(connId)
    return true
  }
}

function makeApp(pushes?: Pusher) {
  return createStaffApp({
    db,
    config: { ...DEFAULT_CONFIG, sessionSecret: 'test-secret' },
    events: new CmsEvents(),
    pushes
  })
}

async function loginAs(app: ReturnType<typeof createStaffApp>, username: string, password: string) {
  const agent = request.agent(app)
  const res = await agent.post('/api/login').send({ username, password })
  expect(res.status).toBe(200)
  return agent
}

beforeEach(() => {
  db = openTestDb()
  seed(db, { adminPassword: ADMIN.password })
  for (const [id, name, role] of [
    ['u2', 'barman', 'bar'],
    ['u3', 'konobar', 'staff']
  ] as const) {
    db.prepare(
      `INSERT INTO staff_users (id, username, password_hash, role) VALUES (?, ?, ?, ?)`
    ).run(id, name, hashPassword(ADMIN.password), role)
  }
})

describe('access', () => {
  test('admin may list machines', async () => {
    const agent = await loginAs(makeApp(), ADMIN.username, ADMIN.password)

    const res = await agent.get('/api/machines')

    expect(res.status).toBe(200)
    expect(res.body.machines).toEqual([])
  })

  test.each(['konobar', 'barman'])('%s may not', async (username) => {
    const agent = await loginAs(makeApp(), username, ADMIN.password)

    expect((await agent.get('/api/machines')).status).toBe(403)
  })

  test('lists the registry even with no terminal link wired in', async () => {
    createMachine(db, { label: 'Кабина 1' })
    const agent = await loginAs(makeApp(undefined), ADMIN.username, ADMIN.password)

    const res = await agent.get('/api/machines')

    expect(res.status).toBe(200)
    expect(res.body.machines[0]).toMatchObject({ label: 'Кабина 1', state: 'offline', link: null })
  })
})

describe('registering', () => {
  test('creates a machine', async () => {
    const agent = await loginAs(makeApp(), ADMIN.username, ADMIN.password)

    const res = await agent
      .post('/api/machines')
      .send({ label: 'Shining Crown 01', host: '10.0.0.1', location: 'Кај шанкот' })

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ label: 'Shining Crown 01', host: '10.0.0.1' })
    const row = db.prepare('SELECT action FROM audit_log ORDER BY id DESC LIMIT 1').get()
    expect(row).toEqual({ action: 'machine.create' })
  })

  test('demands a label', async () => {
    const agent = await loginAs(makeApp(), ADMIN.username, ADMIN.password)

    const res = await agent.post('/api/machines').send({ host: '10.0.0.1' })

    expect(res.status).toBe(400)
  })

  test('refuses a second machine on one host, as a 400 not a crash', async () => {
    createMachine(db, { label: 'Кабина 1', host: '10.0.0.1' })
    const agent = await loginAs(makeApp(), ADMIN.username, ADMIN.password)

    const res = await agent.post('/api/machines').send({ label: 'Кабина 2', host: '10.0.0.1' })

    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/host/)
  })

  test('rejects a nonsense host', async () => {
    const agent = await loginAs(makeApp(), ADMIN.username, ADMIN.password)

    const res = await agent.post('/api/machines').send({ label: 'Кабина', host: 'not a host!' })

    expect(res.status).toBe(400)
  })
})

describe('adopting a live connection', () => {
  test('takes the host and device id from the socket, not from the client', async () => {
    const pusher = new StubPusher([link({ host: '10.0.0.9', deviceId: 'smib-1' })])
    const agent = await loginAs(makeApp(pusher), ADMIN.username, ADMIN.password)

    const res = await agent
      .post('/api/machines/adopt')
      .send({ connId: 'conn-1', label: 'Кабина 9', host: '1.2.3.4' })

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ label: 'Кабина 9', host: '10.0.0.9', device_id: 'smib-1' })
  })

  test('binds the live socket at once instead of waiting for the next hello', async () => {
    const live = link({ host: '10.0.0.9' })
    const pusher = new StubPusher([live])
    const agent = await loginAs(makeApp(pusher), ADMIN.username, ADMIN.password)

    const res = await agent.post('/api/machines/adopt').send({ connId: 'conn-1', label: 'Кабина 9' })

    // The route must go through adoptLink: listLinks() hands out copies, so
    // assigning to the link it was given would leave the cabinet reading as
    // offline until the terminal happened to reconnect.
    expect(pusher.adopted).toEqual([{ connId: 'conn-1', machineId: res.body.id }])
    expect(live.machineId).toBe(res.body.id)
  })

  test('the adopted machine reads as online straight away', async () => {
    const pusher = new StubPusher([link({ host: '10.0.0.9', lastRxAt: Date.now() })])
    const agent = await loginAs(makeApp(pusher), ADMIN.username, ADMIN.password)

    await agent.post('/api/machines/adopt').send({ connId: 'conn-1', label: 'Кабина 9' })
    const res = await agent.get('/api/machines')

    expect(res.body.machines[0]).toMatchObject({ state: 'online' })
  })

  test('404s an unknown connection', async () => {
    const agent = await loginAs(makeApp(new StubPusher()), ADMIN.username, ADMIN.password)

    const res = await agent.post('/api/machines/adopt').send({ connId: 'nope', label: 'Кабина' })

    expect(res.status).toBe(404)
  })

  test('409s a connection that is already registered', async () => {
    const m = createMachine(db, { label: 'Кабина 1', host: '10.0.0.9' })
    const pusher = new StubPusher([link({ host: '10.0.0.9', machineId: m.id })])
    const agent = await loginAs(makeApp(pusher), ADMIN.username, ADMIN.password)

    const res = await agent.post('/api/machines/adopt').send({ connId: 'conn-1', label: 'X' })

    expect(res.status).toBe(409)
  })

  test('link timestamps use the same shape as every other date in the API', async () => {
    const pusher = new StubPusher([link()])
    const agent = await loginAs(makeApp(pusher), ADMIN.username, ADMIN.password)

    const res = await agent.get('/api/machines/links')

    // fmtDateTime/timeAgo parse "YYYY-MM-DD HH:MM:SS" as UTC; ISO-8601 gives NaN.
    expect(res.body.links[0].connectedAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    expect(res.body.links[0].lastRxAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
  })

  test('/machines/links is not swallowed by the :id route', async () => {
    const pusher = new StubPusher([link()])
    const agent = await loginAs(makeApp(pusher), ADMIN.username, ADMIN.password)

    const res = await agent.get('/api/machines/links')

    expect(res.status).toBe(200)
    expect(res.body.links[0]).toMatchObject({ connId: 'conn-1', deviceId: 'smib-1' })
  })
})

describe('live state', () => {
  test('a connection heard from within the firmware timeout is online', async () => {
    const m = createMachine(db, { label: 'Кабина 1', host: '10.0.0.1' })
    const pusher = new StubPusher([link({ machineId: m.id, lastRxAt: Date.now() })])
    const agent = await loginAs(makeApp(pusher), ADMIN.username, ADMIN.password)

    const res = await agent.get('/api/machines')

    expect(res.body.machines[0].state).toBe('online')
  })

  test('a socket that has gone quiet reads as silent, not online', async () => {
    const m = createMachine(db, { label: 'Кабина 1', host: '10.0.0.1' })
    const pusher = new StubPusher([link({ machineId: m.id, lastRxAt: Date.now() - 10_000 })])
    const agent = await loginAs(makeApp(pusher), ADMIN.username, ADMIN.password)

    const res = await agent.get('/api/machines')

    expect(res.body.machines[0].state).toBe('silent')
  })

  test('shows who is playing at the machine', async () => {
    const m = createMachine(db, { label: 'Кабина 1', host: '10.0.0.1' })
    const { card } = createPlayerWithCard(db, { name: 'Иван Илијевски', cardUid: 'AA BB' })
    const session = openSession(db, card.id)
    db.prepare('UPDATE sessions SET machine_id = ? WHERE sid = ?').run(m.id, session.sid)
    const agent = await loginAs(makeApp(), ADMIN.username, ADMIN.password)

    const res = await agent.get('/api/machines')

    expect(res.body.machines[0].players).toEqual([
      expect.objectContaining({ name: 'Иван Илијевски', sid: session.sid })
    ])
  })
})

describe('control actions', () => {
  test('out of service is recorded and audited', async () => {
    const m = createMachine(db, { label: 'Кабина 1' })
    const agent = await loginAs(makeApp(), ADMIN.username, ADMIN.password)

    const res = await agent.post(`/api/machines/${m.id}/status`).send({ status: 'out_of_service' })

    expect(res.status).toBe(200)
    expect(res.body.status).toBe('out_of_service')
    expect(db.prepare('SELECT action FROM audit_log ORDER BY id DESC LIMIT 1').get()).toEqual({
      action: 'machine.status'
    })
  })

  test('taking a machine out of service does not touch card auth', async () => {
    const m = createMachine(db, { label: 'Кабина 1', host: '10.0.0.1' })
    const { card } = createPlayerWithCard(db, { name: 'Иван Илијевски', cardUid: 'AA BB' })
    const agent = await loginAs(makeApp(), ADMIN.username, ADMIN.password)
    await agent.post(`/api/machines/${m.id}/status`).send({ status: 'out_of_service' })

    // status is advisory: nothing in the wire path reads it, so a session still opens.
    expect(() => openSession(db, card.id)).not.toThrow()
  })

  test('rejects an unknown status', async () => {
    const m = createMachine(db, { label: 'Кабина 1' })
    const agent = await loginAs(makeApp(), ADMIN.username, ADMIN.password)

    expect((await agent.post(`/api/machines/${m.id}/status`).send({ status: 'broken' })).status).toBe(
      400
    )
  })

  test('force-logout pushes to the terminal and closes the session', async () => {
    const m = createMachine(db, { label: 'Кабина 1', host: '10.0.0.1' })
    const { card } = createPlayerWithCard(db, { name: 'Иван Илијевски', cardUid: 'AA BB' })
    const session = openSession(db, card.id)
    db.prepare('UPDATE sessions SET machine_id = ? WHERE sid = ?').run(m.id, session.sid)
    const pusher = new StubPusher()
    const agent = await loginAs(makeApp(pusher), ADMIN.username, ADMIN.password)

    const res = await agent.post(`/api/machines/${m.id}/logout`).send({})

    expect(res.body).toEqual({ ok: true, sessions: 1 })
    expect(pusher.logouts).toEqual([session.sid])
    const row = db.prepare('SELECT closed_at, close_reason FROM sessions WHERE sid = ?').get(
      session.sid
    ) as { closed_at: string | null; close_reason: string }
    expect(row.closed_at).not.toBeNull()
    expect(row.close_reason).toBe('logout_push')
  })

  test('drop cuts the live link', async () => {
    const m = createMachine(db, { label: 'Кабина 1', host: '10.0.0.1' })
    const pusher = new StubPusher([link({ machineId: m.id })])
    const agent = await loginAs(makeApp(pusher), ADMIN.username, ADMIN.password)

    const res = await agent.post(`/api/machines/${m.id}/drop`).send({})

    expect(res.status).toBe(200)
    expect(pusher.dropped).toEqual(['conn-1'])
  })

  test('drop 409s when nothing is connected', async () => {
    const m = createMachine(db, { label: 'Кабина 1' })
    const agent = await loginAs(makeApp(new StubPusher()), ADMIN.username, ADMIN.password)

    expect((await agent.post(`/api/machines/${m.id}/drop`).send({})).status).toBe(409)
  })

  test('renaming records only the field names in the audit trail', async () => {
    const m = createMachine(db, { label: 'Кабина 1' })
    const agent = await loginAs(makeApp(), ADMIN.username, ADMIN.password)

    const res = await agent.patch(`/api/machines/${m.id}`).send({ label: 'Кабина еден' })

    expect(res.status).toBe(200)
    expect(res.body.label).toBe('Кабина еден')
    const row = db.prepare('SELECT details FROM audit_log ORDER BY id DESC LIMIT 1').get() as {
      details: string
    }
    expect(JSON.parse(row.details)).toEqual({ fields: ['label'] })
  })

  test('404s every action on an unknown machine', async () => {
    const agent = await loginAs(makeApp(), ADMIN.username, ADMIN.password)

    expect((await agent.get('/api/machines/nope')).status).toBe(404)
    expect((await agent.patch('/api/machines/nope').send({ label: 'x' })).status).toBe(404)
    expect((await agent.get('/api/machines/nope/sessions')).status).toBe(404)
  })
})
