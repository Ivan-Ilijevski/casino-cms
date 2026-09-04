import { describe, expect, test } from 'vitest'
import { openTestDb } from '../src/db/index.js'
import { createPlayerWithCard, findCardByUid } from '../src/domain/accounts.js'
import { canonUid } from '../src/domain/pos.js'

describe('canonUid', () => {
  test('normalises the RC522 terminal format', () => {
    // rc522_helpers.c writes "%02X " per byte, trailing space stripped.
    expect(canonUid('9C 76 5A F4')).toBe('9C765AF4')
  })

  test('normalises the Web NFC / Chrome format', () => {
    // NDEFReadingEvent.serialNumber is lowercase, colon-separated.
    expect(canonUid('9c:76:5a:f4')).toBe('9C765AF4')
  })

  test('the two readers agree on the same card', () => {
    expect(canonUid('9c:76:5a:f4')).toBe(canonUid('9C 76 5A F4'))
  })

  test('handles 7-byte NTAG uids', () => {
    expect(canonUid('04:a2:b3:c4:d5:e6:f7')).toBe('04A2B3C4D5E6F7')
    expect(canonUid('04 A2 B3 C4 D5 E6 F7')).toBe('04A2B3C4D5E6F7')
  })

  test('accepts dashes and stray whitespace', () => {
    expect(canonUid(' 9c-76-5a-f4 ')).toBe('9C765AF4')
  })

  test('rejects anything that is not a plausible uid', () => {
    expect(() => canonUid('')).toThrow()
    expect(() => canonUid('nonsense')).toThrow()
    expect(() => canonUid('9C 76 5A ZZ')).toThrow() // ZZ is not hex
    expect(() => canonUid('9C 76 5')).toThrow() // half a byte
    expect(() => canonUid('AA'.repeat(11))).toThrow() // longer than RC522_PICC_UID_SIZE_MAX
  })

  test('accepts the short uid the firmware golden vectors use', () => {
    // tools/host_sim/selftest.py drives auth_req with uid="AA BB". Real cards are
    // 4/7/10 bytes, but rejecting shorter would fail the contract's own vectors
    // for no security gain — an unregistered uid simply matches no card.
    expect(canonUid('AA BB')).toBe('AABB')
  })
})

describe('card lookup is reader-agnostic', () => {
  test('a card registered from a terminal tap is found by a Web NFC tap', () => {
    const db = openTestDb()
    // Registered from the terminal's spelling...
    const { card } = createPlayerWithCard(db, { name: 'Иван', cardUid: '9C 76 5A F4' })

    // ...and found by Chrome's spelling of the same physical card.
    expect(findCardByUid(db, '9c:76:5a:f4')?.id).toBe(card.id)
    expect(findCardByUid(db, '9C 76 5A F4')?.id).toBe(card.id)
  })

  test('a card registered from a Web NFC tap is found by the terminal', () => {
    const db = openTestDb()
    const { card } = createPlayerWithCard(db, { name: 'Иван', cardUid: '04:a2:b3:c4:d5:e6:f7' })

    expect(findCardByUid(db, '04 A2 B3 C4 D5 E6 F7')?.id).toBe(card.id)
  })

  test('an unknown card is still not found', () => {
    const db = openTestDb()
    createPlayerWithCard(db, { name: 'Иван', cardUid: '9C 76 5A F4' })

    expect(findCardByUid(db, 'AA BB CC DD')).toBeUndefined()
  })

  test('a malformed uid does not throw the caller — it just finds nothing', () => {
    const db = openTestDb()

    // auth_req can carry junk off the wire; that must not kill the link.
    expect(findCardByUid(db, 'garbage')).toBeUndefined()
  })

  test('the same physical card cannot be registered twice in another spelling', () => {
    const db = openTestDb()
    createPlayerWithCard(db, { name: 'Иван', cardUid: '9C 76 5A F4' })

    expect(() => createPlayerWithCard(db, { name: 'Друг', cardUid: '9c:76:5a:f4' })).toThrow()
  })
})
