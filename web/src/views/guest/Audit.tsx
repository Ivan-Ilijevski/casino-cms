import { useEffect, useState } from 'react'
import { api, type AuditRow } from '../../api'
import { Empty, Err, Skeleton } from '../../components/Bits'
import { fmtDateTime } from '../../format'
import { useGuest } from '../GuestProfile'

const ACTION_MK: Record<string, string> = {
  'card.register': 'Регистрирана картичка',
  'card.adjust': 'Рачна корекција',
  'card.block': 'Блокирана картичка',
  'card.unblock': 'Одблокирана картичка',
  'card.set_pin': 'Поставен ПИН',
  'pos.charge': 'Наплата на каса',
  'order.received': 'Примена нарачка',
  'order.accepted': 'Прифатена нарачка',
  'order.fulfilled': 'Испорачана нарачка',
  'order.cancelled': 'Откажана нарачка',
  'player.update': 'Изменет идентитет',
  'player.note': 'Додадена белешка',
  'player.note_delete': 'Избришана белешка',
  'player.tag': 'Додадена ознака',
  'player.untag': 'Отстранета ознака',
  'osint.lookup': 'Отворен јавен извор'
}

export function Audit() {
  const { customer } = useGuest()
  const [rows, setRows] = useState<AuditRow[] | null>(null)
  const [err, setErr] = useState('')

  useEffect(() => {
    setRows(null)
    api
      .customerAudit(customer.player.id)
      .then(setRows)
      .catch((e) => {
        setErr((e as Error).message)
        setRows([])
      })
  }, [customer.player.id])

  return (
    <div className="card scroll">
      <h3>Дневник</h3>
      <p className="muted">Сè што персоналот направил на овој гостин, вклучувајќи ги пребарувањата.</p>
      <Err>{err}</Err>

      {rows === null ? (
        <Skeleton rows={6} />
      ) : rows.length === 0 ? (
        <Empty title="Нема запис" hint="Дневникот се полни при секое дејство врз гостинот." />
      ) : (
        <table>
          <thead>
            <tr>
              <th>Кога</th>
              <th>Дејство</th>
              <th>Кој</th>
              <th>Детали</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr
                key={r.id}
                className={r.action === 'osint.lookup' ? 'audit-osint' : ''}
                style={{ '--i': Math.min(i, 12) } as React.CSSProperties}
              >
                <td className="muted">{fmtDateTime(r.created_at)}</td>
                <td>{ACTION_MK[r.action] ?? r.action}</td>
                <td>{r.actor}</td>
                <td className="mono muted details">{r.details ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
