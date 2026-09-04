import { describe, expect, test } from 'vitest'
import { openTestDb, type Db } from '../src/db/index.js'
import { createPlayerWithCard, type Card } from '../src/domain/accounts.js'
import { creditCard } from '../src/domain/credits.js'
import { commitHold, placeHold } from '../src/domain/holds.js'
import { balanceOf, postEntry } from '../src/domain/ledger.js'
import { handleCmsMessage, type CmsContext } from '../src/wire/handlers.js'

/**
 * The firmware mints txns with `snprintf(out, 24, "SMIB-%06u", s_next_txn++)`
 * over `static uint32_t s_next_txn = 1` (cms.c) — a counter in RAM that
 * restarts at 1 on every SMIB reboot. A txn is therefore unique only within one
 * firmware boot, never for all time, and replay detection that keys on the txn
 * alone reads a post-reboot transfer as a retry and silently moves no money.
 */

function setup(startingDeni = 100000): { db: Db; card: Card; ctx: CmsContext } {
  const db = openTestDb()
  const { card } = createPlayerWithCard(db, { name: 'Иван Илијевски', cardUid: 'AA BB' })
  postEntry(db, { cardId: card.id, unit: 'deni', amount: startingDeni, kind: 'adjustment' })
  return { db, card, ctx: { db, pointsPerMkd: 0, currency: 'MKD' } }
}

const TXN = 'SMIB-000001'

describe('placeHold across a SMIB reboot', () => {
  test('debits again when the txn is reused in a new session', () => {
    const { db, card } = setup()
    placeHold(db, { cardId: card.id, txn: TXN, amountDeni: 30000, sessionId: 'boot1' })
    commitHold(db, { txn: TXN, pointsPerMkd: 0 })

    const res = placeHold(db, { cardId: card.id, txn: TXN, amountDeni: 50000, sessionId: 'boot2' })

    expect(res).toMatchObject({ ok: true, balanceDeni: 20000 })
    expect(balanceOf(db, card.id, 'deni')).toBe(20000)
  })

  test('debits again even when card, amount and txn all repeat', () => {
    // The dangerous near-miss: every field a replay check could compare is
    // identical, so only the session tells a retry from a post-reboot collision.
    const { db, card } = setup()
    placeHold(db, { cardId: card.id, txn: TXN, amountDeni: 30000, sessionId: 'boot1' })
    commitHold(db, { txn: TXN, pointsPerMkd: 0 })

    placeHold(db, { cardId: card.id, txn: TXN, amountDeni: 30000, sessionId: 'boot2' })

    expect(balanceOf(db, card.id, 'deni')).toBe(40000)
  })

  test('still treats a same-session repeat as a replay', () => {
    const { db, card } = setup()
    placeHold(db, { cardId: card.id, txn: TXN, amountDeni: 30000, sessionId: 'boot1' })

    const replay = placeHold(db, { cardId: card.id, txn: TXN, amountDeni: 30000, sessionId: 'boot1' })

    expect(replay).toMatchObject({ ok: true, balanceDeni: 70000 })
    expect(balanceOf(db, card.id, 'deni')).toBe(70000)
  })

  test('refuses a txn whose earlier hold is still unresolved', () => {
    // debit_commit and debit_rollback carry nothing but the txn, so two open
    // holds sharing one would be unresolvable. Refuse rather than guess.
    const { db, card } = setup()
    placeHold(db, { cardId: card.id, txn: TXN, amountDeni: 30000, sessionId: 'boot1' })

    const res = placeHold(db, { cardId: card.id, txn: TXN, amountDeni: 50000, sessionId: 'boot2' })

    expect(res).toEqual({ ok: false, code: 'txn_reused' })
    expect(balanceOf(db, card.id, 'deni')).toBe(70000)
  })

  test('commit settles the reused txn once per hold', () => {
    const { db, card } = setup()
    placeHold(db, { cardId: card.id, txn: TXN, amountDeni: 30000, sessionId: 'boot1' })
    commitHold(db, { txn: TXN, pointsPerMkd: 0 })
    placeHold(db, { cardId: card.id, txn: TXN, amountDeni: 50000, sessionId: 'boot2' })

    expect(commitHold(db, { txn: TXN, pointsPerMkd: 0 })).toMatchObject({ ok: true })

    const states = db
      .prepare('SELECT state FROM holds WHERE txn = ? ORDER BY id')
      .all(TXN) as Array<{ state: string }>
    expect(states.map((s) => s.state)).toEqual(['committed', 'committed'])
    expect(balanceOf(db, card.id, 'deni')).toBe(20000)
  })
})

describe('creditCard across a SMIB reboot', () => {
  test('credits again when the txn is reused in a new session', () => {
    const { db, card } = setup()
    creditCard(db, { cardId: card.id, txn: TXN, amountDeni: 20000, sessionId: 'boot1' })

    creditCard(db, { cardId: card.id, txn: TXN, amountDeni: 45000, sessionId: 'boot2' })

    expect(balanceOf(db, card.id, 'deni')).toBe(165000)
  })

  test('credits again even when card, amount and txn all repeat', () => {
    const { db, card } = setup()
    creditCard(db, { cardId: card.id, txn: TXN, amountDeni: 20000, sessionId: 'boot1' })

    creditCard(db, { cardId: card.id, txn: TXN, amountDeni: 20000, sessionId: 'boot2' })

    expect(balanceOf(db, card.id, 'deni')).toBe(140000)
  })

  test('still treats a same-session repeat as a replay', () => {
    const { db, card } = setup()
    creditCard(db, { cardId: card.id, txn: TXN, amountDeni: 20000, sessionId: 'boot1' })

    creditCard(db, { cardId: card.id, txn: TXN, amountDeni: 20000, sessionId: 'boot1' })

    expect(balanceOf(db, card.id, 'deni')).toBe(120000)
  })
})

describe('a txn is required on the wire', () => {
  function auth(ctx: CmsContext): string {
    return handleCmsMessage(ctx, { t: 'auth_req', id: 1, d: { uid: 'AA BB' } })[0]!.d.sid
  }

  test('debit_req without a txn is refused and moves no money', () => {
    const { db, card, ctx } = setup()
    const sid = auth(ctx)

    const res = handleCmsMessage(ctx, { t: 'debit_req', id: 2, d: { sid, amount: 30000 } })[0]!.d

    expect(res.ok).toBe(false)
    expect(balanceOf(db, card.id, 'deni')).toBe(100000)
    expect(db.prepare('SELECT COUNT(*) AS n FROM holds').get()).toEqual({ n: 0 })
  })

  test('a second untxned debit cannot pass as a replay of the first', () => {
    // Both used to collapse onto the single hold keyed by the empty string: the
    // second answered ok:true, the firmware credited the machine, no debit.
    const { db, card, ctx } = setup()
    const sid = auth(ctx)

    handleCmsMessage(ctx, { t: 'debit_req', id: 2, d: { sid, amount: 30000 } })
    const second = handleCmsMessage(ctx, { t: 'debit_req', id: 3, d: { sid, amount: 50000 } })[0]!.d

    expect(second.ok).toBe(false)
    expect(balanceOf(db, card.id, 'deni')).toBe(100000)
  })

  test('credit_req without a txn is refused', () => {
    const { db, card, ctx } = setup()
    const sid = auth(ctx)

    const res = handleCmsMessage(ctx, { t: 'credit_req', id: 2, d: { sid, amount: 20000 } })[0]!.d

    expect(res.ok).toBe(false)
    expect(balanceOf(db, card.id, 'deni')).toBe(100000)
  })

  test('a txn longer than the firmware buffer is refused', () => {
    // char txn[24] in cms.c: anything longer comes back truncated, and a
    // truncated txn resolves the wrong hold on commit.
    const { db, card, ctx } = setup()
    const sid = auth(ctx)

    const res = handleCmsMessage(ctx, {
      t: 'debit_req',
      id: 2,
      d: { sid, amount: 30000, txn: 'S'.repeat(24) }
    })[0]!.d

    expect(res.ok).toBe(false)
    expect(balanceOf(db, card.id, 'deni')).toBe(100000)
  })

  test('debit_commit without a txn is refused', () => {
    const { ctx } = setup()
    auth(ctx)

    const res = handleCmsMessage(ctx, { t: 'debit_commit', id: 2, d: {} })[0]!.d

    expect(res.ok).toBe(false)
  })

  test('a full reboot cycle over the wire debits both transfers', () => {
    const { db, card, ctx } = setup()

    const sid1 = auth(ctx)
    handleCmsMessage(ctx, { t: 'debit_req', id: 2, d: { sid: sid1, amount: 30000, txn: TXN } })
    handleCmsMessage(ctx, { t: 'debit_commit', id: 3, d: { txn: TXN } })
    expect(balanceOf(db, card.id, 'deni')).toBe(70000)

    // SMIB power-cycles: new session, and s_next_txn is back to 1.
    const sid2 = auth(ctx)
    const res = handleCmsMessage(ctx, {
      t: 'debit_req',
      id: 4,
      d: { sid: sid2, amount: 50000, txn: TXN }
    })[0]!.d

    expect(res.ok).toBe(true)
    expect(balanceOf(db, card.id, 'deni')).toBe(20000)
  })
})
