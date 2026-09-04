import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { api, mkd, type MenuItem, type PosDirection, type PosIntentResponse } from '../api'
import { Dialog } from '../components/Dialog'
import { useIsMobile } from '../media'
import { shareFile } from '../share'
import { checkNfcSupport, NfcScanError, readCardUid } from '../webnfc'
import contactlessSvg from '../assets/Universal_Contactless_Card_Symbol.svg'
import logoCheck from '../assets/logo-check.gif'

type Stage = 'cart' | 'tap' | 'pin' | 'done' | 'failed'
type PosMode = 'bar' | 'charge'

/**
 * 'working' while the render call is in flight; 'manual' once the image is
 * ready but navigator.share() didn't go through on its own (unsupported, or
 * the gesture went stale) — the done screen then offers a button to retry it
 * from a fresh tap. 'error' means the render call itself failed.
 */
type ReceiptStatus = 'idle' | 'working' | 'manual' | 'error'
interface ReceiptState {
  status: ReceiptStatus
  blob: Blob | null
}
const RECEIPT_IDLE: ReceiptState = { status: 'idle', blob: null }

interface Quote {
  intentId: string
  player: { name: string; balance: number; points: number }
  totalDeni: number
  totalPoints: number
  pinRequired: boolean
  direction: PosDirection
  chargeType: 'order' | 'custom'
  label: string | null
}

const ERROR_MK: Record<string, string> = {
  unknown_card: 'Непозната картичка. Регистрирајте ја прво.',
  card_blocked: 'Картичката е блокирана.',
  no_pin_set: 'Оваа картичка нема ПИН. Постави ПИН пред плаќање.',
  pin_locked: 'Картичката е привремено заклучена поради погрешен ПИН.',
  insufficient: 'Недоволно средства на картичката.',
  empty: 'Празна нарачка.',
  out_of_stock: 'Нема залиха за еден од пијалаците.',
  pin_required: 'Потребен е ПИН.',
  pin_wrong: 'Погрешен ПИН.',
  intent_used: 'Оваа наплата е веќе направена.',
  intent_expired: 'Времето истече. Обидете се повторно.',
  unknown_intent: 'Наплатата не постои.'
}

const mkError = (code?: string, fallback = 'Настана грешка.') =>
  (code && ERROR_MK[code]) || fallback

export function Pos({ onExit }: { onExit: () => void }) {
  const [menu, setMenu] = useState<MenuItem[]>([])
  const [cart, setCart] = useState<Record<number, number>>({})
  const [pay, setPay] = useState<'cash' | 'points'>('cash')
  const [stage, setStage] = useState<Stage>('cart')
  const [quote, setQuote] = useState<Quote | null>(null)
  const [pin, setPin] = useState('')
  const [err, setErr] = useState('')
  const [nfcState, setNfcState] = useState<'idle' | 'scanning'>('idle')
  const [busy, setBusy] = useState(false)
  const abort = useRef<AbortController | null>(null)
  const [printReceipt, setPrintReceipt] = useState(true)
  const [receipt, setReceipt] = useState<ReceiptState>(RECEIPT_IDLE)
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // On a phone the cart cannot be a side column — see the cart bar below.
  const isMobile = useIsMobile()
  const [cartOpen, setCartOpen] = useState(false)

  // Custom charge state
  const [mode, setMode] = useState<PosMode>('bar')
  const [customAmount, setCustomAmount] = useState('')
  const [customDirection, setCustomDirection] = useState<PosDirection>('debit')
  const [customLabel, setCustomLabel] = useState('Чипови')

  const support = useMemo(() => checkNfcSupport(), [])

  useEffect(() => {
    void api.menu().then((m) => setMenu(m.items.filter((i) => i.available)))
    return () => abort.current?.abort()
  }, [])

  const items = Object.entries(cart)
    .filter(([, qty]) => qty > 0)
    .map(([drink, qty]) => ({ drink: Number(drink), qty }))

  const totals = items.reduce(
    (acc, i) => {
      const m = menu.find((x) => x.drink_id === i.drink)!
      return {
        deni: acc.deni + m.price_deni * i.qty,
        points: acc.points + m.points_price * i.qty
      }
    },
    { deni: 0, points: 0 }
  )

  const payable = pay === 'cash' || items.every((i) => menu.find((m) => m.drink_id === i.drink)!.points_price > 0)

  // Emptying the cart from inside the sheet leaves nothing to look at, and the
  // bar that opened it is gone too — so the sheet closes with it.
  useEffect(() => {
    if (items.length === 0) setCartOpen(false)
  }, [items.length])

  const customAmountDeni = Math.round(Number(customAmount) * 100)
  const customValid = customAmountDeni > 0 && customAmountDeni <= 5_000_000

  function bump(drinkId: number, by: number) {
    setCart((c) => ({ ...c, [drinkId]: Math.max(0, (c[drinkId] ?? 0) + by) }))
  }

  function reset() {
    abort.current?.abort()
    abort.current = null
    if (resetTimer.current) clearTimeout(resetTimer.current)
    resetTimer.current = null
    setCart({})
    setQuote(null)
    setPin('')
    setErr('')
    setNfcState('idle')
    setStage('cart')
    setCustomAmount('')
    setCustomDirection('debit')
    setCustomLabel('Чипови')
    setCartOpen(false)
    setPrintReceipt(true)
    setReceipt(RECEIPT_IDLE)
    // mode is NOT reset — staff stays in their working mode
  }

  /**
   * The success screen auto-clears after a few seconds — except while a
   * fiscal receipt is still being prepared or waiting on a manual retry tap,
   * where clearing it under the bartender's thumb would be worse than a
   * slightly longer pause.
   */
  function scheduleReset() {
    if (resetTimer.current) clearTimeout(resetTimer.current)
    resetTimer.current = setTimeout(reset, 3500)
  }

  /** Arm the reader (needs a user gesture), then quote against the tapped card. */
  async function armAndQuote() {
    setErr('')
    setNfcState('scanning')
    const controller = new AbortController()
    abort.current = controller

    try {
      const serial = await readCardUid(controller.signal)
      setNfcState('idle')
      setBusy(true)

      let res: PosIntentResponse
      if (mode === 'bar') {
        res = await api.posIntent(serial, items, pay)
      } else {
        res = await api.posCustomIntent(serial, customAmountDeni, customDirection, customLabel)
      }

      if (!res.ok) {
        setErr(mkError(res.code))
        setStage('failed')
        return
      }
      setQuote(res)
      if (res.pinRequired) {
        setStage('pin')
      } else {
        void charge(res.intentId)
      }
    } catch (e) {
      if (e instanceof NfcScanError && e.kind === 'other') return // cancelled
      setNfcState('idle')
      setErr(e instanceof Error ? e.message : 'Грешка при читање.')
      setStage('failed')
    } finally {
      setBusy(false)
    }
  }

  /**
   * Fires after a bar-mode payment succeeds. Non-blocking on purpose — the
   * "done" screen is already showing, this just fills in the print status on
   * top of it. Tries to open the share sheet itself; if that doesn't go
   * through (unsupported, or the gesture went stale by the time both network
   * calls resolve) it leaves the fetched image for a manual retry button.
   */
  async function tryPrintReceipt() {
    setReceipt({ status: 'working', blob: null })
    try {
      const lines = items.map((i) => {
        const m = menu.find((x) => x.drink_id === i.drink)!
        return {
          name: m.name,
          quantity: i.qty,
          price: m.price_deni / 100,
          vatType: m.vat_type,
          isDomestic: m.is_domestic === 1
        }
      })
      const blob = await api.receiptImage(lines, pay === 'points' ? 'ПОЕНИ' : undefined)
      const file = new File([blob], 'receipt.png', { type: 'image/png' })
      const shared = await shareFile(file, 'Фискална сметка')
      if (shared) {
        setReceipt(RECEIPT_IDLE)
        scheduleReset()
      } else {
        // Leave the done screen up so the "Печати" button below has time to be tapped.
        setReceipt({ status: 'manual', blob })
      }
    } catch {
      setReceipt({ status: 'error', blob: null })
      scheduleReset()
    }
  }

  async function charge(intentId: string, withPin?: string) {
    setBusy(true)
    setErr('')
    try {
      const res = await api.posConfirm(intentId, withPin)
      if (!res.ok) {
        setErr(mkError(res.code) + (res.attemptsLeft ? ` Преостанати обиди: ${res.attemptsLeft}.` : ''))
        // A wrong PIN keeps the pad open; anything else is terminal.
        if (res.code !== 'pin_wrong') setStage('failed')
        setPin('')
        return
      }
      setStage('done')
      if (printReceipt && mode === 'bar') void tryPrintReceipt()
      else setReceipt(RECEIPT_IDLE)
      scheduleReset()
    } finally {
      setBusy(false)
    }
  }

  // ------------------------------------------------------------- unsupported
  if (!support.supported) {
    return (
      <>
        <div className="head">
          <div>
            <h2>Каса</h2>
            <p>Плаќање со картичка на самото место.</p>
          </div>
          <div className="toolbar">
            <button className="ghost" onClick={onExit}>
              ← Назад
            </button>
          </div>
        </div>
        <div className="card" style={{ maxWidth: 560 }}>
          <h3>Овој уред не може да чита картички</h3>
          <p className="muted" style={{ fontSize: 14, lineHeight: 1.7 }}>
            {support.reason === 'no-api' ? (
              <>
                Читањето на картички користи <strong>Web NFC</strong>, кој постои само во{' '}
                <strong>Chrome на Android</strong>. Отворете ја касата од таблет со Android и
                вклучен NFC.
              </>
            ) : (
              <>
                Web NFC бара безбеден контекст (HTTPS). Отворете ја страницата преку HTTPS, или
                за тестирање додајте го овој origin во{' '}
                <code className="mono">chrome://flags/#unsafely-treat-insecure-origin-as-secure</code>{' '}
                и рестартирајте го Chrome.
              </>
            )}
          </p>
        </div>
      </>
    )
  }

  // ------------------------------------------------------------------- done
  if (stage === 'done' && quote) {
    const isCredit = quote.direction === 'credit'
    return (
      <div className="pos-screen light">
        <div className="pos-result ok">
          {/*
            The house animation draws a tick in gold and settles into the club's
            mark. It is authored on cream, so the whole screen takes that ground
            rather than framing a bright rectangle in a dark room — see
            .pos-screen.light. A GIF starts on mount with no play() to be refused.
          */}
          <img className="pos-success-clip" src={logoCheck} alt="" />
          <h2>{isCredit ? 'Исплатено' : 'Платено'}</h2>
          <div className={`pos-amount money ${isCredit ? 'credit' : ''}`}>
            {isCredit ? '+' : ''}{mkd(quote.totalDeni)} ден.
          </div>
          <p className="muted">{quote.player.name}</p>

          {receipt.status === 'working' && (
            <p className="muted" style={{ fontSize: 13 }}>
              Подготвување фискална сметка…
            </p>
          )}
          {receipt.status === 'error' && (
            <p className="muted" style={{ fontSize: 13 }}>
              Фискалната сметка не можеше да се подготви.
            </p>
          )}
          {receipt.status === 'manual' && receipt.blob && (
            <button
              className="ghost"
              style={{ marginTop: 8 }}
              onClick={() => {
                const blob = receipt.blob!
                void shareFile(new File([blob], 'receipt.png', { type: 'image/png' }), 'Фискална сметка').then(
                  () => {
                    setReceipt(RECEIPT_IDLE)
                    scheduleReset()
                  }
                )
              }}
            >
              Печати фискална
            </button>
          )}

          <button className="gold" onClick={reset} style={{ marginTop: 22 }}>
            Нова нарачка
          </button>
        </div>
      </div>
    )
  }

  // ----------------------------------------------------------------- failed
  if (stage === 'failed') {
    return (
      <div className="pos-screen">
        <div className="pos-result bad">
          <div className="pos-tick">✕</div>
          <h2>Не успеа</h2>
          <p style={{ maxWidth: 380, margin: '0 auto' }}>{err}</p>
          <button className="gold" onClick={reset} style={{ marginTop: 22 }}>
            Назад
          </button>
        </div>
      </div>
    )
  }

  // -------------------------------------------------------------- pin entry
  if (stage === 'pin' && quote) {
    const submit = (value: string) => void charge(quote.intentId, value)
    return (
      <div className="pos-screen">
        <div className="pos-pin">
          <div className="pos-pin-head">
            <div className="muted" style={{ fontSize: 12, letterSpacing: '0.12em' }}>
              БЕЗБЕДНОСНА ПРОВЕРКА
            </div>
            <h2>Внесете го вашиот ПИН</h2>
            <div className="pos-amount money">
              {quote.direction === 'credit' ? '+' : ''}{mkd(quote.totalDeni)} ден.
            </div>
            <p className="muted">{quote.player.name}</p>
          </div>

          <div className="pin-dots">
            {[0, 1, 2, 3].map((i) => (
              <span key={i} className={`pin-dot ${pin.length > i ? 'on' : ''}`} />
            ))}
          </div>

          <div className="err" style={{ textAlign: 'center' }}>
            {err}
          </div>

          <div className="pinpad">
            {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
              <button
                key={d}
                disabled={busy}
                onClick={() => {
                  const next = (pin + d).slice(0, 4)
                  setPin(next)
                  if (next.length === 4) submit(next)
                }}
              >
                {d}
              </button>
            ))}
            <button className="ghost" disabled={busy} onClick={reset}>
              Откажи
            </button>
            <button
              disabled={busy}
              onClick={() => {
                const next = (pin + '0').slice(0, 4)
                setPin(next)
                if (next.length === 4) submit(next)
              }}
            >
              0
            </button>
            <button className="ghost" disabled={busy} onClick={() => setPin(pin.slice(0, -1))}>
              ⌫
            </button>
          </div>
        </div>
      </div>
    )
  }

  // ------------------------------------------------------ customer: tap card
  if (stage === 'tap') {
    const isCredit = mode === 'charge' && customDirection === 'credit'
    const showAmount = mode === 'bar'
      ? (pay === 'points' ? `${totals.points} поени` : `${mkd(totals.deni)} ден.`)
      : `${mkd(customAmountDeni)} ден.`

    return (
      <div className="pos-screen light">
        <div className="pos-tap">
          <div className="muted" style={{ fontSize: 12, letterSpacing: '0.12em' }}>
            {isCredit ? 'ЗА ИСПЛАТА' : 'ЗА ПЛАЌАЊЕ'}
          </div>
          <div className={`pos-amount big money ${isCredit ? 'credit' : ''}`}>
            {showAmount}
          </div>

          <img
            src={contactlessSvg}
            alt=""
            className={`contactless-logo ${nfcState === 'scanning' ? 'scanning' : ''}`}
          />

          <p style={{ fontSize: 17, fontWeight: 600 }}>
            {nfcState === 'scanning'
              ? 'Приложете ја картичката'
              : busy
                ? 'Обработка...'
                : 'Подготвено за плаќање'}
          </p>
          <div className="err" style={{ textAlign: 'center' }}>
            {err}
          </div>

          {nfcState === 'idle' && !busy && (
            <button className="gold big-btn" disabled={busy} onClick={() => void armAndQuote()}>
              Потврди
            </button>
          )}
          <button className="ghost" onClick={reset} style={{ marginTop: 10 }}>
            Откажи
          </button>
        </div>
      </div>
    )
  }

  // ----------------------------------------------------------- staff: cart
  const Wrapper = mode === 'charge' ? 'div' : Fragment
  const wrapperProps = mode === 'charge' ? { className: 'pos-charge-full' } : {}

  /** The order itself — a side column on desktop, a bottom sheet on a phone. */
  const cartBody = (
    <>
      {items.length === 0 ? (
        <div className="muted" style={{ padding: '18px 0' }}>
          Изберете пијалаци.
        </div>
      ) : (
        <div className="stack" style={{ gap: 8 }}>
          {items.map((i) => {
            const m = menu.find((x) => x.drink_id === i.drink)!
            return (
              /*
                Name and controls are grouped rather than five loose siblings so
                the modal can stack them — the name on its own line, the qty and
                the total beneath it — while the desktop column keeps one line.
              */
              <div className="row pos-cart-row" key={i.drink}>
                <span className="name">{m.name}</span>
                <span className="controls">
                  <button onClick={() => bump(i.drink, -1)}>−</button>
                  <span className="mono qty">{i.qty}</span>
                  <button onClick={() => bump(i.drink, 1)}>+</button>
                  <span className="mono muted line-total">
                    {pay === 'points' ? `${m.points_price * i.qty} п.` : mkd(m.price_deni * i.qty)}
                  </span>
                </span>
              </div>
            )
          })}
        </div>
      )}

      <div
        className="row"
        style={{
          justifyContent: 'space-between',
          marginTop: 16,
          paddingTop: 14,
          borderTop: '1px solid var(--line)'
        }}
      >
        <span className="muted">Вкупно</span>
        <span className="money" style={{ fontSize: 22 }}>
          {pay === 'points' ? `${totals.points} п.` : `${mkd(totals.deni)} ден.`}
        </span>
      </div>

      <label className="row" style={{ marginTop: 12 }}>
        <input
          type="checkbox"
          checked={printReceipt}
          onChange={(e) => setPrintReceipt(e.target.checked)}
        />
        <span>Испринтај фискална</span>
      </label>

      {!payable && (
        <div className="banner" style={{ marginTop: 12 }}>
          Некој од избраните пијалаци не може да се плати со поени.
        </div>
      )}
    </>
  )

  return (
    <Wrapper {...wrapperProps}>
      <div className="head">
        <div>
          <h2>Каса</h2>
          {mode === 'bar' && <p>Направете нарачка, потоа дајте му го таблетот на гостинот да плати.</p>}
        </div>
        <div className="toolbar">
          {mode === 'bar' && (
            <>
              <button className={pay === 'cash' ? 'gold' : 'ghost'} onClick={() => setPay('cash')}>
                Денари
              </button>
              <button className={pay === 'points' ? 'gold' : 'ghost'} onClick={() => setPay('points')}>
                Поени
              </button>
            </>
          )}
          <button className="ghost" onClick={onExit}>
            ← Назад
          </button>
        </div>
      </div>

      <div className="pos-mode-tabs">
        <button className={mode === 'bar' ? 'active' : ''} onClick={() => setMode('bar')}>
          Бар
        </button>
        <button className={mode === 'charge' ? 'active' : ''} onClick={() => setMode('charge')}>
          Наплата
        </button>
      </div>

      {mode === 'bar' ? (
        <div className={isMobile ? '' : 'split'}>
          <div className={isMobile && items.length > 0 ? 'pos-tiles has-cartbar' : 'pos-tiles'}>
            {menu.map((m) => (
              <button
                key={m.drink_id}
                className={'tile' + ((cart[m.drink_id] ?? 0) > 0 ? ' picked' : '')}
                onClick={() => bump(m.drink_id, 1)}
              >
                <span className="tile-name">{m.name}</span>
                <span className="tile-price mono">
                  {pay === 'points' ? `${m.points_price || '—'} п.` : mkd(m.price_deni)}
                </span>
                <span className="tile-qty" style={{ visibility: (cart[m.drink_id] ?? 0) > 0 ? 'visible' : 'hidden' }}>
                  {cart[m.drink_id] ?? 0}
                </span>
              </button>
            ))}
          </div>

          {!isMobile && (
            <div className="card">
              <h3>Нарачка</h3>
              {cartBody}
              <button
                className="gold big-btn"
                style={{ width: '100%', marginTop: 14 }}
                disabled={items.length === 0 || !payable}
                onClick={() => setStage('tap')}
              >
                Наплати
              </button>
              {items.length > 0 && (
                <button className="ghost" style={{ width: '100%', marginTop: 8 }} onClick={reset}>
                  Исчисти
                </button>
              )}
            </div>
          )}
        </div>
      ) : (
        /* ------------------------------------------------- custom charge mode */
        <div className="pos-custom">
          <div className="pos-custom-dir">
            <button
              className={customDirection === 'debit' ? 'active' : ''}
              onClick={() => setCustomDirection('debit')}
            >
              Наплати
            </button>
            <button
              className={customDirection === 'credit' ? 'active' : ''}
              onClick={() => setCustomDirection('credit')}
            >
              Исплати
            </button>
          </div>

          <div className="pos-custom-labels">
            {['Чипови', 'Друго'].map((l) => (
              <button
                key={l}
                className={customLabel === l ? 'active' : ''}
                onClick={() => setCustomLabel(l)}
              >
                {l}
              </button>
            ))}
          </div>

          <div className="pos-amount-display">{customAmount || '0'}</div>
          <div className="muted" style={{ textAlign: 'center', fontSize: 13 }}>
            Износ во денари
          </div>

          <div className="pos-keypad">
            {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
              <button key={d} onClick={() => setCustomAmount((v) => {
                if (v.length >= 8) return v
                const dec = v.indexOf('.')
                if (dec !== -1 && v.length - dec > 2) return v
                return v === '0' ? d : v + d
              })}>{d}</button>
            ))}
            <button onClick={() => setCustomAmount((v) => {
              if (v.includes('.') || v.length >= 7) return v
              return v === '' ? '0.' : v + '.'
            })}>.</button>
            <button onClick={() => setCustomAmount((v) => {
              if (v.length >= 8) return v
              const dec = v.indexOf('.')
              if (dec !== -1 && v.length - dec > 2) return v
              return v === '' ? '0' : v + '0'
            })}>0</button>
            <button className="ghost" onClick={() => setCustomAmount((v) => v.slice(0, -1))}>⌫</button>
          </div>

          <button
            className="gold big-btn"
            style={{ width: '100%' }}
            disabled={!customValid}
            onClick={() => setStage('tap')}
          >
            {customDirection === 'debit' ? 'Наплати' : 'Исплати'}
          </button>
        </div>
      )}

      {/*
        The cart used to be the second column of .split, which on a phone lands
        BELOW the whole tile grid — the total and Наплати were off-screen, so
        charging a guest meant scrolling past every drink first. Fixed to the
        bottom instead, with the line items one tap away.
      */}
      {isMobile && mode === 'bar' && items.length > 0 && (
        <div className="pos-cartbar">
          <button className="summary" onClick={() => setCartOpen(true)}>
            <span className="count-line">
              {items.reduce((n, i) => n + i.qty, 0)} ставки · измени
            </span>
            <span className="money total">
              {pay === 'points' ? `${totals.points} п.` : `${mkd(totals.deni)} ден.`}
            </span>
          </button>
          <button className="gold" disabled={!payable} onClick={() => setStage('tap')}>
            Наплати
          </button>
        </div>
      )}

      {isMobile && mode === 'bar' && cartOpen && (
        <Dialog
          title="Нарачка"
          onClose={() => setCartOpen(false)}
          footer={
            <>
              <button type="button" className="ghost" onClick={reset}>
                Исчисти
              </button>
              <button
                type="button"
                className="gold"
                disabled={items.length === 0 || !payable}
                onClick={() => {
                  setCartOpen(false)
                  setStage('tap')
                }}
              >
                Наплати
              </button>
            </>
          }
        >
          {cartBody}
        </Dialog>
      )}
    </Wrapper>
  )
}
