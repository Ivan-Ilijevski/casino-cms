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
  },
  {
    // POS tap-to-pay. Additive only: 001 has already been applied to live
    // databases, and editing an applied migration leaves them silently behind
    // the schema (in-memory test DBs are built fresh and would never catch it).
    name: '002_pos',
    sql: `
      -- Two readers, two UID spellings, one card:
      --   RC522 terminal -> "9C 76 5A F4"  (uppercase, space-separated)
      --   Web NFC/Chrome -> "9c:76:5a:f4"  (lowercase, colon-separated)
      -- card_uid keeps whatever the registrar typed; card_uid_canon is what we
      -- actually match on. Without this no POS tap would ever find its card.
      ALTER TABLE cards ADD COLUMN card_uid_canon TEXT;
      UPDATE cards
         SET card_uid_canon = REPLACE(REPLACE(REPLACE(UPPER(card_uid), ' ', ''), ':', ''), '-', '');
      CREATE UNIQUE INDEX idx_cards_uid_canon ON cards(card_uid_canon);

      -- 4-digit PIN, spot-checked on a random 1-in-8 of POS payments.
      -- 10^4 combinations, so the attempt counter is what keeps the confirm
      -- endpoint from being a brute-force oracle.
      ALTER TABLE cards ADD COLUMN pin_hash TEXT;
      ALTER TABLE cards ADD COLUMN pin_failed_attempts INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE cards ADD COLUMN pin_locked_until TEXT;

      -- Tells bar sales from machine-side orders in reports.
      ALTER TABLE orders ADD COLUMN source TEXT NOT NULL DEFAULT 'terminal';

      -- A priced, single-use payment authorisation. pin_required is decided and
      -- stored HERE, server-side, so a client cannot dodge the check by simply
      -- omitting the PIN on confirm.
      CREATE TABLE pos_intents (
        id             TEXT PRIMARY KEY,
        card_id        TEXT NOT NULL REFERENCES cards(id),
        staff_username TEXT NOT NULL,
        pay_method     TEXT NOT NULL CHECK (pay_method IN ('cash','points')),
        items_json     TEXT NOT NULL,
        total_deni     INTEGER NOT NULL,
        total_points   INTEGER NOT NULL,
        pin_required   INTEGER NOT NULL,
        state          TEXT NOT NULL DEFAULT 'pending'
                         CHECK (state IN ('pending','consumed','expired')),
        created_at     TEXT NOT NULL DEFAULT (datetime('now')),
        expires_at     TEXT NOT NULL,
        order_id       TEXT REFERENCES orders(id)
      );
      CREATE INDEX idx_pos_intents_state ON pos_intents(state);
    `
  },
  {
    // Session-scoped replay detection for AFT transfers.
    //
    // The firmware mints txns with `snprintf(out, 24, "SMIB-%06u", s_next_txn++)`
    // over `static uint32_t s_next_txn = 1` (main/cms/cms.c) — a counter in RAM
    // that restarts at 1 on every SMIB reboot. A txn is therefore unique only
    // within one firmware boot, NEVER for all time, so the old global
    // UNIQUE(holds.txn) plus "txn already seen -> replay" read a post-reboot
    // transfer as a retry: debit_res answered ok, the firmware credited the
    // machine, and the card was never charged. The mirror case swallowed a
    // cashout credit and lost the player's money.
    //
    // A session ends when the card leaves the reader — and a reboot always ends
    // one — so (session, txn) IS unique where txn alone is not.
    name: '003_txn_session_scope',
    sql: `
      -- Rebuild: SQLite cannot drop the UNIQUE(txn) column constraint in place.
      -- Nothing references holds, so a plain copy is safe.
      CREATE TABLE holds_new (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        card_id     TEXT NOT NULL REFERENCES cards(id),
        txn         TEXT NOT NULL,
        session_id  TEXT,
        amount_deni INTEGER NOT NULL,
        state       TEXT NOT NULL CHECK (state IN ('held','committed','rolledback')),
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        resolved_at TEXT
      );
      INSERT INTO holds_new (id, card_id, txn, session_id, amount_deni, state, created_at, resolved_at)
        SELECT id, card_id, txn, NULL, amount_deni, state, created_at, resolved_at FROM holds;
      DROP TABLE holds;
      ALTER TABLE holds_new RENAME TO holds;

      -- debit_commit and debit_rollback carry nothing but the txn, so at most
      -- one hold per txn may be unresolved at a time. Settled ones may share.
      CREATE UNIQUE INDEX idx_holds_txn_open ON holds(txn) WHERE state = 'held';
      CREATE INDEX idx_holds_txn ON holds(txn);

      ALTER TABLE ledger_entries ADD COLUMN session_id TEXT;
      CREATE INDEX idx_ledger_txn_kind ON ledger_entries(txn, kind);
    `
  },
  {
    // The staff app turns "Гости" from a list of cards into a list of people.
    // Additive only — 001–003 are applied on live databases.
    //
    // Risk flags live in player_tags rather than columns so a new one (say a
    // court order) needs no migration. Reserved slugs the UI knows about:
    // vip, watchlist, self_excluded, pep, sanctions_hit.
    name: '004_crm',
    sql: `
      -- Identity. The card terminal never sees any of this; it exists so staff
      -- can tell two Иван Илијевскис apart, and so KYC/AML has something to
      -- match on. dob and doc_id are returned to admins only (routes/customers.ts).
      ALTER TABLE players ADD COLUMN phone      TEXT;
      ALTER TABLE players ADD COLUMN email      TEXT;
      ALTER TABLE players ADD COLUMN city       TEXT;
      ALTER TABLE players ADD COLUMN dob        TEXT;
      ALTER TABLE players ADD COLUMN doc_id     TEXT;
      ALTER TABLE players ADD COLUMN updated_at TEXT;

      -- Tickets are machine money and carry no card, so a cashout cannot be
      -- attributed to a guest today. The column is here so that when the slot
      -- game starts passing a session on /create, the linkage lands without
      -- another migration. Until then the profile time-correlates and says so.
      ALTER TABLE tickets ADD COLUMN player_id TEXT REFERENCES players(id);

      CREATE TABLE player_notes (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        player_id  TEXT NOT NULL REFERENCES players(id),
        body       TEXT NOT NULL,
        author     TEXT NOT NULL,
        pinned     INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_player_notes_player ON player_notes(player_id, id DESC);

      CREATE TABLE player_tags (
        player_id  TEXT NOT NULL REFERENCES players(id),
        tag        TEXT NOT NULL,
        actor      TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (player_id, tag)
      );

      -- players.notes has existed since 001 with no route or screen able to
      -- reach it. Anything already in there becomes the first note.
      INSERT INTO player_notes (player_id, body, author)
        SELECT id, notes, 'system' FROM players
         WHERE notes IS NOT NULL AND trim(notes) <> '';

      -- The profile queries by player and by entity; none of these were indexed
      -- because nothing had ever asked for them.
      CREATE INDEX idx_sessions_card_opened ON sessions(card_id, opened_at DESC);
      CREATE INDEX idx_holds_card           ON holds(card_id);
      CREATE INDEX idx_audit_entity         ON audit_log(entity_type, entity_id, id DESC);
    `
  },
  {
    // Indexes for the guest profile's fan-out. 004 indexed the tables the CRM
    // adds but not the join it leans on hardest: every profile query filters
    // cards by player_id, and there was no index for it, so SQLite built a
    // throwaway AUTOMATIC COVERING INDEX on each request.
    //
    // ledger_entries(session_id) matters more than it looks. The per-visit spend
    // subquery ran a full ledger scan for every row of the Посети tab, on the
    // same synchronous connection the terminal's AFT hold path uses — so opening
    // a regular's visit history could stall a cash transfer on the floor.
    name: '005_crm_indexes',
    sql: `
      CREATE INDEX IF NOT EXISTS idx_cards_player   ON cards(player_id);
      CREATE INDEX IF NOT EXISTS idx_ledger_session ON ledger_entries(session_id);

      -- 003 rebuilds the holds table, so if it ever lands after 004 the index
      -- 004 created is dropped with no error. Recreating it here is idempotent
      -- and makes the outcome independent of the order those two are merged in.
      CREATE INDEX IF NOT EXISTS idx_holds_card ON holds(card_id);
    `
  },
  {
    // Per-drink stock, so the menu stops offering what the bar ran out of.
    // Additive only — 001-005 are applied on live databases.
    name: '006_menu_stock',
    sql: `
      -- NULL = not stock-tracked: sold from an unlimited supply, and the only
      -- state every existing drink can honestly be in after this migration.
      -- 0 = ran out: priceLines() skips it and the terminal greys it out.
      ALTER TABLE menu_items ADD COLUMN stock_qty INTEGER;
    `
  },
  {
    // POS custom charges (chips buy/cashout, free-form amounts) and the confirm
    // step that shows the guest what they are about to pay before committing.
    name: '007_pos_custom_charges',
    sql: `
      -- 'order' = menu-item cart (existing); 'custom' = free-form amount.
      ALTER TABLE pos_intents ADD COLUMN charge_type TEXT NOT NULL DEFAULT 'order'
        CHECK (charge_type IN ('order', 'custom'));

      -- 'debit' = money leaves the card (bar, chip buy); 'credit' = money enters (chip cashout).
      ALTER TABLE pos_intents ADD COLUMN direction TEXT NOT NULL DEFAULT 'debit'
        CHECK (direction IN ('debit', 'credit'));

      -- Human label for custom charges (e.g. "Чипови", "Друго").
      ALTER TABLE pos_intents ADD COLUMN label TEXT;
    `
  },
  {
    // POST /cards had two insert paths and only one of them wrote
    // card_uid_canon: registering a SECOND card for an existing guest left it
    // NULL. Every reader resolves a card through that column and nothing else
    // (accounts.ts findCardByUid, called by the terminal's auth_req and by the
    // POS), so those cards authenticated nowhere — and the duplicate guard,
    // which is the same lookup, could not see them either, so the same physical
    // card could be registered twice in two spellings.
    //
    // The code now has a single insert (accounts.ts addCardToPlayer). This
    // repairs the rows that path already wrote.
    name: '008_backfill_card_canon',
    sql: `
      -- Same expression as 002, so the backfill agrees with the rows already here.
      -- Two guards, because idx_cards_uid_canon is UNIQUE and a failed migration
      -- takes startup with it:
      --   1. never take a canon a non-NULL row already holds;
      --   2. where several NULL rows compute the SAME canon — the same card
      --      registered twice — only the earliest (lowest rowid) claims it.
      WITH computed AS (
        SELECT rowid AS rid,
               REPLACE(REPLACE(REPLACE(UPPER(card_uid), ' ', ''), ':', ''), '-', '') AS canon
          FROM cards
         WHERE card_uid_canon IS NULL
      ),
      claimable AS (
        SELECT canon, MIN(rid) AS rid
          FROM computed
         WHERE canon NOT IN (SELECT card_uid_canon FROM cards WHERE card_uid_canon IS NOT NULL)
         GROUP BY canon
      )
      UPDATE cards
         SET card_uid_canon = (SELECT canon FROM claimable WHERE claimable.rid = cards.rowid)
       WHERE rowid IN (SELECT rid FROM claimable);

      -- Anything still NULL is a duplicate registration of a card that already
      -- works under another row. A human decides which one to delete; there is
      -- no answer a migration could pick safely.

      -- A card with no canon cannot be authenticated by any reader, so it is not
      -- a valid row. SQLite cannot add NOT NULL to an existing column without
      -- rebuilding a table five others reference by foreign key, so the same
      -- guarantee is bought with one statement.
      CREATE TRIGGER cards_require_canon BEFORE INSERT ON cards
      WHEN NEW.card_uid_canon IS NULL
      BEGIN
        SELECT RAISE(ABORT, 'card_uid_canon is required');
      END;
    `
  },
  {
    // Fiscal-receipt printing (POS) needs a VAT band and a domestic/imported
    // flag per line item, or the receipt-render API drops the item entirely.
    // Existing drinks default to the standard 18% band, domestic — the least
    // surprising guess, correctable per-drink from the menu editor.
    name: '009_menu_vat',
    sql: `
      ALTER TABLE menu_items ADD COLUMN vat_type TEXT NOT NULL DEFAULT 'A'
        CHECK (vat_type IN ('A', 'B', 'V', 'G'));
      ALTER TABLE menu_items ADD COLUMN is_domestic INTEGER NOT NULL DEFAULT 1;
    `
  },
  {
    // The tablet behind the bar only takes orders and reads the drink list, so
    // handing it a 'staff' account would also hand it the guest CRM, the POS
    // and every player's PII. 'bar' is that account with nothing else attached;
    // what it may call is the allowlist in http/staffAuth.ts, not this CHECK.
    name: '010_staff_bar_role',
    sql: `
      -- Rebuild: SQLite cannot widen a column CHECK in place. Nothing has a
      -- foreign key to staff_users, so a plain copy is safe.
      CREATE TABLE staff_users_new (
        id            TEXT PRIMARY KEY,
        username      TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role          TEXT NOT NULL CHECK (role IN ('admin','staff','bar')),
        active        INTEGER NOT NULL DEFAULT 1,
        created_at    TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO staff_users_new (id, username, password_hash, role, active, created_at)
        SELECT id, username, password_hash, role, active, created_at FROM staff_users;
      DROP TABLE staff_users;
      ALTER TABLE staff_users_new RENAME TO staff_users;
    `
  },
  {
    // Accepting an order now promises the guest a time, and the bar board counts
    // down to it. Additive on purpose: the alternative shape was a fifth status
    // between accepted and fulfilled, which would mean rebuilding a table that
    // order_items and pos_intents both point at, with foreign_keys ON and
    // migrations running inside a transaction where the pragma is a no-op.
    //
    // NULL means "accepted before this shipped, or accepted with no estimate" —
    // every reader has to handle it, so the board falls back to elapsed time.
    name: '011_order_promised_at',
    sql: `
      ALTER TABLE orders ADD COLUMN promised_at TEXT;
    `
  },
  {
    // A fiscal receipt carries a number that restarts at 0001 every day, so the
    // number alone is not an identifier — (day, seq) is.
    //
    // This table IS the counter: MAX(seq) WHERE day = ? derives the next one,
    // the same shape orders.number already uses, so there is no second mutable
    // "last number" row that can drift from the receipts actually issued.
    //
    // `day` is the local calendar day in `time_zone`, computed in TS through ICU
    // (domain/businessDay.ts) and NOT date(created_at) — created_at is UTC, which
    // would roll the counter over at 01:00 or 02:00 Skopje depending on season,
    // in the middle of service. time_zone is recorded per row so an old day stays
    // interpretable after CMS_TIME_ZONE is ever changed.
    //
    // order_id is UNIQUE because a reprint of one sale must be the same fiscal
    // document, never a second number. If voiding and reissuing is ever designed,
    // relaxing this is far cheaper than finding duplicate numbering at an audit.
    //
    // pay_method/total_deni snapshot what the paper said. The receipt is the
    // fiscal record and orders is the commercial one: an order can be cancelled
    // and refunded afterwards, and the receipt still printed.
    //
    // rendered_at NULL means a number was allocated but never reached paper —
    // the one thing that makes a gap in the sequence explainable.
    name: '012_receipts',
    sql: `
      CREATE TABLE receipts (
        -- Doubles as the never-resetting progressive count of every receipt ever
        -- issued, which MK fiscal law wants alongside the daily one. The render
        -- service hardcodes its own and exposes no field for it, so this is
        -- recorded from day one and not yet printed.
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        day         TEXT    NOT NULL,
        seq         INTEGER NOT NULL CHECK (seq > 0),
        order_id    TEXT    NOT NULL UNIQUE REFERENCES orders(id),
        pay_method  TEXT    NOT NULL CHECK (pay_method IN ('cash','points')),
        total_deni  INTEGER NOT NULL,
        actor       TEXT    NOT NULL,
        time_zone   TEXT    NOT NULL,
        created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
        rendered_at TEXT,
        -- Both the guarantee that one day never issues a number twice and the
        -- index the allocator's MAX(seq) WHERE day = ? reads.
        UNIQUE (day, seq)
      );
    `
  },
  {
    // The CMS has spoken to slot machines since day one without ever recording
    // that one existed: CmsTcpServer held its connections in a bare Set<Socket>
    // with no id, no address and no timestamps, so "is cabinet 3 online?" had no
    // answer. This is the registry behind the admin Machines view.
    //
    // The terminal already identifies itself -- cms.c sends hello {dev, fw, proto}
    // on connect and on every link down->up edge -- but SMIB_DEVICE_ID is a
    // COMPILE-TIME constant in board.h, so every terminal flashed from one image
    // reports the same "smib-1". device_id is therefore recorded as a reported
    // attribute and is deliberately NOT unique; `host` (the remote IP, one per
    // slot PC) is the discriminator that actually separates two cabinets.
    //
    // The index is partial so many rows may sit with host IS NULL -- a machine
    // registered from its asset tag before it has ever dialled in.
    //
    // status is ADVISORY. Nothing in the wire path reads it: taking a machine out
    // of service greys it in the UI and drops it from the expected-online count,
    // and card auth at that cabinet keeps working. Refusing auth here would put a
    // new failure branch in the money path for the sake of a label.
    name: '013_machines',
    sql: `
      CREATE TABLE machines (
        id         TEXT PRIMARY KEY,
        label      TEXT NOT NULL,
        device_id  TEXT,
        host       TEXT,
        location   TEXT,
        asset_no   TEXT,
        serial     TEXT,
        status     TEXT NOT NULL DEFAULT 'in_service'
                     CHECK (status IN ('in_service','out_of_service')),
        notes      TEXT,
        fw         TEXT,
        proto      INTEGER,
        first_seen TEXT,
        last_seen  TEXT,
        connects   INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE UNIQUE INDEX idx_machines_host ON machines(host) WHERE host IS NOT NULL;

      -- Which cabinet a card session was opened at. Nullable with no backfill:
      -- sessions that predate machine identity genuinely have no machine, and
      -- guessing one retroactively would invent history. tickets.machine_id has
      -- existed since 001 and is filled from this release on (voucherLegacy.ts).
      --
      -- Deliberately NOT "REFERENCES machines(id)", matching tickets.machine_id.
      -- foreign_keys is ON, so an FK here would make every openSession() INSERT
      -- validate against an oversight table -- and a machines table that was
      -- missing or locked would stop a guest logging in at the cabinet. Card auth
      -- must not be able to fail because of a reporting feature.
      ALTER TABLE sessions ADD COLUMN machine_id TEXT;
    `
  },
  {
    // A fiscal receipt used to be rendered, sent to the printer and forgotten: the
    // receipts row said a number was issued, not what the paper said, and its lines
    // came from the browser. A reprint had nothing to reprint from.
    //
    // `png` is the render exactly as the API returned it, so a reprint is the same
    // document byte for byte -- including whatever date and time the render service
    // stamped -- and still works while that service is down. It is never the
    // КОПИЈА-marked image: the band is drawn in the browser, per print, from this.
    // `items` is the JSON lines that were sent to the render API alongside it.
    //
    // Both are NULL on receipts from before this release; those re-render once from
    // their order and are stored then (domain/receiptHistory.ts).
    //
    // receipt_prints is the print log. rendered_at only ever meant "the render API
    // answered", which happens before a single byte goes over Bluetooth, so whether a
    // receipt reached the printer was unrecorded. The tablet reports each attempt:
    // 'sending' when it starts, then how it ended. A row left in 'sending' is a tablet
    // that died mid-print and is shown as unconfirmed, never guessed at.
    //
    // `copy` is decided by the server when the attempt starts -- an earlier attempt
    // reached 'sent' -- and says whether the paper carried the КОПИЈА band. A retry
    // after an interrupted print is still the original, because no whole original
    // ever came out.
    //
    // The foreign key is fine here, unlike sessions.machine_id: nothing in the money
    // path writes this table, and releaseReceiptNumber only deletes receipts that
    // never rendered, which no print can exist for.
    name: '014_receipt_history',
    sql: `
      ALTER TABLE receipts ADD COLUMN items TEXT;
      ALTER TABLE receipts ADD COLUMN png BLOB;

      CREATE TABLE receipt_prints (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        receipt_id  INTEGER NOT NULL REFERENCES receipts(id),
        copy        INTEGER NOT NULL CHECK (copy IN (0, 1)),
        actor       TEXT    NOT NULL,
        device      TEXT,
        status      TEXT    NOT NULL DEFAULT 'sending'
                      CHECK (status IN ('sending','sent','interrupted','failed')),
        percent     INTEGER CHECK (percent IS NULL OR percent BETWEEN 0 AND 100),
        error       TEXT,
        started_at  TEXT    NOT NULL DEFAULT (datetime('now')),
        finished_at TEXT
      );
      CREATE INDEX idx_receipt_prints_receipt ON receipt_prints(receipt_id);
    `
  },
  {
    // AI screening on the guest Истражување tab. Until now that tab was a link
    // launcher and the CMS stored nothing but the fact a link was opened. The
    // AI run is different in kind: the server hands guest details to Claude
    // and/or Codex, and what comes back IS the due-diligence record an AML
    // file wants kept. So reports are stored -- admin-only, and deletable
    // outright when a run turned out to be noise. Deleting removes the report;
    // the audit_log entries that a run happened, and was deleted, stay.
    //
    // `subject` is the JSON snapshot of exactly what was disclosed to the
    // engines, taken when the run started, so a later edit to the guest cannot
    // rewrite what the record says was sent.
    //
    // One results row per engine, so a run on both can finish half-failed and
    // still show the half that worked. ON DELETE CASCADE is what makes deleting
    // a run one statement; foreign_keys is ON in every connection (db/index.ts).
    name: '015_osint_runs',
    sql: `
      CREATE TABLE osint_runs (
        id          TEXT PRIMARY KEY,
        player_id   TEXT NOT NULL REFERENCES players(id),
        actor       TEXT NOT NULL,
        reason      TEXT NOT NULL,
        engines     TEXT NOT NULL CHECK (engines IN ('claude','codex','both')),
        status      TEXT NOT NULL DEFAULT 'running'
                      CHECK (status IN ('running','done','failed')),
        subject     TEXT NOT NULL,
        merged      TEXT,
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        finished_at TEXT
      );
      CREATE INDEX idx_osint_runs_player ON osint_runs(player_id, created_at);

      CREATE TABLE osint_engine_results (
        run_id      TEXT NOT NULL REFERENCES osint_runs(id) ON DELETE CASCADE,
        engine      TEXT NOT NULL CHECK (engine IN ('claude','codex')),
        status      TEXT NOT NULL DEFAULT 'running'
                      CHECK (status IN ('running','done','failed')),
        report      TEXT,
        queries     TEXT NOT NULL DEFAULT '[]',
        cost_usd    REAL,
        error       TEXT,
        started_at  TEXT NOT NULL DEFAULT (datetime('now')),
        finished_at TEXT,
        PRIMARY KEY (run_id, engine)
      );
    `
  },
  {
    // The general profile ("Општ профил") reason, which collects photos.
    //
    // osint_images: photos a profile run found, DOWNLOADED rather than linked,
    // because social-media image URLs are signed and expire within days. This is
    // the first place the CMS server itself fetches arbitrary URLs, so the
    // downloader (domain/osintImages.ts) only connects to public addresses —
    // the slot machines share this LAN — accepts only JPEG/PNG/GIF/WebP by magic
    // bytes, and caps size and count. Rows are kept for failed downloads too,
    // so the report can say what it could not fetch. Deleting a run cascades.
    //
    // face_*: the 1:1 comparison of each photo against the guest's own reference
    // photo, computed in the admin's browser. Only the outcome is stored; face
    // descriptors never leave the browser's memory.
    //
    // player_photos: that reference photo. Using a face to recognise someone is
    // special-category biometric processing under the data protection law, and
    // the lawful basis here is the guest's explicit consent — so the row cannot
    // exist without consent_by, which the API refuses to fill in unasked.
    name: '016_osint_profile',
    sql: `
      CREATE TABLE osint_images (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id           TEXT NOT NULL REFERENCES osint_runs(id) ON DELETE CASCADE,
        origin           TEXT NOT NULL CHECK (origin IN ('report','account')),
        image_url        TEXT,
        page_url         TEXT NOT NULL,
        description      TEXT,
        match_confidence TEXT NOT NULL CHECK (match_confidence IN ('low','medium','high')),
        engines          TEXT NOT NULL DEFAULT '[]',
        status           TEXT NOT NULL CHECK (status IN ('stored','failed')),
        content_type     TEXT,
        bytes            BLOB,
        sha256           TEXT,
        error            TEXT,
        face_verdict     TEXT CHECK (face_verdict IN ('match','possible','different','no_face')),
        face_distance    REAL,
        faces            INTEGER,
        face_checked_at  TEXT,
        created_at       TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_osint_images_run ON osint_images(run_id);

      CREATE TABLE player_photos (
        player_id    TEXT PRIMARY KEY REFERENCES players(id),
        content_type TEXT NOT NULL,
        bytes        BLOB NOT NULL,
        sha256       TEXT NOT NULL,
        consent_by   TEXT NOT NULL,
        consent_at   TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `
  },
  {
    // A live log of what each AI engine is doing — searches, pages opened,
    // result counts, its own narration — so a run that is thinking for a minute
    // does not look identical to one that has hung. JSON array of
    // {t, kind, text}, appended as the CLI streams, capped in osintRuns.ts.
    // `queries` stays as the plain search list the report has always shown.

    name: '017_osint_activity',
    sql: `
      ALTER TABLE osint_engine_results ADD COLUMN activity TEXT NOT NULL DEFAULT '[]';
    `
  },
  {
    // How long an order containing this drink actually takes, learned from
    // fulfilled orders, so the terminal can promise the guest something real
    // the moment the order is placed -- before the bar has accepted it.
    //
    // avg_prep_s NULL means "never timed"; every reader falls back to the
    // module default rather than treating NULL as zero. Additive on
    // menu_items for the reason 011 was additive on orders: order_items and
    // pos_intents both point at drink_id, and rebuilding that table under
    // foreign_keys would be a far bigger change than the feature deserves.
    name: '018_menu_prep_stats',
    sql: `
      ALTER TABLE menu_items ADD COLUMN avg_prep_s   INTEGER;
      ALTER TABLE menu_items ADD COLUMN prep_samples INTEGER NOT NULL DEFAULT 0;
    `
  }
]