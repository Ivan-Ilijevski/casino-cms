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
│   ├── receiptHistory.ts # Stored receipts, reprints, print log
│   ├── paymentSlip.ts   # Guest's card slip facts (not fiscal, never stored)
│   ├── businessDay.ts   # Local-day boundary (IANA zone)
│   ├── uid.ts           # Card UID normalisation (canonUid)
│   ├── staffUsers.ts    # Staff user CRUD
│   ├── customers.ts     # Customer/player management
│   ├── password.ts      # Scrypt password hashing
│   ├── translit.ts      # Macedonian Cyrillic ↔ Latin name spellings (search only)
│   ├── osintSubject.ts  # What an AI screening may disclose (never doc_id)
│   ├── osintPrompt.ts   # Screening prompt, strict report schema, sanitizeReport
│   ├── osintEngines.ts  # Headless claude/codex CLI runner (web tools only)
│   ├── osintMerge.ts    # Deterministic cross-check of two engines' reports
│   ├── osintRuns.ts     # Stored runs, link-lookup history
│   ├── osintScreening.ts # Background run driver, cancel on delete
│   ├── osintImages.ts   # Fenced photo downloader for profile runs (public IPs only)
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
│       ├── osint.ts     # Link-lookup audit + AI screening runs
│       ├── players.ts
│       ├── pos.ts
│       ├── receipts.ts  # Receipt history, image, print log
│       ├── reports.ts
│       ├── tickets.ts
│       └── users.ts
web/                     # Staff SPA (Vite + React)
├── src/
│   ├── main.tsx         # React entry, SW unregistration
│   ├── App.tsx          # Router, role-gated views
│   ├── api.ts           # Fetch wrapper for all /api/* calls
│   ├── printer.ts       # Web Bluetooth thermal printer (X5/X5h), auto-reconnect
│   ├── receiptPrint.ts  # Logged print path + КОПИЈА band, shared by POS and history
│   ├── paymentSlip.ts   # Draws the Ingenico-style card slip above a receipt
│   ├── webnfc.ts        # Web NFC card reader
│   ├── fullscreen.ts    # Fullscreen API for kiosk mode
│   ├── roles.ts         # Role constants
│   ├── format.ts        # Currency/date formatting
│   ├── osint.ts         # OSINT link-launcher source registry
│   ├── faceMatch.ts     # In-browser 1:1 face comparison (lazy face-api)
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

Each receipt stores its rendered PNG and lines (`receipts.png`/`items`); reprints use
the stored image, never a fresh render. Receipt lines are read from `order_items` +
`menu_items`, not from the request. `receipt_prints` is the per-attempt print log the
tablet reports (`sending` → `sent`/`interrupted`/`failed`); the server decides whether
a print is a КОПИЈА (an earlier attempt reached `sent`) and audits it as
`receipt.reprint`. `rendered_at` is not "printed".

## Card payment slip

Every POS card payment prints an Ingenico-style slip for the guest (logo, address,
ПРОДАЖБА/ИСПЛАТА, date, masked card, contactless and PIN, guest, operator, order and
reference, amount, balances before and after). Its lines pack two facts each, and a
label steps down to a shorter spelling when a line overflows (`web/src/paymentSlip.ts`). A
bar sale prints it above the fiscal receipt in one job, and Наплата/Исплата prints it
alone. The slip is **not fiscal**: it is never stored, numbered, logged, or КОПИЈА-banded.
Its facts arrive only in the `/pos/confirm` response (`src/domain/paymentSlip.ts`), and
the tablet draws them at print time. A reprint from Сметки is the fiscal receipt alone.

## OSINT (guest Истражување tab)

Admin-only, and every action needs a reason (`kyc`/`aml`/`self_exclusion`/`dispute`/`other`).

- **Link tiles** open public sites in the browser. The server fetches nothing; it
  audits `osint.lookup` before the tab is allowed to navigate. Source ids key the
  audit history — never rename one.
- **AI screening** runs the `claude` and/or `codex` CLI **on the CMS host**, headless,
  on that host's own login (`claude login` / `codex login`). Each run is stored in
  `osint_runs` + `osint_engine_results` until an admin deletes it; start and delete
  are audited (`osint.ai_run`, `osint.ai_delete`), the findings are not copied into
  the audit log.

Invariants:
- `doc_id` is never disclosed to an engine — `buildSubject` does not read it.
- Engines get web tools only. Claude: `--tools WebSearch,WebFetch --safe-mode
  --strict-mcp-config`. Codex: `--disable shell_tool --disable unified_exec`,
  read-only sandbox, `--ignore-user-config`. Web pages are untrusted input; don't
  loosen these flags.
- `sanitizeReport` drops findings without an http(s) source; a match verdict with no
  surviving findings becomes `insufficient_data`.
- Cross-checking is plain code (`osintMerge.ts`), not a third model call.
- Suggested tags (`pep`, `sanctions_hit`, `watchlist`) are applied only by an admin's
  click, and only if that run suggested them.
- A run is driven in-process; `failInterruptedRuns` marks leftovers failed at boot.
- Each engine's stdout is parsed into a live **activity log** (`osint_engine_results.activity`,
  migration 017): searches, pages opened, result counts, the engine's narration. Codex
  web_search actions come in several shapes — `search` with `query` *or* a batched
  `queries[]`, `open_page`, `find_in_page` — and all must be read, or its runs look frozen.
- Tests never spawn a real CLI: `StaffDeps.osint` is unset unless injected.

**General profile** (reason `profile`, "Општ профил"): a broader prompt
(`buildProfilePrompt`) — online accounts, work, education, business, media,
interests, risk — plus photos. Same out-of-scope list as screening (`OUT_OF_SCOPE`
in `osintPrompt.ts`): no special categories, home address/whereabouts, relatives,
leaked data, people-search sites or login-walled content. Uses its own limits
(`CMS_OSINT_PROFILE_*`).

- **Photos are downloaded** (`osint_images`, migration 016) by `osintImages.ts`, the
  only code that fetches engine-supplied URLs. Invariants: connect only to public
  addresses (checked inside the socket's DNS lookup, so DNS rebinding can't reach the
  LAN), http/https on default ports, ≤3 re-checked redirects, 10 s/request, 5 MB cap,
  stored only if the bytes are JPEG/PNG/GIF/WebP (never SVG), ≤12 per run, and only
  for medium/high-confidence pages. Attribution is by the page, not the face.
- **Face comparison is 1:1** against the guest's reference photo (`player_photos`),
  which the API refuses to store without `?consent=1` and records who took consent.
  It runs in the admin's browser (`web/src/faceMatch.ts`); only verdict + distance
  reach the server, never descriptors. `/api/face-models` serves an allowlist —
  detector, landmarks, recognition — and deliberately not the age/gender/expression
  models. Results are advisory and never apply tags. No reverse face search, and faces
  are never sent to the AI engines.

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
| `CMS_OSINT_CLAUDE_BIN` / `CMS_OSINT_CODEX_BIN` | AI screening CLIs; empty disables | `claude` / `codex` |
| `CMS_OSINT_CLAUDE_MODEL` / `CMS_OSINT_CODEX_MODEL` | `--model` per engine | `sonnet` / (CLI default) |
| `CMS_OSINT_TIMEOUT_MS` | Per-engine run timeout | `480000` |
| `CMS_OSINT_CLAUDE_MAX_USD` | Claude `--max-budget-usd` per run | `2` |
| `CMS_OSINT_PROFILE_TIMEOUT_MS` / `CMS_OSINT_PROFILE_CLAUDE_MAX_USD` | Same limits for general-profile runs | `900000` / `5` |

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
