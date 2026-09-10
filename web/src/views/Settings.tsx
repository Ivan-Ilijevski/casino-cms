import { useEffect, useState, useSyncExternalStore } from 'react'
import { api } from '../api'
import { Err } from '../components/Bits'
import {
  displayMode,
  enterFullscreen,
  exitFullscreen,
  fullscreenSupported,
  isFullscreen,
  rememberFullscreen,
  type DisplayMode
} from '../fullscreen'
import {
  checkPrinterSupport,
  describePrinterError,
  disconnectPrinter,
  pairPrinter,
  PrinterJobError,
  printerState,
  printPng,
  subscribePrinter,
  type PrinterSupport
} from '../printer'

const MODE_MK: Record<DisplayMode, string> = {
  fullscreen: 'на цел екран',
  standalone: 'како инсталирана апликација',
  'minimal-ui': 'како инсталирана апликација',
  browser: 'во картичка на прелистувачот'
}

export function Settings() {
  const supported = fullscreenSupported()
  const [on, setOn] = useState(isFullscreen)
  const [mode, setMode] = useState<DisplayMode>(displayMode)

  // Esc and the Android back gesture leave fullscreen without touching the button,
  // so the label is driven by the document rather than by what was last pressed.
  useEffect(() => {
    const sync = () => {
      setOn(isFullscreen())
      setMode(displayMode())
    }
    document.addEventListener('fullscreenchange', sync)
    document.addEventListener('webkitfullscreenchange', sync)
    return () => {
      document.removeEventListener('fullscreenchange', sync)
      document.removeEventListener('webkitfullscreenchange', sync)
    }
  }, [])

  // Acts on the label the user pressed, not on the live document state — see the
  // note on armFullscreenRestore() about the first tap after a reload.
  async function toggle() {
    const next = !on
    rememberFullscreen(next)
    await (next ? enterFullscreen() : exitFullscreen())
  }

  return (
    <>
      <div className="head">
        <div>
          <h2>Поставки</h2>
          <p>Вашата сметка и поставките за овој уред.</p>
        </div>
      </div>

      <div className="card settings-card">
        <div className="settings-row">
          <div>
            <h3>Цел екран</h3>
            <p className="muted">
              Ги крие лентите на прелистувачот и на уредот. Изборот се памети — по
              освежување на страницата се враќа на првиот допир.
            </p>
          </div>
          {supported ? (
            <button className={on ? 'ghost' : 'gold'} onClick={toggle}>
              {on ? 'Излези од цел екран' : 'Влези во цел екран'}
            </button>
          ) : (
            <div className="muted">Овој прелистувач не поддржува цел екран.</div>
          )}
        </div>

        <div className="settings-status muted">
          Апликацијата работи <strong>{MODE_MK[mode]}</strong>. Поставката важи само за овој
          уред.
        </div>
      </div>

      <PrinterCard />

      <ChangePassword />
    </>
  )
}

/**
 * The printer's native raster width in dots — the full head of an X5/X5h at 203dpi.
 *
 * `preparePngImage()` rescales anything that is not exactly this wide before it
 * Atkinson-dithers it, and a rescaled bitmap turns crisp glyphs into grey mush. So
 * the test page is authored at 384px and drawn in pure black on white: no greys, no
 * hairlines, and type big enough that the dither cannot eat it.
 */
const RASTER_WIDTH = 384

/** Short enough not to waste a strip of paper on every tap. */
const TEST_PAGE_HEIGHT = 120

const p2 = (n: number) => String(n).padStart(2, '0')

/**
 * Draws the test page in the browser rather than shipping an asset, so the stamp
 * can carry the current time — two tests in a row must be tellable apart on paper.
 *
 * Formatted by hand rather than through Intl, for the reason format.ts documents:
 * a Chromium built with a trimmed ICU silently falls back to en-US and prints the
 * wrong date order.
 */
async function testPagePng(): Promise<Blob> {
  const canvas = document.createElement('canvas')
  canvas.width = RASTER_WIDTH
  canvas.height = TEST_PAGE_HEIGHT
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('2D canvas context unavailable')

  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, RASTER_WIDTH, TEST_PAGE_HEIGHT)

  ctx.fillStyle = '#000'
  // Solid rules top and bottom: the fastest way to see whether the whole head fires.
  ctx.fillRect(0, 0, RASTER_WIDTH, 12)
  ctx.fillRect(0, TEST_PAGE_HEIGHT - 12, RASTER_WIDTH, 12)

  ctx.textAlign = 'center'
  ctx.textBaseline = 'alphabetic'
  const mid = RASTER_WIDTH / 2

  ctx.font = 'bold 34px sans-serif'
  ctx.fillText('КАЗИНО CMS', mid, 52)

  ctx.font = 'bold 24px sans-serif'
  ctx.fillText('ТЕСТ ПЕЧАТЕЊЕ', mid, 80)

  const d = new Date()
  const date = `${p2(d.getDate())}.${p2(d.getMonth() + 1)}.${d.getFullYear()}`
  const time = `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`
  ctx.font = 'bold 18px sans-serif'
  ctx.fillText(`${date} ${time}`, mid, 100)

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  if (!blob) throw new Error('canvas.toBlob produced no PNG')
  return blob
}

/**
 * The one place the X5/X5h gets paired.
 *
 * Chrome's device chooser needs a live user gesture, so pairing can only ever be a
 * deliberate tap — never something a sale triggers mid-payment. Каса then prints
 * through the same module-level connection this card opens; see printer.ts.
 */
function PrinterCard() {
  const state = useSyncExternalStore(subscribePrinter, printerState)
  const [support, setSupport] = useState<PrinterSupport | null>(null)
  const [err, setErr] = useState('')

  // Unlike fullscreenSupported() above, which only reads document.documentElement,
  // checkPrinterSupport() touches `navigator` and `isSecureContext` — so it is
  // probed once from an effect instead of during render.
  useEffect(() => {
    setSupport(checkPrinterSupport())
  }, [])

  // pairPrinter() opens the chooser, and Chrome only shows it while the tap's
  // transient activation is still alive. It is therefore called straight from the
  // handler with nothing awaited before it — the same rule webnfc.ts states for
  // scan(). Clearing the local error is synchronous and spends no activation, and
  // pairPrinter() never rejects: it reports through the store.
  function pair() {
    setErr('')
    void pairPrinter()
  }

  async function testPrint() {
    setErr('')
    try {
      await printPng(await testPagePng())
    } catch (e) {
      // A failed transfer has already put describePrinterError() in the store, so
      // repeating it here would stack two lines saying the same thing. What never
      // reaches the store is a 'not-connected' throw or a canvas that gave us no
      // blob — this line exists for those, and to keep the rejection handled.
      const spoken = e instanceof PrinterJobError && e.kind === 'transfer-failed'
      setErr(spoken ? '' : describePrinterError(e))
    }
  }

  const printing = state.status === 'printing'
  const linked = state.status === 'ready' || printing

  function controls() {
    // Nothing until the effect has probed; one paint without a button beats a button
    // that might have to be taken away.
    if (!support) return null
    if (!support.supported) return <div className="muted">{support.reason}</div>
    if (state.status === 'connecting') {
      return (
        <button className="gold" disabled>
          Се поврзува…
        </button>
      )
    }
    if (linked) {
      return (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="gold" disabled={printing} onClick={testPrint}>
            Тест печатење
          </button>
          <button className="ghost" disabled={printing} onClick={() => void disconnectPrinter()}>
            Исклучи
          </button>
        </div>
      )
    }
    // idle and error share the button: an error is only ever fixed by pairing again.
    return (
      <button className="gold" onClick={pair}>
        Поврзи печатач
      </button>
    )
  }

  return (
    <div className="card settings-card">
      <div className="settings-row">
        <div>
          <h3>Печатач</h3>
          <p className="muted">
            Bluetooth печатач за сметките на Каса. Мора да биде модел X5 или X5h.
            Спарувањето важи само за оваа сесија на прелистувачот — по освежување
            на страницата спарете го одново, бидејќи Web Bluetooth не може да ја
            врати врската без нов допир од корисникот.
          </p>
          {linked && (
            <div className="muted" style={{ fontSize: 13, marginTop: 6 }}>
              Поврзан: <strong className="mono">{state.deviceName ?? 'печатач без име'}</strong>
            </div>
          )}
          {printing && (
            <div className="muted" style={{ fontSize: 13, marginTop: 6 }}>
              Се испраќа: <strong className="mono">{state.percent}%</strong>
            </div>
          )}
        </div>
        {controls()}
      </div>

      {err !== '' && <Err>{err}</Err>}

      {state.message !== null && <div className="settings-status muted">{state.message}</div>}
    </div>
  )
}

const MIN_PASSWORD = 8

/** Every role, the bar tablet included — the current password is the check. */
function ChangePassword() {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [err, setErr] = useState('')
  const [done, setDone] = useState(false)
  const [busy, setBusy] = useState(false)

  const valid = current !== '' && next.length >= MIN_PASSWORD && next === confirm

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setErr('')
    setDone(false)
    try {
      await api.changeMyPassword(current, next)
      setCurrent('')
      setNext('')
      setConfirm('')
      setDone(true)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="card settings-card" onSubmit={submit}>
      <h3>Промени лозинка</h3>
      <p className="muted">
        Важи за вашата сметка на сите уреди. Старата престанува да важи веднаш.
      </p>

      <div className="field">
        <label htmlFor="current-password">Тековна лозинка</label>
        <input
          id="current-password"
          type="password"
          autoComplete="current-password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
        />
      </div>

      <div className="field">
        <label htmlFor="next-password">Нова лозинка</label>
        <input
          id="next-password"
          type="password"
          autoComplete="new-password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
        />
        <div className="hint">Најмалку {MIN_PASSWORD} знаци.</div>
      </div>

      <div className="field">
        <label htmlFor="confirm-password">Потврди нова лозинка</label>
        <input
          id="confirm-password"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
        {confirm !== '' && next !== confirm && (
          <div className="hint over">Двете лозинки не се совпаѓаат.</div>
        )}
      </div>

      <Err>{err}</Err>
      {done && <div className="settings-status muted">Лозинката е променета.</div>}

      <button type="submit" className="gold" disabled={!valid || busy}>
        {busy ? 'Се менува…' : 'Промени лозинка'}
      </button>
    </form>
  )
}
