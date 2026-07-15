import { describe, expect, test } from 'vitest'
import { openTestDb } from '../src/db/index.js'
import { seed } from '../src/db/seed.js'
import { createPlayerWithCard } from '../src/domain/accounts.js'
import { balanceOf, postEntry } from '../src/domain/ledger.js'
import { handleCmsMessage, type CmsContext } from '../src/wire/handlers.js'
import { MAX_ERR_MSG_BYTES } from '../src/wire/limits.js'

function setup(deni = 100000, points = 100, pointsPerMkd = 0) {
  const db = openTestDb()
  seed(db, { adminPassword: 'test' })
  const { card } = createPlayerWithCard(db, { name: 'Иван Илијевски', cardUid: 'AA BB' })
  if (deni > 0) postEntry(db, { cardId: card.id, unit: 'deni', amount: deni, kind: 'adjustment' })
  if (points > 0) postEntry(db, { cardId: card.id, unit: 'points', amount: points, kind: 'adjustment' })
  const ctx: CmsContext = { db, pointsPerMkd, currency: 'MKD' }
  return { db, card, ctx }
}

/** Mirrors selftest.py's rpc(): returns the first reply's `d`, or undefined. */
function rpc(ctx: CmsContext, t: string, id: number, d: Record<string, unknown> = {}): any {
  const replies = handleCmsMessage(ctx, { t, id, d })
  return replies[0]?.d
}

describe('session messages', () => {
  test('hello is acknowledged', () => {
    const { ctx } = setup()

    const replies = handleCmsMessage(ctx, { t: 'hello', id: 1, d: { dev: 'smib-1', fw: '0.1.0', proto: 1 } })

    expect(replies).toHaveLength(1)
    expect(replies[0]).toMatchObject({ t: 'hello_res', id: 1, d: { ok: true } })
  })

  test('ping is answered with pong echoing the request id', () => {
    const { ctx } = setup()

    const replies = handleCmsMessage(ctx, { t: 'ping', id: 7, d: {} })

    expect(replies[0]).toEqual({ t: 'pong', id: 7, d: {} })
  })

  test('an unknown message type is ignored rather than crashing the link', () => {
    const { ctx } = setup()

    expect(handleCmsMessage(ctx, { t: 'nonsense', id: 1, d: {} })).toEqual([])
  })

  test('auth of an unknown card is rejected and the tap is recorded for staff', () => {
    const { db, ctx } = setup()

    const res = rpc(ctx, 'auth_req', 1, { uid: 'FF EE' })

    expect(res.ok).toBe(false)
    expect(res.err.code).toBe('unknown_card')
    const tap = db.prepare('SELECT * FROM unknown_card_taps WHERE card_uid = ?').get('FF EE') as any
    expect(tap.count).toBe(1)
  })

  test('repeated unknown taps are counted, not duplicated', () => {
    const { db, ctx } = setup()

    rpc(ctx, 'auth_req', 1, { uid: 'FF EE' })
    rpc(ctx, 'auth_req', 2, { uid: 'FF EE' })

    const tap = db.prepare('SELECT * FROM unknown_card_taps WHERE card_uid = ?').get('FF EE') as any
    expect(tap.count).toBe(2)
  })

  test('auth of a blocked card is rejected', () => {
    const { db, ctx, card } = setup()
    db.prepare(`UPDATE cards SET status = 'blocked' WHERE id = ?`).run(card.id)

    const res = rpc(ctx, 'auth_req', 1, { uid: 'AA BB' })

    expect(res.ok).toBe(false)
    expect(res.err.code).toBe('unknown_card')
  })

  test('logout is fire-and-forget and closes the session', () => {
    const { db, ctx } = setup()
    const sid = rpc(ctx, 'auth_req', 1, { uid: 'AA BB' }).sid

    const replies = handleCmsMessage(ctx, { t: 'logout', id: 2, d: { sid, reason: 'cashout' } })

    expect(replies).toEqual([])
    const row = db.prepare('SELECT * FROM sessions WHERE sid = ?').get(sid) as any
    expect(row.close_reason).toBe('cashout')
  })

  test('error messages fit the firmware err_msg[96] buffer', () => {
    const { ctx } = setup()

    const res = rpc(ctx, 'auth_req', 1, { uid: 'FF EE' })

    expect(Buffer.byteLength(res.err.msg, 'utf8')).toBeLessThanOrEqual(MAX_ERR_MSG_BYTES)
  })
})

describe('funds messages reject work without a valid session', () => {
  test('debit with an unknown sid is denied', () => {
    const { ctx } = setup()

    const res = rpc(ctx, 'debit_req', 1, { sid: 's-bogus', txn: 'T1', amount: 100 })

    expect(res.ok).toBe(false)
    expect(res.txn).toBe('T1')
  })

  test('order with an unknown sid is denied', () => {
    const { ctx } = setup()

    const res = rpc(ctx, 'order_req', 1, { sid: 's-bogus', pay: 'cash', items: [{ drink: 1, qty: 1 }] })

    expect(res.ok).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Ported verbatim from tools/host_sim/selftest.py :: test_cms.
// This is the contract the ESP32 firmware is built against.
//
// Runs with pointsPerMkd = 0 because the Python prototype never awarded points
// on commit; with earning on, the later `points === 20` assertion would drift.
// ---------------------------------------------------------------------------
describe('selftest.py test_cms golden vectors', () => {
  test('the full CMS flow matches the prototype', () => {
    const { db, card, ctx } = setup(100000, 100, 0)

    const auth = rpc(ctx, 'auth_req', 1, { uid: 'AA BB' })
    expect(auth.ok).toBe(true)
    expect(auth.player.balance).toBe(100000)
    expect(auth.player.cur).toBe('MKD')
    const sid = auth.sid

    // Debit hold + commit (idempotent)
    let deb = rpc(ctx, 'debit_req', 2, { sid, txn: 'T1', amount: 40000 })
    expect(deb.ok).toBe(true)
    expect(deb.balance).toBe(60000)
    expect(rpc(ctx, 'debit_commit', 3, { txn: 'T1' }).ok).toBe(true)
    expect(rpc(ctx, 'debit_commit', 4, { txn: 'T1' }).ok).toBe(true) // repeat commit ok

    // Rollback restores exactly once
    deb = rpc(ctx, 'debit_req', 5, { sid, txn: 'T2', amount: 10000 })
    expect(deb.balance).toBe(50000)
    expect(rpc(ctx, 'debit_rollback', 6, { txn: 'T2' }).ok).toBe(true)
    expect(balanceOf(db, card.id, 'deni')).toBe(60000)
    expect(rpc(ctx, 'debit_rollback', 7, { txn: 'T2' }).ok).toBe(true) // idempotent
    expect(balanceOf(db, card.id, 'deni')).toBe(60000)

    // Overdraft refused
    expect(rpc(ctx, 'debit_req', 8, { sid, txn: 'T3', amount: 999999 }).ok).toBe(false)

    // Order with cash, then with points
    let order = rpc(ctx, 'order_req', 9, { sid, pay: 'cash', items: [{ drink: 1, qty: 2 }] })
    expect(order.ok).toBe(true)
    expect(order.balance).toBe(60000 - 16000)
    order = rpc(ctx, 'order_req', 10, { sid, pay: 'points', items: [{ drink: 2, qty: 1 }] })
    expect(order.ok).toBe(true)
    expect(order.points).toBe(20)

    // Unavailable drink -> empty order
    expect(rpc(ctx, 'order_req', 11, { sid, pay: 'cash', items: [{ drink: 5, qty: 1 }] }).ok).toBe(false)

    // Cashout credit: applied once, idempotent by txn
    const bal = balanceOf(db, card.id, 'deni')
    let cred = rpc(ctx, 'credit_req', 12, { sid, txn: 'C1', amount: 25000 })
    expect(cred.ok).toBe(true)
    expect(cred.balance).toBe(bal + 25000)
    cred = rpc(ctx, 'credit_req', 13, { sid, txn: 'C1', amount: 25000 })
    expect(cred.ok).toBe(true)
    expect(cred.balance).toBe(bal + 25000) // repeat: no double add
    expect(balanceOf(db, card.id, 'deni')).toBe(bal + 25000)
  })

  test('menu_res survives UTF-8 round-tripping', () => {
    const { ctx } = setup()

    const res = rpc(ctx, 'menu_req', 1, {})

    expect(res.ok).toBe(true)
    expect(JSON.stringify(res)).toContain('Кафе')
  })

  test('commit refuses a rolled-back txn with conflict', () => {
    const { ctx } = setup()
    const sid = rpc(ctx, 'auth_req', 1, { uid: 'AA BB' }).sid
    rpc(ctx, 'debit_req', 2, { sid, txn: 'T1', amount: 1000 })
    rpc(ctx, 'debit_rollback', 3, { txn: 'T1' })

    const res = rpc(ctx, 'debit_commit', 4, { txn: 'T1' })

    expect(res.ok).toBe(false)
    expect(res.err.code).toBe('conflict')
  })

  test('commit and rollback of an unknown txn report unknown_txn', () => {
    const { ctx } = setup()

    expect(rpc(ctx, 'debit_commit', 1, { txn: 'NOPE' }).err.code).toBe('unknown_txn')
    expect(rpc(ctx, 'debit_rollback', 2, { txn: 'NOPE' }).err.code).toBe('unknown_txn')
  })
})

describe('points earning is applied when configured', () => {
  test('commit awards points at the configured rate', () => {
    const { ctx } = setup(100000, 0, 1)
    const sid = rpc(ctx, 'auth_req', 1, { uid: 'AA BB' }).sid
    rpc(ctx, 'debit_req', 2, { sid, txn: 'T1', amount: 40000 })

    const res = rpc(ctx, 'debit_commit', 3, { txn: 'T1' })

    expect(res.points).toBe(400)
  })
})
