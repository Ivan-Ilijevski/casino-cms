import { beforeEach, describe, expect, test } from 'vitest'
import { openTestDb, type Db } from '../src/db/index.js'
import {
  allocateReceiptNumber,
  formatReceiptNumber,
  markRendered,
  releaseReceiptNumber,
  UnknownOrderError
} from '../src/domain/receiptNumbers.js'

const TZ = 'Europe/Skopje'
const DAY = '2026-07-07'

let db: Db

beforeEach(() => {
  db = openTestDb()
  db.prepare("INSERT INTO players (id, name) VALUES ('p1', 'Иван')").run()
  db.prepare(
    "INSERT INTO cards (id, card_uid, player_id, card_uid_canon) VALUES ('c1', 'AA BB', 'p1', 'AABB')"
  ).run()
})

/** Orders are the thing a receipt number is issued against, so every test needs some. */
function seedOrder(id: string, number: number, pay: 'cash' | 'points' = 'cash'): string {
  db.prepare(
    `INSERT INTO orders (id, number, card_id, pay_method, total_deni, total_points)
     VALUES (?, ?, 'c1', ?, 24000, 300)`
  ).run(id, number, pay)
  return id
}

function allocate(orderId: string, day = DAY) {
  return allocateReceiptNumber(db, { orderId, day, timeZone: TZ, actor: 'barman' })
}

function count(): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM receipts').get() as { n: number }).n
}

describe('formatReceiptNumber', () => {
  test('pads to the four digits the render service prints', () => {
    expect(formatReceiptNumber(1)).toBe('0001')
    expect(formatReceiptNumber(42)).toBe('0042')
    expect(formatReceiptNumber(9999)).toBe('9999')
  })

  test('grows past four digits rather than repeating a number already issued', () => {
    // Truncating to '0000' here would print a number that has already been on paper.
    // A cosmetically wide receipt beats a duplicated fiscal one.
    expect(formatReceiptNumber(10000)).toBe('10000')
  })
})

describe('allocateReceiptNumber', () => {
  test('the first receipt of a day is 0001', () => {
    const n = allocate(seedOrder('o1', 1))

    expect(n.seq).toBe(1)
    expect(n.printed).toBe('0001')
    expect(n.reused).toBe(false)
  })

  test('numbers run consecutively within a day', () => {
    const printed = ['o1', 'o2', 'o3'].map((id, i) => allocate(seedOrder(id, i + 1)).printed)

    expect(printed).toEqual(['0001', '0002', '0003'])
  })

  test('a new day restarts at 0001 however busy the previous one was', () => {
    for (let i = 1; i <= 57; i++) allocate(seedOrder(`o${i}`, i))
    expect(allocate(seedOrder('o58', 58)).printed).toBe('0058')

    const tomorrow = allocate(seedOrder('o59', 59), '2026-07-08')

    expect(tomorrow.printed).toBe('0001')
    expect(tomorrow.day).toBe('2026-07-08')
  })

  test('records the sale, the tender, who printed it and the zone the day came from', () => {
    allocate(seedOrder('o1', 1, 'points'))

    expect(
      db
        .prepare(
          'SELECT order_id AS o, pay_method AS p, total_deni AS t, actor AS a, time_zone AS z FROM receipts'
        )
        .get()
    ).toEqual({ o: 'o1', p: 'points', t: 24000, a: 'barman', z: TZ })
  })

  test('a reprint of one sale keeps its number and burns none', () => {
    const first = allocate(seedOrder('o1', 1))
    const again = allocate('o1')

    expect(again.printed).toBe(first.printed)
    expect(again.reused).toBe(true)
    expect(count()).toBe(1)
  })

  test("a reprint after midnight keeps yesterday's number, not a new day's", () => {
    const first = allocate(seedOrder('o1', 1))

    const again = allocate('o1', '2026-07-08')

    expect(again.day).toBe(DAY)
    expect(again.seq).toBe(first.seq)
  })

  test('refuses to number a sale that does not exist, and records nothing', () => {
    expect(() => allocate('nope')).toThrow(UnknownOrderError)
    // The guard that matters: inside db.transaction a returned {ok:false} would COMMIT,
    // so this asserts the throw actually rolled the row back.
    expect(count()).toBe(0)
  })
})

describe('releaseReceiptNumber', () => {
  test('gives the last number of a day back so the next sale reuses it', () => {
    const first = allocate(seedOrder('o1', 1))

    expect(releaseReceiptNumber(db, first.id)).toBe(true)
    expect(count()).toBe(0)
    expect(allocate(seedOrder('o2', 2)).printed).toBe('0001')
  })

  test('leaves a number a later sale has already built on', () => {
    const first = allocate(seedOrder('o1', 1))
    allocate(seedOrder('o2', 2))

    // Deleting seq 1 now would punch the very hole this is meant to avoid, so the
    // row stays — unprinted, but explainable — and numbering carries on.
    expect(releaseReceiptNumber(db, first.id)).toBe(false)
    expect(count()).toBe(2)
    expect(allocate(seedOrder('o3', 3)).printed).toBe('0003')
  })

  test('never takes back a number that reached paper', () => {
    const first = allocate(seedOrder('o1', 1))
    markRendered(db, first.id)

    expect(releaseReceiptNumber(db, first.id)).toBe(false)
    expect(count()).toBe(1)
  })
})

describe('markRendered', () => {
  test('records that the number actually printed', () => {
    const n = allocate(seedOrder('o1', 1))
    expect(db.prepare('SELECT rendered_at AS r FROM receipts').get()).toEqual({ r: null })

    markRendered(db, n.id)

    expect((db.prepare('SELECT rendered_at AS r FROM receipts').get() as { r: string }).r).toMatch(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/
    )
  })
})
