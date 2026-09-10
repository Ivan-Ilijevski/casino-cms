import { useState } from 'react'
import { Dialog } from './Dialog'

const PRESETS = [5, 10, 15, 20, 30]
const DEFAULT_MINUTES = 10
const MAX_MINUTES = 240

/**
 * The clock time an estimate lands on, which is what the guest is actually told.
 * hour12 pinned off: mk-MK is missing on some Android builds and the en-US
 * fallback would promise "08:27 PM".
 */
function readyAt(minutes: number): string {
  const at = new Date(Date.now() + minutes * 60000)
  return at.toLocaleTimeString('mk-MK', { hour: '2-digit', minute: '2-digit', hour12: false })
}

/**
 * Asked once, when an order is accepted. The board then counts down to the
 * answer, so „кога ќе биде готова" is a promise rather than a guess nobody sees.
 *
 * Sends minutes, never a timestamp — the server owns the clock, so a tablet
 * running slow cannot promise a time that has already passed.
 */
export function EtaDialog({
  orderNumber,
  guest,
  busy,
  onAccept,
  onClose
}: {
  orderNumber: number
  guest: string
  busy?: boolean
  onAccept: (minutes: number) => void
  onClose: () => void
}) {
  const [minutes, setMinutes] = useState(DEFAULT_MINUTES)
  const [custom, setCustom] = useState('')

  // A typed value wins while it is valid; clearing the box falls back to the pills.
  const typed = custom === '' ? null : Number(custom)
  const effective = typed !== null && Number.isInteger(typed) ? typed : minutes
  const valid = Number.isInteger(effective) && effective >= 1 && effective <= MAX_MINUTES

  return (
    <Dialog
      title="Кога ќе биде готова?"
      sub={`Нарачка #${orderNumber} · ${guest}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="ghost" onClick={onClose}>
            Откажи
          </button>
          <button
            type="button"
            className="gold"
            disabled={!valid || busy}
            onClick={() => onAccept(effective)}
          >
            {busy ? 'Се прифаќа…' : `Прифати · ${valid ? readyAt(effective) : '—'}`}
          </button>
        </>
      }
    >
      <div className="eta-presets">
        {PRESETS.map((m) => (
          <button
            key={m}
            type="button"
            className={effective === m ? 'pill on' : 'pill'}
            onClick={() => {
              setMinutes(m)
              setCustom('')
            }}
          >
            {m} мин
          </button>
        ))}
      </div>

      <div className="field">
        <label htmlFor="eta-custom">Или внесете минути</label>
        <input
          id="eta-custom"
          type="number"
          inputMode="numeric"
          min={1}
          max={MAX_MINUTES}
          placeholder={String(minutes)}
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
        />
        <div className={valid ? 'hint' : 'hint over'}>
          {valid ? `Готова околу ${readyAt(effective)}.` : `Од 1 до ${MAX_MINUTES} минути.`}
        </div>
      </div>
    </Dialog>
  )
}
