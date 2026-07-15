import { describe, expect, test } from 'vitest'
import { openTestDb, type Db } from '../src/db/index.js'
import { seed } from '../src/db/seed.js'
import { createPlayerWithCard } from '../src/domain/accounts.js'
import { balanceOf, postEntry } from '../src/domain/ledger.js'
import { getOrder } from '../src/domain/orders.js'
import {
  confirmIntent,
  createIntent,
  getIntent,
  hasPin,
  isPinLocked,
  PIN_MAX_ATTEMPTS,
  setPin,
  verifyPin
} from '../src/domain/pos.js'

const TERMINAL_UID = '9C 76 5A F4'
const NFC_UID = '9c:76:5a:f4' // the same card, as Chrome spells it

function setup(opts: { deni?: number; points?: number; pin?: string | null } = {}) {
  const db = openTestDb()
  seed(db, { adminPassword: 'test' })
  const { card } = createPlayerWithCard(db, { name: 'Иван Илијевски', cardUid: TERMINAL_UID })
  postEntry(db, { cardId: card.id, unit: 'deni', amount: opts.deni ?? 100000, kind: 'adjustment' })
  postEntry(db, { cardId: card.id, unit: 'points', amount: opts.points ?? 500, kind: 'adjustment' })
  if (opts.pin !== null) setPin(db, card.id, opts.pin ?? '1234')
  return { db, card }
}

const CART = [{ drink: 1, qty: 2 }] // 2x Кафе = 16000 deni / 100 points

function intent(db: Db, extra: Record<string, unknown> = {}) {
  return createIntent(db, { cardUid: NFC_UID, items: CART, pay: 'cash', staff: 'barman', ...extra })
}

describe('PIN storage', () => {
  test('a PIN is stored hashed, never in the clear', () => {
    const { db, card } = setup({ pin: '4321' })

    const row = db.prepare('SELECT pin_hash FROM cards WHERE id = ?').get(card.id) as any
    expect(row.pin_hash).not.toContain('4321')
    expect(row.pin_hash.startsWith('scrypt$')).toBe(true)
  })

  test('rejects a PIN that is not exactly 4 digits', () => {
    const { db, card } = setup()

    expect(() => setPin(db, card.id, '123')).toThrow()
    expect(() => setPin(db, card.id, '12345')).toThrow()
    expect(() => setPin(db, card.id, 'abcd')).toThrow()
  })

  test('hasPin reports whether a card can be used at the POS', () => {
    const { db, card } = setup({ pin: null })
    expect(hasPin(db, card.id)).toBe(false)

    setPin(db, card.id, '1234')
    expect(hasPin(db, card.id)).toBe(true)
  })

  test('verifyPin accepts the right PIN and rejects the wrong one', () => {
    const { db, card } = setup({ pin: '1234' })

    expect(verifyPin(db, card.id, '1234').ok).toBe(true)
    expect(verifyPin(db, card.id, '9999').ok).toBe(false)
  })

  test('locks the card after too many wrong PINs', () => {
    const { db, card } = setup({ pin: '1234' })

    for (let i = 0; i < PIN_MAX_ATTEMPTS; i++) verifyPin(db, card.id, '0000')

    // 10^4 combinations would fall in minutes without this.
    expect(isPinLocked(db, card.id)).toBe(true)
  })

  test('a correct PIN resets the attempt counter', () => {
    const { db, card } = setup({ pin: '1234' })
    verifyPin(db, card.id, '0000')
    verifyPin(db, card.id, '0000')

    verifyPin(db, card.id, '1234')
    for (let i = 0; i < PIN_MAX_ATTEMPTS - 1; i++) verifyPin(db, card.id, '0000')

    expect(isPinLocked(db, card.id)).toBe(false)
  })

  test('setting a new PIN clears a lockout', () => {
    const { db, card } = setup({ pin: '1234' })
    for (let i = 0; i < PIN_MAX_ATTEMPTS; i++) verifyPin(db, card.id, '0000')

    setPin(db, card.id, '5678')

    expect(isPinLocked(db, card.id)).toBe(false)
  })
})

describe('createIntent', () => {
  test('prices the cart and resolves the card from a Web NFC uid', () => {
    const { db, card } = setup()

    const res = intent(db)

    expect(res).toMatchObject({
      ok: true,
      totalDeni: 16000,
      player: { name: 'Иван Илијевски', balance: 100000 }
    })
    if (!res.ok) throw new Error('unreachable')
    expect(getIntent(db, res.intentId)?.card_id).toBe(card.id)
  })

  test('does not charge anything — pricing only', () => {
    const { db, card } = setup()

    intent(db)

    expect(balanceOf(db, card.id, 'deni')).toBe(100000)
    expect(db.prepare('SELECT COUNT(*) AS n FROM orders').get()).toEqual({ n: 0 })
  })

  test('refuses an unknown card', () => {
    const { db } = setup()

    expect(intent(db, { cardUid: 'AA BB CC DD' })).toEqual({ ok: false, code: 'unknown_card' })
  })

  test('refuses a blocked card', () => {
    const { db, card } = setup()
    db.prepare(`UPDATE cards SET status = 'blocked' WHERE id = ?`).run(card.id)

    expect(intent(db)).toEqual({ ok: false, code: 'card_blocked' })
  })

  test('refuses a card with no PIN set', () => {
    const { db } = setup({ pin: null })

    // Otherwise a PIN-less card would silently never be spot-checked.
    expect(intent(db)).toEqual({ ok: false, code: 'no_pin_set' })
  })

  test('refuses a PIN-locked card', () => {
    const { db, card } = setup({ pin: '1234' })
    for (let i = 0; i < PIN_MAX_ATTEMPTS; i++) verifyPin(db, card.id, '0000')

    expect(intent(db)).toEqual({ ok: false, code: 'pin_locked' })
  })

  test('refuses an empty cart', () => {
    const { db } = setup()

    expect(intent(db, { items: [] })).toEqual({ ok: false, code: 'empty' })
  })

  test('refuses a cart the card cannot afford', () => {
    const { db } = setup({ deni: 1000 })

    expect(intent(db)).toEqual({ ok: false, code: 'insufficient' })
  })

  test('prices a points cart against the points balance', () => {
    const { db } = setup({ points: 40 })

    expect(intent(db, { pay: 'points' })).toEqual({ ok: false, code: 'insufficient' })
  })

  test('the PIN roll is server-side and forceable for tests', () => {
    const { db } = setup()

    const on = intent(db, { forcePin: true })
    const off = intent(db, { forcePin: false })

    expect(on).toMatchObject({ ok: true, pinRequired: true })
    expect(off).toMatchObject({ ok: true, pinRequired: false })
  })

  test('the PIN requirement is persisted, not merely returned', () => {
    const { db } = setup()
    const res = intent(db, { forcePin: true })
    if (!res.ok) throw new Error('unreachable')

    // The client must not be able to influence this after the fact.
    expect(getIntent(db, res.intentId)?.pin_required).toBe(1)
  })

  test('roughly one payment in eight is PIN-checked', () => {
    const { db } = setup({ deni: 100_000_000 })

    let checked = 0
    const runs = 2000
    for (let i = 0; i < runs; i++) {
      const res = intent(db)
      if (res.ok && res.pinRequired) checked++
    }

    // Binomial(2000, 1/8): mean 250, sd ~14.8. This window is ~±6 sd, so it
    // catches a wrong rate (1/4, 1/16) without being flaky.
    expect(checked).toBeGreaterThan(160)
    expect(checked).toBeLessThan(340)
  })
})

describe('confirmIntent', () => {
  test('charges the card and creates a pos order', () => {
    const { db, card } = setup()
    const res = intent(db, { forcePin: false })
    if (!res.ok) throw new Error('unreachable')

    const done = confirmIntent(db, { intentId: res.intentId })

    expect(done).toMatchObject({ ok: true, balanceDeni: 84000 })
    expect(balanceOf(db, card.id, 'deni')).toBe(84000)
    if (!done.ok) throw new Error('unreachable')
    expect(getOrder(db, done.orderId)).toMatchObject({ source: 'pos', status: 'received' })
  })

  test('refuses to charge without the PIN when the intent demands one', () => {
    const { db, card } = setup()
    const res = intent(db, { forcePin: true })
    if (!res.ok) throw new Error('unreachable')

    // The whole point: a client that just omits the pin must not get a free pass.
    const done = confirmIntent(db, { intentId: res.intentId })

    expect(done).toEqual({ ok: false, code: 'pin_required' })
    expect(balanceOf(db, card.id, 'deni')).toBe(100000)
  })

  test('refuses a wrong PIN and charges nothing', () => {
    const { db, card } = setup({ pin: '1234' })
    const res = intent(db, { forcePin: true })
    if (!res.ok) throw new Error('unreachable')

    const done = confirmIntent(db, { intentId: res.intentId, pin: '9999' })

    expect(done).toMatchObject({ ok: false, code: 'pin_wrong' })
    expect(balanceOf(db, card.id, 'deni')).toBe(100000)
  })

  test('accepts the right PIN', () => {
    const { db, card } = setup({ pin: '1234' })
    const res = intent(db, { forcePin: true })
    if (!res.ok) throw new Error('unreachable')

    expect(confirmIntent(db, { intentId: res.intentId, pin: '1234' }).ok).toBe(true)
    expect(balanceOf(db, card.id, 'deni')).toBe(84000)
  })

  test('an intent is single-use', () => {
    const { db, card } = setup()
    const res = intent(db, { forcePin: false })
    if (!res.ok) throw new Error('unreachable')

    confirmIntent(db, { intentId: res.intentId })
    const replay = confirmIntent(db, { intentId: res.intentId })

    expect(replay).toEqual({ ok: false, code: 'intent_used' })
    expect(balanceOf(db, card.id, 'deni')).toBe(84000) // charged once
  })

  test('an expired intent cannot be charged', () => {
    const { db, card } = setup()
    const res = intent(db, { forcePin: false })
    if (!res.ok) throw new Error('unreachable')
    db.prepare(`UPDATE pos_intents SET expires_at = datetime('now', '-1 second') WHERE id = ?`).run(
      res.intentId
    )

    expect(confirmIntent(db, { intentId: res.intentId })).toEqual({ ok: false, code: 'intent_expired' })
    expect(balanceOf(db, card.id, 'deni')).toBe(100000)
  })

  test('rejects an unknown intent', () => {
    const { db } = setup()

    expect(confirmIntent(db, { intentId: 'nope' })).toEqual({ ok: false, code: 'unknown_intent' })
  })

  test('wrong PINs on confirm eventually lock the card', () => {
    const { db, card } = setup({ pin: '1234' })

    for (let i = 0; i < PIN_MAX_ATTEMPTS; i++) {
      const res = intent(db, { forcePin: true })
      if (!res.ok) throw new Error('unreachable')
      confirmIntent(db, { intentId: res.intentId, pin: '0000' })
    }

    expect(isPinLocked(db, card.id)).toBe(true)
    expect(intent(db)).toEqual({ ok: false, code: 'pin_locked' })
  })

  test('a points payment deducts points, not cash', () => {
    const { db, card } = setup()
    const res = createIntent(db, {
      cardUid: NFC_UID,
      items: CART,
      pay: 'points',
      staff: 'barman',
      forcePin: false
    })
    if (!res.ok) throw new Error('unreachable')

    confirmIntent(db, { intentId: res.intentId })

    expect(balanceOf(db, card.id, 'points')).toBe(400) // 500 - 100
    expect(balanceOf(db, card.id, 'deni')).toBe(100000)
  })
})
