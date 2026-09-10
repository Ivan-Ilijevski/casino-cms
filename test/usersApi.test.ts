import request from 'supertest'
import { beforeEach, describe, expect, test } from 'vitest'
import { DEFAULT_CONFIG } from '../src/config.js'
import { openTestDb, type Db } from '../src/db/index.js'
import { seed } from '../src/db/seed.js'
import { hashPassword } from '../src/domain/password.js'
import { CmsEvents } from '../src/events.js'
import { createStaffApp } from '../src/http/server.js'

let db: Db
let app: ReturnType<typeof createStaffApp>

const ADMIN = { username: 'admin', password: 'secret123' }
const NEW_USER = { username: 'sank.tablet', password: 'tablet-pass-1', role: 'bar' }

beforeEach(() => {
  db = openTestDb()
  seed(db, { adminPassword: ADMIN.password })
  db.prepare(
    `INSERT INTO staff_users (id, username, password_hash, role) VALUES ('u2', 'barman', ?, 'staff')`
  ).run(hashPassword(ADMIN.password))
  app = createStaffApp({
    db,
    config: { ...DEFAULT_CONFIG, sessionSecret: 'test-secret' },
    events: new CmsEvents()
  })
})

async function loginAs(username: string, password: string) {
  const agent = request.agent(app)
  const res = await agent.post('/api/login').send({ username, password })
  expect(res.status).toBe(200)
  return agent
}

function adminId(): string {
  return (db.prepare(`SELECT id FROM staff_users WHERE username = 'admin'`).get() as { id: string })
    .id
}

describe('listing users', () => {
  test('admin sees every account', async () => {
    const agent = await loginAs(ADMIN.username, ADMIN.password)

    const res = await agent.get('/api/users')

    expect(res.status).toBe(200)
    expect(res.body.users.map((u: { username: string }) => u.username)).toEqual(['admin', 'barman'])
  })

  test('never leaks the password hash', async () => {
    const agent = await loginAs(ADMIN.username, ADMIN.password)

    const res = await agent.get('/api/users')

    expect(JSON.stringify(res.body)).not.toContain('scrypt$')
    expect(JSON.stringify(res.body)).not.toContain('password_hash')
  })

  test('ordinary staff may not', async () => {
    const agent = await loginAs('barman', ADMIN.password)

    expect((await agent.get('/api/users')).status).toBe(403)
  })
})

describe('creating a user', () => {
  test('admin creates one and it can sign in', async () => {
    const agent = await loginAs(ADMIN.username, ADMIN.password)

    const res = await agent.post('/api/users').send(NEW_USER)

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ username: NEW_USER.username, role: 'bar', active: 1 })
    expect(JSON.stringify(res.body)).not.toContain('scrypt$')
    await loginAs(NEW_USER.username, NEW_USER.password)
  })

  test('rejects a duplicate username', async () => {
    const agent = await loginAs(ADMIN.username, ADMIN.password)

    const res = await agent.post('/api/users').send({ ...NEW_USER, username: 'barman' })

    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/already taken/i)
  })

  test('rejects a malformed username', async () => {
    const agent = await loginAs(ADMIN.username, ADMIN.password)

    const res = await agent.post('/api/users').send({ ...NEW_USER, username: 'Ivan Ilijevski' })

    expect(res.status).toBe(400)
  })

  test('rejects a short password', async () => {
    const agent = await loginAs(ADMIN.username, ADMIN.password)

    const res = await agent.post('/api/users').send({ ...NEW_USER, password: 'short' })

    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/at least 8/i)
  })

  test('rejects an unknown role', async () => {
    const agent = await loginAs(ADMIN.username, ADMIN.password)

    const res = await agent.post('/api/users').send({ ...NEW_USER, role: 'superuser' })

    expect(res.status).toBe(400)
  })

  test('ordinary staff may not', async () => {
    const agent = await loginAs('barman', ADMIN.password)

    expect((await agent.post('/api/users').send(NEW_USER)).status).toBe(403)
  })
})

describe('editing a user', () => {
  test('renames and re-roles', async () => {
    const agent = await loginAs(ADMIN.username, ADMIN.password)

    const res = await agent.patch('/api/users/u2').send({ username: 'sanker', role: 'bar' })

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ username: 'sanker', role: 'bar' })
  })

  test('rejects renaming onto a taken username', async () => {
    const agent = await loginAs(ADMIN.username, ADMIN.password)

    const res = await agent.patch('/api/users/u2').send({ username: 'admin' })

    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/already taken/i)
  })

  test('404s on an unknown user', async () => {
    const agent = await loginAs(ADMIN.username, ADMIN.password)

    expect((await agent.patch('/api/users/nope').send({ role: 'bar' })).status).toBe(404)
  })

  test('an admin cannot change their own role', async () => {
    const agent = await loginAs(ADMIN.username, ADMIN.password)

    const res = await agent.patch(`/api/users/${adminId()}`).send({ role: 'staff' })

    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/your own role/i)
  })

  test('an admin cannot deactivate themselves', async () => {
    const agent = await loginAs(ADMIN.username, ADMIN.password)

    const res = await agent.patch(`/api/users/${adminId()}`).send({ active: false })

    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/your own account/i)
  })

  test('an admin may demote another admin while one is left', async () => {
    const agent = await loginAs(ADMIN.username, ADMIN.password)
    const second = await agent
      .post('/api/users')
      .send({ username: 'admin2', password: 'password-2', role: 'admin' })

    const res = await agent.patch(`/api/users/${second.body.id}`).send({ role: 'staff' })

    expect(res.status).toBe(200)
    expect(res.body.role).toBe('staff')
  })

  test('the casino can never be left without an admin', async () => {
    const agent = await loginAs(ADMIN.username, ADMIN.password)

    // Only an admin may edit users, and only an active one has a session at all,
    // so the sole way to reach zero admins is the actor editing themselves —
    // which is exactly what these two refuse.
    expect((await agent.patch(`/api/users/${adminId()}`).send({ role: 'bar' })).status).toBe(409)
    expect((await agent.patch(`/api/users/${adminId()}`).send({ active: false })).status).toBe(409)

    const left = db.prepare(
      `SELECT COUNT(*) AS n FROM staff_users WHERE role = 'admin' AND active = 1`
    ).get() as { n: number }
    expect(left.n).toBe(1)
  })

  test('deactivating cuts the user off on their very next request', async () => {
    const admin = await loginAs(ADMIN.username, ADMIN.password)
    const barman = await loginAs('barman', ADMIN.password)
    expect((await barman.get('/api/me')).status).toBe(200)

    await admin.patch('/api/users/u2').send({ active: false })

    expect((await barman.get('/api/me')).status).toBe(401)
    const res = await request(app).post('/api/login').send({ username: 'barman', password: ADMIN.password })
    expect(res.status).toBe(401)
  })

  test('reactivating lets them back in', async () => {
    const admin = await loginAs(ADMIN.username, ADMIN.password)
    await admin.patch('/api/users/u2').send({ active: false })

    await admin.patch('/api/users/u2').send({ active: true })

    await loginAs('barman', ADMIN.password)
  })
})

describe('passwords', () => {
  test('an admin reset replaces the old password', async () => {
    const admin = await loginAs(ADMIN.username, ADMIN.password)

    const res = await admin.post('/api/users/u2/password').send({ password: 'brand-new-pass' })

    expect(res.status).toBe(200)
    expect(
      (await request(app).post('/api/login').send({ username: 'barman', password: ADMIN.password })).status
    ).toBe(401)
    await loginAs('barman', 'brand-new-pass')
  })

  test('an admin reset rejects a short password', async () => {
    const admin = await loginAs(ADMIN.username, ADMIN.password)

    expect((await admin.post('/api/users/u2/password').send({ password: 'no' })).status).toBe(400)
  })

  test('a user changes their own password', async () => {
    const barman = await loginAs('barman', ADMIN.password)

    const res = await barman
      .post('/api/me/password')
      .send({ current_password: ADMIN.password, new_password: 'my-own-choice' })

    expect(res.status).toBe(200)
    await loginAs('barman', 'my-own-choice')
  })

  test('changing your own password needs the current one', async () => {
    const barman = await loginAs('barman', ADMIN.password)

    const res = await barman
      .post('/api/me/password')
      .send({ current_password: 'not-it', new_password: 'my-own-choice' })

    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/current password/i)
    await loginAs('barman', ADMIN.password)
  })
})

describe('audit trail', () => {
  test('records the lifecycle without ever writing password material', async () => {
    const admin = await loginAs(ADMIN.username, ADMIN.password)

    const created = await admin.post('/api/users').send(NEW_USER)
    await admin.patch(`/api/users/${created.body.id}`).send({ role: 'staff' })
    await admin.post(`/api/users/${created.body.id}/password`).send({ password: 'another-one' })

    const rows = db
      .prepare(`SELECT * FROM audit_log WHERE action LIKE 'user.%' ORDER BY id`)
      .all() as Array<{ action: string; actor: string; entity_id: string; details: string | null }>
    expect(rows.map((r) => r.action)).toEqual(['user.create', 'user.update', 'user.password'])
    expect(rows.every((r) => r.actor === 'admin')).toBe(true)
    expect(rows.every((r) => r.entity_id === created.body.id)).toBe(true)

    const dumped = JSON.stringify(rows)
    expect(dumped).not.toContain(NEW_USER.password)
    expect(dumped).not.toContain('another-one')
    expect(dumped).not.toContain('scrypt$')
  })

  test('records a self-service password change', async () => {
    const barman = await loginAs('barman', ADMIN.password)

    await barman
      .post('/api/me/password')
      .send({ current_password: ADMIN.password, new_password: 'my-own-choice' })

    const row = db.prepare(`SELECT * FROM audit_log WHERE action = 'user.password_self'`).get() as {
      actor: string
      details: string | null
    }
    expect(row).toMatchObject({ actor: 'barman' })
    expect(JSON.stringify(row)).not.toContain('my-own-choice')
  })
})
