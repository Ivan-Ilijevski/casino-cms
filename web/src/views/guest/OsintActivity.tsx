import { useEffect, useRef } from 'react'
import type { OsintActivity, OsintActivityKind } from '../../api'

const GLYPH: Record<OsintActivityKind, string> = {
  start: '▸',
  search: '⌕',
  open: '↗',
  find: '⌖',
  results: '≡',
  fetched: '✓',
  note: '›',
  done: '■',
  error: '!'
}

const KIND_MK: Record<OsintActivityKind, string> = {
  start: 'старт',
  search: 'пребарување',
  open: 'отвора страница',
  find: 'бара во страница',
  results: 'резултати',
  fetched: 'преземена страница',
  note: 'белешка на моторот',
  done: 'готово',
  error: 'грешка'
}

/** What an engine is most likely doing when it has gone quiet, judged by its last step. */
function quietPhase(last: OsintActivityKind | undefined): string {
  switch (last) {
    case undefined:
    case 'start':
      return 'планира пребарувања'
    case 'search':
    case 'find':
      return 'чека и чита резултати'
    case 'results':
    case 'open':
    case 'fetched':
      return 'ги анализира страниците'
    case 'done':
      return 'го составува извештајот'
    default:
      return 'размислува'
  }
}

function clock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

interface Props {
  items: OsintActivity[]
  /** Epoch ms the engine started; times are shown relative to it. */
  startedAt: number
  running: boolean
  now: number
  /** Only the most recent N while live; everything in a finished report. */
  limit?: number
}

/**
 * The engine's step-by-step log. While it runs, a last line always says what
 * it is probably doing and for how long it has been quiet — a model reading
 * twenty pages or writing its report can go a minute without a new step, and
 * that must not look the same as a hang.
 */
export function ActivityFeed({ items, startedAt, running, now, limit }: Props) {
  const box = useRef<HTMLOListElement>(null)
  const stick = useRef(true)
  const shown = limit ? items.slice(-limit) : items

  // Follow new steps unless the admin has scrolled up to read something.
  useEffect(() => {
    const el = box.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [shown.length, running])

  const last = items.at(-1)
  const quietFor = now - (last?.t ?? startedAt)

  return (
    <ol
      ref={box}
      className={running ? 'osint-activity live' : 'osint-activity'}
      onScroll={(e) => {
        const el = e.currentTarget
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
      }}
    >
      {limit && items.length > limit && <li className="osint-activity-more muted">… {items.length - limit} претходни чекори</li>}
      {shown.map((a, i) => (
        <li key={`${a.t}-${i}`} className={`act-${a.kind}`} title={KIND_MK[a.kind]}>
          <span className="osint-act-time mono">{clock(a.t - startedAt)}</span>
          <span className="osint-act-glyph" aria-label={KIND_MK[a.kind]}>
            {GLYPH[a.kind]}
          </span>
          <span className="osint-act-text">{a.text}</span>
        </li>
      ))}
      {running && (
        <li className="osint-activity-pending">
          <span className="osint-act-time mono">{clock(now - startedAt)}</span>
          <span className="osint-act-glyph">
            <span className="dot" />
          </span>
          <span className="osint-act-text">
            {quietPhase(last?.kind)}
            {quietFor > 8000 ? ` · ${Math.round(quietFor / 1000)}с без нов чекор` : '…'}
          </span>
        </li>
      )}
    </ol>
  )
}
