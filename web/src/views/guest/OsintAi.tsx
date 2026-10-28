import { useCallback, useEffect, useRef, useState } from 'react'
import {
  api,
  type OsintEngine,
  type OsintEngineChoice,
  type OsintOverview,
  type OsintReason,
  type OsintRun,
  type Player
} from '../../api'
import { Err } from '../../components/Bits'
import { fmtDateTime, fmtDuration, sqlMs } from '../../format'
import { reasonShort } from '../../osint'
import { ActivityFeed } from './OsintActivity'
import { ENGINE_LABEL, enginesLabel, FIELD_MK, OsintReport, verdictLabel } from './OsintReport'

const POLL_MS = 3000

const PROVIDER: Record<OsintEngine, string> = { claude: 'Anthropic', codex: 'OpenAI' }

const CHOICES: Array<{ value: OsintEngineChoice; label: string; needs: OsintEngine[] }> = [
  { value: 'both', label: 'Двата (вкрстена проверка)', needs: ['claude', 'codex'] },
  { value: 'claude', label: 'Claude', needs: ['claude'] },
  { value: 'codex', label: 'Codex', needs: ['codex'] }
]

interface Props {
  player: Player
  overview: OsintOverview | null
  reason: OsintReason | ''
  guestTags: string[]
  /** Refetches the tab overview (run history, link history). */
  onChanged: () => Promise<void>
  /** Refetches the guest header, whose tag chips an applied tag changes. */
  onTagsChanged: () => Promise<void>
}

/**
 * AI screening: the server runs the Claude and/or Codex CLI against the web and
 * files a cited report. This is the part of the tab that DOES send guest
 * details off-site and DOES keep what comes back, so the panel says exactly
 * which fields go to which provider before the button is pressed, and every
 * report can be deleted outright.
 */
export function OsintAi({ player, overview, reason, guestTags, onChanged, onTagsChanged }: Props) {
  const engines = overview?.engines ?? { claude: false, codex: false }
  const usable = (c: (typeof CHOICES)[number]) => c.needs.every((e) => engines[e])

  const [choice, setChoice] = useState<OsintEngineChoice>('both')
  const [openId, setOpenId] = useState<string | null>(null)
  const [run, setRun] = useState<OsintRun | null>(null)
  const [err, setErr] = useState('')
  const [starting, setStarting] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const sawRunning = useRef(false)
  // Deleted runs linger in `overview` until it refetches; without this the
  // auto-open below would reopen a run that was just deleted and 404 on it.
  const deleted = useRef(new Set<string>())

  // Land on the best engine choice this host can actually run.
  useEffect(() => {
    if (!overview) return
    const current = CHOICES.find((c) => c.value === choice)
    if (current && usable(current)) return
    const first = CHOICES.find(usable)
    if (first) setChoice(first.value)
  }, [overview?.engines.claude, overview?.engines.codex])

  // A run already in progress (another tab, a reload) opens by itself.
  useEffect(() => {
    if (openId || !overview) return
    const running = overview.runs.find((r) => r.status === 'running' && !deleted.current.has(r.id))
    if (running) setOpenId(running.id)
  }, [overview, openId])

  // Poll the open run while it is still searching.
  useEffect(() => {
    if (!openId) {
      setRun(null)
      return
    }
    let cancelled = false
    let timer: number | undefined

    const tick = async () => {
      try {
        const r = await api.osintRun(player.id, openId)
        if (cancelled) return
        setRun(r)
        if (r.status === 'running') {
          sawRunning.current = true
          timer = window.setTimeout(() => void tick(), POLL_MS)
        } else if (sawRunning.current) {
          sawRunning.current = false
          void onChanged()
        }
      } catch (e) {
        if (cancelled) return
        if (!deleted.current.has(openId)) setErr((e as Error).message)
        setOpenId(null)
      }
    }
    void tick()
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [openId, player.id])

  // The elapsed clock only needs to tick while something is running.
  useEffect(() => {
    if (run?.status !== 'running') return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [run?.status])

  const selected = CHOICES.find((c) => c.value === choice) ?? CHOICES[0]!
  const anyEngine = engines.claude || engines.codex
  const busy = overview?.runs.some((r) => r.status === 'running' && !deleted.current.has(r.id)) ?? false

  async function start() {
    if (!reason) return
    setErr('')
    setStarting(true)
    try {
      const { run: started } = await api.osintStartRun(player.id, reason, choice)
      sawRunning.current = true
      setRun(started)
      setOpenId(started.id)
      await onChanged()
    } catch (e) {
      setErr((e as Error).message)
      await onChanged()
    } finally {
      setStarting(false)
    }
  }

  async function remove() {
    if (!run) return
    const what = run.status === 'running' ? 'Да се прекине проверката и да се избрише?' : 'Да се избрише извештајот?'
    if (!window.confirm(`${what} Наодите се бришат трајно; во Дневник останува само записот дека проверката постоела.`)) {
      return
    }
    setErr('')
    setDeleting(true)
    deleted.current.add(run.id)
    try {
      await api.osintDeleteRun(player.id, run.id)
      sawRunning.current = false
      setOpenId(null)
      await onChanged()
    } catch (e) {
      deleted.current.delete(run.id)
      setErr((e as Error).message)
    } finally {
      setDeleting(false)
    }
  }

  // After a photo is deleted or faces are compared, the open report needs the new image rows.
  const reloadRun = useCallback(async () => {
    if (!openId) return
    try {
      setRun(await api.osintRun(player.id, openId))
    } catch (e) {
      setErr((e as Error).message)
    }
  }, [openId, player.id])

  async function applyTag(tag: string) {
    if (!run) return
    setErr('')
    try {
      await api.osintApplyTag(player.id, run.id, tag)
      await onTagsChanged()
    } catch (e) {
      setErr((e as Error).message)
    }
  }

  const disclosed = overview?.disclosed ?? []
  const providers = selected.needs.map((e) => PROVIDER[e]).join(' и ')
  const profile = reason === 'profile'
  // Engines finished but the run is still open: a profile run is downloading its photos.
  const fetchingImages =
    run?.status === 'running' && run.reason === 'profile' && run.results.every((r) => r.status !== 'running')

  return (
    <section className="osint-ai">
      <h4 className="osint-section-title">AI проверка</h4>

      <div className="card osint-ai-launch">
        {profile ? (
          <p>
            <strong>Општ профил:</strong> Claude и/или Codex бараат сè што е јавно достапно за гостинот — онлајн
            сметки, работа, образование, бизнис, медиуми, интереси и ризици — и ги собираат фотографиите од
            страниците за кои се сигурни дека се за гостинот. Здравје, религија, етничка припадност, адреса и
            семејство не се бараат. Секој наод мора да има извор.
          </p>
        ) : (
          <p>
            Серверот ги пушта <strong>Claude</strong> и/или <strong>Codex</strong> да пребаруваат санкциски листи,
            ПЕП, негативни медиуми, судски и деловни регистри, на кирилица и латиница. Секој наод мора да има
            извор; наодите без извор се отфрлаат.
          </p>
        )}

        {overview && !anyEngine ? (
          <div className="banner">
            Ниту еден AI мотор не е достапен на серверот. Инсталирајте го и најавете го <span className="mono">claude</span>{' '}
            или <span className="mono">codex</span> CLI на машината каде работи CMS.
          </div>
        ) : (
          <>
            <div className="seg osint-engines">
              {CHOICES.map((c) => (
                <button
                  key={c.value}
                  type="button"
                  className={choice === c.value ? 'on' : ''}
                  disabled={!usable(c)}
                  title={usable(c) ? undefined : 'CLI не е пронајден на серверот'}
                  onClick={() => setChoice(c.value)}
                >
                  {c.label}
                </button>
              ))}
            </div>

            <p className="osint-disclose">
              Се испраќа до <strong>{providers}</strong>:{' '}
              {disclosed.length ? disclosed.map((f) => FIELD_MK[f]).join(', ') : '—'}.{' '}
              <strong>Бројот на документ никогаш не се испраќа.</strong> Извештајот се чува додека не го избришете.
              {profile &&
                ' Пронајдените фотографии се преземаат и чуваат во CMS со извештајот; секоја може да се избрише. Споредбата на лица се прави локално, во прелистувачот.'}
            </p>

            <div className="osint-ai-go">
              <button
                type="button"
                className="gold"
                disabled={!reason || starting || busy || !usable(selected)}
                onClick={() => void start()}
              >
                {starting ? 'Се започнува…' : profile ? 'Започни општ профил' : 'Започни AI проверка'}
              </button>
              <span className={reason ? 'hint' : 'hint over'}>
                {!reason
                  ? 'Прво изберете причина погоре.'
                  : busy
                    ? 'Една проверка веќе е во тек за овој гостин.'
                    : profile
                      ? 'Пошироко пребарување со фотографии — обично 5–15 минути.'
                      : choice === 'both'
                        ? 'Двата мотора работат паралелно, обично 2–6 минути.'
                        : 'Обично трае 2–5 минути.'}
              </span>
            </div>
          </>
        )}
      </div>

      <Err>{err}</Err>

      {run?.status === 'running' && (
        <div className="card osint-progress">
          <div className="card-head">
            <h3>
              <span className="dot" />{' '}
              {fetchingImages
                ? `Се преземаат фотографии… (${run.images.filter((i) => i.status === 'stored').length} преземени)`
                : 'Проверката е во тек'}
            </h3>
            <span className="muted mono">{fmtDuration(Math.max(0, Math.round((now - sqlMs(run.created_at)) / 1000)))}</span>
          </div>
          <div className="osint-progress-grid">
            {run.results.map((r) => {
              const searches = r.activity.filter((a) => a.kind === 'search').length
              const pages = r.activity.filter((a) => a.kind === 'open' || a.kind === 'fetched').length
              return (
                <div key={r.engine} className="osint-progress-engine">
                  <div className="osint-progress-top">
                    <strong>{ENGINE_LABEL[r.engine]}</strong>
                    <span className={`tag ${r.status === 'done' ? 'fulfilled' : r.status === 'failed' ? 'cancelled' : 'received'}`}>
                      {r.status === 'running' ? 'работи' : r.status === 'done' ? 'готово' : 'неуспешно'}
                    </span>
                    <span className="muted">
                      {searches} пребарувања · {pages} страници
                    </span>
                  </div>
                  {r.error && <div className="err mono">{r.error}</div>}
                  <ActivityFeed
                    items={r.activity}
                    startedAt={sqlMs(r.started_at)}
                    running={r.status === 'running'}
                    now={now}
                    limit={60}
                  />
                </div>
              )
            })}
          </div>
          <div className="osint-actions">
            <button type="button" className="danger" disabled={deleting} onClick={() => void remove()}>
              {deleting ? 'Се прекинува…' : 'Прекини и избриши'}
            </button>
          </div>
        </div>
      )}

      {run?.status === 'failed' && (
        <div className="card osint-failed">
          <h3>Проверката не успеа</h3>
          {run.results.map((r) => (
            <p key={r.engine}>
              <strong>{ENGINE_LABEL[r.engine]}:</strong>{' '}
              <span className="mono">{r.error === 'interrupted' ? 'прекинато (серверот беше рестартиран)' : r.error ?? '—'}</span>
            </p>
          ))}
          <div className="osint-actions">
            <button type="button" className="danger" disabled={deleting} onClick={() => void remove()}>
              Избриши
            </button>
          </div>
        </div>
      )}

      {run?.status === 'done' && (
        <OsintReport
          run={run}
          guestTags={guestTags}
          photo={overview?.photo ?? null}
          onApplyTag={applyTag}
          onDelete={() => void remove()}
          deleting={deleting}
          onRunChanged={reloadRun}
        />
      )}

      {overview && overview.runs.length > 0 && (
        <div className="osint-history">
          <h4 className="osint-section-title">Претходни проверки</h4>
          <ul>
            {overview.runs.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  className={r.id === openId ? 'osint-run-row on' : 'osint-run-row'}
                  onClick={() => setOpenId(r.id === openId ? null : r.id)}
                >
                  <span className="mono">{fmtDateTime(r.created_at)}</span>
                  <span>{enginesLabel(r.engines)}</span>
                  <span className="muted">
                    {r.actor} · {reasonShort(r.reason)}
                  </span>
                  <span className={`osint-run-verdict v-${r.verdict ?? r.status}`}>
                    {r.status === 'running'
                      ? 'во тек'
                      : r.status === 'failed'
                        ? 'неуспешна'
                        : `${verdictLabel(r.reason, r.verdict ?? 'insufficient_data')} · ${r.findings ?? 0}`}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}
