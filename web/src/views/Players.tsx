import { useEffect, useState } from 'react'
import { api, mkd, timeAgo, type Card, type LedgerEntry, type UnknownTap } from '../api'

const KIND_MK: Record<string, string> = {
  adjustment: 'корекција',
  aft_debit: 'кредити на машина',
  aft_credit: 'исплата на картичка',
  aft_rollback: 'вратен трансфер',
  order: 'нарачка',
  order_refund: 'враќање за нарачка',
  points_earned: 'освоени поени'
}

export function Players({ isAdmin }: { isAdmin: boolean }) {
  const [cards, setCards] = useState<Card[]>([])
  const [taps, setTaps] = useState<UnknownTap[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [history, setHistory] = useState<LedgerEntry[]>([])
  const [err, setErr] = useState('')

  // Registering a tapped card: staff pick it off the inbox, no hex typing.
  const [regUid, setRegUid] = useState('')
  const [regName, setRegName] = useState('')
  const [regPin, setRegPin] = useState('')

  async function load() {
    setCards(await api.cards())
    setTaps(await api.unknownTaps())
  }

  useEffect(() => {
    void load()
    const t = setInterval(() => void api.unknownTaps().then(setTaps), 5000)
    return () => clearInterval(t)
  }, [])

  async function open(id: string) {
    setSelected(id)
    setHistory((await api.card(id)).history)
  }

  async function register(e: React.FormEvent) {
    e.preventDefault()
    setErr('')
    try {
      await api.registerCard(regUid, regName, regPin)
      setRegUid('')
      setRegName('')
      setRegPin('')
      await load()
    } catch (e) {
      setErr((e as Error).message)
    }
  }

  async function changePin(card: Card) {
    const pin = prompt(`Нов 4-цифрен ПИН за ${card.player_name}:`)
    if (!pin) return
    setErr('')
    try {
      await api.setPin(card.id, pin)
      await load()
    } catch (e) {
      setErr((e as Error).message)
    }
  }

  async function adjust(card: Card) {
    const raw = prompt(`Корекција за ${card.player_name} во денари (пр. 500 или -500):`)
    if (!raw) return
    const denars = Number(raw)
    if (!Number.isFinite(denars) || denars === 0) return
    setErr('')
    try {
      await api.adjust(card.id, 'deni', Math.round(denars * 100), prompt('Причина:') ?? '')
      await load()
      if (selected === card.id) await open(card.id)
    } catch (e) {
      setErr((e as Error).message)
    }
  }

  return (
    <>
      <div className="head">
        <div>
          <h2>Гости и картички</h2>
          <p>Регистрација на картички, состојби и историја.</p>
        </div>
      </div>

      <div className="err">{err}</div>

      {taps.length > 0 && (
        <div className="banner">
          Непознати картички допрени на терминалот: {taps.map((t) => t.card_uid).join(', ')} — регистрирајте ги подолу.
        </div>
      )}

      <div className="split">
        <div className="stack">
          <div className="card scroll">
            <h3>Картички</h3>
            <table>
              <thead>
                <tr>
                  <th>Гостин</th>
                  <th>UID</th>
                  <th className="num">Состојба</th>
                  <th className="num">Поени</th>
                  <th>Статус</th>
                  {isAdmin && <th />}
                </tr>
              </thead>
              <tbody>
                {cards.map((c) => (
                  <tr key={c.id} onClick={() => void open(c.id)} style={{ cursor: 'pointer' }}>
                    <td style={{ fontWeight: 600 }}>{c.player_name}</td>
                    <td className="mono muted">{c.card_uid}</td>
                    <td className="num money">{mkd(c.balance_deni)}</td>
                    <td className="num muted">{c.points}</td>
                    <td>
                      {c.status === 'blocked' ? (
                        <span className="tag blocked">блокирана</span>
                      ) : (
                        <span className="tag fulfilled">активна</span>
                      )}
                      {!c.has_pin && (
                        <span className="tag cancelled" style={{ marginLeft: 5 }} title="Не може да плаќа на касата">
                          без пин
                        </span>
                      )}
                    </td>
                    {isAdmin && (
                      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                        <button onClick={(e) => (e.stopPropagation(), void changePin(c))}>ПИН</button>{' '}
                        <button onClick={(e) => (e.stopPropagation(), void adjust(c))}>Корекција</button>{' '}
                        <button
                          className="danger"
                          onClick={async (e) => {
                            e.stopPropagation()
                            await (c.status === 'blocked' ? api.unblock(c.id) : api.block(c.id))
                            await load()
                          }}
                        >
                          {c.status === 'blocked' ? 'Одблокирај' : 'Блокирај'}
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
                {cards.length === 0 && (
                  <tr>
                    <td colSpan={6} className="muted" style={{ padding: 26, textAlign: 'center' }}>
                      Сè уште нема регистрирани картички.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {selected && (
            <div className="card scroll">
              <h3>Историја на промени</h3>
              <table>
                <thead>
                  <tr>
                    <th>Кога</th>
                    <th>Тип</th>
                    <th className="num">Износ</th>
                    <th>Кој</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((h) => (
                    <tr key={h.id}>
                      <td className="mono muted">{timeAgo(h.created_at)}</td>
                      <td>{KIND_MK[h.kind] ?? h.kind}</td>
                      <td
                        className="num money"
                        style={{ color: h.amount < 0 ? 'var(--crimson)' : 'var(--emerald)' }}
                      >
                        {h.amount > 0 ? '+' : ''}
                        {h.unit === 'deni' ? mkd(h.amount) : `${h.amount} п.`}
                      </td>
                      <td className="muted">{h.actor}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {isAdmin && (
          <div className="stack">
            <div className="card">
              <h3>Регистрирај картичка</h3>
              {taps.length > 0 && (
                <div style={{ marginBottom: 12 }}>
                  <label>Скоро допрени</label>
                  {taps.map((t) => (
                    <button
                      key={t.card_uid}
                      className="mono"
                      style={{ width: '100%', marginBottom: 5, textAlign: 'left' }}
                      onClick={() => setRegUid(t.card_uid)}
                    >
                      {t.card_uid} <span className="muted">×{t.count}</span>
                    </button>
                  ))}
                </div>
              )}
              <form onSubmit={register}>
                <div className="field">
                  <label>UID на картичка</label>
                  <input className="mono" value={regUid} onChange={(e) => setRegUid(e.target.value)} required />
                </div>
                <div className="field">
                  <label>Име на гостин</label>
                  <input value={regName} onChange={(e) => setRegName(e.target.value)} required />
                </div>
                <div className="field">
                  <label>ПИН (4 цифри)</label>
                  <input
                    className="mono"
                    inputMode="numeric"
                    pattern="[0-9]{4}"
                    maxLength={4}
                    value={regPin}
                    onChange={(e) => setRegPin(e.target.value.replace(/\D/g, ''))}
                    required
                  />
                  <div className="muted" style={{ fontSize: 11, marginTop: 5 }}>
                    Се бара на секое осмо плаќање на касата.
                  </div>
                </div>
                <button className="gold" type="submit" style={{ width: '100%' }}>
                  Регистрирај
                </button>
              </form>
            </div>
          </div>
        )}
      </div>
    </>
  )
}
