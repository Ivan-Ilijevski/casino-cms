import { useCallback, useEffect, useRef, useState } from 'react'
import { api, mkd, timeAgo, type Order } from '../api'

const STATUS_MK: Record<Order['status'], string> = {
  received: 'нова',
  accepted: 'прифатена',
  fulfilled: 'завршена',
  cancelled: 'откажана'
}

const FILTERS: Array<{ key: string; label: string }> = [
  { key: 'received', label: 'Нови' },
  { key: 'accepted', label: 'Прифатени' },
  { key: 'fulfilled', label: 'Завршени' },
  { key: '', label: 'Сите' }
]

export function Orders({ onCount }: { onCount: (n: number) => void }) {
  const [orders, setOrders] = useState<Order[]>([])
  const [filter, setFilter] = useState('received')
  const [live, setLive] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const fresh = useRef<Set<string>>(new Set())

  const load = useCallback(async () => {
    const rows = await api.orders(filter || undefined)
    setOrders(rows)
    onCount(filter === 'received' ? rows.length : (await api.orders('received')).length)
  }, [filter, onCount])

  useEffect(() => {
    void load()
  }, [load])

  // Live feed: an order placed at the terminal must appear here immediately.
  useEffect(() => {
    const source = new EventSource('/api/orders/events')
    source.onopen = () => setLive(true)
    source.onerror = () => setLive(false)

    const onCreated = (e: MessageEvent) => {
      const order = JSON.parse(e.data) as Order
      if (order?.id) fresh.current.add(order.id)
      void load()
    }
    source.addEventListener('order.created', onCreated)
    source.addEventListener('order.updated', () => void load())

    return () => source.close()
  }, [load])

  async function act(id: string, status: Order['status']) {
    setBusy(id)
    try {
      const res = await api.setOrderStatus(id, status)
      if (res.refunded) fresh.current.delete(id)
      await load()
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <div className="head">
        <div>
          <h2>Нарачки</h2>
          <p>Нарачките од терминалот пристигнуваат тука во живо.</p>
        </div>
        <div className="toolbar">
          <span className="live">
            <span className={`dot ${live ? '' : 'off'}`} />
            {live ? 'во живо' : 'без врска'}
          </span>
          {FILTERS.map((f) => (
            <button key={f.key} className={filter === f.key ? 'gold' : 'ghost'} onClick={() => setFilter(f.key)}>
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {orders.length === 0 ? (
        <div className="empty">
          <div className="big">Нема нарачки</div>
          <div>Штом гостин нарача на терминалот, ќе се појави тука.</div>
        </div>
      ) : (
        <div className="grid">
          {orders.map((o) => (
            <article
              key={o.id}
              className={`order ${o.status} ${fresh.current.has(o.id) && o.status === 'received' ? 'fresh' : ''}`}
            >
              <div className="order-top">
                <div>
                  <div className="order-no">#{o.number}</div>
                  <div className="order-who">{o.player_name}</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <span className={`tag ${o.status}`}>{STATUS_MK[o.status]}</span>
                  <div className="order-when">{timeAgo(o.created_at)}</div>
                </div>
              </div>

              <div className="lines">
                {o.items.map((i) => (
                  <div className="line" key={i.drink_id}>
                    <span className="qty">{i.qty}×</span>
                    <span className="nm">{i.name}</span>
                    <span className="mono muted">
                      {o.pay_method === 'points' ? `${i.line_total_points} п.` : mkd(i.line_total_deni)}
                    </span>
                  </div>
                ))}
              </div>

              <div className="order-bot">
                <div>
                  {o.pay_method === 'points' ? (
                    <span className="tag points">{o.total_points} поени</span>
                  ) : (
                    <span className="money" style={{ fontSize: 16 }}>
                      {mkd(o.total_deni)} <span className="muted">ден.</span>
                    </span>
                  )}
                </div>

                {(o.status === 'received' || o.status === 'accepted') && (
                  <div className="order-acts">
                    {o.status === 'received' && (
                      <button disabled={busy === o.id} onClick={() => act(o.id, 'accepted')}>
                        Прифати
                      </button>
                    )}
                    <button className="gold" disabled={busy === o.id} onClick={() => act(o.id, 'fulfilled')}>
                      Заврши
                    </button>
                    <button
                      className="danger"
                      disabled={busy === o.id}
                      title="Откажување ги враќа парите/поените на картичката"
                      onClick={() => act(o.id, 'cancelled')}
                    >
                      Откажи
                    </button>
                  </div>
                )}
                {o.status === 'fulfilled' && o.fulfilled_by && (
                  <span className="muted" style={{ fontSize: 12 }}>
                    {o.fulfilled_by}
                  </span>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
    </>
  )
}
