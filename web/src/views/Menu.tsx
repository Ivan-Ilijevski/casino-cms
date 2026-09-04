import { useEffect, useState } from 'react'
import { api, mkd, type MenuItem, type VatType } from '../api'
import { ConfirmDialog, Dialog } from '../components/Dialog'
import { Empty } from '../components/Bits'
import { useIsMobile } from '../media'

const VAT_LABELS: Record<VatType, string> = {
  A: 'А — 18%',
  B: 'Б — 5%',
  V: 'В — ослободено',
  G: 'Г — нулта стапка'
}

/** stock '' means "not tracked" — the input is empty, the column stays NULL. */
const EMPTY = {
  drink_id: 0,
  name: '',
  price_deni: 0,
  points_price: 0,
  stock: '' as number | '',
  vat_type: 'A' as VatType,
  is_domestic: true
}

type Draft = typeof EMPTY

/** A drink the guest can actually order: switched on AND not sold out. */
function orderable(item: MenuItem): boolean {
  return item.available === 1 && item.stock_qty !== 0
}

export function Menu({ isAdmin }: { isAdmin: boolean }) {
  const [items, setItems] = useState<MenuItem[]>([])
  const [warning, setWarning] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft>({ ...EMPTY })
  const [err, setErr] = useState('')
  const [editing, setEditing] = useState<MenuItem | null>(null)
  const [deleting, setDeleting] = useState<MenuItem | null>(null)
  // Desktop keeps the form permanently in the right-hand column; on mobile that
  // column lands below the whole grid, so there the form is a modal instead.
  const [formOpen, setFormOpen] = useState(false)
  const isMobile = useIsMobile()

  async function load() {
    const res = await api.menu()
    setItems(res.items)
    setWarning(res.warning)
  }

  useEffect(() => {
    void load()
  }, [])

  async function toggle(item: MenuItem) {
    await api.updateDrink(item.drink_id, { available: item.available ? 0 : 1 })
    await load()
  }

  async function create(e: React.SyntheticEvent) {
    e.preventDefault()
    setErr('')
    try {
      await api.createDrink({
        drink_id: Number(draft.drink_id),
        name: draft.name,
        price_deni: Math.round(Number(draft.price_deni) * 100),
        points_price: Number(draft.points_price),
        stock_qty: draft.stock === '' ? null : Number(draft.stock),
        vat_type: draft.vat_type,
        is_domestic: draft.is_domestic ? 1 : 0
      })
      setDraft({ ...EMPTY })
      setFormOpen(false)
      await load()
    } catch (e) {
      setErr((e as Error).message)
    }
  }

  async function save(e: React.SyntheticEvent) {
    e.preventDefault()
    if (!editing) return
    setErr('')
    try {
      await api.updateDrink(editing.drink_id, {
        name: draft.name,
        price_deni: Math.round(Number(draft.price_deni) * 100),
        points_price: Number(draft.points_price),
        stock_qty: draft.stock === '' ? null : Number(draft.stock),
        vat_type: draft.vat_type,
        is_domestic: draft.is_domestic ? 1 : 0
      })
      exitEdit()
      await load()
    } catch (e) {
      setErr((e as Error).message)
    }
  }

  function startEdit(item: MenuItem) {
    setEditing(item)
    setDraft({
      drink_id: item.drink_id,
      name: item.name,
      price_deni: item.price_deni / 100,
      points_price: item.points_price,
      stock: item.stock_qty ?? '',
      vat_type: item.vat_type,
      is_domestic: item.is_domestic === 1
    })
    setFormOpen(true)
    setErr('')
  }

  function startCreate() {
    setEditing(null)
    setDraft({ ...EMPTY })
    setFormOpen(true)
    setErr('')
  }

  function exitEdit() {
    setEditing(null)
    setDraft({ ...EMPTY })
    setFormOpen(false)
    setErr('')
  }

  async function confirmDelete() {
    if (!deleting) return
    await api.deleteDrink(deleting.drink_id)
    setDeleting(null)
    exitEdit()
    await load()
  }

  async function swap(a: MenuItem, b: MenuItem) {
    await api.updateDrink(a.drink_id, { sort_order: b.sort_order })
    await api.updateDrink(b.drink_id, { sort_order: a.sort_order })
    await load()
  }

  /** Restocking is open to all staff, so this is the one action not admin-gated. */
  async function bumpStock(item: MenuItem, delta: number) {
    setErr('')
    try {
      await api.adjustStock(item.drink_id, delta)
      await load()
    } catch (e) {
      setErr((e as Error).message)
    }
  }

  const fields = (
    <MenuItemFields draft={draft} setDraft={setDraft} isNew={!editing} err={err} />
  )

  return (
    <>
      <div className="head">
        <div>
          <h2>Мени</h2>
          <p>Пијалаци што гостинот ги гледа на терминалот.</p>
        </div>
        {isAdmin && isMobile && (
          <button className="gold" onClick={startCreate}>
            + Нов пијалак
          </button>
        )}
      </div>

      {warning && <div className="banner">{warning}</div>}

      <div className={isAdmin && !isMobile ? 'split' : ''}>
        <div className="menu-grid">
          {items.length === 0 && <Empty title="Нема пијалаци" hint="Додадете преку формата." />}
          {items.map((item, idx) => (
            <div
              key={item.drink_id}
              className={
                'menu-card' +
                (orderable(item) ? '' : ' unavailable') +
                (editing?.drink_id === item.drink_id && formOpen ? ' editing' : '')
              }
              style={{ animationDelay: `${idx * 0.04}s` }}
              onClick={isAdmin ? () => startEdit(item) : undefined}
            >
              <div className="menu-card-top">
                <span className="mono muted">#{item.drink_id}</span>
                <span className={'menu-dot' + (orderable(item) ? ' on' : '')} />
              </div>
              <div className="menu-card-name">{item.name}</div>
              <div className="menu-card-price">
                <span className="money gold">{mkd(item.price_deni)} ден.</span>
                {item.points_price > 0 && (
                  <span className="mono muted" style={{ fontSize: 12 }}>
                    {item.points_price} п.
                  </span>
                )}
              </div>
              {item.stock_qty !== null && (
                <div className="menu-card-stock" onClick={(e) => e.stopPropagation()}>
                  <button
                    className="ghost"
                    disabled={item.stock_qty === 0}
                    onClick={() => void bumpStock(item, -1)}
                    aria-label={`Намали залиха за ${item.name}`}
                  >
                    −
                  </button>
                  <span className={'stock-count' + stockTone(item.stock_qty)}>
                    {item.stock_qty === 0 ? 'нема залиха' : `${item.stock_qty} на залиха`}
                  </span>
                  <button
                    className="ghost"
                    onClick={() => void bumpStock(item, 1)}
                    aria-label={`Зголеми залиха за ${item.name}`}
                  >
                    +
                  </button>
                </div>
              )}
              {isAdmin && (
                <div className="menu-card-actions" onClick={(e) => e.stopPropagation()}>
                  <button className="ghost" onClick={() => void toggle(item)}>
                    {item.available ? 'Исклучи' : 'Вклучи'}
                  </button>
                  <span className="menu-card-arrows">
                    <button
                      className="ghost"
                      disabled={idx === 0}
                      onClick={() => void swap(item, items[idx - 1])}
                      aria-label="Нагоре"
                    >
                      ↑
                    </button>
                    <button
                      className="ghost"
                      disabled={idx === items.length - 1}
                      onClick={() => void swap(item, items[idx + 1])}
                      aria-label="Надолу"
                    >
                      ↓
                    </button>
                  </span>
                </div>
              )}
            </div>
          ))}
        </div>

        {isAdmin && !isMobile && (
          <form className="card" onSubmit={editing ? save : create}>
            <h3>{editing ? `Измени: ${editing.name}` : 'Нов пијалак'}</h3>
            {fields}
            {editing ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <button className="gold" type="submit" style={{ width: '100%' }}>
                  Зачувај
                </button>
                <button
                  className="danger"
                  type="button"
                  style={{ width: '100%' }}
                  onClick={() => setDeleting(editing)}
                >
                  Избриши
                </button>
                <button className="ghost" type="button" style={{ width: '100%' }} onClick={exitEdit}>
                  Откажи
                </button>
              </div>
            ) : (
              <button className="gold" type="submit" style={{ width: '100%' }}>
                Додади
              </button>
            )}
          </form>
        )}
      </div>

      {/*
        Dialog renders its own <form>, and a nested form is invalid HTML that
        React silently mis-submits — so the shared piece is the FIELDS, and each
        layout brings its own wrapper and buttons.
      */}
      {isAdmin && isMobile && formOpen && (
        <Dialog
          title={editing ? `Измени: ${editing.name}` : 'Нов пијалак'}
          onClose={exitEdit}
          footer={
            <>
              {editing && (
                <button type="button" className="danger" onClick={() => setDeleting(editing)}>
                  Избриши
                </button>
              )}
              <button type="button" className="ghost" onClick={exitEdit}>
                Откажи
              </button>
              <button
                type="button"
                className="gold"
                onClick={(e) => void (editing ? save(e) : create(e))}
              >
                {editing ? 'Зачувај' : 'Додади'}
              </button>
            </>
          }
        >
          {fields}
        </Dialog>
      )}

      {deleting && (
        <ConfirmDialog
          title="Избриши пијалак"
          body={
            <p>
              Избриши го <strong>{deleting.name}</strong>? Историјата на нарачки останува зачувана.
            </p>
          }
          confirmLabel="Избриши"
          danger
          onConfirm={() => void confirmDelete()}
          onClose={() => setDeleting(null)}
        />
      )}
    </>
  )
}

/** Low stock is the whole point of the badge, so it has to read at a glance. */
function stockTone(stock: number): string {
  if (stock === 0) return ' out'
  if (stock <= 5) return ' low'
  return ''
}

/**
 * Fields only — no <form> element. The desktop column wraps these in one for
 * Enter-to-submit; the mobile modal puts them inside Dialog's own form.
 */
function MenuItemFields({
  draft,
  setDraft,
  isNew,
  err
}: {
  draft: Draft
  setDraft: (d: Draft) => void
  isNew: boolean
  err: string
}) {
  return (
    <>
      <div className="err">{err}</div>
      {isNew && (
        <div className="field">
          <label>Реден број (drink id)</label>
          <input
            type="number"
            value={draft.drink_id || ''}
            onChange={(e) => setDraft({ ...draft, drink_id: Number(e.target.value) })}
            required
          />
        </div>
      )}
      <div className="field">
        <label>Име</label>
        <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} required />
      </div>
      <div className="field">
        <label>Цена во денари</label>
        <input
          type="number"
          step="0.01"
          value={draft.price_deni || ''}
          onChange={(e) => setDraft({ ...draft, price_deni: Number(e.target.value) })}
          required
        />
      </div>
      <div className="field">
        <label>Цена во поени (0 = не може)</label>
        <input
          type="number"
          value={draft.points_price}
          onChange={(e) => setDraft({ ...draft, points_price: Number(e.target.value) })}
        />
      </div>
      <div className="field">
        <label>Залиха (празно = неограничено)</label>
        <input
          type="number"
          min="0"
          value={draft.stock}
          placeholder="неограничено"
          onChange={(e) =>
            setDraft({ ...draft, stock: e.target.value === '' ? '' : Number(e.target.value) })
          }
        />
      </div>
      <div className="field">
        <label>ДДВ стапка (за фискална сметка)</label>
        <select
          value={draft.vat_type}
          onChange={(e) => setDraft({ ...draft, vat_type: e.target.value as VatType })}
        >
          {(Object.entries(VAT_LABELS) as Array<[VatType, string]>).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </div>
      <label className="row">
        <input
          type="checkbox"
          checked={draft.is_domestic}
          onChange={(e) => setDraft({ ...draft, is_domestic: e.target.checked })}
        />
        <span>Домашно производство</span>
      </label>
    </>
  )
}
