import { describe, expect, test } from 'vitest'
import { openTestDb } from '../src/db/index.js'
import { createPlayerWithCard, getCard } from '../src/domain/accounts.js'
import { balanceOf, postEntry } from '../src/domain/ledger.js'
import { commitHold, placeHold, rollbackHold } from '../src/domain/holds.js'
import { pointsFor } from '../src/domain/points.js'

function setup(startingDeni = 100000) {
  const db = openTestDb()
  const { card } = createPlayerWithCard(db, { name: 'Иван Илијевски', cardUid: 'AA BB' })
  if (startingDeni > 0) {
    postEntry(db, { cardId: card.id, unit: 'deni', amount: startingDeni, kind: 'adjustment' })
  }
  return { db, card }
}

describe('points rule', () => {
  test('awards floor(amount_deni * pointsPerMkd / 100)', () => {
    expect(pointsFor(40000, 1)).toBe(400)
    expect(pointsFor(40000, 2)).toBe(800)
    expect(pointsFor(150, 1)).toBe(1) // 1.5 MKD -> 1 point, floored
    expect(pointsFor(99, 1)).toBe(0)
  })

  test('a rate of zero disables earning', () => {
    expect(pointsFor(1_000_000, 0)).toBe(0)
  })
})

describe('placeHold', () => {
  test('debits the card and records a held hold', () => {
    const { db, card } = setup()

    const res = placeHold(db, { cardId: card.id, txn: 'T1', amountDeni: 40000 })

    expect(res).toMatchObject({ ok: true, balanceDeni: 60000 })
    expect(balanceOf(db, card.id, 'deni')).toBe(60000)
    const hold = db.prepare('SELECT * FROM holds WHERE txn = ?').get('T1') as { state: string }
    expect(hold.state).toBe('held')
  })

  test('refuses more than the balance and moves no money', () => {
    const { db, card } = setup()

    const res = placeHold(db, { cardId: card.id, txn: 'T1', amountDeni: 999999 })

    expect(res).toEqual({ ok: false, code: 'insufficient' })
    expect(balanceOf(db, card.id, 'deni')).toBe(100000)
    expect(db.prepare('SELECT * FROM holds WHERE txn = ?').get('T1')).toBeUndefined()
  })

  test('refuses a non-positive amount', () => {
    const { db, card } = setup()

    expect(placeHold(db, { cardId: card.id, txn: 'T1', amountDeni: 0 })).toEqual({
      ok: false,
      code: 'insufficient'
    })
    expect(balanceOf(db, card.id, 'deni')).toBe(100000)
  })

  test('is idempotent by txn — a replayed hold does not double-debit', () => {
    const { db, card } = setup()

    placeHold(db, { cardId: card.id, txn: 'T1', amountDeni: 40000 })
    const replay = placeHold(db, { cardId: card.id, txn: 'T1', amountDeni: 40000 })

    expect(replay).toMatchObject({ ok: true, balanceDeni: 60000 })
    expect(balanceOf(db, card.id, 'deni')).toBe(60000)
  })
})

describe('commitHold', () => {
  test('marks the hold committed and awards points', () => {
    const { db, card } = setup()
    placeHold(db, { cardId: card.id, txn: 'T1', amountDeni: 40000 })

    const res = commitHold(db, { txn: 'T1', pointsPerMkd: 1 })

    expect(res).toMatchObject({ ok: true, balanceDeni: 60000, points: 400 })
    const hold = db.prepare('SELECT * FROM holds WHERE txn = ?').get('T1') as { state: string }
    expect(hold.state).toBe('committed')
  })

  test('is idempotent — a replayed commit returns ok and does not double-award points', () => {
    const { db, card } = setup()
    placeHold(db, { cardId: card.id, txn: 'T1', amountDeni: 40000 })

    commitHold(db, { txn: 'T1', pointsPerMkd: 1 })
    const replay = commitHold(db, { txn: 'T1', pointsPerMkd: 1 })

    // The firmware retries commit forever after a successful AFT; it must keep succeeding.
    expect(replay).toMatchObject({ ok: true, balanceDeni: 60000, points: 400 })
    expect(getCard(db, card.id)!.points).toBe(400)
  })

  test('rejects an unknown txn', () => {
    const { db } = setup()

    expect(commitHold(db, { txn: 'NOPE', pointsPerMkd: 1 })).toEqual({
      ok: false,
      code: 'unknown_txn'
    })
  })

  test('refuses to commit a rolled-back hold', () => {
    const { db, card } = setup()
    placeHold(db, { cardId: card.id, txn: 'T1', amountDeni: 40000 })
    rollbackHold(db, { txn: 'T1' })

    expect(commitHold(db, { txn: 'T1', pointsPerMkd: 1 })).toEqual({ ok: false, code: 'conflict' })
    expect(balanceOf(db, card.id, 'deni')).toBe(100000)
  })
})

describe('rollbackHold', () => {
  test('restores the balance exactly once', () => {
    const { db, card } = setup()
    placeHold(db, { cardId: card.id, txn: 'T1', amountDeni: 40000 })

    const res = rollbackHold(db, { txn: 'T1' })

    expect(res).toMatchObject({ ok: true, balanceDeni: 100000 })
    expect(balanceOf(db, card.id, 'deni')).toBe(100000)
  })

  test('is idempotent — a replayed rollback does not double-credit', () => {
    const { db, card } = setup()
    placeHold(db, { cardId: card.id, txn: 'T1', amountDeni: 40000 })

    rollbackHold(db, { txn: 'T1' })
    const replay = rollbackHold(db, { txn: 'T1' })

    expect(replay).toMatchObject({ ok: true, balanceDeni: 100000 })
    expect(balanceOf(db, card.id, 'deni')).toBe(100000)
  })

  test('rejects an unknown txn', () => {
    const { db } = setup()

    expect(rollbackHold(db, { txn: 'NOPE' })).toEqual({ ok: false, code: 'unknown_txn' })
  })

  test('never gives money back once the hold is committed', () => {
    const { db, card } = setup()
    placeHold(db, { cardId: card.id, txn: 'T1', amountDeni: 40000 })
    commitHold(db, { txn: 'T1', pointsPerMkd: 1 })

    const res = rollbackHold(db, { txn: 'T1' })

    // Matches the prototype: reports ok, but the committed money stays gone.
    expect(res).toMatchObject({ ok: true, balanceDeni: 60000 })
    expect(balanceOf(db, card.id, 'deni')).toBe(60000)
  })
})
