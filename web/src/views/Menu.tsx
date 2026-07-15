import { useEffect, useState } from 'react'
import { api, mkd, type MenuItem } from '../api'

const EMPTY = { drink_id: 0, name: '', price_deni: 0, points_price: 0 }

export function Menu({ isAdmin }: { isAdmin: boolean }) {
  const [items, setItems] = useState<MenuItem[]>([])
  const [warning, setWarning] = useState<string | null>(null)
  const [draft, setDraft] = useState({ ...EMPTY })
  const [err, setErr] = useState('')

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

  async function create(e: React.FormEvent) {
    e.preventDefault()
    setErr('')
    try {
      await api.createDrink({
        drink_id: Number(draft.drink_id),
        name: draft.name,
        price_deni: Math.round(Number(draft.price_deni) * 100),
        points_price: Number(draft.points_price)
      })
      setDraft({ ...EMPTY })
      await load()
    } catch (e) {
      setErr((e as Error).message)
    }
  }

  return (
    <>
      <div className="head">
        <div>
          <h2>Мени</h2>
          <p>Пијалаци што гостинот ги гледа на терминалот.</p>
        </div>
      </div>

      {warning && <div className="banner">{warning}</div>}

      <div className="split">
        <div className="card scroll">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Пијалак</th>
                <th className="num">Цена (ден.)</th>
                <th className="num">Поени</th>
                <th>Состојба</th>
                {isAdmin && <th />}
              </tr>
            </thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.drink_id}>
                  <td className="mono muted">{i.drink_id}</td>
                  <td style={{ fontWeight: 600 }}>{i.name}</td>
                  <td className="num">{mkd(i.price_deni)}</td>
                  <td className="num muted">{i.points_price || '—'}</td>
                  <td>
                    <span className={`tag ${i.available ? 'fulfilled' : 'cancelled'}`}>
                      {i.available ? 'достапно' : 'нема'}
                    </span>
                  </td>
                  {isAdmin && (
                    <td style={{ textAlign: 'right' }}>
                      <button onClick={() => void toggle(i)}>{i.available ? 'Исклучи' : 'Вклучи'}</button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {isAdmin && (
          <form className="card" onSubmit={create}>
            <h3>Нов пијалак</h3>
            <div className="err">{err}</div>
            <div className="field">
              <label>Реден број (drink id)</label>
              <input
                type="number"
                value={draft.drink_id || ''}
                onChange={(e) => setDraft({ ...draft, drink_id: Number(e.target.value) })}
                required
              />
            </div>
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
            <button className="gold" type="submit" style={{ width: '100%' }}>
              Додади
            </button>
          </form>
        )}
      </div>
    </>
  )
}
