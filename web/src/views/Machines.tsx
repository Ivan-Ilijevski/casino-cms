import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, type Machine, type MachineInput, type TerminalLink } from '../api'
import { Empty, Err, Monogram, Skeleton } from '../components/Bits'
import { ConfirmDialog, Dialog } from '../components/Dialog'
import { fmtDateTime } from '../format'
import { LINK_STATE_MK, MachineDot } from './machineBits'

/**
 * Slot machines. Admin-only on the server too; this only hides the door.
 *
 * Two lists, because a cabinet can be in either without being in the other. The
 * registry is what the venue owns and named; below it sit live sockets that
 * matched no machine — a cabinet plugged in and waiting to be named. That second
 * list IS the onboarding flow, which is why it is not tucked away in a dialog.
 *
 * There is no delete: sessions, orders and tickets are attributed to a machine,
 * so a removed row would orphan that history. "Вон употреба" is the off switch,
 * and it is advisory — nothing on the wire reads it.
 */
export function Machines() {
  const navigate = useNavigate()
  const [rows, setRows] = useState<Machine[] | null>(null)
  const [links, setLinks] = useState<TerminalLink[]>([])
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [live, setLive] = useState(false)
  const [creating, setCreating] = useState(false)
  const [adopting, setAdopting] = useState<TerminalLink | null>(null)
  const [confirming, setConfirming] = useState<{ machine: Machine; kind: 'logout' | 'drop' } | null>(
    null
  )

  const load = useCallback(async () => {
    const [machines, linkList] = await Promise.all([api.machines(), api.machineLinks()])
    setRows(machines.machines)
    setLinks(linkList.links)
  }, [])

  useEffect(() => {
    void load().catch((e) => setErr((e as Error).message))
  }, [load])

  // Connect/disconnect arrives over SSE, the same feed shape the bar screen uses.
  useEffect(() => {
    const source = new EventSource('/api/machines/events')
    source.onopen = () => setLive(true)
    source.onerror = () => setLive(false)
    const refresh = () => void load().catch(() => {})
    source.addEventListener('machine.connected', refresh)
    source.addEventListener('machine.disconnected', refresh)
    source.addEventListener('machine.updated', refresh)
    return () => source.close()
  }, [load])

  /**
   * A link goes quiet without any event firing — the socket stays open, the pings
   * simply stop. Re-render on a timer so "онлајн" decays to "без сигнал" on its
   * own; the server decides the state, this only asks again.
   */
  useEffect(() => {
    const t = setInterval(() => void load().catch(() => {}), 5000)
    return () => clearInterval(t)
  }, [load])

  async function run(action: () => Promise<unknown>) {
    setBusy(true)
    setErr('')
    try {
      await action()
      await load()
      return true
    } catch (e) {
      setErr((e as Error).message)
      return false
    } finally {
      setBusy(false)
    }
  }

  const unregistered = links.filter((l) => l.machineId === null)
  const counted = rows?.filter((m) => m.status === 'in_service') ?? []
  const stats = {
    total: rows?.length ?? 0,
    online: counted.filter((m) => m.state === 'online').length,
    silent: counted.filter((m) => m.state === 'silent').length,
    offline: counted.filter((m) => m.state === 'offline').length,
    parked: rows?.filter((m) => m.status === 'out_of_service').length ?? 0
  }

  return (
    <>
      <div className="head">
        <div>
          <h2>Слот машини</h2>
          <p>Врска, играч и историја по кабина. Мерачите сè уште не стигнуваат до CMS.</p>
        </div>
        <div className="toolbar">
          <span className="live">
            <span className={`dot ${live ? '' : 'off'}`} />
            {live ? 'во живо' : 'без врска'}
          </span>
          <button className="gold" onClick={() => setCreating(true)}>
            Нова машина
          </button>
        </div>
      </div>

      <Err>{err}</Err>

      <div className="stats">
        <div className="stat">
          <div className="k">Вкупно</div>
          <div className="v">{stats.total}</div>
          <div className="s">регистрирани кабини</div>
        </div>
        <div className="stat emerald">
          <div className="k">Онлајн</div>
          <div className="v">{stats.online}</div>
          <div className="s">јавуваат во последните 6с</div>
        </div>
        <div className="stat crimson">
          <div className="k">Без сигнал</div>
          <div className="v">{stats.silent + stats.offline}</div>
          <div className="s">{stats.silent} тивки · {stats.offline} офлајн</div>
        </div>
        <div className="stat">
          <div className="k">Вон употреба</div>
          <div className="v">{stats.parked}</div>
          <div className="s">не се сметаат за дефект</div>
        </div>
      </div>

      {unregistered.length > 0 && (
        <div className="card scroll m-adopt">
          <div className="card-head">
            <h3>Непријавени врски · {unregistered.length}</h3>
          </div>
          <p className="muted">
            Овие терминали се јавуваат, но не одговараат на ниту една машина. Пријави ја врската
            за да добие име — адресата и уредот се земаат од самата врска.
          </p>
          <table className="rows">
            <thead>
              <tr>
                <th>Адреса</th>
                <th>Уред</th>
                <th>Фирмвер</th>
                <th>Поврзан</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {unregistered.map((l, i) => (
                <tr key={l.connId} style={{ '--i': Math.min(i, 12) } as React.CSSProperties}>
                  <td className="mono">{l.host ?? '—'}</td>
                  <td className="mono">{l.deviceId ?? '—'}</td>
                  <td className="mono">{l.fw ?? '—'}</td>
                  <td>{fmtDateTime(l.connectedAt)}</td>
                  <td className="num">
                    <button className="gold" onClick={() => setAdopting(l)}>
                      Пријави
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="card scroll">
        <div className="card-head">
          <h3>{rows === null ? 'Машини' : `Машини · ${rows.length}`}</h3>
        </div>

        {rows === null ? (
          <Skeleton rows={4} />
        ) : rows.length === 0 ? (
          <Empty
            title="Нема регистрирани машини"
            hint="Штом кабина се поврзе, ќе се појави горе како непријавена врска."
          />
        ) : (
          <table className="rows">
            <thead>
              <tr>
                <th>Машина</th>
                <th>Состојба</th>
                <th>Адреса</th>
                <th>Играч</th>
                <th>Последно јавување</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((m, i) => (
                <tr
                  key={m.id}
                  className={m.status === 'out_of_service' ? 'm-parked' : undefined}
                  style={{ '--i': Math.min(i, 12) } as React.CSSProperties}
                >
                  <td>
                    <div className="m-name">
                      <Monogram id={m.id} name={m.label} />
                      <div>
                        <button className="linkish" onClick={() => navigate(`/machines/${m.id}`)}>
                          {m.label}
                        </button>
                        <div className="muted">{m.location ?? '—'}</div>
                      </div>
                    </div>
                  </td>
                  <td>
                    <MachineDot state={m.state} parked={m.status === 'out_of_service'} />
                  </td>
                  <td className="mono">{m.host ?? '—'}</td>
                  <td>
                    {m.players.length === 0 ? (
                      <span className="muted">—</span>
                    ) : (
                      m.players.map((p) => p.name).join(', ')
                    )}
                  </td>
                  <td>{m.last_seen ? fmtDateTime(m.last_seen) : <span className="muted">—</span>}</td>
                  <td className="num m-actions">
                    <button
                      className="ghost"
                      disabled={busy || m.players.length === 0}
                      onClick={() => setConfirming({ machine: m, kind: 'logout' })}
                    >
                      Одјави играч
                    </button>
                    <button
                      className="ghost"
                      disabled={busy || m.link === null}
                      onClick={() => setConfirming({ machine: m, kind: 'drop' })}
                    >
                      Прекини врска
                    </button>
                    <button
                      className="ghost"
                      disabled={busy}
                      onClick={() =>
                        void run(() =>
                          api.setMachineStatus(
                            m.id,
                            m.status === 'in_service' ? 'out_of_service' : 'in_service'
                          )
                        )
                      }
                    >
                      {m.status === 'in_service' ? 'Вон употреба' : 'Врати'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {creating && (
        <MachineDialog
          title="Нова машина"
          busy={busy}
          onClose={() => setCreating(false)}
          onSave={async (input) => {
            if (await run(() => api.createMachine(input))) setCreating(false)
          }}
        />
      )}

      {adopting && (
        <MachineDialog
          title="Пријави ја врската"
          sub={`${adopting.host ?? 'непозната адреса'} · ${adopting.deviceId ?? 'непознат уред'}`}
          busy={busy}
          lockHost
          onClose={() => setAdopting(null)}
          onSave={async ({ label, location, asset_no, serial, notes }) => {
            const ok = await run(() =>
              api.adoptMachine(adopting.connId, { label, location, asset_no, serial, notes })
            )
            if (ok) setAdopting(null)
          }}
        />
      )}

      {confirming && (
        <ConfirmDialog
          title={confirming.kind === 'logout' ? 'Одјави го играчот?' : 'Прекини ја врската?'}
          body={
            confirming.kind === 'logout' ? (
              <>
                Терминалот на <strong>{confirming.machine.label}</strong> ќе се врати на почетниот
                екран и сесијата се затвора.
              </>
            ) : (
              <>
                Врската со <strong>{confirming.machine.label}</strong> се прекинува. Терминалот се
                поврзува сам по околу 2 секунди — ова не ја гаси машината.
              </>
            )
          }
          confirmLabel={confirming.kind === 'logout' ? 'Одјави' : 'Прекини'}
          danger
          busy={busy}
          onClose={() => setConfirming(null)}
          onConfirm={() => {
            const { machine, kind } = confirming
            void run(() =>
              kind === 'logout' ? api.logoutMachine(machine.id) : api.dropMachineLink(machine.id)
            ).then(() => setConfirming(null))
          }}
        />
      )}
    </>
  )
}

/** Create and adopt share every field; adopting just cannot choose the address. */
function MachineDialog({
  title,
  sub,
  busy,
  lockHost,
  initial,
  onSave,
  onClose
}: {
  title: string
  sub?: string
  busy: boolean
  lockHost?: boolean
  initial?: Partial<MachineInput>
  onSave: (input: MachineInput) => void
  onClose: () => void
}) {
  const [label, setLabel] = useState(initial?.label ?? '')
  const [host, setHost] = useState(initial?.host ?? '')
  const [location, setLocation] = useState(initial?.location ?? '')
  const [assetNo, setAssetNo] = useState(initial?.asset_no ?? '')
  const [serial, setSerial] = useState(initial?.serial ?? '')
  const [notes, setNotes] = useState(initial?.notes ?? '')

  const valid = label.trim() !== ''

  return (
    <Dialog
      title={title}
      sub={sub}
      onClose={onClose}
      footer={
        <>
          <button className="ghost" onClick={onClose}>
            Откажи
          </button>
          <button
            className="gold"
            disabled={!valid || busy}
            onClick={() =>
              onSave({
                label: label.trim(),
                host: lockHost ? undefined : host.trim() || null,
                location: location.trim() || null,
                asset_no: assetNo.trim() || null,
                serial: serial.trim() || null,
                notes: notes.trim() || null
              })
            }
          >
            {busy ? 'Се зачувува…' : 'Зачувај'}
          </button>
        </>
      }
    >
      <div className="field">
        <label htmlFor="m-label">Име</label>
        <input
          id="m-label"
          value={label}
          autoFocus
          placeholder="Shining Crown 01"
          onChange={(e) => setLabel(e.target.value)}
        />
      </div>

      {!lockHost && (
        <div className="field">
          <label htmlFor="m-host">Адреса</label>
          <input
            id="m-host"
            className="mono"
            value={host ?? ''}
            placeholder="192.168.1.7"
            onChange={(e) => setHost(e.target.value)}
          />
          <div className="hint">
            IP-адресата на слот компјутерот. Ова е она по што се препознава кабината — уредот се
            јавува како „smib-1“ на сите машини.
          </div>
        </div>
      )}

      <div className="field">
        <label htmlFor="m-loc">Место</label>
        <input
          id="m-loc"
          value={location ?? ''}
          placeholder="Десен ред, до шанкот"
          onChange={(e) => setLocation(e.target.value)}
        />
      </div>

      <div className="row">
        <div className="field">
          <label htmlFor="m-asset">Инвентарен број</label>
          <input
            id="m-asset"
            className="mono"
            value={assetNo ?? ''}
            onChange={(e) => setAssetNo(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="m-serial">Сериски број</label>
          <input
            id="m-serial"
            className="mono"
            value={serial ?? ''}
            onChange={(e) => setSerial(e.target.value)}
          />
        </div>
      </div>

      <div className="field">
        <label htmlFor="m-notes">Белешка</label>
        <input id="m-notes" value={notes ?? ''} onChange={(e) => setNotes(e.target.value)} />
      </div>
    </Dialog>
  )
}
