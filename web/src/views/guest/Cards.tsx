import { useState } from 'react'
import { api, mkd, type CustomerCard } from '../../api'
import { Err } from '../../components/Bits'
import { ConfirmDialog, Dialog } from '../../components/Dialog'
import { fmtDate, fmtDateTime } from '../../format'
import { useGuest } from '../GuestProfile'

export function Cards({ isAdmin }: { isAdmin: boolean }) {
  const { customer, reload } = useGuest()
  const [err, setErr] = useState('')
  const [adjusting, setAdjusting] = useState<CustomerCard | null>(null)
  const [pinning, setPinning] = useState<CustomerCard | null>(null)
  const [blocking, setBlocking] = useState<CustomerCard | null>(null)
  const [busy, setBusy] = useState(false)

  async function toggleBlock(card: CustomerCard) {
    setBusy(true)
    setErr('')
    try {
      await (card.status === 'blocked' ? api.unblock(card.id) : api.block(card.id))
      setBlocking(null)
      await reload()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Err>{err}</Err>

      <div className="grid">
        {customer.cards.map((c) => {
          const locked = c.pin_locked_until && new Date(c.pin_locked_until.replace(' ', 'T') + 'Z') > new Date()
          return (
            <div key={c.id} className={c.status === 'blocked' ? 'card cardface blocked' : 'card cardface'}>
              <div className="cardface-top">
                <span className="mono cardface-uid">{c.card_uid}</span>
                <div className="chips">
                  <span className={c.status === 'blocked' ? 'tag blocked' : 'tag active'}>
                    {c.status === 'blocked' ? 'блокирана' : 'активна'}
                  </span>
                  {!c.has_pin && (
                    <span className="tag nopin" title="Не може да плаќа на касата">
                      без пин
                    </span>
                  )}
                  {locked && <span className="tag locked">заклучена</span>}
                </div>
              </div>

              <div className="cardface-money">
                <div>
                  <div className="k">Состојба</div>
                  <div className="v money">{mkd(c.balance_deni)}</div>
                </div>
                <div>
                  <div className="k">Поени</div>
                  <div className="v">{c.points}</div>
                </div>
              </div>

              <dl className="dl tight">
                <div className="dl-row">
                  <dt className="dl-k">Канонски UID</dt>
                  <dd className="dl-v mono muted">{c.card_uid_canon ?? '—'}</dd>
                </div>
                <div className="dl-row">
                  <dt className="dl-k">Регистрирана</dt>
                  <dd className="dl-v">{fmtDate(c.created_at)}</dd>
                </div>
                <div className="dl-row">
                  <dt className="dl-k">Погрешни ПИН обиди</dt>
                  <dd className="dl-v">
                    {c.pin_failed_attempts}
                    <span className="muted"> / 5</span>
                  </dd>
                </div>
                {locked && (
                  <div className="dl-row">
                    <dt className="dl-k">Заклучена до</dt>
                    <dd className="dl-v crimson">{fmtDateTime(c.pin_locked_until)}</dd>
                  </div>
                )}
              </dl>

              {isAdmin && (
                <div className="cardface-acts">
                  <button onClick={() => setPinning(c)}>{c.has_pin ? 'Смени ПИН' : 'Постави ПИН'}</button>
                  <button onClick={() => setAdjusting(c)}>Корекција</button>
                  <button className="danger" onClick={() => setBlocking(c)}>
                    {c.status === 'blocked' ? 'Одблокирај' : 'Блокирај'}
                  </button>
                </div>
              )}
            </div>
          )
        })}
      </div>

      {adjusting && (
        <AdjustDialog
          card={adjusting}
          onClose={() => setAdjusting(null)}
          onDone={async () => {
            setAdjusting(null)
            await reload()
          }}
        />
      )}

      {pinning && (
        <PinDialog
          card={pinning}
          onClose={() => setPinning(null)}
          onDone={async () => {
            setPinning(null)
            await reload()
          }}
        />
      )}

      {blocking && (
        <ConfirmDialog
          title={blocking.status === 'blocked' ? 'Одблокирај картичка' : 'Блокирај картичка'}
          danger={blocking.status !== 'blocked'}
          busy={busy}
          confirmLabel={blocking.status === 'blocked' ? 'Одблокирај' : 'Блокирај'}
          body={
            blocking.status === 'blocked' ? (
              <p>
                Картичката <span className="mono">{blocking.card_uid}</span> повторно ќе може да се
                најавува и да плаќа.
              </p>
            ) : (
              <>
                <p>
                  Картичката <span className="mono">{blocking.card_uid}</span> веднаш ќе биде
                  одјавена од машината ако е во сесија, и нема да може да плаќа.
                </p>
                <p className="muted">
                  Состојбата од {mkd(blocking.balance_deni)} останува на картичката.
                </p>
              </>
            )
          }
          onConfirm={() => void toggleBlock(blocking)}
          onClose={() => setBlocking(null)}
        />
      )}
    </>
  )
}

/**
 * Replaces two chained prompt() calls that parsed with Number() and showed the
 * staff member nothing before committing. Denars in, deni out — the conversion
 * happens here and nowhere else in this screen.
 */
function AdjustDialog({
  card,
  onClose,
  onDone
}: {
  card: CustomerCard
  onClose: () => void
  onDone: () => void
}) {
  const [unit, setUnit] = useState<'deni' | 'points'>('deni')
  const [raw, setRaw] = useState('')
  const [reason, setReason] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const parsed = Number(raw.replace(',', '.'))
  const valid = raw.trim() !== '' && Number.isFinite(parsed) && parsed !== 0
  const amount = unit === 'deni' ? Math.round(parsed * 100) : Math.round(parsed)
  const current = unit === 'deni' ? card.balance_deni : card.points
  const after = current + (valid ? amount : 0)

  async function save() {
    setErr('')
    setBusy(true)
    try {
      await api.adjust(card.id, unit, amount, reason)
      onDone()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      title="Рачна корекција"
      sub={`Картичка ${card.card_uid}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="ghost" onClick={onClose}>
            Откажи
          </button>
          <button
            type="button"
            className="gold"
            disabled={!valid || after < 0 || !reason.trim() || busy}
            onClick={save}
          >
            {busy ? 'Се запишува…' : 'Потврди корекција'}
          </button>
        </>
      }
    >
      <Err>{err}</Err>

      <div className="seg">
        <button type="button" className={unit === 'deni' ? 'on' : ''} onClick={() => setUnit('deni')}>
          Денари
        </button>
        <button type="button" className={unit === 'points' ? 'on' : ''} onClick={() => setUnit('points')}>
          Поени
        </button>
      </div>

      <div className="field">
        <label>{unit === 'deni' ? 'Износ во денари' : 'Поени'}</label>
        <input
          className="mono"
          inputMode="decimal"
          placeholder="500 или -500"
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          autoFocus
        />
        <div className="hint">Позитивно додава, негативно одзема.</div>
      </div>

      {/* The whole point of the dialog: see the result before committing. */}
      <div className="preview">
        <div>
          <div className="k">Сега</div>
          <div className="v money">{unit === 'deni' ? mkd(current) : current}</div>
        </div>
        <div className="arrow" aria-hidden="true">
          →
        </div>
        <div>
          <div className="k">По корекцијата</div>
          <div className={after < 0 ? 'v money crimson' : 'v money gold'}>
            {unit === 'deni' ? mkd(after) : after}
          </div>
        </div>
      </div>
      {after < 0 && <div className="err">Корекцијата би ја однела состојбата под нула.</div>}

      <div className="field">
        <label>Причина</label>
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="пр. компензација за прекин на машина"
        />
        <div className="hint">Се запишува во дневникот заедно со вашето име.</div>
      </div>
    </Dialog>
  )
}

function PinDialog({
  card,
  onClose,
  onDone
}: {
  card: CustomerCard
  onClose: () => void
  onDone: () => void
}) {
  const [pin, setPin] = useState('')
  const [again, setAgain] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const match = pin.length === 4 && pin === again

  async function save() {
    setErr('')
    setBusy(true)
    try {
      await api.setPin(card.id, pin)
      onDone()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      title={card.has_pin ? 'Смени ПИН' : 'Постави ПИН'}
      sub={`Картичка ${card.card_uid} · поставувањето го отклучува ПИН заклучувањето`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="ghost" onClick={onClose}>
            Откажи
          </button>
          <button type="button" className="gold" disabled={!match || busy} onClick={save}>
            {busy ? 'Се зачувува…' : 'Зачувај ПИН'}
          </button>
        </>
      }
    >
      <Err>{err}</Err>
      <div className="field">
        <label>Нов ПИН (4 цифри)</label>
        <input
          className="mono pin-input"
          type="password"
          inputMode="numeric"
          maxLength={4}
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
          autoFocus
        />
      </div>
      <div className="field">
        <label>Повторете го</label>
        <input
          className="mono pin-input"
          type="password"
          inputMode="numeric"
          maxLength={4}
          value={again}
          onChange={(e) => setAgain(e.target.value.replace(/\D/g, ''))}
        />
        {again.length === 4 && !match && <div className="hint over">ПИН-овите не се совпаѓаат.</div>}
      </div>
      <div className="hint">
        Се бара на секое осмо плаќање на касата. По 5 погрешни обиди картичката се заклучува за 15
        минути.
      </div>
    </Dialog>
  )
}
