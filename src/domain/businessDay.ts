/**
 * The calendar day a moment falls on in a given IANA zone, as 'YYYY-MM-DD'.
 *
 * Everything in this database is stored as UTC `datetime('now')`, but a fiscal day ends
 * at local midnight: a sale at 23:30 UTC in July is already tomorrow's receipt in Skopje
 * (UTC+2), and in January it is tomorrow too but an hour later (UTC+1). Only tzdata knows
 * where that line sits on any given date, so this goes through ICU rather than adding a
 * fixed number of hours by hand — a hardcoded +2 is wrong for half the year, and wrong in
 * both directions across the two changeover weekends.
 *
 * `formatToParts` rather than `format`: the part *types* are locale-independent, whereas
 * 'en-CA' merely happens to print ISO order and would degrade to '9/7/2026' on a Node
 * built with small-icu. Same reason the locale is 'en-US' — the one every ICU build ships.
 *
 * `at` is a parameter rather than an inline `new Date()` so day-rollover and DST are
 * ordinary unit tests; nothing here has to fake a global clock.
 */
export function businessDay(timeZone: string, at: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(at)
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')}`
}
