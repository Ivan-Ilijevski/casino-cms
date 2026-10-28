import BetterSqlite3 from 'better-sqlite3'
import { describe, expect, test } from 'vitest'
import { migrate, type Db } from '../src/db/index.js'
import { migrations } from '../src/db/migrations.js'

/**
 * Fresh in-memory databases run every migration in one go, so they never
 * exercise the upgrade path a live database actually takes. 003 rebuilds the
 * holds table; these run it against a database that already has rows in it.
 */
function dbAtMigration(upTo: string): Db {
  const db = new BetterSqlite3(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)
  for (const m of migrations) {
    db.transaction(() => {
      db.exec(m.sql)
      db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(m.name)
    })()
    if (m.name === upTo) break
  }
  return db
}

function seedCard(db: Db): string {
  db.prepare("INSERT INTO players (id, name) VALUES ('p1', 'Иван')").run()
  db.prepare(
    "INSERT INTO cards (id, card_uid, player_id, card_uid_canon) VALUES ('c1', 'AA BB', 'p1', 'AABB')"
  ).run()
  return 'c1'
}

describe('003_txn_session_scope', () => {
  test('carries existing holds across the table rebuild', () => {
    const db = dbAtMigration('002_pos')
    const cardId = seedCard(db)
    db.prepare(
      `INSERT INTO holds (id, card_id, txn, amount_deni, state, created_at, resolved_at)
       VALUES (7, ?, 'SMIB-000001', 30000, 'committed', '2026-01-01 10:00:00', '2026-01-01 10:00:05')`
    ).run(cardId)
    db.prepare(
      `INSERT INTO holds (card_id, txn, amount_deni, state) VALUES (?, 'SMIB-000002', 5000, 'held')`
    ).run(cardId)

    migrate(db)

    const rows = db.prepare('SELECT * FROM holds ORDER BY id').all() as any[]
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      id: 7,
      card_id: 'c1',
      txn: 'SMIB-000001',
      session_id: null,
      amount_deni: 30000,
      state: 'committed',
      created_at: '2026-01-01 10:00:00',
      resolved_at: '2026-01-01 10:00:05'
    })
    expect(rows[1]).toMatchObject({ txn: 'SMIB-000002', state: 'held', session_id: null })
  })

  test('keeps the id sequence going after the rebuild', () => {
    const db = dbAtMigration('002_pos')
    const cardId = seedCard(db)
    db.prepare(
      `INSERT INTO holds (id, card_id, txn, amount_deni, state) VALUES (7, ?, 'T1', 100, 'committed')`
    ).run(cardId)

    migrate(db)

    db.prepare(
      `INSERT INTO holds (card_id, txn, amount_deni, state) VALUES (?, 'T2', 100, 'held')`
    ).run(cardId)
    const ids = (db.prepare('SELECT id FROM holds ORDER BY id').all() as Array<{ id: number }>).map(
      (r) => r.id
    )
    expect(ids).toEqual([7, 8])
  })

  test('lets a settled txn recur but still allows only one open hold for it', () => {
    const db = dbAtMigration('002_pos')
    const cardId = seedCard(db)
    migrate(db)

    const insert = db.prepare(
      `INSERT INTO holds (card_id, txn, session_id, amount_deni, state) VALUES (?, 'SMIB-000001', ?, 100, ?)`
    )
    insert.run(cardId, 'boot1', 'committed')
    insert.run(cardId, 'boot2', 'held')

    expect(() => insert.run(cardId, 'boot3', 'held')).toThrow(/UNIQUE/)
  })

  test('preserves existing ledger rows and defaults their session to null', () => {
    const db = dbAtMigration('002_pos')
    const cardId = seedCard(db)
    db.prepare(
      `INSERT INTO ledger_entries (card_id, unit, amount, kind, txn) VALUES (?, 'deni', 500, 'aft_credit', 'SMIB-000001')`
    ).run(cardId)

    migrate(db)

    const row = db.prepare('SELECT * FROM ledger_entries').get() as any
    expect(row).toMatchObject({ amount: 500, kind: 'aft_credit', session_id: null })
  })

  test('is idempotent — re-running migrate changes nothing', () => {
    const db = dbAtMigration('002_pos')
    const cardId = seedCard(db)
    db.prepare(
      `INSERT INTO holds (card_id, txn, amount_deni, state) VALUES (?, 'T1', 100, 'held')`
    ).run(cardId)

    migrate(db)
    migrate(db)

    expect(db.prepare('SELECT COUNT(*) AS n FROM holds').get()).toEqual({ n: 1 })
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE name = '003_txn_session_scope'").get()
    ).toEqual({ n: 1 })
  })
})

describe('004_crm', () => {
  test('rehomes the orphaned players.notes column into player_notes', () => {
    const db = dbAtMigration('003_txn_session_scope')
    db.prepare("INSERT INTO players (id, name, notes) VALUES ('p1', 'Иван', 'ВИП, пие само виски')").run()
    db.prepare("INSERT INTO players (id, name, notes) VALUES ('p2', 'Марија', '   ')").run()
    db.prepare("INSERT INTO players (id, name) VALUES ('p3', 'Горан')").run()

    migrate(db)

    const notes = db.prepare('SELECT * FROM player_notes ORDER BY id').all() as any[]
    expect(notes).toHaveLength(1)
    expect(notes[0]).toMatchObject({
      player_id: 'p1',
      body: 'ВИП, пие само виски',
      author: 'system',
      pinned: 0
    })
  })

  test('adds the identity columns without disturbing existing players', () => {
    const db = dbAtMigration('003_txn_session_scope')
    db.prepare("INSERT INTO players (id, name, created_at) VALUES ('p1', 'Иван', '2026-01-01 10:00:00')").run()

    migrate(db)

    expect(db.prepare('SELECT * FROM players').get()).toMatchObject({
      id: 'p1',
      name: 'Иван',
      created_at: '2026-01-01 10:00:00',
      phone: null,
      email: null,
      city: null,
      dob: null,
      doc_id: null
    })
  })

  test('a tag can only be applied to a guest once', () => {
    const db = dbAtMigration('003_txn_session_scope')
    db.prepare("INSERT INTO players (id, name) VALUES ('p1', 'Иван')").run()
    migrate(db)

    const insert = db.prepare("INSERT INTO player_tags (player_id, tag, actor) VALUES ('p1', ?, 'ana')")
    insert.run('vip')
    expect(() => insert.run('vip')).toThrow(/UNIQUE/)
  })

  test('006 leaves existing drinks untracked rather than sold out', () => {
    const db = dbAtMigration('005_crm_indexes')
    db.prepare(
      `INSERT INTO menu_items (drink_id, name, price_deni, points_price, available, sort_order)
       VALUES (1, 'Кафе', 8000, 50, 1, 1)`
    ).run()

    migrate(db)

    // NULL, not 0: a live bar's existing drinks are of unknown quantity, and
    // defaulting to 0 would take the whole menu off the terminal on deploy.
    expect(db.prepare('SELECT stock_qty AS s FROM menu_items WHERE drink_id = 1').get()).toEqual({
      s: null
    })
  })

  describe('008_backfill_card_canon', () => {
    /** The rows POST /cards used to write for a second card: no canon at all. */
    function cardWithoutCanon(db: Db, id: string, uid: string) {
      db.prepare('INSERT INTO cards (id, card_uid, player_id) VALUES (?, ?, ?)').run(id, uid, 'p1')
    }

    function dbWithPlayer() {
      const db = dbAtMigration('007_pos_custom_charges')
      db.prepare("INSERT INTO players (id, name) VALUES ('p1', 'Иван')").run()
      return db
    }

    const canonOf = (db: Db, id: string) =>
      (db.prepare('SELECT card_uid_canon AS c FROM cards WHERE id = ?').get(id) as { c: string | null }).c

    test('gives an orphaned card the canon its readers need', () => {
      const db = dbWithPlayer()
      cardWithoutCanon(db, 'c1', '55:B5:B6:60')

      migrate(db)

      expect(canonOf(db, 'c1')).toBe('55B5B660')
    })

    test('leaves a canon that is already claimed alone, rather than failing the migration', () => {
      const db = dbWithPlayer()
      db.prepare(
        "INSERT INTO cards (id, card_uid, player_id, card_uid_canon) VALUES ('c1', '55 B5 B6 60', 'p1', '55B5B660')"
      ).run()
      cardWithoutCanon(db, 'c2', '55:b5:b6:60') // the same card, registered twice

      migrate(db)

      expect(canonOf(db, 'c1')).toBe('55B5B660')
      // Which of two registrations of one card to delete is a human's call.
      expect(canonOf(db, 'c2')).toBeNull()
    })

    test('two canon-less rows for one card: the earlier claims it, the later stays null', () => {
      const db = dbWithPlayer()
      cardWithoutCanon(db, 'c1', '55B5B660')
      cardWithoutCanon(db, 'c2', '55:B5:B6:60')

      migrate(db)

      expect(canonOf(db, 'c1')).toBe('55B5B660')
      expect(canonOf(db, 'c2')).toBeNull()
    })

    test('a card can no longer be inserted without a canon at all', () => {
      const db = dbWithPlayer()
      migrate(db)

      expect(() => cardWithoutCanon(db, 'c9', 'AA BB')).toThrow(/card_uid_canon is required/)
    })
  })

  test('is idempotent — re-running migrate does not duplicate the notes backfill', () => {
    const db = dbAtMigration('003_txn_session_scope')
    db.prepare("INSERT INTO players (id, name, notes) VALUES ('p1', 'Иван', 'белешка')").run()

    migrate(db)
    migrate(db)

    expect(db.prepare('SELECT COUNT(*) AS n FROM player_notes').get()).toEqual({ n: 1 })
  })
})

describe('009_menu_vat', () => {
  test('gives existing drinks the standard-rate domestic default', () => {
    const db = dbAtMigration('008_backfill_card_canon')
    db.prepare(
      `INSERT INTO menu_items (drink_id, name, price_deni, points_price, available, sort_order)
       VALUES (1, 'Кафе', 8000, 50, 1, 1)`
    ).run()

    migrate(db)

    expect(
      db.prepare('SELECT vat_type AS v, is_domestic AS d FROM menu_items WHERE drink_id = 1').get()
    ).toEqual({ v: 'A', d: 1 })
  })

  test('rejects a vat_type outside the four fiscal bands', () => {
    const db = dbAtMigration('008_backfill_card_canon')
    migrate(db)

    expect(() =>
      db
        .prepare(
          `INSERT INTO menu_items (drink_id, name, price_deni, points_price, vat_type)
           VALUES (2, 'Пиво', 6000, 0, 'X')`
        )
        .run()
    ).toThrow(/CHECK/)
  })
})

describe('012_receipts', () => {
  /** A receipt has to point at a real sale, so every case here needs one. */
  function seedOrder(db: Db, id: string, number: number): string {
    db.prepare(
      `INSERT INTO orders (id, number, card_id, pay_method, total_deni, total_points)
       VALUES (?, ?, 'c1', 'cash', 24000, 0)`
    ).run(id, number)
    return id
  }

  function insertReceipt(db: Db, r: { day: string; seq: number; orderId: string }): void {
    db.prepare(
      `INSERT INTO receipts (day, seq, order_id, pay_method, total_deni, actor, time_zone)
       VALUES (?, ?, ?, 'cash', 24000, 'barman', 'Europe/Skopje')`
    ).run(r.day, r.seq, r.orderId)
  }

  function upgraded(): Db {
    const db = dbAtMigration('011_order_promised_at')
    seedCard(db)
    migrate(db)
    return db
  }

  test('two receipts can never share a number on one day', () => {
    const db = upgraded()
    seedOrder(db, 'o1', 1)
    seedOrder(db, 'o2', 2)
    insertReceipt(db, { day: '2026-07-07', seq: 1, orderId: 'o1' })

    expect(() => insertReceipt(db, { day: '2026-07-07', seq: 1, orderId: 'o2' })).toThrow(/UNIQUE/)
  })

  test('the same number on another day is fine — that is the whole point', () => {
    const db = upgraded()
    seedOrder(db, 'o1', 1)
    seedOrder(db, 'o2', 2)

    insertReceipt(db, { day: '2026-07-07', seq: 1, orderId: 'o1' })
    insertReceipt(db, { day: '2026-07-08', seq: 1, orderId: 'o2' })

    expect(db.prepare('SELECT COUNT(*) AS n FROM receipts WHERE seq = 1').get()).toEqual({ n: 2 })
  })

  test('one sale can only ever have one receipt', () => {
    const db = upgraded()
    seedOrder(db, 'o1', 1)
    insertReceipt(db, { day: '2026-07-07', seq: 1, orderId: 'o1' })

    // A reprint must be the same fiscal document, not a second number.
    expect(() => insertReceipt(db, { day: '2026-07-07', seq: 2, orderId: 'o1' })).toThrow(/UNIQUE/)
  })

  test('a receipt cannot point at a sale that does not exist', () => {
    const db = upgraded()

    expect(() => insertReceipt(db, { day: '2026-07-07', seq: 1, orderId: 'nope' })).toThrow(
      /FOREIGN KEY/
    )
  })

  test('a number starts out allocated but not printed', () => {
    const db = upgraded()
    seedOrder(db, 'o1', 1)
    insertReceipt(db, { day: '2026-07-07', seq: 1, orderId: 'o1' })

    expect(db.prepare('SELECT rendered_at AS r FROM receipts').get()).toEqual({ r: null })
  })

  test('rejects a sequence number that is not a real position', () => {
    const db = upgraded()
    seedOrder(db, 'o1', 1)

    expect(() => insertReceipt(db, { day: '2026-07-07', seq: 0, orderId: 'o1' })).toThrow(/CHECK/)
  })

  test('is idempotent — re-running migrate keeps the receipts already issued', () => {
    const db = upgraded()
    seedOrder(db, 'o1', 1)
    insertReceipt(db, { day: '2026-07-07', seq: 1, orderId: 'o1' })

    migrate(db)
    migrate(db)

    expect(db.prepare('SELECT COUNT(*) AS n FROM receipts').get()).toEqual({ n: 1 })
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE name = '012_receipts'").get()
    ).toEqual({ n: 1 })
  })
})

describe('013_machines', () => {
  test('machines is keyed on host, not on the shared firmware device id', () => {
    const db = dbAtMigration('013_machines')

    db.prepare("INSERT INTO machines (id, label, host, device_id) VALUES ('m1','К1','10.0.0.1','smib-1')").run()

    // Two cabinets flashed from one firmware image both report "smib-1", so a
    // UNIQUE on device_id would make the second one unregistrable.
    expect(() =>
      db.prepare("INSERT INTO machines (id, label, host, device_id) VALUES ('m2','К2','10.0.0.2','smib-1')").run()
    ).not.toThrow()
    expect(() =>
      db.prepare("INSERT INTO machines (id, label, host) VALUES ('m3','К3','10.0.0.1')").run()
    ).toThrow()
  })

  test('many machines may sit with no host at all', () => {
    const db = dbAtMigration('013_machines')

    db.prepare("INSERT INTO machines (id, label) VALUES ('m1','К1')").run()

    // The index is partial, so NULL hosts do not collide.
    expect(() => db.prepare("INSERT INTO machines (id, label) VALUES ('m2','К2')").run()).not.toThrow()
  })

  test('status is constrained to the two the UI knows', () => {
    const db = dbAtMigration('013_machines')

    expect(() =>
      db.prepare("INSERT INTO machines (id, label, status) VALUES ('m1','К1','retired')").run()
    ).toThrow()
  })

  test('sessions.machine_id carries no foreign key', () => {
    const db = dbAtMigration('013_machines')

    // foreign_keys is ON. An FK here would make every openSession() validate
    // against an oversight table, so a missing machines table would stop a guest
    // logging in. tickets.machine_id has been FK-free since 001 for the same
    // reason; this pins that sessions matches it.
    const fks = db.prepare('PRAGMA foreign_key_list(sessions)').all() as Array<{ table: string }>
    expect(fks.map((f) => f.table)).not.toContain('machines')
  })
})

describe('014_receipt_history', () => {
  function seedReceipt(db: Db): number {
    db.prepare(
      `INSERT INTO orders (id, number, card_id, pay_method, total_deni, total_points)
       VALUES ('o1', 1, 'c1', 'cash', 24000, 0)`
    ).run()
    return Number(
      db
        .prepare(
          `INSERT INTO receipts (day, seq, order_id, pay_method, total_deni, actor, time_zone, rendered_at)
           VALUES ('2026-07-07', 1, 'o1', 'cash', 24000, 'barman', 'Europe/Skopje', datetime('now'))`
        )
        .run().lastInsertRowid
    )
  }

  test('receipts issued before it survive, with nothing stored to reprint from yet', () => {
    const db = dbAtMigration('013_machines')
    seedCard(db)
    seedReceipt(db)
    migrate(db)

    // NULL rather than a guess: receiptHistory re-renders these once from the order.
    expect(db.prepare('SELECT seq, items, png FROM receipts').get()).toEqual({
      seq: 1,
      items: null,
      png: null
    })
  })

  test('a print attempt starts out unconfirmed', () => {
    const db = dbAtMigration('014_receipt_history')
    seedCard(db)
    const receiptId = seedReceipt(db)

    db.prepare("INSERT INTO receipt_prints (receipt_id, copy, actor) VALUES (?, 0, 'barman')").run(receiptId)

    expect(db.prepare('SELECT status, finished_at AS f FROM receipt_prints').get()).toEqual({
      status: 'sending',
      f: null
    })
  })

  test('an attempt can only end in an outcome the history view knows', () => {
    const db = dbAtMigration('014_receipt_history')
    seedCard(db)
    const receiptId = seedReceipt(db)

    expect(() =>
      db
        .prepare("INSERT INTO receipt_prints (receipt_id, copy, actor, status) VALUES (?, 0, 'barman', 'printed')")
        .run(receiptId)
    ).toThrow(/CHECK/)
    expect(() =>
      db.prepare("INSERT INTO receipt_prints (receipt_id, copy, actor) VALUES (?, 2, 'barman')").run(receiptId)
    ).toThrow(/CHECK/)
    expect(() =>
      db
        .prepare("INSERT INTO receipt_prints (receipt_id, copy, actor, percent) VALUES (?, 0, 'barman', 101)")
        .run(receiptId)
    ).toThrow(/CHECK/)
  })

  test('a print attempt must belong to a receipt', () => {
    const db = dbAtMigration('014_receipt_history')

    expect(() =>
      db.prepare("INSERT INTO receipt_prints (receipt_id, copy, actor) VALUES (999, 0, 'barman')").run()
    ).toThrow(/FOREIGN KEY/)
  })
})
