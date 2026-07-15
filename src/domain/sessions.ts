import { randomBytes } from 'node:crypto'
import type { Db } from '../db/index.js'

export type CloseReason = 'cashout' | 'inactivity' | 'logout_push' | 'replaced' | 'blocked'

export interface SessionRow {
  sid: string
  card_id: string
  opened_at: string
  last_activity_at: string
  closed_at: string | null
  close_reason: CloseReason | null
}

/**
 * 18 chars — comfortably inside the firmware's char sid[24], and random enough
 * that a session id can't be guessed (it authorises debits).
 */
function mintSid(): string {
  return `s-${randomBytes(8).toString('hex')}`
}

export function getActiveSession(db: Db, sid: string): SessionRow | undefined {
  return db.prepare('SELECT * FROM sessions WHERE sid = ? AND closed_at IS NULL').get(sid) as
    | SessionRow
    | undefined
}

export function activeSessionForCard(db: Db, cardId: string): SessionRow | undefined {
  return db.prepare('SELECT * FROM sessions WHERE card_id = ? AND closed_at IS NULL').get(cardId) as
    | SessionRow
    | undefined
}

export function closeSession(db: Db, sid: string, reason: CloseReason): boolean {
  const res = db
    .prepare(
      `UPDATE sessions SET closed_at = datetime('now'), close_reason = ?
       WHERE sid = ? AND closed_at IS NULL`
    )
    .run(reason, sid)
  return res.changes === 1
}

/** One active session per card: a new tap supersedes any session still open. */
export function openSession(db: Db, cardId: string): SessionRow {
  return db.transaction((): SessionRow => {
    const existing = activeSessionForCard(db, cardId)
    if (existing) closeSession(db, existing.sid, 'replaced')

    const sid = mintSid()
    db.prepare('INSERT INTO sessions (sid, card_id) VALUES (?, ?)').run(sid, cardId)
    return getActiveSession(db, sid)!
  })()
}

export function touchSession(db: Db, sid: string): void {
  db.prepare(
    `UPDATE sessions SET last_activity_at = datetime('now') WHERE sid = ? AND closed_at IS NULL`
  ).run(sid)
}

/**
 * Server-side idle logout. The firmware logs out on its own after 5 minutes,
 * but the CMS must not be left holding a session open if the terminal dies.
 * Returns the sessions it closed so callers can push logout_push to them.
 */
export function sweepIdleSessions(db: Db, idleMs: number): SessionRow[] {
  const seconds = Math.floor(idleMs / 1000)
  const stale = db
    .prepare(
      `SELECT * FROM sessions
       WHERE closed_at IS NULL AND last_activity_at <= datetime('now', ?)`
    )
    .all(`-${seconds} seconds`) as SessionRow[]

  for (const session of stale) closeSession(db, session.sid, 'inactivity')
  return stale
}
