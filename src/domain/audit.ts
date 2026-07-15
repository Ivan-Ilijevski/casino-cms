import type { Db } from '../db/index.js'

export interface AuditEntry {
  actor: string
  action: string
  entityType?: string
  entityId?: string
  details?: unknown
}

/** Every staff mutation goes through here. Append-only, never edited. */
export function audit(db: Db, entry: AuditEntry): void {
  db.prepare(
    `INSERT INTO audit_log (actor, action, entity_type, entity_id, details)
     VALUES (?, ?, ?, ?, ?)`
  ).run(
    entry.actor,
    entry.action,
    entry.entityType ?? null,
    entry.entityId ?? null,
    entry.details === undefined ? null : JSON.stringify(entry.details)
  )
}

export interface AuditRow {
  id: number
  actor: string
  action: string
  entity_type: string | null
  entity_id: string | null
  details: string | null
  created_at: string
}

export function listAudit(db: Db, limit = 200): AuditRow[] {
  return db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(limit) as AuditRow[]
}
