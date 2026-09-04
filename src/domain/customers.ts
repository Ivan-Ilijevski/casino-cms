import type { Db } from '../db/index.js'
import { tryCanonUid } from './uid.js'

/**
 * The player-level view of everything the CMS knows about a guest.
 *
 * Every other domain module is card-scoped, because that is what the firmware
 * deals in. A person, though, may hold more than one card, so the staff app's
 * "Гости" tab needs the fan-out that lives here: given a player, reach all of
 * their cards, then all of the card-keyed tables.
 *
 * Nothing in here writes money. Corrections still go through ledger.postEntry
 * so the append-only invariant holds in exactly one place.
 */

/** Tags the UI gives special meaning to. Any other string is a free-form label. */
export const RESERVED_TAGS = ['vip', 'watchlist', 'self_excluded', 'pep', 'sanctions_hit'] as const
export type ReservedTag = (typeof RESERVED_TAGS)[number]

/** Identity fields only an admin may read — see routes/customers.ts. */
export const PII_FIELDS = ['dob', 'doc_id'] as const

export interface PlayerRow {
  id: string
  name: string
  notes: string | null
  created_at: string
  phone: string | null
  email: string | null
  city: string | null
  dob: string | null
  doc_id: string | null
  updated_at: string | null
}

export interface CustomerListRow {
  id: string
  name: string
  city: string | null
  phone: string | null
  created_at: string
  cards: number
  blocked_cards: number
  balance_deni: number
  points: number
  last_seen: string | null
  tags: string[]
}

export interface CustomerCard {
  id: string
  card_uid: string
  card_uid_canon: string | null
  status: 'active' | 'blocked'
  balance_deni: number
  points: number
  created_at: string
  has_pin: number
  pin_failed_attempts: number
  pin_locked_until: string | null
}

export interface CustomerStats {
  lifetime_in_deni: number
  lifetime_out_deni: number
  bar_spend_deni: number
  points_earned: number
  adjustments_deni: number
  visits: number
  first_seen: string | null
  last_seen: string | null
  avg_visit_seconds: number | null
}

export interface TimelineRow {
  id: number
  card_id: string
  card_uid: string
  unit: 'deni' | 'points'
  amount: number
  kind: string
  txn: string | null
  ref: string | null
  actor: string
  created_at: string
  session_id: string | null
  order_number: number | null
  order_status: string | null
  order_items: string | null
}

export interface VisitRow {
  sid: string
  card_id: string
  card_uid: string
  opened_at: string
  last_activity_at: string
  closed_at: string | null
  close_reason: string | null
  duration_seconds: number
  spend_deni: number
  orders: number
}

export interface NoteRow {
  id: number
  player_id: string
  body: string
  author: string
  pinned: number
  created_at: string
}

// cards is the only join, so there is no row multiplication and the sums are
// plain sums. last_seen is a subquery rather than a second join for that reason.
const LIST_SELECT = `
  SELECT p.id, p.name, p.city, p.phone, p.created_at,
         COUNT(c.id)                                              AS cards,
         COUNT(CASE WHEN c.status = 'blocked' THEN 1 END)         AS blocked_cards,
         COALESCE(SUM(c.balance_deni), 0)                         AS balance_deni,
         COALESCE(SUM(c.points), 0)                               AS points,
         (SELECT MAX(s.last_activity_at) FROM sessions s
            JOIN cards sc ON sc.id = s.card_id
           WHERE sc.player_id = p.id)                             AS last_seen
  FROM players p
  LEFT JOIN cards c ON c.player_id = p.id
`

export type CustomerSort = 'name' | 'balance' | 'last_seen' | 'created'

const SORT_SQL: Record<CustomerSort, string> = {
  name: 'p.name COLLATE NOCASE ASC',
  balance: 'balance_deni DESC, p.name COLLATE NOCASE ASC',
  last_seen: 'last_seen IS NULL, last_seen DESC',
  created: 'p.created_at DESC'
}

/**
 * The WHERE shared by the list and its total, so a filtered page can never be
 * counted against a different filter.
 *
 * `q` deliberately also matches a card UID: staff hold a card in one hand and
 * the tablet in the other, and the two readers spell the same card two ways
 * (see uid.ts), so a hex-looking term is canonicalised before it is compared.
 */
function customerFilter(opts: { q?: string; tag?: string }): {
  where: string
  params: unknown[]
} {
  const clauses: string[] = []
  const params: unknown[] = []

  const q = opts.q?.trim()
  if (q) {
    const like = `%${q}%`
    const canon = tryCanonUid(q)
    clauses.push(`(
      p.name  LIKE ? COLLATE NOCASE OR
      p.phone LIKE ? OR
      p.email LIKE ? COLLATE NOCASE OR
      EXISTS (SELECT 1 FROM cards q1 WHERE q1.player_id = p.id
              AND (q1.card_uid LIKE ? COLLATE NOCASE OR (? IS NOT NULL AND q1.card_uid_canon = ?)))
    )`)
    params.push(like, like, like, like, canon, canon)
  }
  if (opts.tag) {
    clauses.push('EXISTS (SELECT 1 FROM player_tags t WHERE t.player_id = p.id AND t.tag = ?)')
    params.push(opts.tag)
  }

  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params }
}

/**
 * One row per guest, with the aggregates the list shows.
 */
export function listCustomers(
  db: Db,
  opts: { q?: string; tag?: string; sort?: CustomerSort; limit?: number; offset?: number } = {}
): CustomerListRow[] {
  const { where, params } = customerFilter(opts)
  const order = SORT_SQL[opts.sort ?? 'name']
  params.push(opts.limit ?? 100, opts.offset ?? 0)

  const rows = db
    .prepare(`${LIST_SELECT} ${where} GROUP BY p.id ORDER BY ${order} LIMIT ? OFFSET ?`)
    .all(...params) as Array<Omit<CustomerListRow, 'tags'>>

  // One query for every tag on the page, not one per guest: `limit` goes up to
  // 500, and calling tagsFor in a map would recompile the statement each time.
  return attachTags(db, rows)
}

function attachTags<T extends { id: string }>(db: Db, rows: T[]): Array<T & { tags: string[] }> {
  if (rows.length === 0) return []
  const ids = rows.map((r) => r.id)
  const tagRows = db
    .prepare(
      `SELECT player_id, tag FROM player_tags
        WHERE player_id IN (${ids.map(() => '?').join(',')})
        ORDER BY created_at`
    )
    .all(...ids) as Array<{ player_id: string; tag: string }>

  const byPlayer = new Map<string, string[]>()
  for (const { player_id, tag } of tagRows) {
    const list = byPlayer.get(player_id)
    if (list) list.push(tag)
    else byPlayer.set(player_id, [tag])
  }
  return rows.map((r) => ({ ...r, tags: byPlayer.get(r.id) ?? [] }))
}

/** The total the current filters match, before limit/offset — for "200 of 412". */
export function countCustomers(db: Db, opts: { q?: string; tag?: string } = {}): number {
  const { where, params } = customerFilter(opts)
  return (
    db.prepare(`SELECT COUNT(*) AS n FROM players p ${where}`).get(...params) as { n: number }
  ).n
}

export function getPlayer(db: Db, playerId: string): PlayerRow | undefined {
  return db.prepare('SELECT * FROM players WHERE id = ?').get(playerId) as PlayerRow | undefined
}

export function cardsFor(db: Db, playerId: string): CustomerCard[] {
  return db
    .prepare(
      // has_pin, never the hash — a card without a PIN is refused at the POS.
      `SELECT id, card_uid, card_uid_canon, status, balance_deni, points, created_at,
              CASE WHEN pin_hash IS NOT NULL THEN 1 ELSE 0 END AS has_pin,
              pin_failed_attempts, pin_locked_until
         FROM cards WHERE player_id = ? ORDER BY created_at`
    )
    .all(playerId) as CustomerCard[]
}

export function tagsFor(db: Db, playerId: string): string[] {
  return (
    db
      .prepare('SELECT tag FROM player_tags WHERE player_id = ? ORDER BY created_at')
      .all(playerId) as Array<{ tag: string }>
  ).map((r) => r.tag)
}

/**
 * Lifetime aggregates. All of these were computable from day one and none of
 * them had a query — the ledger's `kind` column is what separates them.
 */
export function customerStats(db: Db, playerId: string): CustomerStats {
  const money = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN l.kind = 'aft_credit'    THEN l.amount END), 0) AS lifetime_in_deni,
         COALESCE(SUM(CASE WHEN l.kind = 'aft_debit'     THEN -l.amount END), 0) AS lifetime_out_deni,
         COALESCE(SUM(CASE WHEN l.kind IN ('order','order_refund') AND l.unit = 'deni'
                           THEN -l.amount END), 0)                              AS bar_spend_deni,
         COALESCE(SUM(CASE WHEN l.kind = 'points_earned' THEN l.amount END), 0) AS points_earned,
         COALESCE(SUM(CASE WHEN l.kind = 'adjustment' AND l.unit = 'deni'
                           THEN l.amount END), 0)                               AS adjustments_deni
       FROM ledger_entries l
       JOIN cards c ON c.id = l.card_id
      WHERE c.player_id = ?`
    )
    .get(playerId) as Omit<CustomerStats, 'visits' | 'first_seen' | 'last_seen' | 'avg_visit_seconds'>

  const visits = db
    .prepare(
      `SELECT COUNT(*) AS visits,
              MIN(s.opened_at) AS first_seen,
              MAX(s.last_activity_at) AS last_seen,
              AVG(CASE WHEN s.closed_at IS NOT NULL
                       THEN (julianday(s.closed_at) - julianday(s.opened_at)) * 86400 END)
                AS avg_visit_seconds
         FROM sessions s JOIN cards c ON c.id = s.card_id
        WHERE c.player_id = ?`
    )
    .get(playerId) as Pick<CustomerStats, 'visits' | 'first_seen' | 'last_seen' | 'avg_visit_seconds'>

  return {
    ...money,
    ...visits,
    avg_visit_seconds:
      visits.avg_visit_seconds === null ? null : Math.round(visits.avg_visit_seconds)
  }
}

/**
 * The money timeline, across every card the guest holds.
 *
 * Keyset paginated on `id` rather than OFFSET: the ledger is append-only and
 * strictly increasing, so a cursor cannot skip or repeat a row the way an
 * offset does when a transfer lands mid-scroll.
 */
export function customerTimeline(
  db: Db,
  playerId: string,
  opts: { kinds?: string[]; from?: string; to?: string; limit?: number; before?: number } = {}
): TimelineRow[] {
  const clauses = ['c.player_id = ?']
  const params: unknown[] = [playerId]

  if (opts.kinds?.length) {
    clauses.push(`l.kind IN (${opts.kinds.map(() => '?').join(',')})`)
    params.push(...opts.kinds)
  }
  if (opts.from) {
    clauses.push('l.created_at >= ?')
    params.push(opts.from)
  }
  if (opts.to) {
    clauses.push('l.created_at <= ?')
    params.push(opts.to)
  }
  if (opts.before) {
    clauses.push('l.id < ?')
    params.push(opts.before)
  }
  params.push(opts.limit ?? 50)

  // ledger_entries.ref is polymorphic: an order uuid for order/order_refund
  // rows, a free-text reason for adjustments. The join only fires for the
  // former, which is why it is a LEFT JOIN on a kind test.
  return db
    .prepare(
      `SELECT l.*, c.card_uid,
              o.number AS order_number,
              o.status AS order_status,
              (SELECT group_concat(oi.qty || '× ' || oi.name, ', ')
                 FROM order_items oi WHERE oi.order_id = o.id) AS order_items
         FROM ledger_entries l
         JOIN cards c ON c.id = l.card_id
         LEFT JOIN orders o ON o.id = l.ref AND l.kind IN ('order','order_refund')
        WHERE ${clauses.join(' AND ')}
        ORDER BY l.id DESC LIMIT ?`
    )
    .all(...params) as TimelineRow[]
}

/**
 * Visit history. The sessions table has held this since 001 and nothing has
 * ever read a closed session — only the active one was reachable.
 */
export function sessionsForPlayer(
  db: Db,
  playerId: string,
  opts: { limit?: number; offset?: number } = {}
): VisitRow[] {
  return db
    .prepare(
      `SELECT s.sid, s.card_id, c.card_uid, s.opened_at, s.last_activity_at,
              s.closed_at, s.close_reason,
              CAST((julianday(COALESCE(s.closed_at, s.last_activity_at))
                    - julianday(s.opened_at)) * 86400 AS INTEGER) AS duration_seconds,
              -- NET outflow, not the sum of the negatives. A guest who moved
              -- 5 000 to a machine and cashed 4 000 back spent 1 000, not 5 000;
              -- summing only the debits reads as a loss five times the real one.
              COALESCE((SELECT -SUM(l.amount) FROM ledger_entries l
                         WHERE l.session_id = s.sid AND l.unit = 'deni'), 0)
                AS spend_deni,
              (SELECT COUNT(*) FROM orders o WHERE o.session_id = s.sid) AS orders
         FROM sessions s JOIN cards c ON c.id = s.card_id
        WHERE c.player_id = ?
        ORDER BY s.opened_at DESC LIMIT ? OFFSET ?`
    )
    .all(playerId, opts.limit ?? 50, opts.offset ?? 0) as VisitRow[]
}

/** Open AFT holds — money in flight to a machine right now. */
export function holdsForPlayer(db: Db, playerId: string): unknown[] {
  return db
    .prepare(
      `SELECT h.*, c.card_uid FROM holds h JOIN cards c ON c.id = h.card_id
        WHERE c.player_id = ? AND h.state = 'held' ORDER BY h.created_at DESC`
    )
    .all(playerId)
}

/**
 * Everything staff have done to this guest.
 *
 * audit_log rows are entity-keyed, and card actions carry the CARD id, so this
 * has to reach through the player's cards. pos.charge is filed under the order
 * it created, hence the third arm.
 */
export function auditForPlayer(db: Db, playerId: string, limit = 100): unknown[] {
  return db
    .prepare(
      `SELECT a.* FROM audit_log a
        WHERE (a.entity_type = 'player' AND a.entity_id = ?)
           OR (a.entity_type = 'card'
               AND a.entity_id IN (SELECT id FROM cards WHERE player_id = ?))
           OR (a.entity_type = 'order'
               AND a.entity_id IN (SELECT o.id FROM orders o
                                     JOIN cards c ON c.id = o.card_id
                                    WHERE c.player_id = ?))
        ORDER BY a.id DESC LIMIT ?`
    )
    .all(playerId, playerId, playerId, limit)
}

/**
 * Tickets that MIGHT belong to this guest.
 *
 * Tickets are machine money and carry no card (migrations.ts 001), so this is a
 * time correlation and nothing more: a ticket printed while the guest had a
 * session open. The caller must label it as unconfirmed — see the profile's
 * Посети tab. `tickets.player_id`, added in 004, takes over when the slot game
 * starts passing a session on cashout.
 */
export function ticketsNearSessions(db: Db, playerId: string, limit = 50): unknown[] {
  return db
    .prepare(
      `SELECT t.*,
              CASE WHEN t.player_id = ? THEN 'confirmed' ELSE 'session-window' END AS confidence
         FROM tickets t
        WHERE t.player_id = ?
           OR (t.player_id IS NULL
               AND EXISTS (SELECT 1 FROM sessions s JOIN cards c ON c.id = s.card_id
                       WHERE c.player_id = ?
                         AND t.created_at >= s.opened_at
                         AND t.created_at <= COALESCE(s.closed_at, s.last_activity_at)))
        ORDER BY t.created_at DESC LIMIT ?`
    )
    .all(playerId, playerId, playerId, limit)
}

/** Identity fields a PATCH may touch. Name is handled separately (byte-capped). */
export const EDITABLE_FIELDS = ['name', 'phone', 'email', 'city', 'dob', 'doc_id'] as const
export type EditableField = (typeof EDITABLE_FIELDS)[number]

/** Applies only the fields present in `patch`; returns the ones that changed. */
export function updatePlayer(
  db: Db,
  playerId: string,
  patch: Partial<Record<EditableField, string | null>>
): EditableField[] {
  const current = getPlayer(db, playerId)
  if (!current) return []

  const changed = EDITABLE_FIELDS.filter(
    (f) => f in patch && (patch[f] ?? null) !== (current[f] ?? null)
  )
  if (changed.length === 0) return []

  db.prepare(
    `UPDATE players SET ${changed.map((f) => `${f} = ?`).join(', ')},
            updated_at = datetime('now') WHERE id = ?`
  ).run(...changed.map((f) => patch[f] ?? null), playerId)

  return changed
}

export function notesFor(db: Db, playerId: string): NoteRow[] {
  return db
    .prepare('SELECT * FROM player_notes WHERE player_id = ? ORDER BY pinned DESC, id DESC')
    .all(playerId) as NoteRow[]
}

export function addNote(db: Db, playerId: string, body: string, author: string): NoteRow {
  const info = db
    .prepare('INSERT INTO player_notes (player_id, body, author) VALUES (?, ?, ?)')
    .run(playerId, body, author)
  return db
    .prepare('SELECT * FROM player_notes WHERE id = ?')
    .get(info.lastInsertRowid as number) as NoteRow
}

/**
 * Both of these are scoped by player as well as note id.
 *
 * A note id alone is enough to address any note in the table, so routing by id
 * only would let /customers/<A>/notes/<B's note> succeed — deleting B's note and
 * filing the audit row against A. In a system whose point is an accountable
 * record, an entry attributed to the wrong guest is worse than no entry.
 */
export function setNotePinned(
  db: Db,
  playerId: string,
  noteId: number,
  pinned: boolean
): boolean {
  return (
    db
      .prepare('UPDATE player_notes SET pinned = ? WHERE id = ? AND player_id = ?')
      .run(pinned ? 1 : 0, noteId, playerId).changes > 0
  )
}

export function deleteNote(db: Db, playerId: string, noteId: number): boolean {
  return (
    db.prepare('DELETE FROM player_notes WHERE id = ? AND player_id = ?').run(noteId, playerId)
      .changes > 0
  )
}

/** Idempotent: re-tagging an already-tagged guest is a no-op, not an error. */
export function addTag(db: Db, playerId: string, tag: string, actor: string): void {
  db.prepare(
    'INSERT OR IGNORE INTO player_tags (player_id, tag, actor) VALUES (?, ?, ?)'
  ).run(playerId, tag, actor)
}

export function removeTag(db: Db, playerId: string, tag: string): boolean {
  return (
    db.prepare('DELETE FROM player_tags WHERE player_id = ? AND tag = ?').run(playerId, tag)
      .changes > 0
  )
}
