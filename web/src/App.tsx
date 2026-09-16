import { useEffect, useState } from 'react'
import {
  BrowserRouter,
  NavLink,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate
} from 'react-router-dom'
import { api, type StaffRole, type StaffUser } from './api'
import { ROLE_MK } from './roles'
import { BarOrders } from './views/BarOrders'
import { Users } from './views/Users'
import { GuestProfile } from './views/GuestProfile'
import { Guests } from './views/Guests'
import { Machines } from './views/Machines'
import {
  MachineMeters,
  MachineOrders,
  MachineOverview,
  MachineProfile,
  MachineSessions,
  MachineTickets
} from './views/MachineProfile'
import { Menu } from './views/Menu'
import { Orders } from './views/Orders'
import { Pos } from './views/Pos'
import { Reports } from './views/Reports'
import { Settings } from './views/Settings'
import { Tickets } from './views/Tickets'
import { Audit } from './views/guest/Audit'
import { Cards } from './views/guest/Cards'
import { Money } from './views/guest/Money'
import { Notes } from './views/guest/Notes'
import { Osint } from './views/guest/Osint'
import { Overview } from './views/guest/Overview'
import { Visits } from './views/guest/Visits'

/** No `roles` means every role. The server enforces the same shape. */
const TABS: Array<{ path: string; label: string; roles?: StaffRole[] }> = [
  { path: '/orders', label: 'Нарачки' },
  { path: '/pos', label: 'Каса', roles: ['admin', 'staff'] },
  { path: '/menu', label: 'Мени' },
  { path: '/guests', label: 'Гости', roles: ['admin', 'staff'] },
  { path: '/tickets', label: 'Тикети', roles: ['admin', 'staff'] },
  { path: '/reports', label: 'Извештаи', roles: ['admin', 'staff'] },
  { path: '/machines', label: 'Машини', roles: ['admin'] },
  { path: '/users', label: 'Корисници', roles: ['admin'] }
]

function Login({ onIn }: { onIn: (u: StaffUser) => void }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setErr('')
    try {
      onIn(await api.login(username, password))
    } catch {
      setErr('Погрешно корисничко име или лозинка.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login-wrap">
      <form className="login" onSubmit={submit}>
        <h1>CMS</h1>
        <div className="sub">Шалтер · персонал</div>
        <div className="err">{err}</div>
        <div className="field">
          <label>Корисник</label>
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus required />
        </div>
        <div className="field">
          <label>Лозинка</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>
        <button className="gold" type="submit" disabled={busy} style={{ width: '100%', marginTop: 6 }}>
          {busy ? 'Се најавува…' : 'Најави се'}
        </button>
      </form>
    </div>
  )
}

function Shell({ user, onOut }: { user: StaffUser; onOut: () => void }) {
  const [pending, setPending] = useState(0)
  const [navOpen, setNavOpen] = useState(false)
  // Reported up by the board, because its status now shows in the topbar.
  const [live, setLive] = useState(false)
  const location = useLocation()
  const navigate = useNavigate()

  // New orders should be visible from any tab.
  useEffect(() => {
    const tick = () => void api.orders('received').then((o) => setPending(o.length)).catch(() => {})
    tick()
    const t = setInterval(tick, 8000)
    return () => clearInterval(t)
  }, [location.pathname])

  useEffect(() => {
    if (!navOpen) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setNavOpen(false)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [navOpen])

  // Navigating away closes the drawer, wherever the navigation came from.
  useEffect(() => setNavOpen(false), [location.pathname])

  const isAdmin = user.role === 'admin'
  // The bar tablet gets orders and the drink list; the server refuses the rest.
  const isBar = user.role === 'bar'

  // The POS tablet is handed to the customer, so it gets the screen to itself.
  const posFull = location.pathname.startsWith('/pos')

  // The kanban board wants the full width for its three columns, so the rail
  // becomes the burger drawer at every size — unlike Каса, which loses the
  // chrome entirely, the bar still needs a way back to Мени and Поставки.
  const boardFull = isBar && location.pathname.startsWith('/orders')

  return (
    <div className={`shell${posFull ? ' bare' : ''}${boardFull ? ' board' : ''}`}>
      {!posFull && (
        <header className="topbar">
          <button
            className="burger"
            aria-label="Мени"
            aria-expanded={navOpen}
            aria-controls="rail"
            onClick={() => setNavOpen((o) => !o)}
          >
            <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
              <g stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
                <path d="M3 5.5h14M3 10h14M3 14.5h14" />
              </g>
            </svg>
            {pending > 0 && !navOpen && <span className="count">{pending}</span>}
          </button>
          <div className="topbar-brand">CMS</div>
          {/* The board gives its whole height to the three columns, so what
              would have been its header rides here instead. */}
          {boardFull && (
            <>
              <span className="topbar-sep" aria-hidden="true">
                |
              </span>
              <span className="topbar-title">Активни нарачки</span>
              <span className="live topbar-live">
                <span className={`dot ${live ? '' : 'off'}`} />
                {live ? 'во живо' : 'без врска'}
              </span>
            </>
          )}
        </header>
      )}

      {!posFull && (
        <nav id="rail" className={navOpen ? 'rail open' : 'rail'}>
          <div className="brand">
            <h1>CMS</h1>
            <small>Шалтер</small>
          </div>

          <div className="nav">
            {TABS.filter((t) => !t.roles || t.roles.includes(user.role)).map((t) => (
              <NavLink key={t.path} to={t.path} className={({ isActive }) => (isActive ? 'on' : '')}>
                <span>{t.label}</span>
                {t.path === '/orders' && pending > 0 && <span className="count">{pending}</span>}
              </NavLink>
            ))}
          </div>

          <div className="rail-foot">
            <div className="who">
              <div>
                <div className="name">{user.username}</div>
                <div className="muted role">{ROLE_MK[user.role]}</div>
              </div>
              <NavLink
                to="/settings"
                className={({ isActive }) => (isActive ? 'icon-btn on' : 'icon-btn')}
                aria-label="Поставки"
                title="Поставки"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
                  <g
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.9"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <circle cx="12" cy="12" r="3.1" />
                    <path d="M19.2 14.4a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.56-1.1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1.03-1.56V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9a1.7 1.7 0 0 0 1.56 1.03H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.56 1.03z" />
                  </g>
                </svg>
              </NavLink>
            </div>
            <button
              className="ghost"
              style={{ width: '100%' }}
              onClick={async () => {
                await api.logout()
                onOut()
              }}
            >
              Одјави се
            </button>
          </div>
        </nav>
      )}

      {!posFull && navOpen && <div className="scrim" onClick={() => setNavOpen(false)} />}

      <main className="main">
        <Routes>
          <Route path="/" element={<Navigate to="/orders" replace />} />
          {/* The bar tablet works a kanban board; the desk keeps the card grid. */}
          <Route
            path="/orders"
            element={
              isBar ? (
                <BarOrders onCount={setPending} onLive={setLive} />
              ) : (
                <Orders onCount={setPending} />
              )
            }
          />
          {/* Everything the bar tablet is missing here is a 403 on the server
              too; this only hides the door. Menu stays: isAdmin=false already
              leaves it view-plus-restock, which is exactly the bar's share. */}
          {!isBar && <Route path="/pos" element={<Pos onExit={() => navigate('/orders')} />} />}
          <Route path="/menu" element={<Menu isAdmin={isAdmin} />} />
          {!isBar && <Route path="/guests" element={<Guests isAdmin={isAdmin} />} />}
          {!isBar && (
            <Route path="/guests/:id" element={<GuestProfile isAdmin={isAdmin} />}>
              <Route index element={<Overview isAdmin={isAdmin} />} />
              <Route path="money" element={<Money />} />
              <Route path="cards" element={<Cards isAdmin={isAdmin} />} />
              <Route path="visits" element={<Visits />} />
              <Route path="notes" element={<Notes isAdmin={isAdmin} />} />
              {isAdmin && <Route path="osint" element={<Osint />} />}
              {isAdmin && <Route path="audit" element={<Audit />} />}
            </Route>
          )}
          {!isBar && <Route path="/tickets" element={<Tickets isAdmin={isAdmin} />} />}
          {!isBar && <Route path="/reports" element={<Reports />} />}
          {isAdmin && (
            <>
              <Route path="/machines" element={<Machines />} />
              <Route path="/machines/:id" element={<MachineProfile />}>
                <Route index element={<MachineOverview />} />
                <Route path="sessions" element={<MachineSessions />} />
                <Route path="orders" element={<MachineOrders />} />
                <Route path="tickets" element={<MachineTickets />} />
                <Route path="meters" element={<MachineMeters />} />
              </Route>
            </>
          )}
          {isAdmin && <Route path="/users" element={<Users me={user} />} />}
          {/* Reached by the gear in the rail footer, so deliberately not in TABS. */}
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<Navigate to="/orders" replace />} />
        </Routes>
      </main>
    </div>
  )
}

export function App() {
  const [user, setUser] = useState<StaffUser | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    api
      .me()
      .then(setUser)
      .catch(() => setUser(null))
      .finally(() => setReady(true))
  }, [])

  if (!ready) return null
  if (!user) return <Login onIn={setUser} />

  return (
    <BrowserRouter>
      <Shell user={user} onOut={() => setUser(null)} />
    </BrowserRouter>
  )
}
