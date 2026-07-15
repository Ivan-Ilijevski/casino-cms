# casino-cms

The Casino Management System behind the Shining Crown slot machine: player-card
auth, drink ordering, TITO tickets, and a staff dashboard — backed by SQLite.

It replaces **two throwaway prototypes** and is a drop-in for both, so nothing
downstream needs changing:

| It replaces | With |
|---|---|
| `esp/cms-auth-terminal/cyd_test/tools/host_sim/cms_server.py` (in-memory, one hard-coded player, no persistence) | A persistent CMS speaking the **same firmware JSON contract** on **TCP 9020** |
| `voucher-server/voucher-server.js` (one table, two-state vouchers, no audit trail) | A real **TITO** ticket lifecycle behind the **byte-compatible legacy API** on **8080** |

…and adds the thing that never existed: a **staff web app** on **8090**.

## Listeners

| Port | What | Notes |
|---|---|---|
| **9020** TCP | SMIB card terminal (mux-framed JSON, channel `0x02`) | The slot game's `cmsBridge.ts` already points here |
| **8080** HTTP | Legacy voucher API | The slot game hard-codes this — **stop the old `voucher-server.js` first** |
| **8090** HTTP | Staff dashboard + API | New |

## Quick start

```bash
npm install
cp .env.example .env          # then set CMS_SESSION_SECRET

npm run seed                  # 5 drinks + an admin user (prints a generated password once)
npm run import:vouchers       # one-time: pull in the legacy vouchers.db

npm run build                 # typecheck + build the staff SPA
npm run dev                   # or: npm start (after build)
```

Then open <http://localhost:8090>.

Set `CMS_ADMIN_PASSWORD` before `npm run seed` to choose the admin password
instead of having one generated.

## Switching over from the prototypes

1. **Stop** `cms_server.py` / `cms_tcp_server.py` and `voucher-server.js` — this
   service takes both ports (9020 and 8080).
2. `npm run import:vouchers` — copies every legacy voucher across, preserving id,
   amount, created-at, and used-state. Idempotent, and read-only on the source.
3. Start the CMS. The slot game needs **no changes**: `sasSettings.json` already
   targets `127.0.0.1:9020`, and `.env.local` already targets `:8080`.

## Money units — read this before touching money code

| Boundary | Unit |
|---|---|
| Card ledger, orders, tickets, the slot game's wallet and meters | **integer deni** (1 MKD = 100 deni) |
| Firmware wire (`amount` / `balance` / `price`) | **integer deni** — the field is *named* after cents, but `cms_types.h` says `uint64_t balance; // integer cents (дени)`. Same integer, no conversion. |
| **Legacy voucher API (`credit`)** | **whole denars** — the slot game sends `amount / 100` and `Math.round(credit * 100)`s it back |

`denarsToDeni` / `deniToDenars` in `src/domain/tickets.ts` are the **only** places
that convert. Everything is integer arithmetic; never use floats for money.

## Firmware limits are load-bearing

The terminal copies our JSON into fixed C buffers with `snprintf`, so oversized
values are **silently truncated** — a truncated `sid` would make every later debit
fail. `src/wire/limits.ts` encodes these, and the staff API rejects input that
would overflow them:

| Limit | Source |
|---|---|
| `sid` ≤ 23 chars | `char sid[24]` in `cms_types.h` |
| `txn` ≤ 23 chars | `char txn[24]` in `cms.c` |
| player name ≤ 63 **bytes** | `char name[64]` — Cyrillic is 2 bytes/char |
| drink name ≤ 47 **bytes** | `char name[48]` |
| **menu ≤ 16 items** | `CMS_MENU_MAX_ITEMS` — the terminal stops parsing there, so extra drinks are invisible. The staff app warns rather than letting them vanish. |
| reply within 3 s | `CMS_REQUEST_TIMEOUT_US` |

## The invariant that matters most

`debit_commit`, `debit_rollback` and `credit_req` are **idempotent by `txn`**.
After a successful transfer the firmware retries `debit_commit` *forever* and must
never receive a rollback. A handler that throws deliberately sends **no reply** —
the firmware then retries, which is far safer than a spurious error that would
strand money and show "контактирајте персонал".

## Architecture

```
ESP32 terminal ──serial──> slot game cmsBridge.ts ──TCP 9020──> casino-cms
slot game cashout/redeem ─────────────HTTP 8080───────────────> casino-cms
staff browser ────────────────────────HTTP 8090───────────────> casino-cms
```

- `src/domain/` — the money core. `ledger.ts` is append-only and **balance =
  SUM(entries)**; the `balance_deni` / `points` columns on `cards` are only a
  cache and are always recomputable (`recomputeCache`). Holds are first-class
  rows that survive restart.
- `src/wire/` — firmware contract: `mux.ts` (framing, ported from
  `muxCodec.ts`), `handlers.ts`, `tcpServer.ts`, `push.ts`.
- `src/http/` — `voucherLegacy.ts` (the 8080 compat facade) and the staff app.
- `web/` — the staff SPA (Vite + React).

**Tickets are machine money, not card money**: the slot game redeems a ticket into
its own wallet, so tickets live outside the card-keyed ledger and carry their own
append-only `ticket_events` trail.

### `balance_push` / `logout_push`

The firmware has always handled both (`cms.c` `k_msg_map`, `is_push=true`) but the
Python CMS never sent either. This CMS does: adjust a balance and the terminal
updates immediately; block a card and it logs out on the spot.

## Tests

```bash
npm test
```

The protocol suite is ported from the firmware's own golden vectors
(`tools/host_sim/selftest.py`) — the full auth → debit → commit / rollback /
credit idempotency chains, order maths, and mux resync. It runs with
`pointsPerMkd: 0` because the Python prototype never awarded points on commit;
with earning on, its `points === 20` assertion would drift. The earn rule is
tested separately.

The legacy voucher suite pins every status code and response shape against
`voucher-server.js`, including its quirks (only `/generate` checks the API key;
`/validate` cannot tell "already used" from "never existed").

## Migrations

`src/db/migrations.ts` holds an ordered list, applied once each and recorded in
`schema_migrations`. **Once this has run anywhere real, never edit an applied
migration — add a new one.** Editing one in place leaves existing databases
silently behind the schema (in-memory test DBs are built fresh and won't catch it).

## Configuration

See `.env.example`. Notable:

- `CMS_SESSION_SECRET` — **change it**; it signs staff cookies.
- `CMS_VOUCHER_API_KEY` — must match the slot game's `VOUCHER_API_KEY`.
- `CMS_POINTS_PER_MKD` — loyalty points per denar on commit (`0` disables).
- `CMS_TICKET_EXPIRY_DAYS` — empty = never expire, matching the legacy server.
  Tickets print "valid 30 days" but the old server never enforced it; set this to
  start enforcing.

## Not built yet (deliberately)

- SAS **meter reconciliation** (the ledger is shaped for it; the nightly compare
  and the SMIB meter-snapshot upload are a later phase).
- TLS/mTLS on the TCP leg, and DESFire challenge-response cards — card UID auth is
  cloneable, which is a known limitation carried over from the prototype.
- Redeeming a TITO ticket onto a player card.
