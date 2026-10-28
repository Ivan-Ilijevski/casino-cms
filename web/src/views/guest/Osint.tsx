import { useCallback, useEffect, useState } from 'react'
import { api, timeAgo, type OsintOverview, type OsintReason } from '../../api'
import { Empty, Err } from '../../components/Bits'
import { availableSources, GROUPS, reasonShort, REASONS, type OsintContext, type OsintSource } from '../../osint'
import { useGuest } from '../GuestProfile'
import { GuestPhoto } from './GuestPhoto'
import { OsintAi } from './OsintAi'

/**
 * Public-source research for KYC/AML due diligence. Two halves, with different
 * rules, sharing one reason picker:
 *
 * AI screening (OsintAi) — the server runs Claude/Codex, which DOES send guest
 * details to those providers and DOES store the report until it is deleted.
 *
 * Link tiles (below) — these open websites. They do not fetch, scrape, store or
 * enrich anything; the CMS never sees a result. What is recorded is that a
 * lookup happened: who ran it, on whom, against which source and why. That
 * record is the condition on which the tiles exist, so the flow is built with
 * no way around it:
 *
 *   1. A reason must be picked before any tile is live.
 *   2. The click opens a blank tab SYNCHRONOUSLY (a popup blocker will not let
 *      window.open survive an await), then the audit write is awaited, and only
 *      on success does the tab get its destination. A failed write closes the
 *      tab rather than letting an unlogged lookup through.
 */
export function Osint() {
  const { customer, reload } = useGuest()
  const player = customer.player
  const [reason, setReason] = useState<OsintReason | ''>('')
  const [overview, setOverview] = useState<OsintOverview | null>(null)
  const [err, setErr] = useState('')
  const [pending, setPending] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  const loadOverview = useCallback(async () => {
    try {
      setOverview(await api.osintOverview(player.id))
    } catch (e) {
      setErr((e as Error).message)
    }
  }, [player.id])

  useEffect(() => {
    setOverview(null)
    void loadOverview()
  }, [loadOverview])

  const ctx: OsintContext = { player, variants: overview?.variants ?? [player.name] }
  const sources = availableSources(player)
  const missing = ['phone', 'email', 'city'].filter((f) => !player[f as 'phone' | 'email' | 'city'])

  function flashCopied(key: string) {
    setCopied(key)
    setTimeout(() => setCopied((c) => (c === key ? null : c)), 4000)
  }

  async function copyVariant(v: string) {
    await navigator.clipboard?.writeText(v).catch(() => {})
    flashCopied(`variant:${v}`)
  }

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
        await navigator.clipboard?.writeText(source.term(ctx)).catch(() => {})
        flashCopied(source.id)
      }
      if (tab) {
        tab.opener = null
        tab.location.href = source.url(ctx)
      } else {
        // Popup blocked outright — fall back rather than losing the lookup.
        window.location.href = source.url(ctx)
      }
      void loadOverview()
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
          <strong>AI проверка</strong> — серверот ги праќа податоците на гостинот (без број на документ) до Claude
          и/или Codex, кои пребаруваат на интернет и враќаат извештај со извори. Извештајот се чува додека не го
          избришете.
        </p>
        <p>
          <strong>Плочките</strong> отвораат јавни веб-страници во нов прозорец. CMS не презема и не чува ништо од
          нив — се запишува само дека сте отвориле извор, кој сте и зошто.
        </p>
        <p className="muted">
          И двете се запишуваат во <strong>Дневник</strong>. Користете само за законски обврски: потврда на
          идентитет, спречување перење пари, самоисклучување или спор. Резултатите се индиции, не доказ — потврдете
          пред да преземете дејство.
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
            ? 'Изворите се отклучени. Причината се запишува со секое отворање и секоја AI проверка.'
            : 'Изборите се заклучени додека не изберете причина.'}
        </div>
      </div>

      <Err>{err}</Err>

      {overview && (reason === 'profile' || overview.photo) && (
        <GuestPhoto playerId={player.id} photo={overview.photo} onChanged={loadOverview} />
      )}

      <OsintAi
        player={player}
        overview={overview}
        reason={reason}
        guestTags={customer.tags}
        onChanged={loadOverview}
        onTagsChanged={reload}
      />

      <h4 className="osint-section-title">Јавни извори</h4>

      {missing.length > 0 && (
        <div className="banner">
          Гостинот нема{' '}
          {missing
            .map((m) => ({ phone: 'телефон', email: 'е-пошта', city: 'град' })[m as 'phone'])
            .join(', ')}{' '}
          — дел од изворите не се достапни. Дополнете ги во <strong>Преглед</strong>.
        </div>
      )}

      {ctx.variants.length > 1 && (
        <div className="osint-variants">
          <span className="muted">Варијанти на името:</span>
          {ctx.variants.map((v) => (
            <button key={v} type="button" className="osint-variant" onClick={() => void copyVariant(v)}>
              {v}
              {copied === `variant:${v}` && <span className="osint-copied"> копирано</span>}
            </button>
          ))}
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
                {inGroup.map((s, i) => {
                  const history = overview?.lookups[s.id]
                  return (
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
                      <span className="osint-term mono">{s.term(ctx)}</span>
                      {history && (
                        <span className="osint-history-line muted">
                          отворено {history.count}× · {timeAgo(history.last_at)} · {history.last_actor} ·{' '}
                          {reasonShort(history.last_reason)}
                        </span>
                      )}
                      {copied === s.id && <span className="osint-copied">залепено во меморија</span>}
                    </button>
                  )
                })}
              </div>
            </section>
          )
        })
      )}

      <p className="muted osint-foot">
        „Рачно“ значи дека страницата нема пребарување преку адреса — терминот се копира во меморија, залепете го на
        самата страница. Кирилица се користи за македонски регистри, латиница за странски листи и мрежи.
      </p>
    </>
  )
}
