import { hueFor, initials } from '../format'

/**
 * A guest's initials on a gold plate. Cyrillic names have no avatars anywhere
 * in this system, and a list of twenty identical rows is hard to scan — the
 * per-guest hue is derived from the id so it is stable across reloads.
 */
export function Monogram({ id, name, big }: { id: string; name: string; big?: boolean }) {
  return (
    <span
      className={big ? 'monogram big' : 'monogram'}
      style={{ '--hue': hueFor(id) } as React.CSSProperties}
      aria-hidden="true"
    >
      {initials(name)}
    </span>
  )
}

/** The tags the UI gives meaning to. Anything else renders as a plain label. */
const TAG_MK: Record<string, { label: string; kind: string }> = {
  vip: { label: 'ВИП', kind: 'vip' },
  watchlist: { label: 'НА НАБЉУДУВАЊЕ', kind: 'watch' },
  self_excluded: { label: 'САМОИСКЛУЧЕН', kind: 'excluded' },
  pep: { label: 'ПЕП', kind: 'pep' },
  sanctions_hit: { label: 'САНКЦИИ', kind: 'excluded' }
}

export function tagLabel(tag: string): string {
  return TAG_MK[tag]?.label ?? tag
}

export function Chip({ tag, onRemove }: { tag: string; onRemove?: () => void }) {
  const meta = TAG_MK[tag]
  return (
    <span className={`chip ${meta?.kind ?? 'plain'}`}>
      {meta?.label ?? tag}
      {onRemove && (
        <button type="button" className="chip-x" aria-label={`Отстрани ${tagLabel(tag)}`} onClick={onRemove}>
          ✕
        </button>
      )}
    </span>
  )
}

export function Skeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="skeleton-stack" aria-busy="true" aria-label="Се вчитува">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton" style={{ '--i': i } as React.CSSProperties} />
      ))}
    </div>
  )
}

export function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="empty">
      <div className="big">{title}</div>
      {hint && <div className="muted">{hint}</div>}
    </div>
  )
}

/** The one place an error message renders, so the layout never jumps. */
export function Err({ children }: { children?: string }) {
  return <div className="err">{children}</div>
}
