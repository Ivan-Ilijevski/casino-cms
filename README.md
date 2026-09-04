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

## POS tap-to-pay (`/pos`) — Chrome on Android only

Staff build an order on a tablet, hand it to the customer, and the customer taps
their player card on the same tablet to pay. A 4-digit PIN is demanded on a random
**1 in 8** payments; the other 7 are a single tap.

**This only works in Chrome on Android**, because Web NFC (`NDEFReader`) exists
nowhere else. The POS tab feature-detects and explains itself rather than offering
a dead button.

### Setting it up on the tablet

1. Cards must be **NTAG21x / MIFARE Ultralight**. Web NFC reads NFC Forum Type 1–5
   only — **MIFARE Classic will never fire a read event**. The RC522 terminal does
   no type filtering (`nfc.c` checks only `state == ACTIVE`), so NTAG works on both.
2. Web NFC needs a **secure context**, and `http://<lan-ip>:8090` is not one. For
   development, on the tablet open `chrome://flags/#unsafely-treat-insecure-origin-as-secure`,
   add `http://<lan-ip>:8090`, set it to Enabled, and restart Chrome.
   **For production, serve the staff app over real HTTPS** — the flag is per-device
   and turns off a security check.
3. Enable NFC on the tablet. `scan()` also requires a user gesture, hence the
   explicit "Активирај читач" button.

### Fullscreen on the tablet (PWA install is disabled)

Use **Поставки → Влези во цел екран** (the gear beside the role in the side menu). It
uses the Fullscreen API, so it needs no install and works in a plain Chrome tab: the
browser UI and the Android status/nav bars go away. The choice is remembered, and since
a reload always drops fullscreen and the API refuses to re-enter without a gesture, the
first tap after any reload silently restores it — a kiosk reboot costs one tap.

**Do not use Chrome's "Install app".** It is switched off deliberately: `web/index.html`
no longer links the manifest, so Chrome offers no install. The WebAPK Chrome mints ships
**DEX 039** bytecode, introduced in Android 9 (API 28). Our Android 8.0 kiosk is API 26
and reads to DEX 038, so the dex will not open, every class in it is missing — including
Chrome's own `SplashContentProvider` — and the icon dies on launch with *"CMS keeps
stopping"*. The signature in `adb logcat -b crash`:

```
java.io.IOException: Failed to open dex files from …/base.apk
  because: Unrecognized version number in …/base.apk: 0 3 9
```

Nothing in a web manifest can influence an APK's DEX version, so this is not fixable from
this repo — only withdrawable. `web/src/main.tsx` also *unregisters* any service worker
left behind rather than merely stopping registration, because a registered worker outlives
the code that registered it; devices are swept on their next load.

If a tablet still has the crashing icon, it is a real package — remove it with
`adb uninstall org.chromium.webapk.aff984add835f14e5_v2` (the hash differs per origin;
`adb shell pm list packages | grep webapk` finds it).

`web/public/manifest.webmanifest`, `web/public/sw.js` and `web/public/icons/` are still
built and served on purpose. The planned replacement — a Trusted Web Activity we build
ourselves with `minSdkVersion 21`, giving a loadable DEX 035 — is seeded from that manifest
over HTTPS. See `.claude/plans/android-8-twa-apk.md`. A normal PWA install still works on
Android 9+, should you re-enable the `<link>`.

### Two readers, two spellings of the same card

The RC522 sends `"9C 76 5A F4"` (uppercase, space-separated); Web NFC gives Chrome
`"9c:76:5a:f4"` (lowercase, colon-separated). `cards.card_uid_canon` holds the
separator-less uppercase form and is what every lookup matches on — without it a
POS tap would never find its card. `canonUid` in `src/domain/uid.ts` is the single
normalisation point.

### Why the PIN check is two requests

`POST /api/pos/intent` prices the cart **and decides server-side** whether this
payment is PIN-checked, persisting that on the intent. `POST /api/pos/confirm`
reads the requirement back off the stored intent. If the client made that call it
would simply never ask for a PIN. Intents are single-use and expire after 2 minutes.

A 4-digit PIN is only 10⁴ combinations, so 5 wrong attempts lock the card for POS
for 15 minutes — otherwise `confirm` is a brute-force oracle. Cards **without** a
PIN are refused at the POS rather than silently skipping the check; staff set the
PIN at registration (`POST /api/cards` with `pin`, or `POST /api/cards/:id/pin`).

Only POS uses the PIN. The card terminal, ordering at the machine, and cashout are
untouched.

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
- `CMS_RECEIPT_API_URL` / `CMS_RECEIPT_API_KEY` — origin and key for the external
  fiscal receipt-render service the POS calls after a bar payment when
  "Испринтај фискална" is checked. Unset = `POST /api/pos/receipt` fails closed
  with 503 rather than silently skipping the print.

## Not built yet (deliberately)

- SAS **meter reconciliation** (the ledger is shaped for it; the nightly compare
  and the SMIB meter-snapshot upload are a later phase).
- TLS/mTLS on the TCP leg, and DESFire challenge-response cards — card UID auth is
  cloneable, which is a known limitation carried over from the prototype.
- Redeeming a TITO ticket onto a player card.
