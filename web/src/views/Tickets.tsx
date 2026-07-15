import { useEffect, useState } from 'react'
import { api, mkd, timeAgo, type Ticket } from '../api'

const STATUS_MK: Record<Ticket['status'], string> = {
  issued: 'важечки',
  redeemed: 'исплатен',
  voided: 'поништен',
  expired: 'истечен'
}

const FILTERS = [
  { key: 'issued', label: 'Важечки' },
  { key: 'redeemed', label: 'Исплатени' },
  { key: '', label: 'Сите' }
]

/** The 18-digit id prints as xx-xxxx-xxxx-xxxx-xxxx on the ticket. */
function pretty(id: string): string {
  if (id.length !== 18) return id
  return `${id.slice(0, 2)}-${id.slice(2, 6)}-${id.slice(6, 10)}-${id.slice(10, 14)}-${id.slice(14, 18)}`
}

export function Tickets({ isAdmin }: { isAdmin: boolean }) {
  const [tickets, setTickets] = useState<Ticket[]>([])
  const [filter, setFilter] = useState('issued')
  const [amount, setAmount] = useState('')
  const [err, setErr] = useState('')

  async function load() {
    setTickets(await api.tickets(filter || undefined))
  }

  useEffect(() => {
    void load()
  }, [filter])

  async function issue(e: React.FormEvent) {
    e.preventDefault()
    setErr('')
    try {
      await api.issueTicket(Math.round(Number(amount) * 100))
      setAmount('')
      await load()
    } catch (e) {
      setErr((e as Error).message)
    }
  }

  const outstanding = tickets.filter((t) => t.status === 'issued')
  const liability = outstanding.reduce((sum, t) => sum + t.amount_deni, 0)

  return (
    <>
      <div className="head">
        <div>
          <h2>Тикети (TITO)</h2>
          <p>Ваучери издадени од машината и исплатени назад.</p>
        </div>
        <div className="toolbar">
          {FILTERS.map((f) => (
            <button key={f.key} className={filter === f.key ? 'gold' : 'ghost'} onClick={() => setFilter(f.key)}>
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {filter === 'issued' && (
        <div className="stats">
          <div className="stat gold">
            <div className="k">Неисплатени тикети</div>
            <div className="v">{outstanding.length}</div>
          </div>
          <div className="stat crimson">
            <div className="k">Обврска</div>
            <div className="v">{mkd(liability)}</div>
            <div className="s">денари во оптек</div>
          </div>
        </div>
      )}

      <div className="split">
        <div className="card scroll">
          <table>
            <thead>
              <tr>
                <th>Број на тикет</th>
                <th className="num">Износ (ден.)</th>
                <th>Статус</th>
                <th>Издаден</th>
                {isAdmin && <th />}
              </tr>
            </thead>
            <tbody>
              {tickets.map((t) => (
                <tr key={t.id}>
                  <td className="mono">{pretty(t.id)}</td>
                  <td className="num money">{mkd(t.amount_deni)}</td>
                  <td>
                    <span className={`tag ${t.status}`}>{STATUS_MK[t.status]}</span>
                  </td>
                  <td className="muted">{timeAgo(t.created_at)}</td>
                  {isAdmin && (
                    <td style={{ textAlign: 'right' }}>
                      {t.status === 'issued' && (
                        <button
                          className="danger"
                          onClick={async () => {
                            if (confirm(`Поништи тикет ${pretty(t.id)}?`)) {
                              await api.voidTicket(t.id)
                              await load()
                            }
                          }}
                        >
                          Поништи
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
              {tickets.length === 0 && (
                <tr>
                  <td colSpan={5} className="muted" style={{ padding: 26, textAlign: 'center' }}>
                    Нема тикети.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {isAdmin && (
          <form className="card" onSubmit={issue}>
            <h3>Издај тикет рачно</h3>
            <div className="err">{err}</div>
            <div className="field">
              <label>Износ во денари</label>
              <input
                type="number"
                step="0.01"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                required
              />
            </div>
            <button className="gold" type="submit" style={{ width: '100%' }}>
              Издај
            </button>
          </form>
        )}
      </div>
    </>
  )
}
