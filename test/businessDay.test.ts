import { describe, expect, test } from 'vitest'
import { loadConfig } from '../src/config.js'
import { businessDay } from '../src/domain/businessDay.js'

/** Every timestamp in this database is UTC; these assert what LOCAL day it lands on. */
const day = (iso: string, tz = 'Europe/Skopje') => businessDay(tz, new Date(iso))

describe('businessDay', () => {
  test('a late-evening sale is already tomorrow in Skopje, in either season', () => {
    // Summer, UTC+2: 21:30Z is 23:30 local — still today.
    expect(day('2026-07-07T21:30:00Z')).toBe('2026-07-07')
    // ...and 23:30Z is 01:30 local, tomorrow's receipt.
    expect(day('2026-07-07T23:30:00Z')).toBe('2026-07-08')
    // Winter, UTC+1: 23:30Z is 00:30 local, so it rolls too — just an hour later.
    expect(day('2026-01-15T23:30:00Z')).toBe('2026-01-16')
    expect(day('2026-01-15T22:30:00Z')).toBe('2026-01-15')
  })

  test('the boundary moves with DST rather than sitting at a fixed offset', () => {
    // Spring forward. The same UTC clock time, one day apart, lands on days that are
    // TWO apart — 22:30Z is 23:30 local before the change and 00:30 local after it.
    expect(day('2026-03-28T22:30:00Z')).toBe('2026-03-28')
    expect(day('2026-03-29T22:30:00Z')).toBe('2026-03-30')
    // Fall back. The same UTC clock time, one day apart, lands on the SAME day.
    // A hardcoded +2 gets this one wrong, which is why this goes through tzdata.
    expect(day('2026-10-24T22:30:00Z')).toBe('2026-10-25')
    expect(day('2026-10-25T22:30:00Z')).toBe('2026-10-25')
  })

  test('rolls the year over at local midnight, not UTC midnight', () => {
    expect(day('2025-12-31T22:30:00Z')).toBe('2025-12-31')
    expect(day('2025-12-31T23:30:00Z')).toBe('2026-01-01')
  })

  test('zero-pads month and day so the string sorts as a date', () => {
    expect(day('2026-03-05T12:00:00Z')).toBe('2026-03-05')
  })

  test('honours the zone it is given', () => {
    // The same instant, two zones, two different days.
    expect(day('2026-07-07T23:30:00Z', 'UTC')).toBe('2026-07-07')
    expect(day('2026-07-07T23:30:00Z', 'Europe/Skopje')).toBe('2026-07-08')
  })

  test('defaults to now, so callers that do not care need not pass a clock', () => {
    expect(businessDay('Europe/Skopje')).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})

describe('CMS_TIME_ZONE', () => {
  test('defaults to the venue, so nothing has to be configured to get the right day', () => {
    expect(loadConfig({}).timeZone).toBe('Europe/Skopje')
  })

  test('takes a zone from the environment', () => {
    expect(loadConfig({ CMS_TIME_ZONE: 'Europe/Belgrade' }).timeZone).toBe('Europe/Belgrade')
  })

  test('treats an empty value as unset rather than as a zone', () => {
    expect(loadConfig({ CMS_TIME_ZONE: '  ' }).timeZone).toBe('Europe/Skopje')
  })

  test('refuses a zone it cannot resolve, at boot rather than at the first sale', () => {
    // A typo here would otherwise surface as a receipt numbered on the wrong day.
    expect(() => loadConfig({ CMS_TIME_ZONE: 'Nope/Nowhere' })).toThrow(/time zone/)
  })
})
