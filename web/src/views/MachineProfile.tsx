import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { NavLink, Outlet, useParams } from 'react-router-dom'
import {
  api,
  mkd,
  timeAgo,
  type Machine,
  type MachineOrder,
  type MachineSession,
  type MachineTicket
} from '../api'
import { Empty, Err, Monogram, Skeleton } from '../components/Bits'
import { fmtDateTime, fmtDuration, sqlMs } from '../format'
import { CLOSE_REASON_MK, MachineDot } from './machineBits'

interface Ctx {
  machine: Machine
  reload: () => Promise<void>
}

const MachineCtx = createContext<Ctx | null>(null)

function useMachine(): Ctx {
  const ctx = useContext(MachineCtx)
  if (!ctx) throw new Error('useMachine outside a machine route')
  return ctx
}

/**
 * One cabinet: what it is, what it is doing, and what has happened at it.
 *
 * Tabs are routes rather than local state so a shift lead can send a colleague
 * the link to a specific machine's ticket history, the same way the guest
 * dossier works.
 */
export function MachineProfile() {
  const { id = '' } = useParams()
  const [machine, setMachine] = useState<Machine | null>(null)
  const [err, setErr] = useState('')

  const reload = useCallback(async () => {
    setMachine(await api.machine(id))
  }, [id])

  useEffect(() => {
    void reload().catch((e) => setErr((e as Error).message))
  }, [reload])

  // The link decays to "без сигнал" with no event to announce it.
  useEffect(() => {
    const t = setInterval(() => void reload().catch(() => {}), 5000)
    return () => clearInterval(t)
  }, [reload])

  if (err) return <Err>{err}</Err>
  if (!machine) return <Skeleton rows={6} />

  const tabs = [
    { to: '', label: 'Преглед', end: true },
    { to: 'sessions', label: 'Сесии' },
    { to: 'orders', label: 'Нарачки' },
    { to: 'tickets', label: 'Тикети' },
    { to: 'meters', label: 'Мерачи' }
  ]

  return (
    <MachineCtx.Provider value={{ machine, reload }}>
      <NavLink to="/machines" className="back">
        ← Машини
      </NavLink>

      <header className="dossier">
        <Monogram id={machine.id} name={machine.label} big />
        <div className="dossier-id">
          <h2>{machine.label}</h2>
          <div className="dossier-meta mono">
            {machine.location ?? 'без место'} · {machine.host ?? 'без адреса'} ·{' '}
            {machine.device_id ?? 'непознат уред'}
            {machine.fw ? ` · fw ${machine.fw}` : ''}
          </div>
        </div>
        <div className="kpis">
          <MachineDot state={machine.state} parked={machine.status === 'out_of_service'} />
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
    </MachineCtx.Provider>
  )
}

export function MachineOverview() {
  const { machine } = useMachine()
  const link = machine.link

  return (
    <div className="split">
      <div className="card">
        <h3>Врска</h3>
        {link === null ? (
          <Empty
            title="Нема жива врска"
            hint="Кабината не е поврзана на 9020 во моментов."
          />
        ) : (
          <dl className="dl">
            <div className="dl-row">
              <dt className="dl-k">Адреса</dt>
              <dd className="dl-v mono">
                {link.host}:{link.port}
              </dd>
            </div>
            <div className="dl-row">
              <dt className="dl-k">Поврзана</dt>
              <dd className="dl-v">
                {fmtDateTime(link.connectedAt)} · {fmtDuration(secondsSince(link.connectedAt))}
              </dd>
            </div>
            <div className="dl-row">
              <dt className="dl-k">Последна порака</dt>
              <dd className="dl-v">
                {timeAgo(link.lastRxAt)} <span className="mono muted">{link.lastType ?? ''}</span>
              </dd>
            </div>
            <div className="dl-row">
              <dt className="dl-k">Пораки</dt>
              <dd className="dl-v num mono">{link.frames}</dd>
            </div>
            <div className="dl-row">
              <dt className="dl-k">Фирмвер</dt>
              <dd className="dl-v mono">
                {link.fw ?? '—'} · протокол {link.proto ?? '—'}
              </dd>
            </div>
          </dl>
        )}
      </div>

      <div className="card">
        <h3>Кабина</h3>
        <dl className="dl">
          <div className="dl-row">
            <dt className="dl-k">Состојба</dt>
            <dd className="dl-v">
              {machine.status === 'in_service' ? 'во употреба' : 'вон употреба'}
            </dd>
          </div>
          <div className="dl-row">
            <dt className="dl-k">Инвентарен</dt>
            <dd className="dl-v mono">{machine.asset_no ?? '—'}</dd>
          </div>
          <div className="dl-row">
            <dt className="dl-k">Сериски</dt>
            <dd className="dl-v mono">{machine.serial ?? '—'}</dd>
          </div>
          <div className="dl-row">
            <dt className="dl-k">Први пат видена</dt>
            <dd className="dl-v">{machine.first_seen ? fmtDateTime(machine.first_seen) : '—'}</dd>
          </div>
          <div className="dl-row">
            <dt className="dl-k">Поврзувања</dt>
            <dd className="dl-v num mono">{machine.connects}</dd>
          </div>
        </dl>
        {machine.notes && <p className="muted">{machine.notes}</p>}
      </div>
    </div>
  )
}

/** fmtDuration counts in seconds, not milliseconds. */
function secondsSince(sqlTime: string): number {
  return (Date.now() - sqlMs(sqlTime)) / 1000
}

/** Every tab below is the same read-only shape: load once, tri-state, table. */
function usePanel<T>(load: () => Promise<T[]>) {
  const [rows, setRows] = useState<T[] | null>(null)
  const [err, setErr] = useState('')
  useEffect(() => {
    void load()
      .then(setRows)
      .catch((e) => setErr((e as Error).message))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return { rows, err }
}

export function MachineSessions() {
  const { machine } = useMachine()
  const { rows, err } = usePanel<MachineSession>(() =>
    api.machineSessions(machine.id).then((r) => r.sessions)
  )

  return (
    <div className="card scroll">
      <h3>Сесии</h3>
      <p className="muted">Кој се пријавил на оваа кабина. Отворените сесии се први.</p>
      <Err>{err}</Err>
      {rows === null ? (
        <Skeleton rows={5} />
      ) : rows.length === 0 ? (
        <Empty
          title="Нема сесии"
          hint="Сесиите се врзуваат за машина од моментот кога таа е регистрирана."
        />
      ) : (
        <table className="rows">
          <thead>
            <tr>
              <th>Гостин</th>
              <th>Од</th>
              <th>Траење</th>
              <th>Состојба</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s, i) => (
              <tr key={s.sid} style={{ '--i': Math.min(i, 12) } as React.CSSProperties}>
                <td>{s.player_name}</td>
                <td>{fmtDateTime(s.opened_at)}</td>
                <td className="mono">
                  {fmtDuration(
                    ((s.closed_at ? sqlMs(s.closed_at) : Date.now()) - sqlMs(s.opened_at)) / 1000
                  )}
                </td>
                <td>
                  {s.closed_at === null ? (
                    <span className="tag active">отворена</span>
                  ) : (
                    <span className="muted">
                      {s.close_reason
                        ? (CLOSE_REASON_MK[s.close_reason] ?? s.close_reason)
                        : 'затворена'}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

export function MachineOrders() {
  const { machine } = useMachine()
  const { rows, err } = usePanel<MachineOrder>(() =>
    api.machineOrders(machine.id).then((r) => r.orders)
  )

  return (
    <div className="card scroll">
      <h3>Нарачки</h3>
      <p className="muted">Пијалаци нарачани од терминалот на оваа кабина.</p>
      <Err>{err}</Err>
      {rows === null ? (
        <Skeleton rows={5} />
      ) : rows.length === 0 ? (
        <Empty title="Нема нарачки" hint="Нарачките се врзуваат преку сесијата на гостинот." />
      ) : (
        <table className="rows">
          <thead>
            <tr>
              <th>#</th>
              <th>Гостин</th>
              <th>Кога</th>
              <th className="num">Износ</th>
              <th>Состојба</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((o, i) => (
              <tr key={o.id} style={{ '--i': Math.min(i, 12) } as React.CSSProperties}>
                <td className="mono">{o.number}</td>
                <td>{o.player_name}</td>
                <td>{fmtDateTime(o.created_at)}</td>
                <td className="num money">
                  {o.pay_method === 'points' ? `${o.total_points} п.` : mkd(o.total_deni)}
                </td>
                <td>
                  <span className={`tag ${o.status}`}>{o.status}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

export function MachineTickets() {
  const { machine } = useMachine()
  const { rows, err } = usePanel<MachineTicket>(() =>
    api.machineTickets(machine.id).then((r) => r.tickets)
  )

  return (
    <div className="card scroll">
      <h3>Тикети</h3>
      <p className="muted">
        TITO тикети издадени од оваа кабина. Врската се прави според адресата од која слот играта
        го повикува легацискиот API — значи е показател, не доказ.
      </p>
      <Err>{err}</Err>
      {rows === null ? (
        <Skeleton rows={5} />
      ) : rows.length === 0 ? (
        <Empty
          title="Нема тикети"
          hint="Тикетите се врзуваат за машина дури откако таа е регистрирана со адреса."
        />
      ) : (
        <table className="rows">
          <thead>
            <tr>
              <th>Тикет</th>
              <th className="num">Износ</th>
              <th>Издаден</th>
              <th>Состојба</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t, i) => (
              <tr key={t.id} style={{ '--i': Math.min(i, 12) } as React.CSSProperties}>
                <td className="mono">{t.id}</td>
                <td className="num money">{mkd(t.amount_deni)}</td>
                <td>{fmtDateTime(t.created_at)}</td>
                <td>
                  <span className={`tag ${t.status}`}>{t.status}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

/**
 * Deliberately empty.
 *
 * The EGM does keep SAS meters (coin in, coin out, drop, games played) and the
 * SMIB does poll them — but it never forwards them, and the CMS protocol carries
 * no meter message at all. Showing a number here would mean inventing one, so
 * the panel states the position instead and holds the place for the phase that
 * adds the meter upload.
 */
export function MachineMeters() {
  return (
    <div className="card">
      <h3>Мерачи</h3>
      <Empty
        title="Мерачите сè уште не стигнуваат до CMS"
        hint="Кабината ги брои игрите и парите преку SAS, но SMIB-от не ги праќа натаму — за тоа е потребна засебна фаза со пренос на состојбата од мерачите. Тука намерно не стои проценка."
      />
    </div>
  )
}
