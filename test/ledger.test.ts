import { describe, expect, test } from 'vitest'
import { openTestDb } from '../src/db/index.js'
import { createPlayerWithCard, findCardByUid, getCard } from '../src/domain/accounts.js'
import { balanceOf, postEntry, recomputeCache } from '../src/domain/ledger.js'

function setup() {
  const db = openTestDb()
  const { card } = createPlayerWithCard(db, { name: 'Иван Илијевски', cardUid: 'AA BB' })
  return { db, card }
}

describe('ledger', () => {
  test('balance is the sum of posted entries', () => {
    const { db, card } = setup()

    postEntry(db, { cardId: card.id, unit: 'deni', amount: 100000, kind: 'adjustment' })
    postEntry(db, { cardId: card.id, unit: 'deni', amount: -40000, kind: 'aft_debit' })

    expect(balanceOf(db, card.id, 'deni')).toBe(60000)
  })

  test('deni and points are tracked independently', () => {
    const { db, card } = setup()

    postEntry(db, { cardId: card.id, unit: 'deni', amount: 100000, kind: 'adjustment' })
    postEntry(db, { cardId: card.id, unit: 'points', amount: 340, kind: 'adjustment' })

    expect(balanceOf(db, card.id, 'deni')).toBe(100000)
    expect(balanceOf(db, card.id, 'points')).toBe(340)
  })

  test('posting an entry updates the cached balance on the card', () => {
    const { db, card } = setup()

    postEntry(db, { cardId: card.id, unit: 'deni', amount: 100000, kind: 'adjustment' })
    postEntry(db, { cardId: card.id, unit: 'deni', amount: -40000, kind: 'aft_debit' })
    postEntry(db, { cardId: card.id, unit: 'points', amount: 340, kind: 'adjustment' })

    const row = getCard(db, card.id)!
    expect(row.balance_deni).toBe(60000)
    expect(row.points).toBe(340)
  })

  test('recomputeCache rebuilds the cached balance from the ledger', () => {
    const { db, card } = setup()
    postEntry(db, { cardId: card.id, unit: 'deni', amount: 50000, kind: 'adjustment' })

    // The cache is only ever a cache: corrupt it, then prove the ledger is the truth.
    db.prepare('UPDATE cards SET balance_deni = 999, points = 777 WHERE id = ?').run(card.id)

    recomputeCache(db, card.id)

    const row = getCard(db, card.id)!
    expect(row.balance_deni).toBe(50000)
    expect(row.points).toBe(0)
  })

  test('rejects a non-integer amount', () => {
    const { db, card } = setup()

    expect(() =>
      postEntry(db, { cardId: card.id, unit: 'deni', amount: 10.5, kind: 'adjustment' })
    ).toThrow(/integer/)
  })
})

describe('accounts', () => {
  test('a card is found by its physical NFC uid', () => {
    const { db, card } = setup()

    expect(findCardByUid(db, 'AA BB')?.id).toBe(card.id)
    expect(findCardByUid(db, 'FF FF')).toBeUndefined()
  })

  test('a new card starts active with zero balance and points', () => {
    const { db, card } = setup()

    expect(card.status).toBe('active')
    expect(card.balance_deni).toBe(0)
    expect(card.points).toBe(0)
  })
})
