import { useEffect, useState } from 'react'
import { api, type StaffUser } from './api'
import { Menu } from './views/Menu'
import { Orders } from './views/Orders'
import { Players } from './views/Players'
import { Reports } from './views/Reports'
import { Tickets } from './views/Tickets'

type Tab = 'orders' | 'menu' | 'players' | 'tickets' | 'reports'

const TABS: Array<{ key: Tab; label: string; adminOnly?: boolean }> = [
  { key: 'orders', label: 'Нарачки' },
  { key: 'menu', label: 'Мени' },
  { key: 'players', label: 'Гости' },
  { key: 'tickets', label: 'Тикети' },
  { key: 'reports', label: 'Извештаи' }
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

export function App() {
  const [user, setUser] = useState<StaffUser | null>(null)
  const [ready, setReady] = useState(false)
  const [tab, setTab] = useState<Tab>('orders')
  const [pending, setPending] = useState(0)

  useEffect(() => {
    api
      .me()
      .then(setUser)
      .catch(() => setUser(null))
      .finally(() => setReady(true))
  }, [])

  // New orders should be visible from any tab.
  useEffect(() => {
    if (!user) return
    const tick = () => void api.orders('received').then((o) => setPending(o.length))
    tick()
    const t = setInterval(tick, 8000)
    return () => clearInterval(t)
  }, [user, tab])

  if (!ready) return null
  if (!user) return <Login onIn={setUser} />

  const isAdmin = user.role === 'admin'

  return (
    <div className="shell">
      <nav className="rail">
        <div className="brand">
          <h1>CMS</h1>
          <small>Шалтер</small>
        </div>

        <div className="nav">
          {TABS.filter((t) => !t.adminOnly || isAdmin).map((t) => (
            <button key={t.key} className={tab === t.key ? 'on' : ''} onClick={() => setTab(t.key)}>
              <span>{t.label}</span>
              {t.key === 'orders' && pending > 0 && <span className="count">{pending}</span>}
            </button>
          ))}
        </div>

        <div className="rail-foot">
          <div style={{ fontWeight: 600 }}>{user.username}</div>
          <div className="muted" style={{ fontSize: 11, marginBottom: 10 }}>
            {isAdmin ? 'администратор' : 'персонал'}
          </div>
          <button
            className="ghost"
            style={{ width: '100%' }}
            onClick={async () => {
              await api.logout()
              setUser(null)
            }}
          >
            Одјави се
          </button>
        </div>
      </nav>

      <main className="main">
        {tab === 'orders' && <Orders onCount={setPending} />}
        {tab === 'menu' && <Menu isAdmin={isAdmin} />}
        {tab === 'players' && <Players isAdmin={isAdmin} />}
        {tab === 'tickets' && <Tickets isAdmin={isAdmin} />}
        {tab === 'reports' && <Reports />}
      </main>
    </div>
  )
}
