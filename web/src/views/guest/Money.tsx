import { useEffect, useRef, useState } from 'react'
import { api, mkd, type TimelineRow } from '../../api'
import { Empty, Err, Skeleton } from '../../components/Bits'
import { fmtDateTime, localDayToUtc } from '../../format'
import { useGuest } from '../GuestProfile'

/** ledger_entries.kind is free-text; these are every value the domain writes. */
export const KIND_MK: Record<string, string> = {
  adjustment: 'Рачна корекција',
  aft_debit: 'Кредити на машина',
  aft_credit: 'Исплата на картичка',
  aft_rollback: 'Вратен трансфер',
  order: 'Нарачка на бар',
  order_refund: 'Враќање за нарачка',
  points_earned: 'Освоени поени'
}

const FILTERS: Array<{ value: string; label: string }> = [
  { value: '', label: 'Сè' },
  { value: 'aft_debit,aft_credit,aft_rollback', label: 'Машина' },
  { value: 'order,order_refund', label: 'Бар' },
  { value: 'adjustment', label: 'Корекции' },
  { value: 'points_earned', label: 'Поени' }
]

const PAGE = 40

export function Money() {
  const { customer } = useGuest()
  const playerId = customer.player.id

  const [rows, setRows] = useState<TimelineRow[] | null>(null)
  const [type, setType] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [done, setDone] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  // Both the filter effect and "Вчитај уште" call load(). Without a guard, a
  // slow page-2 request that resolves after a filter change appends unfiltered
  // rows onto the filtered list. Each call claims a ticket; only the newest wins.
  const request = useRef(0)

  async function load(before?: number) {
    const ticket = ++request.current
    setBusy(true)
    setErr('')
    try {
      const page = await api.timeline(playerId, {
        type: type || undefined,
        from: from ? localDayToUtc(from, false) : undefined,
        to: to ? localDayToUtc(to, true) : undefined,
        limit: PAGE,
        before
      })
      if (ticket !== request.current) return
      setDone(page.length < PAGE)
      setRows((prev) => (before && prev ? [...prev, ...page] : page))
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
  }, [playerId, type, from, to])

  function exportCsv() {
    // Built from what is loaded, so the file matches what the screen shows.
    const head = ['Кога', 'Тип', 'Картичка', 'Единица', 'Износ', 'Опис', 'Кој']
    const body = (rows ?? []).map((r) => [
      r.created_at,
      KIND_MK[r.kind] ?? r.kind,
      r.card_uid,
      r.unit,
      r.unit === 'deni' ? (r.amount / 100).toFixed(2) : String(r.amount),
      describe(r),
      r.actor
    ])
    const csv = [head, ...body]
      .map((cols) => cols.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(','))
      .join('\n')
    const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `${customer.player.name.replace(/\s+/g, '-')}-промени.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <>
      <div className="toolbar money-bar">
        <div className="seg">
          {FILTERS.map((f) => (
            <button key={f.value} className={type === f.value ? 'on' : ''} onClick={() => setType(f.value)}>
              {f.label}
            </button>
          ))}
        </div>
        <label className="inline-field">
          <span>Од</span>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="inline-field">
          <span>До</span>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <button className="ghost" disabled={!rows?.length} onClick={exportCsv}>
          Извези CSV
        </button>
      </div>

      <Err>{err}</Err>

      <div className="card">
        {rows === null ? (
          <Skeleton rows={6} />
        ) : rows.length === 0 ? (
          <Empty
            title="Нема промени по тие услови"
            hint="Обидете се без филтер или со поширок период."
          />
        ) : (
          <>
            <TimelineList rows={rows} />
            <div className="more">
              {done ? (
                <span className="muted">Тоа е сè — {rows.length} промени.</span>
              ) : (
                <button disabled={busy} onClick={() => void load(rows[rows.length - 1].id)}>
                  {busy ? 'Се вчитува…' : 'Вчитај уште'}
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </>
  )
}

/**
 * ledger_entries.ref is polymorphic — an order uuid for bar lines, a free-text
 * reason for adjustments — so it can only be rendered by branching on kind.
 */
function describe(r: TimelineRow): string {
  if (r.kind === 'order' || r.kind === 'order_refund') {
    return r.order_items ?? (r.order_number ? `нарачка #${r.order_number}` : '')
  }
  if (r.kind === 'adjustment') return r.ref ?? ''
  if (r.txn) return r.txn
  return r.ref ?? ''
}

export function TimelineList({ rows }: { rows: TimelineRow[] }) {
  return (
    <ol className="timeline">
      {rows.map((r, i) => (
        <li key={r.id} className="tl-item" style={{ '--i': Math.min(i, 12) } as React.CSSProperties}>
          <span className={`tl-dot k-${r.kind}`} aria-hidden="true" />
          <div className="tl-main">
            <div className="tl-top">
              <span className="tl-kind">{KIND_MK[r.kind] ?? r.kind}</span>
              {r.order_number !== null && <span className="tl-ref mono">#{r.order_number}</span>}
            </div>
            {describe(r) && <div className="tl-desc muted">{describe(r)}</div>}
            <div className="tl-meta muted">
              {fmtDateTime(r.created_at)} · {r.card_uid} · {r.actor}
            </div>
          </div>
          <span className={r.amount < 0 ? 'tl-amount money neg' : 'tl-amount money pos'}>
            {r.amount > 0 ? '+' : '−'}
            {r.unit === 'deni' ? mkd(Math.abs(r.amount)) : `${Math.abs(r.amount)} п.`}
          </span>
        </li>
      ))}
    </ol>
  )
}
