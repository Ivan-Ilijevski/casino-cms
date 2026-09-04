import type { Config } from '../config.js'

export interface ReceiptItem {
  name: string
  quantity: number
  price: number
  vatType: 'A' | 'B' | 'V' | 'G'
  isDomestic: boolean
}

export interface ReceiptRequest {
  items: ReceiptItem[]
  paymentMethod?: string
}

export type ReceiptResult =
  | { ok: true; png: Buffer; contentType: string }
  | { ok: false; status: number; code: 'not_configured' | 'upstream_error'; error?: string }

/**
 * Proxies a fiscal-receipt render to the external Receipt Render API, keeping
 * its x-api-key server-side — the API's own docs say to keep that key and the
 * endpoint off the open internet, so the browser never calls it directly.
 */
export async function renderReceipt(config: Config, body: ReceiptRequest): Promise<ReceiptResult> {
  if (!config.receiptApiUrl || !config.receiptApiKey) {
    return { ok: false, status: 503, code: 'not_configured' }
  }

  const res = await fetch(`${config.receiptApiUrl}/api/receipt/render`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': config.receiptApiKey },
    body: JSON.stringify(body)
  })

  if (!res.ok) {
    const errBody = (await res.json().catch(() => ({}))) as { error?: string }
    return { ok: false, status: res.status, code: 'upstream_error', error: errBody.error }
  }

  const png = Buffer.from(await res.arrayBuffer())
  return { ok: true, png, contentType: res.headers.get('content-type') ?? 'image/png' }
}
