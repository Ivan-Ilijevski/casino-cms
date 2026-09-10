import { useCallback, useEffect, useState } from 'react'
import { api, mkd, type Order } from '../api'
import { ConfirmDialog } from '../components/Dialog'
import { EtaDialog } from '../components/EtaDialog'

/** SQLite hands back "YYYY-MM-DD HH:MM:SS" in UTC. */
function stamp(iso: string): number {
  return new Date(iso.replace(' ', 'T') + 'Z').getTime()
}

/** hour12 pinned off: mk-MK is missing on some Android builds, and the en-US
 *  fallback renders "01:12 PM" on a board that is read at a glance. */
function clock(iso: string): string {
  return new Date(stamp(iso)).toLocaleTimeString('mk-MK', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  })
}

/** Fills over a quarter of an hour, which is long enough to mean something. */
const WAIT_SCALE_MS = 15 * 60_000

interface Dial {
  /** 0–1 of the arc to draw. */
  fraction: number
  label: string
  tone: 'ok' | 'warn' | 'late'
  title: string
}

/**
 * Before a promise exists the ring counts UP from when the guest ordered; once
 * accepted with an estimate it counts DOWN to it and keeps going when overdue.
 *
 * Orders accepted before promises existed have promised_at NULL, so the
 * counting-up branch is the fallback rather than an edge case.
 */
function dial(order: Order, now: number): Dial {
  if (order.promised_at) {
    const target = stamp(order.promised_at)
    const from = stamp(order.updated_at)
    const span = Math.max(target - from, 60_000)
    const remaining = target - now
    const mins = Math.ceil(Math.abs(remaining) / 60_000)
    if (remaining <= 0) {
      return {
        fraction: 1,
        label: `+${mins}`,
        tone: 'late',
        title: `Ветена ${clock(order.promised_at)} — доцни ${mins} мин`
      }
    }
    return {
      fraction: Math.min(remaining / span, 1),
      label: String(mins),
      tone: remaining <= 2 * 60_000 ? 'warn' : 'ok',
      title: `Готова околу ${clock(order.promised_at)}`
    }
  }

  const waited = Math.max(now - stamp(order.created_at), 0)
  const mins = Math.floor(waited / 60_000)
  return {
    fraction: Math.min(waited / WAIT_SCALE_MS, 1),
    label: String(mins),
    tone: waited >= 10 * 60_000 ? 'late' : waited >= 5 * 60_000 ? 'warn' : 'ok',
    title: `Чека ${mins} мин`
  }
}

const RADIUS = 19
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

function Ring({ order, now }: { order: Order; now: number }) {
  const d = dial(order, now)
  return (
    <svg className={`ring ${d.tone}`} viewBox="0 0 44 44" role="img" aria-label={d.title}>
      <title>{d.title}</title>
      <circle className="ring-track" cx="22" cy="22" r={RADIUS} />
      <circle
        className="ring-arc"
        cx="22"
        cy="22"
        r={RADIUS}
        strokeDasharray={CIRCUMFERENCE}
        strokeDashoffset={CIRCUMFERENCE * (1 - d.fraction)}
        transform="rotate(-90 22 22)"
      />
      <text className="ring-num" x="22" y="22" textAnchor="middle" dominantBaseline="central">
        {d.label}
      </text>
    </svg>
  )
}

type ColumnKind = 'new' | 'working' | 'done'

/**
 * Module scope, not nested inside BarOrders: a component declared during render
 * is a NEW type every render, so React remounts rather than reconciles it — and
 * the five-second ring tick would replay the card's entrance animation, which
 * looked like the whole board flickering.
 */
function OrderCard({
  order,
  column,
  now,
  busy,
  menuOpen,
  onToggleMenu,
  onCloseMenu,
  onPrimary,
  onCancel
}: {
  order: Order
  column: ColumnKind
  now: number
  busy: boolean
  menuOpen: boolean
  onToggleMenu: () => void
  onCloseMenu: () => void
  onPrimary: () => void
  onCancel: () => void
}) {
  const money =
    order.pay_method === 'points' ? `${order.total_points} поени` : `${mkd(order.total_deni)} ден`
  const count = order.items.reduce((n, i) => n + i.qty, 0)

  return (
    <article className={`bo-card ${column}`}>
      <div className="bo-top">
        <div className="bo-id">
          <span className="bo-no">#{order.number}</span>
          <span className="bo-who">{order.player_name}</span>
        </div>
        {column === 'done' ? (
          <span className="bo-servedat">{order.fulfilled_at && clock(order.fulfilled_at)}</span>
        ) : (
          <Ring order={order} now={now} />
        )}
      </div>

      <div className="bo-sum">
        <span className="money mono">{money}</span>
        <span className="muted"> · {count} артикли</span>
      </div>

      <div className="bo-lines">
        {order.items.map((i) => (
          <div className="bo-line" key={i.drink_id}>
            <span className={i.qty > 1 ? 'bo-qty many' : 'bo-qty'}>{i.qty}×</span>
            <span className="bo-nm">{i.name}</span>
            <span className="mono muted">
              {order.pay_method === 'points' ? `${i.line_total_points} п.` : mkd(i.line_total_deni)}
            </span>
          </div>
        ))}
      </div>

      {column === 'done' ? (
        order.fulfilled_by && <div className="bo-by muted">Заврши: {order.fulfilled_by}</div>
      ) : (
        <div className="bo-acts">
          <button className="gold bo-primary" disabled={busy} onClick={onPrimary}>
            {column === 'new' ? 'Прифати' : 'Заврши'}
          </button>
          <button
            className="ghost bo-more"
            aria-label="Повеќе"
            aria-expanded={menuOpen}
            disabled={busy}
            onClick={onToggleMenu}
          >
            …
          </button>

          {menuOpen && (
            <>
              {/* A full-screen catcher beats a document listener: it closes on
                  any outside tap, including one that scrolls a column. */}
              <div className="bo-catch" onClick={onCloseMenu} />
              <div className="bo-menu">
                <button className="danger" onClick={onCancel}>
                  Откажи нарачка
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </article>
  )
}

function Column({
  title,
  count,
  empty,
  children
}: {
  title: string
  count: number
  empty: string
  children: React.ReactNode
}) {
  return (
    <section className="bo-col">
      <header className="bo-colhead">
        <h3>{title}</h3>
        <span className="bo-count">{count}</span>
      </header>
      <div className="bo-scroll">
        {count === 0 ? <p className="bo-empty muted">{empty}</p> : children}
      </div>
    </section>
  )
}

/**
 * The bar tablet's order board: Нови → Во тек → Завршени, side by side, so the
 * whole flow is one glance and one thumb. Admin and staff keep the desk view.
 *
 * The board has no header of its own — its title and connection state sit in the
 * topbar beside the brand, which is why `onLive` is reported outwards the same
 * way `onCount` already is.
 */
export function BarOrders({
  onCount,
  onLive
}: {
  onCount: (n: number) => void
  onLive: (live: boolean) => void
}) {
  const [received, setReceived] = useState<Order[]>([])
  const [accepted, setAccepted] = useState<Order[]>([])
  const [done, setDone] = useState<Order[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [accepting, setAccepting] = useState<Order | null>(null)
  const [cancelling, setCancelling] = useState<Order | null>(null)
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())

  const load = useCallback(async () => {
    // Three requests rather than one unfiltered page, so a busy evening's
    // cancelled orders cannot crowd the live columns out of a single limit.
    const [fresh, working, finished] = await Promise.all([
      api.orders('received'),
      api.orders('accepted'),
      api.orders('fulfilled')
    ])
    const midnight = new Date()
    midnight.setHours(0, 0, 0, 0)

    setReceived(fresh)
    setAccepted(working)
    setDone(finished.filter((o) => o.fulfilled_at && stamp(o.fulfilled_at) >= midnight.getTime()))
    onCount(fresh.length)
  }, [onCount])

  useEffect(() => {
    void load()
  }, [load])

  // The rings move on their own; nothing else needs this tick.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    const source = new EventSource('/api/orders/events')
    source.onopen = () => onLive(true)
    source.onerror = () => onLive(false)
    source.addEventListener('order.created', () => void load())
    source.addEventListener('order.updated', () => void load())
    return () => {
      source.close()
      // The badge outlives this view now, so it must not be left reading „во
      // живо" on a screen that has no stream open.
      onLive(false)
    }
  }, [load, onLive])

  async function act(id: string, status: Order['status'], etaMinutes?: number) {
    setBusy(id)
    try {
      await api.setOrderStatus(id, status, etaMinutes)
      await load()
    } finally {
      setBusy(null)
    }
  }

  const refund =
    cancelling?.pay_method === 'points'
      ? `${cancelling.total_points} поени`
      : `${mkd(cancelling?.total_deni ?? 0)} ден`

  const cards = (orders: Order[], column: ColumnKind) =>
    orders.map((o) => (
      <OrderCard
        key={o.id}
        order={o}
        column={column}
        now={now}
        busy={busy === o.id}
        menuOpen={menuFor === o.id}
        onToggleMenu={() => setMenuFor(menuFor === o.id ? null : o.id)}
        onCloseMenu={() => setMenuFor(null)}
        onPrimary={() => (column === 'new' ? setAccepting(o) : void act(o.id, 'fulfilled'))}
        onCancel={() => {
          setMenuFor(null)
          setCancelling(o)
        }}
      />
    ))

  return (
    <div className="bo-board">
      <div className="bo-cols">
        <Column title="Нови" count={received.length} empty="Нема нови нарачки.">
          {cards(received, 'new')}
        </Column>
        <Column title="Во тек" count={accepted.length} empty="Ништо не се подготвува.">
          {cards(accepted, 'working')}
        </Column>
        <Column title="Завршени" count={done.length} empty="Денес сè уште нема завршени.">
          {cards(done, 'done')}
        </Column>
      </div>

      {accepting && (
        <EtaDialog
          orderNumber={accepting.number}
          guest={accepting.player_name}
          busy={busy === accepting.id}
          onClose={() => setAccepting(null)}
          onAccept={async (minutes) => {
            await act(accepting.id, 'accepted', minutes)
            setAccepting(null)
          }}
        />
      )}

      {cancelling && (
        <ConfirmDialog
          title="Откажи ја нарачката?"
          body={
            <p>
              Нарачка <strong>#{cancelling.number}</strong> за {cancelling.player_name} —{' '}
              <strong>{refund}</strong> се враќаат на картичката, а пијалаците се враќаат на
              залиха.
            </p>
          }
          // „Да," and not another „Откажи": the dismiss button already says that,
          // and the two must not read as the same choice.
          confirmLabel="Да, откажи ја"
          danger
          busy={busy === cancelling.id}
          onClose={() => setCancelling(null)}
          onConfirm={async () => {
            await act(cancelling.id, 'cancelled')
            setCancelling(null)
          }}
        />
      )}
    </div>
  )
}
