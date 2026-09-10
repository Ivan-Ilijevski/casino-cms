import { useEffect, useState } from 'react'
import { api, type StaffAccount, type StaffRole, type StaffUser } from '../api'
import { Empty, Err, Skeleton } from '../components/Bits'
import { ConfirmDialog, Dialog } from '../components/Dialog'
import { fmtDate } from '../format'
import { ROLE_HINT_MK, ROLE_MK, ROLE_OPTIONS } from '../roles'

const MIN_PASSWORD = 8

/**
 * Staff accounts. Admin-only on the server too; this only hides the door.
 *
 * There is no delete on purpose: the audit trail records who did what by
 * username, so accounts are switched off rather than removed.
 */
export function Users({ me }: { me: StaffUser }) {
  const [rows, setRows] = useState<StaffAccount[] | null>(null)
  const [err, setErr] = useState('')
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<StaffAccount | null>(null)
  const [confirming, setConfirming] = useState<StaffAccount | null>(null)
  const [busy, setBusy] = useState(false)

  async function load() {
    const res = await api.users()
    setRows(res.users)
  }

  useEffect(() => {
    void load().catch((e) => setErr((e as Error).message))
  }, [])

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

  return (
    <>
      <div className="head">
        <div>
          <h2>Корисници</h2>
          <p>Сметки за персоналот и за таблетите. Сметките се исклучуваат, не се бришат.</p>
        </div>
      </div>

      <Err>{err}</Err>

      <div className="card scroll">
        <div className="card-head">
          <h3>{rows === null ? 'Корисници' : `Корисници · ${rows.length}`}</h3>
          <button className="gold" onClick={() => setCreating(true)}>
            Нов корисник
          </button>
        </div>

        {rows === null ? (
          <Skeleton rows={4} />
        ) : rows.length === 0 ? (
          <Empty title="Нема корисници" />
        ) : (
          <table className="rows">
            <thead>
              <tr>
                <th>Корисник</th>
                <th>Улога</th>
                <th>Статус</th>
                <th>Создаден</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((u, i) => (
                <tr key={u.id} style={{ '--i': Math.min(i, 12) } as React.CSSProperties}>
                  <td>
                    {/* A button, not a row onClick: one tab stop, and the whole
                        name is the target on a touchscreen. */}
                    <button type="button" className="linkish" onClick={() => setEditing(u)}>
                      {u.username}
                    </button>
                    {u.id === me.id && <span className="muted"> (вие)</span>}
                  </td>
                  <td className="muted">{ROLE_MK[u.role]}</td>
                  <td>
                    <span className={u.active === 1 ? 'tag active' : 'tag blocked'}>
                      {u.active === 1 ? 'активен' : 'неактивен'}
                    </span>
                  </td>
                  <td className="muted">{fmtDate(u.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {creating && (
        <CreateDialog
          busy={busy}
          onClose={() => setCreating(false)}
          onCreate={async (draft) => {
            if (await run(() => api.createUser(draft))) setCreating(false)
          }}
        />
      )}

      {editing && (
        <EditDialog
          user={editing}
          isSelf={editing.id === me.id}
          busy={busy}
          onClose={() => setEditing(null)}
          onSave={async (patch) => {
            if (await run(() => api.updateUser(editing.id, patch))) setEditing(null)
          }}
          onResetPassword={async (password) => {
            return run(() => api.setUserPassword(editing.id, password))
          }}
          onToggleActive={() => {
            if (editing.active === 1) {
              setConfirming(editing)
            } else {
              void run(() => api.updateUser(editing.id, { active: true })).then(
                (ok) => ok && setEditing(null)
              )
            }
          }}
        />
      )}

      {confirming && (
        <ConfirmDialog
          title="Деактивирај го корисникот?"
          body={
            <p>
              <strong>{confirming.username}</strong> веднаш нема да може да се најави и
              отворените сесии престануваат при следното барање. Сметката останува во
              историјата и може да се врати.
            </p>
          }
          confirmLabel="Деактивирај"
          danger
          busy={busy}
          onClose={() => setConfirming(null)}
          onConfirm={async () => {
            if (await run(() => api.updateUser(confirming.id, { active: false }))) {
              setConfirming(null)
              setEditing(null)
            }
          }}
        />
      )}
    </>
  )
}

function RoleField({
  value,
  disabled,
  onChange
}: {
  value: StaffRole
  disabled?: boolean
  onChange: (role: StaffRole) => void
}) {
  return (
    <div className="field">
      <label htmlFor="role">Улога</label>
      <select
        id="role"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value as StaffRole)}
      >
        {ROLE_OPTIONS.map((r) => (
          <option key={r} value={r}>
            {ROLE_MK[r]}
          </option>
        ))}
      </select>
      <div className="hint">{ROLE_HINT_MK[value]}</div>
    </div>
  )
}

function CreateDialog({
  busy,
  onClose,
  onCreate
}: {
  busy: boolean
  onClose: () => void
  onCreate: (draft: { username: string; password: string; role: StaffRole }) => void
}) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState<StaffRole>('staff')

  const valid = /^[a-z0-9._-]{3,32}$/.test(username) && password.length >= MIN_PASSWORD

  return (
    <Dialog
      title="Нов корисник"
      sub="Лозинката се внесува сега и корисникот може да ја смени во Поставки."
      onClose={onClose}
      footer={
        <>
          <button type="button" className="ghost" onClick={onClose}>
            Откажи
          </button>
          <button
            type="button"
            className="gold"
            disabled={!valid || busy}
            onClick={() => onCreate({ username, password, role })}
          >
            {busy ? 'Се создава…' : 'Создај'}
          </button>
        </>
      }
    >
      <div className="field">
        <label htmlFor="new-username">Корисничко име</label>
        <input
          id="new-username"
          value={username}
          autoCapitalize="none"
          autoCorrect="off"
          placeholder="sank.tablet"
          onChange={(e) => setUsername(e.target.value.toLowerCase())}
        />
        <div className="hint">Мали букви, бројки, точка, долна црта или цртичка. 3–32 знаци.</div>
      </div>

      <RoleField value={role} onChange={setRole} />

      <div className="field">
        <label htmlFor="new-password">Лозинка</label>
        <input
          id="new-password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <div className="hint">Најмалку {MIN_PASSWORD} знаци.</div>
      </div>
    </Dialog>
  )
}

function EditDialog({
  user,
  isSelf,
  busy,
  onClose,
  onSave,
  onResetPassword,
  onToggleActive
}: {
  user: StaffAccount
  isSelf: boolean
  busy: boolean
  onClose: () => void
  onSave: (patch: { username?: string; role?: StaffRole }) => void
  onResetPassword: (password: string) => Promise<boolean>
  onToggleActive: () => void
}) {
  const [username, setUsername] = useState(user.username)
  const [role, setRole] = useState<StaffRole>(user.role)
  const [password, setPassword] = useState('')
  const [reset, setReset] = useState(false)

  const nameValid = /^[a-z0-9._-]{3,32}$/.test(username)
  const changed = username !== user.username || role !== user.role

  return (
    <Dialog
      title={user.username}
      sub={`${ROLE_MK[user.role]} · од ${fmtDate(user.created_at)}`}
      onClose={onClose}
      footer={
        <>
          <button
            type="button"
            className={user.active === 1 ? 'danger' : 'ghost'}
            disabled={isSelf || busy}
            onClick={onToggleActive}
          >
            {user.active === 1 ? 'Деактивирај' : 'Активирај'}
          </button>
          <button
            type="button"
            className="gold"
            disabled={!changed || !nameValid || busy}
            onClick={() => onSave({ username, role })}
          >
            {busy ? 'Се зачувува…' : 'Зачувај'}
          </button>
        </>
      }
    >
      <div className="field">
        <label htmlFor="edit-username">Корисничко име</label>
        <input
          id="edit-username"
          value={username}
          autoCapitalize="none"
          autoCorrect="off"
          onChange={(e) => setUsername(e.target.value.toLowerCase())}
        />
      </div>

      <RoleField value={role} disabled={isSelf} onChange={setRole} />

      {isSelf && (
        <div className="hint over">
          Не можете да си ја смените сопствената улога ниту да се деактивирате — тоа е
          единствениот начин казиното да остане без администратор.
        </div>
      )}

      <div className="field">
        <div className="field-head">
          <label htmlFor="reset-password">Лозинка</label>
          {!reset && (
            <button type="button" className="ghost" onClick={() => setReset(true)}>
              Ресетирај
            </button>
          )}
        </div>
        {reset ? (
          <>
            <input
              id="reset-password"
              type="password"
              value={password}
              placeholder="Нова лозинка"
              onChange={(e) => setPassword(e.target.value)}
            />
            <div className="row" style={{ marginTop: 8 }}>
              <button
                type="button"
                className="gold"
                disabled={password.length < MIN_PASSWORD || busy}
                onClick={async () => {
                  if (await onResetPassword(password)) {
                    setPassword('')
                    setReset(false)
                  }
                }}
              >
                {busy ? 'Се менува…' : 'Постави лозинка'}
              </button>
              <button
                type="button"
                className="ghost"
                onClick={() => {
                  setPassword('')
                  setReset(false)
                }}
              >
                Откажи
              </button>
            </div>
            <div className="hint">Најмалку {MIN_PASSWORD} знаци. Старата престанува да важи веднаш.</div>
          </>
        ) : (
          <div className="hint">Скриена. Ресетирањето ја заменува веднаш.</div>
        )}
      </div>
    </Dialog>
  )
}
