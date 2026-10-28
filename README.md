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

### Fiscal receipts print over Bluetooth (X5/X5h, no share sheet)

With "Испринтај фискална" checked, `POST /api/pos/receipt` proxies the render to the
external Receipt Render API (`CMS_RECEIPT_API_URL`, see **Configuration**) and the PNG
that comes back is sent **straight to the printer over Web Bluetooth**. There is no share
sheet and no third-party printer app in the path any more. The render API returns the
image exactly **384 px wide** — the X5's native raster width — so nothing is resampled:
`preparePngImage` only composites it on white, greys it and Atkinson-dithers it to 1-bit.
`web/src/printer.ts` owns the connection, on top of the local `web-timini-print` package.

**The tender line always says a card paid.** Every POS sale prints **`НА КРЕДИТ`**, and only
a points purchase prints **`ПОЕНИ`** — `ВО ГОТОВО` can never appear, because the POS takes no
cash: a sale is always settled from a balance held on the guest's card. Note that the
`cash` pay method names the card's **денари** balance, not banknotes, which is why it prints
as a card payment; that is not a typo waiting to be tidied up. The browser sends only
`payMethod: 'cash' | 'points'` and the server picks the printed string
(`PAYMENT_METHOD_LABELS` in `src/domain/receipt.ts`), so an unknown or missing value is a
400 and nothing prints. That is deliberate: the render API fills every field it is *not*
sent from its own preset, whose payment method is `ВО ГОТОВО`, so an omitted tender line
does not fail — it quietly prints a cash sale that never happened.

**Receipt numbers restart at 0001 every day.** The number is allocated server-side per
sale and printed in the header as `#0001`. The `receipts` table *is* the counter —
`MAX(seq) WHERE day = ?`, the same shape `orders.number` already uses — so there is no
separate "last number" row that can drift from the receipts actually issued, and every
number is recorded against the sale that earned it, with who printed it. A reprint of one
sale reuses its number rather than taking a new one; `order_id` is UNIQUE, so a second
fiscal document for one sale is not merely discouraged but impossible.

The day is the **local** calendar day (`CMS_TIME_ZONE`, see **Configuration**), computed
through ICU in `src/domain/businessDay.ts` — deliberately **not** `date(created_at)`, which
is UTC and would roll the counter at 01:00 or 02:00 Skopje, in the middle of service. Nor a
hardcoded +2: that is wrong for half the year and wrong in both directions across the two
changeover weekends, which the tests pin.

**A failed render gives its number back**, so the sequence stays dense — a hole in a daily
fiscal sequence is exactly what gets asked about later. The number has to be allocated
*before* the render (it goes into the request, and better-sqlite3 cannot hold a transaction
across an `await`), so the release is a compensating delete, guarded two ways: it only ever
touches a row that never printed, and only the tail of its day. If a later sale already took
the next number, the delete is a no-op and the row stays with `rendered_at` NULL — which
reads as "allocated, never printed" instead of as an unexplained missing number.

**Requirements.** Chromium only (Chrome/Edge) — Web Bluetooth exists in neither Safari nor
Firefox. A **secure context is mandatory**: HTTPS or `localhost`, so `http://<lan-ip>:8090`
cannot print. That is the same constraint Web NFC already puts on the POS (step 2 of
**Setting it up on the tablet**), and both are satisfied by the same thing: in development
the ngrok host that `vite.config.ts` allow-lists, or the per-device Chrome insecure-origin
flag, which makes the whole origin a secure context; in production, real HTTPS. The device
must be an **X5 or X5h** — the library matches those two names only and rejects an
uppercase `X5H`, which upstream maps to a different model. As with the card reader, the
POS feature-detects (`checkPrinterSupport`) and says why it cannot print rather than
offering a dead button.

**Pairing is one-time, in Поставки → Печатач.** `TiMiniPrinter.requestPrinter()` opens
Chrome's device chooser, and Chrome only shows that while a user gesture is still live —
which is exactly why pairing is a button in Settings and never something the payment flow
triggers. Two consequences:

- **A reload drops the pairing.** Web Bluetooth cannot silently restore a connection
  without a fresh gesture, so the operator re-pairs after every refresh or kiosk reboot.
- **A dropped link does not.** Switching the printer off or walking out of range keeps the
  paired printer: `device.gatt.connect()` on a device the chooser already granted needs no
  gesture, so the store goes to **reconnecting** and tries by itself — after 1 s, 2 s, 4 s,
  then every 10 s for two minutes — and then to **offline**, where „Поврзи повторно" (in
  Поставки, on the cart screen and on the done screen) tries again without the chooser.
- **Moving between views does not.** The connection is a module-level singleton in
  `web/src/printer.ts`, not React state, so it survives `Pos.tsx` unmounting; Settings and
  the POS read the same store through `useSyncExternalStore`.

**The transfer settings are hardcoded on purpose**: `chunkSize: 182`, `delayMs: 50`,
`blackening: 5` (depth 1–5, 5 darkest — bar thermal paper fades fast) and `feed: 3` steps
after each job. Those are the values measured against the real X5h — the library's
`docs/hardware-verification.md` — and they are deliberately not configurable. The browser
cannot ask Chrome for the negotiated ATT MTU, so 182 is a *measured* payload capacity, not
a negotiated one, and a larger chunk silently corrupts a job instead of failing. What is
**not** verified upstream: how far one `feed` step advances the paper (the bytes are
identical to the Python reference at 1/2/3/8 steps, but it has never been measured on
paper), paper output for an arbitrary PNG as opposed to the reference fixture, and the
plain X5 — only the X5h has printed.

**A finished transfer is not a finished print.** `printRasterImage()` resolves when the
last byte is written; the printer sends back no completion acknowledgement, so all the app
knows is that the bytes left the tablet. Every string the operator sees therefore says
**"испратено"** (sent) and never "испечатено" (printed). That wording is deliberate — it
is not a translation slip to be tidied up later.

**A failed or interrupted receipt reconnects, but is never re-sent by itself.** A failed
write may already have been delivered, so the library refuses every further job on that
link until a disconnect and a fresh `connect()` — which works on the same instance, so
`printPng` closes the link and hands it to the same reconnect loop instead of forgetting
the printer. What it **never** does is send the job again: if the printer dropped at 40%,
40% of a receipt is hanging out of it. The done screen says how far it got („Печатачот се
исклучи при испраќањето (40%)") and the operator tears that off and taps „Печати
повторно" once the printer is back. A print that finds the link on its way back waits up to
8 s for it rather than failing. With the share sheet gone there is nothing to fall back to,
so the cart screen still warns before the card is charged.

### Receipt history, reprints and the print log (`/receipts`)

**Сметки** lists one business day's receipts with where each one stands, and opens any of
them: the image, its lines, and every attempt to print it. Admin and staff only — the bar
tablet is refused by the same default-deny as everything else.

**The receipt is stored, not re-rendered.** `receipts.png` keeps the render exactly as the
API returned it, and `receipts.items` the lines it was sent. A reprint is that image again —
byte for byte, including whatever date and time the render service stamped on it — and
works while the render service is down. Asking `/api/pos/receipt` again for a sale that
already has its document returns the stored one without calling the render API. Receipts
from before this was stored (migration 014) render once, from their sale and under their
existing number, the first time they are opened, and are kept from then on.

**The lines come from the sale, not the browser.** `/api/pos/receipt` reads name, quantity
and price from `order_items` and the VAT band from `menu_items`; any `items` in the request
are ignored. A sale with a line that is on no menu — a custom „Наплата" charge — is refused
with 409 rather than printed with a guessed VAT band.

**A reprint is marked КОПИЈА.** The server decides: once any attempt at a receipt has
reached `sent`, every further print is a copy, the tablet draws a solid КОПИЈА band above
and below the stored image (`web/src/receiptPrint.ts`), and `receipt.reprint` is written to
the audit log with who asked. A retry after an interrupted or failed attempt is still the
original — no whole original ever came out.

**`rendered_at` is not "printed".** It means the render API answered, which happens before a
byte goes over Bluetooth. Whether a receipt reached the printer is `receipt_prints`: the
tablet opens an attempt before sending (`sending`) and closes it as `sent`, `interrupted`
(with the percent reached) or `failed` (with the operator-facing reason). An attempt left
at `sending` is a tablet that died mid-print and shows as „без потврда". A receipt with no
`sent` attempt is **неиспратена**, and the POS cart screen links to today's list of them,
so walking away from a done screen does not lose a receipt.

### `web-timini-print` is installed from a local path

```json
"web-timini-print": "git+file:///Users/ivanilijevski/Web-TiMini-Print"
```

That absolute path exists on exactly one laptop, and the package is not on npm, so
**`npm ci` (and a fresh `npm install`) fails on any other machine — including the venue
box.** Two ways out, neither done yet:

- `npm pack` the library and commit the tarball as `vendor/web-timini-print-*.tgz`, then
  depend on `file:vendor/…`; or
- push it to a git remote and pin a commit SHA — it currently has neither a remote nor
  tags, so there is nothing to pin today.

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
  with 503 rather than silently skipping the print. The 384 px PNG it returns goes
  to the paired Bluetooth printer — see **Fiscal receipts print over Bluetooth**.
- `CMS_TIME_ZONE` — IANA zone the venue is in, default `Europe/Skopje`. Fixes where
  the fiscal day ends, and so when receipt numbers restart at 0001; the database
  stays UTC regardless. Deployment-wide rather than receipt-specific, because it is
  a property of where the venue is — `/reports` should eventually use it too. An
  unresolvable zone throws at startup, not at the first sale of the night.
- `CMS_RECEIPT_STORE_NAME` / `CMS_RECEIPT_ADDRESS` — the legal entity and address
  printed in the receipt header. The render API fills every field it isn't sent
  from its own demo preset, so an unset store name prints *its* sample company on
  our receipts; set both in production. The server adds them to the render request
  itself, so the browser cannot put a different company on a fiscal receipt — and for
  the same reason it derives the tender line rather than accepting one. There is
  deliberately **no** `CMS_RECEIPT_PAYMENT_METHOD`: what a receipt was paid with is a
  property of the sale, not of the deployment. The receipt number is derived the
  same way, from the sale and the local day.

## Not built yet (deliberately)

- SAS **meter reconciliation** (the ledger is shaped for it; the nightly compare
  and the SMIB meter-snapshot upload are a later phase).
- TLS/mTLS on the TCP leg, and DESFire challenge-response cards — card UID auth is
  cloneable, which is a known limitation carried over from the prototype.
- Redeeming a TITO ticket onto a player card.
