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
