import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { NavLink, Outlet, useParams } from 'react-router-dom'
import { api, mkd, timeAgo, type Customer } from '../api'
import { Chip, Err, Monogram, Skeleton, tagLabel } from '../components/Bits'
import { fmtDate, fmtDuration } from '../format'

interface Ctx {
  customer: Customer
  isAdmin: boolean
  reload: () => Promise<void>
}

const GuestCtx = createContext<Ctx | null>(null)

/** Every tab reads the guest from here rather than refetching the header. */
export function useGuest(): Ctx {
  const ctx = useContext(GuestCtx)
  if (!ctx) throw new Error('useGuest outside a guest route')
  return ctx
}

/** Tags that mean "stop and read this before serving them". */
const ALARMS: Record<string, string> = {
  self_excluded: 'Гостинот побарал самоисклучување. Не служете и не примајте уплата.',
  sanctions_hit: 'Позитивен погодок на санкциска листа. Известете го раководителот.',
  watchlist: 'Гостинот е на набљудување — забележете сè невообичаено.'
}

export function GuestProfile({ isAdmin }: { isAdmin: boolean }) {
  const { id = '' } = useParams()
  const [customer, setCustomer] = useState<Customer | null>(null)
  const [err, setErr] = useState('')

  const reload = useCallback(async () => {
    try {
      setCustomer(await api.customer(id))
      setErr('')
    } catch (e) {
      setErr((e as Error).message)
    }
  }, [id])

  useEffect(() => {
    setCustomer(null)
    void reload()
  }, [reload])

  if (err) return <Err>{err}</Err>
  if (!customer) return <Skeleton rows={8} />

  const { player, cards, tags, stats, session } = customer
  const balance = cards.reduce((n, c) => n + c.balance_deni, 0)
  const points = cards.reduce((n, c) => n + c.points, 0)
  const alarm = Object.keys(ALARMS).find((t) => tags.includes(t))

  const tabs = [
    { to: '.', end: true, label: 'Преглед' },
    { to: 'money', label: 'Пари' },
    { to: 'cards', label: `Картички · ${cards.length}` },
    { to: 'visits', label: 'Посети' },
    { to: 'notes', label: 'Белешки' },
    ...(isAdmin ? [{ to: 'osint', label: 'Истражување' }] : []),
    ...(isAdmin ? [{ to: 'audit', label: 'Дневник' }] : [])
  ]

  return (
    <GuestCtx.Provider value={{ customer, isAdmin, reload }}>
      <NavLink to="/guests" className="back">
        ← Сите гости
      </NavLink>

      {alarm && (
        <div className="risk-banner">
          <strong>{tagLabel(alarm)}</strong>
          <span>{ALARMS[alarm]}</span>
        </div>
      )}

      <header className="dossier">
        <Monogram id={player.id} name={player.name} big />
        <div className="dossier-id">
          <h2>{player.name}</h2>
          <div className="dossier-meta mono">
            ГОСТ · {player.id.slice(0, 8)} · регистриран {fmtDate(player.created_at)}
          </div>
          <div className="chips">
            {session && (
              <span className="live">
                <span className="dot" /> на машина {timeAgo(session.opened_at)}
              </span>
            )}
            {tags.map((t) => (
              <Chip key={t} tag={t} />
            ))}
          </div>
        </div>

        <div className="kpis">
          <div className="stat gold" style={{ '--i': 0 } as React.CSSProperties}>
            <div className="k">Состојба</div>
            <div className="v">{mkd(balance)}</div>
            <div className="s">низ {cards.length} картич{cards.length === 1 ? 'ка' : 'ки'}</div>
          </div>
          <div className="stat" style={{ '--i': 1 } as React.CSSProperties}>
            <div className="k">Поени</div>
            <div className="v">{points}</div>
            <div className="s">освоени {stats.points_earned}</div>
          </div>
          <div className="stat emerald" style={{ '--i': 2 } as React.CSSProperties}>
            <div className="k">Животен промет</div>
            <div className="v">{mkd(stats.lifetime_out_deni)}</div>
            <div className="s">исплатено {mkd(stats.lifetime_in_deni)}</div>
          </div>
          <div className="stat" style={{ '--i': 3 } as React.CSSProperties}>
            <div className="k">Посети</div>
            <div className="v">{stats.visits}</div>
            <div className="s">
              {stats.last_seen ? timeAgo(stats.last_seen) : 'нема'}
              {stats.avg_visit_seconds ? ` · просек ${fmtDuration(stats.avg_visit_seconds)}` : ''}
            </div>
          </div>
        </div>
      </header>

      <nav className="tabs">
        {tabs.map((t) => (
          <NavLink
            key={t.to}
            to={t.to}
            end={t.end}
            className={({ isActive }) => (isActive ? 'tab on' : 'tab')}
          >
            {t.label}
          </NavLink>
        ))}
      </nav>

      <Outlet />
    </GuestCtx.Provider>
  )
}
