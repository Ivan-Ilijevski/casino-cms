import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { PrinterDisconnectedError, PrinterTimeoutError } from 'web-timini-print/core'

/**
 * A stand-in X5 with the parts printer.ts actually touches: connect/disconnect on one
 * instance, disconnect callbacks that survive reconnects (as the library's transport
 * keeps them), and a transfer that can be cut off part way.
 *
 * printer.test.ts runs against the real library in a runtime with no Web Bluetooth;
 * everything here needs a printer that pairs, so it lives in its own file.
 */
const fake = vi.hoisted(() => {
  class FakePrinter {
    device = { name: 'X5h' }
    connected = false
    /** False while the printer is switched off or out of range. */
    reachable = true
    connectCalls = 0
    jobs = 0
    /** Cut the link once the transfer passes this percent. */
    dropAfterPercent: number | null = null
    /** Fail the transfer this way without touching the link. */
    failWith: (() => Error) | null = null
    /** Per chunk, so a job can be caught still going out. */
    chunkDelayMs = 0
    private listeners = new Set<() => void>()

    async connect() {
      this.connectCalls++
      if (!this.reachable) throw new Error('GATT connect failed')
      this.connected = true
    }
    async disconnect() {
      const was = this.connected
      this.connected = false
      if (was) this.fire()
    }
    onDisconnected(cb: () => void) {
      this.listeners.add(cb)
      return () => this.listeners.delete(cb)
    }
    /** The printer switched off: the link drops and stays unreachable. */
    switchOff() {
      this.reachable = false
      this.connected = false
      this.fire()
    }
    async printRasterImage(_raster: unknown, opts: { progress?: (sent: number, total: number) => void }) {
      this.jobs++
      for (let chunk = 1; chunk <= 10; chunk++) {
        if (this.chunkDelayMs) await new Promise((r) => setTimeout(r, this.chunkDelayMs))
        if (this.dropAfterPercent !== null && chunk * 10 > this.dropAfterPercent) {
          this.switchOff()
          throw state.disconnectedError()
        }
        if (this.failWith && chunk === 5) throw this.failWith()
        opts.progress?.(chunk, 10)
      }
    }
    async feed() {}
    private fire() {
      for (const cb of [...this.listeners]) cb()
    }
  }

  const state = {
    current: null as FakePrinter | null,
    requests: 0,
    disconnectedError: (): Error => new Error('set in beforeEach')
  }
  return { FakePrinter, state }
})

vi.mock('web-timini-print', () => ({
  TiMiniPrinter: {
    requestPrinter: async () => {
      fake.state.requests++
      fake.state.current = new fake.FakePrinter()
      return fake.state.current
    }
  },
  bluetoothAvailability: () => undefined,
  preparePngImage: async () => ({ raster: {} })
}))

const {
  disconnectPrinter,
  pairPrinter,
  PrinterJobError,
  printerState,
  printPng,
  reconnectPrinter
} = await import('../web/src/printer')

const receipt = () => new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' })

async function paired() {
  await pairPrinter()
  expect(printerState().status).toBe('ready')
  return fake.state.current!
}

beforeEach(async () => {
  await disconnectPrinter()
  fake.state.current = null
  fake.state.requests = 0
  fake.state.disconnectedError = () => new PrinterDisconnectedError('The BLE connection closed.')
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('a printer that drops off the link', () => {
  test('comes back by itself, with no chooser', async () => {
    const printer = await paired()

    printer.switchOff()
    expect(printerState()).toMatchObject({ status: 'reconnecting', deviceName: 'X5h' })

    printer.reachable = true
    await vi.advanceTimersByTimeAsync(1_000)

    expect(printerState().status).toBe('ready')
    expect(printerState().message).toMatch(/повторно поврзан/)
    expect(fake.state.requests).toBe(1)
  })

  test('keeps trying while it is off, then gives up and waits for a tap', async () => {
    const printer = await paired()
    printer.switchOff()

    await vi.advanceTimersByTimeAsync(60_000)
    expect(printerState().status).toBe('reconnecting')
    const triedSoFar = printer.connectCalls
    expect(triedSoFar).toBeGreaterThan(3)

    await vi.advanceTimersByTimeAsync(70_000)
    expect(printerState().status).toBe('offline')

    // Given up means given up: no more attempts in the background.
    const atGiveUp = printer.connectCalls
    await vi.advanceTimersByTimeAsync(60_000)
    expect(printer.connectCalls).toBe(atGiveUp)
  })

  test('„Поврзи повторно“ brings an offline printer back without the chooser', async () => {
    const printer = await paired()
    printer.switchOff()
    await vi.advanceTimersByTimeAsync(130_000)
    expect(printerState().status).toBe('offline')

    printer.reachable = true
    await expect(reconnectPrinter()).resolves.toBe(true)

    expect(printerState().status).toBe('ready')
    expect(fake.state.requests).toBe(1)
  })

  test('forgetting the printer stops the loop from bringing it back', async () => {
    const printer = await paired()
    printer.switchOff()

    await disconnectPrinter()
    const calls = printer.connectCalls
    printer.reachable = true
    await vi.advanceTimersByTimeAsync(30_000)

    expect(printer.connectCalls).toBe(calls)
    expect(printerState()).toMatchObject({ status: 'idle', deviceName: null })
  })

  test('with nothing ever paired there is nothing to reconnect to', async () => {
    await expect(reconnectPrinter()).resolves.toBe(false)
    expect(printerState().status).toBe('idle')
  })
})

describe('a receipt interrupted by the printer', () => {
  test('rejects as link-lost, says how far it got, and is never re-sent', async () => {
    const printer = await paired()
    printer.dropAfterPercent = 40

    const err = await printPng(receipt()).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(PrinterJobError)
    expect((err as InstanceType<typeof PrinterJobError>).kind).toBe('link-lost')
    expect((err as InstanceType<typeof PrinterJobError>).percent).toBe(40)
    expect(printerState().status).toBe('reconnecting')

    printer.dropAfterPercent = null
    printer.reachable = true
    await vi.advanceTimersByTimeAsync(30_000)

    expect(printerState().status).toBe('ready')
    // Half a receipt may be hanging out of the printer: a reprint is the operator's call.
    expect(printer.jobs).toBe(1)
  })

  test('the tap to print it again goes through on the reconnected link', async () => {
    const printer = await paired()
    printer.dropAfterPercent = 60
    await printPng(receipt()).catch(() => {})

    printer.dropAfterPercent = null
    printer.reachable = true
    await vi.advanceTimersByTimeAsync(1_000)
    await printPng(receipt())

    expect(printer.jobs).toBe(2)
    expect(printerState()).toMatchObject({ status: 'ready', percent: 100 })
  })

  test('a failure that leaves the link up still reopens it before the next job', async () => {
    const printer = await paired()
    // The library refuses every job after a failed one until a fresh connect().
    printer.failWith = () => new PrinterTimeoutError('Timed out waiting for the X5 buffer to resume.')

    const err = await printPng(receipt()).catch((e: unknown) => e)

    expect((err as InstanceType<typeof PrinterJobError>).kind).toBe('transfer-failed')
    expect((err as InstanceType<typeof PrinterJobError>).percent).toBe(40)
    const before = printer.connectCalls
    await vi.advanceTimersByTimeAsync(1_000)
    expect(printer.connectCalls).toBe(before + 1)
    expect(printerState().status).toBe('ready')
  })
})

describe('printing while the link is on its way back', () => {
  test('waits for it rather than failing the receipt', async () => {
    const printer = await paired()
    printer.switchOff()

    const job = printPng(receipt())
    printer.reachable = true
    await vi.advanceTimersByTimeAsync(1_000)
    await job

    expect(printer.jobs).toBe(1)
    expect(printerState()).toMatchObject({ status: 'ready', percent: 100 })
  })

  test('gives up after a few seconds as not-connected, having sent nothing', async () => {
    const printer = await paired()
    printer.switchOff()

    const job = printPng(receipt()).catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(8_000)
    const err = await job

    expect((err as InstanceType<typeof PrinterJobError>).kind).toBe('not-connected')
    expect(printer.jobs).toBe(0)
    // The loop keeps going in the background; the receipt can be sent when it is back.
    expect(printerState().status).toBe('reconnecting')
  })

  test('a second receipt while one is going out is refused, and the first finishes', async () => {
    const printer = await paired()
    printer.chunkDelayMs = 100

    const first = printPng(receipt())
    const second = await printPng(receipt()).catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(2_000)
    await first

    expect((second as InstanceType<typeof PrinterJobError>).kind).toBe('busy')
    expect(printer.jobs).toBe(1)
    expect(printerState().status).toBe('ready')
  })
})
