# AGENTS.md

Context file for AI coding agents working on this codebase.

## What this is

Casino Management System for the Shining Crown slot machine. Handles player-card
auth, drink ordering, TITO (Ticket-In/Ticket-Out) tickets, a POS tap-to-pay bar
terminal, fiscal receipt printing, and a staff dashboard — backed by SQLite.

It replaces two earlier prototypes and is a drop-in for both:
- `cms_server.py` — in-memory CMS with one hard-coded player → persistent CMS on **TCP 9020**
- `voucher-server.js` — simple voucher DB → real TITO ticket lifecycle on **HTTP 8080**

The staff web app on **HTTP 8090** is new.

## Tech stack

- **Runtime**: Node.js ≥ 20.12, ESM (`"type": "module"`)
- **Language**: TypeScript (strict mode, `noUncheckedIndexedAccess`)
- **Server**: Express 5, TCP socket (raw mux-framed JSON)
- **Database**: SQLite via `better-sqlite3` (synchronous, WAL mode)
- **Frontend**: React 19 + React Router 7, built with Vite 8
- **Tests**: Vitest 4, Supertest for HTTP
- **Other**: Web NFC (Android Chrome only), Web Bluetooth (Chromium only)

## Repository layout

```
src/
├── main.ts              # Entrypoint — starts TCP, voucher HTTP, staff HTTP servers
├── config.ts            # All env vars → typed Config (validated at boot)
├── events.ts            # In-process event bus (TCP ↔ staff SSE)
├── db/
│   ├── index.ts         # Opens SQLite, runs migrations
│   ├── migrations.ts    # Ordered, append-only migrations (inlined SQL)
│   ├── seed.ts          # Seeds menu + admin user
│   └── importVouchers.ts # One-time import from legacy vouchers.db
├── domain/              # Business logic (the money core)
│   ├── ledger.ts        # Append-only ledger; balance = SUM(entries)
│   ├── holds.ts         # Debit hold → commit/rollback (AFT lifecycle)
│   ├── credits.ts       # Credit card (TITO redeem, cashier top-up)
│   ├── tickets.ts       # TITO ticket issue/redeem/void/expire
│   ├── orders.ts        # Drink orders from terminal or POS
│   ├── pos.ts           # POS intent/confirm flow, PIN verification
│   ├── sessions.ts      # Terminal sessions (idle sweep)
│   ├── accounts.ts      # Card/player lookups
│   ├── menu.ts          # Menu items (firmware wire format)
│   ├── points.ts        # Loyalty point calculation
│   ├── receipt.ts        # Fiscal receipt render request
│   ├── receiptNumbers.ts # Daily receipt numbering
│   ├── businessDay.ts   # Local-day boundary (IANA zone)
│   ├── uid.ts           # Card UID normalisation (canonUid)
│   ├── staffUsers.ts    # Staff user CRUD
│   ├── customers.ts     # Customer/player management
│   ├── password.ts      # Scrypt password hashing
│   └── audit.ts         # Audit log
├── wire/                # Firmware protocol layer
│   ├── mux.ts           # Mux framing (0x7E sync, CRC-16/KERMIT)
│   ├── handlers.ts      # CMS message handlers (auth, debit, credit, order…)
│   ├── tcpServer.ts     # TCP server on port 9020
│   ├── push.ts          # balance_push / logout_push to terminal
│   ├── envelope.ts      # Request/response envelope types
│   └── limits.ts        # Firmware C buffer limits
├── http/
│   ├── server.ts        # Express app (staff dashboard + API)
│   ├── staffAuth.ts     # Cookie-based staff auth
│   ├── voucherLegacy.ts # Legacy voucher API on port 8080
│   ├── deps.ts          # Dependency injection for HTTP layer
│   └── routes/          # API route modules
│       ├── customers.ts
│       ├── menu.ts
│       ├── orders.ts
│       ├── players.ts
│       ├── pos.ts
│       ├── reports.ts
│       ├── tickets.ts
│       └── users.ts
web/                     # Staff SPA (Vite + React)
├── src/
│   ├── main.tsx         # React entry, SW unregistration
│   ├── App.tsx          # Router, role-gated views
│   ├── api.ts           # Fetch wrapper for all /api/* calls
│   ├── printer.ts       # Web Bluetooth thermal printer (X5/X5h)
│   ├── webnfc.ts        # Web NFC card reader
│   ├── fullscreen.ts    # Fullscreen API for kiosk mode
│   ├── roles.ts         # Role constants
│   ├── format.ts        # Currency/date formatting
│   ├── styles.css       # Single CSS file
│   ├── views/           # Page-level components
│   └── components/      # Shared UI components
├── index.html
└── tsconfig.json
test/                    # 28 test files (Vitest)
data/cms.sqlite          # SQLite database file (gitignored in production)
```

## Commands

```bash
npm install              # Install deps (see note about web-timini-print below)
npm run build            # Typecheck + compile server + build SPA
npm run dev              # Start server with tsx watch (hot-reload)
npm run dev:web          # Vite dev server for SPA only (proxies /api to :8090)
npm test                 # Run all tests (vitest run)
npm run test:watch       # Vitest in watch mode
npm run seed             # Seed menu items + admin user
npm run import:vouchers  # Import legacy vouchers.db
npm run typecheck        # Typecheck both server and web tsconfigs
npm run build:server     # Compile server only
npm run build:web        # Build SPA only
```

## Critical invariants — do NOT break these

### Money is always integer deni

1 MKD = 100 deni. All money values throughout the system are **integer deni**.
Never use floats for money. The only conversion to/from whole denars happens in
`src/domain/tickets.ts` (`denarsToDeni` / `deniToDenars`) for the legacy voucher
API compatibility.

### The ledger is append-only

`ledger_entries` is never UPDATEd or DELETEd. Balance = `SUM(amount)` per
`(card_id, unit)`. The `balance_deni` / `points` columns on `cards` are a
**cache** and are always recomputable via `recomputeCache()`. Corrections are new
compensating entries, not edits.

### Idempotency of wire handlers

`debit_commit`, `debit_rollback`, and `credit_req` are **idempotent by `txn`**.
After a successful transfer the firmware retries `debit_commit` *forever* and
must never receive a rollback. A handler that throws deliberately sends **no
reply** — the firmware then retries, which is safer than a spurious error.

### Holds carry session context

Firmware txns recycle on every SMIB reboot (`SMIB-%06u` wraps). Debit replay
detection matches `(txn, session_id, card_id, amount_deni)` — not txn alone
(migration 003). Two open holds under one txn are refused rather than guessed.

### Migrations are append-only

`src/db/migrations.ts` holds an ordered list, applied once and recorded in
`schema_migrations`. **Never edit an applied migration — add a new one.** In-memory
test DBs are built fresh and won't catch a modified migration.

## Firmware wire limits

The terminal copies JSON into fixed C buffers with `snprintf`. Oversized values
are **silently truncated** — a truncated `sid` makes every later debit fail.
See `src/wire/limits.ts`:

| Limit | Value | Source |
|---|---|---|
| `sid` | ≤ 23 chars | `char sid[24]` |
| `txn` | ≤ 23 chars | `char txn[24]` |
| player name | ≤ 63 bytes | `char name[64]` (Cyrillic = 2 bytes/char) |
| drink name | ≤ 47 bytes | `char name[48]` |
| menu items | ≤ 16 | `CMS_MENU_MAX_ITEMS` |
| reply timeout | 3 s | `CMS_REQUEST_TIMEOUT_US` |

## Wire protocol

Mux framing: `[0x7E][chan][len_lo][len_hi][payload…][crc_lo][crc_hi]`
- Channel `0x02` = CMS, `0x01` = SAS, `0x7F` = log
- CRC-16/KERMIT over chan+len+payload, appended LSB-first
- Payload is UTF-8 JSON
- The format is fixed — ported from firmware, Python sim, and the slot game's bridge

Message types: `hello`, `ping/pong`, `auth_req/res`, `logout`, `debit_req/res`,
`debit_commit/res`, `debit_rollback/res`, `credit_req/res`, `menu_req/res`,
`order_req/res`, `balance_push`, `logout_push`.

## Card UID normalisation

The RC522 terminal sends `"9C 76 5A F4"` (uppercase, space-separated). Web NFC
gives `"9c:76:5a:f4"` (lowercase, colon-separated). `canonUid()` in
`src/domain/uid.ts` strips separators and uppercases — this is the single
normalisation point. The `card_uid_canon` column stores the canonical form.

## POS flow

1. `POST /api/pos/intent` — prices cart, decides server-side if PIN is needed
   (1 in 8 spot-check for debits, always for credits), persists decision
2. `POST /api/pos/confirm` — reads PIN requirement from stored intent, charges card
3. Intents are single-use, expire after 2 minutes
4. 5 wrong PIN attempts → 15-minute lockout
5. Cards without a PIN are refused at POS, not silently skipped

## Receipt numbering

Receipt numbers restart at `#0001` each **local** calendar day (`CMS_TIME_ZONE`).
The `receipts` table is the counter — `MAX(seq) WHERE day = ?`. A failed render
gives its number back to keep the sequence dense. The day boundary uses ICU
`Intl.DateTimeFormat`, not UTC offsets.

## Configuration

All config via environment variables (see `.env.example`). Key ones:

| Variable | Purpose | Default |
|---|---|---|
| `CMS_SESSION_SECRET` | Signs staff cookies — **change it** | `change-me-in-production` |
| `CMS_VOUCHER_API_KEY` | Must match slot game's `VOUCHER_API_KEY` | `ivan1507` |
| `CMS_POINTS_PER_MKD` | Loyalty points per denar on commit (0 = off) | `1` |
| `CMS_TICKET_EXPIRY_DAYS` | Empty = never expire (legacy behaviour) | (empty) |
| `CMS_TIME_ZONE` | IANA zone for fiscal day boundary | `Europe/Skopje` |
| `CMS_RECEIPT_API_URL` | External receipt-render service origin | (empty) |
| `CMS_DB_PATH` | SQLite file path | `./data/cms.sqlite` |

## Testing conventions

- Tests are in `test/` (flat, one file per concern)
- Each test gets a fresh in-memory SQLite DB with all migrations applied
- Protocol tests are ported from the firmware's golden vectors (`selftest.py`)
- Legacy voucher tests pin every status code and response shape
- Tests run with `pointsPerMkd: 0` for protocol vectors (matching Python prototype)
- Use `vitest` assertions; HTTP tests use `supertest`

## Known issues

- `web-timini-print` is installed from a local absolute path
  (`git+file:///Users/ivanilijevski/Web-TiMini-Print`) — `npm ci` fails on other
  machines. Needs to be vendored as a tarball or pushed to a git remote.
- PWA install is deliberately disabled (DEX version incompatibility with Android 8 kiosk)
- Card auth is UID-only (cloneable) — DESFire challenge-response is a future phase

## Style notes

- UI strings are in **Macedonian** (Cyrillic). This is intentional — don't
  "fix" strings like `"испратено"` (sent) to English or change them to
  `"испечатено"` (printed). The wording is deliberate.
- `НА КРЕДИТ` (on credit) on receipts for card payments is correct — the POS
  takes no cash, so every sale is from a card balance. `ВО ГОТОВО` (cash) must
  never appear on a POS receipt.
- `balance_push` / `logout_push` are real features this CMS sends (the Python
  prototype never did). Don't remove them thinking they're dead code.
