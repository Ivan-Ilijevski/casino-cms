import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, mkd, type Note, type Player } from '../../api'
import { Empty, Err } from '../../components/Bits'
import { Dialog } from '../../components/Dialog'
import { fmtDate, fmtDateTime, fmtPlainDate } from '../../format'
import { useGuest } from '../GuestProfile'
import { KIND_MK, TimelineList } from './Money'

const FIELDS: Array<{ key: keyof Player; label: string; type?: string; pii?: boolean }> = [
  { key: 'name', label: 'Име' },
  { key: 'phone', label: 'Телефон', type: 'tel' },
  { key: 'email', label: 'Е-пошта', type: 'email' },
  { key: 'city', label: 'Град' },
  { key: 'dob', label: 'Датум на раѓање', type: 'date', pii: true },
  { key: 'doc_id', label: 'ЕМБГ / пасош', pii: true }
]

export function Overview({ isAdmin }: { isAdmin: boolean }) {
  const { customer, reload } = useGuest()
  const { player, holds } = customer
  const [editing, setEditing] = useState(false)
  const [pinned, setPinned] = useState<Note[]>([])
  const [recent, setRecent] = useState<Awaited<ReturnType<typeof api.timeline>>>([])

  useEffect(() => {
    void api.notes(player.id).then((n) => setPinned(n.filter((x) => x.pinned))).catch(() => {})
    void api.timeline(player.id, { limit: 5 }).then(setRecent).catch(() => {})
  }, [player.id])

  return (
    <div className="split">
      <div className="stack">
        <div className="card">
          <div className="card-head">
            <h3>Идентитет</h3>
            {isAdmin && (
              <button className="ghost" onClick={() => setEditing(true)}>
                Уреди
              </button>
            )}
          </div>
          <dl className="dl">
            {FIELDS.map((f) => {
              // dob and doc_id never reach a non-admin, so the row would read
              // "—" and imply the field is empty. Better to not show it.
              if (f.pii && !(f.key in player)) return null
              return (
                <div key={f.key} className="dl-row">
                  <dt className="dl-k">{f.label}</dt>
                  <dd className={f.key === 'doc_id' ? 'dl-v mono' : 'dl-v'}>
                    {/* dob is a calendar date, not an instant — formatting it
                        through the UTC round trip renders the previous day in
                        any negative-offset timezone. */}
                    {(player[f.key] as string | null)
                      ? f.key === 'dob'
                        ? fmtPlainDate(player.dob)
                        : (player[f.key] as string)
                      : <span className="muted">не е внесено</span>}
                  </dd>
                </div>
              )
            })}
            <div className="dl-row">
              <dt className="dl-k">Регистриран</dt>
              <dd className="dl-v">{fmtDate(player.created_at)}</dd>
            </div>
            {player.updated_at && (
              <div className="dl-row">
                <dt className="dl-k">Изменето</dt>
                <dd className="dl-v muted">{fmtDateTime(player.updated_at)}</dd>
              </div>
            )}
          </dl>
          {!isAdmin && (
            <div className="hint">Само администратор може да ги менува овие податоци.</div>
          )}
        </div>

        {holds.length > 0 && (
          <div className="card">
            <h3>Пари во движење</h3>
            <p className="muted">
              Отворен трансфер кон машина. Ако остане тука долго, трансферот не е потврден.
            </p>
            <table>
              <tbody>
                {holds.map((h) => (
                  <tr key={h.id}>
                    <td className="mono muted">{h.txn}</td>
                    <td className="muted">{h.card_uid}</td>
                    <td className="num money">{mkd(h.amount_deni)}</td>
                    <td className="muted">{fmtDateTime(h.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="card">
          <div className="card-head">
            <h3>Последни промени</h3>
            <Link to="money" className="ghost-link">
              Сите пари →
            </Link>
          </div>
          {recent.length === 0 ? (
            <Empty title="Нема ниту една промена" hint="Состојбата се менува при трансфер, нарачка или корекција." />
          ) : (
            <TimelineList rows={recent} />
          )}
        </div>
      </div>

      <div className="stack">
        <div className="card">
          <div className="card-head">
            <h3>Закачени белешки</h3>
            <Link to="notes" className="ghost-link">
              Сите →
            </Link>
          </div>
          {pinned.length === 0 ? (
            <div className="muted">Нема закачена белешка.</div>
          ) : (
            pinned.map((n) => (
              <div key={n.id} className="note">
                <div className="note-body">{n.body}</div>
                <div className="note-meta muted">
                  {n.author} · {fmtDateTime(n.created_at)}
                </div>
              </div>
            ))
          )}
        </div>

        <div className="card">
          <h3>Разбивање на прометот</h3>
          <dl className="dl">
            <div className="dl-row">
              <dt className="dl-k">Кон машина</dt>
              <dd className="dl-v money">{mkd(customer.stats.lifetime_out_deni)}</dd>
            </div>
            <div className="dl-row">
              <dt className="dl-k">Исплатено на картичка</dt>
              <dd className="dl-v money">{mkd(customer.stats.lifetime_in_deni)}</dd>
            </div>
            <div className="dl-row">
              <dt className="dl-k">{KIND_MK.order ?? 'Бар'}</dt>
              <dd className="dl-v money">{mkd(customer.stats.bar_spend_deni)}</dd>
            </div>
            <div className="dl-row">
              <dt className="dl-k">Рачни корекции</dt>
              <dd className="dl-v money">{mkd(customer.stats.adjustments_deni)}</dd>
            </div>
          </dl>
        </div>
      </div>

      {editing && (
        <EditDialog
          player={player}
          onClose={() => setEditing(false)}
          onDone={async () => {
            setEditing(false)
            await reload()
          }}
        />
      )}
    </div>
  )
}

function EditDialog({
  player,
  onClose,
  onDone
}: {
  player: Player
  onClose: () => void
  onDone: () => void
}) {
  const [draft, setDraft] = useState<Partial<Player>>({ ...player })
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  // The terminal copies the name into char name[64] and Cyrillic is two bytes
  // a letter, so the limit is in bytes and the counter has to be too.
  const nameBytes = new TextEncoder().encode(draft.name ?? '').length

  async function save() {
    setErr('')
    setBusy(true)
    try {
      await api.updateCustomer(player.id, draft)
      onDone()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      title="Уреди идентитет"
      sub="Се запишува кои полиња се сменети, но не и нивните вредности."
      onClose={onClose}
      footer={
        <>
          <button type="button" className="ghost" onClick={onClose}>
            Откажи
          </button>
          <button
            type="button"
            className="gold"
            disabled={busy || !draft.name?.trim() || nameBytes > 63}
            onClick={save}
          >
            {busy ? 'Се зачувува…' : 'Зачувај'}
          </button>
        </>
      }
    >
      <Err>{err}</Err>
      {FIELDS.map((f) => {
        if (f.pii && !(f.key in player)) return null
        return (
          <div key={f.key} className="field">
            <label>{f.label}</label>
            <input
              type={f.type ?? 'text'}
              className={f.key === 'doc_id' ? 'mono' : ''}
              value={(draft[f.key] as string | null) ?? ''}
              onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
            />
            {f.key === 'name' && (
              <div className={nameBytes > 63 ? 'hint over' : 'hint'}>
                {nameBytes}/63 бајти — терминалот отсекува подолго име.
              </div>
            )}
            {f.pii && f.key === 'doc_id' && (
              <div className="hint">Видливо само за администратори.</div>
            )}
          </div>
        )
      })}
    </Dialog>
  )
}
