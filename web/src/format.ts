/**
 * Absolute time and duration, in Macedonian.
 *
 * `timeAgo` in api.ts covers "пред 5м", which is right for a live order queue
 * and wrong for a guest file — "registered пред 340д" tells you nothing. Same
 * parsing rule as timeAgo: SQLite hands back "YYYY-MM-DD HH:MM:SS" in UTC.
 */
function parse(sqlTime: string): Date {
  return new Date(sqlTime.replace(' ', 'T') + 'Z')
}

const MONTHS = [
  'јануари', 'февруари', 'март', 'април', 'мај', 'јуни',
  'јули', 'август', 'септември', 'октомври', 'ноември', 'декември'
]

const p2 = (n: number) => String(n).padStart(2, '0')

/**
 * Formatted by hand rather than through Intl.
 *
 * Not every browser ships `mk` locale data — Chromium builds with a trimmed ICU
 * fall back to en-US and silently render 09/01/2026 and 11:43 AM, which is the
 * wrong date order AND the wrong clock for a Macedonian floor. `timeAgo` in
 * api.ts is hand-rolled for the same reason.
 */
export function fmtDate(sqlTime: string | null | undefined): string {
  if (!sqlTime) return '—'
  const d = parse(sqlTime)
  return `${p2(d.getDate())}.${p2(d.getMonth() + 1)}.${d.getFullYear()}`
}

export function fmtDateLong(sqlTime: string | null | undefined): string {
  if (!sqlTime) return '—'
  const d = parse(sqlTime)
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`
}

export function fmtTime(sqlTime: string | null | undefined): string {
  if (!sqlTime) return '—'
  const d = parse(sqlTime)
  return `${p2(d.getHours())}:${p2(d.getMinutes())}`
}

export function fmtDateTime(sqlTime: string | null | undefined): string {
  return sqlTime ? `${fmtDate(sqlTime)} ${fmtTime(sqlTime)}` : '—'
}

/** Compact duration: 2ч 14м, 45м, 30с. */
export function fmtDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return '—'
  const s = Math.max(0, Math.round(seconds))
  if (s < 60) return `${s}с`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}м`
  const h = Math.floor(m / 60)
  return m % 60 === 0 ? `${h}ч` : `${h}ч ${m % 60}м`
}

/** A visit as one line: "12.03.2026 · 21:40 – 23:15". */
export function fmtVisit(openedAt: string, closedAt: string | null): string {
  return `${fmtDate(openedAt)} · ${fmtTime(openedAt)} – ${closedAt ? fmtTime(closedAt) : 'сега'}`
}

/** Initials for the monogram plate. Cyrillic-safe: no charAt byte games. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  const first = [...parts[0]][0] ?? ''
  const second = parts.length > 1 ? ([...parts[parts.length - 1]][0] ?? '') : ''
  return (first + second).toUpperCase()
}

/** A stable, subtly different hue per guest, so monograms are tellable apart. */
export function hueFor(id: string): number {
  let h = 0
  for (const ch of id) h = (h * 31 + ch.codePointAt(0)!) % 360
  return h
}

/**
 * Turns a local calendar date from <input type="date"> into the UTC timestamp
 * SQLite stores, so a date filter selects the day the user actually sees.
 *
 * `ledger_entries.created_at` is `datetime('now')` — UTC — while the timeline
 * renders those rows in local time. Comparing the raw "YYYY-MM-DD" against them
 * silently drops rows near midnight: a transaction shown as 15.03 01:30 local is
 * stored as 2026-03-14 23:30 and would fall outside a "from 15.03" filter.
 */
export function localDayToUtc(day: string, end: boolean): string {
  const [y, m, d] = day.split('-').map(Number)
  const local = end
    ? new Date(y, m - 1, d, 23, 59, 59, 999)
    : new Date(y, m - 1, d, 0, 0, 0, 0)
  return local.toISOString().slice(0, 19).replace('T', ' ')
}

/** Plain calendar dates (dob) carry no time, so they must not be UTC-shifted. */
export function fmtPlainDate(day: string | null | undefined): string {
  if (!day) return '—'
  const [y, m, d] = day.split('-')
  return d && m && y ? `${d}.${m}.${y}` : day
}
