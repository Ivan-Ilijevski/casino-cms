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

    const result = await renderReceipt(DEFAULT_CONFIG, { items: [ITEM] })

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
    const result = await renderReceipt(config, { items: [ITEM], paymentMethod: 'ПОЕНИ' })

    expect(fetchMock).toHaveBeenCalledWith(
      'https://receipts.example/api/receipt/render',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'x-api-key': 'secret', 'content-type': 'application/json' })
      })
    )
    const [, init] = fetchMock.mock.calls[0]
    expect(JSON.parse(init.body)).toEqual({ items: [ITEM], paymentMethod: 'ПОЕНИ' })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.contentType).toBe('image/png')
      expect(Buffer.from(result.png)).toEqual(Buffer.from(png))
    }
  })

  test('passes through an upstream error instead of throwing', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: 'Body does not describe a receipt' })
    })
    vi.stubGlobal('fetch', fetchMock)

    const config = { ...DEFAULT_CONFIG, receiptApiUrl: 'https://receipts.example', receiptApiKey: 'secret' }
    const result = await renderReceipt(config, { items: [ITEM] })

    expect(result).toEqual({
      ok: false,
      status: 400,
      code: 'upstream_error',
      error: 'Body does not describe a receipt'
    })
  })
})
