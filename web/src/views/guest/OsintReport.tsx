import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  api,
  type OsintCategory,
  type OsintConfidence,
  type OsintEngine,
  type OsintEngineChoice,
  type OsintFaceVerdict,
  type OsintFinding,
  type OsintImage,
  type OsintPhotoMeta,
  type OsintRun,
  type OsintSeverity,
  type OsintVerdict
} from '../../api'
import { Chip, Empty, tagLabel } from '../../components/Bits'
import { compareFaces } from '../../faceMatch'
import { fmtDateTime, sqlMs } from '../../format'
import { reasonShort } from '../../osint'
import { ActivityFeed } from './OsintActivity'

export const ENGINE_LABEL: Record<OsintEngine, string> = { claude: 'Claude', codex: 'Codex' }

export function enginesLabel(choice: OsintEngineChoice): string {
  return choice === 'both' ? 'Claude + Codex' : ENGINE_LABEL[choice]
}

export const VERDICT_MK: Record<OsintVerdict, string> = {
  no_match: 'Нема совпаѓање',
  possible_match: 'Можно совпаѓање',
  likely_match: 'Веројатно совпаѓање',
  insufficient_data: 'Недоволно податоци'
}

/** A profile's verdict is about finding the person online, not about a list hit. */
export const PROFILE_VERDICT_MK: Record<OsintVerdict, string> = {
  likely_match: 'Профилот е пронајден',
  possible_match: 'Можен профил',
  no_match: 'Нема јавен профил',
  insufficient_data: 'Недоволно за идентификација'
}

export function verdictLabel(reason: string, verdict: OsintVerdict): string {
  return (reason === 'profile' ? PROFILE_VERDICT_MK : VERDICT_MK)[verdict]
}

const CATEGORY_MK: Record<OsintCategory, string> = {
  sanctions: 'Санкции',
  pep: 'ПЕП',
  adverse_media: 'Негативни медиуми',
  court_legal: 'Судско / правно',
  business: 'Бизнис',
  identity: 'Идентитет',
  social_profile: 'Профил',
  employment: 'Работа',
  education: 'Образование',
  media: 'Медиуми',
  interests: 'Интереси',
  other: 'Друго'
}

const PROFILE_SECTIONS: Array<{ title: string; categories: OsintCategory[] }> = [
  { title: 'Идентитет', categories: ['identity'] },
  { title: 'Работа', categories: ['employment'] },
  { title: 'Образование', categories: ['education'] },
  { title: 'Бизнис', categories: ['business'] },
  { title: 'Онлајн присуство', categories: ['social_profile'] },
  { title: 'Медиуми', categories: ['media'] },
  { title: 'Интереси', categories: ['interests'] },
  { title: 'Ризик', categories: ['sanctions', 'pep', 'adverse_media', 'court_legal'] },
  { title: 'Друго', categories: ['other'] }
]

const SEVERITY_MK: Record<OsintSeverity, string> = {
  info: 'инфо',
  low: 'ниска тежина',
  medium: 'средна тежина',
  high: 'висока тежина'
}

const CONFIDENCE_MK: Record<OsintConfidence, string> = {
  low: 'ниска',
  medium: 'средна',
  high: 'висока'
}

const FACE_MK: Record<OsintFaceVerdict, string> = {
  match: 'Исто лице',
  possible: 'Можно исто лице',
  different: 'Различно лице',
  no_face: 'Нема лице'
}

const FACE_ORDER: Record<string, number> = { match: 0, possible: 1, unchecked: 2, no_face: 3, different: 4 }

export const FIELD_MK: Record<'name' | 'city' | 'dob' | 'phone' | 'email', string> = {
  name: 'име (со варијанти на писмо)',
  city: 'град',
  dob: 'датум на раѓање',
  phone: 'телефон',
  email: 'е-пошта'
}

/** From the run's own snapshot — what was actually disclosed then, not what the guest holds now. */
function sentFields(run: OsintRun): string {
  const s = run.subject
  return (['name', 'city', 'dob', 'phone', 'email'] as const)
    .filter((f) => (f === 'name' ? s.name : s[f]))
    .map((f) => FIELD_MK[f])
    .join(', ')
}

function host(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

function corroboration(engines: OsintEngine[], corroborated: boolean): string {
  if (corroborated) return `потврдено од ${engines.map((e) => ENGINE_LABEL[e]).join(' и ')}`
  return `само ${engines.map((e) => ENGINE_LABEL[e]).join(', ')}`
}

interface Props {
  run: OsintRun
  guestTags: string[]
  /** The guest's consented reference photo; face comparison needs it. */
  photo: OsintPhotoMeta | null
  onApplyTag: (tag: string) => Promise<void>
  onDelete: () => void
  deleting: boolean
  /** Refetch this run after its photos changed. */
  onRunChanged: () => Promise<void>
}

/**
 * A finished AI run. Everything on it is an indication for a human to verify,
 * and it says so: findings carry the page they came from and which engine(s)
 * found them, suggested tags do nothing until clicked, face similarity is
 * labelled as an automated estimate, and the print copy repeats all of it so it
 * survives being filed without the screen.
 */
export function OsintReport({ run, guestTags, photo, onApplyTag, onDelete, deleting, onRunChanged }: Props) {
  const profile = run.reason === 'profile'
  const [printing, setPrinting] = useState(false)
  const [applying, setApplying] = useState<string | null>(null)
  const [err, setErr] = useState('')

  // Face comparison state (profile runs only).
  const [comparing, setComparing] = useState<{ done: number; total: number } | null>(null)
  const [faceErr, setFaceErr] = useState('')
  const [autoTried, setAutoTried] = useState<string | null>(null)

  const stored = run.images.filter((i) => i.status === 'stored')
  const unchecked = stored.filter((i) => i.face_verdict === null)
  const different = stored.filter((i) => i.face_verdict === 'different')

  // The print copy is rendered into <body> only while printing, so the print
  // stylesheet can hide the whole app without knowing its structure. Photos
  // are decoded first so the preview does not print empty frames.
  useEffect(() => {
    if (!printing) return
    let cancelled = false
    const done = () => setPrinting(false)
    window.addEventListener('afterprint', done, { once: true })
    const frame = requestAnimationFrame(() => {
      const imgs = [...document.querySelectorAll<HTMLImageElement>('.osint-print-portal img')]
      void Promise.all(imgs.map((img) => img.decode().catch(() => {}))).then(() => {
        if (!cancelled) window.print()
      })
    })
    return () => {
      cancelled = true
      cancelAnimationFrame(frame)
      window.removeEventListener('afterprint', done)
    }
  }, [printing])

  const runComparison = useCallback(
    async (targets: OsintImage[]) => {
      if (!photo || targets.length === 0) return
      setFaceErr('')
      setComparing({ done: 0, total: targets.length })
      try {
        const results = await compareFaces(
          api.guestPhotoSrc(run.player_id, photo.sha256),
          targets.map((i) => ({ imageId: i.id, src: api.osintImageSrc(run.player_id, run.id, i.id) })),
          (done, total) => setComparing({ done, total })
        )
        await api.osintFaceResults(run.player_id, run.id, results)
        await onRunChanged()
      } catch (e) {
        setFaceErr((e as Error).message)
      } finally {
        setComparing(null)
      }
    },
    [photo, run.player_id, run.id, onRunChanged]
  )

  // Automatic once per run + reference photo: compare every photo not yet compared.
  useEffect(() => {
    if (!profile || !photo || comparing || unchecked.length === 0) return
    const key = `${run.id}:${photo.sha256}`
    if (autoTried === key) return
    setAutoTried(key)
    void runComparison(unchecked)
  }, [profile, photo, comparing, unchecked, run.id, autoTried, runComparison])

  async function apply(tag: string) {
    setApplying(tag)
    try {
      await onApplyTag(tag)
    } finally {
      setApplying(null)
    }
  }

  async function removeImage(image: OsintImage) {
    if (!window.confirm('Да се избрише оваа фотографија од извештајот?')) return
    setErr('')
    try {
      await api.osintDeleteImage(run.player_id, run.id, image.id)
      await onRunChanged()
    } catch (e) {
      setErr((e as Error).message)
    }
  }

  async function removeDifferent() {
    if (!window.confirm(`Да се избришат ${different.length} фотографии оценети како различно лице?`)) return
    setErr('')
    try {
      await api.osintDeleteDifferentFaces(run.player_id, run.id)
      await onRunChanged()
    } catch (e) {
      setErr((e as Error).message)
    }
  }

  return (
    <div className="osint-report">
      {err && <div className="err">{err}</div>}

      {profile && stored.length > 0 && (
        <div className="osint-face-bar">
          {!photo ? (
            <span className="muted">
              За споредба на лица, додадете фотографија на гостинот (со негова согласност) погоре.
            </span>
          ) : comparing ? (
            <span>
              <span className="dot" /> Се споредуваат лица {comparing.done}/{comparing.total}…
            </span>
          ) : (
            <>
              <span className="muted">
                {unchecked.length === 0
                  ? 'Лицата се споредени со фотографијата на гостинот. Автоматска проценка — не е доказ.'
                  : `${unchecked.length} фотографии не се споредени.`}
              </span>
              <button type="button" onClick={() => void runComparison(stored)}>
                Спореди повторно
              </button>
              {different.length > 0 && (
                <button type="button" className="danger" onClick={() => void removeDifferent()}>
                  Избриши ги сликите со различно лице ({different.length})
                </button>
              )}
            </>
          )}
        </div>
      )}
      {faceErr && <div className="banner">Споредбата на лица не успеа: {faceErr} Галеријата работи и без неа.</div>}

      <ReportBody run={run} onDeleteImage={removeImage} />

      {run.merged && run.merged.suggested_tags.length > 0 && (
        <section className="card osint-tags">
          <h4>Предложени ознаки</h4>
          <p className="muted">Не се додаваат сами. Проверете ги наодите, па одлучете.</p>
          {run.merged.suggested_tags.map((t) => {
            const has = guestTags.includes(t.tag)
            return (
              <div key={t.tag} className="osint-tag-row">
                <Chip tag={t.tag} />
                <span className="osint-tag-why">
                  {t.rationale}
                  <span className="muted"> · {t.engines.map((e) => ENGINE_LABEL[e]).join(' и ')}</span>
                </span>
                <button
                  type="button"
                  className={has ? 'ghost' : 'gold'}
                  disabled={has || applying !== null}
                  onClick={() => void apply(t.tag)}
                >
                  {has ? 'Веќе додадена' : applying === t.tag ? 'Се додава…' : `Додај ${tagLabel(t.tag)}`}
                </button>
              </div>
            )
          })}
        </section>
      )}

      <div className="osint-actions">
        <button type="button" onClick={() => setPrinting(true)} disabled={printing}>
          Печати
        </button>
        <button type="button" className="danger" onClick={onDelete} disabled={deleting}>
          {deleting ? 'Се брише…' : 'Избриши извештај'}
        </button>
      </div>

      {printing &&
        createPortal(
          <div className="osint-print-portal">
            <ReportBody run={run} print />
          </div>,
          document.body
        )}
    </div>
  )
}

function FindingCard({ f, i }: { f: OsintFinding; i: number }) {
  return (
    <article className={`osint-finding sev-${f.severity}`} style={{ '--i': i } as React.CSSProperties}>
      <div className="osint-finding-top">
        <span className="tag">{CATEGORY_MK[f.category] ?? f.category}</span>
        {f.severity !== 'info' && <span className={`tag sev sev-${f.severity}`}>{SEVERITY_MK[f.severity]}</span>}
        <span className="muted">сигурност: {CONFIDENCE_MK[f.match_confidence]}</span>
        <span className={f.corroborated ? 'osint-corr yes' : 'osint-corr'}>{corroboration(f.engines, f.corroborated)}</span>
      </div>
      <h4>{f.title}</h4>
      {f.detail && <p>{f.detail}</p>}
      {f.match_basis && (
        <p className="muted osint-basis">
          <strong>Основа за совпаѓање:</strong> {f.match_basis}
        </p>
      )}
      <ul className="osint-sources">
        {f.sources.map((s) => (
          <li key={s.url}>
            <a href={s.url} target="_blank" rel="noopener noreferrer">
              {s.title}
            </a>
            <span className="muted mono">
              {' '}
              {host(s.url)}
              {s.published ? ` · ${s.published}` : ''}
            </span>
            <div className="osint-print-url mono">{s.url}</div>
          </li>
        ))}
      </ul>
    </article>
  )
}

function Gallery({
  run,
  print,
  onDeleteImage
}: {
  run: OsintRun
  print: boolean
  onDeleteImage?: (image: OsintImage) => void
}) {
  const stored = [...run.images.filter((i) => i.status === 'stored')].sort(
    (a, b) => (FACE_ORDER[a.face_verdict ?? 'unchecked'] ?? 2) - (FACE_ORDER[b.face_verdict ?? 'unchecked'] ?? 2)
  )
  const failed = run.images.filter((i) => i.status === 'failed')
  const lowConfidence = (run.merged?.images ?? []).filter((i) => i.match_confidence === 'low')

  if (stored.length === 0 && failed.length === 0 && lowConfidence.length === 0) return null

  return (
    <section className="osint-profile-section">
      <h4 className="osint-section-title">Фотографии</h4>
      {stored.length === 0 ? (
        <p className="muted">Ниту една фотографија не можеше да се преземе.</p>
      ) : (
        <div className="osint-gallery">
          {stored.map((img) => (
            <figure key={img.id} className={`osint-photo face-${img.face_verdict ?? 'unchecked'}`}>
              <div className="osint-photo-frame">
                <img src={api.osintImageSrc(run.player_id, run.id, img.id)} alt={img.description ?? ''} loading="lazy" />
                {img.face_verdict && (
                  <span className={`osint-face-badge face-${img.face_verdict}`}>
                    {FACE_MK[img.face_verdict]}
                    {img.face_distance !== null ? ` · ${img.face_distance.toFixed(2)}` : ''}
                  </span>
                )}
                {!print && onDeleteImage && (
                  <button
                    type="button"
                    className="osint-photo-x"
                    aria-label="Избриши фотографија"
                    onClick={() => onDeleteImage(img)}
                  >
                    ✕
                  </button>
                )}
              </div>
              <figcaption>
                <span className="osint-photo-desc">{img.description}</span>
                <span className="muted">
                  сигурност на страницата: {CONFIDENCE_MK[img.match_confidence]} ·{' '}
                  {corroboration(img.engines, img.engines.length > 1)}
                </span>
                <a href={img.page_url} target="_blank" rel="noopener noreferrer">
                  {host(img.page_url)}
                </a>
                <div className="osint-print-url mono">{img.page_url}</div>
              </figcaption>
            </figure>
          ))}
        </div>
      )}
      <p className="osint-disclaimer">
        Фотографиите се поврзани со гостинот преку страницата на која се најдени, не преку лицето. Споредбата на лица
        е автоматска проценка — потврдете со гостинот лично.
      </p>
      {!print && (failed.length > 0 || lowConfidence.length > 0) && (
        <details className="osint-queries">
          <summary>Непреземени слики ({failed.length + lowConfidence.length})</summary>
          <ul className="osint-sources">
            {failed.map((i) => (
              <li key={`f${i.id}`}>
                <a href={i.page_url} target="_blank" rel="noopener noreferrer">
                  {i.description || host(i.page_url)}
                </a>
                <span className="muted mono"> {i.error}</span>
              </li>
            ))}
            {lowConfidence.map((i) => (
              <li key={`l${i.image_url ?? i.page_url}`}>
                <a href={i.page_url} target="_blank" rel="noopener noreferrer">
                  {i.description || host(i.page_url)}
                </a>
                <span className="muted"> ниска сигурност — не е преземена</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  )
}

function Accounts({ run }: { run: OsintRun }) {
  const accounts = run.merged?.accounts ?? []
  if (accounts.length === 0) return null
  return (
    <section className="osint-profile-section">
      <h4 className="osint-section-title">Онлајн сметки</h4>
      <ul className="osint-accounts">
        {accounts.map((a) => (
          <li key={a.url}>
            <span className="osint-account-platform">{a.platform}</span>
            <a href={a.url} target="_blank" rel="noopener noreferrer">
              {a.handle ?? host(a.url)}
            </a>
            <span className="muted">
              сигурност: {CONFIDENCE_MK[a.match_confidence]} · {corroboration(a.engines, a.engines.length > 1)}
            </span>
            {a.match_basis && <span className="muted osint-account-basis">{a.match_basis}</span>}
            <div className="osint-print-url mono">{a.url}</div>
          </li>
        ))}
      </ul>
    </section>
  )
}

function ReportBody({
  run,
  print = false,
  onDeleteImage
}: {
  run: OsintRun
  print?: boolean
  onDeleteImage?: (image: OsintImage) => void
}) {
  const profile = run.reason === 'profile'
  const merged = run.merged
  const failed = run.results.filter((r) => r.status === 'failed')
  const cost = run.results.reduce((n, r) => n + (r.cost_usd ?? 0), 0)

  return (
    <div className={print ? 'osint-report-body print' : 'osint-report-body'}>
      {print && (
        <header className="osint-print-head">
          <h1>{profile ? 'Профил на гостин од јавни извори' : 'Извештај од AI проверка на јавни извори'}</h1>
          <dl>
            <dt>Гостин</dt>
            <dd>
              {run.subject.name} <span className="mono">({run.player_id.slice(0, 8)})</span>
            </dd>
            <dt>Датум</dt>
            <dd>{fmtDateTime(run.created_at)}</dd>
            <dt>Извршил</dt>
            <dd>{run.actor}</dd>
            <dt>Причина</dt>
            <dd>{reasonShort(run.reason)}</dd>
            <dt>Мотори</dt>
            <dd>{enginesLabel(run.engines)}</dd>
            <dt>Пребарувано</dt>
            <dd>{run.subject.variants.join(' · ')}</dd>
          </dl>
        </header>
      )}

      {merged && (
        <div className={`osint-verdict v-${merged.verdict}${profile ? ' profile' : ''}`}>
          <span className="osint-verdict-k">{profile ? 'Профил' : 'Пресуда'}</span>
          <strong>{verdictLabel(run.reason, merged.verdict)}</strong>
          <span className="osint-verdict-meta">
            {merged.engines.map((e) => ENGINE_LABEL[e]).join(' + ')} · {merged.findings.length}{' '}
            {merged.findings.length === 1 ? 'наод' : 'наоди'}
            {profile && ` · ${run.images.filter((i) => i.status === 'stored').length} фотографии`}
            {!print && (
              <>
                {' '}
                · {fmtDateTime(run.created_at)} · {run.actor} · {reasonShort(run.reason)}
              </>
            )}
            {cost > 0 && ` · трошок $${cost.toFixed(2)}`}
          </span>
          {merged.disagreement && (
            <span className="osint-disagree">
              Моторите не се согласуваат:{' '}
              {(Object.entries(merged.verdicts) as Array<[OsintEngine, OsintVerdict]>)
                .map(([e, v]) => `${ENGINE_LABEL[e]} — ${verdictLabel(run.reason, v).toLowerCase()}`)
                .join(', ')}
              . Прикажана е попретпазливата оценка.
            </span>
          )}
        </div>
      )}

      {failed.map((r) => (
        <div key={r.engine} className="banner">
          {ENGINE_LABEL[r.engine]} не заврши: <span className="mono">{r.error ?? 'непозната грешка'}</span>
        </div>
      ))}

      {profile && <Gallery run={run} print={print} {...(onDeleteImage ? { onDeleteImage } : {})} />}

      {merged &&
        (Object.entries(merged.summaries) as Array<[OsintEngine, string]>)
          .filter(([, s]) => s)
          .map(([engine, summary]) => (
            <div key={engine} className="osint-summary">
              <span className="osint-summary-k">{ENGINE_LABEL[engine]}</span>
              <p>{summary}</p>
            </div>
          ))}

      {profile && <Accounts run={run} />}

      <p className="osint-disclaimer">
        Наодите се индиции, не доказ. Секој наод е поврзан со страницата од која потекнува — отворете ја и
        потврдете дека станува збор за истото лице пред да преземете дејство.
      </p>

      {merged && merged.findings.length === 0 ? (
        <Empty title="Нема наоди со извор" hint="Ниту еден мотор не пронајде нешто што може да се поврзе со гостинот." />
      ) : profile && merged ? (
        PROFILE_SECTIONS.map((section) => {
          const inSection = merged.findings.filter((f) => section.categories.includes(f.category))
          if (inSection.length === 0) return null
          return (
            <section key={section.title} className="osint-profile-section">
              <h4 className="osint-section-title">{section.title}</h4>
              {inSection.map((f, i) => (
                <FindingCard key={i} f={f} i={i} />
              ))}
            </section>
          )
        })
      ) : (
        merged?.findings.map((f, i) => <FindingCard key={i} f={f} i={i} />)
      )}

      {merged &&
        (Object.entries(merged.limitations) as Array<[OsintEngine, string]>)
          .filter(([, l]) => l)
          .map(([engine, text]) => (
            <p key={engine} className="muted osint-limits">
              <strong>Ограничувања ({ENGINE_LABEL[engine]}):</strong> {text}
            </p>
          ))}

      {!print && run.results.some((r) => r.queries.length > 0 || r.activity.length > 0) && (
        <details className="osint-queries">
          <summary>Што правеа моторите ({run.results.reduce((n, r) => n + r.queries.length, 0)} пребарувања)</summary>
          {run.results.map((r) => (
            <div key={r.engine}>
              <span className="osint-summary-k">{ENGINE_LABEL[r.engine]}</span>
              {r.activity.length > 0 ? (
                <ActivityFeed items={r.activity} startedAt={sqlMs(r.started_at)} running={false} now={0} />
              ) : (
                <ol className="mono">
                  {r.queries.map((qq, i) => (
                    <li key={i}>{qq}</li>
                  ))}
                </ol>
              )}
            </div>
          ))}
        </details>
      )}

      {print && (
        <footer className="osint-print-foot">
          Испечатено {fmtDateTime(new Date().toISOString().slice(0, 19).replace('T', ' '))}. Извештајот е
          генериран автоматски од јавни извори преку AI и не е доказ. Испратено до AI: {sentFields(run)}. Бројот
          на документ не се испраќа.
          {profile &&
            ' Фотографиите се преземени од наведените страници; споредбата на лица е автоматска проценка направена локално, без испраќање на лица до трети страни.'}
        </footer>
      )}
    </div>
  )
}
