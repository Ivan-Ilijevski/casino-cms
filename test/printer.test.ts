import { beforeEach, describe, expect, test } from 'vitest'
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
import {
  PrinterJobError,
  checkPrinterSupport,
  describePrinterError,
  disconnectPrinter,
  isPrinterReady,
  pairPrinter,
  printPng,
  printerState,
  subscribePrinter
} from '../web/src/printer'

// The connection is a module-level singleton by design, so every test starts by
// putting it back where a fresh page load would leave it.
beforeEach(async () => {
  await disconnectPrinter()
})

/** Cyrillic, so a forgotten English string from the library cannot pass. */
function isMacedonian(text: string): boolean {
  return /[а-шА-Ш]/.test(text)
}

/** Collects notifications so a test can count them rather than await them. */
function watch(): { count: () => number; stop: () => void } {
  let seen = 0
  const off = subscribePrinter(() => {
    seen += 1
  })
  return { count: () => seen, stop: off }
}

/** Every error the library documents, most specific first, base class last. */
const LIBRARY_ERRORS: Array<[string, Error]> = [
  ['a device that is not an X5', new PrinterNotSupportedError('not an X5')],
  ['the link dropping', new PrinterDisconnectedError('link lost')],
  ['no Web Bluetooth at all', new BluetoothUnavailableError('unavailable')],
  ['a connection that never came up', new BluetoothConnectionError('gatt failed')],
  ['a printer that stopped answering', new PrinterTimeoutError('timed out')],
  ['a job the printer refused', new PrinterProtocolError('bad job')],
  ['a printer already busy', new PrinterBusyError('busy')],
  ['a write that may or may not have landed', new PrinterWriteError('write failed')],
  ['anything else from the library', new PrinterError('generic')]
]

describe('telling the operator what went wrong', () => {
  for (const [label, err] of LIBRARY_ERRORS) {
    test(`${label} gets its own Macedonian sentence`, () => {
      const message = describePrinterError(err)
      expect(isMacedonian(message)).toBe(true)
      expect(message).not.toBe('')
    })
  }

  test('every library error maps to a different sentence', () => {
    const messages = LIBRARY_ERRORS.map(([, err]) => describePrinterError(err))
    expect(new Set(messages).size).toBe(LIBRARY_ERRORS.length)
  })

  test('the base class is tested last, so subclasses keep their own copy', () => {
    // PrinterError is the parent of all eight; if its branch ran first every one
    // of these would collapse onto the generic sentence.
    const generic = describePrinterError(new PrinterError('generic'))
    for (const [, err] of LIBRARY_ERRORS.slice(0, -1)) {
      expect(describePrinterError(err)).not.toBe(generic)
    }
  })

  test('something that is not an Error at all still gets a sentence', () => {
    const message = describePrinterError('kaboom')
    expect(isMacedonian(message)).toBe(true)
    expect(message).not.toBe(describePrinterError(new PrinterError('generic')))
  })

  test('a dismissed chooser reads as a cancel, not a failure', () => {
    const dismissed = new DOMException('User cancelled', 'NotFoundError')
    expect(describePrinterError(dismissed)).toMatch(/откажан/)
  })

  test('a dismissed chooser is still recognised through the library wrapper', () => {
    // requestX5Device catches the DOMException and rethrows a
    // BluetoothConnectionError carrying it as `cause`, so the raw name is never
    // what reaches us in practice.
    const wrapped = new BluetoothConnectionError('No printer selected.', {
      cause: new DOMException('User cancelled', 'NotFoundError')
    })
    expect(describePrinterError(wrapped)).toBe(
      describePrinterError(new DOMException('User cancelled', 'NotFoundError'))
    )
    expect(describePrinterError(wrapped)).not.toBe(
      describePrinterError(new BluetoothConnectionError('gatt failed'))
    )
  })

  test("our own job errors keep the copy they were raised with", () => {
    const err = new PrinterJobError('Нема спарен печатач.', 'not-connected')
    expect(describePrinterError(err)).toBe('Нема спарен печатач.')
  })
})

describe('the snapshot React subscribes to', () => {
  test('returns the same object across repeated reads', () => {
    // useSyncExternalStore re-reads until two reads match; a fresh object here
    // would spin forever.
    expect(printerState()).toBe(printerState())
    expect(printerState()).toBe(printerState())
  })

  test('starts idle with nothing paired', () => {
    expect(printerState()).toMatchObject({
      status: 'idle',
      deviceName: null,
      percent: 0
    })
  })

  test('notifies subscribers when the state changes', async () => {
    const w = watch()

    await disconnectPrinter()

    expect(w.count()).toBeGreaterThan(0)
    w.stop()
  })

  test('hands back a new object once something has changed', async () => {
    const before = printerState()

    await disconnectPrinter()

    expect(printerState()).not.toBe(before)
    // ...and is stable again from there.
    expect(printerState()).toBe(printerState())
  })

  test('unsubscribing stops further notifications', async () => {
    const w = watch()
    await disconnectPrinter()
    const seenWhileSubscribed = w.count()

    w.stop()
    await disconnectPrinter()

    expect(w.count()).toBe(seenWhileSubscribed)
  })

  test('a second subscriber does not displace the first', async () => {
    const a = watch()
    const b = watch()

    await disconnectPrinter()

    expect(a.count()).toBeGreaterThan(0)
    expect(b.count()).toBeGreaterThan(0)
    a.stop()
    b.stop()
  })
})

describe('a runtime with no Web Bluetooth', () => {
  test('reports itself unsupported, in Macedonian', () => {
    // Node has a `navigator`, but no `navigator.bluetooth` — the same answer the
    // library gives Safari or a plain http:// origin.
    const support = checkPrinterSupport()
    expect(support.supported).toBe(false)
    if (support.supported) return
    expect(isMacedonian(support.reason)).toBe(true)
  })

  test('pairing settles rather than rejecting, leaving the reason in the store', async () => {
    // pairPrinter deliberately does not rethrow: Settings reads status/message.
    await expect(pairPrinter()).resolves.toBeUndefined()

    const s = printerState()
    expect(s.status).toBe('error')
    expect(s.deviceName).toBeNull()
    expect(s.message).not.toBeNull()
    expect(isMacedonian(s.message ?? '')).toBe(true)
  })

  test('a failed pairing leaves nothing that claims to be ready', async () => {
    await pairPrinter()

    expect(isPrinterReady()).toBe(false)
  })
})

describe('printing with nothing paired', () => {
  test('rejects with a job error the POS can branch on', async () => {
    const blob = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' })

    await expect(printPng(blob)).rejects.toBeInstanceOf(PrinterJobError)
  })

  test('the rejection says "nothing paired", not "the job failed"', async () => {
    const blob = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' })

    const err = await printPng(blob).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(PrinterJobError)
    expect((err as PrinterJobError).kind).toBe('not-connected')
    expect(isMacedonian((err as PrinterJobError).message)).toBe(true)
  })

  test('the refused job does not move the store off idle', async () => {
    const blob = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' })

    await printPng(blob).catch(() => {})

    // Nothing was sent, so there is no half-printed receipt to report.
    expect(printerState().status).toBe('idle')
    expect(printerState().percent).toBe(0)
  })
})

describe('the copy the operator reads', () => {
  test('never claims a receipt was printed, only that it was sent', () => {
    // A resolved transfer means the last byte was written, not that paper came
    // out — see the file header. Any form of "испечатен" would be a promise the
    // BLE link cannot keep, so no operator-facing string is allowed to use one.
    const everySentence = [
      ...LIBRARY_ERRORS.map(([, err]) => describePrinterError(err)),
      describePrinterError(new DOMException('cancelled', 'NotFoundError')),
      describePrinterError('kaboom')
    ]
    for (const sentence of everySentence) expect(sentence).not.toMatch(/испечат/)
  })
})
