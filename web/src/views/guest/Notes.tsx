import { useEffect, useState } from 'react'
import { api, type Note } from '../../api'
import { Chip, Empty, Err, Skeleton } from '../../components/Bits'
import { fmtDateTime } from '../../format'
import { useGuest } from '../GuestProfile'

const SUGGESTED = ['vip', 'watchlist', 'self_excluded', 'pep', 'sanctions_hit']

export function Notes({ isAdmin }: { isAdmin: boolean }) {
  const { customer, reload } = useGuest()
  const playerId = customer.player.id
  const [notes, setNotes] = useState<Note[] | null>(null)
  const [draft, setDraft] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  async function load() {
    try {
      setNotes(await api.notes(playerId))
    } catch (e) {
      setErr((e as Error).message)
      setNotes([])
    }
  }

  useEffect(() => {
    setNotes(null)
    void load()
  }, [playerId])

  async function add(e: React.FormEvent) {
    e.preventDefault()
    if (!draft.trim()) return
    setBusy(true)
    setErr('')
    try {
      await api.addNote(playerId, draft.trim())
      setDraft('')
      await load()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function guard(fn: () => Promise<unknown>) {
    setErr('')
    try {
      await fn()
    } catch (e) {
      setErr((e as Error).message)
    }
  }

  return (
    <div className="split">
      <div className="stack">
        <Err>{err}</Err>

        <div className="card">
          <h3>Нова белешка</h3>
          <form onSubmit={add}>
            <textarea
              rows={3}
              value={draft}
              placeholder="Што треба персоналот да знае за овој гостин?"
              onChange={(e) => setDraft(e.target.value)}
            />
            <div className="row" style={{ justifyContent: 'space-between', marginTop: 8 }}>
              <span className="hint">Се потпишува со вашето име и време.</span>
              <button className="gold" type="submit" disabled={!draft.trim() || busy}>
                {busy ? 'Се додава…' : 'Додај белешка'}
              </button>
            </div>
          </form>
        </div>

        {notes === null ? (
          <Skeleton rows={4} />
        ) : notes.length === 0 ? (
          <Empty title="Нема ниту една белешка" hint="Првата белешка ја пишува персоналот што го служи гостинот." />
        ) : (
          notes.map((n, i) => (
            <div
              key={n.id}
              className={n.pinned ? 'card note pinned' : 'card note'}
              style={{ '--i': Math.min(i, 12) } as React.CSSProperties}
            >
              <div className="note-body">{n.body}</div>
              <div className="note-foot">
                <span className="note-meta muted">
                  {n.author} · {fmtDateTime(n.created_at)}
                </span>
                <span className="row">
                  <button
                    className="ghost"
                    onClick={() => void guard(async () => {
                      await api.pinNote(playerId, n.id, !n.pinned)
                      await load()
                    })}
                  >
                    {n.pinned ? 'Откачи' : 'Закачи'}
                  </button>
                  {isAdmin && (
                    <button
                      className="danger"
                      onClick={() => void guard(async () => {
                        await api.deleteNote(playerId, n.id)
                        await load()
                      })}
                    >
                      Избриши
                    </button>
                  )}
                </span>
              </div>
            </div>
          ))
        )}
      </div>

      <div className="stack">
        <div className="card">
          <h3>Ознаки</h3>
          <p className="muted">
            Ознаките се гледаат на списокот и на врвот од досието. Само администратор ги менува.
          </p>
          <div className="chips" style={{ marginBottom: 12 }}>
            {customer.tags.length === 0 && <span className="muted">Нема ознака.</span>}
            {customer.tags.map((t) => (
              <Chip
                key={t}
                tag={t}
                onRemove={
                  isAdmin
                    ? () => void guard(async () => {
                        await api.removeTag(playerId, t)
                        await reload()
                      })
                    : undefined
                }
              />
            ))}
          </div>

          {isAdmin && (
            <>
              <label>Додај ознака</label>
              <div className="chips">
                {SUGGESTED.filter((t) => !customer.tags.includes(t)).map((t) => (
                  <button
                    key={t}
                    className="chip-add"
                    onClick={() => void guard(async () => {
                      await api.addTag(playerId, t)
                      await reload()
                    })}
                  >
                    + <Chip tag={t} />
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
