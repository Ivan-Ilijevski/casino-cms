/**
 * The guest's card slip, drawn for the X5/X5h.
 *
 * At a normal bar an Ingenico terminal prints this and the till prints the fiscal
 * receipt. Here one printer does both, so a bar sale goes out as one strip — slip on
 * top, blank paper, then the fiscal receipt — and a Наплата/Исплата, which has no
 * fiscal receipt, as the slip alone.
 *
 * The slip is not a fiscal document and is never kept: its facts come from the one
 * /pos/confirm response (src/domain/paymentSlip.ts), and nothing here is stored or
 * logged. That is why a reprint from Сметки is the fiscal receipt alone, and why this
 * file never says „КОПИЈА“ — on this printer that word means a duplicate fiscal receipt.
 *
 * Drawn under the rules RASTER_WIDTH documents: pure black on white at the printer's
 * own width, bold type only, no hairlines.
 */

import { mkd, type PaymentSlip } from './api'
import contactlessUrl from './assets/Universal_Contactless_Card_Symbol.svg'
import logoUrl from './assets/logo.jpeg'
import { RASTER_WIDTH } from './printer'

const MARGIN = 8
/** Blank paper between the slip and the fiscal receipt, enough to tear them apart (~15mm at 8 dots/mm). */
const SLIP_GAP = 120

/** The logo is fitted inside this box: wide enough to read, short enough to spare paper. */
const LOGO_BOX = { width: 220, height: 150 }
const CONTACTLESS_WIDTH = 56

/**
 * The logo is a gold crown and a green club on off-white. Left to the printer's dither
 * both come out as a speckled grey, so everything darker than near-white is made solid.
 * The contactless symbol's outline is thin, and a stricter cut would break it.
 */
const LOGO_THRESHOLD = 200
const CONTACTLESS_THRESHOLD = 180

/** The slip's only two type sizes: every line reads at TEXT, the title and the amount at DISPLAY. */
const TEXT = 18
const DISPLAY = 20
/** Blank dots above and below a line of text, split evenly. */
const LEADING = 0

const FONT = (px: number) => `bold ${px}px sans-serif`
const p2 = (n: number) => String(n).padStart(2, '0')

// ---------------------------------------------------------------------- artwork

/**
 * Prepared once per page and shared by every sale, so a slip never waits on an image
 * load. A failure resolves to null and is forgotten, so the next slip tries again —
 * and prints without the picture meanwhile, because a missing logo must never stand
 * between a guest and proof of their payment.
 */
const artwork = new Map<string, Promise<HTMLCanvasElement | null>>()

function prepared(src: string, prepare: (img: HTMLImageElement) => HTMLCanvasElement) {
  let art = artwork.get(src)
  if (!art) {
    const img = new Image()
    img.src = src
    art = img.decode().then(
      () => prepare(img),
      (err: unknown) => {
        console.warn('[slip] could not load artwork', src, err)
        artwork.delete(src)
        return null
      }
    )
    artwork.set(src, art)
  }
  return art
}

/** Starts both image loads ahead of the first sale. Safe to call repeatedly. */
export function warmPaymentSlip(): void {
  void logoArt()
  void contactlessArt()
}

function canvas2d(width: number, height: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width))
  canvas.height = Math.max(1, Math.round(height))
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('2D canvas context unavailable')
  return [canvas, ctx]
}

const luma = (d: Uint8ClampedArray, i: number) => 0.299 * d[i]! + 0.587 * d[i + 1]! + 0.114 * d[i + 2]!

/** Every pixel to pure black or pure white, in place. The canvas is opaque white underneath. */
function threshold(ctx: CanvasRenderingContext2D, width: number, height: number, cut: number): void {
  const image = ctx.getImageData(0, 0, width, height)
  const d = image.data
  for (let i = 0; i < d.length; i += 4) {
    const v = luma(d, i) < cut ? 0 : 255
    d[i] = d[i + 1] = d[i + 2] = v
    d[i + 3] = 255
  }
  ctx.putImageData(image, 0, 0)
}

/** Draws `img` at the given size on white, then makes it pure black and white. */
function monochrome(
  img: CanvasImageSource,
  src: { x: number; y: number; width: number; height: number },
  width: number,
  height: number,
  cut: number
): HTMLCanvasElement {
  const [canvas, ctx] = canvas2d(width, height)
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(img, src.x, src.y, src.width, src.height, 0, 0, canvas.width, canvas.height)
  threshold(ctx, canvas.width, canvas.height, cut)
  return canvas
}

/**
 * The club logo, trimmed to its ink. The JPEG carries wide off-white margins that would
 * otherwise cost a hand's width of paper on every sale.
 */
function logoArt(): Promise<HTMLCanvasElement | null> {
  return prepared(logoUrl, (img) => {
    const [full, ctx] = canvas2d(img.naturalWidth, img.naturalHeight)
    ctx.drawImage(img, 0, 0)
    const d = ctx.getImageData(0, 0, full.width, full.height).data

    let top = full.height
    let left = full.width
    let right = -1
    let bottom = -1
    for (let y = 0; y < full.height; y++) {
      for (let x = 0; x < full.width; x++) {
        if (luma(d, (y * full.width + x) * 4) >= LOGO_THRESHOLD) continue
        if (x < left) left = x
        if (x > right) right = x
        if (y < top) top = y
        if (y > bottom) bottom = y
      }
    }
    // Nothing dark at all — draw the whole image rather than nothing.
    const ink =
      right < 0
        ? { x: 0, y: 0, width: full.width, height: full.height }
        : { x: left, y: top, width: right - left + 1, height: bottom - top + 1 }

    const scale = Math.min(LOGO_BOX.width / ink.width, LOGO_BOX.height / ink.height)
    return monochrome(img, ink, ink.width * scale, ink.height * scale, LOGO_THRESHOLD)
  })
}

/** The same contactless card symbol the tap screen shows. */
function contactlessArt(): Promise<HTMLCanvasElement | null> {
  return prepared(contactlessUrl, (img) => {
    // An SVG's natural size is only a hint; its aspect ratio is what matters here.
    const aspect = img.naturalWidth > 0 && img.naturalHeight > 0 ? img.naturalHeight / img.naturalWidth : 186 / 314
    const src = { x: 0, y: 0, width: img.naturalWidth || 314, height: img.naturalHeight || 186 }
    return monochrome(img, src, CONTACTLESS_WIDTH, CONTACTLESS_WIDTH * aspect, CONTACTLESS_THRESHOLD)
  })
}

// ---------------------------------------------------------------------- layout

interface Block {
  height: number
  draw: (ctx: CanvasRenderingContext2D, top: number) => void
}

/** Cuts `text` with an ellipsis until it fits `max` in the context's current font. */
function fit(ctx: CanvasRenderingContext2D, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text
  const chars = [...text]
  while (chars.length > 1 && ctx.measureText(`${chars.join('')}…`).width > max) chars.pop()
  return `${chars.join('').trimEnd()}…`
}

/** Centred text at the largest of `sizes` that fits, cut short at the smallest. */
function centred(text: string, sizes: number[], height: number, width: number): Block {
  return {
    height,
    draw(ctx, top) {
      const max = width - 2 * MARGIN
      for (const px of sizes) {
        ctx.font = FONT(px)
        if (ctx.measureText(text).width <= max) break
      }
      ctx.textAlign = 'center'
      ctx.fillText(fit(ctx, text, max), width / 2, top + height / 2)
    }
  }
}

/** A label on the left and its value on the right, the way a terminal slip reads. */
function row(label: string, value: string, width: number, size = TEXT, valueSize = size): Block {
  const height = Math.max(size, valueSize) + LEADING
  return {
    height,
    draw(ctx, top) {
      const mid = top + height / 2
      ctx.font = FONT(size)
      ctx.textAlign = 'left'
      ctx.fillText(label, MARGIN, mid)
      const labelWidth = ctx.measureText(label).width
      ctx.font = FONT(valueSize)
      ctx.textAlign = 'right'
      ctx.fillText(fit(ctx, value, width - 2 * MARGIN - labelWidth - GUTTER), width - MARGIN, mid)
    }
  }
}

/** Blank dots kept between the two facts on a packed line. */
const GUTTER = 8
/** A line whose facts cannot fit even cut shrinks its type, but never below this. */
const MIN_TEXT = 10
/** A cut value keeps at least this many characters before its ellipsis. */
const MIN_KEPT = 3

/**
 * One fact on a packed line: its label, longest spelling first, and its value.
 *
 * A value prints whole unless `cut` allows an ellipsis. Only names and descriptions do:
 * a time, a card, a reference or a balance is no use to anyone half-printed.
 */
interface Field {
  labels: string[]
  value: string
  cut?: boolean
}

/** A packed line: a fact at the left edge, and optionally one at the right. */
type Line = [left: Field, right: Field | null]

/** How many spellings each side's label has stepped down. */
interface Steps {
  left: number
  right: number
}

const spell = (field: Field, step: number) => `${field.labels[Math.min(step, field.labels.length - 1)]}: `

/**
 * The label spellings a line uses: of every combination that fits, the one that fills
 * the line most, so no label is shorter than the line needs. The shortest if none fits.
 */
function stepsFor(ctx: CanvasRenderingContext2D, [left, right]: Line, max: number): Steps {
  const measure = (text: string) => ctx.measureText(text).width
  const shortest = { left: left.labels.length - 1, right: right ? right.labels.length - 1 : 0 }
  let best: Steps | null = null
  let bestWidth = -1
  for (let l = 0; l <= shortest.left; l++) {
    for (let r = 0; r <= shortest.right; r++) {
      const width =
        measure(spell(left, l) + left.value) + (right ? GUTTER + measure(spell(right, r) + right.value) : 0)
      if (width <= max && width > bestWidth) {
        best = { left: l, right: r }
        bestWidth = width
      }
    }
  }
  return best ?? shortest
}

/**
 * A line's left and right text in the context's current font: whole if they fit, else
 * with its cuttable values cut a character at a time from whichever is wider, so two
 * long names end up cut to about the same width. Null if that still leaves it too long.
 */
function settle(ctx: CanvasRenderingContext2D, [left, right]: Line, steps: Steps, max: number): [string, string] | null {
  const measure = (text: string) => ctx.measureText(text).width
  const sides = [left, right]
    .map((field, i) => field && { field, label: spell(field, i === 0 ? steps.left : steps.right), value: field.value })
    .filter((side) => side !== null)
  const over = () => sides.reduce((sum, side) => sum + measure(side.label + side.value), GUTTER * (sides.length - 1)) - max

  const cuttable = sides.filter((side) => side.field.cut).map((side) => ({ side, kept: [...side.field.value] }))
  while (over() > 0) {
    const shrinkable = cuttable.filter((c) => c.kept.length > MIN_KEPT)
    if (shrinkable.length === 0) return null
    const widest = shrinkable.reduce((a, b) => (measure(a.side.value) >= measure(b.side.value) ? a : b))
    widest.kept.pop()
    widest.side.value = `${widest.kept.join('').trimEnd()}…`
  }

  const [first, second] = sides.map((side) => side.label + side.value)
  return [first!, second ?? '']
}

/**
 * Lines of one or two facts, `ЛАБЕЛА: вредност` at each edge, whose labels shorten
 * together: every line takes the shortest spelling any of them needs, so lines that read
 * as a set (the balances before and after) never mix a long label with a short one.
 *
 * A line too long even with its shortest labels cuts its names and descriptions. Only
 * if that is not enough does its type shrink — nothing else is ever hidden.
 */
function lines(group: Line[], width: number): Block[] {
  const height = TEXT + LEADING
  const max = width - 2 * MARGIN
  let shared: Steps | null = null

  return group.map((packed) => ({
    height,
    draw(ctx, top) {
      ctx.font = FONT(TEXT)
      // Measured for the whole set on its first draw, the first moment a context exists.
      shared ??= group
        .map((entry) => stepsFor(ctx, entry, max))
        .reduce((a, b) => ({ left: Math.max(a.left, b.left), right: Math.max(a.right, b.right) }))

      let texts: [string, string] | null = null
      for (let px = TEXT; px >= MIN_TEXT && !texts; px--) {
        ctx.font = FONT(px)
        texts = settle(ctx, packed, shared, max)
      }
      // Past the smallest type: print it whole and let it crowd, rather than hide it.
      const [left, right] = packed
      const [leftText, rightText] = texts ?? [spell(left, shared.left) + left.value, right ? spell(right, shared.right) + right.value : '']

      const mid = top + height / 2
      ctx.textAlign = 'left'
      ctx.fillText(leftText, MARGIN, mid)
      ctx.textAlign = 'right'
      ctx.fillText(rightText, width - MARGIN, mid)
    }
  }))
}

/** A packed line on its own, its labels shortening only for itself. */
const line = (left: Field, right: Field | null, width: number): Block => lines([[left, right]], width)[0]!

const gap = (height: number): Block => ({ height, draw() {} })

function rule(width: number): Block {
  return {
    height: 15,
    draw(ctx, top) {
      ctx.fillRect(MARGIN, top + 6, width - 2 * MARGIN, 3)
    }
  }
}

function picture(art: HTMLCanvasElement, width: number): Block {
  return {
    height: art.height + 12,
    draw(ctx, top) {
      ctx.drawImage(art, Math.round((width - art.width) / 2), top + 4)
    }
  }
}

function amountText(slip: PaymentSlip): string {
  if (slip.pay === 'points') return `${slip.amountPoints} поени`
  return `${slip.direction === 'credit' ? '+' : ''}${mkd(slip.amountDeni)} ден.`
}

function stamp(iso: string): string {
  const d = new Date(iso)
  return `${p2(d.getDate())}.${p2(d.getMonth() + 1)}.${d.getFullYear()} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`
}

/**
 * The slip as a canvas `width` dots wide.
 *
 * Laid out as blocks of fixed height first, so the canvas is sized once; only the text
 * inside a block depends on measuring.
 */
async function drawPaymentSlip(slip: PaymentSlip, width: number): Promise<HTMLCanvasElement> {
  const [logo, contactless] = await Promise.all([logoArt(), contactlessArt()])

  const blocks: Block[] = [gap(6)]
  if (logo) blocks.push(picture(logo, width))
  if (slip.address) blocks.push(centred(slip.address, [TEXT], TEXT + LEADING, width))
  blocks.push(rule(width))

  blocks.push(centred(slip.direction === 'credit' ? 'ИСПЛАТА' : 'ПРОДАЖБА', [DISPLAY], DISPLAY + 2 * LEADING, width))
  blocks.push(
    line(
      { labels: ['ДАТУМ', 'ДАТ'], value: stamp(slip.at) },
      { labels: ['КАРТИЧКА', 'КАРТ'], value: slip.card },
      width
    )
  )
  const pin = slip.pinVerified ? 'ПИН ПРОВЕРЕН' : 'БЕЗ ПИН'
  const approval = [`БЕСКОНТАКТНО, ${pin}`, `БЕСКОНТ., ${pin}`]
  if (contactless) {
    const height = contactless.height + LEADING + 4
    blocks.push({
      height,
      draw(ctx, top) {
        ctx.font = FONT(TEXT)
        const room = width - 2 * MARGIN - contactless.width - GUTTER
        const text = approval.find((spelling) => ctx.measureText(spelling).width <= room) ?? approval.at(-1)!
        ctx.textAlign = 'left'
        ctx.fillText(text, MARGIN, top + height / 2)
        ctx.drawImage(contactless, width - MARGIN - contactless.width, top + (LEADING + 4) / 2)
      }
    })
  } else {
    blocks.push(row(approval[0]!, '', width))
  }
  blocks.push(
    line(
      { labels: ['ГОСТИН', 'ГОСТ'], value: slip.playerName, cut: true },
      { labels: ['ОПЕРАТОР', 'ОПЕР'], value: slip.staff, cut: true },
      width
    )
  )

  // The reference shares a line with the order, or with the description when there is
  // none (an Исплата). A Наплата has both, so its description takes a line of its own.
  const reference: Field = { labels: ['РЕФЕРЕНЦА', 'РЕФ'], value: slip.reference }
  const [first, second] = [
    slip.orderNumber !== null ? { labels: ['НАРАЧКА', 'НАР'], value: `#${slip.orderNumber}` } : null,
    slip.label ? { labels: ['ОПИС'], value: slip.label, cut: true } : null
  ].filter((field) => field !== null)
  blocks.push(first ? line(first, reference, width) : line(reference, null, width))
  if (second) blocks.push(line(second, null, width))

  blocks.push(gap(LEADING / 2))
  blocks.push(row('ВКУПНО:', amountText(slip), width, TEXT, DISPLAY))
  blocks.push(gap(LEADING / 2))

  blocks.push(rule(width))
  const deni = (amount: number) => `${mkd(amount)} ден.`
  blocks.push(
    ...lines(
      [
        [
          { labels: ['ПРЕТХОДНА СОСТОЈБА', 'ПРЕТХОДНО', 'ПРЕТХ'], value: deni(slip.balanceBeforeDeni) },
          { labels: ['ПОЕНИ'], value: String(slip.pointsBefore) }
        ],
        [
          { labels: ['НОВА СОСТОЈБА', 'СОСТОЈБА', 'СОСТ'], value: deni(slip.balanceDeni) },
          { labels: ['ПОЕНИ'], value: String(slip.points) }
        ]
      ],
      width
    )
  )
  blocks.push(gap(10))

  const height = blocks.reduce((sum, b) => sum + b.height, 0)
  const [canvas, ctx] = canvas2d(width, height)
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, width, height)
  ctx.fillStyle = '#000'
  ctx.textBaseline = 'middle'

  let top = 0
  for (const block of blocks) {
    block.draw(ctx, top)
    top += block.height
  }
  return canvas
}

async function toPng(canvas: HTMLCanvasElement): Promise<Blob> {
  const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  if (!png) throw new Error('canvas.toBlob produced no PNG')
  return png
}

// --------------------------------------------------------------------- exports

/** The slip on its own — for a Наплата or Исплата, which has no fiscal receipt. */
export async function paymentSlipPng(slip: PaymentSlip): Promise<Blob> {
  return toPng(await drawPaymentSlip(slip, RASTER_WIDTH))
}

/**
 * The slip above a fiscal receipt, with blank paper between them so the guest can tear
 * the two apart. Drawn at the receipt's own width, so the printer never has
 * to rescale the fiscal part.
 */
export async function withPaymentSlip(slip: PaymentSlip, receipt: Blob): Promise<Blob> {
  const image = await createImageBitmap(receipt)
  const width = image.width
  const top = await drawPaymentSlip(slip, width)

  const [canvas, ctx] = canvas2d(width, top.height + SLIP_GAP + image.height)
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(top, 0, 0)
  ctx.drawImage(image, 0, top.height + SLIP_GAP)
  image.close()

  return toPng(canvas)
}
