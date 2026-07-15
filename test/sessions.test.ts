import { describe, expect, test } from 'vitest'
import { openTestDb } from '../src/db/index.js'
import { createPlayerWithCard } from '../src/domain/accounts.js'
import {
  activeSessionForCard,
  closeSession,
  getActiveSession,
  openSession,
  sweepIdleSessions,
  touchSession
} from '../src/domain/sessions.js'
import { MAX_SID_LEN } from '../src/wire/limits.js'

function setup() {
  const db = openTestDb()
  const { card } = createPlayerWithCard(db, { name: 'Иван Илијевски', cardUid: 'AA BB' })
  return { db, card }
}

describe('sessions', () => {
  test('mints a sid that fits the firmware char sid[24] buffer', () => {
    const { db, card } = setup()

    const session = openSession(db, card.id)

    // A UUID (36 chars) would be silently truncated by the firmware and every
    // subsequent debit would be rejected.
    expect(session.sid.length).toBeLessThanOrEqual(MAX_SID_LEN)
    expect(MAX_SID_LEN).toBe(23)
  })

  test('mints unique sids', () => {
    const { db, card } = setup()

    const a = openSession(db, card.id).sid
    const b = openSession(db, card.id).sid

    expect(a).not.toBe(b)
  })

  test('an open session is retrievable by sid', () => {
    const { db, card } = setup()

    const { sid } = openSession(db, card.id)

    expect(getActiveSession(db, sid)?.card_id).toBe(card.id)
  })

  test('a closed session is no longer active', () => {
    const { db, card } = setup()
    const { sid } = openSession(db, card.id)

    closeSession(db, sid, 'cashout')

    expect(getActiveSession(db, sid)).toBeUndefined()
    const row = db.prepare('SELECT * FROM sessions WHERE sid = ?').get(sid) as {
      close_reason: string
      closed_at: string
    }
    expect(row.close_reason).toBe('cashout')
    expect(row.closed_at).not.toBeNull()
  })

  test('opening a second session for a card replaces the first', () => {
    const { db, card } = setup()
    const first = openSession(db, card.id).sid

    const second = openSession(db, card.id).sid

    expect(getActiveSession(db, first)).toBeUndefined()
    expect(getActiveSession(db, second)).toBeDefined()
    expect(activeSessionForCard(db, card.id)?.sid).toBe(second)
    const row = db.prepare('SELECT close_reason FROM sessions WHERE sid = ?').get(first) as {
      close_reason: string
    }
    expect(row.close_reason).toBe('replaced')
  })

  test('sweepIdleSessions closes only sessions idle past the window', () => {
    const { db, card } = setup()
    const { card: card2 } = createPlayerWithCard(db, { name: 'Втор', cardUid: 'CC DD' })
    const stale = openSession(db, card.id).sid
    const fresh = openSession(db, card2.id).sid
    db.prepare(`UPDATE sessions SET last_activity_at = datetime('now', '-10 minutes') WHERE sid = ?`).run(
      stale
    )

    const closed = sweepIdleSessions(db, 5 * 60 * 1000)

    expect(closed.map((s) => s.sid)).toEqual([stale])
    expect(getActiveSession(db, stale)).toBeUndefined()
    expect(getActiveSession(db, fresh)).toBeDefined()
    const row = db.prepare('SELECT close_reason FROM sessions WHERE sid = ?').get(stale) as {
      close_reason: string
    }
    expect(row.close_reason).toBe('inactivity')
  })

  test('touchSession keeps a session out of the idle sweep', () => {
    const { db, card } = setup()
    const { sid } = openSession(db, card.id)
    db.prepare(`UPDATE sessions SET last_activity_at = datetime('now', '-10 minutes') WHERE sid = ?`).run(
      sid
    )

    touchSession(db, sid)
    const closed = sweepIdleSessions(db, 5 * 60 * 1000)

    expect(closed).toHaveLength(0)
    expect(getActiveSession(db, sid)).toBeDefined()
  })
})
