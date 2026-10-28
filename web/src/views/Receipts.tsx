import { useEffect, useState, useSyncExternalStore } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  api,
  mkd,
  type ReceiptDetail,
  type ReceiptPrint,
  type ReceiptSummary
} from '../api'
import { fmtDateTime, fmtTime } from '../format'
import { describePrinterError, PrinterJobError, printerState, subscribePrinter } from '../printer'
import { printReceipt } from '../receiptPrint'

const TENDER_MK: Record<ReceiptSummary['payMethod'], string> = {
  cash: 'На кредит',
  points: 'Поени'
}

const p2 = (n: number) => String(n).padStart(2, '0')

/** The tablet's own calendar day, which is the venue's — the tablet sits in it. */
function today(): string {
  const d = new Date()
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
}

/**
 * Where a receipt stands, as one tag.
 *
 * "Испратена" and never "испечатена": a finished Bluetooth transfer is all the tablet
 * can know, not that paper came out (see printer.ts). A receipt that went through once
 * stays испратена even if a later copy failed — the guest has their original.
 */
function standing(r: Pick<ReceiptSummary, 'printed' | 'lastStatus' | 'lastPercent'>): {
  label: string
  tone: string
} {
  if (r.printed) return { label: 'испратена', tone: 'fulfilled' }
  switch (r.lastStatus) {
    case 'interrupted':
      return { label: `прекината ${r.lastPercent ?? 0}%`, tone: 'cancelled' }
    case 'failed':
      return { label: 'неуспешна', tone: 'cancelled' }
    // An attempt that never reported back: the tablet died or lost the network mid-print.
    case 'sending':
      return { label: 'без потврда', tone: 'accepted' }
    default:
      return { label: 'неиспратена', tone: 'accepted' }
  }
}

function attemptLabel(p: ReceiptPrint): { label: string; tone: string } {
  switch (p.status) {
    case 'sent':
      return { label: 'испратена', tone: 'fulfilled' }
    case 'interrupted':
      return { label: `прекината ${p.percent ?? 0}%`, tone: 'cancelled' }
    case 'failed':
      return { label: 'неуспешна', tone: 'cancelled' }
    case 'sending':
      return { label: 'без потврда', tone: 'accepted' }
  }
}

/** The one sentence the operator needs after a print from here did not go through. */
function notSentMk(err: unknown): string {
  if (err instanceof PrinterJobError && err.kind === 'link-lost') {
    return `Печатачот се исклучи при испраќањето (${err.percent}%). Откинете ја прекинатата сметка и пратете ја повторно штом се поврзе.`
  }
  if (err instanceof PrinterJobError) return describePrinterError(err)
  return (err as Error)?.message || 'Сметката не можеше да се подготви.'
}

/**
 * Fiscal receipt history: every receipt of a business day, what it said, and every
 * attempt to get it out of the printer.
 *
 * The first print of a receipt that never came out whole is still the original; once
 * one attempt has gone through, the server marks every further print a КОПИЈА and
 * audits who asked for it. This view only ever asks — it never decides which.
 */
export function Receipts() {
  const [params, setParams] = useSearchParams()
  const unprintedOnly = params.get('unprinted') === '1'
  const [day, setDay] = useState(today)
  const [rows, setRows] = useState<ReceiptSummary[]>([])
  const [selected, setSelected] = useState<number | null>(null)
  const [detail, setDetail] = useState<ReceiptDetail | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ text: string; ok: boolean } | null>(null)
  const [err, setErr] = useState('')
  const printer = useSyncExternalStore(subscribePrinter, printerState)

  async function loadList() {
    try {
      setRows(await api.receipts({ day, unprinted: unprintedOnly }))
      setErr('')
    } catch (e) {
      setErr((e as Error).message)
    }
  }

  async function loadDetail(id: number) {
    try {
      setDetail(await api.receipt(id))
    } catch (e) {
      setDetail(null)
      setErr((e as Error).message)
    }
  }

  useEffect(() => {
    void loadList()
  }, [day, unprintedOnly])

  useEffect(() => {
    setNote(null)
    if (selected === null) {
      setDetail(null)
      return
    }
    void loadDetail(selected)
  }, [selected])

  function setFilter(unprinted: boolean) {
    const next = new URLSearchParams(params)
    if (unprinted) next.set('unprinted', '1')
    else next.delete('unprinted')
    setParams(next, { replace: true })
  }

  async function print(id: number) {
    setBusy(true)
    setNote(null)
    try {
      const blob = await api.receiptImageById(id)
      const { copy } = await printReceipt(id, blob)
      setNote({ text: copy ? 'Копијата е испратена до печатачот.' : 'Сметката е испратена до печатачот.', ok: true })
    } catch (e) {
      setNote({ text: notSentMk(e), ok: false })
    } finally {
      setBusy(false)
      await Promise.all([loadList(), loadDetail(id)])
    }
  }

  const unsentCount = rows.filter((r) => !r.printed).length
  // Nothing paired means nothing to send to; a printer that is busy, only reconnecting or
  // has given up is still paired, and printing waits for it or wakes it.
  const canSend = ['ready', 'printing', 'reconnecting', 'offline'].includes(printer.status)
  const sending = busy || printer.status === 'printing'

  return (
    <>
      <div className="head">
        <div>
          <h2>Сметки</h2>
          <p>Фискални сметки по ден, со секој обид за печатење.</p>
        </div>
        <div className="toolbar">
          <input
            type="date"
            aria-label="Ден"
            value={day}
            max={today()}
            onChange={(e) => e.target.value && setDay(e.target.value)}
          />
          <button className={!unprintedOnly ? 'pill on' : 'pill'} onClick={() => setFilter(false)}>
            Сите
          </button>
          <button className={unprintedOnly ? 'pill on' : 'pill'} onClick={() => setFilter(true)}>
            Неиспратени
          </button>
        </div>
      </div>

      {err && <div className="err">{err}</div>}

      {!unprintedOnly && rows.length > 0 && (
        <div className="stats">
          <div className="stat gold">
            <div className="k">Сметки</div>
            <div className="v">{rows.length}</div>
          </div>
          <div className={`stat ${unsentCount > 0 ? 'crimson' : 'emerald'}`}>
            <div className="k">Неиспратени</div>
            <div className="v">{unsentCount}</div>
          </div>
          <div className="stat">
            <div className="k">Промет</div>
            <div className="v">{mkd(rows.reduce((sum, r) => sum + r.totalDeni, 0))}</div>
            <div className="s">денари</div>
          </div>
        </div>
      )}

      <div className="split">
        <div className="card scroll">
          <table className="receipts-table">
            <thead>
              <tr>
                <th>Број</th>
                <th>Време</th>
                <th>Нарачка</th>
                <th className="num">Износ (ден.)</th>
                <th>Плаќање</th>
                <th>Персонал</th>
                <th>Статус</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const s = standing(r)
                return (
                  <tr
                    key={r.id}
                    className={selected === r.id ? 'on' : ''}
                    onClick={() => setSelected(selected === r.id ? null : r.id)}
                  >
                    <td className="mono">#{r.number}</td>
                    <td className="muted">{fmtTime(r.createdAt)}</td>
                    <td className="mono muted">#{r.orderNumber}</td>
                    <td className="num money">{mkd(r.totalDeni)}</td>
                    <td className="muted">{TENDER_MK[r.payMethod]}</td>
                    <td className="muted">{r.actor}</td>
                    <td>
                      <span className={`tag ${s.tone}`}>{s.label}</span>
                      {r.copies > 0 && <span className="tag receipt-copies">копии {r.copies}</span>}
                    </td>
                  </tr>
                )
              })}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={7} className="muted" style={{ padding: 26, textAlign: 'center' }}>
                    {unprintedOnly ? 'Сите сметки за овој ден се испратени.' : 'Нема сметки за овој ден.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="card receipt-detail">
          {!detail ? (
            <p className="muted">Изберете сметка за да ја видите и да ја пратите повторно.</p>
          ) : (
            <ReceiptPanel
              detail={detail}
              canSend={canSend}
              sending={sending}
              percent={printer.status === 'printing' ? printer.percent : null}
              note={note}
              onPrint={() => void print(detail.receipt.id)}
            />
          )}
        </div>
      </div>
    </>
  )
}

function ReceiptPanel({
  detail,
  canSend,
  sending,
  percent,
  note,
  onPrint
}: {
  detail: ReceiptDetail
  canSend: boolean
  sending: boolean
  percent: number | null
  note: { text: string; ok: boolean } | null
  onPrint: () => void
}) {
  const { receipt, items, prints } = detail
  const s = standing(receipt)

  return (
    <div className="stack">
      <div className="card-head">
        <h3>Фискална сметка #{receipt.number}</h3>
        <span className={`tag ${s.tone}`}>{s.label}</span>
      </div>
      <div className="muted" style={{ fontSize: 13 }}>
        {fmtDateTime(receipt.createdAt)} · нарачка #{receipt.orderNumber} · {receipt.actor}
      </div>

      {/*
        The stored render, exactly what the printer is sent. A receipt from before
        images were kept is rendered once when first opened here, then kept too.
      */}
      <img
        className="receipt-preview"
        src={`/api/receipts/${receipt.id}/image`}
        alt={`Фискална сметка #${receipt.number}`}
      />

      {items && (
        <table className="receipt-lines">
          <tbody>
            {items.map((line, i) => (
              <tr key={i}>
                <td>
                  {line.name} <span className="muted">× {line.quantity}</span>
                </td>
                <td className="num">{mkd(Math.round(line.price * line.quantity * 100))}</td>
                <td className="muted mono">{line.vatType}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div>
        <button className="gold" style={{ width: '100%' }} disabled={!canSend || sending} onClick={onPrint}>
          {sending
            ? percent !== null
              ? `Се испраќа… ${percent}%`
              : 'Се испраќа…'
            : receipt.printed
              ? 'Печати копија'
              : 'Печати'}
        </button>
        {!canSend && (
          <div className="hint">Нема спарен печатач. Спарете печатач во Поставки.</div>
        )}
        {receipt.printed && canSend && !sending && (
          <div className="hint">Ќе излезе означена како КОПИЈА.</div>
        )}
        {note && <div className={note.ok ? 'settings-status muted' : 'err'}>{note.text}</div>}
      </div>

      <div>
        <h4 className="receipt-log-title">Дневник на печатење</h4>
        {prints.length === 0 ? (
          <p className="muted" style={{ fontSize: 13 }}>
            Сметката никогаш не е пратена до печатач.
          </p>
        ) : (
          <ul className="receipt-log">
            {prints.map((p) => {
              const a = attemptLabel(p)
              return (
                <li key={p.id}>
                  <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
                    <span className="mono muted">{fmtDateTime(p.startedAt)}</span>
                    <span>
                      {p.copy && <span className="tag receipt-copies">копија</span>}{' '}
                      <span className={`tag ${a.tone}`}>{a.label}</span>
                    </span>
                  </div>
                  <div className="muted" style={{ fontSize: 12 }}>
                    {p.actor}
                    {p.device ? ` · ${p.device}` : ''}
                  </div>
                  {p.error && <div className="receipt-log-error">{p.error}</div>}
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
