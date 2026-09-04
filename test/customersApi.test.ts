import request from 'supertest'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { DEFAULT_CONFIG } from '../src/config.js'
import { openTestDb, type Db } from '../src/db/index.js'
import { seed } from '../src/db/seed.js'
import { createPlayerWithCard, type Card } from '../src/domain/accounts.js'
import { postEntry } from '../src/domain/ledger.js'
import { placeOrder } from '../src/domain/orders.js'
import { hashPassword } from '../src/domain/password.js'
import { closeSession, openSession } from '../src/domain/sessions.js'
import { CmsEvents } from '../src/events.js'
import { createStaffApp } from '../src/http/server.js'

const PASSWORD = 'secret123'
const TERMINAL_UID = '9C 76 5A F4'
const NFC_UID = '9c:76:5a:f4'

let db: Db
let app: ReturnType<typeof createStaffApp>
let card: Card
let playerId: string

beforeEach(() => {
  db = openTestDb()
  seed(db, { adminPassword: PASSWORD })
  db.prepare(
    `INSERT INTO staff_users (id, username, password_hash, role) VALUES ('u2', 'barman', ?, 'staff')`
  ).run(hashPassword(PASSWORD))

  const made = createPlayerWithCard(db, { name: 'Иван Илијевски', cardUid: TERMINAL_UID })
  card = made.card
  playerId = made.player.id
  postEntry(db, { cardId: card.id, unit: 'deni', amount: 100000, kind: 'adjustment' })

  app = createStaffApp({
    db,
    config: { ...DEFAULT_CONFIG, sessionSecret: 'test-secret' },
    events: new CmsEvents(),
    pushes: { pushBalance: vi.fn().mockReturnValue(true), pushLogout: vi.fn().mockReturnValue(true) }
  })
})

async function loginAs(username: string) {
  const agent = request.agent(app)
  const res = await agent.post('/api/login').send({ username, password: PASSWORD })
  expect(res.status).toBe(200)
  return agent
}

describe('GET /api/customers', () => {
  test('returns one row per person, not per card', async () => {
    // A second card for the same guest — the old cards-table view showed two rows.
    db.prepare(
      `INSERT INTO cards (id, card_uid, player_id, card_uid_canon, balance_deni)
       VALUES ('c2', 'BB CC DD EE', ?, 'BBCCDDEE', 2500)`
    ).run(playerId)
    const agent = await loginAs('admin')

    const res = await agent.get('/api/customers')

    expect(res.status).toBe(200)
    expect(res.body).toHaveLength(1)
    expect(res.body[0]).toMatchObject({
      name: 'Иван Илијевски',
      cards: 2,
      balance_deni: 102500
    })
  })

  test('finds a guest by a card uid in either reader spelling', async () => {
    const agent = await loginAs('admin')

    const terminal = await agent.get('/api/customers').query({ q: TERMINAL_UID })
    const nfc = await agent.get('/api/customers').query({ q: NFC_UID })

    expect(terminal.body).toHaveLength(1)
    expect(nfc.body).toHaveLength(1)
    expect(nfc.body[0].id).toBe(playerId)
  })

  test('filters by tag', async () => {
    createPlayerWithCard(db, { name: 'Марија', cardUid: 'AA AA' })
    const agent = await loginAs('admin')
    await agent.post(`/api/customers/${playerId}/tags`).send({ tag: 'vip' })

    const res = await agent.get('/api/customers').query({ tag: 'vip' })

    expect(res.body).toHaveLength(1)
    expect(res.body[0].tags).toEqual(['vip'])
  })
})

describe('GET /api/customers/:id', () => {
  test('gathers cards, tags and lifetime stats', async () => {
    postEntry(db, { cardId: card.id, unit: 'deni', amount: -30000, kind: 'aft_debit' })
    postEntry(db, { cardId: card.id, unit: 'deni', amount: 5000, kind: 'aft_credit' })
    const agent = await loginAs('admin')

    const res = await agent.get(`/api/customers/${playerId}`)

    expect(res.status).toBe(200)
    expect(res.body.cards).toHaveLength(1)
    expect(res.body.cards[0]).toMatchObject({ card_uid: TERMINAL_UID, has_pin: 0 })
    expect(res.body.stats).toMatchObject({ lifetime_out_deni: 30000, lifetime_in_deni: 5000 })
    expect(res.body.cards[0].pin_hash).toBeUndefined()
  })

  test('404s an unknown guest', async () => {
    const agent = await loginAs('admin')

    expect((await agent.get('/api/customers/nope')).status).toBe(404)
  })

  test('withholds dob and doc_id from ordinary staff', async () => {
    db.prepare("UPDATE players SET dob = '1980-05-01', doc_id = '1234567890123', phone = '070111222' WHERE id = ?").run(playerId)

    const asAdmin = await (await loginAs('admin')).get(`/api/customers/${playerId}`)
    const asStaff = await (await loginAs('barman')).get(`/api/customers/${playerId}`)

    expect(asAdmin.body.player).toMatchObject({ dob: '1980-05-01', doc_id: '1234567890123' })
    expect(asStaff.body.player.phone).toBe('070111222')
    expect(asStaff.body.player).not.toHaveProperty('dob')
    expect(asStaff.body.player).not.toHaveProperty('doc_id')
  })
})

describe('PII confinement', () => {
  /**
   * Migration 004 put dob and doc_id on `players`, and two pre-existing routes
   * selected `p.*` / `SELECT *` from it. Both are staff-readable, so the wildcard
   * turned an additive migration into a passport-number leak. This sweeps every
   * staff-reachable endpoint rather than the one the redact() helper guards, so
   * the next identity column added cannot quietly reopen it.
   */
  test('no staff-readable endpoint returns dob or doc_id', async () => {
    db.prepare("UPDATE players SET dob = '1980-05-01', doc_id = '1234567890123' WHERE id = ?").run(playerId)
    const staff = await loginAs('barman')

    // Sequential: one supertest agent cannot service five concurrent requests.
    for (const path of [
      '/api/customers',
      `/api/customers/${playerId}`,
      '/api/players',
      '/api/cards',
      `/api/cards/${card.id}`
    ]) {
      const res = await staff.get(path)
      expect(res.status, path).toBe(200)
      const body = JSON.stringify(res.body)
      expect(body, `${path} leaked doc_id`).not.toContain('1234567890123')
      expect(body, `${path} leaked dob`).not.toContain('1980-05-01')
    }
  })

  test('an admin still gets them where the CRM intends to serve them', async () => {
    db.prepare("UPDATE players SET dob = '1980-05-01', doc_id = '1234567890123' WHERE id = ?").run(playerId)
    const admin = await loginAs('admin')

    const res = await admin.get(`/api/customers/${playerId}`)

    expect(res.body.player).toMatchObject({ dob: '1980-05-01', doc_id: '1234567890123' })
  })
})

describe('PATCH /api/customers/:id', () => {
  test('updates identity and audits the field names, never the values', async () => {
    const agent = await loginAs('admin')

    const res = await agent
      .patch(`/api/customers/${playerId}`)
      .send({ phone: '070111222', doc_id: '1234567890123' })

    expect(res.status).toBe(200)
    expect(res.body.changed.sort()).toEqual(['doc_id', 'phone'])
    const entry = db
      .prepare("SELECT * FROM audit_log WHERE action = 'player.update'")
      .get() as { details: string }
    expect(JSON.parse(entry.details)).toEqual({ fields: ['phone', 'doc_id'] })
    expect(entry.details).not.toContain('1234567890123')
  })

  test('rejects a name past the terminal byte limit', async () => {
    const agent = await loginAs('admin')

    // Cyrillic is two bytes a letter, so 40 letters is 80 bytes against a 63 cap.
    const res = await agent.patch(`/api/customers/${playerId}`).send({ name: 'И'.repeat(40) })

    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/too long/)
  })

  test('is refused to ordinary staff', async () => {
    const agent = await loginAs('barman')

    expect((await agent.patch(`/api/customers/${playerId}`).send({ city: 'Скопје' })).status).toBe(403)
  })
})

describe('GET /api/customers/:id/timeline', () => {
  test('paginates backwards on a keyset cursor without repeating a row', async () => {
    for (let i = 0; i < 5; i++) {
      postEntry(db, { cardId: card.id, unit: 'deni', amount: -100, kind: 'aft_debit' })
    }
    const agent = await loginAs('admin')

    const first = await agent.get(`/api/customers/${playerId}/timeline`).query({ limit: 3 })
    const next = await agent
      .get(`/api/customers/${playerId}/timeline`)
      .query({ limit: 3, before: first.body[first.body.length - 1].id })

    expect(first.body).toHaveLength(3)
    expect(next.body).toHaveLength(3) // 6 entries total: the seed adjustment plus five
    const ids = [...first.body, ...next.body].map((r: { id: number }) => r.id)
    expect(new Set(ids).size).toBe(6)
  })

  test('names the drinks on a bar line', async () => {
    const placed = placeOrder(db, { cardId: card.id, pay: 'cash', items: [{ drink: 1, qty: 2 }] })
    expect(placed.ok).toBe(true)
    const agent = await loginAs('admin')

    const res = await agent.get(`/api/customers/${playerId}/timeline`).query({ type: 'order' })

    expect(res.body).toHaveLength(1)
    expect(res.body[0].order_items).toMatch(/^2× /)
    expect(res.body[0].order_number).toBeGreaterThan(0)
  })
})

describe('GET /api/customers/:id/sessions', () => {
  test('returns closed visits with their duration and reason', async () => {
    const session = openSession(db, card.id)
    db.prepare("UPDATE sessions SET opened_at = '2026-01-01 10:00:00' WHERE sid = ?").run(session.sid)
    closeSession(db, session.sid, 'cashout')
    db.prepare("UPDATE sessions SET closed_at = '2026-01-01 10:30:00' WHERE sid = ?").run(session.sid)
    const agent = await loginAs('admin')

    const res = await agent.get(`/api/customers/${playerId}/sessions`)

    expect(res.body).toHaveLength(1)
    expect(res.body[0]).toMatchObject({
      card_uid: TERMINAL_UID,
      close_reason: 'cashout',
      duration_seconds: 1800
    })
  })
})

describe('visit spend', () => {
  test('nets the cashout back against the transfer out', async () => {
    const s1 = openSession(db, card.id)
    postEntry(db, { cardId: card.id, unit: 'deni', amount: -500000, kind: 'aft_debit', sessionId: s1.sid })
    postEntry(db, { cardId: card.id, unit: 'deni', amount: 400000, kind: 'aft_credit', sessionId: s1.sid })
    const agent = await loginAs('admin')

    const res = await agent.get(`/api/customers/${playerId}/sessions`)

    // 5 000 out, 4 000 back = 1 000 spent, not 5 000.
    expect(res.body[0].spend_deni).toBe(100000)
  })
})

describe('tags and notes', () => {
  test('tagging twice is a no-op rather than an error', async () => {
    const agent = await loginAs('admin')

    await agent.post(`/api/customers/${playerId}/tags`).send({ tag: 'watchlist' })
    const res = await agent.post(`/api/customers/${playerId}/tags`).send({ tag: 'watchlist' })

    expect(res.status).toBe(200)
    expect(res.body.tags).toEqual(['watchlist'])
  })

  test('rejects a tag that is not a slug', async () => {
    const agent = await loginAs('admin')

    expect((await agent.post(`/api/customers/${playerId}/tags`).send({ tag: 'на списокот!' })).status).toBe(400)
  })

  test('ordinary staff may add a note but not delete one', async () => {
    const staff = await loginAs('barman')

    const added = await staff.post(`/api/customers/${playerId}/notes`).send({ body: 'Бара само виски' })
    expect(added.status).toBe(200)
    expect(added.body.note).toMatchObject({ author: 'barman', body: 'Бара само виски' })

    const removed = await staff.delete(`/api/customers/${playerId}/notes/${added.body.note.id}`)
    expect(removed.status).toBe(403)
  })
})

describe('note scoping', () => {
  /**
   * A note id addresses any row in the table, so the guest in the path has to be
   * part of the WHERE — otherwise one guest's URL deletes another guest's note
   * and the audit row names the wrong person.
   */
  test('cannot delete a note through a different guest\'s url', async () => {
    const other = createPlayerWithCard(db, { name: 'Марија', cardUid: 'AA AA' }).player
    const admin = await loginAs('admin')
    const added = await admin.post(`/api/customers/${other.id}/notes`).send({ body: 'нејзина белешка' })
    const noteId = added.body.note.id

    const res = await admin.delete(`/api/customers/${playerId}/notes/${noteId}`)

    expect(res.status).toBe(404)
    expect(db.prepare('SELECT COUNT(*) AS n FROM player_notes WHERE id = ?').get(noteId)).toEqual({ n: 1 })
    expect(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'player.note_delete'").get()).toEqual({ n: 0 })
  })

  test('cannot pin a note through a different guest\'s url', async () => {
    const other = createPlayerWithCard(db, { name: 'Марија', cardUid: 'AA AA' }).player
    const admin = await loginAs('admin')
    const added = await admin.post(`/api/customers/${other.id}/notes`).send({ body: 'нејзина белешка' })

    const res = await admin
      .post(`/api/customers/${playerId}/notes/${added.body.note.id}/pin`)
      .send({ pinned: true })

    expect(res.status).toBe(404)
    expect(db.prepare('SELECT pinned FROM player_notes WHERE id = ?').get(added.body.note.id)).toEqual({ pinned: 0 })
  })

  test('deleting through the right url works and audits the right guest', async () => {
    const admin = await loginAs('admin')
    const added = await admin.post(`/api/customers/${playerId}/notes`).send({ body: 'негова белешка' })

    const res = await admin.delete(`/api/customers/${playerId}/notes/${added.body.note.id}`)

    expect(res.status).toBe(200)
    const entry = db
      .prepare("SELECT entity_id FROM audit_log WHERE action = 'player.note_delete'")
      .get() as { entity_id: string }
    expect(entry.entity_id).toBe(playerId)
  })
})

describe('POST /api/customers/:id/osint-lookup', () => {
  test('records who looked the guest up, where and why', async () => {
    const agent = await loginAs('admin')

    const res = await agent
      .post(`/api/customers/${playerId}/osint-lookup`)
      .send({ source: 'opensanctions', reason: 'aml' })

    expect(res.status).toBe(200)
    const entry = db
      .prepare("SELECT * FROM audit_log WHERE action = 'osint.lookup'")
      .get() as { actor: string; entity_id: string; details: string }
    expect(entry).toMatchObject({ actor: 'admin', entity_id: playerId })
    expect(JSON.parse(entry.details)).toEqual({ source: 'opensanctions', reason: 'aml' })
  })

  test('demands a reason from the fixed list', async () => {
    const agent = await loginAs('admin')

    const res = await agent
      .post(`/api/customers/${playerId}/osint-lookup`)
      .send({ source: 'google' })

    expect(res.status).toBe(400)
    expect(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'osint.lookup'").get()).toEqual({ n: 0 })
  })

  test('is refused to ordinary staff', async () => {
    const staff = await loginAs('barman')

    const res = await staff
      .post(`/api/customers/${playerId}/osint-lookup`)
      .send({ source: 'google', reason: 'kyc' })

    expect(res.status).toBe(403)
  })
})
