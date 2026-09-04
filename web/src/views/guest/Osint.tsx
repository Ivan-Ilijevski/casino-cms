import { useState } from 'react'
import { api, type OsintReason } from '../../api'
import { Empty, Err } from '../../components/Bits'
import { availableSources, GROUPS, REASONS, type OsintSource } from '../../osint'
import { useGuest } from '../GuestProfile'

/**
 * Public-source research for KYC/AML due diligence.
 *
 * This panel opens websites. It does not fetch, scrape, store or enrich
 * anything — the CMS never sees a result. What it does record is that a lookup
 * happened: who ran it, on whom, against which source and why. That record is
 * the condition on which the panel exists, so the flow is deliberately built
 * with no way around it:
 *
 *   1. A reason must be picked before any tile is live.
 *   2. The click opens a blank tab SYNCHRONOUSLY (a popup blocker will not let
 *      window.open survive an await), then the audit write is awaited, and only
 *      on success does the tab get its destination. A failed write closes the
 *      tab rather than letting an unlogged lookup through.
 */
export function Osint() {
  const { customer } = useGuest()
  const player = customer.player
  const [reason, setReason] = useState<OsintReason | ''>('')
  const [err, setErr] = useState('')
  const [pending, setPending] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  const sources = availableSources(player)
  const missing = ['phone', 'email', 'city'].filter((f) => !player[f as 'phone' | 'email' | 'city'])

  async function launch(source: OsintSource) {
    if (!reason) return
    setErr('')
    setPending(source.id)

    // Opened here, on the gesture, so the browser does not treat it as a popup.
    // Deliberately WITHOUT the noopener feature: that makes window.open return
    // null by spec, and the handle is the whole point — without it the CMS tab
    // itself navigates to the source and the staff member loses their place.
    // The opener reference is severed below instead, which protects the same
    // thing (tabnabbing) while keeping the handle.
    const tab = window.open('', '_blank')
    try {
      await api.osintLookup(player.id, source.id, reason)

      if (source.mode === 'manual') {
        await navigator.clipboard?.writeText(source.term(player)).catch(() => {})
        setCopied(source.id)
        setTimeout(() => setCopied(null), 4000)
      }
      if (tab) {
        tab.opener = null
        tab.location.href = source.url(player)
      } else {
        // Popup blocked outright — fall back rather than losing the lookup.
        window.location.href = source.url(player)
      }
    } catch (e) {
      tab?.close()
      setErr(`Пребарувањето не е запишано, па не е ни отворено: ${(e as Error).message}`)
    } finally {
      setPending(null)
    }
  }

  return (
    <>
      <div className="card osint-intro">
        <h3>Истражување од јавни извори</h3>
        <p>
          Овие плочки отвораат <strong>јавни веб-страници</strong> во нов прозорец. CMS не презема,
          не чува и не обработува ништо од нив — единственото што се запишува е дека сте отвориле
          извор за овој гостин, кој сте и зошто. Записот е видлив во <strong>Дневник</strong>.
        </p>
        <p className="muted">
          Користете само за законски обврски: потврда на идентитет, спречување перење пари,
          самоисклучување или спор. Резултатите се индиции, не доказ — потврдете пред да преземете
          дејство.
        </p>
      </div>

      <div className="card osint-reason">
        <label htmlFor="osint-reason">Причина за пребарување</label>
        <select
          id="osint-reason"
          value={reason}
          onChange={(e) => setReason(e.target.value as OsintReason)}
        >
          <option value="">— изберете причина —</option>
          {REASONS.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </select>
        <div className={reason ? 'hint' : 'hint over'}>
          {reason
            ? 'Изворите се отклучени. Причината се запишува со секое отворање.'
            : 'Изборите се заклучени додека не изберете причина.'}
        </div>
      </div>

      <Err>{err}</Err>

      {missing.length > 0 && (
        <div className="banner">
          Гостинот нема{' '}
          {missing
            .map((m) => ({ phone: 'телефон', email: 'е-пошта', city: 'град' })[m as 'phone'])
            .join(', ')}{' '}
          — дел од изворите не се достапни. Дополнете ги во <strong>Преглед</strong>.
        </div>
      )}

      {sources.length === 0 ? (
        <Empty title="Нема достапен извор" hint="Внесете барем име на гостинот." />
      ) : (
        GROUPS.map((group) => {
          const inGroup = sources.filter((s) => s.group === group)
          if (inGroup.length === 0) return null
          return (
            <section key={group} className="osint-group">
              <h4>{group}</h4>
              <div className="osint-grid">
                {inGroup.map((s, i) => (
                  <button
                    key={s.id}
                    className="osint-src"
                    style={{ '--i': i } as React.CSSProperties}
                    disabled={!reason || pending === s.id}
                    onClick={() => void launch(s)}
                  >
                    <span className="osint-top">
                      <span className="osint-label">{s.label}</span>
                      <span className={s.mode === 'query' ? 'tag active' : 'tag maybe'}>
                        {s.mode === 'query' ? 'директно' : 'рачно'}
                      </span>
                    </span>
                    <span className="osint-hint muted">{s.hint}</span>
                    <span className="osint-term mono">{s.term(player)}</span>
                    {copied === s.id && <span className="osint-copied">залепено во меморија</span>}
                  </button>
                ))}
              </div>
            </section>
          )
        })
      )}

      <p className="muted osint-foot">
        „Рачно“ значи дека страницата нема пребарување преку адреса — терминот се копира во
        меморија, залепете го на самата страница.
      </p>
    </>
  )
}
