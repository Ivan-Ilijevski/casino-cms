import type { Config } from '../config.js'
import type { PayMethod } from './orders.js'

export interface ReceiptItem {
  name: string
  quantity: number
  price: number
  vatType: 'A' | 'B' | 'V' | 'G'
  isDomestic: boolean
}

export interface ReceiptRequest {
  items: ReceiptItem[]
  /**
   * Which balance the guest settled from. The printed tender line is derived from this
   * below — callers say how the sale was paid, never what the receipt should say.
   */
  payMethod: PayMethod
  /**
   * The daily sequence number, already zero-padded ('0001'). Printed as
   * `#${receiptNumber}` in the header. Required, never optional: the render API fills
   * what it is not sent from its own preset, which is why every receipt printed before
   * this existed said #0012 — its demo value.
   */
  receiptNumber: string
}

/**
 * What each pay method prints on the fiscal receipt's tender line.
 *
 * Both are card payments as far as the receipt is concerned: the guest settled from a
 * balance held on their casino card, never with notes over the bar. `cash` names the
 * card's *денари* balance, not banknotes, so it prints НА КРЕДИТ — that is not a typo. Only a
 * points purchase prints ПОЕНИ, and nothing here can ever print ВО ГОТОВО.
 *
 * Typed `Record<PayMethod, string>` so a new pay method cannot be added without someone
 * deciding what it says on a fiscal document.
 */
const PAYMENT_METHOD_LABELS: Record<PayMethod, string> = {
  cash: 'НА КРЕДИТ',
  points: 'ПОЕНИ'
}

/**
 * The receipt boundary's guard, derived from the table so it can only admit a method we
 * know how to print. `Object.hasOwn` rather than `in`: `'constructor' in labels` is true
 * and its value is a function, which `JSON.stringify` drops — which would hand the browser
 * a way to send no tender line at all, the exact failure this module now prevents.
 */
export function isPayMethod(value: unknown): value is PayMethod {
  return typeof value === 'string' && Object.hasOwn(PAYMENT_METHOD_LABELS, value)
}

export type ReceiptResult =
  | { ok: true; png: Buffer; contentType: string }
  | { ok: false; status: number; code: 'not_configured' | 'upstream_error'; error?: string }

/**
 * Proxies a fiscal-receipt render to the external Receipt Render API, keeping
 * its x-api-key server-side — the API's own docs say to keep that key and the
 * endpoint off the open internet, so the browser never calls it directly.
 *
 * Who the receipt is *from* comes from config, not from the caller: the store
 * identity is a property of this deployment, so the browser cannot put another
 * company's name on a fiscal receipt by editing the request it sends us. Unset
 * fields are omitted rather than sent empty — the render API fills what it is
 * not sent from its own demo preset, and a wrong-but-plausible header is easier
 * to miss than an obviously unconfigured one.
 *
 * The tender line is the same class of fact, and the same preset filled it: an absent
 * `paymentMethod` printed the API's default ВО ГОТОВО on a POS that takes no cash. So it
 * is resolved here from `payMethod` and always sent, and the browser cannot type what a
 * fiscal receipt says it was paid with. `receiptNumber` is sent unconditionally for the
 * same reason — it is allocated per sale by domain/receiptNumbers.ts, not chosen here.
 */
export async function renderReceipt(config: Config, body: ReceiptRequest): Promise<ReceiptResult> {
  if (!config.receiptApiUrl || !config.receiptApiKey) {
    return { ok: false, status: 503, code: 'not_configured' }
  }

  // Trimmed because a .env value that is only whitespace is "unset" in every sense
  // that matters here, but would pass the API's `typeof === 'string'` guard and print
  // as a blank header line.
  const storeName = config.receiptStoreName.trim()
  const address = config.receiptAddress.trim()

  const res = await fetch(`${config.receiptApiUrl}/api/receipt/render`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': config.receiptApiKey },
    body: JSON.stringify({
      items: body.items,
      paymentMethod: PAYMENT_METHOD_LABELS[body.payMethod],
      receiptNumber: body.receiptNumber,
      ...(storeName ? { storeName } : {}),
      ...(address ? { address } : {})
    })
  })

  if (!res.ok) {
    const errBody = (await res.json().catch(() => ({}))) as { error?: string }
    return { ok: false, status: res.status, code: 'upstream_error', error: errBody.error }
  }

  const png = Buffer.from(await res.arrayBuffer())
  return { ok: true, png, contentType: res.headers.get('content-type') ?? 'image/png' }
}
