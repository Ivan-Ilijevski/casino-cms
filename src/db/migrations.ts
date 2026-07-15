export interface Migration {
  name: string
  sql: string
}

// Migrations are inlined rather than read from .sql files so that `tsc` output
// needs no asset-copying step and tests can run straight from source.
export const migrations: Migration[] = [
  {
    name: '001_init',
    sql: `
      CREATE TABLE players (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        notes       TEXT,
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- card_uid is the physical NFC UID the RC522 reports (e.g. "9C 76 5A F4").
      -- It is the auth credential; id is our own UUID for the card record.
      -- balance_deni/points are a CACHE of ledger_entries, always recomputable.
      CREATE TABLE cards (
        id           TEXT PRIMARY KEY,
        card_uid     TEXT NOT NULL UNIQUE,
        player_id    TEXT NOT NULL REFERENCES players(id),
        status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','blocked')),
        balance_deni INTEGER NOT NULL DEFAULT 0,
        points       INTEGER NOT NULL DEFAULT 0,
        created_at   TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- Append-only. Balance = SUM(amount) per (card_id, unit). Never UPDATE or DELETE.
      CREATE TABLE ledger_entries (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        card_id    TEXT NOT NULL REFERENCES cards(id),
        unit       TEXT NOT NULL CHECK (unit IN ('deni','points')),
        amount     INTEGER NOT NULL,
        kind       TEXT NOT NULL,
        txn        TEXT,
        ref        TEXT,
        actor      TEXT NOT NULL DEFAULT 'system',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_ledger_card_unit ON ledger_entries(card_id, unit);
      CREATE INDEX idx_ledger_txn ON ledger_entries(txn);

      -- First-class holds: survive restart, never auto-expire once an AFT may have started.
      CREATE TABLE holds (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        card_id     TEXT NOT NULL REFERENCES cards(id),
        txn         TEXT NOT NULL UNIQUE,
        amount_deni INTEGER NOT NULL,
        state       TEXT NOT NULL CHECK (state IN ('held','committed','rolledback')),
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        resolved_at TEXT
      );

      CREATE TABLE sessions (
        sid              TEXT PRIMARY KEY,
        card_id          TEXT NOT NULL REFERENCES cards(id),
        opened_at        TEXT NOT NULL DEFAULT (datetime('now')),
        last_activity_at TEXT NOT NULL DEFAULT (datetime('now')),
        closed_at        TEXT,
        close_reason     TEXT
      );
      -- Enforces single active session per card.
      CREATE UNIQUE INDEX idx_sessions_one_active ON sessions(card_id) WHERE closed_at IS NULL;

      -- drink_id is the firmware-facing "drink" int; price_deni maps to wire "price".
      CREATE TABLE menu_items (
        drink_id     INTEGER PRIMARY KEY,
        name         TEXT NOT NULL,
        price_deni   INTEGER NOT NULL CHECK (price_deni >= 0),
        points_price INTEGER NOT NULL DEFAULT 0 CHECK (points_price >= 0),
        available    INTEGER NOT NULL DEFAULT 1,
        sort_order   INTEGER NOT NULL DEFAULT 0,
        updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE orders (
        id           TEXT PRIMARY KEY,
        -- Short human number for staff ("order #42"); the firmware ignores the
        -- order id entirely, so this exists purely for the staff app.
        number       INTEGER NOT NULL UNIQUE,
        card_id      TEXT NOT NULL REFERENCES cards(id),
        session_id   TEXT,
        pay_method   TEXT NOT NULL CHECK (pay_method IN ('cash','points')),
        total_deni   INTEGER NOT NULL,
        total_points INTEGER NOT NULL,
        status       TEXT NOT NULL DEFAULT 'received'
                       CHECK (status IN ('received','accepted','fulfilled','cancelled')),
        created_at   TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
        fulfilled_by TEXT,
        fulfilled_at TEXT
      );
      CREATE INDEX idx_orders_status ON orders(status);
      CREATE INDEX idx_orders_created ON orders(created_at);

      CREATE TABLE order_items (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id          TEXT NOT NULL REFERENCES orders(id),
        drink_id          INTEGER NOT NULL,
        name              TEXT NOT NULL,
        qty               INTEGER NOT NULL,
        unit_price_deni   INTEGER NOT NULL,
        unit_points       INTEGER NOT NULL,
        line_total_deni   INTEGER NOT NULL,
        line_total_points INTEGER NOT NULL
      );
      CREATE INDEX idx_order_items_order ON order_items(order_id);

      -- TITO. Tickets are MACHINE money (redeemed into the slot game's wallet),
      -- so they deliberately live outside the card-keyed ledger.
      -- id keeps the legacy 18-digit numeric format.
      CREATE TABLE tickets (
        id          TEXT PRIMARY KEY,
        amount_deni INTEGER NOT NULL CHECK (amount_deni >= 0),
        status      TEXT NOT NULL DEFAULT 'issued'
                      CHECK (status IN ('issued','redeemed','voided','expired')),
        source      TEXT NOT NULL DEFAULT 'cashout',
        machine_id  TEXT,
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        expires_at  TEXT,
        redeemed_at TEXT,
        redeemed_by TEXT
      );
      CREATE INDEX idx_tickets_status ON tickets(status);
      CREATE INDEX idx_tickets_created ON tickets(created_at);

      -- Append-only audit trail the legacy voucher server never had.
      CREATE TABLE ticket_events (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket_id  TEXT NOT NULL REFERENCES tickets(id),
        event      TEXT NOT NULL CHECK (event IN ('issued','redeemed','voided','expired')),
        actor      TEXT NOT NULL DEFAULT 'system',
        details    TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_ticket_events_ticket ON ticket_events(ticket_id);

      -- Unknown card taps feed the staff "register this card" flow.
      CREATE TABLE unknown_card_taps (
        card_uid   TEXT PRIMARY KEY,
        first_seen TEXT NOT NULL DEFAULT (datetime('now')),
        last_seen  TEXT NOT NULL DEFAULT (datetime('now')),
        count      INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE staff_users (
        id            TEXT PRIMARY KEY,
        username      TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role          TEXT NOT NULL CHECK (role IN ('admin','staff')),
        active        INTEGER NOT NULL DEFAULT 1,
        created_at    TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE audit_log (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        actor       TEXT NOT NULL,
        action      TEXT NOT NULL,
        entity_type TEXT,
        entity_id   TEXT,
        details     TEXT,
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_audit_created ON audit_log(created_at);
    `
  }
]
