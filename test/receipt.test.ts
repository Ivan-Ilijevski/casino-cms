import { afterEach, describe, expect, test, vi } from 'vitest'
import { DEFAULT_CONFIG } from '../src/config.js'
import { renderReceipt } from '../src/domain/receipt.js'

const ITEM = { name: 'Кафе', quantity: 2, price: 3.5, vatType: 'A' as const, isDomestic: true }

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('renderReceipt', () => {
  test('fails closed without calling out when the receipt API is not configured', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const result = await renderReceipt(DEFAULT_CONFIG, { items: [ITEM], payMethod: 'cash', receiptNumber: '0001' })

    expect(result).toEqual({ ok: false, status: 503, code: 'not_configured' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('posts the receipt payload with the api key header and returns the PNG', async () => {
    const png = new Uint8Array([1, 2, 3])
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'image/png' }),
      arrayBuffer: async () => png.buffer
    })
    vi.stubGlobal('fetch', fetchMock)

    const config = { ...DEFAULT_CONFIG, receiptApiUrl: 'https://receipts.example', receiptApiKey: 'secret' }
    const result = await renderReceipt(config, { items: [ITEM], payMethod: 'points', receiptNumber: '0001' })

    expect(fetchMock).toHaveBeenCalledWith(
      'https://receipts.example/api/receipt/render',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'x-api-key': 'secret', 'content-type': 'application/json' })
      })
    )
    const [, init] = fetchMock.mock.calls[0]
    expect(JSON.parse(init.body)).toEqual({
      items: [ITEM],
      paymentMethod: 'ПОЕНИ',
      receiptNumber: '0001',
      storeName: DEFAULT_CONFIG.receiptStoreName,
      address: DEFAULT_CONFIG.receiptAddress
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.contentType).toBe('image/png')
      expect(Buffer.from(result.png)).toEqual(Buffer.from(png))
    }
  })

  test('prints a денари purchase as a card payment, never as cash', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'image/png' }),
      arrayBuffer: async () => new Uint8Array([1]).buffer
    })
    vi.stubGlobal('fetch', fetchMock)

    const config = { ...DEFAULT_CONFIG, receiptApiUrl: 'https://receipts.example', receiptApiKey: 'secret' }
    await renderReceipt(config, { items: [ITEM], payMethod: 'cash', receiptNumber: '0001' })

    const [, init] = fetchMock.mock.calls[0]
    const sent = JSON.parse(init.body)
    // Asserted by name as well as by value: the field going *missing* is the whole bug.
    // The render API fills anything it is not sent from its own preset, and that preset
    // says ВО ГОТОВО — so an omitted tender line prints a cash sale the POS never took.
    expect(sent).toHaveProperty('paymentMethod')
    expect(sent.paymentMethod).toBe('НА КРЕДИТ')
  })

  test('prints a points purchase as ПОЕНИ', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'image/png' }),
      arrayBuffer: async () => new Uint8Array([1]).buffer
    })
    vi.stubGlobal('fetch', fetchMock)

    const config = { ...DEFAULT_CONFIG, receiptApiUrl: 'https://receipts.example', receiptApiKey: 'secret' }
    await renderReceipt(config, { items: [ITEM], payMethod: 'points', receiptNumber: '0001' })

    const [, init] = fetchMock.mock.calls[0]
    expect(JSON.parse(init.body).paymentMethod).toBe('ПОЕНИ')
  })

  test('sends the receipt number, so the header is not the API demo #0012', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'image/png' }),
      arrayBuffer: async () => new Uint8Array([1]).buffer
    })
    vi.stubGlobal('fetch', fetchMock)

    const config = { ...DEFAULT_CONFIG, receiptApiUrl: 'https://receipts.example', receiptApiKey: 'secret' }
    await renderReceipt(config, { items: [ITEM], payMethod: 'cash', receiptNumber: '0042' })

    const [, init] = fetchMock.mock.calls[0]
    const sent = JSON.parse(init.body)
    // By name as well as by value: an absent field is not an error, it is the render
    // API silently substituting '0012' from its own preset onto a fiscal document.
    expect(sent).toHaveProperty('receiptNumber')
    expect(sent.receiptNumber).toBe('0042')
  })

  test('sends the configured store name and address so the header is this casino, not the API demo default', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'image/png' }),
      arrayBuffer: async () => new Uint8Array([1]).buffer
    })
    vi.stubGlobal('fetch', fetchMock)

    const config = {
      ...DEFAULT_CONFIG,
      receiptApiUrl: 'https://receipts.example',
      receiptApiKey: 'secret',
      receiptStoreName: 'КАЗИНО ФЕНИКС ДООЕЛ',
      receiptAddress: 'БУЛ. ПАРТИЗАНСКИ ОДРЕДИ 12 СКОПЈЕ'
    }
    await renderReceipt(config, { items: [ITEM], payMethod: 'points', receiptNumber: '0007' })

    const [, init] = fetchMock.mock.calls[0]
    expect(JSON.parse(init.body)).toEqual({
      items: [ITEM],
      paymentMethod: 'ПОЕНИ',
      receiptNumber: '0007',
      storeName: 'КАЗИНО ФЕНИКС ДООЕЛ',
      address: 'БУЛ. ПАРТИЗАНСКИ ОДРЕДИ 12 СКОПЈЕ'
    })
  })

  test('omits an unset store name or address rather than blanking the receipt header', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'image/png' }),
      arrayBuffer: async () => new Uint8Array([1]).buffer
    })
    vi.stubGlobal('fetch', fetchMock)

    const config = {
      ...DEFAULT_CONFIG,
      receiptApiUrl: 'https://receipts.example',
      receiptApiKey: 'secret',
      receiptStoreName: 'КАЗИНО ФЕНИКС ДООЕЛ',
      receiptAddress: '   '
    }
    await renderReceipt(config, { items: [ITEM], payMethod: 'cash', receiptNumber: '0007' })

    const [, init] = fetchMock.mock.calls[0]
    expect(JSON.parse(init.body)).toEqual({
      items: [ITEM],
      paymentMethod: 'НА КРЕДИТ',
      receiptNumber: '0007',
      storeName: 'КАЗИНО ФЕНИКС ДООЕЛ'
    })
  })

  test('passes through an upstream error instead of throwing', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: 'Body does not describe a receipt' })
    })
    vi.stubGlobal('fetch', fetchMock)

    const config = { ...DEFAULT_CONFIG, receiptApiUrl: 'https://receipts.example', receiptApiKey: 'secret' }
    const result = await renderReceipt(config, { items: [ITEM], payMethod: 'cash', receiptNumber: '0001' })

    expect(result).toEqual({
      ok: false,
      status: 400,
      code: 'upstream_error',
      error: 'Body does not describe a receipt'
    })
  })
})
