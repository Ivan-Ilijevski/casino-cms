import { describe, expect, test } from 'vitest'
import { openTestDb } from '../src/db/index.js'
import {
  denarsToDeni,
  deniToDenars,
  generateTicketId,
  getTicket,
  issueTicket,
  issueTicketWithId,
  redeemTicket,
  voidTicket
} from '../src/domain/tickets.js'

function setup() {
  return openTestDb()
}

describe('denar <-> deni conversion', () => {
  test('converts whole denars to deni', () => {
    expect(denarsToDeni(400)).toBe(40000)
    expect(deniToDenars(40000)).toBe(400)
  })

  test('round-trips fractional denars exactly', () => {
    // The slot game divides deni by 100 on cashout and Math.rounds back on
    // redeem, so a half-denar ticket must survive the trip.
    expect(denarsToDeni(450.5)).toBe(45050)
    expect(deniToDenars(45050)).toBe(450.5)
  })

  test('does not fall foul of float multiplication', () => {
    expect(denarsToDeni(0.07)).toBe(7) // 0.07 * 100 === 7.000000000000001
    expect(denarsToDeni(1.1)).toBe(110)
  })
})

describe('generateTicketId', () => {
  test('produces an 18-digit numeric id, matching the legacy format', () => {
    const db = setup()

    const id = generateTicketId(db)

    expect(id).toMatch(/^[0-9]{18}$/)
  })

  test('never collides with an existing ticket', () => {
    const db = setup()
    const ids = new Set<string>()
    for (let i = 0; i < 50; i++) {
      const t = issueTicket(db, { amountDeni: 100 })
      expect(ids.has(t.id)).toBe(false)
      ids.add(t.id)
    }
  })
})

describe('issueTicket', () => {
  test('creates an issued ticket and an append-only issued event', () => {
    const db = setup()

    const ticket = issueTicket(db, { amountDeni: 40000, source: 'cashout' })

    expect(ticket).toMatchObject({ amount_deni: 40000, status: 'issued', source: 'cashout' })
    expect(ticket.id).toMatch(/^[0-9]{18}$/)
    const events = db.prepare('SELECT * FROM ticket_events WHERE ticket_id = ?').all(ticket.id) as any[]
    expect(events).toHaveLength(1)
    expect(events[0].event).toBe('issued')
  })

  test('sets no expiry by default, matching the legacy server', () => {
    const db = setup()

    const ticket = issueTicket(db, { amountDeni: 100 })

    expect(ticket.expires_at).toBeNull()
  })

  test('sets an expiry when configured', () => {
    const db = setup()

    const ticket = issueTicket(db, { amountDeni: 100, expiryDays: 30 })

    expect(ticket.expires_at).not.toBeNull()
  })

  test('accepts a caller-supplied id for the legacy /create path', () => {
    const db = setup()

    const ticket = issueTicketWithId(db, { id: 'CUSTOM-1', amountDeni: 500, source: 'manual' })

    expect(ticket.id).toBe('CUSTOM-1')
    expect(getTicket(db, 'CUSTOM-1')?.amount_deni).toBe(500)
  })

  test('refuses a duplicate id', () => {
    const db = setup()
    issueTicketWithId(db, { id: 'DUP', amountDeni: 500 })

    expect(() => issueTicketWithId(db, { id: 'DUP', amountDeni: 500 })).toThrow()
  })
})

describe('redeemTicket', () => {
  test('pays out exactly once', () => {
    const db = setup()
    const ticket = issueTicket(db, { amountDeni: 40000 })

    const first = redeemTicket(db, ticket.id)
    const second = redeemTicket(db, ticket.id)

    expect(first).toEqual({ ok: true, amountDeni: 40000 })
    expect(second).toEqual({ ok: false, reason: 'already_used_or_invalid' })
    expect(getTicket(db, ticket.id)?.status).toBe('redeemed')
  })

  test('records who redeemed it and when', () => {
    const db = setup()
    const ticket = issueTicket(db, { amountDeni: 100 })

    redeemTicket(db, ticket.id, { actor: 'machine-1' })

    const row = getTicket(db, ticket.id)!
    expect(row.redeemed_at).not.toBeNull()
    expect(row.redeemed_by).toBe('machine-1')
    const events = db.prepare(`SELECT * FROM ticket_events WHERE ticket_id = ? AND event = 'redeemed'`).all(ticket.id)
    expect(events).toHaveLength(1)
  })

  test('rejects an unknown ticket', () => {
    const db = setup()

    expect(redeemTicket(db, '000000000000000000')).toEqual({
      ok: false,
      reason: 'already_used_or_invalid'
    })
  })

  test('rejects a voided ticket', () => {
    const db = setup()
    const ticket = issueTicket(db, { amountDeni: 100 })
    voidTicket(db, ticket.id, 'admin')

    expect(redeemTicket(db, ticket.id)).toEqual({ ok: false, reason: 'already_used_or_invalid' })
  })

  test('rejects an expired ticket', () => {
    const db = setup()
    const ticket = issueTicket(db, { amountDeni: 100, expiryDays: 30 })
    db.prepare(`UPDATE tickets SET expires_at = datetime('now', '-1 day') WHERE id = ?`).run(ticket.id)

    expect(redeemTicket(db, ticket.id)).toEqual({ ok: false, reason: 'expired' })
    expect(getTicket(db, ticket.id)?.status).toBe('expired')
  })

  test('a ticket with no expiry never expires', () => {
    const db = setup()
    const ticket = issueTicket(db, { amountDeni: 100 })

    expect(redeemTicket(db, ticket.id)).toEqual({ ok: true, amountDeni: 100 })
  })
})

describe('voidTicket', () => {
  test('voids an unredeemed ticket and logs the actor', () => {
    const db = setup()
    const ticket = issueTicket(db, { amountDeni: 100 })

    expect(voidTicket(db, ticket.id, 'admin')).toBe(true)

    expect(getTicket(db, ticket.id)?.status).toBe('voided')
    const events = db.prepare(`SELECT * FROM ticket_events WHERE ticket_id = ? AND event = 'voided'`).all(ticket.id) as any[]
    expect(events[0].actor).toBe('admin')
  })

  test('refuses to void a redeemed ticket', () => {
    const db = setup()
    const ticket = issueTicket(db, { amountDeni: 100 })
    redeemTicket(db, ticket.id)

    expect(voidTicket(db, ticket.id, 'admin')).toBe(false)
    expect(getTicket(db, ticket.id)?.status).toBe('redeemed')
  })
})
