import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { api, mkd, timeAgo, type CustomerListRow, type UnknownTap } from '../api'
import { Chip, Empty, Err, Monogram, Skeleton } from '../components/Bits'
import { Dialog } from '../components/Dialog'
import { fmtDate } from '../format'
import { checkNfcSupport, NfcScanError, readCardUid } from '../webnfc'

const SORTS: Array<{ value: string; label: string }> = [
  { value: 'name', label: 'Азбучно' },
  { value: 'balance', label: 'Најголема состојба' },
  { value: 'last_seen', label: 'Последна посета' },
  { value: 'created', label: 'Најнови гости' }
]

const FILTER_TAGS = [
  { tag: '', label: 'Сите' },
  { tag: 'vip', label: 'ВИП' },
  { tag: 'watchlist', label: 'На набљудување' },
  { tag: 'self_excluded', label: 'Самоисклучени' }
]

export function Guests({ isAdmin }: { isAdmin: boolean }) {
  // The filters live in the URL, so a filtered list survives a refresh and can
  // be handed to a colleague as a link.
  const [params, setParams] = useSearchParams()
  const q = params.get('q') ?? ''
  const tag = params.get('tag') ?? ''
  const sort = params.get('sort') ?? 'name'

  const [rows, setRows] = useState<CustomerListRow[] | null>(null)
  const [total, setTotal] = useState(0)
  const [taps, setTaps] = useState<UnknownTap[]>([])
  const [err, setErr] = useState('')
  const [registering, setRegistering] = useState<string | null>(null)
  const [term, setTerm] = useState(q)
  const [busy, setBusy] = useState(false)
  // Same guard as the money timeline: filter changes and "load more" both call
  // load(), and a late response must not append onto a newer list.
  const request = useRef(0)

  // Debounced: typing a name should not fire a request per keystroke.
  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    const t = setTimeout(() => {
      // Functional form: reading `params` from the closure would write back a
      // snapshot from before a tag or sort chosen while the timer was armed.
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          term ? next.set('q', term) : next.delete('q')
          return next
        },
        { replace: true }
      )
    }, 250)
    return () => clearTimeout(t)
  }, [term])

  const PAGE = 100

  async function load(offset = 0) {
    const ticket = ++request.current
    setErr('')
    setBusy(true)
    try {
      const [page, tapped] = await Promise.all([
        api.customers({ q, tag, sort, limit: PAGE, offset }),
        api.unknownTaps()
      ])
      if (ticket !== request.current) return
      setTotal(page.total)
      setRows((prev) => (offset && prev ? [...prev, ...page.rows] : page.rows))
      setTaps(tapped)
    } catch (e) {
      if (ticket !== request.current) return
      setErr((e as Error).message)
      setRows([])
    } finally {
      if (ticket === request.current) setBusy(false)
    }
  }

  useEffect(() => {
    setRows(null)
    void load()
  }, [q, tag, sort])

  // The tap inbox is what staff watch while a guest stands at the counter.
  useEffect(() => {
    const t = setInterval(() => void api.unknownTaps().then(setTaps).catch(() => {}), 5000)
    return () => clearInterval(t)
  }, [])

  function setParam(key: string, value: string) {
    const next = new URLSearchParams(params)
    value ? next.set(key, value) : next.delete(key)
    setParams(next, { replace: true })
  }

  return (
    <>
      <div className="head">
        <div>
          <h2>Гости</h2>
          <p>Досие по гостин — состојби, промет, посети и белешки.</p>
        </div>
        <div className="toolbar">
          <input
            className="search"
            placeholder="Име, телефон или UID на картичка…"
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            aria-label="Пребарај гости"
          />
          <select value={sort} onChange={(e) => setParam('sort', e.target.value)} aria-label="Подреди">
            {SORTS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <Err>{err}</Err>

      <div className="toolbar" style={{ marginBottom: 14 }}>
        {FILTER_TAGS.map((f) => (
          <button
            key={f.tag}
            className={tag === f.tag ? 'pill on' : 'pill'}
            onClick={() => setParam('tag', f.tag)}
          >
            {f.label}
          </button>
        ))}
      </div>

      {taps.length > 0 && isAdmin && (
        <div className="card tap-inbox">
          <h3>
            Непознати картички <span className="count">{taps.length}</span>
          </h3>
          <p className="muted">Допрени на терминалот, но не припаѓаат на ниту еден гостин.</p>
          <div className="taps">
            {taps.map((t) => (
              <div key={t.card_uid} className="tap">
                <span className="mono">{t.card_uid}</span>
                <span className="muted">×{t.count}</span>
                <span className="muted">{timeAgo(t.last_seen)}</span>
                <button className="gold" onClick={() => setRegistering(t.card_uid)}>
                  Регистрирај
                </button>
                <button
                  className="ghost"
                  onClick={async () => {
                    try {
                      await api.dismissTap(t.card_uid)
                      await load()
                    } catch (e) {
                      setErr((e as Error).message)
                    }
                  }}
                >
                  Отфрли
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="card scroll">
        <div className="card-head">
          <h3>
            {rows === null
              ? 'Гости'
              : rows.length < total
                ? `Гости · ${rows.length} од ${total}`
                : `Гости · ${total}`}
          </h3>
          {isAdmin && (
            <button className="gold" onClick={() => setRegistering('')}>
              Нов гостин
            </button>
          )}
        </div>

        {rows === null ? (
          <Skeleton rows={6} />
        ) : rows.length === 0 ? (
          <Empty
            title={q || tag ? 'Нема гостин по тие услови' : 'Сè уште нема регистрирани гости'}
            hint={
              q || tag
                ? 'Пробајте друго име или исчистете ги филтрите.'
                : 'Кога картичка ќе се допре на терминалот се појавува тука за регистрација.'
            }
          />
        ) : (
          <table className="rows">
            <thead>
              <tr>
                <th>Гостин</th>
                <th className="num">Картички</th>
                <th className="num">Состојба</th>
                <th className="num">Поени</th>
                <th>Последна посета</th>
                <th>Ознаки</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.id} style={{ '--i': Math.min(i, 12) } as React.CSSProperties}>
                  <td>
                    {/* A real link: middle-click and ⌘-click work, and the row
                        is one tab stop rather than a div with an onClick. */}
                    <Link to={`/guests/${r.id}`} className="guest-cell">
                      <Monogram id={r.id} name={r.name} />
                      <span>
                        <span className="guest-name">{r.name}</span>
                        <span className="guest-sub muted">
                          {r.city ? `${r.city} · ` : ''}од {fmtDate(r.created_at)}
                        </span>
                      </span>
                    </Link>
                  </td>
                  <td className="num muted">
                    {r.cards}
                    {r.blocked_cards > 0 && (
                      <span className="tag blocked" style={{ marginLeft: 6 }}>
                        {r.blocked_cards} блок.
                      </span>
                    )}
                  </td>
                  <td className="num money">{mkd(r.balance_deni)}</td>
                  <td className="num muted">{r.points}</td>
                  <td className="muted">{r.last_seen ? timeAgo(r.last_seen) : '—'}</td>
                  <td>
                    <div className="chips">
                      {r.tags.map((t) => (
                        <Chip key={t} tag={t} />
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {rows !== null && rows.length < total && (
          <div className="more">
            <button disabled={busy} onClick={() => void load(rows.length)}>
              {busy ? 'Се вчитува…' : `Вчитај уште (${total - rows.length})`}
            </button>
          </div>
        )}
      </div>

      {registering !== null && (
        <RegisterDialog
          uid={registering}
          taps={taps}
          onClose={() => setRegistering(null)}
          onDone={async () => {
            setRegistering(null)
            await load()
          }}
        />
      )}
    </>
  )
}

/**
 * Registration. The endpoint has always accepted a `playerId` to hang a second
 * card off an existing guest; the old screen never sent one, so a guest with
 * two cards could not be created from the UI at all.
 */
function RegisterDialog({
  uid,
  taps,
  onClose,
  onDone
}: {
  uid: string
  taps: UnknownTap[]
  onClose: () => void
  onDone: () => void
}) {
  const [mode, setMode] = useState<'new' | 'existing'>('new')
  const [cardUid, setCardUid] = useState(uid)
  const [name, setName] = useState('')
  const [pin, setPin] = useState('')
  const [playerId, setPlayerId] = useState('')
  const [matches, setMatches] = useState<CustomerListRow[]>([])
  const [search, setSearch] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  // The tablet reading the card itself beats typing 8 hex digits off a sticker,
  // and it is the same reader Каса arms for every payment.
  const nfc = useMemo(() => checkNfcSupport(), [])
  const [scanning, setScanning] = useState(false)
  const scan = useRef<AbortController | null>(null)

  // Closing the modal mid-scan must not leave the reader armed.
  useEffect(() => () => scan.current?.abort(), [])

  async function scanCard() {
    setErr('')
    const controller = new AbortController()
    scan.current = controller
    setScanning(true)
    try {
      setCardUid(await readCardUid(controller.signal))
    } catch (e) {
      // 'other' is the cancel path — the staff member changed their mind.
      if (!(e instanceof NfcScanError) || e.kind !== 'other') {
        setErr(e instanceof Error ? e.message : 'Грешка при читање.')
      }
    } finally {
      setScanning(false)
      scan.current = null
    }
  }

  useEffect(() => {
    if (mode !== 'existing') return
    const t = setTimeout(
      () => void api.customers({ q: search, limit: 8 }).then((p) => setMatches(p.rows)).catch(() => {}),
      200
    )
    return () => clearTimeout(t)
  }, [search, mode])

  async function submit() {
    setErr('')
    setBusy(true)
    try {
      if (mode === 'existing') {
        if (!playerId) throw new Error('Изберете гостин')
        await api.registerCardFor(cardUid, playerId, pin)
      } else {
        await api.registerCard(cardUid, name, pin)
      }
      onDone()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const valid = cardUid.trim() !== '' && pin.length === 4 && (mode === 'existing' ? playerId : name.trim())

  return (
    <Dialog
      title="Регистрирај картичка"
      sub="Картичката мора да има ПИН — без него не може да плаќа на касата."
      onClose={onClose}
      footer={
        <>
          <button type="button" className="ghost" onClick={onClose}>
            Откажи
          </button>
          <button type="button" className="gold" disabled={!valid || busy} onClick={submit}>
            {busy ? 'Се регистрира…' : 'Регистрирај'}
          </button>
        </>
      }
    >
      <Err>{err}</Err>

      <div className="seg">
        <button type="button" className={mode === 'new' ? 'on' : ''} onClick={() => setMode('new')}>
          Нов гостин
        </button>
        <button type="button" className={mode === 'existing' ? 'on' : ''} onClick={() => setMode('existing')}>
          Втора картичка за постоен
        </button>
      </div>

      {taps.length > 0 && (
        <div className="field">
          <label>Скоро допрени</label>
          <div className="taps compact">
            {taps.map((t) => (
              <button
                key={t.card_uid}
                type="button"
                className={t.card_uid === cardUid ? 'mono on' : 'mono'}
                onClick={() => setCardUid(t.card_uid)}
              >
                {t.card_uid} <span className="muted">×{t.count}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="field">
        <div className="field-head">
          <label>UID на картичка</label>
          {/* Chrome-on-Android in a secure context only; anywhere else the field
              is typed by hand, so a button that cannot work is not offered. */}
          {nfc.supported && (
            <button
              type="button"
              className={scanning ? 'ghost scan-btn armed' : 'ghost scan-btn'}
              onClick={() => (scanning ? scan.current?.abort() : void scanCard())}
            >
              {scanning ? 'Приложете ја картичката…' : 'Скенирај картичка'}
            </button>
          )}
        </div>
        <input className="mono" value={cardUid} onChange={(e) => setCardUid(e.target.value)} required />
      </div>

      {mode === 'new' ? (
        <div className="field">
          <label>Име на гостин</label>
          <input value={name} onChange={(e) => setName(e.target.value)} autoFocus required />
        </div>
      ) : (
        <div className="field">
          <label>Постоен гостин</label>
          <input
            placeholder="Пребарај по име…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="picker">
            {matches.map((m) => (
              <button
                key={m.id}
                type="button"
                className={m.id === playerId ? 'on' : ''}
                onClick={() => setPlayerId(m.id)}
              >
                <Monogram id={m.id} name={m.name} />
                <span>{m.name}</span>
                <span className="muted">{m.cards} карт.</span>
              </button>
            ))}
            {matches.length === 0 && <div className="muted">Нема совпаѓање.</div>}
          </div>
        </div>
      )}

      <div className="field">
        <label>ПИН (4 цифри)</label>
        <input
          className="mono"
          inputMode="numeric"
          pattern="[0-9]{4}"
          maxLength={4}
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
          required
        />
        <div className="hint">Се бара на секое осмо плаќање на касата.</div>
      </div>
    </Dialog>
  )
}
