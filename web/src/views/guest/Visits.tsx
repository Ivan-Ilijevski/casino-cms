import { useEffect, useState } from 'react'
import { api, mkd, type LinkedTicket, type Visit } from '../../api'
import { Empty, Err, Skeleton } from '../../components/Bits'
import { fmtDateTime, fmtDuration, fmtVisit } from '../../format'
import { useGuest } from '../GuestProfile'

const REASON_MK: Record<string, string> = {
  cashout: 'исплата',
  inactivity: 'неактивност',
  logout_push: 'одјавен од шалтер',
  replaced: 'нова сесија',
  blocked: 'блокирана картичка'
}

const TICKET_MK: Record<string, string> = {
  issued: 'издаден',
  redeemed: 'искористен',
  voided: 'поништен',
  expired: 'истечен'
}

export function Visits() {
  const { customer } = useGuest()
  const playerId = customer.player.id
  const [visits, setVisits] = useState<Visit[] | null>(null)
  const [tickets, setTickets] = useState<LinkedTicket[]>([])
  const [err, setErr] = useState('')

  useEffect(() => {
    setVisits(null)
    void (async () => {
      try {
        const [v, t] = await Promise.all([api.visits(playerId), api.customerTickets(playerId)])
        setVisits(v)
        setTickets(t)
      } catch (e) {
        setErr((e as Error).message)
        setVisits([])
      }
    })()
  }, [playerId])

  return (
    <>
      <Err>{err}</Err>

      <div className="card scroll">
        <h3>Посети</h3>
        <p className="muted">Секое качување на картичката на машина, од најново кон најстаро.</p>
        {visits === null ? (
          <Skeleton rows={5} />
        ) : visits.length === 0 ? (
          <Empty
            title="Гостинот сè уште не бил на машина"
            hint="Посета се отвора кога картичката ќе се допре на терминалот."
          />
        ) : (
          <table>
            <thead>
              <tr>
                <th>Кога</th>
                <th>Картичка</th>
                <th className="num">Траење</th>
                <th className="num">Потрошено</th>
                <th className="num">Нарачки</th>
                <th>Крај</th>
              </tr>
            </thead>
            <tbody>
              {visits.map((v, i) => (
                <tr key={v.sid} style={{ '--i': Math.min(i, 12) } as React.CSSProperties}>
                  <td>{fmtVisit(v.opened_at, v.closed_at)}</td>
                  <td className="mono muted">{v.card_uid}</td>
                  <td className="num">{fmtDuration(v.duration_seconds)}</td>
                  <td className="num money">{mkd(v.spend_deni)}</td>
                  <td className="num muted">{v.orders || '—'}</td>
                  <td>
                    {v.closed_at ? (
                      <span className="muted">{REASON_MK[v.close_reason ?? ''] ?? v.close_reason}</span>
                    ) : (
                      <span className="live">
                        <span className="dot" /> во тек
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card scroll" style={{ marginTop: 14 }}>
        <h3>Тикети во периодите на посетите</h3>
        {/* Tickets are machine money and carry no card, so this is a time
            correlation and must never be presented as a confirmed cashout. */}
        <div className="banner">
          Веројатна врска, не потврдена. Тикетите се машински пари и не носат картичка — овие се
          издадени додека гостинот имал отворена сесија, што не значи дека се негови.
        </div>
        {tickets.length === 0 ? (
          <div className="muted">Нема тикет издаден во периодите на посетите.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Тикет</th>
                <th className="num">Износ</th>
                <th>Статус</th>
                <th>Издаден</th>
                <th>Врска</th>
              </tr>
            </thead>
            <tbody>
              {tickets.map((t) => (
                <tr key={t.id}>
                  <td className="mono">{t.id}</td>
                  <td className="num money">{mkd(t.amount_deni)}</td>
                  <td>
                    <span className={`tag ${t.status}`}>{TICKET_MK[t.status] ?? t.status}</span>
                  </td>
                  <td className="muted">{fmtDateTime(t.created_at)}</td>
                  <td>
                    <span className={t.confidence === 'confirmed' ? 'tag active' : 'tag maybe'}>
                      {t.confidence === 'confirmed' ? 'потврдена' : 'веројатна'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  )
}
