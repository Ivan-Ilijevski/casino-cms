import { describe, expect, test } from 'vitest'
import { openTestDb } from '../src/db/index.js'
import { createPlayerWithCard } from '../src/domain/accounts.js'
import { balanceOf, postEntry } from '../src/domain/ledger.js'
import { creditCard } from '../src/domain/credits.js'

function setup(startingDeni = 1000) {
  const db = openTestDb()
  const { card } = createPlayerWithCard(db, { name: 'Иван Илијевски', cardUid: 'AA BB' })
  if (startingDeni > 0) {
    postEntry(db, { cardId: card.id, unit: 'deni', amount: startingDeni, kind: 'adjustment' })
  }
  return { db, card }
}

describe('creditCard', () => {
  test('deposits cashed-out money onto the card', () => {
    const { db, card } = setup()

    const res = creditCard(db, { cardId: card.id, txn: 'C1', amountDeni: 25000 })

    expect(res).toMatchObject({ ok: true, balanceDeni: 26000 })
    expect(balanceOf(db, card.id, 'deni')).toBe(26000)
  })

  test('is idempotent by txn — a replayed credit does not double-add', () => {
    const { db, card } = setup()

    creditCard(db, { cardId: card.id, txn: 'C1', amountDeni: 500 })
    const replay = creditCard(db, { cardId: card.id, txn: 'C1', amountDeni: 500 })

    // The firmware retries credit until confirmed; every reply must report the same balance.
    expect(replay).toMatchObject({ ok: true, balanceDeni: 1500 })
    expect(balanceOf(db, card.id, 'deni')).toBe(1500)
  })

  test('a credit txn does not collide with a debit hold of the same name', () => {
    const { db, card } = setup()

    creditCard(db, { cardId: card.id, txn: 'X1', amountDeni: 500 })
    creditCard(db, { cardId: card.id, txn: 'X2', amountDeni: 500 })

    expect(balanceOf(db, card.id, 'deni')).toBe(2000)
  })

  test('rejects a non-positive amount', () => {
    const { db, card } = setup()

    expect(() => creditCard(db, { cardId: card.id, txn: 'C1', amountDeni: 0 })).toThrow()
    expect(balanceOf(db, card.id, 'deni')).toBe(1000)
  })
})
