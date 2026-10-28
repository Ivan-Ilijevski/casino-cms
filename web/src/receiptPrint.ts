/**
 * The one road from a rendered fiscal receipt to the printer, shared by Каса and the
 * receipt history — so both log their attempts the same way and neither can print a
 * copy without the КОПИЈА band.
 *
 * The server is told before a byte goes out and again once the transfer settles. It
 * decides whether this print is a copy; the tablet only draws what it is told. The log
 * is best effort throughout: a network hiccup to the CMS must never stand between a
 * guest and a receipt the printer could have produced.
 *
 * Каса also puts the guest's card slip on top (paymentSlip.ts). It rides in the same
 * job but is not the logged document: the КОПИЈА band only ever wraps the fiscal part,
 * and a logged percent counts the whole strip, slip included. The history passes no
 * slip, because nothing of it was kept.
 */

import { api, type PaymentSlip, type ReceiptPrintStatus } from './api'
import { withPaymentSlip } from './paymentSlip'
import { describePrinterError, PrinterJobError, printerState, printPng } from './printer'

/**
 * How a thrown print maps onto the log. Nothing sent is 'failed' at 0%; a link that
 * dropped mid-receipt is 'interrupted', because that is the one that leaves half a
 * receipt in the printer for someone to tear off.
 */
function outcomeOf(err: unknown): { status: Exclude<ReceiptPrintStatus, 'sending'>; percent: number } {
  if (err instanceof PrinterJobError) {
    if (err.kind === 'link-lost') return { status: 'interrupted', percent: err.percent }
    return { status: 'failed', percent: err.percent }
  }
  return { status: 'failed', percent: 0 }
}

async function report(
  printId: number,
  outcome: { status: Exclude<ReceiptPrintStatus, 'sending'>; percent: number; error?: string }
): Promise<void> {
  try {
    await api.finishReceiptPrint(printId, outcome)
  } catch (e) {
    console.warn('[receipt] could not record how the print ended', e)
  }
}

/**
 * Sends one receipt to the printer and logs the attempt.
 *
 * `receiptId` is null only when the server did not name the row — then the receipt
 * still prints, unlogged, rather than not at all. Rejects exactly as `printPng` does,
 * so callers branch on `PrinterJobError.kind` the same way.
 *
 * `slip`, when given, is drawn above the receipt. A canvas failure while composing is
 * logged as a failed print like any other, since nothing reached the printer.
 */
export async function printReceipt(
  receiptId: number | null,
  blob: Blob,
  opts: { slip?: PaymentSlip } = {}
): Promise<{ copy: boolean }> {
  let printId: number | null = null
  let copy = false
  if (receiptId !== null) {
    try {
      const started = await api.startReceiptPrint(receiptId, printerState().deviceName)
      printId = started.printId
      copy = started.copy
    } catch (e) {
      console.warn('[receipt] could not open a print log entry', e)
    }
  }

  try {
    const fiscal = copy ? await markAsCopy(blob) : blob
    await printPng(opts.slip ? await withPaymentSlip(opts.slip, fiscal) : fiscal)
  } catch (err) {
    if (printId !== null) void report(printId, { ...outcomeOf(err), error: describePrinterError(err) })
    throw err
  }
  if (printId !== null) void report(printId, { status: 'sent', percent: 100 })
  return { copy }
}

const TOP_BAND = 52
const BOTTOM_BAND = 34

/**
 * The receipt with a solid КОПИЈА band above and below it, so a duplicate can never be
 * handed over as a second original — the top one is the first thing out of the printer,
 * the bottom one the last thing left on the roll.
 *
 * Pure black and white at the image's own width, for the reason `RASTER_WIDTH` in
 * printer.ts gives: `preparePngImage` rescales anything not 384px wide and dithers greys,
 * and either turns type to mush. The render API already returns exactly 384px.
 */
export async function markAsCopy(blob: Blob): Promise<Blob> {
  const image = await createImageBitmap(blob)
  const width = image.width
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = TOP_BAND + image.height + BOTTOM_BAND
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('2D canvas context unavailable')

  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(image, 0, TOP_BAND)
  image.close()

  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, width, TOP_BAND - 8)
  ctx.fillRect(0, canvas.height - BOTTOM_BAND + 6, width, BOTTOM_BAND - 6)

  ctx.fillStyle = '#fff'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = 'bold 32px sans-serif'
  ctx.fillText('КОПИЈА', width / 2, (TOP_BAND - 8) / 2 + 1)
  ctx.font = 'bold 20px sans-serif'
  ctx.fillText('КОПИЈА', width / 2, canvas.height - (BOTTOM_BAND - 6) / 2)

  const marked = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  if (!marked) throw new Error('canvas.toBlob produced no PNG')
  return marked
}
