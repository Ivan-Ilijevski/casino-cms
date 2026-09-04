import { useEffect, useState } from 'react'
import { api, mkd, type Summary } from '../api'

export function Reports() {
  const [s, setSummary] = useState<Summary | null>(null)

  useEffect(() => {
    void api.summary().then(setSummary)
  }, [])

  if (!s) return <div className="empty">Се вчитува…</div>

  const peak = Math.max(1, ...s.ordersPerDay.map((d) => d.orders))
  const topQty = Math.max(1, ...s.topDrinks.map((d) => d.qty))

  return (
    <>
      <div className="head">
        <div>
          <h2>Извештаи</h2>
          <p>Преглед на работата.</p>
        </div>
      </div>

      <div className="stats">
        <div className="stat gold">
          <div className="k">Промет од нарачки</div>
          <div className="v">{mkd(s.revenue.cashDeni)}</div>
          <div className="s">денари (без откажани)</div>
        </div>
        <div className="stat">
          <div className="k">Нарачки</div>
          <div className="v">{s.orders.total}</div>
          <div className="s">
            {s.orders.received} нови · {s.orders.fulfilled} завршени · {s.orders.cancelled} откажани
          </div>
        </div>
        <div className="stat crimson">
          <div className="k">Обврска по тикети</div>
          <div className="v">{mkd(s.tickets.outstandingDeni)}</div>
          <div className="s">{s.tickets.outstanding} неисплатени</div>
        </div>
        <div className="stat emerald">
          <div className="k">На картички</div>
          <div className="v">{mkd(s.cards.balanceDeni)}</div>
          <div className="s">
            {s.cards.n} картички · {s.activeSessions} активни сесии
          </div>
        </div>
      </div>

      <div className="split">
        <div className="card">
          <h3>Нарачки по ден (30 дена)</h3>
          {s.ordersPerDay.length === 0 ? (
            <div className="muted">Сè уште нема податоци.</div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 5, height: 150, marginTop: 8 }}>
              {s.ordersPerDay.map((d) => (
                <div key={d.day} style={{ flex: 1, textAlign: 'center' }} title={`${d.day}: ${d.orders}`}>
                  <div
                    style={{
                      height: `${(d.orders / peak) * 120}px`,
                      background: 'linear-gradient(180deg, var(--gold-bright), rgba(212,175,55,0.25))',
                      borderRadius: '2px 2px 0 0',
                      minHeight: 3
                    }}
                  />
                  <div className="mono muted" style={{ fontSize: 9, marginTop: 5 }}>
                    {d.day.slice(8)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="card">
          <h3>Најбарани пијалаци</h3>
          {s.topDrinks.length === 0 ? (
            <div className="muted">Сè уште нема податоци.</div>
          ) : (
            <div className="stack" style={{ gap: 9 }}>
              {s.topDrinks.map((d) => (
                <div key={d.name}>
                  <div className="row" style={{ justifyContent: 'space-between', marginBottom: 3 }}>
                    <span style={{ fontSize: 13, fontWeight: 600 }}>{d.name}</span>
                    <span className="mono muted" style={{ fontSize: 12 }}>
                      {d.qty}
                    </span>
                  </div>
                  <div style={{ height: 5, background: 'var(--surface-3)', borderRadius: 3 }}>
                    <div
                      style={{
                        width: `${(d.qty / topQty) * 100}%`,
                        height: '100%',
                        background: 'var(--gold)',
                        borderRadius: 3
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  )
}
