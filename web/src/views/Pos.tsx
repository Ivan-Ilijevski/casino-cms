import { useEffect, useMemo, useRef, useState } from 'react'
import { api, mkd, type MenuItem } from '../api'
import { checkNfcSupport, NfcScanError, readCardUid } from '../webnfc'

type Stage = 'cart' | 'tap' | 'pin' | 'done' | 'failed'

interface Quote {
  intentId: string
  player: { name: string; balance: number; points: number }
  totalDeni: number
  totalPoints: number
  pinRequired: boolean
}

const ERROR_MK: Record<string, string> = {
  unknown_card: 'Непозната картичка. Регистрирајте ја прво.',
  card_blocked: 'Картичката е блокирана.',
  no_pin_set: 'Оваа картичка нема ПИН. Постави ПИН пред плаќање.',
  pin_locked: 'Картичката е привремено заклучена поради погрешен ПИН.',
  insufficient: 'Недоволно средства на картичката.',
  empty: 'Празна нарачка.',
  pin_required: 'Потребен е ПИН.',
  pin_wrong: 'Погрешен ПИН.',
  intent_used: 'Оваа наплата е веќе направена.',
  intent_expired: 'Времето истече. Обидете се повторно.',
  unknown_intent: 'Наплатата не постои.'
}

const mkError = (code?: string, fallback = 'Настана грешка.') =>
  (code && ERROR_MK[code]) || fallback

export function Pos() {
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

  function bump(drinkId: number, by: number) {
    setCart((c) => ({ ...c, [drinkId]: Math.max(0, (c[drinkId] ?? 0) + by) }))
  }

  function reset() {
    abort.current?.abort()
    abort.current = null
    setCart({})
    setQuote(null)
    setPin('')
    setErr('')
    setNfcState('idle')
    setStage('cart')
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

      const res = await api.posIntent(serial, items, pay)
      if (!res.ok) {
        setErr(mkError(res.code))
        setStage('failed')
        return
      }
      setQuote(res)
      if (res.pinRequired) {
        setStage('pin')
      } else {
        await charge(res.intentId)
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
      setTimeout(reset, 3500)
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
    return (
      <div className="pos-screen">
        <div className="pos-result ok">
          <div className="pos-tick">✓</div>
          <h2>Платено</h2>
          <div className="pos-amount money">
            {pay === 'points' ? `${quote.totalPoints} поени` : `${mkd(quote.totalDeni)} ден.`}
          </div>
          <p className="muted">{quote.player.name}</p>
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
              {pay === 'points' ? `${quote.totalPoints} поени` : `${mkd(quote.totalDeni)} ден.`}
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
    return (
      <div className="pos-screen">
        <div className="pos-tap">
          <div className="muted" style={{ fontSize: 12, letterSpacing: '0.12em' }}>
            ЗА ПЛАЌАЊЕ
          </div>
          <div className="pos-amount big money">
            {pay === 'points' ? `${totals.points} поени` : `${mkd(totals.deni)} ден.`}
          </div>

          <div className={`nfc-target ${nfcState === 'scanning' ? 'live' : ''}`}>
            <div className="nfc-ring" />
            <div className="nfc-ring d2" />
            <div className="nfc-wave">◗))</div>
          </div>

          <p style={{ fontSize: 17, fontWeight: 600 }}>
            {nfcState === 'scanning' ? 'Приложете ја картичката' : 'Подготвено за плаќање'}
          </p>
          <div className="err" style={{ textAlign: 'center' }}>
            {err}
          </div>

          {nfcState === 'idle' && (
            <button className="gold big-btn" disabled={busy} onClick={() => void armAndQuote()}>
              Активирај читач
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
  return (
    <>
      <div className="head">
        <div>
          <h2>Каса</h2>
          <p>Направете нарачка, потоа дајте му го таблетот на гостинот да плати.</p>
        </div>
        <div className="toolbar">
          <button className={pay === 'cash' ? 'gold' : 'ghost'} onClick={() => setPay('cash')}>
            Денари
          </button>
          <button className={pay === 'points' ? 'gold' : 'ghost'} onClick={() => setPay('points')}>
            Поени
          </button>
        </div>
      </div>

      <div className="split">
        <div className="pos-tiles">
          {menu.map((m) => (
            <button key={m.drink_id} className="tile" onClick={() => bump(m.drink_id, 1)}>
              <span className="tile-name">{m.name}</span>
              <span className="tile-price mono">
                {pay === 'points' ? `${m.points_price || '—'} п.` : mkd(m.price_deni)}
              </span>
              {(cart[m.drink_id] ?? 0) > 0 && <span className="tile-qty">{cart[m.drink_id]}</span>}
            </button>
          ))}
        </div>

        <div className="card">
          <h3>Нарачка</h3>
          {items.length === 0 ? (
            <div className="muted" style={{ padding: '18px 0' }}>
              Изберете пијалаци.
            </div>
          ) : (
            <div className="stack" style={{ gap: 8 }}>
              {items.map((i) => {
                const m = menu.find((x) => x.drink_id === i.drink)!
                return (
                  <div className="row" key={i.drink} style={{ justifyContent: 'space-between' }}>
                    <span style={{ flex: 1, fontWeight: 600 }}>{m.name}</span>
                    <button onClick={() => bump(i.drink, -1)}>−</button>
                    <span className="mono" style={{ minWidth: 22, textAlign: 'center' }}>
                      {i.qty}
                    </span>
                    <button onClick={() => bump(i.drink, 1)}>+</button>
                    <span className="mono muted" style={{ minWidth: 68, textAlign: 'right' }}>
                      {pay === 'points'
                        ? `${m.points_price * i.qty} п.`
                        : mkd(m.price_deni * i.qty)}
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

          {!payable && (
            <div className="banner" style={{ marginTop: 12 }}>
              Некој од избраните пијалаци не може да се плати со поени.
            </div>
          )}

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
      </div>
    </>
  )
}
