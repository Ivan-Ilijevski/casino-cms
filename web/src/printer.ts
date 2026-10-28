/**
 * Bluetooth receipt printing — the single owner of the X5/X5h connection.
 *
 * The POS already renders a fiscal receipt server-side as a 384px-wide PNG. This
 * module takes that blob to an X5/X5h BLE thermal printer over Web Bluetooth,
 * replacing the Android share sheet as the primary path.
 *
 * Constraints that shape this file:
 *  - `TiMiniPrinter.requestPrinter()` opens Chrome's device chooser, which needs a
 *    live user gesture. It must be the *first* await inside a click handler, and the
 *    constructor is private, so there is no other way to obtain an instance. That is
 *    why pairing is an explicit button in Settings and never happens inside a sale.
 *  - `Pos.tsx` unmounts whenever the operator navigates away, so the connection
 *    cannot live in React state — one pairing has to survive a whole shift across
 *    every route change. Hence the module-level singleton plus the tiny
 *    subscribe/notify store below, which both Settings and Pos read through
 *    `useSyncExternalStore`.
 *  - A resolved `printRasterImage()` means the *transfer* finished, not that paper
 *    came out. Every string here says "испратено"/"пратено", never "испечатено".
 *  - After a failed transfer the library refuses new jobs until `disconnect()` and a
 *    fresh `connect()`, because a failed GATT write may already have been delivered.
 *    That does NOT need a re-pair: `connect()` works again on the same instance, and
 *    `device.gatt.connect()` on a device the chooser already granted needs no user
 *    gesture — only `requestPrinter()` does. So a dropped link or a failed job keeps
 *    the instance and reconnects to it in the background. What never happens on its
 *    own is re-sending a job: part of the receipt may already be on paper, so a
 *    reprint is always the operator's tap. A page reload still loses the instance.
 *  - `connect()` throws `PrinterBusyError` when it is already connected, so every
 *    path guards on `.connected` first.
 *  - Only lowercase `X5` / `X5h` names are accepted by the library; a device
 *    advertising `X5H` is rejected with `PrinterNotSupportedError`.
 *  - Web Bluetooth needs a secure context, exactly like Web NFC — see webnfc.ts and
 *    the README's note on the Chrome insecure-origin flag used in dev.
 *
 * The error classes live only on the `web-timini-print/core` entry; the browser
 * entry exports the printer, the availability probe and the image helpers.
 */

import { TiMiniPrinter, bluetoothAvailability, preparePngImage } from 'web-timini-print'
import {
  BluetoothConnectionError,
  BluetoothUnavailableError,
  PrinterBusyError,
  PrinterDisconnectedError,
  PrinterError,
  PrinterNotSupportedError,
  PrinterProtocolError,
  PrinterTimeoutError,
  PrinterWriteError
} from 'web-timini-print/core'

/**
 * Measured on the tested X5h over macOS Chrome — see the library's
 * docs/hardware-verification.md. The browser cannot query the ATT MTU, so 182 is a
 * measured payload capacity rather than a negotiated one; raising it without
 * re-measuring on this hardware silently truncates a receipt.
 */
const PRINTER_OPTIONS = { chunkSize: 182, delayMs: 50 } as const

/**
 * The printer's native raster width in dots — the full head of an X5/X5h at 203dpi.
 *
 * `preparePngImage()` rescales anything that is not exactly this wide before it
 * Atkinson-dithers it, and a rescaled bitmap turns crisp glyphs into grey mush. So
 * anything drawn in the browser for this printer is authored at this width, in pure
 * black on white: no greys, no hairlines, and type big enough that the dither cannot
 * eat it.
 */
export const RASTER_WIDTH = 384

/** Print depth 1–5, 5 being darkest. Thermal paper at the bar fades fast. */
const BLACKENING = 5

/** Advances the paper clear of the print head so the receipt can be torn off. */
const FEED_STEPS = 2

// ------------------------------------------------------------------ capability

export type PrinterSupport = { supported: true } | { supported: false; reason: string }

/**
 * English reasons `bluetoothAvailability()` can return, mapped to operator
 * Macedonian. Kept as exact-match keys rather than substring tests: a changed
 * upstream string should fall through to the raw text, not to a wrong translation.
 */
const AVAILABILITY_MK: Record<string, string> = {
  'Web Bluetooth is unavailable. Open this demo in a supported Chromium browser.':
    'Овој прелистувач не поддржува Bluetooth печатење. Отворете ја апликацијата во Chrome.',
  'Web Bluetooth requires HTTPS or localhost.':
    'Bluetooth печатењето бара безбедна врска (HTTPS или localhost).'
}

/**
 * Whether this browser could talk to the printer at all.
 *
 * `bluetoothAvailability()` inverts the usual sense: a returned string is the
 * *reason it is unavailable*, and `undefined` means everything is in place. It
 * reads `navigator` and `isSecureContext`, so call it from an effect or a handler
 * — never during render.
 */
export function checkPrinterSupport(): PrinterSupport {
  const reason = bluetoothAvailability()
  if (!reason) return { supported: true }
  // An unmapped reason is still better shown in English than swallowed.
  return { supported: false, reason: AVAILABILITY_MK[reason] ?? reason }
}

// ---------------------------------------------------------------------- errors

/**
 * What went wrong with a job, as the POS needs to branch on it:
 *  - `not-connected` — nothing was sent; there is no printer, or it did not come back.
 *  - `busy` — nothing was sent; another receipt is still going out.
 *  - `link-lost` — the printer dropped mid-transfer. Part of the receipt may be on paper.
 *  - `transfer-failed` — the job failed some other way. Delivery is just as uncertain.
 */
export type PrinterJobKind = 'not-connected' | 'busy' | 'link-lost' | 'transfer-failed'

/**
 * Raised by this module rather than by the library, so `Pos.tsx` can tell "nothing
 * is paired" apart from "the job failed" without matching on message text.
 */
export class PrinterJobError extends Error {
  /** How far the transfer got before it stopped, 0–100. 0 when nothing was sent. */
  readonly percent: number

  constructor(
    message: string,
    readonly kind: PrinterJobKind,
    options?: ErrorOptions & { percent?: number }
  ) {
    super(message, options)
    this.name = 'PrinterJobError'
    this.percent = options?.percent ?? 0
  }
}

/**
 * Dismissing Chrome's chooser rejects `requestDevice()` with a `DOMException` named
 * `NotFoundError` — but the library catches that and rethrows a
 * `BluetoothConnectionError` carrying the original as `cause`. Both shapes are
 * checked, because a cancel is not a failure and must not raise an alarm.
 */
function isChooserDismissed(err: unknown): boolean {
  const named = (e: unknown) => (e as { name?: string } | null)?.name === 'NotFoundError'
  if (named(err)) return true
  return err instanceof BluetoothConnectionError && named(err.cause)
}

/** A sentence the operator behind the bar can act on, for any thrown value. */
export function describePrinterError(err: unknown): string {
  if (isChooserDismissed(err)) return 'Изборот на печатач е откажан.'
  // Our own errors already carry Macedonian copy aimed at this operator.
  if (err instanceof PrinterJobError) return err.message

  // Subclasses first — every one of these extends PrinterError.
  if (err instanceof PrinterNotSupportedError) {
    return 'Избраниот уред не е X5 печатач. Изберете уред со име X5 или X5h.'
  }
  if (err instanceof PrinterDisconnectedError) {
    return 'Врската со печатачот се прекина. Вклучете го печатачот — таблетот сам ќе се поврзе повторно.'
  }
  if (err instanceof BluetoothUnavailableError) {
    return 'Bluetooth не е достапен. Проверете дали е вклучен и дали страницата е отворена преку HTTPS.'
  }
  if (err instanceof BluetoothConnectionError) {
    return 'Не успеа поврзувањето со печатачот. Проверете дали е вклучен и близу до таблетот.'
  }
  if (err instanceof PrinterTimeoutError) {
    return 'Печатачот не одговара. Проверете дали има хартија и дали не е преоптоварен.'
  }
  if (err instanceof PrinterProtocolError) {
    return 'Печатачот ја одби сметката. Почекајте да се поврзе повторно и обидете се одново.'
  }
  if (err instanceof PrinterBusyError) {
    return 'Печатачот веќе извршува задача. Почекајте да заврши.'
  }
  if (err instanceof PrinterWriteError) {
    return 'Испраќањето кон печатачот прекина. Не е сигурно дали дел од сметката веќе излегол.'
  }
  // The base class last, or it would swallow every branch above it.
  if (err instanceof PrinterError) return 'Грешка на печатачот.'
  return 'Настана непозната грешка при печатењето.'
}

// ----------------------------------------------------------------------- store

/**
 * `reconnecting` and `offline` both still hold the paired printer — its name stays in
 * `deviceName` — but have no live link. `reconnecting` is working on it by itself;
 * `offline` has given up and waits for „Поврзи повторно“, which needs no chooser.
 */
export type PrinterStatus =
  | 'idle'
  | 'connecting'
  | 'ready'
  | 'printing'
  | 'reconnecting'
  | 'offline'
  | 'error'

export interface PrinterState {
  status: PrinterStatus
  deviceName: string | null
  /**
   * 0–100 while status === 'printing', and left at 100 after a completed transfer
   * so a progress bar does not snap back to empty at the moment it finishes.
   */
  percent: number
  /** Macedonian message for the operator; null when there is nothing to say. */
  message: string | null
}

const IDLE_STATE: PrinterState = { status: 'idle', deviceName: null, percent: 0, message: null }

let state: PrinterState = IDLE_STATE
const listeners = new Set<() => void>()

/**
 * `useSyncExternalStore` compares snapshots by identity and re-renders — then reads
 * again — until two consecutive reads match. Returning a fresh object here would
 * never converge and React would throw "getSnapshot should be cached". So this
 * hands back the *same* object until `setState` deliberately replaces it.
 */
export function printerState(): PrinterState {
  return state
}

export function subscribePrinter(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

/** Replaces the snapshot with a new object and notifies. The only writer. */
function setState(patch: Partial<PrinterState>): void {
  state = { ...state, ...patch }
  for (const cb of [...listeners]) cb()
}

// --------------------------------------------------------------- the singleton

let printer: TiMiniPrinter | null = null
/** The `onDisconnected` unsubscribe, so a deliberate teardown stays quiet. */
let offDisconnected: (() => void) | null = null
/**
 * Bumped whenever the paired printer is replaced or forgotten. A reconnect loop
 * started for one pairing checks it after every await, so it can never bring back a
 * printer the operator has since disconnected or swapped for another.
 */
let pairing = 0
/** True from the moment a job starts until its outcome is settled. */
let jobRunning = false

/**
 * Drops the current instance. The listener is removed *before* `disconnect()` so a
 * deliberate teardown does not also fire the "printer disconnected" message, and
 * the reference is cleared synchronously so a caller can start a fresh pairing
 * without awaiting this — the chooser must be the first await in its handler.
 */
async function discardPrinter(): Promise<void> {
  const current = printer
  pairing++
  reconnecting = null
  offDisconnected?.()
  offDisconnected = null
  printer = null
  if (!current) return
  try {
    await current.disconnect()
  } catch {
    // Best effort: the link may already be gone, which is the outcome we wanted.
  }
}

/**
 * Fires when the printer is switched off, walks out of range, or drops the link
 * mid-shift — and also when a reconnect attempt fails partway through its setup.
 *
 * The chooser already granted this device, so nothing needs a gesture to reach it
 * again: the store goes to `reconnecting` and tries by itself. A drop during a job is
 * left to `printPng`, which has to report the interrupted receipt first.
 */
function onLinkLost(): void {
  if (!printer || jobRunning) return
  void startReconnect()
}

// ---------------------------------------------------------------- reconnecting

/** Quick at first — a printer that blinked comes straight back — then steady. */
const RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000]
const RECONNECT_STEADY_MS = 10_000
/** Long enough to walk over and switch the printer back on; then stop draining the tablet. */
const RECONNECT_GIVE_UP_MS = 120_000
/** How long a print waits for a link that is on its way back before giving up. */
const PRINT_WAIT_FOR_LINK_MS = 8_000

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** The loop in flight, shared by everyone waiting on it. Resolves whether the link came back. */
let reconnecting: Promise<boolean> | null = null

const RECONNECTING_MESSAGE = 'Врската со печатачот се прекина. Се поврзува повторно…'

/**
 * Brings the paired printer back without the chooser.
 *
 * One loop at a time: a second caller gets the promise already running. `immediate`
 * skips the first delay, for a caller that is standing at the printer — a tap on
 * „Поврзи повторно“, or a print that found the link down.
 *
 * `connect()` is the library's full setup on the same instance, which also clears the
 * "previous transfer failed" latch — exactly what it demands before the next job.
 */
function startReconnect(opts: { immediate?: boolean; message?: string } = {}): Promise<boolean> {
  if (opts.message && state.status === 'reconnecting') setState({ message: opts.message })
  if (reconnecting) return reconnecting

  const target = printer
  if (!target) return Promise.resolve(false)
  const mine = pairing
  const stillOurs = () => mine === pairing && printer === target

  setState({ status: 'reconnecting', percent: 0, message: opts.message ?? RECONNECTING_MESSAGE })

  const loop = (async (): Promise<boolean> => {
    const started = Date.now()
    for (let attempt = 0; ; attempt++) {
      if (attempt > 0 || !opts.immediate) {
        await sleep(RECONNECT_DELAYS_MS[attempt] ?? RECONNECT_STEADY_MS)
      }
      if (!stillOurs()) return false

      if (!target.connected) {
        try {
          await target.connect()
        } catch {
          // Still off or out of range. The next lap tries again.
        }
      }
      if (!stillOurs()) return false

      if (target.connected) {
        setState({ status: 'ready', percent: 0, message: 'Печатачот е повторно поврзан.' })
        return true
      }
      if (Date.now() - started >= RECONNECT_GIVE_UP_MS) {
        setState({
          status: 'offline',
          percent: 0,
          message: 'Печатачот не се јавува. Вклучете го и притиснете „Поврзи повторно“.'
        })
        return false
      }
    }
  })()

  reconnecting = loop
  void loop.finally(() => {
    if (reconnecting === loop) reconnecting = null
  })
  return loop
}

/**
 * Reconnects to the printer paired earlier in this page's life, with no chooser —
 * which is why a plain tap can call it with awaits before it. Resolves whether the
 * link is back. With nothing paired there is nothing to reconnect to: that takes
 * `pairPrinter()`.
 */
export function reconnectPrinter(): Promise<boolean> {
  if (!printer) return Promise.resolve(false)
  if (printer.connected) return Promise.resolve(true)
  return startReconnect({ immediate: true })
}

/** Resolves true once the link is up, or false after `ms` — leaving any loop running. */
async function waitForLink(ms: number): Promise<boolean> {
  if (printer?.connected) return true
  const back = reconnectPrinter()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms)
  })
  try {
    return await Promise.race([back, timeout])
  } finally {
    clearTimeout(timer)
  }
}

// --------------------------------------------------------------------- pairing

/**
 * Opens Chrome's chooser and connects to the selected X5/X5h.
 *
 * **Call this directly from a click handler.** `requestPrinter()` is the first await
 * on purpose: Chrome only shows the chooser while the user gesture is still live,
 * and any awaited work before it consumes that activation.
 *
 * This deliberately **does not reject**. Pairing is a UI affordance whose only
 * consumer is the Settings panel, which already renders `status` and `message` from
 * the store — rethrowing would force every caller into a try/catch that could only
 * duplicate what the store already says, and an unguarded call would surface as an
 * unhandled rejection. Failures land as `status: 'error'` with a Macedonian
 * `message`; a dismissed chooser lands silently back on `'idle'`.
 * (`printPng` is the opposite and *does* rethrow — see its note.)
 */
export async function pairPrinter(): Promise<void> {
  if (printer?.connected) return
  // A stale instance — one still reconnecting, or given up on — has to go, but its
  // disconnect() cannot be awaited here without spending the gesture, so it is dropped
  // synchronously and closed in the background. discardPrinter() clears `printer` and
  // cancels its reconnect loop before its own first await.
  if (printer) void discardPrinter()

  setState({
    status: 'connecting',
    percent: 0,
    message: 'Изберете печатач од списокот на уреди.'
  })

  let opened: TiMiniPrinter | null = null
  try {
    opened = await TiMiniPrinter.requestPrinter(PRINTER_OPTIONS)
    await opened.connect()
    printer = opened
    // Once per instance: the library keeps this callback across every reconnect of
    // the same printer, so subscribing again on reconnect would fire twice.
    offDisconnected = opened.onDisconnected(onLinkLost)
    setState({
      status: 'ready',
      deviceName: opened.device.name ?? null,
      percent: 0,
      message: null
    })
  } catch (err) {
    // connect() already disconnects internally before it throws, but the instance
    // may still hold a chooser grant, so it is closed rather than left dangling.
    if (opened) {
      try {
        await opened.disconnect()
      } catch {
        // Nothing to salvage; the pairing failed either way.
      }
    }
    printer = null
    offDisconnected = null
    if (isChooserDismissed(err)) {
      // Not a failure: the operator changed their mind at the chooser.
      setState({ status: 'idle', deviceName: null, percent: 0, message: null })
      return
    }
    setState({
      status: 'error',
      deviceName: null,
      percent: 0,
      message: describePrinterError(err)
    })
  }
}

/** Forgets the printer entirely. Getting it back takes the chooser again. */
export async function disconnectPrinter(): Promise<void> {
  await discardPrinter()
  setState({ status: 'idle', deviceName: null, percent: 0, message: null })
}

export function isPrinterReady(): boolean {
  return state.status === 'ready' && printer?.connected === true
}

// -------------------------------------------------------------------- printing

/**
 * Sends a receipt PNG to the paired printer.
 *
 * Unlike `pairPrinter`, this **rejects** on failure: it runs inside the sale flow,
 * where `Pos.tsx` has to stop treating the receipt as handled and offer its manual
 * retry instead. There is no share-sheet fallback any more, so a rejection here is
 * the only signal that the receipt is not on paper. Callers branch on
 * `PrinterJobError.kind` and read `.percent` for how far a broken transfer got, or
 * pass the thrown value to `describePrinterError`.
 *
 * A printer that is paired but momentarily off the link is waited for, briefly: a
 * sale that lands while the printer is coming back should still print.
 *
 * A resolved promise means the last byte reached the printer, not that the paper
 * has finished moving — do not tear down the done screen on this alone.
 */
export async function printPng(blob: Blob): Promise<void> {
  if (jobRunning) {
    throw new PrinterJobError(describePrinterError(new PrinterBusyError('busy')), 'busy')
  }
  if (!printer) {
    throw new PrinterJobError('Нема спарен печатач. Спарете печатач во Поставки.', 'not-connected')
  }
  jobRunning = true
  let lastPercent = 0

  try {
    if (!printer.connected && !(await waitForLink(PRINT_WAIT_FOR_LINK_MS))) {
      throw new PrinterJobError(
        'Печатачот не е поврзан. Вклучете го — сметката чека и може да се прати штом се поврзе.',
        'not-connected'
      )
    }
    const current = printer
    if (!current?.connected) {
      throw new PrinterJobError('Нема спарен печатач. Спарете печатач во Поставки.', 'not-connected')
    }

    setState({ status: 'printing', percent: 0, message: 'Сметката се испраќа кон печатачот...' })

    // Chunks arrive in the hundreds; only a changed whole percent is worth a render.
    const progress = (sent: number, total: number) => {
      const pct = total > 0 ? Math.min(100, Math.round((sent / total) * 100)) : 0
      if (pct === lastPercent) return
      lastPercent = pct
      setState({ percent: pct })
    }

    try {
      // Decodes the PNG and dithers it to the printer's 384px raster; the returned
      // preview canvas is the exact monochrome image the printer receives.
      const { raster } = await preparePngImage(blob)
      await current.printRasterImage(raster, { blackening: BLACKENING, progress })
      await current.feed(FEED_STEPS)
      setState({
        status: 'ready',
        percent: 100,
        message: 'Сметката е испратена до печатачот.'
      })
    } catch (err) {
      // Read before disconnect(), which would make every failure look like a lost link.
      const linkLost = err instanceof PrinterDisconnectedError || !current.connected
      // The library refuses every further job on this link until a fresh connect(),
      // because a failed transfer may have been half delivered. Close it — keeping the
      // instance — and let the reconnect loop open a clean one. Never re-send the job:
      // part of this receipt may already be hanging out of the printer.
      try {
        await current.disconnect()
      } catch {
        // Already gone, which is where we were heading.
      }
      const message = describePrinterError(err)
      if (printer === current) {
        void startReconnect({ message: `${message} Се поврзува повторно…` })
      }
      // The library's error is kept as `cause` so a debug log can still name it.
      throw new PrinterJobError(message, linkLost ? 'link-lost' : 'transfer-failed', {
        cause: err,
        percent: lastPercent
      })
    }
  } finally {
    jobRunning = false
  }
}
